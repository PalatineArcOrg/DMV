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
test('DELIBERATE-ONLY lock: the signed handler is referenced ONLY at its declaration + onPress (no auto-trigger)', () => {
  // Headline safety property: signing must fire only from an explicit tap. If a future edit
  // wires the handler into a useEffect/useFocusEffect/timer/listener, the reference count
  // changes and this test fails, forcing a conscious review.
  const screen = readFileSync(new URL('../screens/SettingsScreen.tsx', import.meta.url), 'utf8');
  const refs = screen.match(/handleEnableSignedNotifications/g) || [];
  assert.equal(refs.length, 2, 'handler referenced exactly twice: its declaration and one onPress');
  assert.match(screen, /const handleEnableSignedNotifications\s*=/);
  assert.match(screen, /onPress=\{handleEnableSignedNotifications\}/);
});
test('SettingsScreen treats an in_flight result as a no-op, not a "failed" flash (review LOW-2)', () => {
  const screen = readFileSync(new URL('../screens/SettingsScreen.tsx', import.meta.url), 'utf8');
  // A concurrent-attempt result must be handled on its own branch (module single-flight
  // guarantees one signature + one POST) rather than falling through to the generic
  // "Registration failed" mapping and re-enabling the button mid-flight.
  assert.match(screen, /result\.stage === 'in_flight'/);
});
