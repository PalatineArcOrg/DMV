// WP4 transition-controller tests (§13): at-cutoff expiry, one-way latch,
// signed-always-enabled, backward-clock no-reopen, restart-after-expiry, exactly-
// once onFirstExpiry, non-negative seconds, non-dual fixed state. Injected clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTransitionController } from '../src/transitionState.js';

const CUT = 1780000000;
function clock(start) {
  let t = start;
  const now = () => t;
  now.set = (v) => { t = v; };
  return now;
}

test('before cutoff: effective dual, legacy accepted, seconds counting down', () => {
  const now = clock(CUT - 100);
  const c = makeTransitionController({ mode: 'dual', legacyAcceptUntil: CUT, now });
  const s = c.get();
  assert.equal(s.effectiveMode, 'dual');
  assert.equal(s.legacyAccepting, true);
  assert.equal(s.legacyWindowExpired, false);
  assert.equal(s.secondsUntilLegacyClose, 100);
});
test('one second before cutoff: still accepted', () => {
  const c = makeTransitionController({ mode: 'dual', legacyAcceptUntil: CUT, now: clock(CUT - 1) });
  assert.equal(c.get().legacyAccepting, true);
  assert.equal(c.get().secondsUntilLegacyClose, 1);
});
test('exactly at cutoff: expired, effective signed, legacy rejected', () => {
  const c = makeTransitionController({ mode: 'dual', legacyAcceptUntil: CUT, now: clock(CUT) });
  const s = c.get();
  assert.equal(s.legacyAccepting, false);
  assert.equal(s.effectiveMode, 'signed');
  assert.equal(s.legacyWindowExpired, true);
  assert.equal(s.secondsUntilLegacyClose, 0);
});
test('after cutoff: effective signed', () => {
  const c = makeTransitionController({ mode: 'dual', legacyAcceptUntil: CUT, now: clock(CUT + 5000) });
  assert.equal(c.get().effectiveMode, 'signed');
  assert.equal(c.get().legacyAccepting, false);
});
test('backward clock after observed expiry does NOT reopen the window', () => {
  const now = clock(CUT + 10);
  const c = makeTransitionController({ mode: 'dual', legacyAcceptUntil: CUT, now });
  assert.equal(c.get().legacyAccepting, false); // observe expiry (latch)
  now.set(CUT - 100); // clock jumps backward before the cutoff
  const s = c.get();
  assert.equal(s.legacyAccepting, false, 'latched closed');
  assert.equal(s.legacyWindowExpired, true);
  assert.equal(s.secondsUntilLegacyClose, 0);
});
test('onFirstExpiry fires exactly once', () => {
  const now = clock(CUT - 5);
  let calls = 0; let seenTs = null;
  const c = makeTransitionController({ mode: 'dual', legacyAcceptUntil: CUT, now, onFirstExpiry: (ts) => { calls += 1; seenTs = ts; } });
  c.get(); // before → no fire
  assert.equal(calls, 0);
  now.set(CUT + 1);
  c.get(); c.get(); c.get(); // observe + repeat
  assert.equal(calls, 1);
  assert.equal(seenTs, CUT + 1);
  assert.equal(c.firstExpiryAt(), CUT + 1);
});
test('restart-style controller created after cutoff starts signed-effective', () => {
  let fired = 0;
  const c = makeTransitionController({ mode: 'dual', legacyAcceptUntil: CUT, now: clock(CUT + 999999), onFirstExpiry: () => { fired += 1; } });
  const s = c.get();
  assert.equal(s.effectiveMode, 'signed');
  assert.equal(s.legacyAccepting, false);
  assert.equal(s.legacyWindowExpired, true);
  assert.equal(fired, 1); // observed on first get()
});
test('secondsUntilLegacyClose never negative', () => {
  const c = makeTransitionController({ mode: 'dual', legacyAcceptUntil: CUT, now: clock(CUT + 10_000) });
  assert.equal(c.get().secondsUntilLegacyClose, 0);
});
test('non-dual modes return consistent fixed state', () => {
  const signed = makeTransitionController({ mode: 'signed', legacyAcceptUntil: null, now: clock(CUT) });
  assert.deepEqual(signed.get(), {
    configuredMode: 'signed', effectiveMode: 'signed', legacyAccepting: false,
    legacyAcceptUntil: null, legacyWindowExpired: false, secondsUntilLegacyClose: 0,
  });
  const legacy = makeTransitionController({ mode: 'legacy', legacyAcceptUntil: null, now: clock(CUT) });
  const ls = legacy.get();
  assert.equal(ls.effectiveMode, 'legacy');
  assert.equal(ls.legacyAccepting, true);
  assert.equal(ls.legacyWindowExpired, false);
});
