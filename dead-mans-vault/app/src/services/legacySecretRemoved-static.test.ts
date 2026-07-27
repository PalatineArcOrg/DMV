// Phase 3 completion: static proof that the burned legacy registration secret and every unsigned
// registration write path are GONE from the app, and that the deliberate owner-signed flow is the
// only remaining way to mutate notify-server registration state.
//
// Background: the shared server secret was inlined into the published v1.13.20 APK bundle and is
// permanently burned. It has been rotated server-side. These tests exist so it cannot come back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = new URL('..', import.meta.url).pathname; // app/src

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(p)) out.push(p);
  }
  return out;
}
const FILES = walk(SRC);
const NON_TEST = FILES.filter((f) => !/\.test\.(ts|tsx)$/.test(f));
const read = (f: string) => readFileSync(f, 'utf8');

test('no app source references the burned notify secret env alias', () => {
  const hits = NON_TEST.filter((f) => /EXPO_PUBLIC_NOTIFY_SECRET/.test(read(f)));
  assert.deepEqual(hits, [], `burned secret alias referenced in: ${hits.join(', ')}`);
});

test('no app source exports or reads a NOTIFY_SECRET constant', () => {
  const hits = NON_TEST.filter((f) => /\bNOTIFY_SECRET\b/.test(read(f)));
  assert.deepEqual(hits, [], `NOTIFY_SECRET referenced in: ${hits.join(', ')}`);
});

test('no app source builds a legacy secret request header', () => {
  const hits = NON_TEST.filter((f) => /x-dmv-secret|x-dmv-admin-secret/.test(read(f)));
  assert.deepEqual(hits, [], `legacy secret header built in: ${hits.join(', ')}`);
});

test('PushRegistrationService exposes only the device token and performs no network I/O', () => {
  const svc = read(join(SRC, 'services/PushRegistrationService.ts'));
  assert.equal(/\bfetch\s*\(/.test(svc), false, 'must not perform any fetch');
  assert.equal(/static\s+async\s+register\s*\(/.test(svc), false, 'legacy register removed');
  assert.equal(/static\s+async\s+deregister\s*\(/.test(svc), false, 'legacy deregister removed');
  assert.equal(/registerSigned|deregisterSigned/.test(svc), false, 'dormant V1-signed variants removed');
  assert.equal(/headers\s*\(/.test(svc), false, 'secret header helper removed');
  assert.ok(/static\s+async\s+getDeviceToken\s*\(/.test(svc), 'getDeviceToken retained');
});

test('no app source issues an unsigned register/deregister request', () => {
  // Any /register or /deregister request boundary must be the deliberate signed flow. The only
  // permitted call sites are SettingsScreen's postRegister/postDeregister, which send a V2 body.
  const offenders: string[] = [];
  for (const f of NON_TEST) {
    const s = read(f);
    if (!/\/(register|deregister)\b/.test(s)) continue;
    if (!/fetch\s*\(/.test(s)) continue; // doc/comment mention only
    if (/SettingsScreen\.tsx$/.test(f)) continue; // the deliberate signed boundary
    offenders.push(f);
  }
  assert.deepEqual(offenders, [], `unsigned registration request boundary in: ${offenders.join(', ')}`);
});

test('the signed request boundary sends only a content-type header', () => {
  const screen = read(join(SRC, 'screens/SettingsScreen.tsx'));
  const headerBlocks = screen.match(/headers:\s*\{[^}]*\}/g) ?? [];
  assert.ok(headerBlocks.length > 0, 'expected at least one headers block');
  for (const h of headerBlocks) {
    assert.equal(/secret/i.test(h), false, `secret-bearing header found: ${h}`);
  }
});

test('no background/mount/focus/timer path performs registration', () => {
  // The signed entry points must never be referenced from an effect, timer or listener.
  const AUTO = /(useEffect|useFocusEffect|setInterval|setTimeout|addListener|addEventListener|AppState)/;
  const offenders: string[] = [];
  for (const f of NON_TEST) {
    const s = read(f);
    if (!/attemptSignedRegistration|attemptSignedDeregistration/.test(s)) continue;
    for (const line of s.split('\n')) {
      if (AUTO.test(line) && /attemptSigned(Registration|Deregistration)/.test(line)) offenders.push(`${f}: ${line.trim()}`);
    }
  }
  assert.deepEqual(offenders, [], `auto-triggered signing: ${offenders.join(' | ')}`);
});

test('the deliberate signed flows are all still present', () => {
  const svc = read(join(SRC, 'services/NotificationRegistrationService.ts'));
  assert.ok(/export async function attemptSignedRegistration/.test(svc), 'signed registration present');
  assert.ok(/export async function attemptSignedDeregistration/.test(svc), 'signed deregistration present');
  assert.ok(/registerMessageV2/.test(svc), 'V2 register envelope used');
  assert.ok(/deregisterMessageV2/.test(svc), 'V2 deregister envelope used');
  assert.ok(/revisionKey/.test(svc), 'revision watermark retained');
  assert.ok(/closedVaultKey|recordVaultClosure/.test(svc), 'WP6.1 post-close cleanup retained');
});

test('app version and release manifest agree on the new devnet version', () => {
  const app = JSON.parse(read(new URL('../../app.json', import.meta.url).pathname));
  const man = JSON.parse(read(new URL('../../../release.manifest.json', import.meta.url).pathname));
  assert.equal(app.expo.version, man.appVersion, 'app.json version matches manifest');
  assert.equal(app.expo.android.versionCode, man.versionCode, 'versionCode matches manifest');
  // Must differ from the published legacy build's identity.
  assert.notEqual(`${app.expo.version}/${app.expo.android.versionCode}`, '1.13.20/106');
});
