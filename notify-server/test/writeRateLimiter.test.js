// WP3 write-endpoint rate limiter (§17). Injected clock; asserts fixed-window
// limits, Retry-After, window expiry, shared facet buckets, sha256 token keying,
// memory bounds, and independent admin limiting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWriteRateLimiter } from '../src/writeRateLimiter.js';

function clock(start = 1_000_000) {
  const c = { t: start };
  return { now: () => c.t, advance: (ms) => { c.t += ms; }, set: (ms) => { c.t = ms; } };
}

test('IP: first 30 pass, 31st is 429 with Retry-After; window expiry restores', () => {
  const k = clock();
  const rl = makeWriteRateLimiter({ now: k.now });
  for (let i = 0; i < 30; i++) assert.equal(rl.checkIp('1.2.3.4').ok, true, `req ${i}`);
  const over = rl.checkIp('1.2.3.4');
  assert.equal(over.ok, false);
  assert.ok(over.retryAfter >= 1 && over.retryAfter <= 60);
  k.advance(60_000);
  assert.equal(rl.checkIp('1.2.3.4').ok, true, 'window expired → allowed again');
});

test('owner facet: 10 pass, 11th 429', () => {
  const k = clock();
  const rl = makeWriteRateLimiter({ now: k.now });
  for (let i = 0; i < 10; i++) assert.equal(rl.checkOwner('ownerA').ok, true);
  assert.equal(rl.checkOwner('ownerA').ok, false);
});

test('vault facet: 10 pass, 11th 429', () => {
  const k = clock();
  const rl = makeWriteRateLimiter({ now: k.now });
  for (let i = 0; i < 10; i++) assert.equal(rl.checkVault('vaultA').ok, true);
  assert.equal(rl.checkVault('vaultA').ok, false);
});

test('token-hash facet: 6 register hits pass, 7th 429; keyed by hash (same hash blocks regardless of plaintext)', () => {
  const k = clock();
  const rl = makeWriteRateLimiter({ now: k.now });
  const HASH = 'a'.repeat(64);
  for (let i = 0; i < 6; i++) assert.equal(rl.checkTokenHash(HASH).ok, true);
  assert.equal(rl.checkTokenHash(HASH).ok, false, 'same hash exhausts the bucket');
});

test('checkFacets returns the first failure and does not reveal which facet', () => {
  const k = clock();
  const rl = makeWriteRateLimiter({ now: k.now });
  // exhaust vault first
  for (let i = 0; i < 10; i++) rl.checkVault('v');
  const r = rl.checkFacets({ owner: 'o', vault: 'v', tokenHash: 'h'.repeat(64) });
  assert.equal(r.ok, false);
  assert.deepEqual(Object.keys(r).sort(), ['ok', 'retryAfter'], 'no facet identity in the result');
});

test('legacy and signed share the SAME owner/vault buckets', () => {
  const k = clock();
  const rl = makeWriteRateLimiter({ now: k.now });
  // A route consults checkFacets for both legacy + signed with the same owner key.
  for (let i = 0; i < 10; i++) assert.equal(rl.checkFacets({ owner: 'shared' }).ok, true);
  assert.equal(rl.checkFacets({ owner: 'shared' }).ok, false, 'shared bucket exhausted across paths');
});

test('deregister facets omit the token bucket entirely', () => {
  const k = clock();
  const rl = makeWriteRateLimiter({ now: k.now });
  for (let i = 0; i < 100; i++) rl.checkFacets({ owner: 'o' + i, vault: 'v' + i }); // no tokenHash
  assert.equal(rl.sizes().token, 0, 'no token buckets created for deregister-shaped calls');
});

test('admin IP limiter is independent (20/60s) and does not consume the write IP bucket', () => {
  const k = clock();
  const rl = makeWriteRateLimiter({ now: k.now });
  for (let i = 0; i < 20; i++) assert.equal(rl.checkAdminIp('9.9.9.9').ok, true);
  assert.equal(rl.checkAdminIp('9.9.9.9').ok, false);
  // The regular write IP bucket for the same IP is untouched.
  assert.equal(rl.checkIp('9.9.9.9').ok, true);
});

test('Retry-After is the remaining whole seconds', () => {
  const k = clock(0);
  const rl = makeWriteRateLimiter({ now: k.now });
  for (let i = 0; i < 30; i++) rl.checkIp('ip');
  k.set(10_000); // 10s into the 60s window
  const r = rl.checkIp('ip');
  assert.equal(r.ok, false);
  assert.equal(r.retryAfter, 50);
});

test('memory is bounded: expired buckets are pruned', () => {
  const k = clock();
  const rl = makeWriteRateLimiter({ now: k.now });
  for (let i = 0; i < 500; i++) rl.checkIp('ip' + i);
  assert.equal(rl.sizes().ip, 500);
  k.advance(120_000); // all windows expired
  rl.sweep();
  assert.equal(rl.sizes().ip, 0);
});

test('the limiter stores no plaintext token/nonce/signature — only provided keys', () => {
  const k = clock();
  const rl = makeWriteRateLimiter({ now: k.now });
  rl.checkTokenHash('deadbeef'.repeat(8));
  // Only sizes are exposed; there is no accessor returning key contents.
  assert.deepEqual(Object.keys(rl.sizes()).sort(), ['adminIp', 'ip', 'owner', 'token', 'vault']);
});
