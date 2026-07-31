import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import bs58 from 'bs58';
import { Keypair } from '@solana/web3.js';
import {
  createPreparedHeartbeatOperation,
  transitionHeartbeatOperation,
  type HeartbeatOperationRecord,
} from '../db/heartbeatOperationRepoCore.ts';
import {
  createHeartbeatOperationReconciler,
} from './HeartbeatOperationReconciler.ts';

function makeOperation(): HeartbeatOperationRecord {
  const signature = bs58.encode(Buffer.alloc(64, 7));
  return createPreparedHeartbeatOperation({
    cluster: 'devnet',
    programId: Keypair.generate().publicKey.toBase58(),
    owner: Keypair.generate().publicKey.toBase58(),
    vault: Keypair.generate().publicKey.toBase58(),
    heartbeat: Keypair.generate().publicKey.toBase58(),
    agentPubkey: Keypair.generate().publicKey.toBase58(),
    method: 'active_tap',
    methodIndex: 0,
    signature,
    blockhash: bs58.encode(Buffer.alloc(32, 8)),
    lastValidBlockHeight: 100,
    beforeLastHeartbeat: 1_000,
    beforeTotalHeartbeats: '9007199254740993',
    heartbeatInterval: 86_400,
    gracePeriod: 604_800,
    createdAt: 10,
    updatedAt: 10,
  });
}

function identity(operation: HeartbeatOperationRecord) {
  return {
    cluster: operation.cluster,
    programId: operation.programId,
    owner: operation.owner,
    vault: operation.vault,
    heartbeat: operation.heartbeat,
    agentPubkey: operation.agentPubkey,
  };
}

function harness(overrides: {
  status?: () => Promise<unknown>;
  blockHeight?: () => Promise<number>;
  verify?: () => Promise<
    | {
        status: 'verified';
        lastHeartbeat: number;
        lastMethod: number;
        totalHeartbeats: bigint;
      }
    | { status: 'not_advanced' }
    | { status: 'rpc_unavailable' }
    | { status: 'invalid_on_chain_state'; reason: string }
  >;
  current?: () => Promise<
    | {
        status: 'verified_state';
        lastHeartbeat: number;
        lastMethod: number;
        totalHeartbeats: bigint;
      }
    | { status: 'rpc_unavailable' }
    | { status: 'invalid_on_chain_state'; reason: string }
  >;
  persist?: () => Promise<void>;
  authoritative?: () => Promise<void>;
  identityValid?: () => Promise<boolean>;
} = {}) {
  let operation = makeOperation();
  const calls = {
    status: 0,
    blockHeight: 0,
    verify: 0,
    current: 0,
    persist: 0,
    authoritative: 0,
    reset: 0,
    reload: 0,
    transition: 0,
    send: 0,
    sign: 0,
  };
  const reconciler = createHeartbeatOperationReconciler({
    currentIdentity: identity(operation),
    validateOperationIdentity: async () =>
      overrides.identityValid
        ? overrides.identityValid()
        : true,
    getSignatureStatuses: async (signatures, config) => {
      calls.status += 1;
      assert.deepEqual(signatures, [operation.signature]);
      assert.deepEqual(config, { searchTransactionHistory: true });
      return overrides.status
        ? overrides.status()
        : {
            value: [{
              err: null,
              confirmationStatus: 'confirmed',
            }],
          };
    },
    getBlockHeight: async () => {
      calls.blockHeight += 1;
      return overrides.blockHeight
        ? overrides.blockHeight()
        : 101;
    },
    verifyHeartbeatConfirmation: async () => {
      calls.verify += 1;
      return overrides.verify
        ? overrides.verify()
        : {
            status: 'verified',
            lastHeartbeat: 1_001,
            lastMethod: 0,
            totalHeartbeats: 9_007_199_254_740_994n,
          };
    },
    readCurrentHeartbeat: async () => {
      calls.current += 1;
      return overrides.current
        ? overrides.current()
        : {
            status: 'verified_state',
            lastHeartbeat: 1_000,
            lastMethod: 0,
            totalHeartbeats: 9_007_199_254_740_993n,
          };
    },
    recordConfirmedHeartbeat: async () => {
      calls.persist += 1;
      await overrides.persist?.();
    },
    recordAuthoritativeUnattributedHeartbeat: async () => {
      calls.authoritative += 1;
      await overrides.authoritative?.();
    },
    resetLocalEscalation: () => {
      calls.reset += 1;
    },
    reloadVaultState: async () => {
      calls.reload += 1;
    },
    transitionOperation: async (_signature, state, patch) => {
      calls.transition += 1;
      operation = transitionHeartbeatOperation(
        operation,
        state,
        operation.updatedAt + 1,
        patch,
      );
      return operation;
    },
    nowSeconds: () => 50,
  });
  return {
    calls,
    get operation() {
      return operation;
    },
    setOperation(next: HeartbeatOperationRecord) {
      operation = next;
    },
    run: () => reconciler.reconcile(operation),
  };
}

test('successful history status plus verified post-state resolves confirmed without a resend', async () => {
  const instance = harness();
  const result = await instance.run();
  assert.equal(result.status, 'reconciled_confirmed');
  assert.equal(instance.operation.state, 'resolved_confirmed');
  assert.equal(
    instance.operation.resolvedTotalHeartbeats,
    '9007199254740994',
  );
  assert.equal(instance.calls.persist, 1);
  assert.equal(instance.calls.reset, 1);
  assert.equal(instance.calls.send, 0);
  assert.equal(instance.calls.sign, 0);
});

test('confirmed chain result with local-cache failure stays repairable and repeated repair never resends', async () => {
  let fail = true;
  const inserted = new Set<string>();
  const instance = harness({
    persist: async () => {
      if (fail) throw new Error('disk');
      inserted.add(instance.operation.signature);
    },
  });
  const first = await instance.run();
  assert.equal(first.status, 'local_sync_pending');
  assert.equal(instance.operation.state, 'confirmed_local_sync_pending');
  fail = false;
  const second = await instance.run();
  assert.equal(second.status, 'reconciled_confirmed');
  assert.equal(inserted.size, 1);
  assert.equal(instance.calls.status, 1);
  assert.equal(instance.calls.send, 0);
});

test('failed signature status resolves failed with no local liveness mutation', async () => {
  const instance = harness({
    status: async () => ({
      value: [{
        err: { InstructionError: [0, 'Custom'] },
        confirmationStatus: 'confirmed',
      }],
    }),
  });
  assert.equal((await instance.run()).status, 'reconciled_failed');
  assert.equal(instance.operation.state, 'resolved_failed');
  assert.equal(instance.calls.persist, 0);
  assert.equal(instance.calls.reset, 0);
});

test('absent status before expiry remains pending and performs no state fetch', async () => {
  const instance = harness({
    status: async () => ({ value: [null] }),
    blockHeight: async () => 100,
  });
  assert.equal((await instance.run()).status, 'still_pending');
  assert.equal(instance.operation.state, 'prepared');
  assert.equal(instance.calls.current, 0);
});

test('absent status after expiry with unchanged chain state resolves expired-not-landed', async () => {
  const instance = harness({
    status: async () => ({ value: [null] }),
  });
  assert.equal((await instance.run()).status, 'reconciled_expired');
  assert.equal(instance.operation.state, 'resolved_expired_not_landed');
  assert.equal(instance.calls.reset, 0);
  assert.equal(instance.calls.persist, 0);
});

test('expired operation with advanced chain state is authoritative but unattributed', async () => {
  const instance = harness({
    status: async () => ({ value: [null] }),
    current: async () => ({
      status: 'verified_state',
      lastHeartbeat: 1_005,
      lastMethod: 1,
      totalHeartbeats: 9_007_199_254_740_999n,
    }),
  });
  const result = await instance.run();
  assert.equal(result.status, 'reconciled_chain_advanced');
  assert.equal(
    instance.operation.state,
    'resolved_chain_advanced_unattributed',
  );
  assert.equal(instance.calls.authoritative, 1);
  assert.equal(instance.calls.persist, 0);
  assert.equal(instance.calls.reset, 1);
});

test('status, block-height, and post-state RPC failures preserve an unresolved record', async (context) => {
  const scenarios = [
    harness({
      status: async () => {
        throw new Error('status');
      },
    }),
    harness({
      status: async () => ({ value: [null] }),
      blockHeight: async () => {
        throw new Error('height');
      },
    }),
    harness({
      status: async () => ({ value: [null] }),
      current: async () => ({ status: 'rpc_unavailable' }),
    }),
  ];
  for (const [index, instance] of scenarios.entries()) {
    await context.test(String(index), async () => {
      const result = await instance.run();
      assert.equal(
        result.status === 'reconciliation_unavailable' ||
          result.status === 'post_state_unverified',
        true,
      );
      assert.notEqual(
        instance.operation.state.startsWith('resolved_'),
        true,
      );
      assert.equal(instance.calls.send, 0);
    });
  }
});

test('method mismatch, timestamp regression, and invalid account remain post-state-unverified', async (context) => {
  const verifications = [
    { status: 'not_advanced' as const },
    {
      status: 'invalid_on_chain_state' as const,
      reason: 'timestamp regressed',
    },
    {
      status: 'invalid_on_chain_state' as const,
      reason: 'wrong vault/PDA',
    },
  ];
  for (const verification of verifications) {
    await context.test(verification.status, async () => {
      const instance = harness({
        verify: async () => verification,
      });
      assert.equal((await instance.run()).status, 'post_state_unverified');
      assert.equal(instance.operation.state, 'post_state_unverified');
      assert.equal(instance.calls.persist, 0);
    });
  }
});

test('malformed status and mismatched identity fail safely before chain-state use', async (context) => {
  await context.test('malformed status', async () => {
    const instance = harness({
      status: async () => ({ value: [] }),
    });
    assert.equal(
      (await instance.run()).status,
      'reconciliation_unavailable',
    );
    assert.equal(instance.calls.verify, 0);
  });
  await context.test('identity mismatch', async () => {
    const instance = harness({
      identityValid: async () => false,
    });
    assert.equal((await instance.run()).status, 'invalid_local_record');
    assert.equal(instance.calls.status, 0);
    assert.equal(instance.operation.state, 'invalid_local_record');
  });
});

test('crash boundaries after possible submission converge read-only without another send', async (context) => {
  const startingStates: Array<{
    name: string;
    state: HeartbeatOperationRecord['state'];
  }> = [
    {
      name: 'after send invocation before response',
      state: 'prepared',
    },
    {
      name: 'after matching response before submitted transition',
      state: 'prepared',
    },
    {
      name: 'after confirmation before post-state verification',
      state: 'submitted',
    },
    {
      name: 'after post-state verification before history insertion',
      state: 'submitted',
    },
    {
      name: 'after history insertion before resolved transition',
      state: 'post_state_unverified',
    },
  ];
  for (const boundary of startingStates) {
    await context.test(boundary.name, async () => {
      const instance = harness();
      if (boundary.state !== 'prepared') {
        instance.setOperation(
          transitionHeartbeatOperation(
            instance.operation,
            boundary.state,
            11,
          ),
        );
      }
      const result = await instance.run();
      assert.equal(result.status, 'reconciled_confirmed');
      assert.equal(instance.calls.send, 0);
      assert.equal(instance.calls.sign, 0);
    });
  }
});

test('crash after PREPARED but before send remains pending until expiry and never sends', async () => {
  const instance = harness({
    status: async () => ({ value: [null] }),
    blockHeight: async () => 100,
  });
  const result = await instance.run();
  assert.equal(result.status, 'still_pending');
  assert.equal(instance.operation.state, 'prepared');
  assert.equal(instance.calls.send, 0);
});

test('crash after terminal journal transition self-heals from idempotent local history without reconciliation', () => {
  const terminal = transitionHeartbeatOperation(
    makeOperation(),
    'resolved_confirmed',
    12,
    {
      resolvedLastHeartbeat: 1_001,
      resolvedTotalHeartbeats: '9007199254740994',
      localSyncState: 'complete',
    },
  );
  assert.equal(terminal.state, 'resolved_confirmed');
  assert.equal(
    terminal.resolvedLastHeartbeat,
    1_001,
  );
});

test('reconciler source contains no build, signing, send, retry, wallet, or notification path', () => {
  const source = readFileSync(
    new URL('./HeartbeatOperationReconciler.ts', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(source, /sendRawTransaction|\.sign\(|Keypair|signTransaction/);
  assert.doesNotMatch(source, /wallet|rotate|notification|setInterval|setTimeout/);
  assert.doesNotMatch(source, /while\s*\(/);
  assert.match(source, /searchTransactionHistory: true/);
});
