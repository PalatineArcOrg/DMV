import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, PublicKey } from '@solana/web3.js';
import type { AgentReadinessResult } from './AgentReadinessService.ts';
import type { HeartbeatVerificationResult } from './HeartbeatConfirmationVerifier.ts';
import {
  createHeartbeatCoordinator,
  type ConfirmedHeartbeatLocalInput,
  type HeartbeatAttemptResult,
  type HeartbeatExplorerTransactionStatus,
} from './HeartbeatCoordinator.ts';
import type { SendAndConfirmResult } from './sendAndConfirmTransaction.ts';

const OWNER = new PublicKey(Buffer.alloc(32, 2));
const VAULT = new PublicKey(Buffer.alloc(32, 3));
const HEARTBEAT = new PublicKey(Buffer.alloc(32, 4));
const AGENT = Keypair.generate();
const OTHER_AGENT = Keypair.generate();

const READY: AgentReadinessResult = {
  status: 'ready',
  owner: OWNER,
  vault: VAULT,
  heartbeat: HEARTBEAT,
  localAgent: AGENT.publicKey,
  onChainAgent: AGENT.publicKey,
  keypair: AGENT,
  vaultConfig: {
    heartbeatInterval: 86_400,
    gracePeriod: 604_800,
    active: true,
    executed: false,
  },
  heartbeatBefore: {
    lastHeartbeat: 1_000,
    lastMethod: 0,
    totalHeartbeats: 4n,
  },
};

const CONFIRMED: SendAndConfirmResult = {
  status: 'confirmed',
  signature: 'mock-signature',
};

const VERIFIED: HeartbeatVerificationResult = {
  status: 'verified',
  lastHeartbeat: 1_001,
  lastMethod: 0,
  totalHeartbeats: 5n,
};

interface Counters {
  readiness: number;
  transaction: number;
  verify: number;
  persist: number;
  reset: number;
  notification: number;
  publish: number;
  reload: number;
}

interface CoordinatorHarness {
  counters: Counters;
  events: Array<string>;
  localInputs: Array<ConfirmedHeartbeatLocalInput>;
  notificationDates: Array<Date>;
  publications: Array<{
    signature: string;
    status: HeartbeatExplorerTransactionStatus;
  }>;
  agentsSubmitted: Array<Keypair>;
  run: () => Promise<HeartbeatAttemptResult>;
  isInFlight: () => boolean;
}

function makeHarness(
  overrides: {
    readiness?: () => Promise<AgentReadinessResult>;
    transaction?: (
      agent: Keypair,
    ) => Promise<SendAndConfirmResult>;
    verification?: () => Promise<HeartbeatVerificationResult>;
    persist?: (input: ConfirmedHeartbeatLocalInput) => Promise<void>;
    reset?: () => void;
    notification?: (nextDueDate: Date) => Promise<void>;
    reload?: () => Promise<void>;
  } = {},
): CoordinatorHarness {
  const coordinator = createHeartbeatCoordinator();
  const counters: Counters = {
    readiness: 0,
    transaction: 0,
    verify: 0,
    persist: 0,
    reset: 0,
    notification: 0,
    publish: 0,
    reload: 0,
  };
  const events: Array<string> = [];
  const localInputs: Array<ConfirmedHeartbeatLocalInput> = [];
  const notificationDates: Array<Date> = [];
  const publications: CoordinatorHarness['publications'] = [];
  const agentsSubmitted: Array<Keypair> = [];

  return {
    counters,
    events,
    localInputs,
    notificationDates,
    publications,
    agentsSubmitted,
    isInFlight: coordinator.isInFlight,
    run: () =>
      coordinator.attempt({
        method: 'active_tap',
        checkAgentReadiness: async () => {
          counters.readiness += 1;
          events.push('readiness');
          return overrides.readiness
            ? overrides.readiness()
            : READY;
        },
        recordHeartbeatOnChain: async (agent) => {
          counters.transaction += 1;
          agentsSubmitted.push(agent);
          events.push('submit and confirm');
          return overrides.transaction
            ? overrides.transaction(agent)
            : CONFIRMED;
        },
        verifyHeartbeatConfirmation: async (verificationInput) => {
          counters.verify += 1;
          events.push('verify post-state');
          assert.equal(verificationInput.vault.equals(VAULT), true);
          assert.equal(
            verificationInput.heartbeat.equals(HEARTBEAT),
            true,
          );
          assert.strictEqual(
            verificationInput.heartbeatBefore,
            READY.status === 'ready'
              ? READY.heartbeatBefore
              : undefined,
          );
          assert.equal(verificationInput.expectedMethod, 0);
          return overrides.verification
            ? overrides.verification()
            : VERIFIED;
        },
        recordConfirmedHeartbeat: async (input) => {
          counters.persist += 1;
          localInputs.push(input);
          events.push('persist local');
          if (overrides.persist) await overrides.persist(input);
        },
        resetLocalEscalation: () => {
          counters.reset += 1;
          events.push('reset escalation');
          overrides.reset?.();
        },
        sendLocalConfirmationNotification: async (nextDueDate) => {
          counters.notification += 1;
          notificationDates.push(nextDueDate);
          events.push('notification');
          if (overrides.notification) {
            await overrides.notification(nextDueDate);
          }
        },
        publishExplorerTransaction: (signature, status) => {
          counters.publish += 1;
          publications.push({ signature, status });
          events.push(`publish ${status}`);
        },
        reloadVaultState: async () => {
          counters.reload += 1;
          events.push('reload');
          if (overrides.reload) await overrides.reload();
        },
        publishInFlightState: (isInFlight) => {
          events.push(`in flight ${String(isInFlight)}`);
        },
      }),
  };
}

function assertNoLocalSuccess(harness: CoordinatorHarness): void {
  assert.equal(harness.counters.persist, 0);
  assert.equal(harness.counters.reset, 0);
  assert.equal(harness.counters.notification, 0);
  assert.equal(
    harness.publications.some(
      (publication) => publication.status === 'confirmed_success',
    ),
    false,
  );
}

test('verified success follows the exact authoritative ordering', async () => {
  const harness = makeHarness();

  const result = await harness.run();

  assert.deepEqual(result, {
    status: 'confirmed_on_chain',
    signature: 'mock-signature',
    lastHeartbeat: 1_001,
    totalHeartbeats: 5n,
    localSync: 'complete',
  });
  assert.deepEqual(harness.events, [
    'in flight true',
    'readiness',
    'submit and confirm',
    'verify post-state',
    'persist local',
    'reset escalation',
    'notification',
    'publish confirmed_success',
    'reload',
    'in flight false',
  ]);
});

test('readiness and transaction confirmation happen before every local mutation', async () => {
  const harness = makeHarness();

  await harness.run();

  const persistenceIndex = harness.events.indexOf('persist local');
  assert.ok(harness.events.indexOf('readiness') < persistenceIndex);
  assert.ok(
    harness.events.indexOf('submit and confirm') < persistenceIndex,
  );
  assert.ok(
    harness.events.indexOf('verify post-state') < persistenceIndex,
  );
});

test('submission_failed causes zero local success effects', async () => {
  const failure = new Error('mock submission failure');
  const harness = makeHarness({
    transaction: async () => ({
      status: 'submission_failed',
      error: failure,
    }),
  });

  assert.deepEqual(await harness.run(), {
    status: 'submission_failed',
    error: failure,
  });
  assert.equal(harness.counters.verify, 0);
  assertNoLocalSuccess(harness);
});

test('confirmed_failed causes zero local success effects and publishes failed signature', async () => {
  const transactionError = { custom: 1 };
  const harness = makeHarness({
    transaction: async () => ({
      status: 'confirmed_failed',
      signature: 'failed-signature',
      transactionError,
    }),
  });

  assert.deepEqual(await harness.run(), {
    status: 'transaction_failed',
    signature: 'failed-signature',
    transactionError,
  });
  assert.deepEqual(harness.publications, [{
    signature: 'failed-signature',
    status: 'confirmed_failed',
  }]);
  assertNoLocalSuccess(harness);
});

test('confirmation_unknown preserves signature and causes zero local success effects', async () => {
  const failure = new Error('mock confirmation timeout');
  const harness = makeHarness({
    transaction: async () => ({
      status: 'confirmation_unknown',
      signature: 'unknown-signature',
      error: failure,
    }),
  });

  assert.deepEqual(await harness.run(), {
    status: 'confirmation_unknown',
    signature: 'unknown-signature',
    error: failure,
  });
  assert.deepEqual(harness.publications, [{
    signature: 'unknown-signature',
    status: 'confirmation_unknown',
  }]);
  assertNoLocalSuccess(harness);
});

test('post-state RPC failure preserves signature without local success', async () => {
  const harness = makeHarness({
    verification: async () => ({
      status: 'rpc_unavailable',
      error: new Error('mock post-state RPC failure'),
    }),
  });

  assert.deepEqual(await harness.run(), {
    status: 'post_state_unavailable',
    signature: 'mock-signature',
  });
  assert.deepEqual(harness.publications, [{
    signature: 'mock-signature',
    status: 'post_state_unverified',
  }]);
  assertNoLocalSuccess(harness);
});

test('invalid post-state preserves signature without local success', async () => {
  const harness = makeHarness({
    verification: async () => ({
      status: 'invalid_on_chain_state',
      reason: 'mock invalid account',
    }),
  });

  assert.deepEqual(await harness.run(), {
    status: 'post_state_invalid',
    signature: 'mock-signature',
  });
  assertNoLocalSuccess(harness);
});

test('post-state that did not advance preserves signature without local success', async () => {
  const harness = makeHarness({
    verification: async () => ({ status: 'not_advanced' }),
  });

  assert.deepEqual(await harness.run(), {
    status: 'post_state_not_advanced',
    signature: 'mock-signature',
  });
  assertNoLocalSuccess(harness);
});

test('local persistence receives verified chain timestamp, method and signature', async () => {
  const harness = makeHarness();

  await harness.run();

  assert.deepEqual(harness.localInputs, [{
    method: 'active_tap',
    onChainTimestamp: 1_001,
    transactionSignature: 'mock-signature',
  }]);
});

test('notification next due uses verified chain timestamp plus vault interval', async () => {
  const harness = makeHarness();

  await harness.run();

  assert.equal(harness.notificationDates.length, 1);
  assert.equal(
    harness.notificationDates[0].getTime(),
    (1_001 + 86_400) * 1000,
  );
});

test('local persistence failure does not negate verified chain success', async () => {
  const harness = makeHarness({
    persist: async () => {
      throw new Error('mock local cache failure');
    },
  });

  const result = await harness.run();

  assert.equal(result.status, 'confirmed_on_chain');
  if (result.status !== 'confirmed_on_chain') return;
  assert.equal(result.localSync, 'failed');
  assert.equal(harness.counters.reset, 1);
  assert.equal(harness.counters.notification, 1);
  assert.deepEqual(harness.publications, [{
    signature: 'mock-signature',
    status: 'confirmed_success',
  }]);
  assert.equal(harness.counters.reload, 1);
});

test('notification failure does not negate verified chain success', async () => {
  const harness = makeHarness({
    notification: async () => {
      throw new Error('mock notification failure');
    },
  });

  const result = await harness.run();

  assert.equal(result.status, 'confirmed_on_chain');
  assert.equal(harness.counters.publish, 1);
  assert.equal(harness.counters.reload, 1);
});

test('vault reload failure does not negate verified chain success', async () => {
  const harness = makeHarness({
    reload: async () => {
      throw new Error('mock reload failure');
    },
  });

  const result = await harness.run();

  assert.equal(result.status, 'confirmed_on_chain');
  assert.equal(harness.counters.reload, 1);
});

test('validated readiness keypair is passed directly to transaction submission', async () => {
  const harness = makeHarness();

  await harness.run();

  assert.deepEqual(harness.agentsSubmitted, [AGENT]);
  assert.strictEqual(harness.agentsSubmitted[0], AGENT);
});

test('unready states retain zero local and chain writes', async (context) => {
  const states: Array<Exclude<
    AgentReadinessResult,
    { status: 'ready' }
  >> = [
    { status: 'agent_missing' },
    {
      status: 'agent_mismatch',
      localAgent: OTHER_AGENT.publicKey,
      onChainAgent: AGENT.publicKey,
    },
    { status: 'rpc_unavailable' },
    { status: 'vault_inactive' },
    { status: 'vault_executed' },
  ];

  for (const readiness of states) {
    await context.test(readiness.status, async () => {
      const harness = makeHarness({
        readiness: async () => readiness,
      });
      const result = await harness.run();

      assert.equal(result.status, readiness.status);
      assert.equal(harness.counters.transaction, 0);
      assert.equal(harness.counters.verify, 0);
      assertNoLocalSuccess(harness);
    });
  }
});

test('second concurrent tap returns heartbeat_in_flight without a second readiness call', async () => {
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
  assert.equal(harness.counters.transaction, 0);

  assert.ok(releaseReadiness);
  releaseReadiness();
  await first;
  assert.equal(harness.counters.transaction, 1);
});

test('single-flight lock releases for every terminal result taxonomy', async () => {
  const scenarios: Array<{
    transaction?: SendAndConfirmResult;
    verification?: HeartbeatVerificationResult;
  }> = [
    { transaction: CONFIRMED, verification: VERIFIED },
    {
      transaction: {
        status: 'submission_failed',
        error: new Error('submission'),
      },
    },
    {
      transaction: {
        status: 'confirmed_failed',
        signature: 'failed',
        transactionError: { custom: 1 },
      },
    },
    {
      transaction: {
        status: 'confirmation_unknown',
        signature: 'unknown',
        error: new Error('unknown'),
      },
    },
    {
      transaction: CONFIRMED,
      verification: { status: 'not_advanced' },
    },
    {
      transaction: CONFIRMED,
      verification: {
        status: 'invalid_on_chain_state',
        reason: 'invalid',
      },
    },
    {
      transaction: CONFIRMED,
      verification: { status: 'rpc_unavailable' },
    },
  ];

  for (const scenario of scenarios) {
    const harness = makeHarness({
      transaction: async () => scenario.transaction ?? CONFIRMED,
      verification: async () => scenario.verification ?? VERIFIED,
    });
    await harness.run();
    assert.equal(harness.isInFlight(), false);
  }
});

test('coordinator contains no key reload, retry, raw transaction logging or pre-chain local commit', () => {
  const source = readFileSync(
    new URL('./HeartbeatCoordinator.ts', import.meta.url),
    'utf8',
  );

  assert.doesNotMatch(source, /getKeypair|loadAgentKeypair|KeyManager/);
  assert.doesNotMatch(source, /console\.|setInterval|setTimeout/);
  assert.doesNotMatch(source, /sendRawTransaction/);
  assert.match(
    source,
    /recordHeartbeatOnChain[\s\S]*verifyHeartbeatConfirmation[\s\S]*recordConfirmedHeartbeat/,
  );
});
