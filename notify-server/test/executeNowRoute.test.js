// /execute-now route-wiring tests (Blocker 1). A pure helper test proved the guard throws when
// readiness is false — but the DEFECT was in the ROUTE: it called runExecutor(vault) with NO
// canSubmit, so the guard was a no-op regardless. These tests exercise the actual handler factory
// (the same one server.js mounts) to prove it hands the executor a LIVE guard reflecting
// readiness.executorReady, and that the entry gates 503 correctly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeExecuteNowHandler } from '../src/routes.js';

// Minimal express-style res double.
function fakeRes() {
  return {
    statusCode: 200,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}
const isPubkey = (s) => typeof s === 'string' && s.length >= 32;
const VALID = 'GXCu5964mvgAJDWmcMriZpzU3vDVqPzjYCM1sxCnsoEb';

test('route passes a LIVE canSubmit that tracks readiness.executorReady (not a constant true)', async () => {
  const readiness = { executorReady: true };
  let captured = null;
  const runExecutor = async (_vault, opts) => { captured = opts; return { action: 'cranked' }; };
  const handler = makeExecuteNowHandler({ readiness, executorReady: () => true, runExecutor, isPubkey });

  const res = fakeRes();
  await handler({ body: { vault: VALID } }, res);
  assert.equal(res.statusCode, 200);
  assert.ok(captured && typeof captured.canSubmit === 'function', 'runExecutor got a canSubmit function');
  // The guard is LIVE: flipping readiness after the call flips what canSubmit() reports.
  assert.equal(captured.canSubmit(), true);
  readiness.executorReady = false;
  assert.equal(captured.canSubmit(), false, 'canSubmit reflects readiness at call time, not a snapshot');
});

test('a mid-crank readiness revocation suppresses every later submission (real guard, real handler)', async () => {
  const readiness = { executorReady: true };
  const submitted = [];
  // runExecutor here is the REAL contract: it builds makeSubmitGuard-style checks from the passed
  // canSubmit and calls it before each step. We import the real guard to avoid re-implementing it.
  const { makeSubmitGuard, READINESS_REVOKED } = await import('../src/executor.js');
  const runExecutor = async (_vault, { canSubmit }) => {
    const guard = makeSubmitGuard(canSubmit);
    const steps = ['begin', 'ata', 'beginTokenDist', 'solShares', 'finalize'];
    try {
      for (const s of steps) {
        guard();
        submitted.push(s);
        if (s === 'begin') readiness.executorReady = false; // runtime MISMATCH clears it after tx 1
      }
    } catch (e) {
      if (e.message === READINESS_REVOKED) return { action: 'aborted_readiness_revoked' };
      throw e;
    }
    return { action: 'cranked' };
  };
  const handler = makeExecuteNowHandler({ readiness, executorReady: () => true, runExecutor, isPubkey });
  const res = fakeRes();
  await handler({ body: { vault: VALID } }, res);
  assert.deepEqual(submitted, ['begin'], 'only tx 1 ran; every later submission suppressed');
  // A readiness-aborted crank did NOT distribute — the route must report it as a FAILURE (503, ok:false),
  // not a success, so a caller can't mistake it for a completed crank.
  assert.equal(res.statusCode, 503, 'readiness-aborted execution → 503');
  assert.equal(res.body.ok, false, 'readiness-aborted execution is not ok');
  assert.equal(res.body.action, 'aborted_readiness_revoked');
});

test('entry gates: invalid pubkey → 400; executor unconfigured → 503; executor not ready → 503', async () => {
  const base = { runExecutor: async () => ({}), isPubkey };
  let r = fakeRes();
  await makeExecuteNowHandler({ ...base, readiness: { executorReady: true }, executorReady: () => true })({ body: { vault: 'x' } }, r);
  assert.equal(r.statusCode, 400);

  r = fakeRes();
  await makeExecuteNowHandler({ ...base, readiness: { executorReady: true }, executorReady: () => false })({ body: { vault: VALID } }, r);
  assert.equal(r.statusCode, 503);

  r = fakeRes();
  await makeExecuteNowHandler({ ...base, readiness: { executorReady: false }, executorReady: () => true })({ body: { vault: VALID } }, r);
  assert.equal(r.statusCode, 503, 'degraded/low-balance/MISMATCH executor is refused even via the manual trigger');
});

test('runExecutor throwing is redacted to a generic 500 (no raw error echoed)', async () => {
  const readiness = { executorReady: true };
  const runExecutor = async () => { throw new Error('rpc https://x.helius-rpc.com/?api-key=SECRET failed'); };
  let loggedInternally = false;
  const handler = makeExecuteNowHandler({
    readiness, executorReady: () => true, runExecutor, isPubkey,
    logError: () => { loggedInternally = true; },
  });
  const res = fakeRes();
  await handler({ body: { vault: VALID } }, res);
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.error, 'execution failed');
  assert.ok(!JSON.stringify(res.body).includes('api-key'), 'no raw error / api-key echoed to the client');
  assert.equal(loggedInternally, true, 'error is logged server-side, not returned');
});
