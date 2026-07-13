// Keeper operational-readiness — pure, dependency-injected functions (WP1 Phase 2). Kept separate
// from index.js/crank.js so CI can unit-test it WITHOUT importing the crank (no side effects, no
// self-executing loop). Mirrors the notify-server readiness classification.
import { PublicKey } from '@solana/web3.js';

export const NET = { VERIFIED: 'VERIFIED', MISMATCH: 'MISMATCH', UNKNOWN: 'UNKNOWN' };

/** A genesis hash is a canonical Base58-encoded 32-byte value. Validate the SHAPE before comparing, so a
 *  MALFORMED full-length response (invalid Base58, wrong byte length, non-canonical encoding) is treated
 *  as UNKNOWN (transient/degraded) — never as a positive MISMATCH (which would be a fatal wrong-cluster
 *  verdict). The PublicKey round-trip is exactly "decodes to 32 bytes AND re-encodes identically". */
function isCanonicalGenesisHash(s) {
  try {
    return typeof s === 'string' && new PublicKey(s).toBase58() === s;
  } catch {
    return false;
  }
}

export const GENESIS_HASHES = {
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  'mainnet-beta': '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
};

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

export function withTimeout(promise, ms, label) {
  let t;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(t)),
    new Promise((_, reject) => {
      t = setTimeout(() => {
        // Message keeps the word "timeout" so reasonCode() still maps it to 'rpc_timeout'; the
        // TimeoutError name lets a caller (tick's scan/balance guards) detect a HANG explicitly, without
        // depending on message matching.
        const err = new Error(label ? `timeout: ${label}` : 'timeout');
        err.name = 'TimeoutError';
        reject(err);
      }, ms);
    }),
  ]);
}

/** Classify RPC genesis vs expected. Never throws. UNKNOWN = transient (retry); MISMATCH = fatal. */
export async function classifyGenesis(getGenesisHash, expected, { timeoutMs = 8000 } = {}) {
  let received;
  try {
    received = await withTimeout(getGenesisHash(), timeoutMs);
  } catch (e) {
    return { state: NET.UNKNOWN, reason: reasonCode(e) };
  }
  // A malformed FULL-LENGTH value (invalid Base58 / not 32 bytes / non-canonical) is UNKNOWN, not a
  // positive MISMATCH: it is not proof of a different cluster, so it must not fatally halt the keeper.
  if (!isCanonicalGenesisHash(received)) {
    return { state: NET.UNKNOWN, reason: 'malformed_genesis_response' };
  }
  if (received === expected) return { state: NET.VERIFIED, expectedGenesisHash: expected, receivedGenesisHash: received };
  return { state: NET.MISMATCH, expectedGenesisHash: expected, receivedGenesisHash: received };
}

/** Confirm the program account exists + is executable. Transient RPC error OR a HUNG call (bounded by
 *  timeoutMs) → UNKNOWN (degraded, not fatal, never an indefinitely-pending promise). */
export async function checkProgramAccount(getAccountInfo, programId, { requireExecutable = true, timeoutMs = 8000 } = {}) {
  let acc;
  try {
    acc = await withTimeout(getAccountInfo(programId), timeoutMs);
  } catch (e) {
    return { state: NET.UNKNOWN, reason: reasonCode(e) };
  }
  // `null` is Solana's DEFINITE "account not found". A fulfilled `undefined` (or any other malformed
  // shape) is NOT a definite answer — it's a broken dependency response → UNKNOWN (degraded), never a
  // definite missing-program condition. Reserve program_not_found for null only.
  if (acc === null) return { ok: false, reason: 'program_not_found' };
  // A malformed payload (undefined, a primitive, or a non-boolean `executable`) is NOT a definite answer:
  // `!!acc.executable` on `{executable:'yes'}` would read as a positive pass. Treat an unparseable shape
  // as UNKNOWN (degraded), mirroring the notify-server guard. (The keeper always calls requireExecutable:
  // true, so a falsy-malformed value already fails closed; this also closes the truthy-non-boolean gap.)
  if (typeof acc !== 'object' || typeof acc.executable !== 'boolean') {
    return { state: NET.UNKNOWN, reason: 'malformed_program_response' };
  }
  const executable = acc.executable;
  if (requireExecutable && !executable) return { ok: false, reason: 'program_not_executable' };
  return { ok: true, executable };
}

/** STATIC keeper keypair validation — pure, LOCAL only (no RPC). Missing/unreadable/malformed/invalid
 *  keypair is FATAL: the keeper's ONLY job is cranking, so there is nothing to keep alive. `loadKeypair`
 *  is injected (it must THROW on an unreadable/malformed file) so this is unit-testable. */
export function validateKeeperKeypair(loadKeypair, keypairPath) {
  if (!keypairPath) return { fatal: true, reason: 'keypair_path_missing' };
  let kp;
  try {
    kp = loadKeypair(keypairPath);
  } catch {
    return { fatal: true, reason: 'keypair_unreadable' };
  }
  if (!kp || typeof kp.publicKey !== 'string') return { fatal: true, reason: 'keypair_invalid' };
  return { ok: true, cranker: kp.publicKey };
}

/** Balance verdict vs min/warn (lamports). Below min → not ok (skip cranking). */
export function evaluateBalance(lamports, { minLamports, warnLamports }) {
  // An unreadable/garbage balance (undefined / NaN / Infinity / negative) is NOT ready: `NaN < min` is
  // false, so without this guard it would fall through to ok:true with a NaN balance and let the keeper
  // crank on a balance it never actually verified.
  if (!Number.isFinite(lamports) || lamports < 0) return { ok: false, reason: 'balance_invalid', balanceSol: null };
  const balanceSol = lamports / 1e9;
  if (lamports < minLamports) return { ok: false, reason: 'balance_below_minimum', balanceSol };
  return { ok: true, low: lamports < warnLamports, balanceSol };
}

/**
 * Production network-revalidation guard with a DOCUMENTED cache policy (Blocker 2). Returns the async
 * `revalidate()` the keeper crank calls before EVERY submission. `check` re-verifies ALL mandatory
 * keeper domains — genesis, executable program, AND a funded balance at/above the minimum — under
 * bounded timeouts, returning a single boolean. A fresh `true` is reused for up to `ttlMs` to avoid an
 * RPC storm per tx. Cache policy (intentional): a domain flip INSIDE the TTL is not detected until the
 * TTL expires; after expiry the full re-check runs and a now-failing domain (cluster switched, program
 * gone, balance dropped below the floor) suppresses the next submission. `check` (→ Promise<boolean>)
 * and `now` (→ ms) are injected so index.js and the tests exercise the EXACT same logic.
 *   revalidate()             → Promise<boolean>       (true = ALL domains still ok → safe to submit)
 *   revalidate.markVerified(t?) → stamp a just-fully-verified result (e.g. right after the readiness gate)
 *   revalidate.isLive()      → current cached liveness (no RPC)
 */
export function makeReadinessRevalidator({ check, now, ttlMs }) {
  let live = false;
  let lastOkAt = -Infinity;
  const revalidate = async () => {
    const t = now();
    const ageMs = t - lastOkAt;
    // Reuse only a NON-NEGATIVE age below the TTL: a backward wall-clock jump makes ageMs negative
    // (still < ttlMs), which would otherwise let a stale verification be reused until the clock catches
    // up. A negative age forces a fresh re-check.
    if (live && ageMs >= 0 && ageMs < ttlMs) return true; // reuse a fresh all-domains-ok result within the TTL
    live = (await check()) === true;
    if (live) lastOkAt = now();
    return live;
  };
  revalidate.markVerified = (t = now()) => { live = true; lastOkAt = t; };
  revalidate.isLive = () => live;
  return revalidate;
}

/** Bounded exponential backoff with jitter (50%–100% of the exponential step). */
export function nextBackoff(attempt, { baseMs = 1000, maxMs = 60000, rng = Math.random } = {}) {
  const exp = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt));
  const withJitter = exp / 2 + rng() * (exp / 2);
  return Math.min(maxMs, Math.max(baseMs, Math.floor(withJitter)));
}

/**
 * Compose a keeper readiness gate from the injected building blocks. Returns:
 *   { fatal:true, reason }  — a global static failure (genesis MISMATCH / definite program failure): caller exits non-zero.
 *   { ok:false, reason, degraded:true } — transient/degraded (UNKNOWN network, RPC blip, low balance): DON'T crank, back off, retry.
 *   { ok:true, balanceSol, low } — safe to crank this tick.
 */
export async function keeperReadiness({ getGenesisHash, expectedGenesis, getAccountInfo, programId, getBalance, minLamports, warnLamports, requireExecutable = true, timeoutMs = 8000, now = Date.now }) {
  const net = await classifyGenesis(getGenesisHash, expectedGenesis, { timeoutMs });
  if (net.state === NET.MISMATCH) {
    return { fatal: true, reason: 'genesis_mismatch', net };
  }
  if (net.state === NET.UNKNOWN) {
    return { ok: false, degraded: true, reason: `network_${net.reason}`, net };
  }
  // Stamp the instant genesis was VERIFIED — BEFORE the (potentially slow) program + balance checks —
  // so the crank's revalidate() TTL is measured from the actual verification, not from gate return
  // (a 10s program/balance check must NOT make a 10s-old genesis look "fresh" for another 1.5s).
  const genesisVerifiedAt = now();
  // Every remaining RPC is timeout-bounded (via checkProgramAccount / withTimeout) so a never-settling
  // call degrades + retries instead of wedging the keeper loop.
  const prog = await checkProgramAccount(getAccountInfo, programId, { requireExecutable, timeoutMs });
  if (prog.state === NET.UNKNOWN) return { ok: false, degraded: true, reason: `program_${prog.reason}` };
  if (!prog.ok) return { fatal: true, reason: prog.reason };
  let lamports;
  try {
    lamports = await withTimeout(getBalance(), timeoutMs);
  } catch (e) {
    return { ok: false, degraded: true, reason: `balance_${reasonCode(e)}` };
  }
  const bal = evaluateBalance(lamports, { minLamports, warnLamports });
  if (!bal.ok) return { ok: false, degraded: true, reason: bal.reason, balanceSol: bal.balanceSol };
  return { ok: true, balanceSol: bal.balanceSol, low: bal.low, genesisVerifiedAt };
}
