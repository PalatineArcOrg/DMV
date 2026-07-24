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

// ── WP6 static invariants ─────────────────────────────────────────────────────
const lifecycle = readFileSync(new URL('./notificationLifecycle.ts', import.meta.url), 'utf8');
const heartbeat = readFileSync(new URL('../hooks/useHeartbeat.ts', import.meta.url), 'utf8');
const screenSrc = readFileSync(new URL('../screens/SettingsScreen.tsx', import.meta.url), 'utf8');

test('WP6: the lifecycle observer NEVER signs or issues a register/deregister request', () => {
  // A real server mutation would need fetch()+NOTIFY_URL or a sign call; those catch it.
  // (Call-form patterns so the module's own prose that names these APIs doesn't false-positive.)
  assert.equal(/signMessage\s*\(|attemptSigned\w*\s*\(|fetch\s*\(|NOTIFY_URL/.test(lifecycle), false);
});
test('WP6: the lifecycle module does not log via console.*', () => {
  assert.equal(/console\.(log|warn|error|debug|info)\s*\(/.test(lifecycle), false);
});
test('WP6: the deregistration coordinator preserves the revision watermark and carries no plaintext token', () => {
  const i = svc.indexOf('export async function attemptSignedDeregistration');
  assert.ok(i > 0, 'deregistration coordinator present');
  const deregFn = svc.slice(i);
  assert.equal(/revisionKey\s*\(/.test(deregFn), false, 'deregister must not write the revision watermark');
  assert.equal(/deleteSetting/.test(deregFn), false, 'deregister must not delete settings');
  assert.equal(/\bdeviceToken\b/.test(deregFn), false, 'deregister carries/stores no device token');
});
test('WP6: the automatic token-observer wiring cannot sign or mutate the server', () => {
  const i = screenSrc.indexOf('makeTokenObserver({');
  assert.ok(i > 0, 'observer wired in SettingsScreen');
  const j = screenSrc.indexOf('observer.start();', i);
  assert.ok(j > i, 'observer block bounded');
  const block = screenSrc.slice(i, j);
  assert.equal(/attemptSigned|signMessage|runDisable|handleEnable|handleDisable|fetch\s*\(/.test(block), false,
    'the observer config must not sign or trigger a server mutation');
});
test('WP6: server-mutation entrypoints are each referenced exactly twice (one import + one deliberate call site)', () => {
  assert.equal((screenSrc.match(/attemptSignedRegistration/g) || []).length, 2);
  assert.equal((screenSrc.match(/attemptSignedDeregistration/g) || []).length, 2);
  // The deregister core is invoked ONLY from the two confirmation onPress handlers.
  assert.equal((screenSrc.match(/void runDisable\(\)/g) || []).length, 2);
});
test('WP6: useHeartbeat never signs, registers, or deregisters (no auto-mutation on the heartbeat path)', () => {
  assert.equal(/signMessage\s*\(|attemptSigned\w*\s*\(|PushRegistrationService\.(register|deregister)\s*\(|['"`]\/register|['"`]\/deregister/.test(heartbeat), false);
});
test('WP6: the disable confirmation clarifies no funds move and that it works after vault close', () => {
  assert.match(screenSrc, /does not move funds/);
  assert.match(screenSrc, /after the vault is closed/);
});
test('WP6 (review MEDIUM-2): a local-cleanup-pending result sets the pending state via pure React state + session guard, not an enabled-capable re-derive', () => {
  // On result.localCleanupPending the handler must set state directly (holds even under a total
  // write failure) and arm the session guard — NOT unconditionally checkNow (which could
  // resurface "enabled" when nothing durable persisted).
  assert.match(screenSrc, /result\.ok && result\.localCleanupPending/);
  assert.match(screenSrc, /notifDeregPendingSessionRef\.current = true/);
});
test('WP6 (review MEDIUM-2): the observer onState suppresses enabled/update_required while a dereg is session-pending', () => {
  assert.match(screenSrc, /notifDeregPendingSessionRef\.current && \(s === 'enabled' \|\| s === 'update_required'\)/);
});

// ── WP6.1 static invariants ───────────────────────────────────────────────────
test('WP6.1: reconcileNotificationsAfterClose (revoke path) never signs or issues a server request', () => {
  const i = screenSrc.indexOf('const reconcileNotificationsAfterClose');
  assert.ok(i > 0, 'reconcile-after-close present');
  const j = screenSrc.indexOf('}, [publicKey, notifCluster, deriveVaultB58]);', i);
  assert.ok(j > i, 'block bounded');
  const block = screenSrc.slice(i, j);
  assert.equal(/signMessage\s*\(|attemptSigned\w*\s*\(|fetch\s*\(|runDisable\s*\(/.test(block), false, 'revoke reconciliation must not sign/deregister/fetch');
  assert.match(block, /recordVaultClosure\s*\(/); // it only records the closure locally + re-derives via the observer
});
test('WP6.1: recordVaultClosure is LOCAL-ONLY — no sign / server request / revision-watermark write / delete', () => {
  const i = svc.indexOf('export async function recordVaultClosure');
  assert.ok(i > 0, 'recordVaultClosure present');
  const fn = svc.slice(i, svc.indexOf('export async function attemptSignedDeregistration'));
  assert.equal(/signMessage\s*\(|fetch\s*\(|postDeregister|revisionKey\s*\(|deleteSetting/.test(fn), false);
});
test('WP6.1: ownership_failed is contextualized ONLY in the explicit post_close_cleanup path with proven closure', () => {
  assert.match(svc, /input\?\.context === 'post_close_cleanup'/);
  assert.match(svc, /code === 'ownership_failed' && closureProven/);
  const ci = svc.indexOf('let closureProven');
  const cj = svc.indexOf('const timestamp = deps.nowSec();', ci);
  const block = svc.slice(ci, cj);
  assert.match(block, /tomb\.owner === owner/);
  assert.match(block, /tomb\.vault === vault/);
  assert.match(block, /tomb\.revokeSig/); // requires a confirmed revoke signature in the tombstone
});
test('WP6.1: SettingsScreen exposes a deliberate post-close cleanup action for the closed-vault state', () => {
  assert.match(screenSrc, /handlePostCloseCleanup/);
  assert.match(screenSrc, /void runDisable\('post_close_cleanup'\)/);
  assert.match(screenSrc, /vault_closed_cleanup_pending/);
});
