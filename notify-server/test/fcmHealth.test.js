// FCM ↔ /health integration (Blocker 4). The prior tests validated fcm.js in ISOLATION; the defect
// was that a real send outcome updated fcm.js's private state but NOT the /health readiness singleton
// (they could disagree between monitor ticks), and a token-only probe could restore readiness while
// the send endpoint kept returning 403. These tests wire the real fcm.js observer into a real
// ReadinessState and drive real send/probe outcomes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReadinessState } from '../src/readiness.js';
import { setFcmObserver, probeFcm, sendPush, resetFcm } from '../src/fcm.js';

// A send double: we can't import the private setFcm, but sendPush drives the SAME state transitions
// through its real logic. To exercise sendPush without real Firebase creds we stub global.fetch and
// the JWT client indirectly — but fcm.js's getClient() returns null with no service account, so we
// instead assert the observer wiring via probeFcm (token path) + a direct provider-rejection using a
// fetch stub is not reachable without a client. So this test focuses on the OBSERVER contract that
// makes /health authoritative, plus the provider-rejection recovery RULE via probeFcm sequencing.

test('every fcm state change is mirrored into the /health readiness singleton (observer wiring)', async () => {
  const readiness = new ReadinessState();
  setFcmObserver((ready, reason) => readiness.setFcm(ready, reason));
  try {
    // Token obtainable → ready true, mirrored to readiness + exposed reason in the snapshot.
    await probeFcm(() => Promise.resolve({ token: 'tok1' }));
    assert.equal(readiness.fcmReady, true);
    assert.equal(readiness.snapshot().fcm.ready, true);
    assert.equal(readiness.snapshot().fcm.reason, 'ok');

    // Token acquisition fails → readiness demoted synchronously (no waiting for a monitor tick).
    await probeFcm(() => Promise.reject(new Error('401 unauthorized')));
    assert.equal(readiness.fcmReady, false);
    assert.match(readiness.snapshot().fcm.reason, /fcm_/);

    // Recovers when the token is obtainable again (a pure probe failure, no send rejection).
    await probeFcm(() => Promise.resolve({ token: 'tok2' }));
    assert.equal(readiness.fcmReady, true);
  } finally {
    setFcmObserver(null);
    resetFcm();
  }
});

test('a provider send-rejection is NOT cleared by a token-only probe; only a successful send recovers', async () => {
  const readiness = new ReadinessState();
  setFcmObserver((ready, reason) => readiness.setFcm(ready, reason));
  const token = 'devicetokendevicetokendevicetoken';
  const message = { title: 't', body: 'b', channel: 'escalation' };
  try {
    // First drive readiness to a known-READY baseline (a successful token probe) so the demotion below
    // is a proven ready→demoted transition, not an assumption about the module's starting state.
    await probeFcm(() => Promise.resolve({ token: 'baselinetoken' }));
    assert.equal(readiness.fcmReady, true, 'baseline: fcm transport ready before the send rejection');

    // Demote via a send that CANNOT complete. INJECT getClient:() => null so this is deterministic and
    // NEVER touches real Firebase — a developer/CI with ambient credentials configured would otherwise
    // make getClient() return a real client and fire a real FCM request.
    const r = await sendPush(token, message, { deps: { projectId: 'test-project', getClient: () => null } });
    assert.equal(r.ok, false);
    assert.equal(readiness.fcmReady, false, 'a send that could not complete demotes /health fcmReady synchronously (ready→demoted)');

    // A token IS obtainable now — but a token alone must NOT override the recent provider rejection.
    const s = await probeFcm(() => Promise.resolve({ token: 'freshtoken' }));
    assert.equal(s.ready, false, 'token alone must not override a recent provider rejection');
    assert.equal(s.reason, 'fcm_awaiting_send_recovery');
    assert.equal(readiness.fcmReady, false, 'the false state is mirrored into /health');

    // ONLY a successful SEND recovers — inject a working client + a 200 transport (in-memory, no real FCM).
    const recovered = await sendPush(token, message, {
      deps: {
        projectId: 'test-project',
        getClient: () => ({ getAccessToken: async () => ({ token: 'access-token' }) }),
        resetFcm: () => {},
        fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
      },
    });
    assert.equal(recovered.ok, true, 'a successful send completes');
    assert.equal(readiness.fcmReady, true, 'a successful send clears the provider rejection and restores /health fcmReady');
  } finally {
    setFcmObserver(null);
    resetFcm();
  }
});
