// Poller destructive-action wiring (Blockers 5 + 6). These exercise the REAL processRegistration with
// injected deps, proving the wiring the reviewer flagged: the poller never DELETES a registration when
// the network is unverified or the program is globally unreadable, and never SENDS an alert on an
// unverified network. (The pure decision helpers are also unit-tested in readiness.test.js.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { processRegistration, pollOnce } from '../src/poller.js';
import { isPollCycleHealthy } from '../src/readiness.js';

const REG = { vault: 'VaultPubkey1111111111111111111111111111111', owner: 'Owner111111111111111111111111111111111111', device_token: 'devicetokendevicetoken', last_stage: 0, stage1: 10, stage2: 10, stage3: 10, last_notified_at: 0 };

function deps({ networkVerified = true, programReady = true, executorReady = false, fcmWaived = false, state, programProbe = { ok: true } } = {}) {
  const calls = { deleted: 0, sent: 0, updated: 0, cranked: 0, probed: 0 };
  return {
    calls,
    readiness: { networkVerified, programReady, executorReady, fcmWaived },
    readVaultState: async () => state,
    // A FRESH bounded program probe used before a destructive missing-vault delete (default: readable).
    checkProgram: async () => { calls.probed++; return programProbe; },
    deleteRegistration: () => { calls.deleted++; },
    updateNotifyState: () => { calls.updated++; },
    sendPush: async () => { calls.sent++; return { ok: true }; },
    runExecutor: async () => { calls.cranked++; return { action: 'cranked' }; },
  };
}

test('Blocker 1: an all-rejecting cycle is UNhealthy (rejections counted as read failures)', async () => {
  // The bug: a per-registration throw was swallowed without incrementing readErrors, so an
  // all-throwing cycle recorded readErrors=0 over N checked → falsely "healthy".
  const regs = Array.from({ length: 5 }, (_, i) => ({ ...REG, vault: `v${i}` }));
  const res = await pollOnce({
    allRegistrations: () => regs,
    processRegistration: async () => { throw new Error('rpc exploded'); },
  });
  assert.equal(res.checked, 5);
  assert.equal(res.readErrors, 5, 'every rejection counts as a failed read');
  assert.equal(isPollCycleHealthy(res), false, 'a fully-failing cycle is not healthy');
});

// Blocker (this round): the empty-cycle program probe must be BOUNDED — a hung probe would otherwise
// wedge the tick and let the watchdog start overlapping probes.
test('empty-cycle: a hung program probe is bounded → probeOk:false (does not hang the tick)', async () => {
  const start = Date.now();
  const res = await pollOnce({
    allRegistrations: () => [], // empty fleet → program-probe path
    checkProgram: () => new Promise(() => {}), // never settles
    probeTimeoutMs: 30,
  });
  assert.equal(res.checked, 0);
  assert.equal(res.probeOk, false, 'a hung probe resolves to not-ready, not a hang');
  assert.ok(Date.now() - start < 500, 'bounded by the probe timeout');
});
test('empty-cycle: a readable program → probeOk:true (normal path unchanged)', async () => {
  const res = await pollOnce({ allRegistrations: () => [], checkProgram: async () => ({ ok: true }), probeTimeoutMs: 1000 });
  assert.equal(res.probeOk, true);
});

// Blocker (this round): withTimeout only returns a fallback to the worker — processRegistration keeps
// running. Once the worker's timeout has fired (isLive → false), NO late effect may occur. This
// reproduces the worker's "timeout fires WHILE the read is in flight" race deterministically.
test('Late effects: a timeout during readVaultState prevents any late delete / send / update', async () => {
  const d = deps({ networkVerified: true, executorReady: true });
  let resolveRead, enteredRead;
  const entered = new Promise((r) => { enteredRead = r; });
  d.readVaultState = () => { enteredRead(); return new Promise((r) => { resolveRead = r; }); };
  let expired = false;
  // A state that WOULD normally delete + send a completion push (executed, stage 4).
  const p = processRegistration({ ...REG, last_stage: 4 }, 1000, d, () => !expired);
  await entered; // the read is provably in flight — deterministic, not a timing guess
  expired = true; // the worker's withTimeout fires and moves on to the next registration
  resolveRead({ exists: true, config: { active: false, executed: true, interval: 10 }, lastHeartbeat: 0 });
  const r = await p;
  assert.equal(r.action, 'timeout', 'the expired registration aborts instead of performing late effects');
  assert.equal(d.calls.deleted, 0, 'no late delete');
  assert.equal(d.calls.sent, 0, 'no late completion push');
  assert.equal(d.calls.updated, 0, 'no late notify-state update');
  assert.equal(d.calls.cranked, 0, 'no late crank');
});

// Blocker (this round): the post-await isLive checks can't see an IN-FLIGHT dependency. sendPush
// re-checks its `canSend` after token acquisition (right before the FCM request) and the executor
// re-checks its `canSubmit` before every submission — so isLive() must be folded INTO both guards, or a
// send/crank that was in flight when the worker timeout fired still lands after the worker moved on.
// These capture the ACTUAL callbacks and prove they flip false the instant the work item expires.
test('Late effects: expiry DURING the completion push flips canSend → false (in-flight FCM request suppressed)', async () => {
  const d = deps({ networkVerified: true, state: EXECUTED_STATE });
  let capturedCanSend, enteredSend, resolveSend;
  const entered = new Promise((r) => { enteredSend = r; });
  d.sendPush = (_t, _m, { canSend }) => { capturedCanSend = canSend; enteredSend(); return new Promise((r) => { resolveSend = () => r({ ok: true }); }); };
  let expired = false;
  const p = processRegistration({ ...REG, last_stage: 4 }, 1000, d, () => !expired);
  await entered; // sendPush is in flight (token acquisition); canSend captured
  assert.equal(capturedCanSend(), true, 'canSend true while the work item is live');
  expired = true; // the worker's withTimeout fires DURING token acquisition
  assert.equal(capturedCanSend(), false, 'canSend flips false → sendPush suppresses the late FCM request');
  resolveSend();
  await p;
});

test('Late effects: expiry DURING the alert push flips canSend → false (in-flight alert suppressed)', async () => {
  const d = deps({ networkVerified: true, executorReady: false });
  const state = { exists: true, config: { active: true, executed: false, interval: 10 }, lastHeartbeat: 0 };
  let capturedCanSend, enteredSend, resolveSend;
  const entered = new Promise((r) => { enteredSend = r; });
  const sendPush = (_t, _m, { canSend }) => { capturedCanSend = canSend; enteredSend(); return new Promise((r) => { resolveSend = () => r({ ok: true }); }); };
  let expired = false;
  const p = processRegistration({ ...REG, last_stage: 0 }, 100000, { ...d, readVaultState: async () => state, sendPush }, () => !expired);
  await entered;
  assert.equal(capturedCanSend(), true, 'canSend true while live');
  expired = true;
  assert.equal(capturedCanSend(), false, 'canSend flips false → the in-flight escalation alert is suppressed');
  resolveSend();
  await p;
});

// Round-N (#7): the liveness callback can't cancel an ALREADY-STARTED FCM request. If the send confirms
// delivery AFTER the work item expired, the outcome MUST still be recorded (last_stage advanced) — else
// the next cycle re-sends the same stage (a duplicate). This proves a confirmed post-expiry delivery is
// recorded as 'sent', not discarded as 'timeout'.
test('Late effects: a delivery confirmed AFTER expiry is RECORDED as sent (no duplicate next cycle)', async () => {
  const d = deps({ networkVerified: true, executorReady: false });
  const state = { exists: true, config: { active: true, executed: false, interval: 10 }, lastHeartbeat: 0 };
  let enteredSend, resolveSend;
  const entered = new Promise((r) => { enteredSend = r; });
  const sendPush = () => { d.calls.sent++; enteredSend(); return new Promise((r) => { resolveSend = () => r({ ok: true }); }); };
  let expired = false;
  const p = processRegistration({ ...REG, last_stage: 0 }, 100000, { ...d, readVaultState: async () => state, sendPush }, () => !expired);
  await entered;   // the FCM request is in flight
  expired = true;  // the worker's withTimeout fires DURING the request…
  resolveSend();   // …but FCM still confirms the delivery
  const r = await p;
  assert.equal(r.action, 'sent', 'a confirmed delivery is recorded, not discarded as timeout');
  assert.equal(d.calls.updated, 1, 'last_stage advanced → the next cycle does NOT duplicate the push');
});

test('Late effects: expiry DURING the crank flips canSubmit → false (remaining submissions abort)', async () => {
  const d = deps({ networkVerified: true, executorReady: true });
  const state = { exists: true, config: { active: true, executed: false, interval: 10 }, lastHeartbeat: 0 };
  let capturedCanSubmit, enteredExec, resolveExec;
  const entered = new Promise((r) => { enteredExec = r; });
  const runExecutor = (_v, { canSubmit }) => { capturedCanSubmit = canSubmit; enteredExec(); return new Promise((r) => { resolveExec = () => r({ action: 'cranked' }); }); };
  let expired = false;
  const p = processRegistration({ ...REG, last_stage: 3 }, 100000, { ...d, readVaultState: async () => state, runExecutor }, () => !expired);
  await entered; // the crank is in flight; canSubmit captured
  assert.equal(capturedCanSubmit(), true, 'canSubmit true while live');
  expired = true; // the worker's withTimeout fires mid-crank
  assert.equal(capturedCanSubmit(), false, 'canSubmit flips false → the executor aborts its remaining on-chain submissions');
  resolveExec();
  await p;
});

test('Blocker 1: no_heartbeat on an active vault counts as a failed read', async () => {
  const regs = [{ ...REG }];
  const res = await pollOnce({
    allRegistrations: () => regs,
    processRegistration: async (reg) => ({ vault: reg.vault, action: 'no_heartbeat' }),
  });
  assert.equal(res.readErrors, 1, 'an uncomputable deadline (no heartbeat) is a failed monitoring read');
  assert.equal(isPollCycleHealthy(res), false);
});

test('Blocker 3: a network flip WHILE runExecutor is pending suppresses the stage-4 notification', async () => {
  const d = deps({ networkVerified: true, executorReady: true });
  let resolveExec;
  // Deterministic "entered" signal resolved from INSIDE the fake runExecutor — no fixed sleep, no
  // timing assumption: the test flips readiness only once the crank is provably in flight.
  let enteredExec;
  const entered = new Promise((r) => { enteredExec = r; });
  d.runExecutor = () => { enteredExec(); return new Promise((r) => { resolveExec = () => { d.calls.cranked++; r({ action: 'aborted_readiness_revoked' }); }; }); };
  // A stage-4 (grace elapsed) state so the crank runs, then an alert would normally follow.
  const state = { exists: true, config: { active: true, executed: false, interval: 10 }, lastHeartbeat: 0 };
  const p = processRegistration({ ...REG, last_stage: 3 }, 100000, { ...d, readVaultState: async () => state });
  await entered; // runExecutor is now pending — deterministic, not a 10ms guess
  d.readiness.networkVerified = false; // cluster becomes unverified during the crank
  resolveExec();
  const r = await p;
  assert.equal(r.action, 'net_unverified', 'the post-executor recheck aborts before the alert');
  assert.equal(d.calls.sent, 0, 'no stage push derived from a now-stale-cluster read');
  assert.equal(d.calls.updated, 0, 'no notify-state update');
});

test('Blocker 3: processRegistration passes a live canSend that suppresses the push mid-send', async () => {
  // The network is VERIFIED at the pre-send recheck but flips DURING sendPush's token-acquisition await;
  // canSend (checked inside sendPush before the fetch) must suppress the actual delivery.
  let sends = 0, suppressed = 0, atSend = false;
  const readiness = { programReady: true, executorReady: false, get networkVerified() { return !atSend; } };
  const state = { exists: true, config: { active: true, executed: false, interval: 10 }, lastHeartbeat: 0 };
  const d = deps({ executorReady: false });
  const r = await processRegistration({ ...REG, last_stage: 0 }, 100000, {
    ...d,
    readiness,
    readVaultState: async () => state,
    sendPush: async (_t, _m, { canSend } = {}) => {
      atSend = true; // network flips during token acquisition, after the pre-send recheck already passed
      if (canSend && !canSend()) { suppressed++; return { ok: false, suppressed: true }; }
      sends++; return { ok: true };
    },
  });
  assert.equal(suppressed, 1, 'canSend suppressed the actual delivery');
  assert.equal(sends, 0);
  assert.equal(r.action, 'net_unverified');
});

test('Blocker 5: a "missing" vault is DELETED only when a LIVE program probe confirms readability', async () => {
  // LIVE probe ok → a genuinely-missing vault is deleted (normal cleanup).
  let d = deps({ programProbe: { ok: true }, state: { exists: false, config: null } });
  let r = await processRegistration(REG, 0, d);
  assert.equal(r.action, 'deregistered_missing');
  assert.equal(d.calls.deleted, 1);
  assert.equal(d.calls.probed, 1, 'a fresh program probe ran before the destructive delete');

  // LIVE probe not-ok (global failure — every vault looks missing) → NEVER delete; retry instead.
  d = deps({ programProbe: { ok: false, reason: 'program_not_found' }, state: { exists: false, config: null } });
  r = await processRegistration(REG, 0, d);
  assert.equal(r.action, 'program_unready');
  assert.equal(d.calls.deleted, 0, 'must not wipe registrations during a global program-readiness failure');
});

test('Blocker 5: a network flip WHILE checkProgram is pending aborts the missing-vault delete (TOCTOU)', async () => {
  // The live probe is another await — a network revocation while it is pending must not let a now-stale
  // ok:true authorize the destructive delete.
  const d = deps({ networkVerified: true, state: { exists: false, config: null } });
  d.checkProgram = async () => { d.readiness.networkVerified = false; return { ok: true }; };
  const r = await processRegistration(REG, 0, d);
  assert.equal(r.action, 'net_unverified');
  assert.equal(d.calls.deleted, 0, 'no delete when the network flipped during the program probe');
});
test('Blocker 5: expiry WHILE checkProgram is pending aborts the missing-vault delete', async () => {
  const d = deps({ networkVerified: true, state: { exists: false, config: null } });
  let expired = false;
  d.checkProgram = async () => { expired = true; return { ok: true }; };
  const r = await processRegistration(REG, 0, d, () => !expired);
  assert.equal(r.action, 'timeout');
  assert.equal(d.calls.deleted, 0, 'no delete when the work item expired during the program probe');
});

test('#3 alert: a network flip WHILE the send is pending still RECORDS a confirmed delivery (no duplicate)', async () => {
  const d = deps({ networkVerified: true, executorReady: false });
  const state = { exists: true, config: { active: true, executed: false, interval: 10 }, lastHeartbeat: 0 };
  // The network flips DURING the send, then FCM confirms delivery — the confirmed outcome must be recorded.
  d.sendPush = async () => { d.readiness.networkVerified = false; d.calls.sent++; return { ok: true }; };
  const r = await processRegistration({ ...REG, last_stage: 0 }, 100000, { ...d, readVaultState: async () => state });
  assert.equal(r.action, 'sent', 'a confirmed delivery is recorded despite a post-send network flip');
  assert.equal(d.calls.updated, 1, 'last_stage advanced → no duplicate next cycle');
});
test('#3 completion: a network flip WHILE the completion send is pending still deregisters (no duplicate)', async () => {
  const d = deps({ networkVerified: true, state: EXECUTED_STATE });
  d.sendPush = async () => { d.readiness.networkVerified = false; d.calls.sent++; return { ok: true }; };
  const r = await processRegistration({ ...REG, last_stage: 4 }, 1000, d);
  assert.equal(r.action, 'deregistered_inactive', 'a delivered completion deregisters despite a post-send network flip');
  assert.equal(d.calls.deleted, 1);
});

test('Blocker 5: STALE cached programReady:true does NOT authorize a delete — only the LIVE probe does', async () => {
  // The exact finding: a prior successful monitor tick leaves readiness.programReady === true, but the
  // CURRENT RPC can no longer serve the program (live probe UNKNOWN/not-ok). The delete must be withheld.
  const d = deps({ programReady: true, programProbe: { state: 'UNKNOWN', reason: 'rpc_timeout' }, state: { exists: false, config: null } });
  const r = await processRegistration(REG, 0, d);
  assert.equal(r.action, 'program_unready', 'stale-true cached readiness must not authorize the delete');
  assert.equal(d.calls.deleted, 0, 'no delete on a stale-true cache when the live probe is not ok:true');
  assert.equal(d.calls.probed, 1);
});

test('Blocker 3 TOCTOU: a network flip WHILE readVaultState is pending aborts before any effect', async () => {
  // Start VERIFIED, pause the read, flip to unverified during the read, then resolve it with a state
  // that would normally trigger a delete + completion push. Assert NOTHING destructive happens — the
  // post-read re-check catches the mid-read flip (the timeout wrapper does not cancel a slow read).
  const d = deps({ networkVerified: true, executorReady: true });
  let resolveRead;
  // Deterministic "entered" signal from INSIDE the fake read — the test flips readiness only once the
  // read is provably in flight, replacing the previous fixed 10ms sleep (a timing assumption).
  let enteredRead;
  const entered = new Promise((r) => { enteredRead = r; });
  d.readVaultState = () => { enteredRead(); return new Promise((r) => { resolveRead = r; }); };

  const p = processRegistration({ ...REG, last_stage: 4 }, 1000, d);
  await entered; // processRegistration has entered the pending read — deterministic, not a 10ms guess
  d.readiness.networkVerified = false; // cluster becomes unverified while the read is in flight
  resolveRead({ exists: true, config: { active: false, executed: true, interval: 10 }, lastHeartbeat: 0 });

  const r = await p;
  assert.equal(r.action, 'net_unverified');
  assert.equal(d.calls.deleted, 0, 'no delete from a read that completed after the cluster went unverified');
  assert.equal(d.calls.sent, 0, 'no completion push either');
  assert.equal(d.calls.cranked, 0);
  assert.equal(d.calls.updated, 0);
});

test('Blocker 6: an unverified network aborts the registration before any delete or send', async () => {
  // Even though the (stale) state says the vault is gone, an unverified network must not delete it…
  let d = deps({ networkVerified: false, state: { exists: false, config: null } });
  let r = await processRegistration(REG, 0, d);
  assert.equal(r.action, 'net_unverified');
  assert.equal(d.calls.deleted, 0, 'no delete on an unverified network');

  // …and a stage-4 state must not send an alert (or crank) on an unverified network.
  const now = 1000;
  const state = { exists: true, config: { active: true, executed: false, interval: 10 }, lastHeartbeat: 0 };
  d = deps({ networkVerified: false, executorReady: true, state });
  r = await processRegistration({ ...REG, last_stage: 0 }, now, d);
  assert.equal(r.action, 'net_unverified');
  assert.equal(d.calls.sent, 0, 'no alert on an unverified network');
  assert.equal(d.calls.cranked, 0, 'no crank on an unverified network');
});

// Completion push (Blocker 7): an executed vault that already reached stage 4 must send the final
// "distribution complete" push and only deregister once that send is accounted for — a transient FCM
// failure must RETAIN the registration so the completion push retries, instead of being lost forever.
const EXECUTED_STATE = { exists: true, config: { active: false, executed: true, interval: 10 }, lastHeartbeat: 0 };

test('Completion: a delivered "complete" push deregisters the vault', async () => {
  const d = deps({ state: EXECUTED_STATE }); // default sendPush → { ok: true }
  const r = await processRegistration({ ...REG, last_stage: 4 }, 1000, d);
  assert.equal(d.calls.sent, 1, 'the completion push was sent');
  assert.equal(d.calls.deleted, 1, 'deregistered after a delivered completion push');
  assert.equal(r.action, 'deregistered_inactive');
});

test('Completion: a transient send failure RETAINS the registration and reports send_failed:complete', async () => {
  const d = deps({ state: EXECUTED_STATE });
  d.sendPush = async () => { d.calls.sent++; return { ok: false, error: 'fcm_auth_failed' }; };
  const r = await processRegistration({ ...REG, last_stage: 4 }, 1000, d);
  assert.equal(d.calls.deleted, 0, 'a failed completion push must NOT delete the registration');
  // Reported as `send_failed` (with stage:'complete') — NOT a distinct action string the worker silently
  // drops. The worker only surfaces failures whose action === 'send_failed', so a completion-send failure
  // was previously invisible in the logs.
  assert.equal(r.action, 'send_failed');
  assert.equal(r.stage, 'complete');
  assert.equal(r.error, 'fcm_auth_failed');
});

test('Completion: a send_failed:complete is LOGGED by the worker and NOT counted as a read failure', async () => {
  // Drive the REAL worker loop (pollOnce) so we exercise both effects the reviewer flagged: (1) the
  // worker's `action === 'send_failed'` branch actually LOGS it, and (2) it is NOT a READ_FAILURE_ACTIONS
  // member, so a completion SEND failure never demotes pollerReady.
  const logs = [];
  const orig = console.log;
  console.log = (...a) => { logs.push(a.join(' ')); };
  let res;
  try {
    res = await pollOnce({
      allRegistrations: () => [{ ...REG, last_stage: 4 }],
      processRegistration: async (reg) => ({ vault: reg.vault, action: 'send_failed', stage: 'complete', error: 'fcm_auth_failed' }),
    });
  } finally {
    console.log = orig;
  }
  assert.equal(res.readErrors, 0, 'a completion SEND failure is not a READ failure (must not demote pollerReady)');
  assert.ok(logs.some((l) => /\[push\] FAILED stage complete/.test(l)), 'the worker logged the completion send failure');
});

test('Completion: a dead (unregistered) token is dropped — retrying is pointless', async () => {
  const d = deps({ state: EXECUTED_STATE });
  d.sendPush = async () => { d.calls.sent++; return { ok: false, unregistered: true }; };
  const r = await processRegistration({ ...REG, last_stage: 4 }, 1000, d);
  assert.equal(d.calls.deleted, 1, 'a dead token is deregistered');
  assert.equal(r.action, 'deregistered_inactive');
});

test('Completion: a suppressed (network-unverified) push RETAINS the registration', async () => {
  const d = deps({ state: EXECUTED_STATE });
  d.sendPush = async () => { d.calls.sent++; return { ok: false, suppressed: true }; };
  const r = await processRegistration({ ...REG, last_stage: 4 }, 1000, d);
  assert.equal(d.calls.deleted, 0, 'no delete when the completion push was suppressed');
  assert.equal(r.action, 'net_unverified');
});

test('Completion: fcmWaived skips the push entirely and deregisters', async () => {
  const d = deps({ fcmWaived: true, state: EXECUTED_STATE });
  const r = await processRegistration({ ...REG, last_stage: 4 }, 1000, d);
  assert.equal(d.calls.sent, 0, 'no push on a notify-disabled (fcmWaived) deployment');
  assert.equal(d.calls.deleted, 1, 'still deregistered — nothing to send or retry');
  assert.equal(r.action, 'deregistered_inactive');
});
