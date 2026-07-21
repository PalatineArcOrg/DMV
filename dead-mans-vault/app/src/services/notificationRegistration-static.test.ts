// WP5: static security checks on the coordinator (no logging, no shared-secret
// header, program-constant parity with the app's configured DMV program).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const svc = readFileSync(new URL('./NotificationRegistrationService.ts', import.meta.url), 'utf8');

test('coordinator does not log via console.*', () => {
  assert.equal(/console\.(log|warn|error|debug|info)\s*\(/.test(svc), false);
});
test('coordinator sends no shared-secret / admin-secret / legacy-secret header', () => {
  assert.equal(/x-dmv-secret|x-dmv-admin-secret|EXPO_PUBLIC_NOTIFY_SECRET/.test(svc), false);
});
test('coordinator EXPECTED_PROGRAM_ID matches constants.PROGRAM_ID', () => {
  const constants = readFileSync(new URL('../utils/constants.ts', import.meta.url), 'utf8');
  const m = constants.match(/PROGRAM_ID\s*=\s*'([^']+)'/);
  assert.ok(m, 'PROGRAM_ID present in constants.ts');
  assert.ok(svc.includes(m![1]), 'coordinator hardcoded program matches constants.PROGRAM_ID');
});
test('SettingsScreen wires the signed /register with NO shared-secret/admin/legacy header (review LOW)', () => {
  // The real request boundary is in SettingsScreen (postRegister), not the coordinator —
  // guard it too so a future edit can't reintroduce the legacy secret header.
  const screen = readFileSync(new URL('../screens/SettingsScreen.tsx', import.meta.url), 'utf8');
  assert.equal(/x-dmv-secret|x-dmv-admin-secret|EXPO_PUBLIC_NOTIFY_SECRET|PushRegistrationService\.headers/.test(screen), false);
});
