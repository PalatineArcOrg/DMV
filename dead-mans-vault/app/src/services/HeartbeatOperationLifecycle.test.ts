import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('Dashboard focus reconciliation is bounded and read-only', () => {
  const source = readFileSync(
    new URL('../screens/DashboardScreen.tsx', import.meta.url),
    'utf8',
  );
  const start = source.indexOf('const reconcileOnFocus');
  const end = source.indexOf('const displayedHeartbeatTx');
  const focusPath = source.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.match(focusPath, /getReconciliable/);
  assert.match(focusPath, /heartbeatOperationService\.reconcile/);
  assert.doesNotMatch(
    focusPath,
    /recordHeartbeatOnChain|sendRawTransaction|signTransaction|KeyManager/,
  );
  assert.doesNotMatch(
    focusPath,
    /sendConfirmedHeartbeatNotification|NotificationService|register/,
  );
  assert.doesNotMatch(focusPath, /setInterval|setTimeout|while\s*\(/);
});

test('operation service deduplicates reconciliation and validates canonical identity before RPC status use', () => {
  const source = readFileSync(
    new URL('./DefaultHeartbeatOperationService.ts', import.meta.url),
    'utf8',
  );
  assert.match(source, /reconciliationInFlight/);
  assert.match(
    source,
    /validateOperationIdentity[\s\S]*getVaultPDA[\s\S]*getHeartbeatPDA[\s\S]*parseVaultConfig/,
  );
  assert.match(source, /candidate\.cluster !== EXPECTED_CLUSTER/);
  assert.match(source, /candidate\.programId !== PROGRAM_ID/);
  assert.doesNotMatch(
    source,
    /KeyManager|sendRawTransaction|\.sign\(|rotateAgent|signTransaction/,
  );
});

test('journal and reconciliation paths contain no automatic resend or notification-secret regression', () => {
  const files = [
    './sendAndConfirmTransaction.ts',
    './HeartbeatOperationReconciler.ts',
    './DefaultHeartbeatOperationService.ts',
    './HeartbeatCoordinator.ts',
  ].map((file) =>
    readFileSync(new URL(file, import.meta.url), 'utf8'));
  const source = files.join('\n');

  assert.equal(
    (source.match(/dependencies\.sendRawTransaction\(/g) ?? []).length,
    1,
  );
  assert.doesNotMatch(source, /REGISTER_SECRET|EXPO_PUBLIC_NOTIFY_SECRET|x-dmv-secret/);
  assert.doesNotMatch(source, /setInterval|setTimeout|while\s*\(/);
  assert.doesNotMatch(
    source,
    /raw_transaction|signed_transaction|secret_key|private_key/,
  );
});
