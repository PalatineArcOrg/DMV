// Phase 3 completion guards.
//
// 1. The legacy register secret was published in a release APK and has been rotated. Signed routes
//    must be entirely independent of it — a wrong/absent secret must change nothing about a signed
//    request, and a legacy request must be rejected BEFORE the secret is ever consulted.
// 2. The test suite must not leak temporary directories (the historical dmv-fcm-* / dmv-boot-test-*
//    leak). These assert the cleanup hooks exist and are wired to `after`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { makeRegistrationHandlers } from '../src/registrationRoutes.js';
import { AUTH_MODE } from '../src/config.js';
import { RESULT } from '../src/registrationStore.js';

function res() {
  const r = { _s: 0, _j: null, _h: {} };
  r.status = (s) => { r._s = s; return r; };
  r.json = (j) => { r._j = j; return r; };
  r.set = (k, v) => { r._h[k] = v; return r; };
  return r;
}

// Deps that record whether the legacy secret check was ever consulted, and whether any
// RPC/store work happened.
function probeDeps(mode, { secretOk }) {
  const seen = { secretChecked: false, rpc: false, store: false, nonce: false };
  return {
    seen,
    deps: {
      mode,
      expected: { cluster: 'devnet', programId: '11111111111111111111111111111111', audience: 'https://notify.palatinearc.com' },
      authorizeRegisterV2: async () => { seen.rpc = true; return { ok: false, code: RESULT.INVALID_REQUEST }; },
      authorizeDeregisterV2: async () => { seen.rpc = true; return { ok: false, code: RESULT.INVALID_REQUEST }; },
      verifyOwnership: async () => { seen.rpc = true; return { ok: true }; },
      getRegistration: () => null,
      applySignedRegistration: () => { seen.store = true; return { ok: true, code: RESULT.CREATED }; },
      applySignedDeregistration: () => { seen.store = true; return { ok: true, code: RESULT.REMOVED, removed: 1 }; },
      applyLegacyRegistration: () => { seen.store = true; return { ok: true, code: RESULT.CREATED }; },
      deleteLegacyRegistration: () => { seen.store = true; return { removed: 1 }; },
      deleteLegacyRegistrationsByOwner: () => { seen.store = true; return { removed: 1 }; },
      legacyOwnerVerify: async () => { seen.rpc = true; return { ok: true }; },
      legacySecretOk: () => { seen.secretChecked = true; return secretOk; },
      limiter: { checkIp: () => ({ ok: true }), checkFacets: () => ({ ok: true }) },
      clientIp: () => '127.0.0.1',
      now: () => 1_800_000_000,
      logger: { log: () => {} },
      tokFingerprint: () => 'tok#0000',
      sha256Hex: (s) => 'h' + String(s).length,
      isPubkey: (k) => typeof k === 'string' && k.length >= 32,
      transition: { get: () => ({ configuredMode: mode, effectiveMode: 'signed', legacyAccepting: false, legacyAcceptUntil: null, legacyWindowExpired: false, secondsUntilLegacyClose: 0 }), firstExpiryAt: () => null },
      metrics: null,
    },
  };
}

const legacyBody = {
  owner: '1'.repeat(43), vault: '2'.repeat(43),
  deviceToken: 'x'.repeat(40), stage1: 1, stage2: 2, stage3: 3,
};

for (const secretOk of [true, false]) {
  test(`signed mode: legacy register rejected before the secret is consulted (secretOk=${secretOk})`, async () => {
    const { seen, deps } = probeDeps(AUTH_MODE.SIGNED_REQUIRED, { secretOk });
    const { register } = makeRegistrationHandlers(deps);
    const r = res();
    await register({ body: { ...legacyBody }, get: () => undefined }, r);
    assert.equal(r._s, 409);
    assert.equal(r._j.code, 'signed_required');
    assert.equal(seen.secretChecked, false, 'the register secret must never be consulted');
    assert.equal(seen.rpc, false, 'no ownership RPC before rejection');
    assert.equal(seen.store, false, 'no store mutation before rejection');
  });

  test(`signed mode: legacy deregister rejected before the secret is consulted (secretOk=${secretOk})`, async () => {
    const { seen, deps } = probeDeps(AUTH_MODE.SIGNED_REQUIRED, { secretOk });
    const { deregister } = makeRegistrationHandlers(deps);
    const r = res();
    await deregister({ body: { vault: '2'.repeat(43) }, get: () => undefined }, r);
    assert.equal(r._s, 409);
    assert.equal(r._j.code, 'signed_required');
    assert.equal(seen.secretChecked, false, 'the register secret must never be consulted');
    assert.equal(seen.store, false, 'no owner-wide deletion or any store mutation');
  });
}

test('rotating the register secret cannot change any signed-request outcome', async () => {
  // NOTE: on a FAILED signed authorization the route does call legacySecretOk(req) — but only to
  // increment the `downgradeBlocked` metric ("a valid legacy secret did NOT rescue it"). It never
  // feeds the decision. The security property is therefore OUTCOME-independence, not
  // never-consulted: the same signed request must produce an identical result whatever the secret
  // is. That is what makes rotating the burned secret safe for signed clients.
  const signedBody = { version: 2, action: 'register', ...legacyBody, signature: 'sig', nonce: 'n', timestamp: 1, revision: 1 };
  const outcomes = [];
  for (const secretOk of [true, false]) {
    const { deps } = probeDeps(AUTH_MODE.SIGNED_REQUIRED, { secretOk });
    const { register } = makeRegistrationHandlers(deps);
    const r = res();
    await register({ body: { ...signedBody }, get: () => undefined }, r);
    outcomes.push(`${r._s}:${r._j && r._j.code}`);
  }
  assert.equal(outcomes[0], outcomes[1], `signed outcome differed with/without a valid secret: ${outcomes.join(' vs ')}`);
});

test('a SUCCESSFUL signed register never consults the legacy secret at all', async () => {
  // The outcome-independence test above exercises the failed-auth branch (the only place the route
  // reads the secret, purely for the downgradeBlocked metric). Cover the success branch too: there
  // the secret must never be read under any circumstances.
  for (const secretOk of [true, false]) {
    const { seen, deps } = probeDeps(AUTH_MODE.SIGNED_REQUIRED, { secretOk });
    deps.authorizeRegisterV2 = async () => ({
      ok: true,
      command: { owner: '1'.repeat(43), vault: '2'.repeat(43), revision: 5 },
    });
    const { register } = makeRegistrationHandlers(deps);
    const r = res();
    await register({ body: { version: 2, action: 'register', ...legacyBody, signature: 'sig', nonce: 'n', timestamp: 1, revision: 5 }, get: () => undefined }, r);
    assert.equal(r._s, 201, 'signed register accepted');
    assert.equal(seen.secretChecked, false, 'success path must never read the register secret');
  }
});

// ── temp-file hygiene ───────────────────────────────────────────────────────────────────────
test('serverBoot test cleans up its throwaway database', () => {
  const s = readFileSync(new URL('./serverBoot.test.js', import.meta.url), 'utf8');
  assert.ok(/import \{ test, after \}/.test(s), 'after() imported');
  assert.ok(/after\(async \(\) => \{/.test(s), 'after() hook present');
  assert.ok(/rm\(f, \{ force: true \}\)/.test(s), 'removes the exact files it created');
  assert.equal(/rm\(\s*tmpdir\(\)/.test(s), false, 'never sweeps the whole temp dir');
});

test('config test cleans up every service-account temp dir it creates', () => {
  const s = readFileSync(new URL('./config.test.js', import.meta.url), 'utf8');
  assert.ok(/import \{ test, after \}/.test(s), 'after() imported');
  assert.ok(/SA_TMP_DIRS/.test(s), 'created dirs are tracked');
  assert.ok(/after\(async \(\) => \{/.test(s), 'after() hook present');
  assert.ok(/SA_TMP_DIRS\.splice\(0\)\.map/.test(s), 'removes exactly the tracked dirs');
  assert.equal(/rm\(\s*tmpdir\(\)/.test(s), false, 'never sweeps the whole temp dir');
});
