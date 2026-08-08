import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PublicKey } from '@solana/web3.js';
import {
  calculateDeadlineSnapshot,
  createConfirmedChainTimeReader,
  createOnChainDeadlineService,
  projectAuthoritativeDeadline,
  type AuthoritativeDeadlineSnapshot,
  type ConfirmedChainTimeResult,
  type OnChainDeadlineDependencies,
} from './OnChainDeadlineService.ts';
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
const OTHER = new PublicKey(Buffer.alloc(32, 5));
const STAGES = {
  stage1Duration: 60,
  stage2Duration: 60,
  stage3Duration: 60,
};

const discriminator = (name: string): Buffer =>
  createHash('sha256')
    .update(`account:${name}`)
    .digest()
    .subarray(0, 8);

function i64(value: number | bigint): Buffer {
  const bytes = Buffer.alloc(8);
  bytes.writeBigInt64LE(BigInt(value));
  return bytes;
}

function u64(value: number | bigint): Buffer {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(BigInt(value));
  return bytes;
}

function vaultAccount(options: {
  owner?: PublicKey;
  active?: boolean;
  executed?: boolean;
  interval?: number | bigint;
  grace?: number | bigint;
  bump?: number;
  accountOwner?: PublicKey;
  discriminator?: Buffer;
} = {}): AccountInfoLike {
  return {
    owner: options.accountOwner ?? PROGRAM,
    data: Buffer.concat([
      options.discriminator ?? discriminator('VaultConfig'),
      (options.owner ?? OWNER).toBuffer(),
      OTHER.toBuffer(),
      i64(options.interval ?? 100),
      i64(options.grace ?? 180),
      Buffer.alloc(4),
      Buffer.from([options.executed ? 1 : 0]),
      Buffer.from([options.active === false ? 0 : 1]),
      i64(1_000),
      i64(1_001),
      Buffer.from([options.bump ?? 254, 1, 0]),
      Buffer.alloc(2),
    ]),
  };
}

function heartbeatAccount(options: {
  vault?: PublicKey;
  lastHeartbeat?: number | bigint;
  lastMethod?: number;
  totalHeartbeats?: number | bigint;
  bump?: number;
  accountOwner?: PublicKey;
  discriminator?: Buffer;
} = {}): AccountInfoLike {
  return {
    owner: options.accountOwner ?? PROGRAM,
    data: Buffer.concat([
      options.discriminator ?? discriminator('HeartbeatRecord'),
      (options.vault ?? VAULT).toBuffer(),
      i64(options.lastHeartbeat ?? 1_000),
      Buffer.from([options.lastMethod ?? 0]),
      u64(options.totalHeartbeats ?? 4),
      Buffer.from([options.bump ?? 253]),
      Buffer.alloc(32),
    ]),
  };
}

function makeDependencies(options: {
  vault?: AccountInfoLike | null;
  heartbeat?: AccountInfoLike | null;
  chainTimes?: Array<ConfirmedChainTimeResult>;
  monotonicNowMs?: () => number;
  stageDurations?: typeof STAGES;
  fetchAccount?: (
    address: PublicKey,
  ) => Promise<AccountInfoLike | null>;
} = {}): OnChainDeadlineDependencies {
  const accounts = new Map<string, AccountInfoLike>();
  const vault = options.vault === undefined ? vaultAccount() : options.vault;
  const heartbeat =
    options.heartbeat === undefined
      ? heartbeatAccount()
      : options.heartbeat;
  if (vault) accounts.set(VAULT.toBase58(), vault);
  if (heartbeat) accounts.set(HEARTBEAT.toBase58(), heartbeat);
  const chainTimes = [
    ...(options.chainTimes ?? [
      { status: 'verified', slot: 50, unixTimestamp: 1_100 },
    ]),
  ];
  return {
    cluster: 'devnet',
    programId: PROGRAM,
    stageDurations: options.stageDurations ?? STAGES,
    deriveVaultPda: () => [VAULT, 254],
    deriveHeartbeatPda: () => [HEARTBEAT, 253],
    fetchAccount:
      options.fetchAccount ??
      (async (address) => accounts.get(address.toBase58()) ?? null),
    parseVaultAccount: (account) =>
      parseVaultConfig(account, PROGRAM),
    parseHeartbeatAccount: (account) =>
      parseHeartbeatRecord(account, PROGRAM),
    getConfirmedChainTime: async () =>
      chainTimes.shift() ?? {
        status: 'verified',
        slot: 51,
        unixTimestamp: 1_101,
      },
    monotonicNowMs: options.monotonicNowMs ?? (() => 5_000),
  };
}

function calculateAt(
  chainUnixTime: number,
  overrides: Partial<{
    lastHeartbeat: number;
    heartbeatInterval: number;
    gracePeriod: number;
    stages: typeof STAGES;
  }> = {},
) {
  return calculateDeadlineSnapshot({
    cluster: 'devnet',
    programId: PROGRAM.toBase58(),
    owner: OWNER,
    vault: VAULT,
    heartbeat: HEARTBEAT,
    slot: 50,
    chainUnixTime,
    lastHeartbeat: overrides.lastHeartbeat ?? 1_000,
    lastMethod: 0,
    totalHeartbeats: 4n,
    heartbeatInterval: overrides.heartbeatInterval ?? 100,
    gracePeriod: overrides.gracePeriod ?? 180,
    stageDurations: overrides.stages ?? STAGES,
    observedAtMonotonicMs: 5_000,
  });
}

test('deadline boundaries mirror the on-chain final-deadline rule', async (t) => {
  const cases: Array<[string, number, number]> = [
    ['healthy before due', 1_099, 0],
    ['exactly at due remains stage 0', 1_100, 0],
    ['one second after due enters stage 1', 1_101, 1],
    ['exact stage 1 boundary enters stage 2', 1_160, 2],
    ['exact stage 2 boundary enters stage 3', 1_220, 3],
    ['one second before final remains stage 3', 1_279, 3],
    ['exactly at final enters stage 4', 1_280, 4],
    ['after final remains stage 4', 1_281, 4],
  ];
  for (const [name, now, expectedStage] of cases) {
    await t.test(name, () => {
      const result = calculateAt(now);
      assert.equal(result.status, 'verified');
      if (result.status !== 'verified') return;
      assert.equal(result.stage, expectedStage);
      assert.equal(result.executableByTime, now >= 1_280);
      assert.equal(now < result.finalDeadline, expectedStage < 4);
    });
  }
});

test('checked deadline arithmetic rejects overflow', () => {
  const result = calculateAt(Number.MAX_SAFE_INTEGER, {
    lastHeartbeat: Number.MAX_SAFE_INTEGER - 20,
    heartbeatInterval: 15,
    gracePeriod: 180,
  });
  assert.equal(result.status, 'invalid_on_chain_state');
});

test('zero, negative, fractional, and mismatched stage durations fail closed', async (t) => {
  for (const stages of [
    { ...STAGES, stage1Duration: 0 },
    { ...STAGES, stage2Duration: -1 },
    { ...STAGES, stage3Duration: 1.5 },
    { ...STAGES, stage3Duration: 59 },
  ]) {
    await t.test(JSON.stringify(stages), () => {
      const result = calculateAt(1_100, { stages });
      assert.equal(result.status, 'stage_configuration_invalid');
    });
  }
});

test('confirmed slot and block time produce a verified chain-time observation', async () => {
  const calls: Array<string> = [];
  const read = createConfirmedChainTimeReader({
    getSlot: async (commitment) => {
      calls.push(`slot:${commitment}`);
      return 42;
    },
    getBlockTime: async (slot) => {
      calls.push(`time:${slot}`);
      return 1_234;
    },
  });
  assert.deepEqual(await read(), {
    status: 'verified',
    slot: 42,
    unixTimestamp: 1_234,
  });
  assert.deepEqual(calls, ['slot:confirmed', 'time:42']);
});

test('chain-time reader rejects null, malformed, unsafe, and RPC failures', async (t) => {
  await t.test('null block time', async () => {
    const read = createConfirmedChainTimeReader({
      getSlot: async () => 42,
      getBlockTime: async () => null,
    });
    assert.deepEqual(await read(), {
      status: 'chain_time_unavailable',
    });
  });
  await t.test('malformed slot', async () => {
    const read = createConfirmedChainTimeReader({
      getSlot: async () => -1,
      getBlockTime: async () => 1_234,
    });
    assert.deepEqual(await read(), { status: 'chain_time_invalid' });
  });
  await t.test('unsafe timestamp', async () => {
    const read = createConfirmedChainTimeReader({
      getSlot: async () => 42,
      getBlockTime: async () => Number.MAX_SAFE_INTEGER + 1,
    });
    assert.deepEqual(await read(), { status: 'chain_time_invalid' });
  });
  await t.test('RPC failure', async () => {
    const read = createConfirmedChainTimeReader({
      getSlot: async () => {
        throw new Error('mock RPC unavailable');
      },
      getBlockTime: async () => 1_234,
    });
    assert.deepEqual(await read(), { status: 'rpc_unavailable' });
  });
});

test('service validates canonical accounts and returns authoritative inputs', async () => {
  const result = await createOnChainDeadlineService(
    makeDependencies(),
  ).fetch(OWNER);
  assert.equal(result.status, 'verified');
  if (result.status !== 'verified') return;
  assert.equal(result.owner.equals(OWNER), true);
  assert.equal(result.vault.equals(VAULT), true);
  assert.equal(result.heartbeat.equals(HEARTBEAT), true);
  assert.equal(result.lastHeartbeat, 1_000);
  assert.equal(result.totalHeartbeats, 4n);
  assert.equal(result.nextDue, 1_100);
  assert.equal(result.finalDeadline, 1_280);
  assert.equal(result.chainUnixTime, 1_100);
});

test('account reads are pinned at or after the confirmed chain-time slot', async () => {
  const dependencies = makeDependencies();
  const readChainTime = dependencies.getConfirmedChainTime;
  const fetchAccount = dependencies.fetchAccount;
  const events: Array<string> = [];
  dependencies.getConfirmedChainTime = async () => {
    events.push('chain-time');
    return readChainTime();
  };
  dependencies.fetchAccount = async (address, minContextSlot) => {
    events.push(`account:${address.toBase58()}:${minContextSlot}`);
    return fetchAccount(address, minContextSlot);
  };
  const result = await createOnChainDeadlineService(
    dependencies,
  ).fetch(OWNER);
  assert.equal(result.status, 'verified');
  assert.deepEqual(events, [
    'chain-time',
    `account:${VAULT.toBase58()}:50`,
    `account:${HEARTBEAT.toBase58()}:50`,
  ]);
});

test('missing, inactive, and executed vault states are explicit', async (t) => {
  await t.test('missing', async () => {
    const result = await createOnChainDeadlineService(
      makeDependencies({ vault: null }),
    ).fetch(OWNER);
    assert.deepEqual(result, { status: 'vault_missing' });
  });
  await t.test('inactive', async () => {
    const result = await createOnChainDeadlineService(
      makeDependencies({ vault: vaultAccount({ active: false }) }),
    ).fetch(OWNER);
    assert.deepEqual(result, { status: 'vault_inactive' });
  });
  await t.test('executed', async () => {
    const result = await createOnChainDeadlineService(
      makeDependencies({
        vault: vaultAccount({ executed: true, active: false }),
      }),
    ).fetch(OWNER);
    assert.deepEqual(result, { status: 'vault_executed' });
  });
});

test('wrong owner, discriminator, account owner, PDA bump, and vault reference are rejected', async (t) => {
  const cases: Array<[string, Parameters<typeof makeDependencies>[0]]> = [
    ['vault owner', { vault: vaultAccount({ owner: OTHER }) }],
    [
      'vault discriminator',
      { vault: vaultAccount({ discriminator: Buffer.alloc(8) }) },
    ],
    [
      'heartbeat account owner',
      { heartbeat: heartbeatAccount({ accountOwner: OTHER }) },
    ],
    ['heartbeat bump', { heartbeat: heartbeatAccount({ bump: 252 }) }],
    [
      'heartbeat vault reference',
      { heartbeat: heartbeatAccount({ vault: OTHER }) },
    ],
  ];
  for (const [name, options] of cases) {
    await t.test(name, async () => {
      const result = await createOnChainDeadlineService(
        makeDependencies(options),
      ).fetch(OWNER);
      assert.equal(result.status, 'invalid_on_chain_state');
    });
  }
});

test('RPC account failure is unavailable, not a death or deadline signal', async () => {
  const result = await createOnChainDeadlineService(
    makeDependencies({
      fetchAccount: async () => {
        throw new Error('mock RPC unavailable');
      },
    }),
  ).fetch(OWNER);
  assert.deepEqual(result, { status: 'rpc_unavailable' });
});

test('unsafe BN conversion is rejected before deadline arithmetic', async () => {
  const result = await createOnChainDeadlineService(
    makeDependencies({
      heartbeat: heartbeatAccount({
        lastHeartbeat: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
      }),
    }),
  ).fetch(OWNER);
  assert.equal(result.status, 'invalid_on_chain_state');
});

test('chain time regression is detected across verified observations', async () => {
  const service = createOnChainDeadlineService(
    makeDependencies({
      chainTimes: [
        { status: 'verified', slot: 50, unixTimestamp: 1_100 },
        { status: 'verified', slot: 51, unixTimestamp: 1_099 },
      ],
    }),
  );
  assert.equal((await service.fetch(OWNER)).status, 'verified');
  assert.deepEqual(await service.fetch(OWNER), {
    status: 'chain_time_regressed',
  });
});

function verifiedSnapshot(
  chainUnixTime = 1_101,
): AuthoritativeDeadlineSnapshot {
  const result = calculateAt(chainUnixTime);
  assert.equal(result.status, 'verified');
  if (result.status !== 'verified') {
    throw new Error('fixture must be verified');
  }
  return result;
}

test('monotonic projection advances warning UI smoothly within freshness', () => {
  const snapshot = verifiedSnapshot(1_159);
  const result = projectAuthoritativeDeadline(snapshot, 6_000);
  assert.equal(result.status, 'verified_projected');
  if (result.status !== 'verified_projected') return;
  assert.equal(result.snapshot.chainUnixTime, 1_160);
  assert.equal(result.snapshot.stage, 2);
  assert.equal(result.snapshot.executableByTime, false);
});

test('monotonic regression and stale observations stop projection', () => {
  const snapshot = verifiedSnapshot();
  assert.equal(
    projectAuthoritativeDeadline(snapshot, 4_999).status,
    'stale',
  );
  assert.equal(
    projectAuthoritativeDeadline(snapshot, 35_001).status,
    'stale',
  );
});

test('projected Stage 4 requires refresh and never becomes executable', () => {
  const snapshot = verifiedSnapshot(1_279);
  const result = projectAuthoritativeDeadline(snapshot, 6_000);
  assert.equal(result.status, 'stage4_refresh_required');
});

test('device wall clock and timezone are absent from deadline authority', () => {
  const source = readFileSync(
    new URL('./OnChainDeadlineService.ts', import.meta.url),
    'utf8',
  );
  const adapter = readFileSync(
    new URL('./DefaultOnChainDeadlineService.ts', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(source, /Date\.now|new Date|timezone|toLocale/);
  assert.doesNotMatch(adapter, /Date\.now|new Date|timezone|toLocale/);
  assert.match(adapter, /getSlot/);
  assert.match(adapter, /getBlockTime/);
  assert.match(adapter, /parseVaultConfig/);
  assert.match(adapter, /parseHeartbeatRecord/);
});
