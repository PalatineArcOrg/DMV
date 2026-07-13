import { createHash } from 'node:crypto';
import { JWT } from 'google-auth-library';
import { config, loadServiceAccount } from './config.js';
import { reasonCode } from './readiness.js';
import { sanitize } from './fatalGuards.js';

const MESSAGING_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

// Short, NON-reversible fingerprint of a device token for log correlation. Logging a stable PREFIX of
// the raw token is a PII leak (it identifies a recipient device across log lines); a truncated sha256
// hex lets us correlate ACCEPTED/REJECTED lines for the same token without exposing the token itself.
/** Non-reversible, stable device-token fingerprint for logs (correlates without exposing a raw prefix
 *  that identifies a recipient device across log lines). Reused by every log path, incl. /register. */
export const tokFingerprint = (t) => `tok#${createHash('sha256').update(String(t)).digest('hex').slice(0, 8)}`;

// Log-safe rendering of a user/provider-controlled field (notification title, channel, FCM message name):
// run it through the shared secret sanitizer AND collapse CR/LF so it can't inject forged log lines,
// bounded so a huge value can't flood the log.
const logField = (v) => sanitize(String(v ?? '')).replace(/[\r\n\t]+/g, ' ').slice(0, 120);
const FCM_TIMEOUT_MS = 15_000; // bound the FCM v1 send so a hung request can't outlive the poll cycle

let jwtClient = null;
let projectId = config.fcmProjectId;

// Runtime FCM readiness (Phase 2). Reflects whether the push TRANSPORT is actually usable — a fresh
// access token is obtainable and sends aren't failing at the transport/auth layer — NOT merely that
// a service-account file parsed. Demoted on auth/provider failures; recovered on a successful
// token/send. A dead per-recipient token (UNREGISTERED/404) is NOT a transport failure.
//
// `providerRejected` records that the actual SEND endpoint recently rejected us (401/403/429/5xx, or
// a send that couldn't complete). While set, a token-acquisition probe ALONE must NOT restore
// readiness — a valid access token says nothing about a 403ing send endpoint. Only a real successful
// send (escalations produce these) clears it. This is the fix for "a later token probe restores
// readiness while sends keep failing." A pure probe failure/recovery (no send rejection) is a weaker
// signal that DOES recover on a later good token.
let fcmState = { ready: false, reason: 'startup', providerRejected: false };

// Single authoritative state: every fcmState change is mirrored SYNCHRONOUSLY into the /health
// readiness singleton via this observer (wired in server.js). So a real send that demotes fcm updates
// /health immediately — the two can no longer disagree between monitor ticks.
let observer = null;
export function setFcmObserver(fn) {
  observer = fn;
}
function setFcm(ready, reason, { providerRejected } = {}) {
  fcmState = {
    ready,
    reason,
    providerRejected: providerRejected === undefined ? fcmState.providerRejected : providerRejected,
  };
  if (observer) observer(ready, reason);
}

function getClient() {
  if (jwtClient) return jwtClient;
  const sa = loadServiceAccount();
  if (!sa) return null;
  if (!projectId) projectId = sa.project_id;
  jwtClient = new JWT({
    email: sa.client_email,
    key: sa.private_key,
    scopes: [MESSAGING_SCOPE],
  });
  return jwtClient;
}

/** Current runtime FCM readiness (no secrets). */
export function fcmReady() {
  return fcmState.ready;
}

/** Structured FCM status for /health and the readiness monitor (no secrets, no raw provider error). */
export function fcmStatus() {
  return { ...fcmState };
}

/** Drop the memoized client AND any INFERRED projectId so the next getClient()/probe fully re-reads the
 *  service account — enables FCM recovery (creds mounted/rotated) WITHOUT a process restart. Resets
 *  projectId to the explicit config value (or '' → re-infer from the reloaded SA); a stale inferred
 *  projectId would otherwise survive and keep addressing the OLD Firebase project. */
export function resetFcm() {
  jwtClient = null;
  projectId = config.fcmProjectId;
}

function withTimeout(promise, ms) {
  let t;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(t)),
    new Promise((_, reject) => {
      t = setTimeout(() => reject(new Error('timeout')), ms);
    }),
  ]);
}

function abortError() {
  return Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
}

// Race a non-abortable promise against the shared send deadline. client.getAccessToken() takes no
// AbortSignal, so a stuck auth client would otherwise leave the send pending forever; when the
// controller aborts first we reject with an AbortError (reasonCode → rpc_timeout) so sendPush returns
// by the deadline. Removes its listener on either outcome so a settled auth call can't leak it.
function raceAbort(promise, signal) {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}

function defaultGetAccessToken() {
  const client = getClient();
  if (!client || !projectId) throw new Error('fcm_not_configured');
  return client.getAccessToken();
}

/**
 * Probe the push transport: config present AND a fresh access token obtainable. Updates the runtime
 * state and returns it. On auth/provider failure, demotes + resets the client so a later creds fix
 * recovers WITHOUT a restart. `getAccessToken` is injectable for tests.
 */
export async function probeFcm(getAccessToken = defaultGetAccessToken) {
  try {
    const res = await withTimeout(getAccessToken(), 8000);
    const token = res?.token ?? res;
    if (!token) {
      resetFcm();
      setFcm(false, 'fcm_no_access_token'); // a token-acquisition failure; not itself a send rejection
      return fcmStatus();
    }
    // Token obtainable. If the SEND endpoint recently rejected us, a token alone is NOT proof the
    // transport works — stay demoted until a real send succeeds (fail-closed). Otherwise recover.
    if (fcmState.providerRejected) {
      setFcm(false, 'fcm_awaiting_send_recovery');
      return fcmStatus();
    }
    setFcm(true, 'ok');
    return fcmStatus();
  } catch (e) {
    resetFcm();
    setFcm(false, `fcm_${reasonCode(e)}`);
    return fcmStatus();
  }
}

// 401/403 = auth revoked, 429 = throttled, 5xx = provider down → transport-level failure (demote).
function isTransportFailure(status) {
  return status === 401 || status === 403 || status === 429 || status >= 500;
}

/**
 * Send an FCM v1 notification to a device token. Returns { ok, status, error?, unregistered? }.
 * Updates runtime readiness from the real outcome: a transport/auth failure demotes fcmReady (+
 * resets the client); a successful send restores it; a dead-token (UNREGISTERED/404) does neither.
 */
export async function sendPush(deviceToken, { title, body, channel }, { canSend, timeoutMs = FCM_TIMEOUT_MS, deps } = {}) {
  // Injection seam (test-only): getClient / resetFcm / fetch default to the module implementations.
  const getClientFn = deps?.getClient || getClient;
  const resetFcmFn = deps?.resetFcm || resetFcm;
  const doFetch = deps?.fetch || fetch;
  const effectiveProjectId = deps?.projectId ?? projectId;

  // getClientFn loads/parses credentials — if that THROWS (bad/rotated service-account, parse error),
  // demote FCM and return a structured failure exactly like the unavailable-client path, instead of
  // rejecting sendPush (which the caller would then have to treat as an unexpected throw).
  let client;
  try {
    client = getClientFn();
  } catch (e) {
    resetFcmFn();
    setFcm(false, `fcm_${reasonCode(e)}`, { providerRejected: true });
    return { ok: false, error: 'fcm_auth_failed' };
  }
  if (!client) {
    setFcm(false, 'fcm_not_configured', { providerRejected: true }); // a send could not complete
    return { ok: false, error: 'fcm_not_configured' };
  }
  // A missing projectId would build .../projects/undefined/messages:send → a 404 the caller treats as
  // `unregistered` and DELETES the registration. Fail closed as not-configured BEFORE token/fetch.
  if (!effectiveProjectId) {
    setFcm(false, 'fcm_not_configured', { providerRejected: true });
    return { ok: false, error: 'fcm_not_configured' };
  }

  // ONE overall deadline for the WHOLE send: token acquisition + fetch + response-body parse. The
  // poller's 45s timeout does NOT cancel the underlying operation (a stalled auth/fetch/body promise
  // could otherwise survive and resume during a later cycle), so the send owns a single AbortController
  // + timer created BEFORE getAccessToken. getAccessToken takes no signal → it's raced against the
  // abort; fetch takes the signal; and res.json() reads the body under the SAME signal, so the timer is
  // NOT cleared until the body has been consumed (a stalled body is aborted too). Cleared in one finally.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let accessToken;
    try {
      const t = await raceAbort(client.getAccessToken(), controller.signal);
      accessToken = t?.token ?? t;
    } catch (e) {
      // Includes the deadline abort — a never-settling auth client can no longer leave sendPush pending.
      resetFcmFn();
      setFcm(false, `fcm_${reasonCode(e)}`, { providerRejected: true });
      return { ok: false, error: 'fcm_auth_failed' };
    }
    if (!accessToken) {
      resetFcmFn();
      setFcm(false, 'fcm_no_access_token', { providerRejected: true });
      return { ok: false, error: 'fcm_no_access_token' };
    }

    // Live send guard: token acquisition above is an await, so re-check IMMEDIATELY before the FCM fetch.
    // The caller passes canSend = () => readiness.networkVerified, so a network flip DURING token
    // acquisition suppresses the actual push — we never deliver an alert derived from a stale-cluster
    // read. This is NOT a transport failure (don't demote fcm readiness).
    if (canSend && !canSend()) {
      return { ok: false, suppressed: true, error: 'send_suppressed' };
    }

    const url = `https://fcm.googleapis.com/v1/projects/${effectiveProjectId}/messages:send`;
    const message = {
      message: {
        token: deviceToken,
        notification: { title, body },
        android: {
          priority: 'high',
          notification: {
            channel_id: channel || 'escalation',
            notification_priority: 'PRIORITY_MAX',
            default_vibrate_timings: true,
            default_sound: true,
          },
        },
      },
    };

    let res;
    try {
      res = await doFetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(message),
        signal: controller.signal,
      });
    } catch (e) {
      // Includes AbortError on timeout — a hung send is bounded and treated as a transport failure.
      setFcm(false, `fcm_${reasonCode(e)}`, { providerRejected: true }); // provider unreachable/hung → demote
      return { ok: false, error: 'fcm_send_failed' };
    }

    if (res.ok) {
      let okBody = {};
      try {
        okBody = await res.json();
      } catch (e) {
        // A body read cut off by the deadline means the send never completed in time → treat as a
        // transport failure, NOT a success. A plain parse error (body present but malformed) still
        // counts as a successful send, just with an unknown message name — so only bail on abort.
        if (controller.signal.aborted) {
          setFcm(false, `fcm_${reasonCode(e)}`, { providerRejected: true });
          return { ok: false, error: 'fcm_send_failed' };
        }
      }
      setFcm(true, 'ok', { providerRejected: false }); // a real successful send restores readiness
      console.log(`[fcm] ACCEPTED "${logField(title)}" ch=${logField(channel)} -> ${logField(okBody.name || '(no name)')} ${tokFingerprint(deviceToken)}`);
      return { ok: true, status: res.status, name: okBody.name };
    }

    let errBody = {};
    try {
      errBody = await res.json();
    } catch (e) {
      // A non-2xx body read cut off by the deadline is a TRANSPORT timeout — do NOT proceed to derive
      // unregistered/status semantics from an incomplete response (e.g. a stalled 404 body would else be
      // treated as a dead token and delete the completion registration — the very outcome the round-5
      // completion fix prevents). Demote and return a transport failure so the caller RETAINS + retries.
      if (controller.signal.aborted) {
        setFcm(false, `fcm_${reasonCode(e)}`, { providerRejected: true });
        return { ok: false, error: 'fcm_send_failed' };
      }
    }
    // sanitize the external FCM/proxy payload before logging — it can echo URLs, credentials, or ids.
    console.log(`[fcm] REJECTED "${logField(title)}" ch=${logField(channel)} status=${res.status} ${tokFingerprint(deviceToken)} body=${sanitize(JSON.stringify(errBody)).slice(0, 300)}`);
    const code = errBody?.error?.details?.[0]?.errorCode || errBody?.error?.status || '';
    const unregistered = code === 'UNREGISTERED' || res.status === 404;
    // A dead/invalid TOKEN is a per-recipient issue, not a transport failure — do NOT demote fcmReady.
    // A 401/403/429/5xx IS a transport/auth problem → demote AND mark providerRejected so a mere token
    // probe can't restore readiness while the send endpoint keeps rejecting; only a later successful
    // send clears it.
    if (isTransportFailure(res.status)) {
      setFcm(false, `fcm_http_${res.status}`, { providerRejected: true });
      // 401/403 = auth revoked or credentials rotated → drop the cached client so the NEXT send re-reads
      // the (possibly newly-mounted) service account. 429/5xx are not auth issues → keep the client.
      if (res.status === 401 || res.status === 403) resetFcmFn();
    }
    return { ok: false, status: res.status, error: code || `http_${res.status}`, unregistered };
  } finally {
    clearTimeout(timer);
  }
}
