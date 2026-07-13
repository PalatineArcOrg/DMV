// Executor in-flight readiness guard (Phase 2, Blocker 4). runExecutorInner routes EVERY submission
// (including ATA creation) through makeSubmitGuard(canSubmit); if readiness is revoked mid-crank the
// guard throws READINESS_REVOKED and the remaining submissions are suppressed. This exercises that
// exact mechanism against a simulated multi-step crank.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSubmitGuard, READINESS_REVOKED } from '../src/executor.js';

test('multi-step crank aborts every submission after readiness is revoked mid-run', async () => {
  let verified = true; // network VERIFIED / executorReady
  const guard = makeSubmitGuard(() => verified);
  const submitted = [];
  // Each step guards, then "submits". The FIRST submission flips readiness to MISMATCH.
  const step = async (name) => {
    guard();
    submitted.push(name);
    if (name === 'begin') verified = false; // runtime MISMATCH clears executorReady after the 1st tx
  };
  const steps = ['begin', 'ata', 'beginTokenDist', 'specificSol', 'specificAsset', 'solShares', 'finalize', 'tokenShares', 'closeTokenDist'];
  let aborted = false;
  try {
    for (const s of steps) await step(s);
  } catch (e) {
    if (e.message === READINESS_REVOKED) aborted = true;
  }
  assert.equal(aborted, true, 'crank aborts once readiness is revoked');
  assert.deepEqual(submitted, ['begin'], 'only the first submission ran; every later one suppressed');
});

test('guard allows all submissions while readiness stays true', () => {
  const guard = makeSubmitGuard(() => true);
  assert.doesNotThrow(() => guard());
  assert.doesNotThrow(() => guard());
});

test('guard with no canSubmit is FAIL-CLOSED (throws), not a permissive no-op', () => {
  // Blocker 1: an omitted guard must NEVER degrade to "always submit". A missing canSubmit throws
  // exactly like a revoked one, so a caller that forgets to wire the guard cannot crank unguarded.
  assert.throws(() => makeSubmitGuard(undefined)(), (e) => e.message === READINESS_REVOKED);
  assert.throws(() => makeSubmitGuard(null)(), (e) => e.message === READINESS_REVOKED);
  assert.throws(() => makeSubmitGuard('nope')(), (e) => e.message === READINESS_REVOKED);
});

// FIX 2: an ASYNC canSubmit returns a Promise (a thenable = truthy) that this synchronous guard cannot
// await. Without an explicit thenable check the guard would treat the pending Promise as "ok" and submit
// even when it would ultimately resolve FALSE. Both a would-resolve-true and a would-resolve-false async
// guard must FAIL CLOSED (throw READINESS_REVOKED) rather than pass on the Promise object being truthy.
test('FIX 2: an async canSubmit (Promise) is FAIL-CLOSED — throws READINESS_REVOKED (would-resolve-true)', () => {
  const guard = makeSubmitGuard(async () => true);
  assert.throws(() => guard(), (e) => e.message === READINESS_REVOKED);
});

test('FIX 2: an async canSubmit (Promise) is FAIL-CLOSED — throws READINESS_REVOKED (would-resolve-false)', () => {
  const guard = makeSubmitGuard(() => Promise.resolve(false));
  assert.throws(() => guard(), (e) => e.message === READINESS_REVOKED);
});
