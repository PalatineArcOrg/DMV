// Keeper run-once orchestration (Blocker 3). The bug: tick() logged a scan failure and returned, then
// runOnce unconditionally returned true — so a scan outage looked like a completed pass (loop reset
// its backoff; `--once` exited 0). runKeeperOnce now returns TRUE only for a COMPLETED pass. These
// tests inject fake gate()/tick() and assert the decision table + that fatal calls exit().
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runKeeperOnce } from '../src/orchestrate.js';

const noExit = () => { throw new Error('exit() should not be called'); };

test('a completed pass returns true (loop keeps normal cadence; --once exits 0)', async () => {
  const ok = await runKeeperOnce({
    gate: async () => ({ ok: true, balanceSol: 1, low: false }),
    tick: async () => ({ ok: true, scanFailed: false, vaults: 3, due: 0 }),
    exit: noExit,
  });
  assert.equal(ok, true);
});

test('a SCAN FAILURE is NOT a completed pass → returns false (was the bug: reported success)', async () => {
  let live = false;
  const degraded = [];
  const ok = await runKeeperOnce({
    gate: async () => ({ ok: true, balanceSol: 1 }),
    tick: async () => ({ ok: false, scanFailed: true, reason: 'scan_failed' }),
    exit: noExit,
    setLive: (v) => { live = v; },
    onDegraded: (r) => degraded.push(r),
  });
  assert.equal(ok, false, 'scan failure must degrade, not report success');
  assert.equal(live, true, 'gate passed so cranking was enabled, but the scan still failed');
  assert.deepEqual(degraded, ['scan_failed']);
});

test('a mid-tick readiness revocation (halted) → returns false', async () => {
  const ok = await runKeeperOnce({
    gate: async () => ({ ok: true, balanceSol: 1 }),
    tick: async () => ({ ok: false, scanFailed: false, halted: true, reason: 'halted' }),
    exit: noExit,
  });
  assert.equal(ok, false);
});

test('a degraded gate → returns false and never ticks', async () => {
  let ticked = false;
  const ok = await runKeeperOnce({
    gate: async () => ({ ok: false, degraded: true, reason: 'network_rpc_timeout' }),
    tick: async () => { ticked = true; return { ok: true, scanFailed: false }; },
    exit: noExit,
  });
  assert.equal(ok, false);
  assert.equal(ticked, false, 'a degraded gate must not crank');
});

test('a FATAL gate calls exit() and returns false (never ticks)', async () => {
  let exited = null;
  let ticked = false;
  const ok = await runKeeperOnce({
    gate: async () => ({ fatal: true, reason: 'genesis_mismatch', net: {} }),
    tick: async () => { ticked = true; return { ok: true }; },
    exit: (g) => { exited = g.reason; },
  });
  assert.equal(exited, 'genesis_mismatch', 'a genesis MISMATCH exits (process.exit(1) in prod)');
  assert.equal(ticked, false);
  assert.equal(ok, false);
});
