import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  Keypair,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import bs58 from 'bs58';
import {
  createPreparedAgentRotation,
  transitionAgentRotation,
  type AgentRotationOperationRecord,
} from '../db/agentRotationRepoCore.ts';
import {
  createAgentRotationCoordinator,
  type AgentRotationCoordinatorDependencies,
  type AgentRotationPreflight,
} from './AgentRotationCoordinator.ts';

function fixture() {
  const owner = Keypair.generate();
  const oldAgent = Keypair.generate();
  const candidate = Keypair.generate();
  const vault = Keypair.generate().publicKey;
  const heartbeat = Keypair.generate().publicKey;
  const programId = Keypair.generate().publicKey.toBase58();
  const preflight: AgentRotationPreflight = {
    identity: {
      cluster: 'devnet',
      programId,
      owner: owner.publicKey.toBase58(),
      vault: vault.toBase58(),
      heartbeat: heartbeat.toBase58(),
    },
    state: {
      owner: owner.publicKey,
      vault,
      heartbeat,
      agent: oldAgent.publicKey,
      active: true,
      executed: false,
      vaultUpdatedAt: 90,
      lastHeartbeat: 100,
      totalHeartbeats: 5n,
      heartbeatInterval: 100,
      gracePeriod: 200,
      configFingerprint: 'ab'.repeat(32),
      chainUnixTime: 110,
    },
    finalDeadline: 400,
  };
  const transaction = new Transaction({
    feePayer: candidate.publicKey,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
  }).add(
    new TransactionInstruction({
      programId: new PublicKeyFromString(programId),
      keys: [
        {
          pubkey: owner.publicKey,
          isSigner: true,
          isWritable: false,
        },
      ],
      data: candidate.publicKey.toBuffer(),
    }),
  );
  transaction.sign(candidate, owner);
  const signature = bs58.encode(transaction.signature!);
  return {
    owner,
    oldAgent,
    candidate,
    preflight,
    transaction,
    signature,
  };
}

import { PublicKey as PublicKeyFromString } from '@solana/web3.js';

function operationFor(
  data: ReturnType<typeof fixture>,
): AgentRotationOperationRecord {
  return createPreparedAgentRotation({
    ...data.preflight.identity,
    oldAgent: data.oldAgent.publicKey.toBase58(),
    candidateAgent: data.candidate.publicKey.toBase58(),
    signature: data.signature,
    blockhash: data.transaction.recentBlockhash!,
    lastValidBlockHeight: 500,
    beforeLastHeartbeat: 100,
    beforeTotalHeartbeats: '5',
    beforeVaultUpdatedAt: 90,
    beforeFinalDeadline: 400,
    beforeConfigFingerprint: 'ab'.repeat(32),
    createdAt: 1,
    updatedAt: 1,
  });
}

function harness(
  overrides: Partial<AgentRotationCoordinatorDependencies> = {},
) {
  const data = fixture();
  const events: Array<string> = [];
  let currentOperation = operationFor(data);
  const dependencies: AgentRotationCoordinatorDependencies = {
    checkPreflight: async () => {
      events.push('preflight');
      return { status: 'ready', value: data.preflight };
    },
    hasBlockingHeartbeatOperation: async () => {
      events.push('heartbeat-journal-check');
      return false;
    },
    reconcileCandidateFunding: async () => {
      events.push('funding-journal-check');
      return false;
    },
    getBlockingRotation: async () => {
      events.push('rotation-journal-check');
      return null;
    },
    reconcileRotation: async () => ({
      status: 'still_pending',
      signature: data.signature,
    }),
    resolveStoredAgent: async () => {
      events.push('resolve-active');
      return {
        status: 'active_match',
        keypair: data.oldAgent,
      };
    },
    hasRetainedPreviousKey: async () => {
      events.push('previous-key-check');
      return false;
    },
    generateCandidate: async () => {
      events.push('generate-candidate');
      return data.candidate.publicKey.toBase58();
    },
    loadCandidate: async () => {
      events.push('load-candidate');
      return data.candidate;
    },
    prepareTransaction: async () => {
      events.push('dual-sign');
      return {
        status: 'fully_signed',
        transaction: data.transaction,
        signature: data.signature,
        blockhashValidity: {
          blockhash: data.transaction.recentBlockhash!,
          lastValidBlockHeight: 500,
        },
        feeLamports: 5_000,
        candidateBalanceLamports: 5_000_000,
      };
    },
    persistPrepared: async () => {
      events.push('journal-prepared');
    },
    sendRawTransaction: async () => {
      events.push('send-once');
      return data.signature;
    },
    confirmTransaction: async () => {
      events.push('confirm');
      return { value: { err: null } };
    },
    transitionRotation: async (_signature, state, patch = {}) => {
      events.push(`transition:${state}`);
      currentOperation = transitionAgentRotation(
        currentOperation,
        state,
        currentOperation.updatedAt + 1,
        patch,
      );
      return currentOperation;
    },
    verifyPostState: async () => {
      events.push('verify-post-state');
      return {
        status: 'verified',
        agent: data.candidate.publicKey,
        vaultUpdatedAt: 101,
        lastHeartbeat: 101,
      };
    },
    promoteCandidate: async () => {
      events.push('promote');
    },
    provePromotedCandidate: async () => {
      events.push('offline-proof');
      return true;
    },
    refreshAuthoritativeDeadline: async () => {
      events.push('refresh-deadline');
    },
    ...overrides,
  };
  return {
    data,
    events,
    coordinator: createAgentRotationCoordinator(dependencies),
  };
}

test('successful rotation journals before one send and promotes only after verified post-state', async () => {
  const setup = harness();
  const result = await setup.coordinator.rotate(
    setup.data.owner.publicKey,
  );
  assert.equal(result.status, 'confirmed');
  assert.deepEqual(setup.events, [
    'heartbeat-journal-check',
    'funding-journal-check',
    'preflight',
    'rotation-journal-check',
    'resolve-active',
    'previous-key-check',
    'load-candidate',
    'dual-sign',
    'journal-prepared',
    'send-once',
    'transition:submitted',
    'confirm',
    'verify-post-state',
    'transition:rotation_confirmed',
    'promote',
    'offline-proof',
    'transition:candidate_promoted',
    'refresh-deadline',
  ]);
});

test('candidate creation verifies active authority and readback without send', async () => {
  const setup = harness();
  const result = await setup.coordinator.createCandidate(
    setup.data.owner.publicKey,
  );
  assert.equal(result.status, 'candidate_secured');
  assert.equal(setup.events.includes('send-once'), false);
  assert.deepEqual(setup.events.slice(-2), [
    'generate-candidate',
    'load-candidate',
  ]);
});

test('unresolved heartbeat blocks candidate creation and rotation before readiness', async () => {
  const setup = harness({
    hasBlockingHeartbeatOperation: async () => true,
  });
  assert.equal(
    (
      await setup.coordinator.rotate(
        setup.data.owner.publicKey,
      )
    ).status,
    'heartbeat_operation_pending',
  );
  assert.equal(setup.events.length, 0);
});

test('unresolved candidate funding is reconciled and blocks rotation before signing', async () => {
  let checks = 0;
  const setup = harness({
    reconcileCandidateFunding: async () => {
      checks += 1;
      return true;
    },
  });
  const result = await setup.coordinator.rotate(
    setup.data.owner.publicKey,
  );
  assert.equal(result.status, 'candidate_funding_pending');
  assert.equal(checks, 1);
  assert.equal(setup.events.includes('dual-sign'), false);
  assert.equal(setup.events.includes('send-once'), false);
});

test('unresolved rotation reconciles read-only and does not prepare or send', async () => {
  const data = fixture();
  const existing = operationFor(data);
  let reconciliations = 0;
  const setup = harness({
    getBlockingRotation: async () => existing,
    reconcileRotation: async () => {
      reconciliations += 1;
      return {
        status: 'still_pending',
        signature: existing.signature,
      };
    },
  });
  const result = await setup.coordinator.rotate(
    setup.data.owner.publicKey,
  );
  assert.equal(result.status, 'rotation_pending');
  assert.equal(reconciliations, 1);
  assert.equal(setup.events.includes('dual-sign'), false);
  assert.equal(setup.events.includes('send-once'), false);
});

test('journal failure prevents send and preserves both keys', async () => {
  const setup = harness({
    persistPrepared: async () => {
      setup.events.push('journal-failed');
      throw new Error('disk full');
    },
  });
  const result = await setup.coordinator.rotate(
    setup.data.owner.publicKey,
  );
  assert.equal(result.status, 'journal_failed');
  assert.equal(setup.events.includes('send-once'), false);
  assert.equal(setup.events.includes('promote'), false);
});

test('send exception after prepared persistence becomes submission_unknown without resend', async () => {
  let sends = 0;
  const setup = harness({
    sendRawTransaction: async () => {
      sends += 1;
      throw new Error('timeout');
    },
  });
  const result = await setup.coordinator.rotate(
    setup.data.owner.publicKey,
  );
  assert.equal(result.status, 'submission_unknown');
  assert.equal(sends, 1);
  assert.equal(setup.events.includes('promote'), false);
});

test('confirmed transaction error leaves old agent unpromoted', async () => {
  const setup = harness({
    confirmTransaction: async () => ({
      value: { err: { InstructionError: [0, 1] } },
    }),
  });
  const result = await setup.coordinator.rotate(
    setup.data.owner.publicKey,
  );
  assert.equal(result.status, 'transaction_failed');
  assert.equal(setup.events.includes('promote'), false);
});

test('confirmation exception preserves signature and never promotes', async () => {
  const setup = harness({
    confirmTransaction: async () => {
      throw new Error('lost response');
    },
  });
  const result = await setup.coordinator.rotate(
    setup.data.owner.publicKey,
  );
  assert.equal(result.status, 'confirmation_unknown');
  assert.equal('signature' in result, true);
  assert.equal(setup.events.includes('promote'), false);
});

test('post-state verification failure preserves both keys', async () => {
  const setup = harness({
    verifyPostState: async () => ({
      status: 'invalid_on_chain_state',
      reason: 'wrong candidate',
    }),
  });
  const result = await setup.coordinator.rotate(
    setup.data.owner.publicKey,
  );
  assert.equal(result.status, 'post_state_unverified');
  assert.equal(setup.events.includes('promote'), false);
});

test('promotion failure remains recoverable as rotation_confirmed', async () => {
  const setup = harness({
    promoteCandidate: async () => {
      throw new Error('secure store interruption');
    },
  });
  const result = await setup.coordinator.rotate(
    setup.data.owner.publicKey,
  );
  assert.equal(result.status, 'promotion_failed');
});

test('single-flight rejects a concurrent rotation and releases after failure', async () => {
  const data = fixture();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const setup = harness({
    checkPreflight: async () => {
      await pending;
      return { status: 'ready', value: data.preflight };
    },
  });
  const first = setup.coordinator.rotate(data.owner.publicKey);
  const second = await setup.coordinator.rotate(data.owner.publicKey);
  assert.equal(second.status, 'rotation_in_flight');
  release();
  await first;
  const third = await setup.coordinator.createCandidate(
    data.owner.publicKey,
  );
  assert.notEqual(third.status, 'rotation_in_flight');
});

test('candidate-not-funded stops before journal and send', async () => {
  const setup = harness({
    prepareTransaction: async () => ({
      status: 'candidate_not_funded',
      balanceLamports: 4,
      feeLamports: 5,
      shortfallLamports: 1,
    }),
  });
  const result = await setup.coordinator.rotate(
    setup.data.owner.publicKey,
  );
  assert.deepEqual(result, {
    status: 'candidate_not_funded',
    shortfallLamports: 1,
  });
  assert.equal(setup.events.includes('journal-prepared'), false);
  assert.equal(setup.events.includes('send-once'), false);
});

test('a retained previous key blocks another rotation before candidate loading', async () => {
  const setup = harness({
    hasRetainedPreviousKey: async () => true,
  });
  const result = await setup.coordinator.rotate(
    setup.data.owner.publicKey,
  );
  assert.equal(result.status, 'previous_key_cleanup_required');
  assert.equal(setup.events.includes('load-candidate'), false);
  assert.equal(setup.events.includes('dual-sign'), false);
  assert.equal(setup.events.includes('send-once'), false);
});
