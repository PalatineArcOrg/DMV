import { createHash } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PublicKey } from '@solana/web3.js';
import {
  createHeartbeatConfirmationVerifier,
  type HeartbeatConfirmationVerifierDependencies,
} from './HeartbeatConfirmationVerifier.ts';
import {
  parseHeartbeatRecord,
  type AccountInfoLike,
} from '../utils/rawAccountParsers.ts';

const PROGRAM = new PublicKey(
  'GXCu5964mvgAJDWmcMriZpzU3vDVqPzjYCM1sxCnsoEb',
);
const VAULT = new PublicKey(Buffer.alloc(32, 3));
const OTHER_VAULT = new PublicKey(Buffer.alloc(32, 4));
const HEARTBEAT = new PublicKey(Buffer.alloc(32, 5));
const OTHER_HEARTBEAT = new PublicKey(Buffer.alloc(32, 6));
const HEARTBEAT_BUMP = 253;

const discriminator = (name: string): Buffer =>
  createHash('sha256')
    .update(`account:${name}`)
    .digest()
    .subarray(0, 8);

const i64 = (value: bigint): Buffer => {
  const bytes = Buffer.alloc(8);
  bytes.writeBigInt64LE(value);
  return bytes;
};

const u64 = (value: bigint): Buffer => {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(value);
  return bytes;
};

function heartbeatAccount(options: {
  vault?: PublicKey;
  lastHeartbeat?: bigint;
  lastMethod?: number;
  totalHeartbeats?: bigint;
  bump?: number;
  owner?: PublicKey;
  discriminator?: Buffer;
} = {}): AccountInfoLike {
  return {
    owner: options.owner ?? PROGRAM,
    data: Buffer.concat([
      options.discriminator ?? discriminator('HeartbeatRecord'),
      (options.vault ?? VAULT).toBuffer(),
      i64(options.lastHeartbeat ?? 1_001n),
      Buffer.from([options.lastMethod ?? 0]),
      u64(options.totalHeartbeats ?? 5n),
      Buffer.from([options.bump ?? HEARTBEAT_BUMP]),
      Buffer.alloc(32),
    ]),
  };
}

function dependencies(
  options: {
    account?: AccountInfoLike | null;
    fetchAccount?: (
      heartbeat: PublicKey,
    ) => Promise<AccountInfoLike | null>;
  } = {},
): HeartbeatConfirmationVerifierDependencies {
  const account =
    options.account === undefined
      ? heartbeatAccount()
      : options.account;
  return {
    deriveHeartbeatPda: () => [HEARTBEAT, HEARTBEAT_BUMP],
    fetchAccount: options.fetchAccount ?? (async () => account),
    parseHeartbeatAccount: (fetchedAccount) =>
      parseHeartbeatRecord(fetchedAccount, PROGRAM),
  };
}

const input = {
  vault: VAULT,
  heartbeat: HEARTBEAT,
  heartbeatBefore: {
    lastHeartbeat: 1_000,
    lastMethod: 0,
    totalHeartbeats: 4n,
  },
  expectedMethod: 0,
};

test('valid advanced heartbeat is verified', async () => {
  const result = await createHeartbeatConfirmationVerifier(
    dependencies(),
  ).verify(input);

  assert.deepEqual(result, {
    status: 'verified',
    lastHeartbeat: 1_001,
    lastMethod: 0,
    totalHeartbeats: 5n,
  });
});

test('same timestamp with incremented count is verified', async () => {
  const result = await createHeartbeatConfirmationVerifier(
    dependencies({
      account: heartbeatAccount({ lastHeartbeat: 1_000n }),
    }),
  ).verify(input);

  assert.equal(result.status, 'verified');
});

test('heartbeat count that did not advance returns not_advanced', async () => {
  const result = await createHeartbeatConfirmationVerifier(
    dependencies({
      account: heartbeatAccount({ totalHeartbeats: 4n }),
    }),
  ).verify(input);

  assert.deepEqual(result, { status: 'not_advanced' });
});

test('regressed heartbeat timestamp is invalid', async () => {
  const result = await createHeartbeatConfirmationVerifier(
    dependencies({
      account: heartbeatAccount({ lastHeartbeat: 999n }),
    }),
  ).verify(input);

  assert.equal(result.status, 'invalid_on_chain_state');
});

test('heartbeat method mismatch is invalid', async () => {
  const result = await createHeartbeatConfirmationVerifier(
    dependencies({
      account: heartbeatAccount({ lastMethod: 1 }),
    }),
  ).verify(input);

  assert.equal(result.status, 'invalid_on_chain_state');
});

test('heartbeat record referencing another vault is invalid', async () => {
  const result = await createHeartbeatConfirmationVerifier(
    dependencies({
      account: heartbeatAccount({ vault: OTHER_VAULT }),
    }),
  ).verify(input);

  assert.equal(result.status, 'invalid_on_chain_state');
});

test('foreign account owner is invalid', async () => {
  const result = await createHeartbeatConfirmationVerifier(
    dependencies({
      account: heartbeatAccount({ owner: OTHER_VAULT }),
    }),
  ).verify(input);

  assert.equal(result.status, 'invalid_on_chain_state');
});

test('wrong discriminator is invalid', async () => {
  const result = await createHeartbeatConfirmationVerifier(
    dependencies({
      account: heartbeatAccount({
        discriminator: Buffer.alloc(8, 0xff),
      }),
    }),
  ).verify(input);

  assert.equal(result.status, 'invalid_on_chain_state');
});

test('wrong heartbeat bump is invalid', async () => {
  const result = await createHeartbeatConfirmationVerifier(
    dependencies({
      account: heartbeatAccount({ bump: HEARTBEAT_BUMP - 1 }),
    }),
  ).verify(input);

  assert.equal(result.status, 'invalid_on_chain_state');
});

test('missing heartbeat account is invalid', async () => {
  const result = await createHeartbeatConfirmationVerifier(
    dependencies({ account: null }),
  ).verify(input);

  assert.equal(result.status, 'invalid_on_chain_state');
});

test('RPC exception returns rpc_unavailable', async () => {
  const failure = new Error('mock RPC unavailable');
  const result = await createHeartbeatConfirmationVerifier(
    dependencies({
      fetchAccount: async () => {
        throw failure;
      },
    }),
  ).verify(input);

  assert.deepEqual(result, {
    status: 'rpc_unavailable',
    error: failure,
  });
});

test('unsafe heartbeat timestamp conversion is rejected', async () => {
  const result = await createHeartbeatConfirmationVerifier(
    dependencies({
      account: heartbeatAccount({
        lastHeartbeat: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
      }),
    }),
  ).verify(input);

  assert.equal(result.status, 'invalid_on_chain_state');
});

test('noncanonical heartbeat address is rejected before fetch', async () => {
  let fetches = 0;
  const verifier = createHeartbeatConfirmationVerifier({
    ...dependencies(),
    fetchAccount: async () => {
      fetches += 1;
      return heartbeatAccount();
    },
  });

  const result = await verifier.verify({
    ...input,
    heartbeat: OTHER_HEARTBEAT,
  });

  assert.equal(result.status, 'invalid_on_chain_state');
  assert.equal(fetches, 0);
});
