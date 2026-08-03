/**
 * Decoding a `Job` account (spec §3.1).
 *
 * Every read here goes through a named `OFF_JOB_*` constant from `./layout.ts`.
 * That is deliberate: it makes the exported offsets *load-bearing* rather than
 * decorative, so the layout-offset guard test in `src/__tests__/layout.test.ts`
 * is also a guard on this decoder, on `findDueJobs`' memcmp filters and on
 * `executeJob`'s `target_program` / `ix_data` reads.
 *
 * There is no `encodeJob`: clients never write a `Job`, and a round-trip
 * encoder would be a second, unverified copy of the layout. The layout test
 * builds its fixture buffer from an independently transcribed field table
 * instead.
 */

import { PublicKey } from '@solana/web3.js';

import { U64_MAX, bytesEqual, decodePubkey, decodeU16LE, decodeU32LE, decodeU64LE, decodeU8, sliceExact, toHex, toU64 } from './borsh';
import {
  DISCRIMINATOR_LEN,
  EXECUTOR_SLOT_NONE,
  JOB_BASE_LEN,
  JOB_DISCRIMINATOR,
  JobStatus,
  MAX_IX_DATA,
  OFF_JOB_AUTHORITY,
  OFF_JOB_BENEFICIARY,
  OFF_JOB_BENEFICIARY_WINDOW_SLOTS,
  OFF_JOB_BUMP,
  OFF_JOB_COMPLETED_SLOT,
  OFF_JOB_CREATED_SLOT,
  OFF_JOB_CU_LIMIT,
  OFF_JOB_EXECUTION_COUNT,
  OFF_JOB_EXECUTOR_SLOT,
  OFF_JOB_FLAGS,
  OFF_JOB_INTERVAL_SLOTS,
  OFF_JOB_IX_DATA,
  OFF_JOB_IX_DATA_LEN,
  OFF_JOB_JOB_ID,
  OFF_JOB_LAST_EXECUTION_SLOT,
  OFF_JOB_MAX_EXECUTIONS,
  OFF_JOB_NEXT_DUE_SLOT,
  OFF_JOB_RESCHEDULER,
  REAP_GRACE_SLOTS,
  OFF_JOB_REWARD_BASE,
  OFF_JOB_REWARD_MAX,
  OFF_JOB_REWARD_SLOPE_PER_SLOT,
  OFF_JOB_STATUS,
  OFF_JOB_TARGET_PROGRAM,
  OFF_JOB_VERSION,
  executorSlotIndex,
} from './layout';
import { effectiveBeneficiaryWindow, phaseAt, rewardAt, type Phase } from './reward';

/**
 * A decoded `Job`, field for field.
 *
 * Every `u64` is a `bigint` and every `u8`/`u16`/`u32` a `number` — see
 * `./borsh.ts` for why the split is not arbitrary.
 */
export interface JobAccount {
  readonly version: number;
  readonly bump: number;
  /** Raw status byte. Compare against `JobStatus.*` from `./layout.js`. */
  readonly status: number;
  readonly flags: number;
  readonly authority: PublicKey;
  readonly targetProgram: PublicKey;
  readonly beneficiary: PublicKey;
  readonly beneficiaryWindowSlots: number;
  readonly rescheduler: PublicKey;
  readonly jobId: bigint;
  readonly nextDueSlot: bigint;
  readonly intervalSlots: bigint;
  readonly executionCount: bigint;
  readonly maxExecutions: bigint;
  readonly lastExecutionSlot: bigint;
  readonly rewardBase: bigint;
  readonly rewardSlopePerSlot: bigint;
  readonly rewardMax: bigint;
  readonly cuLimit: number;
  readonly createdSlot: bigint;
  readonly completedSlot: bigint;
  /**
   * Raw `executor_slot` byte (spec §3.1, Build Set 1.3).
   *
   * `255` — {@link EXECUTOR_SLOT_NONE} — means the job names no executor
   * position. Anything else is an index into the resolved meta list whose
   * supplied account MUST equal the executor. Kept raw rather than pre-decoded
   * to `number | null` so the account interface stays a faithful mirror of the
   * bytes; use {@link jobExecutorSlotIndex} for the decoded form.
   */
  readonly executorSlot: number;
  readonly ixData: Uint8Array;
}

/**
 * Decode a `Job` account from its raw data.
 *
 * Rejects a wrong discriminator, a short account, and an `ix_data` length that
 * disagrees with the account's own size — the last one because a `Job` is sized
 * to exactly `Job::space(ix_data.len())` at registration, so a mismatch means
 * the bytes did not come from `register_job`.
 */
export function decodeJob(data: Uint8Array): JobAccount {
  const discriminator = sliceExact(data, 0, DISCRIMINATOR_LEN, 'Job discriminator');
  if (!bytesEqual(discriminator, JOB_DISCRIMINATOR)) {
    throw new Error(
      `not a Job account: discriminator ${toHex(discriminator)} != ${toHex(JOB_DISCRIMINATOR)}`,
    );
  }
  if (data.length < JOB_BASE_LEN) {
    throw new RangeError(`Job account is ${data.length} bytes, shorter than ${JOB_BASE_LEN}`);
  }

  const ixDataLen = decodeU32LE(data, OFF_JOB_IX_DATA_LEN, 'ix_data length');
  if (ixDataLen > MAX_IX_DATA) {
    throw new RangeError(`Job.ix_data declares ${ixDataLen} bytes, over MAX_IX_DATA`);
  }
  if (data.length !== JOB_BASE_LEN + ixDataLen) {
    throw new RangeError(
      `Job account is ${data.length} bytes but declares ${ixDataLen} ix_data bytes ` +
        `(expected ${JOB_BASE_LEN + ixDataLen}) — not sized by register_job`,
    );
  }

  return {
    version: decodeU8(data, OFF_JOB_VERSION, 'version'),
    bump: decodeU8(data, OFF_JOB_BUMP, 'bump'),
    status: decodeU8(data, OFF_JOB_STATUS, 'status'),
    flags: decodeU8(data, OFF_JOB_FLAGS, 'flags'),
    authority: decodePubkey(data, OFF_JOB_AUTHORITY, 'authority'),
    targetProgram: decodePubkey(data, OFF_JOB_TARGET_PROGRAM, 'target_program'),
    beneficiary: decodePubkey(data, OFF_JOB_BENEFICIARY, 'beneficiary'),
    beneficiaryWindowSlots: decodeU16LE(
      data,
      OFF_JOB_BENEFICIARY_WINDOW_SLOTS,
      'beneficiary_window_slots',
    ),
    rescheduler: decodePubkey(data, OFF_JOB_RESCHEDULER, 'rescheduler'),
    jobId: decodeU64LE(data, OFF_JOB_JOB_ID, 'job_id'),
    nextDueSlot: decodeU64LE(data, OFF_JOB_NEXT_DUE_SLOT, 'next_due_slot'),
    intervalSlots: decodeU64LE(data, OFF_JOB_INTERVAL_SLOTS, 'interval_slots'),
    executionCount: decodeU64LE(data, OFF_JOB_EXECUTION_COUNT, 'execution_count'),
    maxExecutions: decodeU64LE(data, OFF_JOB_MAX_EXECUTIONS, 'max_executions'),
    lastExecutionSlot: decodeU64LE(data, OFF_JOB_LAST_EXECUTION_SLOT, 'last_execution_slot'),
    rewardBase: decodeU64LE(data, OFF_JOB_REWARD_BASE, 'reward_base'),
    rewardSlopePerSlot: decodeU64LE(data, OFF_JOB_REWARD_SLOPE_PER_SLOT, 'reward_slope_per_slot'),
    rewardMax: decodeU64LE(data, OFF_JOB_REWARD_MAX, 'reward_max'),
    cuLimit: decodeU32LE(data, OFF_JOB_CU_LIMIT, 'cu_limit'),
    createdSlot: decodeU64LE(data, OFF_JOB_CREATED_SLOT, 'created_slot'),
    completedSlot: decodeU64LE(data, OFF_JOB_COMPLETED_SLOT, 'completed_slot'),
    executorSlot: decodeU8(data, OFF_JOB_EXECUTOR_SLOT, 'executor_slot'),
    ixData: Uint8Array.from(sliceExact(data, OFF_JOB_IX_DATA, ixDataLen, 'ix_data')),
  };
}

/**
 * `Job.executor_slot` as an index, or `null` when the job names no executor
 * position (spec §3.1, §5.3 step 4).
 *
 * The `255` sentinel is the difference between "the account at index 0 must be
 * the executor" and "no position is special", and confusing the two is how a
 * client ends up substituting the executor's key over a legitimate rule. Read
 * the slot through this rather than testing `=== 255` at each call site.
 */
export function jobExecutorSlotIndex(job: JobAccount): number | null {
  return executorSlotIndex(job.executorSlot);
}

/** True when the job asks the executor to lend its signature (spec §8.8). */
export function jobRequiresExecutorConsent(job: JobAccount): boolean {
  return job.executorSlot !== EXECUTOR_SLOT_NONE;
}

/** The `B` in force for this job (spec §4) — the pubkey substitutions applied. */
export function jobBeneficiaryWindow(job: JobAccount): number {
  return effectiveBeneficiaryWindow(job.beneficiary, job.beneficiaryWindowSlots);
}

/** The phase this job's current due event is in at `slot` (spec §4). */
export function jobPhaseAt(job: JobAccount, slot: bigint | number): Phase {
  return phaseAt(slot, job.nextDueSlot, jobBeneficiaryWindow(job));
}

// ---------------------------------------------------------------------------
// reapability (spec §5.8, Build Set 1.5)
// ---------------------------------------------------------------------------

/**
 * The slot `reap_job`'s grace guard compares against:
 * `next_due_slot + REAP_GRACE_SLOTS`.
 *
 * A job becomes reapable **strictly after** this slot — spec §5.8 writes the
 * guard as `clock.slot > next_due_slot + REAP_GRACE_SLOTS`, so at exactly this
 * slot the program still reverts `ReapGraceNotElapsed`. Hence "threshold" and
 * not "earliest": the first reapable slot is one past the returned value.
 *
 * Saturates at `u64::MAX`. A `next_due_slot` high enough to overflow the sum
 * simply never becomes reapable, which is also what the program does — its
 * checked add reverts instead of wrapping the threshold back to a small slot and
 * handing someone else's live escrow to a reaper.
 */
export function reapThresholdSlot(nextDueSlot: bigint | number): bigint {
  const threshold = toU64(nextDueSlot, 'next_due_slot') + REAP_GRACE_SLOTS;
  return threshold > U64_MAX ? U64_MAX : threshold;
}

/**
 * Would `reap_job` pass its two guards at `slot`? — spec §5.8, from raw fields.
 *
 * `status == Active` **and** `slot > next_due_slot + REAP_GRACE_SLOTS`. Both
 * halves matter and each has its own on-chain error (`InvalidStatus` /
 * `ReapGraceNotElapsed`), so this is the client-side pre-check that keeps a
 * reaper from spending a transaction to learn one of them.
 *
 * Note `>`, not `>=`: see {@link reapThresholdSlot}. An off-by-one the other way
 * costs a reverted transaction on the single most-contested slot.
 *
 * Answers only what the *program* will do. It says nothing about whether reaping
 * is *worth* it — that is `escrow.lamports - rentExempt` against
 * `REAP_TIP_LAMPORTS` (`./layout.js`) and the fee, which needs an escrow fetch
 * this function deliberately does not take.
 */
export function isReapableAt(
  status: number,
  nextDueSlot: bigint | number,
  slot: bigint | number,
): boolean {
  if (status !== JobStatus.Active) return false;
  return toU64(slot, 'slot') > reapThresholdSlot(nextDueSlot);
}

/** {@link isReapableAt} for a decoded job (spec §5.8). */
export function jobIsReapableAt(job: JobAccount, slot: bigint | number): boolean {
  return isReapableAt(job.status, job.nextDueSlot, slot);
}

/** The reward this job would pay an executor firing at `slot` (spec §4). */
export function jobRewardAt(job: JobAccount, slot: bigint | number): bigint {
  return rewardAt(
    slot,
    job.nextDueSlot,
    jobBeneficiaryWindow(job),
    job.rewardBase,
    job.rewardSlopePerSlot,
    job.rewardMax,
  );
}
