// Keeper crank live-readiness guard (Blocker 2). The PR claimed "every transaction path checks
// readiness immediately before submission" but the keeper crank had NO guard. These tests drive the
// REAL crankVault against a fake Anchor program that records every .rpc(), proving: (1) canSubmit is
// MANDATORY (a missing guard throws before any submission); (2) once readiness is revoked mid-crank,
// the guard throws KEEPER_HALT and every LATER submission is suppressed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PublicKey } from '@solana/web3.js';
import { crankVault, KEEPER_HALT, classifyVaultError, isOperationalCrankError, isTransientScanError, makeKeeperGuard, getAccountInfoRetry } from '../src/crank.js';
import { withTimeout } from '../src/readiness.js';

const PROGRAM_ID = new PublicKey('GXCu5964mvgAJDWmcMriZpzU3vDVqPzjYCM1sxCnsoEb');
const KEEPER = new PublicKey('Vote111111111111111111111111111111111111111');
const VAULT = new PublicKey('So11111111111111111111111111111111111111112');
const BENEF = new PublicKey('11111111111111111111111111111111');

// A chainable Anchor-ix double whose .rpc() records the call and applies a state effect.
function makeProgram(rpcLog) {
  const state = { started: false, solPaid: false, completed: false };
  const execObj = () => ({ solPaidMask: state.solPaid ? 1 : 0, completed: state.completed, transferCount: 0 });
  const ix = (name, effect) => ({
    accountsPartial() { return this; },
    remainingAccounts() { return this; },
    preInstructions() { return this; },
    async rpc() { rpcLog.push(name); if (effect) effect(); return 'sig'; },
  });
  return {
    programId: PROGRAM_ID,
    account: {
      executionLog: {
        fetchNullable: async () => (state.started ? execObj() : null),
        fetch: async () => execObj(),
      },
      vaultConfig: {
        fetch: async () => ({ executed: state.completed, owner: KEEPER, beneficiaries: [{ wallet: BENEF, shareBps: 10000 }], hasAssetPlan: false, openTokenDists: 0 }),
      },
      assetPlan: { fetch: async () => ({ assignments: [], paidMask: 0 }) },
      tokenDist: { fetchNullable: async () => null },
    },
    methods: {
      beginExecution: () => ix('beginExecution', () => { state.started = true; }),
      executeSolShares: () => ix('executeSolShares', () => { state.solPaid = true; }),
      finalizeExecution: () => ix('finalizeExecution', () => { state.completed = true; }),
    },
  };
}

function makeCtx(rpcLog) {
  return {
    rpcUrl: undefined, // skip the Helius priority-fee fetch (falls through to the default)
    connection: {
      getRecentPrioritizationFees: async () => [],
      getParsedTokenAccountsByOwner: async () => ({ value: [] }), // no token mints
      getAccountInfo: async () => null,
    },
    keeper: { publicKey: KEEPER },
    provider: { sendAndConfirm: async () => 'sig' },
    program: makeProgram(rpcLog),
  };
}
const CFG = { beneficiaries: [{ wallet: BENEF, shareBps: 10000 }], hasAssetPlan: false, openTokenDists: 0 };

test('crankVault runs every submission while readiness stays true (positive control)', async () => {
  const rpcLog = [];
  const r = await crankVault(makeCtx(rpcLog), VAULT, CFG, { canSubmit: () => true });
  assert.deepEqual(rpcLog, ['beginExecution', 'executeSolShares', 'finalizeExecution']);
  assert.equal(r, 'executed');
});

test('a mid-crank readiness revocation suppresses every LATER submission', async () => {
  const rpcLog = [];
  // Allow exactly one guard() to pass (beginExecution), then revoke — the executeSolShares guard fails.
  let allowed = 1;
  const canSubmit = () => allowed-- > 0;
  await assert.rejects(
    () => crankVault(makeCtx(rpcLog), VAULT, CFG, { canSubmit }),
    (e) => e.message === KEEPER_HALT,
  );
  assert.deepEqual(rpcLog, ['beginExecution'], 'only tx 1 submitted; executeSolShares + finalize suppressed');
});

test('Blocker 5: classifyVaultError — HALT vs operational (skip) vs unknown (fatal)', () => {
  assert.equal(classifyVaultError(new Error(KEEPER_HALT)), 'halt');
  // Expected operational failures → skip this vault, continue.
  assert.equal(classifyVaultError(new Error('Transaction simulation failed: custom program error: 0x1')), 'skip');
  assert.equal(classifyVaultError(Object.assign(new Error('send failed'), { name: 'SendTransactionError', logs: ['Program log: x'] })), 'skip');
  assert.equal(classifyVaultError(new Error('429 Too Many Requests')), 'skip');
  assert.equal(classifyVaultError(new Error('fetch failed')), 'skip');
  assert.equal(classifyVaultError(new Error('CloseDelayNotElapsed')), 'skip');
  assert.equal(isOperationalCrankError(new Error('blockhash not found')), true);
  // Unknown / programming faults → fatal (rethrow to the process guard).
  assert.equal(classifyVaultError(new TypeError("Cannot read properties of undefined (reading 'toNumber')")), 'fatal');
  assert.equal(classifyVaultError(new ReferenceError('foo is not defined')), 'fatal');
  assert.equal(classifyVaultError(new Error('unexpected invariant violation')), 'fatal');
  assert.equal(isOperationalCrankError(new TypeError('x')), false);
});

test('Blocker 5: a programming error escapes the per-vault loop (fatal path); an operational one skips + continues', () => {
  // Faithful reproduction of tick()'s per-vault decision, driven by the REAL classifyVaultError: an
  // operational error skips its vault and continues; a programming error rethrows and stops the loop.
  const vaults = [
    { id: 'a', err: new Error('429 rate limit') },       // operational → skip
    { id: 'b', err: new TypeError('decoded state bug') }, // programming → fatal → escapes
    { id: 'c', err: null },                               // never reached
  ];
  const reached = [];
  let escaped = null;
  try {
    for (const v of vaults) {
      reached.push(v.id);
      try { if (v.err) throw v.err; }
      catch (e) {
        const d = classifyVaultError(e);
        if (d === 'halt') break;
        if (d === 'fatal') throw e; // escape the loop → fatal guard in production
        // 'skip' → continue to the next vault
      }
    }
  } catch (e) { escaped = e; }
  assert.equal(escaped, vaults[1].err, 'the programming error escaped');
  assert.deepEqual(reached, ['a', 'b'], 'the loop stopped at b; c was never processed');
});

test('FIX 3: makeKeeperGuard converts a throwing/rejecting/false/missing canSubmit into KEEPER_HALT', async () => {
  // A throwing or rejecting canSubmit must NOT escape as its own arbitrary error (a token catch could
  // then misclassify it as operational/stuck instead of aborting the crank). Every failure mode → HALT.
  await assert.rejects(makeKeeperGuard(async () => { throw new Error('boom'); })(), (e) => e.message === KEEPER_HALT);
  await assert.rejects(makeKeeperGuard(() => Promise.reject(new Error('rejected')))(), (e) => e.message === KEEPER_HALT);
  await assert.rejects(makeKeeperGuard(() => false)(), (e) => e.message === KEEPER_HALT);
  await assert.rejects(makeKeeperGuard(undefined)(), (e) => e.message === KEEPER_HALT);
  await assert.doesNotReject(makeKeeperGuard(async () => true)()); // still-verified → resolves (may submit)
});

// FIX 2: index.js tick() wraps scanVaults() in `catch (e) { if (!isOperationalCrankError(e)) throw e; ...
// degrade }`. This asserts the exact classification contract that catch relies on: a coder fault must
// escape to the process fatal guard; only a recognized operational RPC failure is masked as a transient
// scan blip.
// #1 (full pass-deadline): tick()'s per-vault catch degrades the WHOLE tick on a bounded-read
// TimeoutError (a hung dependency / pass deadline) instead of skip-and-continuing — otherwise every
// remaining vault would grind into the same wall (~one deadline each). This faithfully reproduces the
// catch's decision, driven by the REAL classifyVaultError for the non-timeout branches.
test('#1: a pass-deadline TimeoutError degrades the whole tick (does not skip-and-continue)', () => {
  const vaults = [
    { id: 'a', err: new Error('429 rate limit') },                                        // operational → skip
    { id: 'b', err: Object.assign(new Error('timeout: executionLog'), { name: 'TimeoutError' }) }, // deadline → DEGRADE + break
    { id: 'c', err: null },                                                               // never reached
  ];
  const reached = [];
  let deadlineHit = false, halted = false, escaped = null;
  try {
    for (const v of vaults) {
      reached.push(v.id);
      try { if (v.err) throw v.err; }
      catch (e) {
        if (e?.name === 'TimeoutError') { deadlineHit = true; break; } // tick's FIRST check
        const d = classifyVaultError(e);
        if (d === 'halt') { halted = true; break; }
        if (d === 'fatal') throw e;
        // 'skip' → continue
      }
    }
  } catch (e) { escaped = e; }
  assert.equal(deadlineHit, true, 'the TimeoutError degraded the tick');
  assert.equal(escaped, null);
  assert.deepEqual(reached, ['a', 'b'], 'skipped a, degraded at b, never processed c (no grind through all vaults)');
});

test('FIX 2: scan-fault classification — coder fault is non-operational (fatal), RPC blip is operational (degrade)', () => {
  assert.equal(isOperationalCrankError(new TypeError('Cannot read properties of undefined')), false);
  assert.equal(isOperationalCrankError(new ReferenceError('x is not defined')), false);
  assert.equal(isOperationalCrankError(new Error('429 Too Many Requests')), true);
  assert.equal(isOperationalCrankError(new Error('fetch failed')), true);
  assert.equal(isOperationalCrankError(Object.assign(new Error('getProgramAccounts failed'), { logs: [] })), true);
});

test('network TypeError (unreachable RPC) is OPERATIONAL; exact-word programming faults stay FATAL', () => {
  // A real unreachable RPC — Node's TypeError('fetch failed'), possibly with a transport cause.code —
  // must be OPERATIONAL (degrade + retry), not misclassified as fatal.
  assert.equal(isOperationalCrankError(new TypeError('fetch failed')), true);
  assert.equal(isOperationalCrankError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })), true);
  assert.equal(isOperationalCrankError(Object.assign(new TypeError('boom'), { cause: { code: 'ETIMEDOUT' } })), true); // explicit transport code
  assert.equal(isOperationalCrankError(Object.assign(new Error('x'), { code: 'ENOTFOUND' })), true);
  // ...but a native programming error whose message/property name merely CONTAINS a transport word must
  // stay FATAL (the fail-closed invariant). Generic words are only matched for ordinary Error objects.
  assert.equal(isOperationalCrankError(new ReferenceError('network is not defined')), false);
  assert.equal(isOperationalCrankError(new TypeError("Cannot read properties of undefined (reading 'socket')")), false);
  assert.equal(isOperationalCrankError(new TypeError("Cannot read properties of undefined (reading 'timeout')")), false);
  assert.equal(isOperationalCrankError(new TypeError('Cannot read properties of undefined')), false);
});

// Blocker (this round): the classifier must NOT substring-match generic keywords. An ordinary Error
// whose message merely CONTAINS `transaction` / `instruction`, or a NON-EXACT `fetch failed` phrase, is
// a programming/coder fault and must stay FATAL (fail-closed) — otherwise it is swallowed as a skippable
// vault and the coder bug never surfaces.
test('classifier does NOT false-positive on builder/invariant/assertion messages or non-exact fetch wording', () => {
  // Previously matched the bare word `transaction` → wrongly operational.
  assert.equal(isOperationalCrankError(new Error('transaction builder invariant violated')), false);
  assert.equal(classifyVaultError(new Error('transaction builder invariant violated')), 'fatal');
  // Previously matched the bare word `instruction` → wrongly operational.
  assert.equal(isOperationalCrankError(new Error('instruction construction assertion failed')), false);
  assert.equal(classifyVaultError(new Error('instruction construction assertion failed')), 'fatal');
  // Non-exact `fetch failed` — a substring, not Node's exact transport message → must stay FATAL.
  assert.equal(isOperationalCrankError(new Error('unexpected fetch failed validation state')), false);
  assert.equal(classifyVaultError(new Error('unexpected fetch failed validation state')), 'fatal');
  // Regression guards: the SPECIFIC operational shapes that share those roots still classify operational.
  assert.equal(isOperationalCrankError(new Error('Transaction simulation failed: custom program error: 0x1')), true);
  assert.equal(isOperationalCrankError(new Error('fetch failed')), true); // exact → operational
  assert.equal(isOperationalCrankError(new Error('blockhash not found')), true);
  // web3.js's real duplicate-tx phrasing ("…already been processed") stays operational even as a bare
  // string (it used to ride on the removed bare `transaction` word).
  assert.equal(isOperationalCrankError(new Error('This transaction has already been processed')), true);
  // Round-N: the bare `rpc` / `signature` / `insufficient` words are gone too — a coder fault whose
  // message merely contains them stays FATAL; only concrete shapes are operational.
  assert.equal(isOperationalCrankError(new Error('RPC response decoder invariant violated')), false);
  assert.equal(isOperationalCrankError(new Error('signature scheme not implemented')), false);
  assert.equal(isOperationalCrankError(new Error('insufficient assignments decoded from state')), false);
  assert.equal(isOperationalCrankError(new Error('insufficient funds for rent')), true);       // concrete → operational
  assert.equal(isOperationalCrankError(new Error('signature verification failed')), true);     // concrete → operational
  // web3.js TransactionExpiredBlockheightExceededError — a routine congestion-time confirmation timeout.
  // It used to ride on the removed bare `signature` word; `block height exceeded` keeps it OPERATIONAL so
  // it degrades/retries instead of crashing the keeper.
  assert.equal(isOperationalCrankError(new Error('Signature 5xy has expired: block height exceeded.')), true);
  // Bare `blockhash` / `simulat` stems were REPLACED with concrete phrases: an invariant/coder fault that
  // merely CONTAINS those stems must stay FATAL, while the real RPC messages stay operational.
  assert.equal(isOperationalCrankError(new Error('blockhash cache invariant violated')), false);
  assert.equal(isOperationalCrankError(new Error('simulation decoder invariant violated')), false);
  assert.equal(isOperationalCrankError(new Error('blockhash not found')), true);
  assert.equal(isOperationalCrankError(new Error('Transaction simulation failed: custom program error: 0x1')), true);
});

// Round-N: a BOUNDED per-vault RPC timeout (withTimeout → TimeoutError, e.g. the heartbeat fetch) must
// be classified 'skip' (operational vault failure), NOT 'fatal' — otherwise a hung heartbeat RPC would
// crash the keeper instead of skipping that vault.
test('classifyVaultError: a per-vault TimeoutError is skip (operational), not fatal', () => {
  assert.equal(classifyVaultError(Object.assign(new Error('timeout: heartbeat'), { name: 'TimeoutError' })), 'skip');
  assert.equal(classifyVaultError(new TypeError('coder bug')), 'fatal'); // control: a real coder fault still escapes
});

// A withTimeout-produced TimeoutError (bounded scan / heartbeat / account-info / ATA lookup) is
// operational everywhere — recognised by name so a bounded RPC hang degrades/retries (e.g. the now-bound
// ensureAta lookup, whose timeout must be caught as a stuck mint, not escape to the fatal guard).
test('isOperationalCrankError: a named TimeoutError is operational (bounded RPC timeout)', () => {
  assert.equal(isOperationalCrankError(Object.assign(new Error('timeout: ata-lookup'), { name: 'TimeoutError' })), true);
  assert.equal(isOperationalCrankError(Object.assign(new Error('timeout: heartbeat'), { name: 'TimeoutError' })), true);
  // A plain Error whose message merely contains "timeout" is NOT operational (only the explicit name is).
  assert.equal(isOperationalCrankError(new Error('timeout configuration invalid')), false);
});

// isTransientScanError (used by tick's scan-timeout catch): a bounded scan HANG (withTimeout →
// TimeoutError) is transient like any operational RPC error; a coder fault is NOT.
test('isTransientScanError: TimeoutError + operational RPC errors are transient; coder faults are not', () => {
  assert.equal(isTransientScanError(Object.assign(new Error('timeout: scan'), { name: 'TimeoutError' })), true);
  assert.equal(isTransientScanError(new Error('fetch failed')), true);
  assert.equal(isTransientScanError(new Error('429 Too Many Requests')), true);
  assert.equal(isTransientScanError(new TypeError('Cannot read properties of undefined')), false);
  assert.equal(isTransientScanError(new ReferenceError('x is not defined')), false);
});

// Blocker (this round): tick()'s two direct RPC reads (the vault scan + the end-of-tick diagnostic
// balance) must be TIMEOUT-BOUNDED so a never-settling call cannot wedge the scheduler. index.js
// self-executes (can't be imported), so this faithfully REPRODUCES tick's scan+balance timeout
// composition with the REAL withTimeout + isTransientScanError, driving never-settling thunks and
// proving the pass RETURNS (a degraded scan result / a '?' balance) rather than hanging forever.
test('tick timeout composition: a never-settling scan RETURNS a transient degrade (does not hang)', async () => {
  const SCAN_MS = 40;
  const scanNeverSettles = () => new Promise(() => {}); // simulates a hung getProgramAccounts
  let result;
  try {
    await withTimeout(scanNeverSettles(), SCAN_MS, 'scan');
    result = { ok: true }; // unreachable
  } catch (e) {
    // tick's exact catch logic: a coder fault escapes; a TimeoutError / operational error degrades.
    if (!isTransientScanError(e)) throw e;
    result = { ok: false, scanFailed: true, reason: e?.name === 'TimeoutError' ? 'scan_timeout' : 'scan_failed' };
  }
  assert.deepEqual(result, { ok: false, scanFailed: true, reason: 'scan_timeout' }, 'the hung scan degraded this tick instead of hanging');
});

test('tick timeout composition: a never-settling diagnostic balance falls back to best-effort (does not hang)', async () => {
  const BAL_MS = 40;
  const balNeverSettles = () => new Promise(() => {}); // simulates a hung getBalance
  let balStr = '?';
  try {
    balStr = ((await withTimeout(balNeverSettles(), BAL_MS, 'balance')) / 1e9).toFixed(4);
  } catch {
    /* best-effort — a hung balance lookup must never wedge the tick */
  }
  assert.equal(balStr, '?', 'the hung balance lookup left the best-effort placeholder and the pass completed');
});

// Blocker (this round): each getAccountInfo attempt must be TIMEOUT-BOUNDED — a never-settling RPC
// would otherwise hang the retry loop forever (no retry, no backoff) and wedge the whole scheduler.
test('getAccountInfoRetry: a never-settling RPC is bounded per attempt and RETURNS (does not hang)', async () => {
  let calls = 0;
  const connection = { getAccountInfo: () => { calls += 1; return new Promise(() => {}); } }; // never settles
  const start = Date.now();
  const r = await getAccountInfoRetry(connection, 'PID', 2, 25); // 2 tries, 25ms bound each
  assert.equal(r, null, 'a permanently-hung lookup returns null after its bounded retries');
  assert.equal(calls, 2, 'each attempt was made and timed out (not a single unbounded hang)');
  assert.ok(Date.now() - start < 1000, 'bounded — did not hang');
});

test('getAccountInfoRetry: a fast successful read returns the account without waiting', async () => {
  const acc = { executable: true };
  const r = await getAccountInfoRetry({ getAccountInfo: async () => acc }, 'PID', 4, 5000);
  assert.equal(r, acc);
});

test('getAccountInfoRetry: a native programming fault ESCAPES (not retried away)', async () => {
  const connection = { getAccountInfo: () => { throw new TypeError('coder bug'); } };
  await assert.rejects(() => getAccountInfoRetry(connection, 'PID', 3, 5000), (e) => e instanceof TypeError);
});

test('canSubmit is MANDATORY — a missing guard throws before any submission (fail-closed wiring)', async () => {
  const rpcLog = [];
  await assert.rejects(
    () => crankVault(makeCtx(rpcLog), VAULT, CFG), // no opts → no canSubmit
    /requires a canSubmit/,
  );
  assert.deepEqual(rpcLog, [], 'no transaction submitted without a readiness guard');
});

test('crankVault awaits the async guard before each tx, so a revocation while a tx is in flight halts the next', async () => {
  // This proves crankVault's SUBMISSION WIRING: it `await`s the guard before every .rpc(), so an async
  // canSubmit that has become false mid-crank suppresses the next submission. (The production TTL/cache
  // policy of the real canSubmit — makeReadinessRevalidator — is tested separately in readiness.test.js;
  // here canSubmit re-evaluates every call to isolate the crank-side wiring.)
  let net = 'VERIFIED';
  const canSubmit = async () => {
    // the same shape as revalidate(): an awaited genesis classification drives the boolean
    await Promise.resolve();
    return net === 'VERIFIED';
  };

  const rpcLog = [];
  let releaseFirst;
  const firstHeld = new Promise((r) => { releaseFirst = r; });
  // Deterministic "beginExecution.rpc() entered" signal — resolved from INSIDE the held rpc, so the
  // test flips the network only once the crank has genuinely reached the in-flight tx. Replaces a
  // fixed sleep (which could elapse before the async crank got there on a busy CI runner → flaky).
  let signalEntered;
  const entered = new Promise((r) => { signalEntered = r; });
  const state = { started: false };
  const ix = (name, effect, hold) => ({
    accountsPartial() { return this; }, remainingAccounts() { return this; }, preInstructions() { return this; },
    async rpc() { rpcLog.push(name); if (effect) effect(); if (hold) { signalEntered(); await hold; } return 'sig'; },
  });
  const ctx = {
    rpcUrl: undefined,
    connection: { getRecentPrioritizationFees: async () => [], getParsedTokenAccountsByOwner: async () => ({ value: [] }), getAccountInfo: async () => null },
    keeper: { publicKey: KEEPER },
    provider: { sendAndConfirm: async () => 'sig' },
    program: {
      programId: PROGRAM_ID,
      account: {
        executionLog: {
          fetchNullable: async () => (state.started ? { solPaidMask: 0, completed: false } : null),
          fetch: async () => ({ solPaidMask: 0, completed: false }),
        },
        vaultConfig: { fetch: async () => ({ executed: false, owner: KEEPER, beneficiaries: [{ wallet: BENEF, shareBps: 10000 }], hasAssetPlan: false, openTokenDists: 0 }) },
        assetPlan: { fetch: async () => ({ assignments: [], paidMask: 0 }) },
        tokenDist: { fetchNullable: async () => null },
      },
      methods: {
        beginExecution: () => ix('beginExecution', () => { state.started = true; }, firstHeld), // held open
        executeSolShares: () => ix('executeSolShares'),
        finalizeExecution: () => ix('finalizeExecution'),
      },
    },
  };

  const crankPromise = crankVault(ctx, VAULT, CFG, { canSubmit });
  // Wait deterministically until beginExecution.rpc() has been ENTERED (now awaiting firstHeld), then
  // flip the network — no timing assumption.
  await entered;
  assert.deepEqual(rpcLog, ['beginExecution'], 'first tx entered while still VERIFIED');
  net = 'MISMATCH'; // cluster switches DURING the in-flight beginExecution
  releaseFirst();

  await assert.rejects(() => crankPromise, (e) => e.message === KEEPER_HALT);
  assert.deepEqual(rpcLog, ['beginExecution'], 'the mid-crank change suppressed executeSolShares');
});
