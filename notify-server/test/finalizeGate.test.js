// Regression guard for the v1.13.3 executor finalize-gate bug.
//
// The bug: after paying the LAST specific bequest in the same run, the in-memory
// `plan.paidMask` still held the PRE-payment value. Feeding that stale mask into the
// finalize gate made `planFull` false, so finalize was wrongly skipped — the run
// aborted one step from done and the close loop then tripped VaultNotExecuted.
//
// The fix re-fetches BOTH masks fresh right before the gate. `shouldFinalize` is the
// extracted, pure decision; these tests pin the contract that a FRESH full mask
// finalizes even in the exact case where the STALE mask would not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldFinalize } from '../src/executor.js';

// The on-chain u64 `plan.paidMask` arrives as a BN-like object (has toString()),
// not a JS number; `bigMask()` handles both. Exercise both shapes.
const bn = (n) => ({ toString: () => String(n) });

test('both SOL + plan masks full → finalize', () => {
  assert.equal(
    shouldFinalize({ completed: false, solPaidMask: 0b11, planPaidMask: 0b11, benCount: 2, hasPlan: true, assignmentCount: 2 }),
    true,
  );
});

test('v1.13.3: a FRESH full plan mask finalizes even though the STALE mask would not', () => {
  // Same vault: SOL fully paid (2 beneficiaries), plan has 2 specific assignments.
  const base = { completed: false, solPaidMask: 0b11, benCount: 2, hasPlan: true, assignmentCount: 2 };
  // BUG shape — in-memory plan.paidMask still pre-payment (only bit 0 set): the gate
  // must evaluate this as "not finalizable", which is exactly why feeding it here
  // (without the re-fetch) silently stalled the run.
  assert.equal(
    shouldFinalize({ ...base, planPaidMask: 0b01 }),
    false,
    'stale/pre-payment mask must NOT finalize — this is the bug the re-fetch avoids',
  );
  // FIX shape — the handler re-fetches, so the fresh mask has both bits set: MUST finalize.
  assert.equal(
    shouldFinalize({ ...base, planPaidMask: 0b11 }),
    true,
    'fresh full plan mask MUST finalize',
  );
  // ...and with the real BN-shaped mask the production code actually passes.
  assert.equal(
    shouldFinalize({ ...base, planPaidMask: bn(0b11) }),
    true,
    'fresh full BN-shaped plan mask MUST finalize',
  );
});

test('already completed → never re-finalize', () => {
  assert.equal(
    shouldFinalize({ completed: true, solPaidMask: 0b11, planPaidMask: 0b11, benCount: 2, hasPlan: true, assignmentCount: 2 }),
    false,
  );
});

test('SOL mask not yet full → wait', () => {
  assert.equal(
    shouldFinalize({ completed: false, solPaidMask: 0b01, planPaidMask: 0b11, benCount: 2, hasPlan: true, assignmentCount: 2 }),
    false,
  );
});

test('plan mask not yet full (specific bequest pending) → wait', () => {
  assert.equal(
    shouldFinalize({ completed: false, solPaidMask: 0b11, planPaidMask: 0b01, benCount: 2, hasPlan: true, assignmentCount: 2 }),
    false,
  );
});

test('no-plan vault finalizes on the SOL mask alone', () => {
  assert.equal(
    shouldFinalize({ completed: false, solPaidMask: 0b111, planPaidMask: 0, benCount: 3, hasPlan: false, assignmentCount: 0 }),
    true,
  );
  assert.equal(
    shouldFinalize({ completed: false, solPaidMask: 0b011, planPaidMask: 0, benCount: 3, hasPlan: false, assignmentCount: 0 }),
    false,
    'no-plan vault with SOL not fully paid must still wait',
  );
});
