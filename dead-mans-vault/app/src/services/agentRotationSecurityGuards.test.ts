import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

test('rotation reconciler has no signing, transaction-building, sending or wallet dependency', () => {
  const reconciler = source('./AgentRotationReconciler.ts');
  assert.doesNotMatch(
    reconciler,
    /sendRawTransaction|partialSign|signTransaction|signWithOwner|buildRotation/,
  );
});

test('rotation is journalled before its only send call and has no resend loop', () => {
  const coordinator = source('./AgentRotationCoordinator.ts');
  const journal = coordinator.indexOf(
    'await dependencies.persistPrepared',
  );
  const send = coordinator.indexOf(
    'await dependencies.sendRawTransaction',
  );
  assert.ok(journal >= 0);
  assert.ok(send > journal);
  assert.equal(
    (coordinator.match(/dependencies\.sendRawTransaction/g) ?? [])
      .length,
    1,
  );
  assert.doesNotMatch(coordinator, /\bwhile\s*\(|\bfor\s*\(/);
});

test('candidate generation never invokes active-key destruction or overwrite', () => {
  const slots = source('../tee/AgentKeySlotManagerCore.ts');
  const coordinator = source('./AgentRotationCoordinator.ts');
  const candidateSection = slots.slice(
    slots.indexOf('generateCandidate:'),
    slots.indexOf('getPublicKey:'),
  );
  assert.doesNotMatch(candidateSection, /active|removeSlot/);
  assert.doesNotMatch(coordinator, /destroyKey|removeSlot/);
});

test('rotation journal and key custody never persist raw transactions or private material', () => {
  const journal = source('../db/agentRotationRepoCore.ts');
  const fundingJournal = source(
    '../db/agentCandidateFundingRepoCore.ts',
  );
  const repository = source('../db/agentRotationRepo.ts');
  for (const text of [journal, fundingJournal, repository]) {
    assert.doesNotMatch(
      text,
      /secret_key|private_key|signed_transaction|raw_transaction/,
    );
  }
});

test('candidate funding is journalled before one send and never auto-retried', () => {
  const funding = source('./AgentCandidateFundingService.ts');
  const journal = funding.indexOf(
    'await dependencies.persistPrepared',
  );
  const send = funding.indexOf(
    'await dependencies.sendRawTransaction',
  );
  assert.ok(journal >= 0 && send > journal);
  assert.equal(
    (funding.match(/dependencies\.sendRawTransaction/g) ?? [])
      .length,
    1,
  );
  assert.doesNotMatch(funding, /\bwhile\s*\(|\bfor\s*\(/);
});

test('ordinary heartbeat has no owner-wallet signature or top-up/rotation call', () => {
  const heartbeat = source('./HeartbeatCoordinator.ts');
  assert.doesNotMatch(
    heartbeat,
    /signWithOwnerWallet|AgentCandidateFunding|AgentRotation/,
  );
});

test('candidate funding never records heartbeat, resets escalation or rotates', () => {
  const funding = source('./AgentCandidateFundingService.ts');
  assert.doesNotMatch(
    funding,
    /recordHeartbeat|resetEscalation|rotateAgent|heartbeatOperation/,
  );
});

test('no automatic owner prompt, funding, rotation or heartbeat exists in lifecycle reconciliation', () => {
  const root = source('../navigation/RootNavigator.tsx');
  const migration = source('./MigrationService.ts');
  assert.doesNotMatch(root, /Rotate Now|Sign rotation/);
  assert.doesNotMatch(
    migration,
    /fundCandidate|createCandidate|\.rotate\(/,
  );
});

test('program and IDL remain outside app rotation implementation boundary', () => {
  const service = source('./DefaultAgentRotationService.ts');
  assert.doesNotMatch(service, /writeFile|deploy|upgrade|idl\\.json/);
});

test('notification registration and shared-secret paths are absent from rotation', () => {
  const files = [
    './AgentRotationCoordinator.ts',
    './AgentRotationReconciler.ts',
    './DefaultAgentRotationService.ts',
    './AgentCandidateFundingService.ts',
  ].map(source).join('\n');
  assert.doesNotMatch(
    files,
    /REGISTER_SECRET|EXPO_PUBLIC_NOTIFY_SECRET|x-dmv-secret|notification registration/i,
  );
});
