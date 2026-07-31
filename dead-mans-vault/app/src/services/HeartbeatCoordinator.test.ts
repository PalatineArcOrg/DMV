import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, PublicKey } from '@solana/web3.js';
import type { AgentReadinessResult } from './AgentReadinessService.ts';
import {
  confirmLocalHeartbeat,
  createHeartbeatCoordinator,
  type HeartbeatAttemptResult,
} from './HeartbeatCoordinator.ts';

const OWNER = new PublicKey(Buffer.alloc(32, 2));
const VAULT = new PublicKey(Buffer.alloc(32, 3));
const HEARTBEAT = new PublicKey(Buffer.alloc(32, 4));
const AGENT = Keypair.fromSeed(new Uint8Array(32).fill(7));
const OTHER_AGENT = Keypair.fromSeed(new Uint8Array(32).fill(8));

const READY: AgentReadinessResult = {
  status: 'ready',
  owner: OWNER,
  vault: VAULT,
  heartbeat: HEARTBEAT,
  localAgent: AGENT.publicKey,
  onChainAgent: AGENT.publicKey,
  keypair: AGENT,
};

interface Counters {
  readiness: number;
  local: number;
  reset: number;
  notification: number;
  onchain: number;
  signature: number;
  warning: number;
  reload: number;
}

interface CoordinatorHarness {
  counters: Counters;
  events: Array<string>;
  signatures: Array<string>;
  warnings: Array<boolean>;
  agentsSubmitted: Array<Keypair>;
  run: () => Promise<HeartbeatAttemptResult>;
}

function makeHarness(
  overrides: {
    readiness?: () => Promise<AgentReadinessResult>;
    recordLocalHeartbeat?: () => Promise<void>;
    recordHeartbeatOnChain?: (agent: Keypair) => Promise<string>;
  } = {},
): CoordinatorHarness {
  const coordinator = createHeartbeatCoordinator();
  const counters: Counters = {
    readiness: 0,
    local: 0,
    reset: 0,
    notification: 0,
    onchain: 0,
    signature: 0,
    warning: 0,
    reload: 0,
  };
  const events: Array<string> = [];
  const signatures: Array<string> = [];
  const warnings: Array<boolean> = [];
  const agentsSubmitted: Array<Keypair> = [];

  return {
    counters,
    events,
    signatures,
    warnings,
    agentsSubmitted,
    run: () =>
      coordinator.attempt({
        checkAgentReadiness: async () => {
          counters.readiness += 1;
          events.push('readiness');
          return overrides.readiness
            ? overrides.readiness()
            : READY;
        },
        confirmLocalHeartbeat: () =>
          confirmLocalHeartbeat({
            recordLocalHeartbeat: async () => {
              counters.local += 1;
              events.push('local heartbeat');
              if (overrides.recordLocalHeartbeat) {
                await overrides.recordLocalHeartbeat();
              }
            },
            resetLocalEscalation: () => {
              counters.reset += 1;
              events.push('reset escalation');
            },
            sendLocalConfirmationNotification: () => {
              counters.notification += 1;
              events.push('local notification');
            },
          }),
        recordHeartbeatOnChain: async (agent) => {
          counters.onchain += 1;
          agentsSubmitted.push(agent);
          events.push('onchain heartbeat');
          return overrides.recordHeartbeatOnChain
            ? overrides.recordHeartbeatOnChain(agent)
            : 'mock-signature';
        },
        publishExplorerSignature: (signature) => {
          counters.signature += 1;
          signatures.push(signature);
          events.push('publish signature');
        },
        publishOnChainError: (hasError) => {
          counters.warning += 1;
          warnings.push(hasError);
          events.push(`warning ${String(hasError)}`);
        },
        reloadVaultState: async () => {
          counters.reload += 1;
          events.push('reload vault');
        },
        publishInFlightState: (isInFlight) => {
          events.push(`in flight ${String(isInFlight)}`);
        },
      }),
  };
}

function assertNoHeartbeatMutation(harness: CoordinatorHarness): void {
  assert.equal(harness.counters.local, 0);
  assert.equal(harness.counters.reset, 0);
  assert.equal(harness.counters.notification, 0);
  assert.equal(harness.counters.onchain, 0);
  assert.equal(harness.counters.signature, 0);
  assert.equal(harness.counters.warning, 0);
  assert.equal(harness.counters.reload, 0);
}

test('successful heartbeat calls every ready-path dependency once', async () => {
  const harness = makeHarness();

  const result = await harness.run();

  assert.deepEqual(result, {
    status: 'confirmed_on_chain',
    signature: 'mock-signature',
  });
  assert.deepEqual(harness.counters, {
    readiness: 1,
    local: 1,
    reset: 1,
    notification: 1,
    onchain: 1,
    signature: 1,
    warning: 1,
    reload: 1,
  });
  assert.deepEqual(harness.signatures, ['mock-signature']);
  assert.deepEqual(harness.warnings, [false]);
});

test('readiness runs before every local or on-chain mutation', async () => {
  const harness = makeHarness();

  await harness.run();

  assert.equal(harness.events.indexOf('readiness'), 1);
  assert.ok(
    harness.events.indexOf('readiness') <
      harness.events.indexOf('local heartbeat'),
  );
  assert.ok(
    harness.events.indexOf('readiness') <
      harness.events.indexOf('onchain heartbeat'),
  );
});

test('current WP 4.2 behaviour: local success still occurs before on-chain confirmation', async () => {
  const harness = makeHarness();

  await harness.run();

  assert.deepEqual(harness.events, [
    'in flight true',
    'readiness',
    'local heartbeat',
    'reset escalation',
    'local notification',
    'onchain heartbeat',
    'publish signature',
    'warning false',
    'reload vault',
    'in flight false',
  ]);
});

test('agent missing produces zero local and chain writes', async () => {
  const harness = makeHarness({
    readiness: async () => ({ status: 'agent_missing' }),
  });

  assert.deepEqual(await harness.run(), { status: 'agent_missing' });
  assertNoHeartbeatMutation(harness);
});

test('agent mismatch produces zero local and chain writes', async () => {
  const harness = makeHarness({
    readiness: async () => ({
      status: 'agent_mismatch',
      localAgent: OTHER_AGENT.publicKey,
      onChainAgent: AGENT.publicKey,
    }),
  });

  const result = await harness.run();
  assert.equal(result.status, 'agent_mismatch');
  assertNoHeartbeatMutation(harness);
});

test('RPC unavailable produces zero local and chain writes', async () => {
  const harness = makeHarness({
    readiness: async () => ({
      status: 'rpc_unavailable',
      error: new Error('mock RPC failure'),
    }),
  });

  assert.deepEqual(await harness.run(), {
    status: 'rpc_unavailable',
  });
  assertNoHeartbeatMutation(harness);
});

test('inactive vault produces zero local and chain writes', async () => {
  const harness = makeHarness({
    readiness: async () => ({ status: 'vault_inactive' }),
  });

  assert.deepEqual(await harness.run(), { status: 'vault_inactive' });
  assertNoHeartbeatMutation(harness);
});

test('executed vault produces zero local and chain writes', async () => {
  const harness = makeHarness({
    readiness: async () => ({ status: 'vault_executed' }),
  });

  assert.deepEqual(await harness.run(), { status: 'vault_executed' });
  assertNoHeartbeatMutation(harness);
});

test('second concurrent tap returns heartbeat_in_flight with no second readiness call', async () => {
  let releaseReadiness: (() => void) | null = null;
  let signalReadinessStarted: (() => void) | null = null;
  const readinessStarted = new Promise<void>((resolve) => {
    signalReadinessStarted = resolve;
  });
  const readinessGate = new Promise<void>((resolve) => {
    releaseReadiness = resolve;
  });
  const harness = makeHarness({
    readiness: async () => {
      signalReadinessStarted?.();
      await readinessGate;
      return READY;
    },
  });

  const first = harness.run();
  await readinessStarted;
  const second = await harness.run();

  assert.deepEqual(second, { status: 'heartbeat_in_flight' });
  assert.equal(harness.counters.readiness, 1);
  assertNoHeartbeatMutation(harness);

  assert.ok(releaseReadiness);
  releaseReadiness();
  await first;
  assert.equal(harness.counters.readiness, 1);
  assert.equal(harness.counters.onchain, 1);
});

test('single-flight lock releases after success', async () => {
  const harness = makeHarness();

  await harness.run();
  await harness.run();

  assert.equal(harness.counters.readiness, 2);
  assert.equal(harness.counters.onchain, 2);
});

test('single-flight lock releases after readiness failure', async () => {
  let readinessCalls = 0;
  const harness = makeHarness({
    readiness: async () => {
      readinessCalls += 1;
      return readinessCalls === 1
        ? { status: 'agent_missing' }
        : READY;
    },
  });

  assert.deepEqual(await harness.run(), { status: 'agent_missing' });
  assert.equal((await harness.run()).status, 'confirmed_on_chain');
  assert.equal(harness.counters.readiness, 2);
});

test('single-flight lock releases after local failure', async () => {
  const failure = new Error('mock SQLite failure');
  let localCalls = 0;
  const harness = makeHarness({
    recordLocalHeartbeat: async () => {
      localCalls += 1;
      if (localCalls === 1) throw failure;
    },
  });

  assert.deepEqual(await harness.run(), {
    status: 'local_failed',
    error: failure,
  });
  assert.equal((await harness.run()).status, 'confirmed_on_chain');
  assert.equal(harness.counters.readiness, 2);
  assert.equal(harness.counters.onchain, 1);
});

test('single-flight lock releases after on-chain failure', async () => {
  const failure = new Error('mock chain failure');
  let chainCalls = 0;
  const harness = makeHarness({
    recordHeartbeatOnChain: async () => {
      chainCalls += 1;
      if (chainCalls === 1) throw failure;
      return 'recovered-signature';
    },
  });

  assert.deepEqual(await harness.run(), {
    status: 'on_chain_failed',
    error: failure,
  });
  assert.equal((await harness.run()).status, 'confirmed_on_chain');
  assert.equal(harness.counters.readiness, 2);
  assert.equal(harness.counters.onchain, 2);
});

test('validated keypair is passed directly to recordHeartbeatOnChain', async () => {
  const harness = makeHarness();

  await harness.run();

  assert.equal(harness.agentsSubmitted.length, 1);
  assert.strictEqual(harness.agentsSubmitted[0], AGENT);
});

test('coordinator has no second key-loading path', () => {
  const source = readFileSync(
    new URL('./HeartbeatCoordinator.ts', import.meta.url),
    'utf8',
  );

  assert.doesNotMatch(source, /getKeypair|loadAgentKeypair|KeyManager/);
  assert.match(source, /readiness\.keypair/);
});

test('current WP 4.2 behaviour: local success survives on-chain failure and reload still occurs', async () => {
  const failure = new Error('mock on-chain failure');
  const harness = makeHarness({
    recordHeartbeatOnChain: async () => {
      throw failure;
    },
  });

  const result = await harness.run();

  assert.deepEqual(result, { status: 'on_chain_failed', error: failure });
  assert.equal(harness.counters.local, 1);
  assert.equal(harness.counters.reset, 1);
  assert.equal(harness.counters.notification, 1);
  assert.equal(harness.counters.signature, 0);
  assert.deepEqual(harness.warnings, [true]);
  assert.equal(harness.counters.reload, 1);
});

test('local heartbeat failure prevents every later success effect', async () => {
  const failure = new Error('mock SQLite failure');
  const harness = makeHarness({
    recordLocalHeartbeat: async () => {
      throw failure;
    },
  });

  assert.deepEqual(await harness.run(), {
    status: 'local_failed',
    error: failure,
  });
  assert.equal(harness.counters.reset, 0);
  assert.equal(harness.counters.notification, 0);
  assert.equal(harness.counters.onchain, 0);
  assert.equal(harness.counters.signature, 0);
  assert.equal(harness.counters.reload, 0);
});

test('Explorer signature is published only after recordHeartbeatOnChain resolves', async () => {
  let resolveSignature: ((signature: string) => void) | null = null;
  let signalChainStarted: (() => void) | null = null;
  const chainStarted = new Promise<void>((resolve) => {
    signalChainStarted = resolve;
  });
  const pendingSignature = new Promise<string>((resolve) => {
    resolveSignature = resolve;
  });
  const harness = makeHarness({
    recordHeartbeatOnChain: async () => {
      signalChainStarted?.();
      return pendingSignature;
    },
  });

  const attempt = harness.run();
  await chainStarted;
  assert.equal(harness.counters.signature, 0);
  assert.deepEqual(harness.signatures, []);

  assert.ok(resolveSignature);
  resolveSignature('late-signature');
  assert.equal((await attempt).status, 'confirmed_on_chain');
  assert.deepEqual(harness.signatures, ['late-signature']);
});

test('unexpected readiness exception releases the lock without mutation', async () => {
  let calls = 0;
  const harness = makeHarness({
    readiness: async () => {
      calls += 1;
      if (calls === 1) throw new Error('unexpected readiness defect');
      return READY;
    },
  });

  assert.deepEqual(await harness.run(), {
    status: 'invalid_on_chain_state',
  });
  assertNoHeartbeatMutation(harness);
  assert.equal((await harness.run()).status, 'confirmed_on_chain');
});
