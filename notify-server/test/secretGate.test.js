// WP3 secret gates (§16 admin routes, §E). Admin gate uses x-dmv-admin-secret ONLY;
// the legacy secret never authenticates admin, and the admin secret never
// authenticates registration (that is enforced in the route tests). Constant-time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { constantTimeEqual, makeLegacySecretCheck, makeAdminGate } from '../src/secretGate.js';
import { makeWriteRateLimiter } from '../src/writeRateLimiter.js';

function fakeReq(headers = {}) {
  const h = {};
  for (const [k, v] of Object.entries(headers)) h[k.toLowerCase()] = v;
  return { headers: h, ip: '1.1.1.1', get: (name) => h[name.toLowerCase()] };
}
function fakeRes() {
  return {
    _status: null, _json: null, _headers: {},
    status(c) { this._status = c; return this; },
    json(o) { this._json = o; return this; },
    set(k, v) { this._headers[k.toLowerCase()] = v; return this; },
  };
}

test('constantTimeEqual: equal true; different/length/type false', () => {
  assert.equal(constantTimeEqual('abc', 'abc'), true);
  assert.equal(constantTimeEqual('abc', 'abd'), false);
  assert.equal(constantTimeEqual('abc', 'abcd'), false);
  assert.equal(constantTimeEqual(undefined, 'abc'), false);
  assert.equal(constantTimeEqual('abc', undefined), false);
});

test('legacy secret check: correct → true, wrong/missing → false, no secret → false', () => {
  const check = makeLegacySecretCheck('legacy-sec');
  assert.equal(check(fakeReq({ 'x-dmv-secret': 'legacy-sec' })), true);
  assert.equal(check(fakeReq({ 'x-dmv-secret': 'nope' })), false);
  assert.equal(check(fakeReq({})), false);
  // admin header must NOT satisfy the legacy check
  assert.equal(check(fakeReq({ 'x-dmv-admin-secret': 'legacy-sec' })), false);
  assert.equal(makeLegacySecretCheck('')(fakeReq({ 'x-dmv-secret': '' })), false);
});

test('admin gate: correct admin secret → next()', () => {
  const gate = makeAdminGate({ adminSecret: 'adm', isDev: false });
  let called = false;
  gate(fakeReq({ 'x-dmv-admin-secret': 'adm' }), fakeRes(), () => { called = true; });
  assert.equal(called, true);
});

test('admin gate: wrong/missing admin secret → generic 401, no next()', () => {
  const gate = makeAdminGate({ adminSecret: 'adm', isDev: false });
  let called = false;
  const r1 = fakeRes();
  gate(fakeReq({ 'x-dmv-admin-secret': 'wrong' }), r1, () => { called = true; });
  assert.equal(r1._status, 401);
  assert.deepEqual(r1._json, { error: 'unauthorized' });
  const r2 = fakeRes();
  gate(fakeReq({}), r2, () => { called = true; });
  assert.equal(r2._status, 401);
  assert.equal(called, false);
});

test('admin gate: the LEGACY x-dmv-secret is NOT accepted', () => {
  const gate = makeAdminGate({ adminSecret: 'adm', isDev: false });
  let called = false;
  const res = fakeRes();
  gate(fakeReq({ 'x-dmv-secret': 'adm' }), res, () => { called = true; });
  assert.equal(res._status, 401);
  assert.equal(called, false);
});

test('admin gate: dev bypass ONLY when isDev && no admin secret', () => {
  let called = false;
  const devGate = makeAdminGate({ adminSecret: '', isDev: true });
  devGate(fakeReq({}), fakeRes(), () => { called = true; });
  assert.equal(called, true, 'dev + no secret → bypass');

  called = false;
  const prodGate = makeAdminGate({ adminSecret: '', isDev: false });
  const res = fakeRes();
  prodGate(fakeReq({}), res, () => { called = true; });
  assert.equal(called, false, 'prod + no secret → NOT bypassed');
  assert.equal(res._status, 401);
});

test('admin gate: per-IP admin attempts are rate limited (20/60s → 429)', () => {
  const c = { t: 0 };
  const limiter = makeWriteRateLimiter({ now: () => c.t });
  const gate = makeAdminGate({ adminSecret: 'adm', isDev: false, limiter, clientIp: (req) => req.ip });
  let nexts = 0;
  for (let i = 0; i < 20; i++) gate(fakeReq({ 'x-dmv-admin-secret': 'adm' }), fakeRes(), () => { nexts++; });
  assert.equal(nexts, 20);
  const res = fakeRes();
  gate(fakeReq({ 'x-dmv-admin-secret': 'adm' }), res, () => { nexts++; });
  assert.equal(res._status, 429);
  assert.ok(res._headers['retry-after']);
  assert.equal(nexts, 20, 'rate-limited attempt did not reach next()');
});
