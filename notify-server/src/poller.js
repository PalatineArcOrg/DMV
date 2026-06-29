import { config } from './config.js';
import {
  allRegistrations,
  updateNotifyState,
  deleteRegistration,
} from './db.js';
import { readVaultState } from './solana.js';
import {
  computeStage,
  stageMessage,
  STAGE_RECUR_INTERVAL,
  formatDuration,
} from './escalation.js';
import { sendPush, fcmReady } from './fcm.js';

let running = false;
let timer = null;

/**
 * Decide whether a push is due for one registration and, if so, send it and
 * persist the new notify state.
 *
 * Rules (mirroring the app):
 *  - stage increased  -> send (stage entry)
 *  - same stage 1..3  -> send if past the per-stage recurring throttle
 *  - stage 4          -> send once
 *  - stage 0 (reset)  -> clear notify state so future escalations re-fire
 */
async function processRegistration(reg, now) {
  const state = await readVaultState(reg.vault);

  // Vault gone (revoked / closed) -> drop the registration.
  if (!state.exists || !state.config) {
    deleteRegistration(reg.vault);
    return { vault: reg.vault, action: 'deregistered_missing' };
  }
  // Inactive / executed -> nothing more to escalate; drop it.
  if (!state.config.active || state.config.executed) {
    deleteRegistration(reg.vault);
    return { vault: reg.vault, action: 'deregistered_inactive' };
  }
  if (state.lastHeartbeat == null) {
    return { vault: reg.vault, action: 'no_heartbeat' };
  }

  const stages = { stage1: reg.stage1, stage2: reg.stage2, stage3: reg.stage3 };
  const { stage, secondsToExecution } = computeStage(
    state.lastHeartbeat,
    state.config.interval,
    stages,
    now,
  );

  // Back to normal — reset so the next escalation notifies from scratch.
  if (stage === 0) {
    if (reg.last_stage !== 0) updateNotifyState(reg.vault, 0, 0);
    return { vault: reg.vault, action: 'normal' };
  }

  const escalated = stage > reg.last_stage;
  const recurDue =
    stage === reg.last_stage &&
    stage >= 1 &&
    stage <= 3 &&
    now - reg.last_notified_at >= (STAGE_RECUR_INTERVAL[stage] || 3600);
  const stage4Once = stage === 4 && reg.last_stage !== 4;

  if (!escalated && !recurDue && !stage4Once) {
    return { vault: reg.vault, action: 'no_change', stage };
  }

  const msg = stageMessage(stage, { timeText: formatDuration(secondsToExecution) });
  if (!msg) return { vault: reg.vault, action: 'no_msg', stage };

  const result = await sendPush(reg.device_token, msg);
  if (result.unregistered) {
    deleteRegistration(reg.vault);
    return { vault: reg.vault, action: 'deregistered_unregistered', stage };
  }
  if (result.ok) {
    updateNotifyState(reg.vault, stage, now);
    return { vault: reg.vault, action: 'sent', stage };
  }
  return { vault: reg.vault, action: 'send_failed', stage, error: result.error };
}

export async function pollOnce() {
  const regs = allRegistrations();
  if (regs.length === 0) return { checked: 0, sent: 0 };
  const now = Math.floor(Date.now() / 1000);

  let sent = 0;
  for (const reg of regs) {
    try {
      const r = await processRegistration(reg, now);
      if (r.action === 'sent') sent++;
    } catch {
      // Per-vault failure is non-fatal; retry next tick.
    }
  }
  return { checked: regs.length, sent };
}

export function startPoller() {
  if (timer) return;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      if (fcmReady()) await pollOnce();
    } finally {
      running = false;
    }
  };
  timer = setInterval(tick, config.pollIntervalMs);
  tick();
}

export function stopPoller() {
  if (timer) clearInterval(timer);
  timer = null;
}
