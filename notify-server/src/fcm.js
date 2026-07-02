import { JWT } from 'google-auth-library';
import { config, loadServiceAccount } from './config.js';

const MESSAGING_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

let jwtClient = null;
let projectId = config.fcmProjectId;

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

/** True once the Firebase service-account file is present and parseable. */
export function fcmReady() {
  return getClient() !== null && !!projectId;
}

/**
 * Send an FCM v1 notification to a device token.
 * Returns { ok, status, error?, unregistered? }. `unregistered` signals the
 * token is dead and the caller should drop the registration.
 */
export async function sendPush(deviceToken, { title, body, channel }) {
  const client = getClient();
  if (!client) return { ok: false, error: 'fcm_not_configured' };

  const { token: accessToken } = await client.getAccessToken();
  const url = `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;

  const message = {
    message: {
      token: deviceToken,
      notification: { title, body },
      android: {
        priority: 'high',
        notification: {
          channel_id: channel || 'escalation',
          // wake the screen for time-critical escalation
          notification_priority: 'PRIORITY_MAX',
          default_vibrate_timings: true,
          default_sound: true,
        },
      },
    },
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(message),
  });

  if (res.ok) {
    let okBody = {};
    try { okBody = await res.json(); } catch {}
    // FCM returns { name: "projects/<id>/messages/<msgId>" } — accepted by FCM.
    console.log(`[fcm] ACCEPTED "${title}" ch=${channel} -> ${okBody.name || '(no name)'} token ${deviceToken.slice(0, 14)}…`);
    return { ok: true, status: res.status, name: okBody.name };
  }

  let errBody = {};
  try {
    errBody = await res.json();
  } catch {}
  console.log(`[fcm] REJECTED "${title}" ch=${channel} status=${res.status} body=${JSON.stringify(errBody).slice(0, 300)}`);
  // FCM returns UNREGISTERED / INVALID_ARGUMENT for dead/invalid tokens.
  const code = errBody?.error?.details?.[0]?.errorCode || errBody?.error?.status || '';
  const unregistered = code === 'UNREGISTERED' || res.status === 404;
  return { ok: false, status: res.status, error: code || `http_${res.status}`, unregistered };
}
