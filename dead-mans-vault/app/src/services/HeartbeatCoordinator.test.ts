import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import bs58 from 'bs58';
import { Keypair, PublicKey, Transaction } from '@solana/web3.js';
import {
  createPreparedHeartbeatOperation,
  transitionHeartbeatOperation,
  type HeartbeatOperationRecord,
} from '../db/heartbeatOperationRepoCore.ts';
import type { AgentReadinessResult } from './AgentReadinessService.ts';
import type { HeartbeatVerificationResult } from './HeartbeatConfirmationVerifier.ts';
import type { HeartbeatReconciliationResult } from './HeartbeatOperationReconciler.ts';
import {
  createHeartbeatCoordinator,
  type ConfirmedHeartbeatLocalInput,
  type HeartbeatAttemptResult,
  type HeartbeatExplorerTransactionStatus,
} from './HeartbeatCoordinator.ts';
import type {
  PreparedTransaction,
  SendAndConfirmLifecycle,
  SendAndConfirmResult,
} from './sendAndConfirmTransaction.ts';
import type {
  PreparedHeartbeatTransaction,
  PrepareHeartbeatTransactionResult,
} from './VaultTransactionService.ts';

const OWNER = new PublicKey(Buffer.alloc(32, 2));
const VAULT = new PublicKey(Buffer.alloc(32, 3));
const HEARTBEAT = new PublicKey(Buffer.alloc(32, 4));
const AGENT = Keypair.generate();
const EXPECTED_SIGNATURE = bs58.encode(Buffer.alloc(64, 5));
const PREPARED: PreparedTransaction = {
  signature: EXPECTED_SIGNATURE,
  blockhash: Keypair.generate().publicKey.toBase58(),
  lastValidBlockHeight: 123,
};
const PREPARED_HEARTBEAT: PreparedHeartbeatTransaction = {
  transaction: new Transaction(),
  agent: AGENT.publicKey,
  blockhashValidity: {
    blockhash: PREPARED.blockhash,
    lastValidBlockHeight: PREPARED.lastValidBlockHeight,
  },
  feeReadiness: {
    status: 'ready',
    agent: AGENT.publicKey,
    balanceLamports: 5_000_000,
    feeLamports: 5_000,
    reserveTargetLamports: 5_000_000,
    estimatedHeartbeatsRemaining: 1_000,
    observedSlot: 10,
  },
};

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

const VERIFIED: HeartbeatVerificationResult = {
  status: 'verified',
  lastHeartbeat: 1_001,
  lastMethod: 0,
  totalHeartbeats: 5n,
};

function operation(): HeartbeatOperationRecord {
  return createPreparedHeartbeatOperation({
    cluster: 'devnet',
    programId: Keypair.generate().publicKey.toBase58(),
    owner: OWNER.toBase58(),
    vault: VAULT.toBase58(),
    heartbeat: HEARTBEAT.toBase58(),
    agentPubkey: AGENT.publicKey.toBase58(),
    method: 'active_tap',
    methodIndex: 0,
    signature: EXPECTED_SIGNATURE,
    blockhash: PREPARED.blockhash,
    lastValidBlockHeight: 123,
    beforeLastHeartbeat: 1_000,
    beforeTotalHeartbeats: '4',
    heartbeatInterval: 86_400,
    gracePeriod: 604_800,
    createdAt: 10,
    updatedAt: 10,
  });
}

function makeHarness(overrides: {
  unresolved?: () => Promise<HeartbeatOperationRecord | null>;
  reconcile?: (
    record: HeartbeatOperationRecord,
  ) => Promise<HeartbeatReconciliationResult>;
  readiness?: () => Promise<AgentReadinessResult>;
  prepare?: () => Promise<void>;
  feePreparation?: () => Promise<PrepareHeartbeatTransactionResult>;
  transaction?: (
    lifecycle: SendAndConfirmLifecycle,
  ) => Promise<SendAndConfirmResult>;
  verification?: () => Promise<HeartbeatVerificationResult>;
  persist?: (input: ConfirmedHeartbeatLocalInput) => Promise<void>;
} = {}) {
  const coordinator = createHeartbeatCoordinator();
  const events: Array<string> = [];
  const localInputs: Array<ConfirmedHeartbeatLocalInput> = [];
  const publications: Array<{
    signature: string;
    status: HeartbeatExplorerTransactionStatus;
  }> = [];
  let currentOperation: HeartbeatOperationRecord | null = null;
  const counters = {
    unresolved: 0,
    reconcile: 0,
    readiness: 0,
    feePreparation: 0,
    transaction: 0,
    send: 0,
    verify: 0,
    persist: 0,
    deadlineRefresh: 0,
    notification: 0,
    reload: 0,
  };

  const run = () =>
    coordinator.attempt({
      method: 'active_tap',
      getUnresolvedOperation: async () => {
        counters.unresolved += 1;
        events.push('check journal');
        return overrides.unresolved
          ? overrides.unresolved()
          : currentOperation;
      },
      reconcileOperation: async (record) => {
        counters.reconcile += 1;
        events.push('reconcile');
        return overrides.reconcile
          ? overrides.reconcile(record)
          : {
              status: 'still_pending',
              signature: record.signature,
              operationState: record.state,
            };
      },
      checkAgentReadiness: async () => {
        counters.readiness += 1;
        events.push('readiness');
        return overrides.readiness
          ? overrides.readiness()
          : READY;
      },
      prepareOperation: async (_readiness, prepared) => {
        events.push('persist prepared');
        assert.equal(prepared.signature, EXPECTED_SIGNATURE);
        if (overrides.prepare) await overrides.prepare();
        currentOperation = operation();
      },
      transitionOperation: async (_signature, state, patch) => {
        events.push(`journal ${state}`);
        if (!currentOperation) currentOperation = operation();
        currentOperation = transitionHeartbeatOperation(
          currentOperation,
          state,
          currentOperation.updatedAt + 1,
          patch,
        );
        return currentOperation;
      },
      prepareHeartbeatTransaction: async (agent) => {
        counters.feePreparation += 1;
        events.push('prepare exact transaction and check fee');
        assert.ok(agent.equals(AGENT.publicKey));
        return overrides.feePreparation
          ? overrides.feePreparation()
          : {
              status: 'prepared',
              prepared: PREPARED_HEARTBEAT,
            };
      },
      recordHeartbeatOnChain: async (agent, prepared, lifecycle) => {
        counters.transaction += 1;
        assert.strictEqual(agent, AGENT);
        assert.ok(prepared.agent.equals(AGENT.publicKey));
        events.push('build/sign');
        if (overrides.transaction) {
          return overrides.transaction(lifecycle);
        }
        await lifecycle.onPrepared(PREPARED);
        counters.send += 1;
        events.push('send');
        await lifecycle.onSubmitted?.(PREPARED);
        events.push('confirm');
        return {
          status: 'confirmed',
          signature: EXPECTED_SIGNATURE,
        };
      },
      verifyHeartbeatConfirmation: async () => {
        counters.verify += 1;
        events.push('verify');
        return overrides.verification
          ? overrides.verification()
          : VERIFIED;
      },
      recordConfirmedHeartbeat: async (input) => {
        counters.persist += 1;
        localInputs.push(input);
        events.push('persist local');
        await overrides.persist?.(input);
      },
      refreshAuthoritativeDeadline: async () => {
        counters.deadlineRefresh += 1;
        events.push('refresh deadline');
      },
      sendLocalConfirmationNotification: async () => {
        counters.notification += 1;
        events.push('notification');
      },
      reloadVaultState: async () => {
        counters.reload += 1;
        events.push('reload');
      },
      publishExplorerTransaction: (signature, status) => {
        publications.push({ signature, status });
        events.push(`publish ${status}`);
      },
      publishInFlightState: (value) => {
        events.push(`in flight ${String(value)}`);
      },
    });

  return {
    coordinator,
    counters,
    events,
    localInputs,
    publications,
    run,
    setOperation: (value: HeartbeatOperationRecord | null) => {
      currentOperation = value;
    },
  };
}

function assertNoLocalSuccess(
  harness: ReturnType<typeof makeHarness>,
): void {
  assert.equal(harness.counters.persist, 0);
  assert.equal(harness.counters.deadlineRefresh, 0);
  assert.equal(harness.counters.notification, 0);
  assert.equal(
    harness.publications.some(
      (publication) => publication.status === 'confirmed_success',
    ),
    false,
  );
}

test('successful operation has exact journal-first authoritative ordering', async () => {
  const harness = makeHarness();
  const result = await harness.run();
  assert.deepEqual(result, {
    status: 'confirmed_on_chain',
    signature: EXPECTED_SIGNATURE,
    lastHeartbeat: 1_001,
    totalHeartbeats: 5n,
    localSync: 'complete',
    feeReadiness: 'ready',
  });
  assert.deepEqual(harness.events, [
    'in flight true',
    'check journal',
    'readiness',
    'prepare exact transaction and check fee',
    'build/sign',
    'persist prepared',
    'send',
    'journal submitted',
    'confirm',
    'verify',
    'persist local',
    'journal resolved_confirmed',
    'refresh deadline',
    'notification',
    'publish confirmed_success',
    'reload',
    'in flight false',
  ]);
});

test('verified insufficient agent funds blocks before signing, journal, send, and local success', async () => {
  const harness = makeHarness({
    feePreparation: async () => ({
      status: 'insufficient',
      agent: AGENT.publicKey,
      balanceLamports: 4_999,
      feeLamports: 5_000,
      shortfallLamports: 1,
      reserveTargetLamports: 5_000_000,
      observedSlot: 10,
    }),
  });
  const result = await harness.run();
  assert.deepEqual(result, {
    status: 'insufficient_agent_funds',
    agent: AGENT.publicKey.toBase58(),
    balanceLamports: 4_999,
    feeLamports: 5_000,
    shortfallLamports: 1,
  });
  assert.equal(harness.counters.transaction, 0);
  assert.equal(harness.counters.send, 0);
  assert.equal(harness.events.includes('persist prepared'), false);
  assertNoLocalSuccess(harness);
});

test('low reserve and unavailable auxiliary checks both allow one journalled deliberate heartbeat', async (context) => {
  const cases = [
    {
      name: 'low reserve',
      feeReadiness: {
        status: 'low_reserve' as const,
        agent: AGENT.publicKey,
        balanceLamports: 6_000,
        feeLamports: 5_000,
        reserveTargetLamports: 5_000_000,
        topUpLamports: 4_994_000,
        estimatedHeartbeatsRemaining: 1,
        observedSlot: 10,
      },
      expected: 'low_reserve',
    },
    {
      name: 'check unavailable',
      feeReadiness: {
        status: 'check_unavailable' as const,
        reason: 'balance_unavailable' as const,
      },
      expected: 'check_unavailable',
    },
  ];
  for (const scenario of cases) {
    await context.test(scenario.name, async () => {
      const harness = makeHarness({
        feePreparation: async () => ({
          status: 'prepared',
          prepared: {
            ...PREPARED_HEARTBEAT,
            feeReadiness: scenario.feeReadiness,
          },
        }),
      });
      const result = await harness.run();
      assert.equal(result.status, 'confirmed_on_chain');
      if (result.status !== 'confirmed_on_chain') return;
      assert.equal(result.feeReadiness, scenario.expected);
      assert.equal(harness.counters.transaction, 1);
      assert.equal(harness.counters.send, 1);
      assert.equal(
        harness.events.filter(
          (event) => event === 'persist prepared',
        ).length,
        1,
      );
    });
  }
});

test('journal failure prevents send and every local success effect', async () => {
  const failure = new Error('journal unavailable');
  const harness = makeHarness({
    prepare: async () => {
      throw failure;
    },
    transaction: async (lifecycle) => {
      try {
        await lifecycle.onPrepared(PREPARED);
      } catch (error: unknown) {
        return { status: 'journal_failed', error };
      }
      throw new Error('unreachable');
    },
  });
  const result = await harness.run();
  assert.equal(result.status, 'journal_failed');
  assert.equal(harness.counters.send, 0);
  assertNoLocalSuccess(harness);
});

test('submission ambiguity is durable, linkable, and has no local success', async () => {
  const harness = makeHarness({
    transaction: async (lifecycle) => {
      await lifecycle.onPrepared(PREPARED);
      harness.counters.send += 1;
      await lifecycle.onSubmissionUnknown?.(
        PREPARED,
        'send_exception',
      );
      return {
        status: 'submission_unknown',
        signature: EXPECTED_SIGNATURE,
        error: new Error('lost response'),
        safeErrorCode: 'send_exception',
      };
    },
  });
  const result = await harness.run();
  assert.equal(result.status, 'submission_unknown');
  assert.equal(harness.counters.send, 1);
  assertNoLocalSuccess(harness);
  assert.deepEqual(harness.publications, [{
    signature: EXPECTED_SIGNATURE,
    status: 'submission_unknown',
  }]);
});

test('confirmed failure, confirmation unknown, and post-state failure never mutate local liveness', async (context) => {
  const scenarios: Array<{
    name: string;
    transaction?: SendAndConfirmResult;
    verification?: HeartbeatVerificationResult;
  }> = [
    {
      name: 'confirmed failed',
      transaction: {
        status: 'confirmed_failed',
        signature: EXPECTED_SIGNATURE,
        transactionError: { custom: 1 },
      },
    },
    {
      name: 'confirmation unknown',
      transaction: {
        status: 'confirmation_unknown',
        signature: EXPECTED_SIGNATURE,
        error: new Error('timeout'),
      },
    },
    {
      name: 'post-state unavailable',
      transaction: {
        status: 'confirmed',
        signature: EXPECTED_SIGNATURE,
      },
      verification: { status: 'rpc_unavailable' },
    },
  ];
  for (const scenario of scenarios) {
    await context.test(scenario.name, async () => {
      const harness = makeHarness({
        transaction: async (lifecycle) => {
          await lifecycle.onPrepared(PREPARED);
          await lifecycle.onSubmitted?.(PREPARED);
          const result = scenario.transaction;
          assert.ok(result);
          if (result.status === 'confirmed_failed') {
            await lifecycle.onConfirmedFailed?.(PREPARED);
          } else if (result.status === 'confirmation_unknown') {
            await lifecycle.onConfirmationUnknown?.(PREPARED);
          }
          return result;
        },
        verification: scenario.verification
          ? async () => scenario.verification!
          : undefined,
      });
      await harness.run();
      assertNoLocalSuccess(harness);
    });
  }
});

test('an unresolved journal record reconciles before readiness and blocks a new send', async () => {
  const pending = operation();
  const harness = makeHarness({
    unresolved: async () => pending,
  });
  const result = await harness.run();
  assert.deepEqual(result, {
    status: 'heartbeat_still_pending',
    signature: EXPECTED_SIGNATURE,
  });
  assert.equal(harness.counters.reconcile, 1);
  assert.equal(harness.counters.readiness, 0);
  assert.equal(harness.counters.transaction, 0);
  assert.equal(harness.counters.send, 0);
});

test('reconciled confirmed action publishes success but never submits or sends an OS notification', async () => {
  const pending = operation();
  const harness = makeHarness({
    unresolved: async () => pending,
    reconcile: async () => ({
      status: 'reconciled_confirmed',
      signature: EXPECTED_SIGNATURE,
      lastHeartbeat: 1_001,
      totalHeartbeats: 5n,
      localSync: 'complete',
    }),
  });
  const result = await harness.run();
  assert.equal(result.status, 'heartbeat_reconciled_confirmed');
  assert.equal(harness.counters.transaction, 0);
  assert.equal(harness.counters.notification, 0);
  assert.deepEqual(harness.publications, [{
    signature: EXPECTED_SIGNATURE,
    status: 'confirmed_success',
  }]);
});

test('resolved failed or expired permits only a later deliberate action to submit', async (context) => {
  for (const reconciled of ['reconciled_failed', 'reconciled_expired'] as const) {
    await context.test(reconciled, async () => {
      let first = true;
      const pending = operation();
      const harness = makeHarness({
        unresolved: async () => first ? pending : null,
        reconcile: async () => {
          first = false;
          return {
            status: reconciled,
            signature: EXPECTED_SIGNATURE,
          };
        },
      });
      await harness.run();
      assert.equal(harness.counters.transaction, 0);
      await harness.run();
      assert.equal(harness.counters.transaction, 1);
      assert.equal(harness.counters.send, 1);
    });
  }
});

test('terminal historical records do not block when unresolved query returns none', async () => {
  const harness = makeHarness({
    unresolved: async () => null,
  });
  await harness.run();
  assert.equal(harness.counters.readiness, 1);
  assert.equal(harness.counters.send, 1);
});

test('local-history failure records sync-pending but does not negate verified chain success', async () => {
  const harness = makeHarness({
    persist: async () => {
      throw new Error('disk');
    },
  });
  const result = await harness.run();
  assert.equal(result.status, 'confirmed_on_chain');
  if (result.status !== 'confirmed_on_chain') return;
  assert.equal(result.localSync, 'failed');
  assert.equal(
    harness.events.includes('journal confirmed_local_sync_pending'),
    true,
  );
  assert.equal(harness.counters.deadlineRefresh, 1);
});

test('single-flight blocks a concurrent reconciliation/readiness and releases afterward', async () => {
  let release: (() => void) | null = null;
  let started: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const signal = new Promise<void>((resolve) => {
    started = resolve;
  });
  const harness = makeHarness({
    unresolved: async () => {
      started?.();
      await gate;
      return null;
    },
  });
  const first = harness.run();
  await signal;
  assert.deepEqual(await harness.run(), {
    status: 'heartbeat_in_flight',
  });
  assert.equal(harness.counters.unresolved, 1);
  release?.();
  await first;
  assert.equal(harness.coordinator.isInFlight(), false);
});

test('lock releases after every reconciliation result taxonomy', async () => {
  const pending = operation();
  const results: Array<HeartbeatReconciliationResult> = [
    {
      status: 'still_pending',
      signature: EXPECTED_SIGNATURE,
      operationState: 'prepared',
    },
    {
      status: 'reconciliation_unavailable',
      signature: EXPECTED_SIGNATURE,
    },
    {
      status: 'post_state_unverified',
      signature: EXPECTED_SIGNATURE,
    },
    {
      status: 'reconciled_failed',
      signature: EXPECTED_SIGNATURE,
    },
    {
      status: 'reconciled_expired',
      signature: EXPECTED_SIGNATURE,
    },
    {
      status: 'reconciled_chain_advanced',
      lastHeartbeat: 1_001,
      totalHeartbeats: 5n,
    },
    { status: 'invalid_local_record' },
  ];
  for (const reconciliation of results) {
    const harness = makeHarness({
      unresolved: async () => pending,
      reconcile: async () => reconciliation,
    });
    await harness.run();
    assert.equal(harness.coordinator.isInFlight(), false);
  }
});

test('coordinator contains no send, retry, raw transaction, key reload, or pre-chain local commit', () => {
  const source = readFileSync(
    new URL('./HeartbeatCoordinator.ts', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(source, /sendRawTransaction|getKeypair|KeyManager/);
  assert.doesNotMatch(source, /console\.|setInterval|setTimeout|while\s*\(/);
  assert.match(
    source,
    /getUnresolvedOperation[\s\S]*checkAgentReadiness[\s\S]*recordHeartbeatOnChain[\s\S]*verifyHeartbeatConfirmation[\s\S]*recordConfirmedHeartbeat/,
  );
});
