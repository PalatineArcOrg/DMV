// WP4 admin status-endpoint tests (§17): admin-secret gate, register-secret
// rejection, admin IP limit, correct aggregate + readiness, no sensitive data,
// expired-dual effective signed, no mutation. Gate + handler wired like express.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { makeAdminGate } from '../src/secretGate.js';
import { makeWriteRateLimiter } from '../src/writeRateLimiter.js';
import { makeTransitionController } from '../src/transitionState.js';
import { makeAuthMetrics } from '../src/authMetrics.js';
import { makeRegistrationAuthStatusHandler } from '../src/adminStatusRoute.js';
import { ensureSchema, migrationCounts, applyLegacyRegistration, applySignedRegistration } from '../src/registrationStore.js';

const ADMIN = 'admin-secret-9';
const REG = 'register-secret-9';
const CUT = 1780000000;

function res() {
  return { _s: null, _j: null, _h: {}, status(c) { this._s = c; return this; }, json(o) { this._j = o; return this; }, set(k, v) { this._h[k.toLowerCase()] = v; return this; } };
}
function req(headers = {}, ip = '9.9.9.9') {
  const h = {}; for (const [k, v] of Object.entries(headers)) h[k.toLowerCase()] = v;
  return { headers: h, ip, get: (n) => h[n.toLowerCase()] };
}
function harness({ mode = 'dual', until = CUT, now = CUT - 100 } = {}) {
  const db = new Database(':memory:'); ensureSchema(db);
  const metrics = makeAuthMetrics({ now: () => now });
  const transition = makeTransitionController({ mode, legacyAcceptUntil: until, now: () => now, onFirstExpiry: (ts) => metrics.legacyExpiryObserved(ts) });
  const limiter = makeWriteRateLimiter({ now: () => now * 1000 });
  const gate = makeAdminGate({ adminSecret: ADMIN, isDev: false, limiter, clientIp: (r) => r.ip, onAuthFailure: () => metrics.adminAuthFailure() });
  const handler = makeRegistrationAuthStatusHandler({ transition, migrationCounts: () => migrationCounts(db), metrics, now: () => now });
  // Run gate then handler (express-style).
  const call = async (r) => { const rs = res(); let nexted = false; await gate(r, rs, () => { nexted = true; }); if (nexted) handler(r, rs); return rs; };
  return { db, metrics, transition, call };
}

test('correct admin secret → 200', async () => {
  const h = harness();
  const r = await h.call(req({ 'x-dmv-admin-secret': ADMIN }));
  assert.equal(r._s, 200);
  assert.equal(r._j.configuredMode, 'dual');
});
test('wrong admin secret → 401 + adminAuthFailure counted', async () => {
  const h = harness();
  const r = await h.call(req({ 'x-dmv-admin-secret': 'nope' }));
  assert.equal(r._s, 401);
  assert.deepEqual(r._j, { error: 'unauthorized' });
  assert.equal(h.metrics.snapshot().security.adminAuthFailures, 1);
});
test('missing admin secret → 401', async () => {
  const r = await harness().call(req({}));
  assert.equal(r._s, 401);
});
test('register secret does not authenticate the status endpoint', async () => {
  const r = await harness().call(req({ 'x-dmv-secret': REG }));
  assert.equal(r._s, 401);
});
test('admin IP rate limit applies (independent 20/60s)', async () => {
  const h = harness();
  let last;
  for (let i = 0; i < 25; i++) last = await h.call(req({ 'x-dmv-admin-secret': ADMIN }));
  assert.equal(last._s, 429);
  assert.ok(last._h['retry-after']);
});
test('aggregate counts + readiness: legacy rows → not ready with fixed blocker', async () => {
  const h = harness();
  applyLegacyRegistration(h.db, { owner: 'o1', vault: 'v1', deviceToken: 't1', stage1: 1, stage2: 2, stage3: 3, now: 1 });
  const r = await h.call(req({ 'x-dmv-admin-secret': ADMIN }));
  assert.equal(r._j.registrations.legacy, 1);
  assert.equal(r._j.registrations.signedPercent, 0);
  assert.equal(r._j.transition.readyForSignedMode, false);
  assert.deepEqual(r._j.transition.blockers, ['legacy_registrations_remaining']);
});
test('readiness true when zero legacy + zero anomalous', async () => {
  const h = harness();
  applySignedRegistration(h.db, { owner: 'o1', vault: 'v1', deviceToken: 't1', deviceTokenHash: 'a'.repeat(64), stage1: 1, stage2: 2, stage3: 3, revision: 1, signedAt: 1, nonce: 'n1', nonceUsedAt: 1, authVersion: 2 });
  const r = await h.call(req({ 'x-dmv-admin-secret': ADMIN }));
  assert.equal(r._j.registrations.signedPercent, 100);
  assert.equal(r._j.transition.readyForSignedMode, true);
  assert.deepEqual(r._j.transition.blockers, []);
});
test('anomalous rows → not ready with anomalous blocker', async () => {
  const h = harness();
  h.db.prepare(`INSERT INTO registrations (vault, owner, device_token, stage1, stage2, stage3, last_stage, last_notified_at, created_at, updated_at, auth_version, registration_revision, migration_status) VALUES ('a','o','t',1,2,3,0,0,0,0,2,0,'legacy')`).run();
  const r = await h.call(req({ 'x-dmv-admin-secret': ADMIN }));
  assert.equal(r._j.registrations.anomalous, 1);
  assert.equal(r._j.transition.readyForSignedMode, false);
  assert.ok(r._j.transition.blockers.includes('anomalous_registration_metadata'));
});
test('expired dual window reports effective signed', async () => {
  const h = harness({ now: CUT + 10 });
  const r = await h.call(req({ 'x-dmv-admin-secret': ADMIN }));
  assert.equal(r._j.effectiveMode, 'signed');
  assert.equal(r._j.legacyAccepting, false);
  assert.equal(r._j.legacyWindowExpired, true);
});
test('response has no row/token/hash/sig/nonce/owner/vault/rpc/secret value', async () => {
  const h = harness();
  applyLegacyRegistration(h.db, { owner: 'OwnerPubkeyValue', vault: 'VaultPubkeyValue', deviceToken: 'DeviceTokenValue', stage1: 1, stage2: 2, stage3: 3, now: 1 });
  const r = await h.call(req({ 'x-dmv-admin-secret': ADMIN }));
  const json = JSON.stringify(r._j);
  for (const bad of ['OwnerPubkeyValue', 'VaultPubkeyValue', 'DeviceTokenValue', ADMIN, REG, 'http']) {
    assert.equal(json.includes(bad), false, `status response leaks ${bad}`);
  }
});
test('endpoint performs no mutation', async () => {
  const h = harness();
  applyLegacyRegistration(h.db, { owner: 'o1', vault: 'v1', deviceToken: 't1', stage1: 1, stage2: 2, stage3: 3, now: 1 });
  const before = h.db.prepare('SELECT COUNT(*) AS n FROM registrations').get().n;
  await h.call(req({ 'x-dmv-admin-secret': ADMIN }));
  await h.call(req({ 'x-dmv-admin-secret': ADMIN }));
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM registrations').get().n, before);
});
