import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import {
  createPreparedAgentRotation,
  transitionAgentRotation,
  type AgentRotationOperationRecord,
} from '../db/agentRotationRepoCore.ts';
import {
  createAgentRotationReconciler,
} from './AgentRotationReconciler.ts';
import type {
  AgentRotationVerificationResult,
} from './AgentRotationVerifier.ts';

function operation(): AgentRotationOperationRecord {
  return createPreparedAgentRotation({
    cluster: 'devnet',
    programId: Keypair.generate().publicKey.toBase58(),
    owner: Keypair.generate().publicKey.toBase58(),
    vault: Keypair.generate().publicKey.toBase58(),
    heartbeat: Keypair.generate().publicKey.toBase58(),
    oldAgent: Keypair.generate().publicKey.toBase58(),
    candidateAgent: Keypair.generate().publicKey.toBase58(),
    signature: bs58.encode(Buffer.alloc(64, 1)),
    blockhash: bs58.encode(Buffer.alloc(32, 2)),
    lastValidBlockHeight: 100,
    beforeLastHeartbeat: 10,
    beforeTotalHeartbeats: '7',
    beforeVaultUpdatedAt: 9,
    beforeFinalDeadline: 500,
    beforeConfigFingerprint: 'ab'.repeat(32),
    createdAt: 1,
    updatedAt: 1,
  });
}

function status(
  kind: 'absent' | 'pending' | 'failed' | 'confirmed',
) {
  if (kind === 'absent') return { value: [null] };
  return {
    value: [
      {
        err: kind === 'failed' ? { InstructionError: [0, 1] } : null,
        confirmationStatus:
          kind === 'confirmed' ? 'confirmed' : 'processed',
      },
    ],
  };
}

function harness(input: {
  signatureStatus?: ReturnType<typeof status>;
  verification?: AgentRotationVerificationResult;
  blockHeight?: number;
  promoteFails?: boolean;
} = {}) {
  let current = operation();
  const transitions: Array<string> = [];
  let promotions = 0;
  let proofs = 0;
  const reconciler = createAgentRotationReconciler({
    validateIdentity: async () => true,
    getSignatureStatuses: async () =>
      input.signatureStatus ?? status('pending'),
    getBlockHeight: async () => input.blockHeight ?? 50,
    verifyPostState: async () =>
      input.verification ?? { status: 'old_agent_still_authorised' },
    promoteCandidate: async () => {
      promotions += 1;
      if (input.promoteFails) throw new Error('promotion failure');
    },
    provePromotedCandidate: async () => {
      proofs += 1;
      return true;
    },
    transition: async (_signature, state, patch = {}) => {
      transitions.push(state);
      current = transitionAgentRotation(current, state, 2, patch);
      return current;
    },
    nowSeconds: () => 2,
  });
  return {
    operation: current,
    reconciler,
    transitions,
    promotionCount: () => promotions,
    proofCount: () => proofs,
  };
}

function verified(
  record: AgentRotationOperationRecord,
): AgentRotationVerificationResult {
  return {
    status: 'verified',
    agent: Keypair.generate().publicKey,
    vaultUpdatedAt: record.beforeVaultUpdatedAt + 1,
    lastHeartbeat: record.beforeLastHeartbeat + 1,
  };
}

test('confirmed signature plus verified candidate promotes idempotently', async () => {
  const first = operation();
  const setup = harness({
    signatureStatus: status('confirmed'),
    verification: verified(first),
  });

  const result = await setup.reconciler.reconcile(setup.operation);

  assert.equal(result.status, 'reconciled_promoted');
  assert.equal(setup.promotionCount(), 1);
  assert.equal(setup.proofCount(), 1);
  assert.deepEqual(setup.transitions, ['candidate_promoted']);
});

test('candidate authority with unavailable attribution promotes as rotated-unattributed', async () => {
  const first = operation();
  const setup = harness({
    signatureStatus: status('absent'),
    verification: verified(first),
    blockHeight: 101,
  });

  const result = await setup.reconciler.reconcile(setup.operation);

  assert.equal(result.status, 'reconciled_rotated_unattributed');
  assert.deepEqual(setup.transitions, [
    'resolved_rotated_unattributed',
  ]);
});

test('failed signature with old agent retains old and resolves failed', async () => {
  const setup = harness({
    signatureStatus: status('failed'),
  });
  const result = await setup.reconciler.reconcile(setup.operation);
  assert.equal(result.status, 'reconciled_failed');
  assert.equal(setup.promotionCount(), 0);
  assert.deepEqual(setup.transitions, ['resolved_failed']);
});

test('absent expired signature with old agent resolves not landed', async () => {
  const setup = harness({
    signatureStatus: status('absent'),
    blockHeight: 101,
  });
  const result = await setup.reconciler.reconcile(setup.operation);
  assert.equal(result.status, 'reconciled_not_landed');
  assert.deepEqual(setup.transitions, ['resolved_not_landed']);
});

test('absent unexpired and processed statuses remain pending without mutation', async () => {
  for (const signatureStatus of [
    status('absent'),
    status('pending'),
  ]) {
    const setup = harness({
      signatureStatus,
      blockHeight: 100,
    });
    const result = await setup.reconciler.reconcile(
      setup.operation,
    );
    assert.equal(result.status, 'still_pending');
    assert.deepEqual(setup.transitions, []);
  }
});

test('neither old nor candidate on-chain enters recovery_required and retains keys', async () => {
  const third = Keypair.generate().publicKey;
  const setup = harness({
    verification: {
      status: 'different_agent_authorised',
      agent: third,
    },
  });
  const result = await setup.reconciler.reconcile(setup.operation);
  assert.deepEqual(result, {
    status: 'recovery_required',
    onChainAgent: third.toBase58(),
  });
  assert.deepEqual(setup.transitions, ['recovery_required']);
});

test('RPC or invalid post-state preserves operation without promotion', async () => {
  for (const verification of [
    { status: 'rpc_unavailable' } as const,
    {
      status: 'invalid_on_chain_state',
      reason: 'bad PDA',
    } as const,
  ]) {
    const setup = harness({ verification });
    const result = await setup.reconciler.reconcile(
      setup.operation,
    );
    assert.equal(result.status, 'post_state_unverified');
    assert.equal(setup.promotionCount(), 0);
  }
});

test('promotion interruption leaves rotation_confirmed for restart repair', async () => {
  const first = operation();
  const setup = harness({
    signatureStatus: status('confirmed'),
    verification: verified(first),
    promoteFails: true,
  });
  const result = await setup.reconciler.reconcile(setup.operation);
  assert.equal(result.status, 'post_state_unverified');
  assert.deepEqual(setup.transitions, ['rotation_confirmed']);
});

test('identity mismatch becomes invalid local record before RPC use', async () => {
  let statusCalls = 0;
  let current = operation();
  const reconciler = createAgentRotationReconciler({
    validateIdentity: async () => false,
    getSignatureStatuses: async () => {
      statusCalls += 1;
      return status('confirmed');
    },
    getBlockHeight: async () => 0,
    verifyPostState: async () => ({
      status: 'old_agent_still_authorised',
    }),
    promoteCandidate: async () => {},
    provePromotedCandidate: async () => true,
    transition: async (_signature, state, patch = {}) => {
      current = transitionAgentRotation(current, state, 2, patch);
      return current;
    },
  });
  const result = await reconciler.reconcile(current);
  assert.equal(result.status, 'invalid_local_record');
  assert.equal(statusCalls, 0);
});
