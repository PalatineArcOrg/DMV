// Mirror of the app's EscalationService.calculateStage so server and client agree.

// Per-stage recurring push throttle (seconds). Matches the app's production cadence.
export const STAGE_RECUR_INTERVAL = { 1: 8 * 3600, 2: 4 * 3600, 3: 1 * 3600 };

/**
 * Compute the current escalation stage.
 * @param {number} lastHeartbeat unix ts of last heartbeat
 * @param {number} interval heartbeat interval (s)
 * @param {object} stages { stage1, stage2, stage3 } durations (s)
 * @param {number} now unix ts
 * @returns {{stage:number, secondsOverdue:number, secondsToExecution:number}}
 */
export function computeStage(lastHeartbeat, interval, stages, now) {
  const nextDue = lastHeartbeat + interval;
  const secondsOverdue = Math.max(0, now - nextDue);
  const { stage1, stage2, stage3 } = stages;
  const grace = stage1 + stage2 + stage3;

  let stage;
  if (secondsOverdue <= 0) stage = 0;
  else if (secondsOverdue < stage1) stage = 1;
  else if (secondsOverdue < stage1 + stage2) stage = 2;
  else if (secondsOverdue < grace) stage = 3;
  else stage = 4;

  return {
    stage,
    secondsOverdue,
    secondsToExecution: Math.max(0, grace - secondsOverdue),
  };
}

/** Notification copy per stage (title/body/channel) for the FCM payload. */
export function stageMessage(stage, ctx = {}) {
  switch (stage) {
    case 1:
      return {
        title: 'Heartbeat Due',
        body: 'Your vault heartbeat is overdue. Open Dead Man’s Vault to confirm and keep your vault active.',
        channel: 'heartbeat',
      };
    case 2:
      return {
        title: 'Heartbeat Overdue',
        body: 'Emergency escalation active. Open the app to confirm your heartbeat.',
        channel: 'escalation',
      };
    case 3:
      return {
        title: 'FINAL WARNING',
        body: `Estate plan executes soon${ctx.timeText ? ` (${ctx.timeText})` : ''}. Confirm your heartbeat NOW.`,
        channel: 'execution',
      };
    case 4:
      return {
        title: 'Estate Plan Due',
        body: 'Grace period elapsed. Open Dead Man’s Vault to begin distribution to your beneficiaries.',
        channel: 'execution',
      };
    default:
      return null;
  }
}

export function formatDuration(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${Math.max(1, Math.round(seconds))}s`;
}
