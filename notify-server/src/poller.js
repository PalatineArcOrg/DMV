import { config } from './config.js';
import {
  allRegistrations,
  updateNotifyState,
  deleteRegistration,
} from './db.js';
import { readVaultState, checkProgram } from './solana.js';
import {
  computeStage,
  stageMessage,
  STAGE_RECUR_INTERVAL,
  formatDuration,
} from './escalation.js';
import { sendPush } from './fcm.js';
import { runExecutor } from './executor.js';
import { readiness, shouldProbe, isPollCycleHealthy } from './readiness.js';
import { sanitize } from './fatalGuards.js';

let running = false;
let runningSince = 0;
let timer = null;

const VAULT_TIMEOUT_MS = 45_000; // per-vault budget so one hung vault can't wedge a tick
const POLL_CONCURRENCY = 4; // process registrations in parallel (was strictly sequential)
const MAX_TICK_MS = 5 * 60_000; // watchdog: allow a new tick if the flag is this stale

// Actions that mean "this registration's on-chain state was NOT successfully read this cycle" — a
// transient read throw, a per-vault timeout, an aborted-because-network-unverified, or a skipped
// delete because the program was globally unreadable; or an ACTIVE vault whose heartbeat could not be
// read/parsed (no_heartbeat → its deadline is uncomputable, i.e. a failed monitoring read). All count
// toward the cycle's read-failure ratio.
const READ_FAILURE_ACTIONS = new Set(['read_error', 'timeout', 'net_unverified', 'program_unready', 'no_heartbeat']);

// Injectable seam (Phase 2): the destructive / network-dependent effects processRegistration performs.
// Production uses the real modules; tests inject fakes to assert the wiring (never deletes on an
// unverified network or a globally-unreadable program; never sends alerts on an unverified network).
export const POLLER_DEPS = { readVaultState, deleteRegistration, updateNotifyState, sendPush, runExecutor, readiness, checkProgram };

/** Resolve `onTimeout()` if `promise` doesn't settle within `ms` (no cancellation
 * of the underlying work — it's idempotent and simply retried next tick). */
function withTimeout(promise, ms, onTimeout) {
  let t;
  const timeout = new Promise((resolve) => {
    t = setTimeout(() => resolve(onTimeout()), ms);
  });
  return Promise.race([
    Promise.resolve(promise).then(
      (v) => {
        clearTimeout(t);
        return v;
      },
      (e) => {
        clearTimeout(t);
        throw e;
      },
    ),
    timeout,
  ]);
}

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
export async function processRegistration(reg, now, deps = POLLER_DEPS, isLive = () => true) {
  const { readVaultState, deleteRegistration, updateNotifyState, sendPush, runExecutor, readiness, checkProgram } = deps;
  // Expiry guard (isLive): the worker bounds this call with withTimeout, but that only returns a
  // fallback — THIS function keeps running. Once the worker's timeout has fired (isLive → false), we
  // must perform NO further external effect (a late send / delete / update after the worker moved on
  // would duplicate a notification or mutate a registration out from under the next cycle). Checked at
  // every post-await point below, alongside the network TOCTOU re-check. The returned action is
  // discarded (the worker already recorded 'timeout'); only skipping the effect matters.

  // Live network guard: the tick gated on networkVerified at ENTRY, but the monitor can detect a
  // runtime MISMATCH/UNKNOWN mid-cycle. Re-check here (each registration is processed independently)
  // so we never delete a registration or send an alert derived from a read on a now-unverified
  // cluster. Fail-closed: abort this registration cleanly (counts as a read failure).
  if (!readiness.networkVerified) return { vault: reg.vault, action: 'net_unverified' };

  let state;
  try {
    state = await readVaultState(reg.vault);
  } catch {
    // Transient RPC read failure — surface it (drives pollerReady demotion) and retry next tick.
    return { vault: reg.vault, action: 'read_error' };
  }

  // TOCTOU guard: readVaultState() is async and the per-vault timeout wrapper does NOT cancel a slow
  // read that later resolves — so the monitor could flip the network to MISMATCH/UNKNOWN WHILE this
  // read was in flight. Re-check the LIVE network state AFTER the read and before ANY chain-derived
  // effect: never delete a registration, send an alert, or update state from a read that completed on
  // a now-unverified cluster. (Re-checked again below immediately before each post-sendPush effect.)
  if (!isLive()) return { vault: reg.vault, action: 'timeout' }; // worker already timed out this read → no late effects
  if (!readiness.networkVerified) return { vault: reg.vault, action: 'net_unverified' };

  // Vault gone (revoked / closed) -> drop the registration. BUT only when we can positively trust the
  // "gone" reading: during a global program-readiness failure (wrong/pruned RPC where NO account
  // resolves), every vault looks missing and a naive delete would wipe every registration. Guard the
  // destructive delete on programReady — if the program itself isn't currently readable, treat this as
  // a transient read failure and retry, never delete.
  if (!state.exists || !state.config) {
    // A "missing" read is DESTRUCTIVE, so confirm with a FRESH bounded program probe — not the cached
    // readiness.programReady, which a prior successful monitor tick can leave stale-true while the
    // current RPC has already become unable to serve the program (every vault would then look missing
    // and a naive delete would wipe every registration). Delete ONLY if the live probe positively
    // confirms the program (ok:true); anything else (not-found / UNKNOWN / transient) → retain + retry.
    const prog = checkProgram ? await checkProgram() : null;
    // checkProgram is another await — re-check expiry + network AFTER it so a worker timeout or a network
    // revocation WHILE the probe was pending can't authorise a delete from a now-stale ok:true.
    if (!isLive()) return { vault: reg.vault, action: 'timeout' };
    if (!readiness.networkVerified) return { vault: reg.vault, action: 'net_unverified' };
    if (!prog || prog.ok !== true) return { vault: reg.vault, action: 'program_unready' };
    deleteRegistration(reg.vault);
    return { vault: reg.vault, action: 'deregistered_missing' };
  }
  // Inactive / executed -> nothing more to escalate; drop it. If it EXECUTED and
  // we'd already escalated to stage 4 (owner saw "executing"), send one final
  // "complete" push first — otherwise autonomous distribution ends in silence
  // after the "executing" alert (the app can't send it; the app never ran).
  if (!state.config.active || state.config.executed) {
    // Executed + owner already saw "executing" (stage 4): send ONE final "complete" push BEFORE dropping
    // the registration. Crucially, handle the send RESULT before deleting — deleting regardless would let
    // a transient FCM outage PERMANENTLY suppress the completion notification (registration gone, nothing
    // left to retry). Skip entirely when notify is waived (fcmWaived): no push to send, so nothing to
    // retry — just deregister.
    if (state.config.executed && reg.last_stage === 4 && !readiness.fcmWaived) {
      const doneMsg = stageMessage('complete');
      if (doneMsg) {
        // isLive() in the canSend guard too: sendPush re-checks canSend AFTER token acquisition, right
        // before the FCM request — so if THIS work item's worker timeout fires DURING token acquisition,
        // the send is suppressed rather than delivered late (the post-await isLive checks below can't see
        // an in-flight send).
        const r = await sendPush(reg.device_token, doneMsg, { canSend: () => isLive() && readiness.networkVerified });
        // Order matters (see #3): handle SUPPRESSED first (the send did NOT happen — retain), then persist
        // any DEFINITIVE outcome regardless of a post-send network flip. If the network flips WHILE FCM is
        // processing, sendPush can still return ok:true — gating that on networkVerified here would discard
        // a confirmed delivery and re-send the completion next cycle (a duplicate).
        if (r.suppressed) return { vault: reg.vault, action: 'net_unverified' };
        // DEFINITIVE: delivered (r.ok) OR dead token (r.unregistered) → deregister to record it (a late
        // expiry / network flip must not leave it to re-send the completion).
        if (r.ok || r.unregistered) {
          if (r.ok) console.log(`[push] sent complete -> ${reg.vault.slice(0, 8)} (owner ${reg.owner.slice(0, 8)})`);
          deleteRegistration(reg.vault);
          return { vault: reg.vault, action: 'deregistered_inactive' };
        }
        // No definitive outcome — a transient / auth / provider failure → RETAIN + retry. Reported as
        // `send_failed` (stage:'complete') so the worker LOGS it (it only surfaces action==='send_failed');
        // NOT a READ_FAILURE_ACTIONS member (the read succeeded, only the SEND failed) → no pollerReady demotion.
        return { vault: reg.vault, action: 'send_failed', stage: 'complete', error: r.error };
      }
    }
    // Plain inactive / executed-not-stage-4 / waived (NO send happened) → the network gate applies here:
    // never delete a registration derived from a read on a now-unverified cluster.
    if (!readiness.networkVerified) return { vault: reg.vault, action: 'net_unverified' };
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

  // Grace elapsed (stage 4): drive the permissionless distribution autonomously.
  // Idempotent and best-effort — the next tick deregisters once executed.
  if (stage === 4 && readiness.executorReady) {
    try {
      // Pass a LIVE readiness guard: if a runtime MISMATCH/UNKNOWN clears executorReady mid-crank,
      // the executor aborts the remaining submissions cleanly (checked before every tx).
      // isLive() in the canSubmit guard too: the executor re-checks canSubmit before EVERY on-chain
      // submission — so if this work item's worker timeout fires mid-crank, the remaining submissions are
      // aborted rather than continuing after the worker moved on.
      const ex = await runExecutor(reg.vault, { canSubmit: () => isLive() && readiness.executorReady });
      if (ex.action === 'executed' || ex.action === 'cranked') {
        console.log(`[exec] ${ex.action} -> ${reg.vault.slice(0, 8)}`);
      }
    } catch (e) {
      console.log(`[exec] FAILED -> ${reg.vault.slice(0, 8)}: ${sanitize(e?.message ?? e)}`);
    }
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

  // Post-executor / pre-push guard: the stage-4 runExecutor above can take a while (its own guard may
  // abort it) — re-check the network BEFORE deriving+sending the alert so we never push an escalation
  // computed from a now-stale-cluster read. canSend re-checks AGAIN inside sendPush after the token
  // acquisition await, immediately before the FCM fetch (closing the token-acquisition gap).
  if (!isLive()) return { vault: reg.vault, action: 'timeout', stage }; // runExecutor may have raced the timeout → no late alert
  if (!readiness.networkVerified) return { vault: reg.vault, action: 'net_unverified', stage };

  // isLive() in the canSend guard (same reason as the completion push): suppress an alert whose worker
  // timeout fired during token acquisition instead of delivering it late.
  const result = await sendPush(reg.device_token, msg, { canSend: () => isLive() && readiness.networkVerified });
  // Order matters (see #3): SUPPRESSED first (send did NOT happen — retain), then persist any DEFINITIVE
  // outcome regardless of a post-send network flip / mid-send expiry. If the network flips WHILE FCM is
  // processing, sendPush can still return ok:true — gating the record on networkVerified here would leave
  // last_stage unadvanced and re-send the same stage next cycle (a duplicate). The network gate is applied
  // BEFORE the send (above + inside canSend); a completed send must be recorded.
  if (result.suppressed) return { vault: reg.vault, action: 'net_unverified', stage };
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

// Injectable for batch-level tests (allRegistrations / processRegistration / checkProgram default to
// the real implementations). This lets a test drive an all-rejecting cycle and prove it is UNhealthy.
export async function pollOnce({
  allRegistrations: allRegs = allRegistrations,
  processRegistration: processReg = processRegistration,
  checkProgram: probeProgram = checkProgram,
  probeTimeoutMs = VAULT_TIMEOUT_MS, // injectable only so the bound is unit-testable without a 45s wait
} = {}) {
  const regs = allRegs();
  if (regs.length === 0) {
    // No registrations to read — probe the actual PROGRAM ACCOUNT (not just getSlot, which only proves
    // the RPC is reachable). This makes pollerReady reflect that the configured DMV program is present
    // and readable, closing the "no registrations + getSlot ok → READY over a missing program"
    // false-green. BOUND it (like per-vault work): a hung probe would otherwise wedge the tick and let
    // the watchdog start overlapping probes.
    const prog = await withTimeout(probeProgram(), probeTimeoutMs, () => ({ ok: false, reason: 'timeout' }));
    return { checked: 0, sent: 0, readErrors: 0, probeOk: prog.ok === true };
  }
  const now = Math.floor(Date.now() / 1000);

  let sent = 0;
  let readErrors = 0;
  let idx = 0;

  // Bounded-concurrency worker pool: registrations are independent, so process a
  // few at once instead of strictly sequentially — one slow/hung vault no longer
  // blocks every other vault's alerts and executions.
  const worker = async () => {
    while (idx < regs.length) {
      const reg = regs[idx++];
      // Per-registration expiry flag: flipped when THIS registration's withTimeout fires, and read by
      // the isLive guard threaded into processReg so a slow read can't perform late effects after the
      // worker has moved on to the next registration.
      let expired = false;
      try {
        const r = await withTimeout(
          processReg(reg, now, undefined, () => !expired),
          VAULT_TIMEOUT_MS,
          () => { expired = true; return { vault: reg.vault, action: 'timeout' }; },
        );
        if (READ_FAILURE_ACTIONS.has(r.action)) readErrors += 1;
        if (r.action === 'sent') {
          sent++;
          console.log(`[push] sent stage ${r.stage} -> ${reg.vault.slice(0, 8)} (owner ${reg.owner.slice(0, 8)})`);
        } else if (r.action === 'timeout') {
          console.log(`[poll] TIMEOUT -> ${reg.vault.slice(0, 8)} (skipped this tick; resumes next)`);
        } else if (r.action.startsWith('deregistered')) {
          console.log(`[drop] ${r.action} -> ${reg.vault.slice(0, 8)}`);
        } else if (r.action === 'send_failed') {
          console.log(`[push] FAILED stage ${r.stage} -> ${reg.vault.slice(0, 8)}: ${r.error}`);
        }
      } catch (e) {
        // An UNEXPECTED throw is still an unsuccessful read for this registration — count it (else an
        // all-throwing cycle records readErrors=0 over N checked and is falsely "healthy"). Redacted
        // through the shared sanitizer (an RPC error string can embed the provider URL + api-key).
        readErrors += 1;
        console.log(`[poll] read failed -> ${reg.vault.slice(0, 8)}: ${sanitize(e?.message ?? 'error')}`);
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(POLL_CONCURRENCY, regs.length) }, () => worker()),
  );
  return { checked: regs.length, sent, readErrors };
}

export function startPoller() {
  if (timer) return;
  const tick = async () => {
    // Normally skip if a tick is already in flight. Watchdog: if the flag has
    // been stuck far longer than any healthy tick (a wedged run), let a new tick
    // start anyway so polling can't silently die (the per-vault crank lock keeps
    // an overlapping run safe).
    if (running && Date.now() - runningSince < MAX_TICK_MS) return;
    running = true;
    runningSince = Date.now();
    try {
      // Gate the probe on network verification ONLY — NEVER on pollerReady (that would be circular:
      // after startup or a failure-threshold demotion the poller could never make itself ready
      // again). `pollerReady` is the RESULT of a successful read cycle (recordPollResult below), not
      // a prerequisite for attempting one. Execution is separately gated on readiness.executorReady
      // inside processRegistration.
      if (shouldProbe(readiness)) {
        const res = await pollOnce();
        // pollerReady is driven ONLY by an actual read outcome: per-vault reads when there are
        // registrations, else the empty-cycle program-account probe. Fail-closed cycle semantics
        // (isPollCycleHealthy): a cycle is healthy only if STRICTLY FEWER than half its reads failed,
        // so a widespread read outage where most/all reads fail is NOT counted as a healthy cycle.
        const healthy = isPollCycleHealthy(res, {
          maxRatio: config.pollMaxFailureRatio,
          maxAbs: config.pollMaxFailureAbs,
        });
        readiness.recordPollResult(healthy, Date.now(), { checked: res.checked, readErrors: res.readErrors });
      }
    } catch (e) {
      // Never let a tick reject out of setInterval (would be an unhandled rejection and could
      // crash the daemon). Per-vault errors are already caught inside pollOnce; this guards the
      // prelude (e.g. DB read).
      console.error('[poll] tick failed:', sanitize(e?.message ?? e));
      readiness.recordPollResult(false, Date.now());
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
