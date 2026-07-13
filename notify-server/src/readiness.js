// Operational-readiness core (WP1 Phase 2). Pure, dependency-injected logic + a small state holder
// so the whole thing is unit-testable without a live RPC / FCM / disk. The overriding invariant:
// an EXECUTOR problem must never flip escalation off — hence escalationReady excludes executorReady.
//
// Readiness domains (7):
//   apiReady         HTTP listener up + static config valid
//   fcmReady         Firebase push transport usable
//   networkVerified  RPC positively serves the expected cluster (genesis hash)
//   programReady     configured DMV program account present + executable (mandatory, non-waivable in deriveHealth)
//   pollerReady      on-chain state currently readable (a healthy poll cycle / program probe)
//   executorReady    cranker key + funded balance + executable program + RPC usable
//   escalationReady  = fcmReady && networkVerified && pollerReady   (NO executorReady)
// deriveHealth requires: apiReady, networkVerified, programReady, poller, (fcm|waived), (executor|waived).
import { PublicKey } from '@solana/web3.js';

export const NET = { VERIFIED: 'VERIFIED', MISMATCH: 'MISMATCH', UNKNOWN: 'UNKNOWN' };
export const HEALTH = { READY: 'READY', DEGRADED: 'DEGRADED', NOT_READY: 'NOT_READY' };

/** A genesis hash is a canonical Base58-encoded 32-byte value. Validate the SHAPE before comparing, so a
 *  MALFORMED full-length response (invalid Base58, wrong byte length, non-canonical encoding) is UNKNOWN
 *  (transient/degraded) — never a positive MISMATCH (a fatal wrong-cluster verdict). The PublicKey
 *  round-trip is exactly "decodes to 32 bytes AND re-encodes identically". */
function isCanonicalGenesisHash(s) {
  try {
    return typeof s === 'string' && new PublicKey(s).toBase58() === s;
  } catch {
    return false;
  }
}

/** Map a thrown error to a stable machine-readable reason code (never leaks a URL/secret). */
export function reasonCode(err) {
  const m = (err?.message || String(err) || '').toLowerCase();
  if (m.includes('timeout') || m.includes('abort')) return 'rpc_timeout';
  if (m.includes('429') || m.includes('too many requests') || m.includes('rate limit')) return 'rpc_rate_limited';
  if (m.includes('econnrefused') || m.includes('connection refused')) return 'rpc_connection_refused';
  if (m.includes('enotfound') || m.includes('eai_again') || m.includes('getaddrinfo') || m.includes('dns')) return 'rpc_dns_failure';
  if (m.includes('fetch failed') || m.includes('network') || m.includes('socket')) return 'rpc_network_error';
  return 'rpc_unreachable';
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

/**
 * Classify the RPC genesis hash vs expected. NEVER throws. Distinguishes a positive MISMATCH
 * (RPC answered with a different hash = wrong cluster) from UNKNOWN (timeout/429/DNS/refused/
 * malformed = no positive proof either way). `getGenesisHash` is injected for testing.
 */
export async function classifyGenesis(getGenesisHash, expected, { timeoutMs = 8000 } = {}) {
  let received;
  try {
    received = await withTimeout(getGenesisHash(), timeoutMs);
  } catch (e) {
    return { state: NET.UNKNOWN, reason: reasonCode(e) };
  }
  // A malformed FULL-LENGTH value (invalid Base58 / not 32 bytes / non-canonical) is UNKNOWN, not a
  // positive MISMATCH: it is not proof of a different cluster, so it must not fatally halt the server.
  if (!isCanonicalGenesisHash(received)) {
    return { state: NET.UNKNOWN, reason: 'malformed_genesis_response' };
  }
  if (received === expected) {
    return { state: NET.VERIFIED, expectedGenesisHash: expected, receivedGenesisHash: received };
  }
  return { state: NET.MISMATCH, expectedGenesisHash: expected, receivedGenesisHash: received };
}

/**
 * Confirm the configured program account exists and (optionally) is executable. A transient RPC
 * error is reported as UNKNOWN (degraded), NOT a positive program failure. `getAccountInfo` injected.
 */
export async function checkProgramAccount(getAccountInfo, programId, { requireExecutable = true, timeoutMs = 8000 } = {}) {
  let acc;
  try {
    acc = await withTimeout(getAccountInfo(programId), timeoutMs); // bounded: a hung RPC → UNKNOWN, never pending forever
  } catch (e) {
    return { state: NET.UNKNOWN, reason: reasonCode(e) };
  }
  // `null` is Solana's DEFINITE "account not found". A fulfilled `undefined` is a malformed dependency
  // response, not a definite answer → UNKNOWN (degraded), never a definite missing-program condition.
  if (acc === null) return { ok: false, reason: 'program_not_found' };
  // A malformed getAccountInfo payload (undefined, a primitive, or an object with no boolean `executable`)
  // is NOT a definite positive: with requireExecutable=false, `!!acc.executable` on `{}`/`42`/`"x"` would
  // return ok:true and wrongly set programReady. Treat an unparseable shape as UNKNOWN (degraded).
  if (typeof acc !== 'object' || typeof acc.executable !== 'boolean') {
    return { state: NET.UNKNOWN, reason: 'malformed_program_response' };
  }
  const executable = acc.executable;
  if (requireExecutable && !executable) return { ok: false, reason: 'program_not_executable' };
  return { ok: true, executable };
}

/**
 * STATIC executor config validation — pure, LOCAL only (no RPC). Missing/unreadable/malformed/invalid
 * key material, or a mismatch against a configured expected pubkey, is FATAL: the caller exits
 * non-zero BEFORE listening, so a transient RPC outage can never disguise a broken local deployment.
 * A disabled/waived executor requires no keypair. `loadKeypair` is injected for testing.
 */
export function validateExecutorStaticConfig({ enabled, keypairPath, expectedPubkey, loadKeypair }) {
  if (!enabled) return { ok: true, disabled: true, reason: 'executor_disabled' };
  if (!keypairPath) return { fatal: true, reason: 'executor_keypair_path_missing' };
  let kp;
  try {
    kp = loadKeypair(keypairPath);
  } catch {
    return { fatal: true, reason: 'executor_keypair_unreadable' };
  }
  if (!kp || typeof kp.publicKey !== 'string') return { fatal: true, reason: 'executor_keypair_invalid' };
  if (expectedPubkey && kp.publicKey !== expectedPubkey) {
    return { fatal: true, reason: 'executor_pubkey_mismatch', cranker: kp.publicKey };
  }
  return { ok: true, cranker: kp.publicKey };
}

/**
 * RUNTIME executor readiness — the REMOTE checks (program account + balance). Never throws. Every
 * transient RPC failure → { transient:true } (DEGRADED: execution blocked, API + escalation stay
 * alive). A low balance blocks submission but is recoverable. Assumes static config already
 * validated at boot (the cranker pubkey is known).
 */
export async function checkExecutorRuntimeReadiness({ cranker, checkProgram, getBalance, minLamports, warnLamports, timeoutMs = 8000 }) {
  if (!cranker) return { ready: false, reason: 'executor_no_cranker' };
  // Defense-in-depth: checkProgram (→ checkProgramAccount) is itself timeout-bounded and never-throws,
  // but it is an INJECTED dependency — a caller could pass one that rejects or hangs. Wrap it so a
  // rejecting or never-settling program probe degrades transiently instead of violating this function's
  // documented "never throws" contract (which would interrupt the readiness monitor).
  let prog;
  try {
    prog = await withTimeout(checkProgram(), timeoutMs);
  } catch (e) {
    return { ready: false, transient: true, reason: `program_${reasonCode(e)}`, cranker };
  }
  // The rejection/timeout paths are guarded above; a FULFILLED but malformed value (null / undefined /
  // primitive) would throw on `prog.state` below and break the documented "never throws" contract, so
  // validate the shape first and degrade transiently.
  if (!prog || typeof prog !== 'object') {
    return { ready: false, transient: true, reason: 'program_malformed_response', cranker };
  }
  if (prog.state === NET.UNKNOWN) return { ready: false, transient: true, reason: `program_${prog.reason}`, cranker };
  if (!prog.ok) return { ready: false, reason: prog.reason, cranker };
  let lamports;
  try {
    lamports = await withTimeout(getBalance(cranker), timeoutMs); // bounded: a hung balance RPC → transient degraded
  } catch (e) {
    return { ready: false, transient: true, reason: `balance_${reasonCode(e)}`, cranker };
  }
  // A malformed balance (undefined / null-coerces-to-0 / NaN / Infinity / negative / non-numeric) must
  // NOT slip through: `NaN < minLamports` is false, so without this guard a garbage reading would fall
  // through to ready:true and let the executor crank on a balance it never actually verified. This is
  // NOT transient — a well-formed RPC that returns a non-number is a hard reject, not a retry.
  if (typeof lamports !== 'number' || !Number.isFinite(lamports) || lamports < 0) {
    return { ready: false, reason: 'executor_balance_malformed', cranker, balanceSol: null };
  }
  const balanceSol = lamports / 1e9;
  if (lamports < minLamports) {
    return { ready: false, reason: 'executor_balance_below_minimum', cranker, balanceSol, minSol: minLamports / 1e9 };
  }
  const low = lamports < warnLamports;
  return { ready: true, cranker, balanceSol, low, reason: low ? 'balance_warning' : 'ok' };
}

/** Bounded exponential backoff with jitter (50%–100% of the exponential step). `rng` injected. */
export function nextBackoff(attempt, { baseMs = 1000, maxMs = 60000, rng = Math.random } = {}) {
  const exp = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt));
  const withJitter = exp / 2 + rng() * (exp / 2);
  return Math.min(maxMs, Math.max(baseMs, Math.floor(withJitter)));
}

/** escalationReady derivation — deliberately excludes executorReady. */
export function computeEscalationReady({ fcmReady, networkVerified, pollerReady }) {
  return !!(fcmReady && networkVerified && pollerReady);
}

/** Boot-time decision for a network classification: MISMATCH → 'exit' (fatal); VERIFIED → 'proceed';
 *  UNKNOWN → 'degraded' (start, retry). A RUNTIME mismatch is handled differently (disable tx
 *  producers, don't exit) — this is boot-only. */
export function bootDecision(state) {
  if (state === NET.MISMATCH) return 'exit';
  if (state === NET.VERIFIED) return 'proceed';
  return 'degraded';
}

/** The poller's probe gate: attempt a read cycle whenever the network is VERIFIED. `pollerReady` is a
 *  RESULT of a successful probe (recordPollResult), NEVER a prerequisite for attempting one — so the
 *  poller always recovers after startup or a failure-threshold demotion (no circular gate). */
export function shouldProbe(state) {
  return !!state.networkVerified;
}

// Conservative, documented poll-cycle health (Blockers 5 + 6). A dead-man notification service must
// NOT report its poller healthy while a large fraction — or the WHOLE — of a small fleet goes
// unmonitored. A cycle is a healthy READ only if ALL of:
//   - the failure RATIO is within a tight service-level bound (default 5%), AND
//   - the ABSOLUTE failure count is within a CAP (default 2 — a MAXIMUM, not a tolerance floor), AND
//   - at least ONE registration read succeeded.
// So a complete tiny-fleet outage (1/1, 2/2) is UNhealthy (ratio + no-success both fail), a mostly-
// failed cycle is UNhealthy (ratio), and a healthy large fleet with a few flaky reads within 5% stays
// healthy (e.g. 1/20). Both bounds are configurable; the 3-consecutive-failure hysteresis in
// recordPollResult sits on top. With no registrations, the empty-cycle program-account probe stands in.
export const DEFAULT_MAX_READ_FAILURE_RATIO = 0.05;
export const DEFAULT_MAX_READ_FAILURE_ABS = 2;
export function isPollCycleHealthy(
  { checked, readErrors, probeOk },
  { maxRatio = DEFAULT_MAX_READ_FAILURE_RATIO, maxAbs = DEFAULT_MAX_READ_FAILURE_ABS } = {},
) {
  if (checked > 0) {
    const ratioOk = readErrors / checked <= maxRatio;
    const absoluteOk = readErrors <= maxAbs; // CAP: never "healthy" past this many failed reads
    const someSucceeded = checked - readErrors >= 1; // never "healthy" while NO owner was read
    return ratioOk && absoluteOk && someSucceeded;
  }
  return probeOk === true;
}

// Poller destructive-action guard (Blocker 5). A "vault missing" reading may only be turned into a
// registration DELETE when the program is currently readable — during a GLOBAL program-readiness
// failure (wrong/pruned RPC) every vault looks missing, and a naive delete would wipe every
// registration. Fail-closed: no delete while the program isn't positively readable.
export function canDeleteMissingRegistration({ programReady }) {
  return programReady === true;
}

/** Aggregate health. NOT_READY on no-listener or a confirmed cluster MISMATCH; else READY iff all
 *  mandatory domains (network, program, fcm-or-waived, poller, executor-or-waived) are up; otherwise
 *  DEGRADED. `programReady` is MANDATORY and NON-waivable: the server must never report READY while
 *  the configured DMV program is absent/non-executable (a false-green — getSlot alone can't prove the
 *  program exists). */
export function deriveHealth(d) {
  if (!d.apiReady) return HEALTH.NOT_READY;
  if (d.networkState === NET.MISMATCH) return HEALTH.NOT_READY;
  const netOk = d.networkVerified;
  const progOk = d.programReady;
  const fcmOk = d.fcmReady || d.fcmWaived;
  const execOk = d.executorReady || d.executorWaived;
  const pollOk = d.pollerReady;
  if (netOk && progOk && fcmOk && pollOk && execOk) return HEALTH.READY;
  return HEALTH.DEGRADED;
}

/** Mutable readiness holder. server.js uses the singleton; tests construct fresh instances. */
export class ReadinessState {
  constructor({ fcmWaived = false, executorWaived = false } = {}) {
    this.apiReady = false;
    this.fcmReady = false;
    this.networkVerified = false;
    this.programReady = false;
    this.pollerReady = false;
    this.executorReady = false;
    this.fcmWaived = fcmWaived;
    this.executorWaived = executorWaived;
    this.net = { state: NET.UNKNOWN, reason: 'startup' };
    this.program = { executable: null, reason: 'startup' };
    this.fcm = { reason: 'startup' };
    this.executor = { reason: 'startup' };
    this.crankerBalanceSol = null;
    this.poller = { consecutiveFailures: 0, lastOkAt: null, lastChecked: null, lastReadErrors: null, lastFailureRatio: null };
    this.lastVerifiedAt = null;
    this.lastAttemptAt = null;
    this.backoffAttempt = 0;
  }

  get escalationReady() {
    return computeEscalationReady(this);
  }

  health() {
    return deriveHealth({
      apiReady: this.apiReady,
      networkState: this.net.state,
      networkVerified: this.networkVerified,
      programReady: this.programReady,
      fcmReady: this.fcmReady,
      pollerReady: this.pollerReady,
      executorReady: this.executorReady,
      fcmWaived: this.fcmWaived,
      executorWaived: this.executorWaived,
    });
  }

  /** Apply a network classification. UNKNOWN/MISMATCH clears networkVerified + tx-producer domains. */
  applyNet(net, nowMs = null) {
    this.net = net;
    this.lastAttemptAt = nowMs;
    if (net.state === NET.VERIFIED) {
      this.networkVerified = true;
      this.lastVerifiedAt = nowMs;
      this.backoffAttempt = 0;
    } else {
      this.networkVerified = false;
      this.programReady = false; // can't prove the program on an unverified/wrong cluster
      this.pollerReady = false;
      this.executorReady = false; // transaction producers off until re-VERIFIED
      // Also clear the stale DIAGNOSTICS, not just the booleans: otherwise /health would keep
      // advertising the last "program ok / executor ready / balance 0.5" while the cluster is
      // unverified — a misleading snapshot. Reset them to a network_unverified reason.
      this.program = { executable: null, reason: 'network_unverified' };
      this.executor = { reason: 'network_unverified' };
      this.crankerBalanceSol = null;
    }
    return this;
  }

  setFcm(ready, reason = null) {
    this.fcmReady = !!ready;
    if (reason) this.fcm = { reason };
    return this;
  }

  setProgram(res) {
    // res: {ok, executable} | {ok:false, reason} | {state:'UNKNOWN', reason}
    // programReady is a MANDATORY health domain: only a positive {ok:true} sets it. A transient
    // UNKNOWN or a definite not-found/not-executable both clear it (fail-closed → health DEGRADED,
    // never a false READY over a missing program).
    if (res.ok) this.program = { executable: res.executable, reason: 'ok' };
    else this.program = { executable: res.state === NET.UNKNOWN ? null : false, reason: res.reason };
    this.programReady = res.ok === true;
    // Executor readiness is SUBORDINATE to program readiness: a program demotion must immediately clear
    // executorReady (and its stale balance), so the poller's transaction guard can't crank against a
    // program the current RPC can no longer prove. It's only restored by a fresh positive setExecutor.
    if (!this.programReady) {
      this.executorReady = false;
      this.crankerBalanceSol = null;
    }
    return this;
  }

  setExecutor(res) {
    // Only accept a POSITIVE executor result while network + program are BOTH currently ready — the
    // executor requires a verified cluster and a proven program. This keeps executorReady subordinate so
    // a stale successful probe can't outlive a network/program demotion.
    this.executorReady = !!res.ready && this.networkVerified === true && this.programReady === true;
    this.executor = { reason: res.reason || null, disabled: !!res.disabled, transient: !!res.transient, low: !!res.low };
    // Set on EVERY result: a balance-less (transient/degraded) executor probe must CLEAR the previous
    // balance, not leave /health advertising a stale successful value the current probe didn't verify.
    this.crankerBalanceSol = Number.isFinite(res.balanceSol) ? res.balanceSol : null;
    return this;
  }

  recordPollResult(ok, nowMs, { threshold = 3, checked = null, readErrors = null } = {}) {
    // Record the cycle metrics so /health exposes the read-failure ratio (not just a boolean).
    if (checked != null) {
      this.poller.lastChecked = checked;
      this.poller.lastReadErrors = readErrors;
      this.poller.lastFailureRatio = checked > 0 ? readErrors / checked : 0;
    }
    if (ok) {
      this.poller.consecutiveFailures = 0;
      this.poller.lastOkAt = nowMs;
      if (this.networkVerified) this.pollerReady = true;
    } else {
      this.poller.consecutiveFailures += 1;
      if (this.poller.consecutiveFailures >= threshold) this.pollerReady = false;
    }
    return this;
  }

  /** Redacted, machine-readable /health payload. Contains NO secrets, keypairs, or RPC URLs
   *  (genesis hashes, the cranker pubkey and the balance number are all public information). */
  snapshot() {
    const status = this.health();
    return {
      status, // READY | DEGRADED | NOT_READY
      ok: status === HEALTH.READY,
      apiReady: this.apiReady,
      fcmReady: this.fcmReady,
      networkVerified: this.networkVerified,
      programReady: this.programReady,
      pollerReady: this.pollerReady,
      executorReady: this.executorReady,
      escalationReady: this.escalationReady,
      network: {
        state: this.net.state,
        reason: this.net.reason || null,
        expectedGenesisHash: this.net.expectedGenesisHash || null,
        receivedGenesisHash: this.net.receivedGenesisHash || null,
      },
      program: { ready: this.programReady, executable: this.program.executable, reason: this.program.reason || null },
      fcm: { ready: this.fcmReady, reason: this.fcm?.reason || null },
      executor: {
        ready: this.executorReady,
        reason: this.executor.reason || null,
        crankerBalanceSol: this.crankerBalanceSol,
      },
      poller: {
        consecutiveFailures: this.poller.consecutiveFailures,
        lastOkAt: this.poller.lastOkAt,
        lastChecked: this.poller.lastChecked,
        lastReadErrors: this.poller.lastReadErrors,
        lastFailureRatio: this.poller.lastFailureRatio,
      },
      lastVerifiedAt: this.lastVerifiedAt,
      lastAttemptAt: this.lastAttemptAt,
      backoffAttempt: this.backoffAttempt,
    };
  }
}

/** Process-wide singleton used by the running server. Tests build their own instances. */
export const readiness = new ReadinessState();
