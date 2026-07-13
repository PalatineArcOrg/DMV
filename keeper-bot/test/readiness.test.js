// Keeper readiness unit tests (Phase 2). Pure, dependency-injected — NO live RPC, and does NOT
// import crank.js / index.js (no crank side effects).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NET,
  classifyGenesis,
  checkProgramAccount,
  evaluateBalance,
  nextBackoff,
  keeperReadiness,
  validateKeeperKeypair,
  makeReadinessRevalidator,
  withTimeout,
} from '../src/readiness.js';

// makeReadinessRevalidator is the EXACT production TTL logic index.js uses: its `check` re-runs the
// FULL gate (genesis + program + balance), so a domain that fails mid-crank (cluster switch, program
// gone, OR balance dropping below the floor) suppresses the next submission after the TTL. Injected
// check + clock so the 1.5s cache policy is deterministically tested, not a synthetic counter.
test('makeReadinessRevalidator: a domain failure INSIDE the TTL is cached; AFTER expiry it suppresses the next submission', async () => {
  let ok = true; // all-domains-ok verdict from the full gate
  let t = 0;
  const revalidate = makeReadinessRevalidator({ check: async () => ok, now: () => t, ttlMs: 1500 });

  assert.equal(await revalidate(), true, 'first call: all domains ok (stamps t=0)');
  ok = false; // e.g. BALANCE just dropped below the floor, or program vanished...
  t = 1000; // ...but we're still inside the TTL
  assert.equal(await revalidate(), true, 'documented cache policy: an in-TTL domain failure is not re-checked');
  t = 1600; // TTL expired → full re-check
  assert.equal(await revalidate(), false, 'after expiry the failing domain is detected → submission suppressed');
  ok = true;
  t = 1700;
  assert.equal(await revalidate(), true, 'while not-live it re-checks every call → recovers when all domains ok again');
});

test('makeReadinessRevalidator: BALANCE revocation mid-crank suppresses the next submission (deterministic)', async () => {
  // Simulate a crank in progress: the gate initially reports all-ok, then the balance drops below MIN.
  let balanceOk = true;
  let t = 0;
  const revalidate = makeReadinessRevalidator({ check: async () => balanceOk, now: () => t, ttlMs: 1500 });
  revalidate.markVerified(0); // gate passed at t=0 → first crank tx reuses it
  t = 500;
  assert.equal(await revalidate(), true, 'early tx submits (balance still ok, within TTL)');
  balanceOk = false; // MID-CRANK: balance falls below MIN_KEEPER_BALANCE_SOL
  t = 2000; // a later tx, after the TTL → the full gate is re-run
  assert.equal(await revalidate(), false, 'the mid-crank balance drop is caught → next submission suppressed');
});

test('makeReadinessRevalidator over the REAL gate: a mid-crank PROGRAM revocation suppresses the next submission', async () => {
  // Not a mocked boolean — this wires the revalidator's `check` to the ACTUAL keeperReadiness gate,
  // EXACTLY as index.js does (`check: () => (await gate()).ok === true`), and flips the program account
  // to gone (null → program_not_found) mid-crank. Proves the live canSubmit guard re-runs the program
  // domain (not only genesis) once the TTL expires, and suppresses the next submission.
  let programOk = true;
  let t = 0;
  const gate = () => keeperReadiness({
    getGenesisHash: async () => GEN, expectedGenesis: GEN,
    getAccountInfo: async () => (programOk ? { executable: true } : null), // vanishes → program_not_found
    programId: 'PID',
    getBalance: async () => 3e8, minLamports: 1e8, warnLamports: 2e8, timeoutMs: 1000, now: () => t,
  });
  const revalidate = makeReadinessRevalidator({ check: async () => (await gate()).ok === true, now: () => t, ttlMs: 1500 });
  revalidate.markVerified(0); // gate fully passed at t=0 → first crank tx reuses it
  t = 500;
  assert.equal(await revalidate(), true, 'early tx: program still executable, within TTL');
  programOk = false; // MID-CRANK: the program account is closed/upgraded away
  t = 2000; // after the TTL → the full gate re-runs and re-checks the program
  assert.equal(await revalidate(), false, 'the mid-crank program revocation is caught → next submission suppressed');
});

// A BACKWARD wall-clock jump makes the cache age negative (still < ttlMs) — it must NOT reuse a stale
// verification; a negative age forces a fresh re-check.
test('makeReadinessRevalidator: a backward clock jump forces a re-check (no stale reuse)', async () => {
  let t = 1000;
  let checks = 0;
  const revalidate = makeReadinessRevalidator({ check: async () => { checks++; return true; }, now: () => t, ttlMs: 1500 });
  revalidate.markVerified(1000);
  t = 1200; // forward, within TTL → reuse, no check
  assert.equal(await revalidate(), true);
  assert.equal(checks, 0, 'a fresh forward age within TTL is reused');
  t = 500; // BACKWARD jump → age = -500 → must NOT reuse
  assert.equal(await revalidate(), true);
  assert.equal(checks, 1, 'a negative (backward-clock) age forces a fresh check, not stale reuse');
});

test('makeReadinessRevalidator.markVerified lets the first crank reuse the gate verification', async () => {
  let t = 1000;
  const revalidate = makeReadinessRevalidator({ check: async () => false, now: () => t, ttlMs: 1500 });
  revalidate.markVerified(1000); // the readiness gate just fully passed
  t = 2000; // within TTL → reuse, no RPC re-check
  assert.equal(await revalidate(), true);
  t = 2600; // TTL expired → full re-check (a domain now failing) → suppress
  assert.equal(await revalidate(), false);
});

test('validateKeeperKeypair: missing path / unreadable / invalid → FATAL; valid → ok', () => {
  assert.equal(validateKeeperKeypair(() => ({ publicKey: 'K' }), '').fatal, true);
  assert.equal(validateKeeperKeypair(() => { throw new Error('ENOENT'); }, '/k').reason, 'keypair_unreadable');
  assert.equal(validateKeeperKeypair(() => ({}), '/k').reason, 'keypair_invalid');
  const ok = validateKeeperKeypair(() => ({ publicKey: 'KEEPERpub' }), '/k');
  assert.equal(ok.ok, true);
  assert.equal(ok.cranker, 'KEEPERpub');
});

const GEN = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const OTHER = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';

test('classifyGenesis VERIFIED / MISMATCH / UNKNOWN', async () => {
  assert.equal((await classifyGenesis(() => Promise.resolve(GEN), GEN)).state, NET.VERIFIED);
  assert.equal((await classifyGenesis(() => Promise.resolve(OTHER), GEN)).state, NET.MISMATCH);
  assert.equal((await classifyGenesis(() => Promise.reject(new Error('timeout')), GEN)).state, NET.UNKNOWN);
  assert.equal((await classifyGenesis(() => Promise.reject(new Error('429')), GEN)).reason, 'rpc_rate_limited');
});
// A MALFORMED full-length value (invalid Base58 char, or valid Base58 that isn't 32 bytes) is NOT proof
// of a different cluster → UNKNOWN (transient/degraded), never a FATAL MISMATCH. Only a canonical 32-byte
// hash that differs is a real MISMATCH.
test('classifyGenesis: a malformed full-length genesis is UNKNOWN, never a fatal MISMATCH', async () => {
  for (const bad of ['O'.repeat(44), '1'.repeat(44), 'not-base58-!!!' + 'x'.repeat(30)]) {
    const r = await classifyGenesis(() => Promise.resolve(bad), GEN);
    assert.equal(r.state, NET.UNKNOWN, `${bad.slice(0, 8)}… → UNKNOWN`);
    assert.equal(r.reason, 'malformed_genesis_response');
  }
  // A canonical 32-byte value that differs is STILL a real MISMATCH.
  assert.equal((await classifyGenesis(() => Promise.resolve(OTHER), GEN)).state, NET.MISMATCH);
});

// Blocker 2: readiness RPCs must be TIMEOUT-BOUNDED — a never-settling call degrades, never hangs.
test('checkProgramAccount: a never-settling RPC → UNKNOWN within the timeout (not a hang)', async () => {
  const res = await checkProgramAccount(() => new Promise(() => {}), 'PID', { timeoutMs: 30 });
  assert.equal(res.state, NET.UNKNOWN);
  assert.equal(res.reason, 'rpc_timeout');
});

test('keeperReadiness: a never-settling balance RPC → degraded within the timeout (not a hang)', async () => {
  const g = await keeperReadiness({
    getGenesisHash: async () => GEN,
    expectedGenesis: GEN,
    getAccountInfo: async () => ({ executable: true }),
    programId: 'PID',
    getBalance: () => new Promise(() => {}), // never settles
    minLamports: 0, warnLamports: 0, timeoutMs: 30,
  });
  assert.equal(g.ok, false);
  assert.match(g.reason, /^balance_/);
});

// Blocker 1: genesisVerifiedAt is stamped BEFORE the (possibly slow) program/balance checks, so a slow
// gate cannot make a stale genesis look fresh to the revalidator's TTL.
test('keeperReadiness stamps genesisVerifiedAt at genesis time, not gate-return time', async () => {
  let clock = 1000;
  const g = await keeperReadiness({
    getGenesisHash: async () => GEN,
    expectedGenesis: GEN,
    getAccountInfo: async () => { clock = 9000; return { executable: true }; }, // "slow" program check advances the clock
    programId: 'PID',
    getBalance: async () => { clock = 12000; return 1e9; }, // "slow" balance check advances further
    minLamports: 0, warnLamports: 1, timeoutMs: 1000,
    now: () => clock,
  });
  assert.equal(g.ok, true);
  assert.equal(g.genesisVerifiedAt, 1000, 'stamped at genesis-verify time (1000), not the 12000 gate-return time');
});

test('checkProgramAccount ok / not_found / not_executable / UNKNOWN', async () => {
  assert.equal((await checkProgramAccount(() => Promise.resolve({ executable: true }), 'p')).ok, true);
  assert.equal((await checkProgramAccount(() => Promise.resolve(null), 'p')).reason, 'program_not_found');
  assert.equal((await checkProgramAccount(() => Promise.resolve({ executable: false }), 'p')).reason, 'program_not_executable');
  assert.equal((await checkProgramAccount(() => Promise.reject(new Error('timeout')), 'p')).state, NET.UNKNOWN);
});
// Parity with the notify guard: a malformed payload (esp. a TRUTHY non-boolean `executable`) must NOT
// read as a positive pass — `!!{executable:'yes'}.executable` used to be true. → UNKNOWN.
test('checkProgramAccount: a malformed payload → UNKNOWN (no truthy-non-boolean false-green)', async () => {
  // `undefined` is a malformed dependency response (NOT a definite miss) → UNKNOWN, unlike `null`.
  for (const bad of [undefined, {}, 42, 'x', true, { executable: 'yes' }]) {
    const r = await checkProgramAccount(() => Promise.resolve(bad), 'p', { requireExecutable: false });
    assert.equal(r.state, NET.UNKNOWN, `${String(bad)} → UNKNOWN`);
    assert.equal(r.reason, 'malformed_program_response');
    assert.notEqual(r.ok, true);
  }
  // null stays the DEFINITE "account not found" (Solana's real not-found result), distinct from undefined.
  assert.equal((await checkProgramAccount(() => Promise.resolve(null), 'p')).reason, 'program_not_found');
});

test('evaluateBalance min/warn', () => {
  assert.equal(evaluateBalance(5e7, { minLamports: 1e8, warnLamports: 2e8 }).ok, false); // below min
  assert.equal(evaluateBalance(1e8, { minLamports: 1e8, warnLamports: 2e8 }).ok, true); // exact min
  assert.equal(evaluateBalance(15e7, { minLamports: 1e8, warnLamports: 2e8 }).low, true); // warn
  assert.equal(evaluateBalance(3e8, { minLamports: 1e8, warnLamports: 2e8 }).low, false);
});

// FIX 4: an unreadable/garbage balance must be NOT-ready. Without the guard, `NaN < min` is false so it
// would fall through to ok:true with a NaN balance and let the keeper crank on an unverified balance.
test('evaluateBalance rejects undefined/NaN/Infinity/negative as not-ready', () => {
  const opts = { minLamports: 1e8, warnLamports: 2e8 };
  for (const bad of [NaN, undefined, -1, Infinity, -Infinity]) {
    const r = evaluateBalance(bad, opts);
    assert.equal(r.ok, false, `${bad} must be not-ready`);
    assert.equal(r.reason, 'balance_invalid');
    assert.equal(r.balanceSol, null);
  }
  assert.equal(evaluateBalance(3e8, opts).ok, true); // a normal in-range value is still ready
});

// withTimeout is the bound that makes tick()'s scan + diagnostic-balance reads unable to hang the
// scheduler. A never-settling promise must REJECT with a named TimeoutError within the bound, and the
// message must still contain "timeout" so reasonCode() maps it to 'rpc_timeout'.
test('withTimeout: a never-settling promise rejects with a named TimeoutError within the bound', async () => {
  const start = Date.now();
  await assert.rejects(
    () => withTimeout(new Promise(() => {}), 30, 'scan'),
    (e) => e.name === 'TimeoutError' && /timeout/.test(e.message),
  );
  assert.ok(Date.now() - start < 500, 'rejected promptly at the bound, did not hang');
});
test('withTimeout: a value that settles first passes through (no spurious timeout)', async () => {
  assert.equal(await withTimeout(Promise.resolve(42), 1000), 42);
});

test('nextBackoff bounded + capped', () => {
  assert.equal(nextBackoff(30, { baseMs: 1000, maxMs: 60000, rng: () => 1 }), 60000);
  const v = nextBackoff(2, { baseMs: 1000, maxMs: 60000, rng: () => 0 });
  assert.ok(v >= 1000 && v <= 60000);
});

// keeperReadiness composition
const base = {
  getGenesisHash: () => Promise.resolve(GEN),
  expectedGenesis: GEN,
  getAccountInfo: () => Promise.resolve({ executable: true }),
  programId: 'p',
  getBalance: () => Promise.resolve(3e8),
  minLamports: 1e8,
  warnLamports: 2e8,
};

test('keeperReadiness FATAL on genesis mismatch', async () => {
  const r = await keeperReadiness({ ...base, getGenesisHash: () => Promise.resolve(OTHER) });
  assert.equal(r.fatal, true);
  assert.equal(r.reason, 'genesis_mismatch');
});
test('keeperReadiness DEGRADED (no crank) on UNKNOWN network', async () => {
  const r = await keeperReadiness({ ...base, getGenesisHash: () => Promise.reject(new Error('timeout')) });
  assert.equal(r.ok, false);
  assert.equal(r.degraded, true);
  assert.match(r.reason, /network_/);
});
test('keeperReadiness FATAL on definite program failure', async () => {
  const r = await keeperReadiness({ ...base, getAccountInfo: () => Promise.resolve(null) });
  assert.equal(r.fatal, true);
  assert.equal(r.reason, 'program_not_found');
});
test('keeperReadiness DEGRADED on transient program error', async () => {
  const r = await keeperReadiness({ ...base, getAccountInfo: () => Promise.reject(new Error('timeout')) });
  assert.equal(r.degraded, true);
});
test('keeperReadiness DEGRADED (no crank) when balance below minimum', async () => {
  const r = await keeperReadiness({ ...base, getBalance: () => Promise.resolve(5e7) });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'balance_below_minimum');
});
test('keeperReadiness OK when verified + program executable + funded', async () => {
  const r = await keeperReadiness(base);
  assert.equal(r.ok, true);
  assert.equal(r.low, false);
});
test('keeperReadiness OK-but-low near warn threshold', async () => {
  const r = await keeperReadiness({ ...base, getBalance: () => Promise.resolve(15e7) });
  assert.equal(r.ok, true);
  assert.equal(r.low, true);
});
