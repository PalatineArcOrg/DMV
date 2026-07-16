// Operational-readiness unit tests (Phase 2). Pure, dependency-injected — NO live RPC/FCM/disk.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NET,
  HEALTH,
  classifyGenesis,
  checkProgramAccount,
  validateExecutorStaticConfig,
  checkExecutorRuntimeReadiness,
  shouldProbe,
  isPollCycleHealthy,
  canDeleteMissingRegistration,
  nextBackoff,
  computeEscalationReady,
  deriveHealth,
  bootDecision,
  reasonCode,
  ReadinessState,
} from '../src/readiness.js';

const GEN = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'; // 44 chars
const OTHER = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';

// ── classifyGenesis ──────────────────────────────────────────────────────────
test('classifyGenesis VERIFIED on matching hash', async () => {
  const r = await classifyGenesis(() => Promise.resolve(GEN), GEN);
  assert.equal(r.state, NET.VERIFIED);
  assert.equal(r.receivedGenesisHash, GEN);
});
test('classifyGenesis MISMATCH on a different hash', async () => {
  const r = await classifyGenesis(() => Promise.resolve(OTHER), GEN);
  assert.equal(r.state, NET.MISMATCH);
  assert.equal(r.expectedGenesisHash, GEN);
  assert.equal(r.receivedGenesisHash, OTHER);
});
// A MALFORMED full-length value (invalid Base58 char, or valid Base58 that isn't 32 bytes) is NOT proof
// of a different cluster → UNKNOWN, never a FATAL MISMATCH.
test('classifyGenesis: a malformed full-length genesis is UNKNOWN, never a fatal MISMATCH', async () => {
  for (const bad of ['O'.repeat(44), '1'.repeat(44), 'not-base58-!!!' + 'x'.repeat(30)]) {
    const r = await classifyGenesis(() => Promise.resolve(bad), GEN);
    assert.equal(r.state, NET.UNKNOWN, `${bad.slice(0, 8)}… → UNKNOWN`);
    assert.equal(r.reason, 'malformed_genesis_response');
  }
});
test('classifyGenesis UNKNOWN on timeout (never resolves)', async () => {
  const r = await classifyGenesis(() => new Promise(() => {}), GEN, { timeoutMs: 20 });
  assert.equal(r.state, NET.UNKNOWN);
  assert.equal(r.reason, 'rpc_timeout');
});
test('classifyGenesis UNKNOWN on 429', async () => {
  const r = await classifyGenesis(() => Promise.reject(new Error('429 Too Many Requests')), GEN);
  assert.equal(r.state, NET.UNKNOWN);
  assert.equal(r.reason, 'rpc_rate_limited');
});
test('classifyGenesis UNKNOWN on connection refused / DNS', async () => {
  assert.equal((await classifyGenesis(() => Promise.reject(new Error('ECONNREFUSED')), GEN)).reason, 'rpc_connection_refused');
  assert.equal((await classifyGenesis(() => Promise.reject(new Error('getaddrinfo ENOTFOUND x')), GEN)).reason, 'rpc_dns_failure');
});
test('classifyGenesis UNKNOWN on malformed response', async () => {
  const r = await classifyGenesis(() => Promise.resolve('short'), GEN);
  assert.equal(r.state, NET.UNKNOWN);
  assert.equal(r.reason, 'malformed_genesis_response');
});

// ── checkProgramAccount ──────────────────────────────────────────────────────
test('checkProgramAccount ok when executable', async () => {
  const r = await checkProgramAccount(() => Promise.resolve({ executable: true }), 'pid');
  assert.deepEqual(r, { ok: true, executable: true });
});
test('checkProgramAccount program_not_found when null', async () => {
  assert.equal((await checkProgramAccount(() => Promise.resolve(null), 'pid')).reason, 'program_not_found');
});
test('checkProgramAccount program_not_executable', async () => {
  assert.equal((await checkProgramAccount(() => Promise.resolve({ executable: false }), 'pid')).reason, 'program_not_executable');
});
test('checkProgramAccount UNKNOWN on transient RPC error (not a positive failure)', async () => {
  const r = await checkProgramAccount(() => Promise.reject(new Error('timeout')), 'pid');
  assert.equal(r.state, NET.UNKNOWN);
  assert.equal(r.reason, 'rpc_timeout');
});
// Round-N: a MALFORMED getAccountInfo payload (primitive, or an object without a boolean `executable`)
// must be UNKNOWN — with requireExecutable=false, `!!acc.executable` on `{}`/`42`/`"x"` would otherwise
// return ok:true and wrongly set programReady.
test('checkProgramAccount UNKNOWN on a malformed payload (never a false-positive pass)', async () => {
  // `undefined` is a malformed dependency response (NOT a definite miss) → UNKNOWN, unlike `null`.
  for (const bad of [undefined, {}, 42, 'invalid', true, [], { executable: 'yes' }]) {
    const r = await checkProgramAccount(() => Promise.resolve(bad), 'pid', { requireExecutable: false });
    assert.equal(r.state, NET.UNKNOWN, `${String(bad)} → UNKNOWN`);
    assert.equal(r.reason, 'malformed_program_response');
    assert.notEqual(r.ok, true, 'a malformed payload must never read as a positive pass');
  }
  // null stays the DEFINITE "account not found"; a well-formed executable:true still passes.
  assert.equal((await checkProgramAccount(() => Promise.resolve(null), 'pid')).reason, 'program_not_found');
  assert.equal((await checkProgramAccount(() => Promise.resolve({ executable: true }), 'pid', { requireExecutable: false })).ok, true);
});

// Blocker 2: readiness RPCs must be TIMEOUT-BOUNDED — a never-settling call degrades, never hangs.
test('checkProgramAccount: a never-settling RPC → UNKNOWN within the timeout (not a hang)', async () => {
  const r = await checkProgramAccount(() => new Promise(() => {}), 'pid', { timeoutMs: 30 });
  assert.equal(r.state, NET.UNKNOWN);
  assert.equal(r.reason, 'rpc_timeout');
});

test('checkExecutorRuntimeReadiness: a never-settling balance RPC → transient within the timeout', async () => {
  const r = await checkExecutorRuntimeReadiness({
    cranker: 'C',
    checkProgram: async () => ({ ok: true, executable: true }),
    getBalance: () => new Promise(() => {}), // never settles
    minLamports: 0, warnLamports: 0, timeoutMs: 30,
  });
  assert.equal(r.ready, false);
  assert.equal(r.transient, true);
  assert.match(r.reason, /^balance_/);
});

// Blocker (this round): checkProgram is an INJECTED dependency. Its documented "never throws" contract
// must hold even if the injected probe REJECTS or NEVER SETTLES — both must degrade transiently
// (program_*), never throw out of checkExecutorRuntimeReadiness (which would interrupt the monitor).
test('checkExecutorRuntimeReadiness: a REJECTING checkProgram → transient (never throws)', async () => {
  const r = await checkExecutorRuntimeReadiness({
    cranker: 'C',
    checkProgram: async () => { throw new Error('boom'); },
    getBalance: async () => 3e8,
    minLamports: 1e8, warnLamports: 2e8, timeoutMs: 30,
  });
  assert.equal(r.ready, false);
  assert.equal(r.transient, true);
  assert.match(r.reason, /^program_/);
  assert.equal(r.cranker, 'C');
});
test('checkExecutorRuntimeReadiness: a NEVER-SETTLING checkProgram → transient within the timeout (no hang)', async () => {
  const start = Date.now();
  const r = await checkExecutorRuntimeReadiness({
    cranker: 'C',
    checkProgram: () => new Promise(() => {}), // never settles
    getBalance: async () => 3e8,
    minLamports: 1e8, warnLamports: 2e8, timeoutMs: 30,
  });
  assert.equal(r.ready, false);
  assert.equal(r.transient, true);
  assert.match(r.reason, /^program_/);
  assert.ok(Date.now() - start < 500, 'bounded by the timeout, did not hang');
});
// Blocker (this round): a checkProgram that FULFILLS with a malformed value (null/undefined/primitive)
// would throw on `prog.state` and break the "never throws" contract. It must degrade transiently.
test('checkExecutorRuntimeReadiness: a FULFILLED-but-malformed checkProgram → program_malformed_response (never throws)', async () => {
  for (const bad of [null, undefined, 42, 'ok', true]) {
    const r = await checkExecutorRuntimeReadiness({
      cranker: 'C',
      checkProgram: async () => bad,
      getBalance: async () => 3e8,
      minLamports: 1e8, warnLamports: 2e8, timeoutMs: 30,
    });
    assert.equal(r.ready, false, `${String(bad)} → not ready`);
    assert.equal(r.transient, true, `${String(bad)} → transient`);
    assert.equal(r.reason, 'program_malformed_response', `${String(bad)} → program_malformed_response`);
  }
});

// ── validateExecutorStaticConfig (LOCAL key material — FATAL) ────────────────
const kpOk = () => ({ publicKey: 'CRANKERpubkey' });
test('static: disabled executor requires no keypair (ok, not fatal)', () => {
  const r = validateExecutorStaticConfig({ enabled: false, keypairPath: '', loadKeypair: kpOk });
  assert.equal(r.ok, true);
  assert.equal(r.disabled, true);
  assert.equal(r.fatal, undefined);
});
test('static: enabled + missing keypair path is FATAL', () => {
  const r = validateExecutorStaticConfig({ enabled: true, keypairPath: '', loadKeypair: kpOk });
  assert.equal(r.fatal, true);
  assert.equal(r.reason, 'executor_keypair_path_missing');
});
test('static: unreadable keypair is FATAL', () => {
  const r = validateExecutorStaticConfig({ enabled: true, keypairPath: '/k', loadKeypair: () => { throw new Error('ENOENT'); } });
  assert.equal(r.fatal, true);
  assert.equal(r.reason, 'executor_keypair_unreadable');
});
test('static: malformed/invalid keypair (no pubkey) is FATAL', () => {
  assert.equal(validateExecutorStaticConfig({ enabled: true, keypairPath: '/k', loadKeypair: () => ({}) }).reason, 'executor_keypair_invalid');
});
test('static: expected-pubkey mismatch is FATAL', () => {
  const r = validateExecutorStaticConfig({ enabled: true, keypairPath: '/k', expectedPubkey: 'OTHER', loadKeypair: kpOk });
  assert.equal(r.fatal, true);
  assert.equal(r.reason, 'executor_pubkey_mismatch');
});
test('static: valid enabled keypair is ok (cranker returned, no RPC touched)', () => {
  const r = validateExecutorStaticConfig({ enabled: true, keypairPath: '/k', loadKeypair: kpOk });
  assert.equal(r.ok, true);
  assert.equal(r.cranker, 'CRANKERpubkey');
  assert.equal(r.fatal, undefined);
});

// ── checkExecutorRuntimeReadiness (REMOTE — always DEGRADED, never fatal) ─────
const okProgram = async () => ({ ok: true, executable: true });
const baseRt = { cranker: 'CRANKERpubkey', minLamports: 1e8, warnLamports: 2e8, checkProgram: okProgram, getBalance: async () => 3e8 };
test('runtime: program lookup transient → transient (degraded, not fatal)', async () => {
  const r = await checkExecutorRuntimeReadiness({ ...baseRt, checkProgram: async () => ({ state: NET.UNKNOWN, reason: 'rpc_timeout' }) });
  assert.equal(r.ready, false);
  assert.equal(r.transient, true);
});
test('runtime: program not executable → definite (not transient)', async () => {
  const r = await checkExecutorRuntimeReadiness({ ...baseRt, checkProgram: async () => ({ ok: false, reason: 'program_not_executable' }) });
  assert.equal(r.ready, false);
  assert.equal(r.reason, 'program_not_executable');
  assert.equal(r.transient, undefined);
});
test('runtime: balance below minimum blocks submission (recoverable)', async () => {
  const r = await checkExecutorRuntimeReadiness({ ...baseRt, getBalance: async () => 5e7 });
  assert.equal(r.ready, false);
  assert.equal(r.reason, 'executor_balance_below_minimum');
  assert.equal(r.balanceSol, 0.05);
});
test('runtime: exactly at minimum is ready', async () => {
  assert.equal((await checkExecutorRuntimeReadiness({ ...baseRt, getBalance: async () => 1e8 })).ready, true);
});
test('runtime: low (warn) but ready', async () => {
  const r = await checkExecutorRuntimeReadiness({ ...baseRt, getBalance: async () => 15e7 });
  assert.equal(r.ready, true);
  assert.equal(r.low, true);
});
test('runtime: funded is ready', async () => {
  const r = await checkExecutorRuntimeReadiness(baseRt);
  assert.equal(r.ready, true);
  assert.equal(r.low, false);
  assert.equal(r.cranker, 'CRANKERpubkey');
});
test('runtime: balance RPC error → transient (degraded)', async () => {
  const r = await checkExecutorRuntimeReadiness({ ...baseRt, getBalance: async () => { throw new Error('429'); } });
  assert.equal(r.ready, false);
  assert.equal(r.transient, true);
});
// A well-formed RPC that RESOLVES with a non-lamport value (undefined / null-coerces-to-0 / NaN /
// Infinity / negative / string) must be a HARD reject, not ready and not transient: `NaN < minLamports`
// is false, so without the guard a garbage reading falls through to ready:true and the executor cranks
// on a balance it never verified. null coerces to 0 in arithmetic → would have read as "0 SOL, ready?
// no" only by luck of below-minimum; we reject it explicitly as malformed rather than trust coercion.
test('runtime: a MALFORMED balance (non-numeric / NaN / Infinity / negative / null) is a hard reject, not ready', async () => {
  for (const bad of [undefined, null, NaN, Infinity, -Infinity, -1, '3']) {
    const r = await checkExecutorRuntimeReadiness({ ...baseRt, getBalance: async () => bad });
    assert.equal(r.ready, false, `${String(bad)} must not be ready`);
    assert.equal(r.reason, 'executor_balance_malformed', `${String(bad)} → executor_balance_malformed`);
    assert.equal(r.transient, undefined, `${String(bad)} is a hard reject, not a retry`);
    assert.equal(r.balanceSol, null);
  }
});

// ── shouldProbe: NON-CIRCULAR poller gate + bootstrap/failure/recovery ────────
test('shouldProbe gates on networkVerified ONLY (never pollerReady)', () => {
  const s = new ReadinessState();
  s.networkVerified = false;
  assert.equal(shouldProbe(s), false);
  s.networkVerified = true;
  s.pollerReady = false;
  assert.equal(shouldProbe(s), true, 'pollerReady=false must NOT block the probe (no circular gate)');
});
test('poller bootstrap → success → failures → still-probes → recovery; no exec while unready', () => {
  const s = new ReadinessState();
  s.networkVerified = true;
  s.executorReady = false; // executor NOT ready throughout
  assert.equal(s.pollerReady, false); // initial
  assert.equal(shouldProbe(s), true, 'first probe attempted despite pollerReady=false');
  s.recordPollResult(true, 1);
  assert.equal(s.pollerReady, true, 'successful probe → ready');
  s.recordPollResult(false, 2);
  s.recordPollResult(false, 3);
  s.recordPollResult(false, 4);
  assert.equal(s.pollerReady, false, 'demoted at failure threshold');
  assert.equal(shouldProbe(s), true, 'subsequent probe STILL attempted after demotion');
  s.recordPollResult(true, 5);
  assert.equal(s.pollerReady, true, 'recovery restores readiness');
  assert.equal(s.executorReady, false, 'executor stayed unready → no execution attempted');
});

// ── nextBackoff ──────────────────────────────────────────────────────────────
test('nextBackoff is bounded and jittered', () => {
  const lo = nextBackoff(3, { baseMs: 1000, maxMs: 60000, rng: () => 0 });
  const hi = nextBackoff(3, { baseMs: 1000, maxMs: 60000, rng: () => 1 });
  assert.ok(lo <= hi);
  assert.ok(lo >= 1000 && hi <= 60000);
  // capped at maxMs for a large attempt
  assert.equal(nextBackoff(30, { baseMs: 1000, maxMs: 60000, rng: () => 1 }), 60000);
});

// ── escalationReady EXCLUDES executor ────────────────────────────────────────
test('escalationReady = fcm && network && poller; executor excluded', () => {
  assert.equal(computeEscalationReady({ fcmReady: true, networkVerified: true, pollerReady: true }), true);
  assert.equal(computeEscalationReady({ fcmReady: false, networkVerified: true, pollerReady: true }), false);
  assert.equal(computeEscalationReady({ fcmReady: true, networkVerified: false, pollerReady: true }), false);
  assert.equal(computeEscalationReady({ fcmReady: true, networkVerified: true, pollerReady: false }), false);
  // A ReadinessState with executor DOWN but fcm+net+poller UP is still escalationReady.
  const s = new ReadinessState();
  s.fcmReady = true; s.networkVerified = true; s.pollerReady = true; s.executorReady = false;
  assert.equal(s.escalationReady, true);
});

// ── deriveHealth ─────────────────────────────────────────────────────────────
test('deriveHealth READY / DEGRADED / NOT_READY', () => {
  const all = { apiReady: true, networkState: NET.VERIFIED, networkVerified: true, programReady: true, fcmReady: true, pollerReady: true, executorReady: true, fcmWaived: false, executorWaived: false };
  assert.equal(deriveHealth(all), HEALTH.READY);
  assert.equal(deriveHealth({ ...all, executorReady: false }), HEALTH.DEGRADED);
  assert.equal(deriveHealth({ ...all, executorReady: false, executorWaived: true }), HEALTH.READY); // waived
  assert.equal(deriveHealth({ ...all, fcmReady: false }), HEALTH.DEGRADED);
  // Blocker 5: programReady is MANDATORY and NON-waivable — a missing/non-executable program must
  // NEVER report READY, even with everything else up (the getSlot-only false-green).
  assert.equal(deriveHealth({ ...all, programReady: false }), HEALTH.DEGRADED);
  assert.equal(deriveHealth({ ...all, apiReady: false }), HEALTH.NOT_READY);
  assert.equal(deriveHealth({ ...all, networkState: NET.MISMATCH }), HEALTH.NOT_READY);
});

// ── isPollCycleHealthy (Blocker 2/5: cap semantics, no tiny-fleet false-green) ─
test('isPollCycleHealthy: ratio AND absolute cap AND at-least-one-success', () => {
  // Tiny-fleet TOTAL outages must be UNhealthy (the false-green being fixed).
  assert.equal(isPollCycleHealthy({ checked: 1, readErrors: 1 }), false, '1/1 outage is unhealthy (no success)');
  assert.equal(isPollCycleHealthy({ checked: 2, readErrors: 2 }), false, '2/2 outage is unhealthy');
  assert.equal(isPollCycleHealthy({ checked: 3, readErrors: 2 }), false, '2/3 failing exceeds 5% → unhealthy');
  // Widespread / half failures unhealthy.
  assert.equal(isPollCycleHealthy({ checked: 2000, readErrors: 1999 }), false);
  assert.equal(isPollCycleHealthy({ checked: 2000, readErrors: 999 }), false);
  // Positive boundary: 1 of 20 at the default 5% ratio + abs cap 2 → healthy.
  assert.equal(isPollCycleHealthy({ checked: 20, readErrors: 1 }), true, '1/20 (=5%) is healthy');
  // Absolute cap is a MAXIMUM, not a floor: even a huge fleet is unhealthy past maxAbs (default 2).
  assert.equal(isPollCycleHealthy({ checked: 2000, readErrors: 2 }), true, '2/2000 within cap → healthy');
  assert.equal(isPollCycleHealthy({ checked: 2000, readErrors: 3 }), false, '3 absolute failures exceeds the cap → unhealthy');
  // Configurable: raise the abs cap for a genuinely large fleet.
  assert.equal(isPollCycleHealthy({ checked: 2000, readErrors: 100 }, { maxRatio: 0.05, maxAbs: 100 }), true, '5% with a matching abs cap → healthy');
  assert.equal(isPollCycleHealthy({ checked: 2000, readErrors: 101 }, { maxRatio: 0.05, maxAbs: 100 }), false, 'over the configured abs cap → unhealthy');
  // Empty cycle → the program-account probe result stands in.
  assert.equal(isPollCycleHealthy({ checked: 0, readErrors: 0, probeOk: true }), true);
  assert.equal(isPollCycleHealthy({ checked: 0, readErrors: 0, probeOk: false }), false);
});

// ── canDeleteMissingRegistration (Blocker 5 destructive-action guard) ────────
test('canDeleteMissingRegistration only permits a delete when the program is readable', () => {
  assert.equal(canDeleteMissingRegistration({ programReady: true }), true);
  assert.equal(canDeleteMissingRegistration({ programReady: false }), false);
});

// ── recordPollResult exposes cycle metrics (Blocker 6) ───────────────────────
test('recordPollResult records checked / readErrors / failure-ratio for /health', () => {
  const s = new ReadinessState();
  s.networkVerified = true;
  s.recordPollResult(false, 1, { checked: 2000, readErrors: 1999 });
  assert.equal(s.poller.lastChecked, 2000);
  assert.equal(s.poller.lastReadErrors, 1999);
  assert.ok(Math.abs(s.poller.lastFailureRatio - 0.9995) < 1e-9);
  const snap = s.snapshot();
  assert.equal(snap.poller.lastChecked, 2000);
  assert.equal(snap.poller.lastReadErrors, 1999);
  assert.ok(snap.poller.lastFailureRatio > 0.99);
});

// ── programReady is a mandatory health domain (Blocker 5) ────────────────────
test('a missing/non-executable program keeps the snapshot out of READY', () => {
  const s = new ReadinessState();
  s.apiReady = true; s.fcmReady = true; s.executorWaived = true;
  s.applyNet({ state: NET.VERIFIED, expectedGenesisHash: GEN, receivedGenesisHash: GEN }, 1);
  s.recordPollResult(true, 1); // pollerReady true
  s.setProgram({ ok: false, reason: 'program_not_found' }); // program absent
  assert.equal(s.programReady, false);
  assert.equal(s.health(), HEALTH.DEGRADED, 'never READY over a missing program');
  s.setProgram({ ok: true, executable: true });
  assert.equal(s.programReady, true);
  assert.equal(s.health(), HEALTH.READY);
});

// ── bootDecision ─────────────────────────────────────────────────────────────
test('bootDecision maps the three network states', () => {
  assert.equal(bootDecision(NET.VERIFIED), 'proceed');
  assert.equal(bootDecision(NET.MISMATCH), 'exit');
  assert.equal(bootDecision(NET.UNKNOWN), 'degraded');
});

// executorReady is SUBORDINATE to network + program readiness: a program demotion clears it immediately,
// and a positive executor probe can't restore it while the program (or network) is down.
test('#4: program demotion clears executorReady and blocks its restoration while the program is down', () => {
  const s = new ReadinessState();
  s.applyNet({ state: NET.VERIFIED, expectedGenesisHash: GEN, receivedGenesisHash: GEN }, 1000);
  s.setProgram({ ok: true, executable: true });
  s.setExecutor({ ready: true, balanceSol: 1 });
  assert.equal(s.executorReady, true, 'executor ready when network + program are both ready');
  // Program demotes (transient UNKNOWN) → executorReady + its cached balance cleared immediately.
  s.setProgram({ state: NET.UNKNOWN, reason: 'rpc_timeout' });
  assert.equal(s.programReady, false);
  assert.equal(s.executorReady, false, 'program demotion clears executorReady');
  assert.equal(s.crankerBalanceSol, null, 'stale executor balance cleared on program demotion');
  // A positive executor probe must NOT restore executorReady while the program is not ready.
  s.setExecutor({ ready: true, balanceSol: 1 });
  assert.equal(s.executorReady, false, 'executor cannot be ready while the program is not ready');
  // Once the program is proven again, a positive executor probe restores it.
  s.setProgram({ ok: true, executable: true });
  s.setExecutor({ ready: true, balanceSol: 1 });
  assert.equal(s.executorReady, true, 'executor restorable once program + network are ready again');
});

// ── ReadinessState transitions ───────────────────────────────────────────────
test('applyNet VERIFIED sets networkVerified + resets backoff; UNKNOWN clears tx producers', () => {
  const s = new ReadinessState();
  s.backoffAttempt = 5; s.pollerReady = true; s.executorReady = true;
  s.applyNet({ state: NET.VERIFIED, expectedGenesisHash: GEN, receivedGenesisHash: GEN }, 1000);
  assert.equal(s.networkVerified, true);
  assert.equal(s.backoffAttempt, 0);
  assert.equal(s.lastVerifiedAt, 1000);

  s.pollerReady = true; s.executorReady = true;
  s.applyNet({ state: NET.UNKNOWN, reason: 'rpc_timeout' }, 2000);
  assert.equal(s.networkVerified, false);
  assert.equal(s.pollerReady, false);
  assert.equal(s.executorReady, false); // transaction producers off
});

// FIX 4: a network demotion must clear the stale DIAGNOSTICS too, not just the readiness booleans —
// otherwise /health keeps advertising "program ok / executor ready / balance X" on an unverified cluster.
test('applyNet non-VERIFIED clears stale program/executor/balance diagnostics in the snapshot', () => {
  const s = new ReadinessState();
  // Bring it to a fully-healthy snapshot first (program ok, executor ready, a balance).
  s.apiReady = true; s.fcmReady = true; s.executorWaived = true;
  s.applyNet({ state: NET.VERIFIED, expectedGenesisHash: GEN, receivedGenesisHash: GEN }, 1);
  s.recordPollResult(true, 1);
  s.setProgram({ ok: true, executable: true });
  s.setExecutor({ ready: true, balanceSol: 0.5, reason: 'ok' });
  let snap = s.snapshot();
  assert.equal(snap.program.executable, true);
  assert.equal(snap.executor.ready, true);
  assert.equal(snap.executor.crankerBalanceSol, 0.5);

  // Network goes UNKNOWN → diagnostics must no longer advertise the stale healthy values.
  s.applyNet({ state: NET.UNKNOWN, reason: 'rpc_timeout' }, 2);
  snap = s.snapshot();
  assert.equal(snap.program.executable, null, 'program executable diagnostic reset');
  assert.equal(snap.program.reason, 'network_unverified');
  assert.equal(snap.executor.ready, false);
  assert.equal(snap.executor.reason, 'network_unverified');
  assert.equal(snap.executor.crankerBalanceSol, null, 'stale cranker balance cleared');
});

test('setExecutor clears a stale balance when a later balance-less (transient) result arrives', () => {
  const s = new ReadinessState();
  s.setExecutor({ ready: true, balanceSol: 0.5, reason: 'ok' });
  assert.equal(s.snapshot().executor.crankerBalanceSol, 0.5);
  // A transient/degraded executor probe returns NO balanceSol — /health must NOT keep showing 0.5.
  s.setExecutor({ ready: false, transient: true, reason: 'balance_rpc_timeout' });
  assert.equal(s.snapshot().executor.crankerBalanceSol, null, 'a balance-less result clears the stale balance');
  // A NaN/garbage balance also clears (never advertises an unverified number).
  s.setExecutor({ ready: false, balanceSol: NaN, reason: 'balance_invalid' });
  assert.equal(s.snapshot().executor.crankerBalanceSol, null);
});

test('recordPollResult demotes pollerReady after the failure threshold and restores on success', () => {
  const s = new ReadinessState();
  s.networkVerified = true; s.pollerReady = true;
  s.recordPollResult(false, 1); s.recordPollResult(false, 2);
  assert.equal(s.pollerReady, true, 'still ready below threshold');
  s.recordPollResult(false, 3);
  assert.equal(s.pollerReady, false, 'demoted at threshold (3)');
  s.recordPollResult(true, 4);
  assert.equal(s.pollerReady, true, 'restored on a successful cycle');
  assert.equal(s.poller.consecutiveFailures, 0);
});

test('a monitor program-check refresh cannot restore pollerReady after failed polls', () => {
  const s = new ReadinessState();
  s.networkVerified = true;
  s.recordPollResult(false, 1);
  s.recordPollResult(false, 2);
  s.recordPollResult(false, 3);
  assert.equal(s.pollerReady, false, 'demoted by failed polls');
  // The monitor refresh updates the program DIAGNOSTIC only — it must NOT touch pollerReady, else it
  // could re-enable polling right after failed polls demoted it.
  s.setProgram({ ok: true, executable: true });
  assert.equal(s.pollerReady, false, 'monitor program check must NOT restore pollerReady');
  s.recordPollResult(true, 4);
  assert.equal(s.pollerReady, true, 'only an ACTUAL successful poll restores it');
});

// ── snapshot redaction ───────────────────────────────────────────────────────
test('snapshot contains no secrets / keypairs / RPC URLs', () => {
  const s = new ReadinessState();
  s.apiReady = true; s.networkVerified = true; s.fcmReady = true; s.pollerReady = true; s.executorReady = true;
  s.applyNet({ state: NET.VERIFIED, expectedGenesisHash: GEN, receivedGenesisHash: GEN }, 5);
  s.setProgram({ ok: true, executable: true }); // programReady is now a mandatory READY domain
  s.crankerBalanceSol = 0.42;
  const json = JSON.stringify(s.snapshot());
  for (const bad of ['api-key', 'apikey', 'BEGIN', 'PRIVATE', 'secret', 'rpcUrl', 'http://', 'https://']) {
    assert.ok(!json.includes(bad), `snapshot leaked "${bad}"`);
  }
  const snap = s.snapshot();
  assert.equal(snap.status, HEALTH.READY);
  assert.equal(snap.escalationReady, true);
  assert.equal(snap.executor.crankerBalanceSol, 0.42);
  assert.equal(snap.network.state, NET.VERIFIED);
});

// ── reasonCode ───────────────────────────────────────────────────────────────
test('reasonCode maps common transient errors', () => {
  assert.equal(reasonCode(new Error('timeout')), 'rpc_timeout');
  assert.equal(reasonCode(new Error('429')), 'rpc_rate_limited');
  assert.equal(reasonCode(new Error('ECONNREFUSED')), 'rpc_connection_refused');
  assert.equal(reasonCode(new Error('whatever')), 'rpc_unreachable');
});
