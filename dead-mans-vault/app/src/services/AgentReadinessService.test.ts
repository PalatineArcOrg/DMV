import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, PublicKey } from '@solana/web3.js';
import {
  createAgentReadinessService,
  type AgentReadinessDependencies,
} from './AgentReadinessService.ts';
import {
  parseHeartbeatRecord,
  parseVaultConfig,
  type AccountInfoLike,
} from '../utils/rawAccountParsers.ts';

const PROGRAM = new PublicKey(
  'GXCu5964mvgAJDWmcMriZpzU3vDVqPzjYCM1sxCnsoEb',
);
const OWNER = new PublicKey(Buffer.alloc(32, 2));
const VAULT = new PublicKey(Buffer.alloc(32, 3));
const HEARTBEAT = new PublicKey(Buffer.alloc(32, 4));
const OTHER_VAULT = new PublicKey(Buffer.alloc(32, 5));
const AGENT = Keypair.generate();
const OTHER_AGENT = Keypair.generate();

const discriminator = (name: string): Buffer =>
  createHash('sha256')
    .update(`account:${name}`)
    .digest()
    .subarray(0, 8);

const i64 = (value: number | bigint): Buffer => {
  const bytes = Buffer.alloc(8);
  bytes.writeBigInt64LE(BigInt(value));
  return bytes;
};

const u64 = (value: number | bigint): Buffer => {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(BigInt(value));
  return bytes;
};

function buildVaultAccount(options: {
  owner?: PublicKey;
  agent?: PublicKey;
  active?: boolean;
  executed?: boolean;
  accountOwner?: PublicKey;
  discriminator?: Buffer;
  heartbeatInterval?: number | bigint;
  gracePeriod?: number | bigint;
} = {}): AccountInfoLike {
  const data = Buffer.concat([
    options.discriminator ?? discriminator('VaultConfig'),
    (options.owner ?? OWNER).toBuffer(),
    (options.agent ?? AGENT.publicKey).toBuffer(),
    i64(options.heartbeatInterval ?? 86_400),
    i64(options.gracePeriod ?? 604_800),
    Buffer.alloc(4),
    Buffer.from([options.executed ? 1 : 0]),
    Buffer.from([options.active === false ? 0 : 1]),
    i64(1_000),
    i64(2_000),
    Buffer.from([254, 1, 0]),
    Buffer.alloc(2),
  ]);
  return { owner: options.accountOwner ?? PROGRAM, data };
}

function buildHeartbeatAccount(
  vault = VAULT,
  accountOwner = PROGRAM,
  bump = 253,
  lastHeartbeat: number | bigint = 1_000,
  totalHeartbeats: number | bigint = 4,
): AccountInfoLike {
  return {
    owner: accountOwner,
    data: Buffer.concat([
      discriminator('HeartbeatRecord'),
      vault.toBuffer(),
      i64(lastHeartbeat),
      Buffer.from([0]),
      u64(totalHeartbeats),
      Buffer.from([bump]),
      Buffer.alloc(32),
    ]),
  };
}

interface ReadinessHarness {
  dependencies: AgentReadinessDependencies;
  accounts: Map<string, AccountInfoLike>;
  counters: {
    fetch: number;
    loadKey: number;
  };
}

function makeHarness(
  options: {
    vaultAccount?: AccountInfoLike | null;
    heartbeatAccount?: AccountInfoLike | null;
    loadKeypair?: () => Promise<Keypair>;
    fetchAccount?: (
      address: PublicKey,
    ) => Promise<AccountInfoLike | null>;
  } = {},
): ReadinessHarness {
  const accounts = new Map<string, AccountInfoLike>();
  const vaultAccount =
    options.vaultAccount === undefined
      ? buildVaultAccount()
      : options.vaultAccount;
  const heartbeatAccount =
    options.heartbeatAccount === undefined
      ? buildHeartbeatAccount()
      : options.heartbeatAccount;
  if (vaultAccount) accounts.set(VAULT.toBase58(), vaultAccount);
  if (heartbeatAccount) {
    accounts.set(HEARTBEAT.toBase58(), heartbeatAccount);
  }

  const counters = { fetch: 0, loadKey: 0 };
  const dependencies: AgentReadinessDependencies = {
    deriveVaultPda: () => [VAULT, 254],
    deriveHeartbeatPda: () => [HEARTBEAT, 253],
    fetchAccount: async (address) => {
      counters.fetch += 1;
      if (options.fetchAccount) {
        return options.fetchAccount(address);
      }
      return accounts.get(address.toBase58()) ?? null;
    },
    parseVaultAccount: (account) =>
      parseVaultConfig(account, PROGRAM),
    parseHeartbeatAccount: (account) =>
      parseHeartbeatRecord(account, PROGRAM),
    loadAgentKeypair: async () => {
      counters.loadKey += 1;
      return options.loadKeypair
        ? options.loadKeypair()
        : AGENT;
    },
    isMissingAgentError: (error) =>
      error instanceof Error && error.message === 'missing agent',
  };
  return { dependencies, accounts, counters };
}

test('matching local and on-chain agent returns ready', async () => {
  const harness = makeHarness();
  const result = await createAgentReadinessService(
    harness.dependencies,
  ).check(OWNER);

  assert.equal(result.status, 'ready');
  if (result.status !== 'ready') return;
  assert.equal(result.owner.equals(OWNER), true);
  assert.equal(result.vault.equals(VAULT), true);
  assert.equal(result.heartbeat.equals(HEARTBEAT), true);
  assert.equal(result.localAgent.equals(AGENT.publicKey), true);
  assert.equal(result.onChainAgent.equals(AGENT.publicKey), true);
  assert.deepEqual(result.vaultConfig, {
    heartbeatInterval: 86_400,
    gracePeriod: 604_800,
    active: true,
    executed: false,
  });
  assert.deepEqual(result.heartbeatBefore, {
    lastHeartbeat: 1_000,
    lastMethod: 0,
    totalHeartbeats: 4n,
  });
});

test('local key missing returns agent_missing', async () => {
  const harness = makeHarness({
    loadKeypair: async () => {
      throw new Error('missing agent');
    },
  });

  const result = await createAgentReadinessService(
    harness.dependencies,
  ).check(OWNER);

  assert.deepEqual(result, { status: 'agent_missing' });
});

test('local key mismatch returns agent_mismatch', async () => {
  const harness = makeHarness({
    loadKeypair: async () => OTHER_AGENT,
  });

  const result = await createAgentReadinessService(
    harness.dependencies,
  ).check(OWNER);

  assert.equal(result.status, 'agent_mismatch');
  if (result.status !== 'agent_mismatch') return;
  assert.equal(result.localAgent.equals(OTHER_AGENT.publicKey), true);
  assert.equal(result.onChainAgent.equals(AGENT.publicKey), true);
});

test('missing vault account returns vault_missing without loading the key', async () => {
  const harness = makeHarness({ vaultAccount: null });

  const result = await createAgentReadinessService(
    harness.dependencies,
  ).check(OWNER);

  assert.deepEqual(result, { status: 'vault_missing' });
  assert.equal(harness.counters.loadKey, 0);
});

test('inactive vault returns vault_inactive', async () => {
  const harness = makeHarness({
    vaultAccount: buildVaultAccount({ active: false }),
  });

  const result = await createAgentReadinessService(
    harness.dependencies,
  ).check(OWNER);

  assert.deepEqual(result, { status: 'vault_inactive' });
  assert.equal(harness.counters.fetch, 1);
  assert.equal(harness.counters.loadKey, 0);
});

test('executed vault returns vault_executed', async () => {
  const harness = makeHarness({
    vaultAccount: buildVaultAccount({ executed: true }),
  });

  const result = await createAgentReadinessService(
    harness.dependencies,
  ).check(OWNER);

  assert.deepEqual(result, { status: 'vault_executed' });
  assert.equal(harness.counters.fetch, 1);
  assert.equal(harness.counters.loadKey, 0);
});

test('heartbeat record referencing a noncanonical vault is rejected', async () => {
  const harness = makeHarness({
    heartbeatAccount: buildHeartbeatAccount(OTHER_VAULT),
  });

  const result = await createAgentReadinessService(
    harness.dependencies,
  ).check(OWNER);

  assert.deepEqual(result, {
    status: 'invalid_on_chain_state',
    reason: 'heartbeat record does not reference the canonical vault',
  });
  assert.equal(harness.counters.loadKey, 0);
});

test('heartbeat account with a noncanonical PDA bump is rejected', async () => {
  const harness = makeHarness({
    heartbeatAccount: buildHeartbeatAccount(VAULT, PROGRAM, 252),
  });

  const result = await createAgentReadinessService(
    harness.dependencies,
  ).check(OWNER);

  assert.deepEqual(result, {
    status: 'invalid_on_chain_state',
    reason: 'heartbeat account bump does not match the canonical PDA',
  });
  assert.equal(harness.counters.loadKey, 0);
});

test('invalid account discriminator or program owner is rejected', async (t) => {
  await t.test('wrong vault discriminator', async () => {
    const harness = makeHarness({
      vaultAccount: buildVaultAccount({
        discriminator: Buffer.alloc(8, 0xff),
      }),
    });
    const result = await createAgentReadinessService(
      harness.dependencies,
    ).check(OWNER);
    assert.equal(result.status, 'invalid_on_chain_state');
  });

  await t.test('wrong heartbeat account owner', async () => {
    const harness = makeHarness({
      heartbeatAccount: buildHeartbeatAccount(
        VAULT,
        new PublicKey(Buffer.alloc(32, 9)),
      ),
    });
    const result = await createAgentReadinessService(
      harness.dependencies,
    ).check(OWNER);
    assert.equal(result.status, 'invalid_on_chain_state');
  });
});

test('RPC failure returns rpc_unavailable and is not treated as agent loss', async () => {
  const failure = new Error('mock RPC unavailable');
  const harness = makeHarness({
    fetchAccount: async () => {
      throw failure;
    },
  });

  const result = await createAgentReadinessService(
    harness.dependencies,
  ).check(OWNER);

  assert.deepEqual(result, {
    status: 'rpc_unavailable',
    error: failure,
  });
  assert.equal(harness.counters.loadKey, 0);
});

test('local key is loaded exactly once after both accounts validate', async () => {
  const harness = makeHarness();

  const result = await createAgentReadinessService(
    harness.dependencies,
  ).check(OWNER);

  assert.equal(result.status, 'ready');
  assert.equal(harness.counters.fetch, 2);
  assert.equal(harness.counters.loadKey, 1);
});

test('ready result carries the exact validated in-memory keypair', async () => {
  const harness = makeHarness();

  const result = await createAgentReadinessService(
    harness.dependencies,
  ).check(OWNER);

  assert.equal(result.status, 'ready');
  if (result.status !== 'ready') return;
  assert.strictEqual(result.keypair, AGENT);
});

test('readiness snapshot rejects onchain integers outside safe numeric bounds', async () => {
  const unsafeInteger = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
  const harness = makeHarness({
    heartbeatAccount: buildHeartbeatAccount(
      VAULT,
      PROGRAM,
      253,
      unsafeInteger,
    ),
  });

  const result = await createAgentReadinessService(
    harness.dependencies,
  ).check(OWNER);

  assert.deepEqual(result, {
    status: 'invalid_on_chain_state',
    reason: 'onchain heartbeat timing exceeds safe numeric bounds',
  });
  assert.equal(harness.counters.fetch, 2);
  assert.equal(harness.counters.loadKey, 0);
});

test('readiness snapshot rejects unsafe vault interval conversion', async () => {
  const harness = makeHarness({
    vaultAccount: buildVaultAccount({
      heartbeatInterval: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
    }),
  });

  const result = await createAgentReadinessService(
    harness.dependencies,
  ).check(OWNER);

  assert.equal(result.status, 'invalid_on_chain_state');
  assert.equal(harness.counters.fetch, 2);
  assert.equal(harness.counters.loadKey, 0);
});

test('readiness implementation has no logging or persistence capability', () => {
  const source = readFileSync(
    new URL('./AgentReadinessService.ts', import.meta.url),
    'utf8',
  );
  const adapter = readFileSync(
    new URL('./DefaultAgentReadinessService.ts', import.meta.url),
    'utf8',
  );

  assert.doesNotMatch(source, /console\./);
  assert.doesNotMatch(source, /SecureStore|SQLite|Zustand|serialize|JSON\.stringify/);
  assert.doesNotMatch(source, /\.secretKey/);
  assert.doesNotMatch(adapter, /console\.|setItem|SQLite|Zustand|serialize/);
  assert.match(adapter, /getVaultPDA/);
  assert.match(adapter, /getHeartbeatPDA/);
  assert.match(adapter, /parseVaultConfig/);
  assert.match(adapter, /parseHeartbeatRecord/);
});

test('missing connected owner is explicit and performs no account or key reads', async () => {
  const harness = makeHarness();

  const result = await createAgentReadinessService(
    harness.dependencies,
  ).check(null);

  assert.deepEqual(result, { status: 'owner_missing' });
  assert.deepEqual(harness.counters, { fetch: 0, loadKey: 0 });
});

test('device authentication failure is distinct from a missing key', async () => {
  const harness = makeHarness({
    loadKeypair: async () => {
      throw new Error('authentication cancelled');
    },
  });

  const result = await createAgentReadinessService(
    harness.dependencies,
  ).check(OWNER);

  assert.deepEqual(result, { status: 'agent_unavailable' });
});

test('current KeyManager readiness load preserves its device-authentication contract', () => {
  const source = readFileSync(
    new URL('../tee/KeyManager.ts', import.meta.url),
    'utf8',
  );
  const slots = readFileSync(
    new URL('../tee/AgentKeySlotManagerCore.ts', import.meta.url),
    'utf8',
  );

  assert.match(source, /async getKeypair\(\): Promise<Keypair>/);
  assert.match(source, /this\.slots\.loadSlot\('active'\)/);
  assert.match(slots, /metadata\.auth === '1'/);
  assert.match(slots, /storage\.get\(\s*SLOT_NAMES\[slot\]\.secret/);
  assert.match(source, /requireAuthentication: true/);
  assert.match(source, /authenticationPrompt: AUTH_PROMPT/);
  assert.match(slots, /throw new CorruptSlotError\(slot\)/);
});
