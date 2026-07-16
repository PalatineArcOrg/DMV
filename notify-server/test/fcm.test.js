// FCM runtime-readiness tests (Phase 2). fcmReady() must reflect a USABLE push transport (token
// acquisition), demote on auth/provider failure, and recover on success — via injected token
// acquisition (no live FCM). Proves unavailable → demoted → recovered.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeFcm, fcmReady, fcmStatus } from '../src/fcm.js';

test('FCM available → demoted (auth failure) → demoted (no token) → recovered', async () => {
  // available: a token is obtained
  let s = await probeFcm(() => Promise.resolve({ token: 'tok1' }));
  assert.equal(s.ready, true);
  assert.equal(fcmReady(), true);
  assert.equal(fcmStatus().ready, true);

  // provider/auth failure → demoted (client reset internally so a later fix can recover)
  s = await probeFcm(() => Promise.reject(new Error('401 unauthorized')));
  assert.equal(s.ready, false);
  assert.equal(fcmReady(), false);
  assert.match(s.reason, /fcm_/);

  // token endpoint returns no token → demoted
  s = await probeFcm(() => Promise.resolve({ token: '' }));
  assert.equal(s.ready, false);
  assert.equal(s.reason, 'fcm_no_access_token');

  // timeout → demoted (classified transient)
  s = await probeFcm(() => new Promise(() => {}));
  assert.equal(s.ready, false);

  // recovered on a successful token acquisition — WITHOUT a process restart
  s = await probeFcm(() => Promise.resolve({ token: 'tok2' }));
  assert.equal(s.ready, true);
  assert.equal(fcmReady(), true);
});

test('credential presence is not runtime readiness — a bare token string counts as usable', async () => {
  const s = await probeFcm(() => Promise.resolve('rawtoken')); // some clients return the token directly
  assert.equal(s.ready, true);
});
