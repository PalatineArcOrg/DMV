/**
 * Phase and reward arithmetic — a mirror of spec §4 and of
 * `programs/coordination/src/reward.rs`, function for function.
 *
 * ## Why the client needs its own copy
 *
 * An executor decides whether to submit *before* the chain tells it anything:
 * it scans with `getProgramAccounts`, computes what a due job would pay at the
 * current slot, and compares that against its fee. If this mirror disagrees
 * with the program by even one lamport at a boundary, the executor either
 * submits transactions that lose money or skips jobs it would have been paid
 * for. That is why the boundaries pinned in `src/__tests__/reward.test.ts` are
 * the *same* boundaries the Rust unit tests pin.
 *
 * ## The model (spec §4)
 *
 * For a due event at `D = next_due_slot` and a resolved window `B`:
 *
 * ```text
 * Phase 0:  D <= slot < D+B   -> only the beneficiary may execute
 *                                reward = reward_base
 * Phase 2:  slot >= D+B       -> anyone may execute
 *                                reward = min(reward_base
 *                                             + reward_slope_per_slot * (slot - (D+B)),
 *                                             reward_max)
 * ```
 *
 * There is no phase 1 in v0.
 *
 * ## Saturating, not throwing
 *
 * Spec §4: "All arithmetic checked/saturating; the curve saturates at
 * `reward_max`, never wraps." `bigint` has no width, so nothing here would wrap
 * on its own — but the *program* saturates at `u64::MAX` before clamping, and a
 * mirror that returned the arbitrary-precision answer would disagree with the
 * chain exactly where an adversary would aim. So `satAdd`/`satMul`/`satSub`
 * clamp to the u64 range explicitly. (The clamp to `reward_max` then makes the
 * two identical anyway, since `reward_max <= u64::MAX` always — see the Rust
 * module docs for why that is exact rather than approximate.)
 *
 * `advanceNextDue` is the exception and uses **checked** arithmetic, throwing
 * on overflow, because the program does: an overflowing schedule has no correct
 * fallback and reverts with `ArithmeticOverflow`.
 */

import { PublicKey } from '@solana/web3.js';

import { U16_MAX, U64_MAX, toU64, toUint } from './borsh';
import { DEFAULT_BENEFICIARY_WINDOW_SLOTS } from './layout';

/** Which execution phase a slot falls in, for one due event (spec §4). */
export const Phase = {
  /** Phase 0 — `D <= slot < D+B`. Only `job.beneficiary` may execute. */
  Beneficiary: 'beneficiary',
  /** Phase 2 — `slot >= D+B`. Permissionless, under the rising Dutch curve. */
  Open: 'open',
} as const;

export type Phase = (typeof Phase)[keyof typeof Phase];

// ---------------------------------------------------------------------------
// saturating u64 helpers
// ---------------------------------------------------------------------------

function satAdd(a: bigint, b: bigint): bigint {
  const sum = a + b;
  return sum > U64_MAX ? U64_MAX : sum;
}

function satSub(a: bigint, b: bigint): bigint {
  return a > b ? a - b : 0n;
}

function satMul(a: bigint, b: bigint): bigint {
  const product = a * b;
  return product > U64_MAX ? U64_MAX : product;
}

// ---------------------------------------------------------------------------
// spec §4
// ---------------------------------------------------------------------------

/**
 * The phase-0 window `B` actually in force, per spec §4's two substitutions:
 *
 * 1. `beneficiary == Pubkey::default()` → **0**. No one holds the priority
 *    window, so phase 2 opens at the due slot itself. This wins outright: a
 *    stored non-zero `beneficiary_window_slots` is ignored, not merely
 *    defaulted.
 * 2. otherwise `beneficiary_window_slots == 0` → `DEFAULT_BENEFICIARY_WINDOW_SLOTS`.
 * 3. otherwise the stored value.
 *
 * Mirror of `Job::effective_beneficiary_window`. Feed the result to
 * {@link phaseAt} / {@link rewardAt} as `window`; those know nothing about
 * pubkeys.
 */
export function effectiveBeneficiaryWindow(
  beneficiary: PublicKey,
  beneficiaryWindowSlots: number,
): number {
  const window = toUint(beneficiaryWindowSlots, U16_MAX, 'beneficiary_window_slots');
  if (beneficiary.equals(PublicKey.default)) return 0;
  if (window === 0) return DEFAULT_BENEFICIARY_WINDOW_SLOTS;
  return window;
}

/**
 * First slot of phase 2, i.e. `D + B`, saturating at `u64::MAX`.
 *
 * Saturating is the only sane behaviour at the top of the slot space: a window
 * running past `u64::MAX` simply never opens, keeping the job in phase 0 rather
 * than wrapping the boundary back to a small slot and handing a permissionless
 * execution to anyone.
 */
export function openSlot(due: bigint | number, window: number): bigint {
  return satAdd(toU64(due, 'due'), BigInt(toUint(window, U16_MAX, 'window')));
}

/**
 * The phase a given slot falls in (spec §4).
 *
 * `window` is `B` **already resolved** — call {@link effectiveBeneficiaryWindow}
 * first.
 *
 * Callers MUST have already established `slot >= due`; that is `execute`
 * step 2 (`NotDue`), which precedes the step-3 phase gate. For `slot < due`
 * this returns `Phase.Beneficiary`, matching the gate's own `slot < D+B` test
 * rather than inventing a third state.
 */
export function phaseAt(slot: bigint | number, due: bigint | number, window: number): Phase {
  return toU64(slot, 'slot') < openSlot(due, window) ? Phase.Beneficiary : Phase.Open;
}

/**
 * The reward, in lamports, payable to whoever executes at `slot` (spec §4).
 *
 * Phase 0 pays `reward_base` verbatim; §4 applies the `min(..., reward_max)`
 * clamp to the phase-2 curve only. The two agree at the curve's origin because
 * `register_job` rejects `reward_max < reward_base` (`RewardMaxBelowBase`).
 *
 * Never throws for any in-range u64 input — see the module docs.
 */
export function rewardAt(
  slot: bigint | number,
  due: bigint | number,
  window: number,
  rewardBase: bigint | number,
  rewardSlopePerSlot: bigint | number,
  rewardMax: bigint | number,
): bigint {
  const base = toU64(rewardBase, 'reward_base');
  const slope = toU64(rewardSlopePerSlot, 'reward_slope_per_slot');
  const ceiling = toU64(rewardMax, 'reward_max');

  if (phaseAt(slot, due, window) === Phase.Beneficiary) return base;

  const elapsed = satSub(toU64(slot, 'slot'), openSlot(due, window));
  const growth = satMul(slope, elapsed);
  const uncapped = satAdd(base, growth);
  return uncapped < ceiling ? uncapped : ceiling;
}

/**
 * The next due slot after a successful recurring execution — spec §5.3 step 8:
 * `next_due_slot = max(next_due_slot + interval_slots, slot + 1)`.
 *
 * Two jobs in one expression: `next_due + interval` holds the original cadence
 * rather than drifting by however long execution took, and the `max(.., slot+1)`
 * clamp kills catch-up bursts — a long outage costs exactly one execution and
 * the schedule resumes from now. `slot + 1`, not `slot`, is also what makes a
 * same-slot second executor find the job `NotDue`.
 *
 * **Checked**, not saturating, mirroring the program: an overflowing schedule
 * has no meaningful answer, so this throws where the program returns
 * `ArithmeticOverflow`.
 */
export function advanceNextDue(
  nextDue: bigint | number,
  intervalSlots: bigint | number,
  slot: bigint | number,
): bigint {
  const due = toU64(nextDue, 'next_due_slot');
  const interval = toU64(intervalSlots, 'interval_slots');
  const at = toU64(slot, 'slot');

  const onCadence = due + interval;
  if (onCadence > U64_MAX) {
    throw new RangeError(
      `ArithmeticOverflow: next_due_slot ${due} + interval_slots ${interval} exceeds u64`,
    );
  }

  const strictlyFuture = at + 1n;
  if (strictlyFuture > U64_MAX) {
    throw new RangeError(`ArithmeticOverflow: slot ${at} + 1 exceeds u64`);
  }

  return onCadence > strictlyFuture ? onCadence : strictlyFuture;
}
