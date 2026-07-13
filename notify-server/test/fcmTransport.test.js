// FCM transport hardening (Blocker 3). The real FCM fetch() had no timeout (a hung send could outlive
// the poll cycle and complete later), and a 401/403 demoted readiness but kept the cached JWT client
// (so rotating the service-account file had no effect). These tests drive the REAL sendPush through
// its injection seam (getClient / resetFcm / fetch) to prove the abort + client-reset behavior.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendPush, resetFcm, fcmReady } from '../src/fcm.js';

const MSG = { title: 't', body: 'b', channel: 'escalation' };
const TOKEN = 'devicetokendevicetoken';
const fakeClient = { getAccessToken: async () => ({ token: 'tok' }) };

test('a hung FCM fetch is bounded by the timeout (aborts, does not hang forever)', async () => {
  // fetch never resolves but honours the abort signal → sendPush's AbortController fires after timeoutMs.
  const hungFetch = (_url, opts) => new Promise((_, reject) => {
    opts.signal.addEventListener('abort', () =>
      reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })));
  });
  const r = await sendPush(TOKEN, MSG, {
    timeoutMs: 30,
    deps: { projectId: 'test-project', getClient: () => fakeClient, resetFcm: () => {}, fetch: hungFetch },
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'fcm_send_failed', 'the aborted send is a transport failure, not a hang');
});

// Blocker (this round): if getClient() THROWS while loading/parsing credentials (bad/rotated service
// account), sendPush must demote + return a structured failure like the unavailable-client path, NOT
// reject (which the caller would treat as an unexpected throw).
test('a THROWING getClient (credential load/parse failure) demotes + returns a structured failure (does not reject)', async () => {
  let resetCalls = 0;
  const r = await sendPush(TOKEN, MSG, {
    deps: {
      projectId: 'test-project',
      getClient: () => { throw new Error('invalid service account JSON'); },
      resetFcm: () => { resetCalls += 1; },
      fetch: async () => { throw new Error('fetch must not be reached'); },
    },
  });
  assert.equal(r.ok, false, 'resolves unsuccessfully, does not reject');
  assert.equal(r.error, 'fcm_auth_failed');
  assert.equal(resetCalls, 1, 'a client-load failure drops the cached client so a fixed credential can recover');
  assert.equal(fcmReady(), false, 'FCM is demoted after a client-load failure');
});

// Blocker (this round): the external FCM/proxy rejection body is logged — it can echo URLs/credentials
// and must pass through the shared sanitizer before hitting the log.
test('a REJECTED response body is sanitized before logging (no secret/URL leak)', async () => {
  const logs = [];
  const orig = console.log;
  console.log = (...a) => { logs.push(a.join(' ')); };
  try {
    await sendPush(TOKEN, MSG, {
      deps: {
        projectId: 'test-project',
        getClient: () => fakeClient,
        resetFcm: () => {},
        fetch: async () => ({
          ok: false,
          status: 400,
          json: async () => ({ error: { status: 'INVALID_ARGUMENT' }, debug: 'see https://fcm.example/?api-key=LEAKEDKEY token=LEAKEDTOKEN' }),
        }),
      },
    });
  } finally {
    console.log = orig;
  }
  const rejectedLine = logs.find((l) => l.includes('[fcm] REJECTED'));
  assert.ok(rejectedLine, 'the rejection was logged');
  for (const s of ['LEAKEDKEY', 'LEAKEDTOKEN', 'fcm.example']) {
    assert.ok(!rejectedLine.includes(s), `rejection log leaked "${s}": ${rejectedLine}`);
  }
});

test('a 401 demotes AND resets the client so a rotated service account is re-read next send', async () => {
  let resetCalls = 0;
  const r = await sendPush(TOKEN, MSG, {
    deps: {
      projectId: 'test-project',
      getClient: () => fakeClient,
      resetFcm: () => { resetCalls += 1; },
      fetch: async () => ({ ok: false, status: 401, json: async () => ({ error: { status: 'UNAUTHENTICATED' } }) }),
    },
  });
  assert.equal(r.ok, false);
  assert.equal(r.status, 401);
  assert.equal(resetCalls, 1, '401 drops the cached client → credential rotation can recover');
});

test('a 403 resets the client; a 429 does NOT (throttle is not an auth failure)', async () => {
  let reset403 = 0, reset429 = 0;
  await sendPush(TOKEN, MSG, { deps: { projectId: 'test-project', getClient: () => fakeClient, resetFcm: () => { reset403 += 1; }, fetch: async () => ({ ok: false, status: 403, json: async () => ({}) }) } });
  await sendPush(TOKEN, MSG, { deps: { projectId: 'test-project', getClient: () => fakeClient, resetFcm: () => { reset429 += 1; }, fetch: async () => ({ ok: false, status: 429, json: async () => ({}) }) } });
  assert.equal(reset403, 1);
  assert.equal(reset429, 0);
});

test('a successful send does NOT reset the client', async () => {
  let resetCalls = 0;
  const r = await sendPush(TOKEN, MSG, {
    deps: {
      projectId: 'test-project',
      getClient: () => fakeClient,
      resetFcm: () => { resetCalls += 1; },
      fetch: async () => ({ ok: true, status: 200, json: async () => ({ name: 'projects/p/messages/1' }) }),
    },
  });
  assert.equal(r.ok, true);
  assert.equal(resetCalls, 0);
});

test('a never-settling getAccessToken() is bounded by the deadline (does not hang)', async () => {
  // The auth client hangs forever. getAccessToken takes no AbortSignal, so it's raced against the send
  // deadline; sendPush must still RESOLVE (unsuccessfully) rather than leave a promise pending forever.
  const hungAuthClient = { getAccessToken: () => new Promise(() => {}) };
  const r = await sendPush(TOKEN, MSG, {
    timeoutMs: 30,
    deps: {
      projectId: 'test-project',
      getClient: () => hungAuthClient,
      resetFcm: () => {},
      fetch: async () => { throw new Error('fetch must not run when auth never settles'); },
    },
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'fcm_auth_failed', 'a stuck auth client is bounded like an auth failure');
});

test('a never-settling response BODY is bounded by the deadline (does not hang)', async () => {
  // fetch resolves 200 OK, but reading the body (.json()) never settles unless the shared deadline
  // aborts it. Since the body read runs under the SAME signal (timer not cleared until it completes),
  // the abort fires and sendPush resolves unsuccessfully instead of hanging on a stalled body.
  const hungBodyFetch = (_url, opts) => Promise.resolve({
    ok: true,
    status: 200,
    json: () => new Promise((_, reject) => {
      const fail = () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
      if (opts.signal.aborted) return fail();
      opts.signal.addEventListener('abort', fail, { once: true });
    }),
  });
  const r = await sendPush(TOKEN, MSG, {
    timeoutMs: 30,
    deps: { projectId: 'test-project', getClient: () => fakeClient, resetFcm: () => {}, fetch: hungBodyFetch },
  });
  assert.equal(r.ok, false, 'a stalled response body must be aborted, not awaited forever');
  assert.equal(r.error, 'fcm_send_failed', 'a body cut off by the deadline is a transport failure');
});

test('resetFcm is idempotent (clears client + inferred projectId without throwing)', () => {
  assert.doesNotThrow(() => { resetFcm(); resetFcm(); });
});

// A missing projectId must fail closed as fcm_not_configured BEFORE any fetch — otherwise the send would
// build .../projects/undefined/messages:send → a 404 the caller treats as `unregistered` → DELETES the
// registration (silently losing a live device).
test('a missing projectId → fcm_not_configured, no fetch (avoids a 404→unregistered→delete)', async () => {
  let fetched = false;
  const r = await sendPush(TOKEN, MSG, {
    deps: { projectId: '', getClient: () => fakeClient, resetFcm: () => {}, fetch: async () => { fetched = true; return { ok: true, status: 200, json: async () => ({}) }; } },
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'fcm_not_configured');
  assert.equal(fetched, false, 'no fetch to a /projects/undefined/ URL');
});

// User/provider-controlled log fields (title / channel / FCM message name) are sanitized + CR/LF-collapsed
// so they can't inject a forged log line or leak a secret embedded in the title.
test('log fields are sanitized + CR/LF-collapsed (no log injection or secret leak)', async () => {
  const logs = [];
  const orig = console.log;
  console.log = (...a) => { logs.push(a.join(' ')); };
  try {
    await sendPush(TOKEN, { title: 'hi\nFORGED https://x/?api-key=SECRETKEY', body: 'b', channel: 'esc\r\nation' }, {
      deps: { projectId: 'p', getClient: () => fakeClient, resetFcm: () => {}, fetch: async () => ({ ok: true, status: 200, json: async () => ({ name: 'msg' }) }) },
    });
  } finally { console.log = orig; }
  const line = logs.find((l) => l.includes('[fcm] ACCEPTED'));
  assert.ok(line, 'ACCEPTED was logged');
  assert.ok(!line.includes('\n') && !line.includes('\r'), 'CR/LF collapsed → no forged log line');
  assert.ok(!line.includes('SECRETKEY'), 'a secret in the title is redacted by the shared sanitizer');
});

// Blocker: a NON-2xx response body cut off by the deadline must be a TRANSPORT failure — not derived
// into unregistered/status semantics from an incomplete response (a stalled 404 would otherwise be
// treated as a dead token and delete the completion registration — the outcome the completion fix
// prevents).
function hungBody(status) {
  return (_url, opts) => Promise.resolve({
    ok: false,
    status,
    json: () => new Promise((_, reject) => {
      const fail = () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
      if (opts.signal.aborted) return fail();
      opts.signal.addEventListener('abort', fail, { once: true });
    }),
  });
}

test('a stalled 404 body is a transport failure (fcm_send_failed), NOT unregistered', async () => {
  const r = await sendPush(TOKEN, MSG, {
    timeoutMs: 30,
    deps: { projectId: 'test-project', getClient: () => fakeClient, resetFcm: () => {}, fetch: hungBody(404) },
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'fcm_send_failed', 'a timed-out 404 body must not be classified from the incomplete response');
  assert.notEqual(r.unregistered, true, 'a transport timeout must NOT be reported as a dead token');
});

test('a stalled 400 body is a transport failure and DEMOTES fcm readiness (from a ready baseline)', async () => {
  // Establish a KNOWN-READY baseline via a successful send FIRST, so this proves a ready→demoted
  // TRANSITION on the stalled non-2xx-body branch — not a pre-existing false state (false-positive risk).
  await sendPush(TOKEN, MSG, {
    deps: { projectId: 'test-project', getClient: () => fakeClient, resetFcm: () => {}, fetch: async () => ({ ok: true, status: 200, json: async () => ({ name: 'projects/p/messages/1' }) }) },
  });
  assert.equal(fcmReady(), true, 'ready baseline established');

  const r = await sendPush(TOKEN, MSG, {
    timeoutMs: 30,
    deps: { projectId: 'test-project', getClient: () => fakeClient, resetFcm: () => {}, fetch: hungBody(400) },
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'fcm_send_failed');
  assert.equal(fcmReady(), false, 'ready → demoted on a send that reached its transport deadline');
});

test('a GENUINE (non-stalled) 404 still marks the token unregistered (regression: dead token deletes)', async () => {
  const r = await sendPush(TOKEN, MSG, {
    deps: { projectId: 'test-project', getClient: () => fakeClient, resetFcm: () => {}, fetch: async () => ({ ok: false, status: 404, json: async () => ({ error: { status: 'NOT_FOUND' } }) }) },
  });
  assert.equal(r.ok, false);
  assert.equal(r.status, 404);
  assert.equal(r.unregistered, true, 'a real 404 with a complete body is still a dead token');
});
