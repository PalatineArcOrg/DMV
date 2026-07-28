// WP4 metrics-collector tests (§16): exact counters, timestamp-on-matching-event,
// fixed cardinality (unknown code → `other`, schema never grows), no-throw methods,
// and a sensitive-value-free snapshot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeAuthMetrics } from '../src/authMetrics.js';

function mk(t0 = 1000) {
  let t = t0;
  const now = () => t;
  const m = makeAuthMetrics({ now, startedAt: t0 });
  return { m, tick: (v) => { t = v; }, now };
}

test('signed create / update counters + timestamp', () => {
  const { m } = mk();
  m.registerAttempt('signed'); m.registerResult('signed', 'created');
  m.registerAttempt('signed'); m.registerResult('signed', 'updated');
  const s = m.snapshot();
  assert.equal(s.register.signedAttempts, 2);
  assert.equal(s.register.signedCreated, 1);
  assert.equal(s.register.signedUpdated, 1);
  assert.ok(s.timestamps.lastSignedRegisterAt != null);
});
test('signed replay / stale-revision / invalid-signature rejections + security side-counters', () => {
  const { m } = mk();
  m.registerResult('signed', 'nonce_reused');
  m.registerResult('signed', 'stale_revision');
  m.registerResult('signed', 'invalid_signature');
  const s = m.snapshot();
  assert.equal(s.register.signedRejected, 3);
  assert.equal(s.failureCodes.nonce_reused, 1);
  assert.equal(s.failureCodes.stale_revision, 1);
  assert.equal(s.failureCodes.invalid_signature, 1);
  assert.equal(s.security.nonceReused, 1);
  assert.equal(s.security.staleRevision, 1);
});
test('no-downgrade counter', () => {
  const { m } = mk();
  m.downgradeBlocked(); m.downgradeBlocked();
  assert.equal(m.snapshot().security.downgradeBlocked, 2);
});
test('legacy success + timestamp; legacy expiry counters; stickiness block', () => {
  const { m } = mk();
  m.registerResult('legacy', 'created');
  m.registerResult('legacy', 'legacy_window_expired');
  m.registerResult('legacy', 'signed_authorization_required');
  const s = m.snapshot();
  assert.equal(s.register.legacySucceeded, 1);
  assert.ok(s.timestamps.lastLegacyRegisterAt != null);
  assert.equal(s.register.legacyExpired, 1);
  assert.equal(s.register.legacyRejected, 2);
  assert.equal(s.register.stickinessBlocks, 1);
  assert.ok(s.timestamps.lastLegacyRejectionAt != null);
});
test('signed deregister removed=1 vs removed=0 idempotent', () => {
  const { m } = mk();
  m.deregisterResult('signed', 'removed', 1);
  m.deregisterResult('signed', 'removed', 0);
  const s = m.snapshot();
  assert.equal(s.deregister.signedRemoved, 1);
  assert.equal(s.deregister.signedIdempotent, 1);
  assert.ok(s.timestamps.lastSignedDeregisterAt != null);
});
test('rate-limited / dependency-unavailable / database-error', () => {
  const { m } = mk();
  m.rateLimited();
  m.registerResult('signed', 'dependency_unavailable');
  m.registerResult('signed', 'database_error');
  const s = m.snapshot();
  assert.equal(s.security.rateLimited, 1);
  assert.equal(s.security.dependencyUnavailable, 1);
  assert.equal(s.security.databaseError, 1);
});
test('unknown code increments `other`; failureCodes schema does not grow', () => {
  const { m } = mk();
  const before = Object.keys(m.snapshot().failureCodes).length;
  m.registerResult('legacy', 'totally_made_up_code');
  m.registerResult('signed', 'another_bogus');
  const s = m.snapshot();
  assert.equal(s.failureCodes.other, 2);
  assert.equal(Object.keys(s.failureCodes).length, before, 'no new keys');
  assert.equal(s.failureCodes.totally_made_up_code, undefined);
});
test('timestamps update only for the corresponding successful event', () => {
  const { m, tick } = mk(1000);
  m.registerResult('signed', 'created'); // sets lastSignedRegisterAt=1000
  tick(2000);
  m.registerResult('signed', 'nonce_reused'); // must NOT touch lastSignedRegisterAt
  assert.equal(m.snapshot().timestamps.lastSignedRegisterAt, 1000);
});
test('legacyExpiryObserved is idempotent (first timestamp wins)', () => {
  const { m } = mk();
  m.legacyExpiryObserved(5000);
  m.legacyExpiryObserved(6000);
  assert.equal(m.snapshot().timestamps.firstLegacyExpiryAt, 5000);
});
test('adminAuthFailure counter', () => {
  const { m } = mk();
  m.adminAuthFailure();
  assert.equal(m.snapshot().security.adminAuthFailures, 1);
});
test('collector methods never throw on bad input', () => {
  const { m } = mk();
  assert.doesNotThrow(() => {
    m.registerAttempt(undefined);
    m.registerResult(null, null);
    m.deregisterResult('signed', undefined, undefined);
    m.legacyExpiryObserved('nope');
    m.snapshot('bad');
  });
});
test('snapshot leaf values are numbers/null only (no owner/vault/token/hash/nonce/signature value can leak)', () => {
  const { m } = mk();
  m.registerResult('signed', 'created');
  m.registerResult('legacy', 'nonce_reused');
  const snap = m.snapshot();
  const walk = (v, path) => {
    if (v === null || typeof v === 'number') return;
    if (v && typeof v === 'object') { for (const [k, val] of Object.entries(v)) walk(val, `${path}.${k}`); return; }
    assert.fail(`non-numeric snapshot leaf at ${path}: ${typeof v}`);
  };
  walk(snap, 'snapshot');
  // The failureCodes keys are a FIXED allowlist (+ other) — no key derived from input.
  const allowed = new Set([
    'invalid_request', 'invalid_signature', 'stale_timestamp', 'context_mismatch', 'nonce_reused',
    'ownership_failed', 'signed_not_enabled', 'signed_required', 'legacy_window_expired',
    'signed_authorization_required', 'stale_revision', 'owner_conflict', 'rate_limited',
    'dependency_unavailable', 'database_error', 'other',
  ]);
  for (const k of Object.keys(snap.failureCodes)) assert.ok(allowed.has(k), `unexpected failureCode key ${k}`);
});
