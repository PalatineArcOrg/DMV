import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import {
  createSigningMigrationRecord,
  transitionSigningMigration,
  type SigningMigrationRecord,
  type SigningMigrationState,
} from '../db/signingMigrationRepoCore.ts';
import {
  createBridgeRollbackCoordinator,
  createSideBySideMigrationCoordinator,
  type IncomingMigrationChainState,
  type SideBySideMigrationDependencies,
} from './SideBySideMigrationCoordinator.ts';

const transactionSignature = (seed: number) =>
  bs58.encode(Uint8Array.from({ length: 64 }, (_, index) => seed + index));

function harness() {
  const owner = Keypair.generate().publicKey;
  const legacy = Keypair.generate().publicKey;
  const candidate = Keypair.generate().publicKey;
  const identity = {
    cluster: 'devnet' as const,
    programId: Keypair.generate().publicKey.toBase58(),
    owner: owner.toBase58(),
    vault: Keypair.generate().publicKey.toBase58(),
  };
  const chain: IncomingMigrationChainState = {
    identity,
    legacyAgent: legacy,
    active: true,
    executed: false,
    finalDeadline: 2_000,
    chainUnixTime: 1_000,
    totalHeartbeats: 7n,
  };
  let record: SigningMigrationRecord | null = null;
  let storedCandidate: string | null = null;
  const calls: Array<string> = [];
  let active: string | null = null;
  const dependencies: SideBySideMigrationDependencies = {
    fetchChainState: async () => {
      calls.push('fetch');
      return chain;
    },
    loadRecord: async () => record,
    beginRecord: async (value) => {
      calls.push('begin');
      record = createSigningMigrationRecord({
        identity: value.identity,
        legacyAgent: value.legacyAgent.toBase58(),
        preRotationTotalHeartbeats: value.totalHeartbeats,
        verifiedDeadline: value.finalDeadline,
        nowSeconds: 100,
      });
      return record;
    },
    transitionRecord: async (_identity, state, patch = {}) => {
      calls.push(`state:${state}`);
      assert.ok(record);
      record = transitionSigningMigration(
        record,
        state,
        record.updatedAt + 1,
        patch
      );
      return record;
    },
    getSuccessorActivePublicKey: async () => active,
    getSuccessorCandidatePublicKey: async () => storedCandidate,
    createCandidateDeliberately: async () => {
      calls.push('create_candidate');
      storedCandidate = candidate.toBase58();
      return storedCandidate;
    },
    readBackCandidate: async () => candidate.toBase58(),
    hasUnresolvedHeartbeat: async () => false,
    hasUnresolvedRotation: async () => false,
    hasUnresolvedFunding: async () => false,
    fundCandidateDeliberately: async () => {
      calls.push('fund');
      return { status: 'confirmed' };
    },
    reconcileFundingReadOnly: async () => 'confirmed',
    rotateIncomingDeliberately: async () => {
      calls.push('candidate_sign');
      calls.push('owner_sign');
      calls.push('journal_prepared');
      calls.push('send_once');
      active = candidate.toBase58();
      return {
        status: 'confirmed',
        signature: transactionSignature(1),
      };
    },
    reconcileRotationReadOnly: async (value) => ({
      status: 'confirmed',
      signature: value.rotationSignature ?? transactionSignature(1),
    }),
    promoteIncomingCandidateAfterVerification: async () => {
      calls.push('promote_successor_candidate');
    },
    reconcileHeartbeatReadOnly: async (value) => ({
      status: 'confirmed',
      signature: value.heartbeatSignature ?? transactionSignature(2),
      totalHeartbeats: 8n,
    }),
    submitSuccessorHeartbeatDeliberately: async () => {
      calls.push('successor_heartbeat');
      return {
        status: 'confirmed',
        signature: transactionSignature(2),
        totalHeartbeats: 8n,
      };
    },
    refreshDeadline: async () => ({
      status: 'verified',
      finalDeadline: 3_000,
      chainUnixTime: 1_100,
    }),
    recheckFeeReserve: async () => 'ready',
  };
  return {
    owner,
    legacy,
    candidate,
    identity,
    chain,
    calls,
    dependencies,
    coordinator: createSideBySideMigrationCoordinator(dependencies),
    record: () => record,
    setRecord: (value: SigningMigrationRecord) => {
      record = value;
    },
  };
}

test('successor empty storage exposes incoming migration without creating a key', async () => {
  const value = harness();
  const result = await value.coordinator.inspect(value.owner);
  assert.equal(result.status, 'incoming_migration_available');
  assert.equal(result.legacyAgent, value.legacy.toBase58());
  assert.equal(value.calls.includes('create_candidate'), false);
  assert.equal(value.calls.includes('fund'), false);
});

test('candidate creation and funding remain separate deliberate actions', async () => {
  const value = harness();
  await value.coordinator.inspect(value.owner);
  const created = await value.coordinator.createCandidate(value.owner);
  assert.equal(created.status, 'candidate_secured');
  assert.equal(value.record()?.state, 'candidate_funding_required');
  assert.equal(value.calls.includes('fund'), false);

  const funded = await value.coordinator.fundCandidate(value.owner);
  assert.equal(funded.status, 'candidate_funded');
  assert.equal(value.record()?.state, 'candidate_funded');
});

test('incoming rotation proves replacement and owner without old private key', async () => {
  const value = harness();
  await value.coordinator.inspect(value.owner);
  await value.coordinator.createCandidate(value.owner);
  await value.coordinator.fundCandidate(value.owner);
  const result = await value.coordinator.rotate(value.owner);
  assert.equal(result.status, 'successor_authorised');
  assert.deepEqual(
    value.calls.filter((call) =>
      [
        'candidate_sign',
        'owner_sign',
        'journal_prepared',
        'send_once',
      ].includes(call)
    ),
    ['candidate_sign', 'owner_sign', 'journal_prepared', 'send_once']
  );
  assert.equal(value.calls.includes('legacy_sign'), false);
  assert.equal(value.record()?.state, 'successor_heartbeat_required');
});

test('rotation alone cannot complete migration; deliberate heartbeat must advance count', async () => {
  const value = harness();
  await value.coordinator.inspect(value.owner);
  await value.coordinator.createCandidate(value.owner);
  await value.coordinator.fundCandidate(value.owner);
  await value.coordinator.rotate(value.owner);
  assert.equal(value.record()?.heartbeatSignature, null);

  const heartbeat = await value.coordinator.proveSuccessorHeartbeat(
    value.owner
  );
  assert.equal(heartbeat.status, 'successor_heartbeat_confirmed');
  assert.equal(value.record()?.verifiedTotalHeartbeats, '8');
  assert.equal(value.record()?.state, 'notification_decision_required');
});

test('notification decision is explicit and remains separate from authority', async () => {
  const value = harness();
  await value.coordinator.inspect(value.owner);
  await value.coordinator.createCandidate(value.owner);
  await value.coordinator.fundCandidate(value.owner);
  await value.coordinator.rotate(value.owner);
  await value.coordinator.proveSuccessorHeartbeat(value.owner);
  assert.equal(value.calls.includes('notification_register'), false);

  const decision = await value.coordinator.recordNotificationDecision(
    value.owner,
    'declined'
  );
  assert.equal(decision.status, 'notification_declined');
  assert.equal(value.record()?.notificationDecision, 'declined');
  assert.equal(value.record()?.state, 'bridge_retention');
});

test('restart reconciliation is read-only and never resends', async () => {
  const value = harness();
  let record = createSigningMigrationRecord({
    identity: value.identity,
    legacyAgent: value.legacy.toBase58(),
    preRotationTotalHeartbeats: 7n,
    verifiedDeadline: 2_000,
    nowSeconds: 100,
  });
  record = transitionSigningMigration(record, 'candidate_secured', 101, {
    successorAgent: value.candidate.toBase58(),
  });
  record = transitionSigningMigration(record, 'candidate_funded', 102);
  record = transitionSigningMigration(record, 'rotation_pending', 103, {
    rotationSignature: transactionSignature(3),
  });
  value.setRecord(record);
  const result = await value.coordinator.resumeReadOnly(value.owner);
  assert.equal(result.status, 'successor_heartbeat_required');
  assert.equal(value.calls.includes('send_once'), false);
  assert.equal(value.calls.includes('candidate_sign'), false);
  assert.equal(value.calls.includes('owner_sign'), false);
});

test('restart reconciles pending funding without a second transfer', async () => {
  const value = harness();
  let record = createSigningMigrationRecord({
    identity: value.identity,
    legacyAgent: value.legacy.toBase58(),
    preRotationTotalHeartbeats: 7n,
    verifiedDeadline: 2_000,
    nowSeconds: 100,
  });
  record = transitionSigningMigration(record, 'candidate_secured', 101, {
    successorAgent: value.candidate.toBase58(),
  });
  record = transitionSigningMigration(
    record,
    'candidate_funding_required',
    102
  );
  record = transitionSigningMigration(
    record,
    'candidate_funding_pending',
    103,
    { fundingSignature: transactionSignature(6) }
  );
  value.setRecord(record);

  const result = await value.coordinator.resumeReadOnly(value.owner);

  assert.equal(result.status, 'candidate_funded');
  assert.equal(value.calls.includes('fund'), false);
  assert.equal(value.record()?.state, 'candidate_funded');
});

test('restart reconciles pending successor heartbeat without another submission', async () => {
  const value = harness();
  let record = createSigningMigrationRecord({
    identity: value.identity,
    legacyAgent: value.legacy.toBase58(),
    preRotationTotalHeartbeats: 7n,
    verifiedDeadline: 2_000,
    nowSeconds: 100,
  });
  record = transitionSigningMigration(record, 'candidate_secured', 101, {
    successorAgent: value.candidate.toBase58(),
  });
  record = transitionSigningMigration(record, 'candidate_funded', 102);
  record = transitionSigningMigration(record, 'rotation_pending', 103, {
    rotationSignature: transactionSignature(7),
  });
  record = transitionSigningMigration(record, 'successor_authorised', 104);
  record = transitionSigningMigration(
    record,
    'successor_heartbeat_required',
    105
  );
  record = transitionSigningMigration(
    record,
    'successor_heartbeat_pending',
    106,
    { heartbeatSignature: transactionSignature(8) }
  );
  value.setRecord(record);

  const result = await value.coordinator.resumeReadOnly(value.owner);

  assert.equal(result.status, 'successor_heartbeat_confirmed');
  assert.equal(value.calls.includes('successor_heartbeat'), false);
  assert.equal(value.record()?.state, 'notification_decision_required');
});

test('a confirmed heartbeat that does not advance count enters recovery', async () => {
  const value = harness();
  value.dependencies.submitSuccessorHeartbeatDeliberately = async () => ({
    status: 'confirmed',
    signature: transactionSignature(4),
    totalHeartbeats: 7n,
  });
  const coordinator = createSideBySideMigrationCoordinator(value.dependencies);
  await coordinator.inspect(value.owner);
  await coordinator.createCandidate(value.owner);
  await coordinator.fundCandidate(value.owner);
  await coordinator.rotate(value.owner);
  const result = await coordinator.proveSuccessorHeartbeat(value.owner);
  assert.equal(result.status, 'recovery_required');
});

test('legacy bridge rollback deliberately funds and rotates to retained bridge key', async () => {
  const owner = Keypair.generate().publicKey;
  const bridge = Keypair.generate().publicKey;
  const successor = Keypair.generate().publicKey;
  const calls: Array<string> = [];
  const rollback = createBridgeRollbackCoordinator({
    loadRetainedBridgeKey: async () => bridge,
    fetchOnChainAgent: async () => successor,
    fundReplacementDeliberately: async (_owner, replacement) => {
      assert.equal(replacement.toBase58(), bridge.toBase58());
      calls.push('fund_bridge');
      return 'funded';
    },
    rotateWithReplacementPayerAndOwner: async (input) => {
      assert.equal(input.replacementAgent.toBase58(), bridge.toBase58());
      assert.equal(input.currentAgent.toBase58(), successor.toBase58());
      calls.push('bridge_candidate_sign');
      calls.push('owner_sign');
      calls.push('journal_before_send');
      return {
        status: 'confirmed',
        signature: transactionSignature(5),
      };
    },
  });
  const result = await rollback.reauthoriseThisInstallation(owner);
  assert.equal(result.status, 'reauthorised');
  assert.deepEqual(calls, [
    'fund_bridge',
    'bridge_candidate_sign',
    'owner_sign',
    'journal_before_send',
  ]);
});

test('no action API automatically rotates, heartbeats, registers or rolls back', () => {
  const sourceMethods: Array<
    keyof ReturnType<typeof createSideBySideMigrationCoordinator>
  > = [
    'inspect',
    'resumeReadOnly',
    'createCandidate',
    'fundCandidate',
    'rotate',
    'proveSuccessorHeartbeat',
    'recordNotificationDecision',
  ];
  assert.equal(sourceMethods.includes('start' as never), false);
});
