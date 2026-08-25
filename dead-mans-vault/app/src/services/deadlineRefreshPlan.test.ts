import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PublicKey } from '@solana/web3.js';
import {
  deadlineRefreshPlan,
  projectAuthoritativeDeadline,
  DEADLINE_REFRESH_NEAR_MS,
  DEADLINE_REFRESH_MID_MS,
  DEADLINE_REFRESH_FAR_MS,
  type AuthoritativeDeadlineSnapshot,
} from './OnChainDeadlineService.ts';

// A fixed 30s deadline poll cost ~480 RPC calls/hour per foregrounded Dashboard,
// enough to get the app throttled on a shared key while watching a clock whose next
// event may be a week away. The cadence now scales with remaining margin.
//
// The safety requirement is unchanged and is asserted here at the WIDEST cadence:
// a projection may never enter Stage 4, and crossing the final deadline must force a
// fresh read regardless of how long the window is.

test('cadence widens with margin and tightens near the deadline', () => {
  assert.equal(deadlineRefreshPlan(60).intervalMs, DEADLINE_REFRESH_NEAR_MS);
  assert.equal(deadlineRefreshPlan(3_600).intervalMs, DEADLINE_REFRESH_NEAR_MS);
  assert.equal(deadlineRefreshPlan(3_601).intervalMs, DEADLINE_REFRESH_MID_MS);
  assert.equal(deadlineRefreshPlan(86_400).intervalMs, DEADLINE_REFRESH_MID_MS);
  assert.equal(deadlineRefreshPlan(86_401).intervalMs, DEADLINE_REFRESH_FAR_MS);
  assert.equal(deadlineRefreshPlan(30 * 86_400).intervalMs, DEADLINE_REFRESH_FAR_MS);
});

test('unknown or nonsense margin keeps the TIGHTEST cadence — backing off is never the fallback', () => {
  for (const v of [null, undefined, NaN, Infinity, -1, -86_400] as const) {
    assert.equal(
      deadlineRefreshPlan(v as never).intervalMs,
      DEADLINE_REFRESH_NEAR_MS,
      `margin ${String(v)} must not widen the cadence`,
    );
  }
});

test('freshness window matches the interval, so a widened poll cannot strand the UI as stale', () => {
  for (const s of [60, 3_600, 7_200, 86_400, 200_000]) {
    const p = deadlineRefreshPlan(s);
    assert.ok(
      p.freshnessWindowMs >= p.intervalMs,
      `window ${p.freshnessWindowMs} must cover interval ${p.intervalMs}`,
    );
  }
});

function snapshot(secondsUntilFinalDeadline: number): AuthoritativeDeadlineSnapshot {
  const now = 1_800_000_000;
  const key = new PublicKey('GXCu5964mvgAJDWmcMriZpzU3vDVqPzjYCM1sxCnsoEb');
  return {
    cluster: 'devnet', programId: key.toBase58(),
    owner: key, vault: key, heartbeat: key,
    slot: 1, chainUnixTime: now,
    lastHeartbeat: now - 1000, lastMethod: 0, totalHeartbeats: 1n,
    heartbeatInterval: 604_800, gracePeriod: 1_468_800,
    nextDue: now + 100, stage1End: now + 200, stage2End: now + 300,
    finalDeadline: now + secondsUntilFinalDeadline,
    secondsUntilDue: 100, secondsOverdue: 0,
    secondsUntilFinalDeadline,
    stage: 0, executableByTime: false,
    observedAtMonotonicMs: 1_000,
  };
}

test('SAFETY: at the widest window a projection still cannot enter Stage 4', () => {
  const s = snapshot(200_000);
  const { freshnessWindowMs } = deadlineRefreshPlan(s.secondsUntilFinalDeadline);
  // Project far enough forward to cross the final deadline, inside the window.
  const crossing = snapshot(10);
  const r = projectAuthoritativeDeadline(crossing, 1_000 + 60_000, freshnessWindowMs);
  assert.equal(r.status, 'stage4_refresh_required',
    'crossing the deadline must force a fresh read, never a projected Stage 4');
});

test('SAFETY: projected snapshots are never executableByTime, at any window', () => {
  const s = snapshot(200_000);
  const { freshnessWindowMs } = deadlineRefreshPlan(s.secondsUntilFinalDeadline);
  const r = projectAuthoritativeDeadline(s, 1_000 + 120_000, freshnessWindowMs);
  assert.equal(r.status, 'verified_projected');
  if (r.status === 'verified_projected') {
    assert.equal(r.snapshot.executableByTime, false);
    assert.notEqual(r.snapshot.stage, 4);
  }
});

test('a projection beyond its window is still reported stale, not silently trusted', () => {
  const s = snapshot(200_000);
  const { freshnessWindowMs } = deadlineRefreshPlan(s.secondsUntilFinalDeadline);
  const r = projectAuthoritativeDeadline(s, 1_000 + freshnessWindowMs + 1_000, freshnessWindowMs);
  assert.equal(r.status, 'stale');
});
