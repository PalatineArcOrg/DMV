/**
 * Instruction builders for all eight v0 instructions (spec §5, §7).
 *
 * ## Why these are hand-encoded rather than driven by `BorshInstructionCoder`
 *
 * Three reasons, in descending order of weight:
 *
 * 1. **The IDL lives in `target/`, which is gitignored.** `import idl from
 *    '../../../target/idl/coordination.json'` would make this package fail to
 *    typecheck, import or publish on any checkout that has not run
 *    `anchor build` — including a fresh CI clone before step 4 of `ci.sh`.
 * 2. **`@coral-xyz/anchor` is a *dev*Dependency of the workspace root**, not a
 *    dependency of this package (`clients/typescript/package.json` declares
 *    `@solana/web3.js` and nothing else). Importing it from `src/` would make
 *    the published package depend on a 3 MB toolchain it uses for two
 *    functions.
 * 3. The encoding is trivially small: eight discriminators, one struct, one
 *    vector. Anchor's own rule — `sha256("global:<snake_case_name>")[0..8]` —
 *    is applied once, offline, into `DISCRIMINATORS_BY_PREIMAGE` in
 *    `./layout.ts`; since A3.0 nothing in this package hashes at runtime (see
 *    that table's header — `node:crypto` does not exist in React Native).
 *
 * The safety net for that choice is two tests. `src/__tests__/layout.test.ts`
 * rehashes every precomputed constant from its own preimage, so the table
 * cannot drift from the naming rule. `src/__tests__/instructions.test.ts` pins
 * every discriminator against the **literal byte arrays from the built IDL**
 * (`target/idl/coordination.json`) and every account list against the IDL's
 * account order, so the naming rule cannot drift from the program. If Anchor
 * ever changed its naming or ordering, those go red rather than the client
 * silently building a malformed instruction.
 *
 * ## Account order is not negotiable
 *
 * Anchor matches accounts positionally. Two orderings in here are easy to get
 * wrong from the spec text alone:
 *
 * - `register_job` takes **six** accounts, not the five spec §5.1 lists:
 *   `authority, job, job_metas, escrow, target_program, system_program`.
 *   `target_program` is there because executability is a property of an
 *   *account*, not of a pubkey, and §5.1 requires the `TargetNotExecutable`
 *   check.
 * - `execute` takes `executor, job, job_metas, escrow, target_program` and then
 *   **the resolved forwarded accounts in `JobMetas` order**, which `execute`
 *   step 4c compares position by position.
 *
 * Signer-but-not-writable is also load-bearing: `reschedule`'s `rescheduler`
 * and `set_rescheduler`'s `authority` sign but are never debited, and marking
 * them writable would demand a write lock the program does not need.
 *
 * - `reap_job` (Build Set 1.5, spec §5.8) takes **four** accounts and no
 *   arguments: `reaper, job, escrow, authority`, every one writable. It looks
 *   like `close_job` minus `job_metas` — §5.8 forbids touching the metas
 *   account at all — and unlike `cancel` the `authority` is a *separate*
 *   account from the signer, because the whole point is that a third party
 *   signs while the refund goes to an authority who cannot act.
 */

import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  type AccountMeta,
} from '@solana/web3.js';

import {
  concatBytes,
  encodeBytesVec,
  encodeU16LE,
  encodeU32LE,
  encodeU64LE,
  encodeU8,
} from './borsh';
import { type AnchorExtraAccountMeta, encodeExtraAccountMetas } from './extraAccountMeta';
import {
  DISCRIMINATORS_BY_PREIMAGE,
  EXECUTOR_SLOT_NONE,
  MAX_IX_DATA,
  PROGRAM_ID,
} from './layout';
import { findEscrowPda, findJobMetasPda, findJobPdas } from './pdas';

// ---------------------------------------------------------------------------
// Discriminators
// ---------------------------------------------------------------------------

/**
 * The eight handler names exactly as Anchor hashes them — **snake_case**, the
 * form that appears in `target/idl/coordination.json`.
 */
export const INSTRUCTION_NAMES = Object.freeze({
  registerJob: 'register_job',
  fund: 'fund',
  execute: 'execute',
  reschedule: 'reschedule',
  setRescheduler: 'set_rescheduler',
  cancel: 'cancel',
  closeJob: 'close_job',
  /** Build Set 1.5, spec §5.8. */
  reapJob: 'reap_job',
} as const);

export type InstructionName = (typeof INSTRUCTION_NAMES)[keyof typeof INSTRUCTION_NAMES];

/**
 * Look a precomputed instruction discriminator up by handler name.
 *
 * Indirect on purpose. The bytes live in `./layout.ts` (one table, one guard
 * test — nothing in this package hashes at runtime, see that table's header),
 * but the *name* lives here in {@link INSTRUCTION_NAMES}. Routing the lookup
 * through the `global:` prefix means a handler renamed in one place and not the
 * other fails to compile rather than producing an undispatchable instruction.
 */
const ixDiscriminator = (name: InstructionName): Uint8Array =>
  DISCRIMINATORS_BY_PREIMAGE[`global:${name}`];

export const REGISTER_JOB_DISCRIMINATOR = ixDiscriminator(INSTRUCTION_NAMES.registerJob);
export const FUND_DISCRIMINATOR = ixDiscriminator(INSTRUCTION_NAMES.fund);
export const EXECUTE_DISCRIMINATOR = ixDiscriminator(INSTRUCTION_NAMES.execute);
export const RESCHEDULE_DISCRIMINATOR = ixDiscriminator(INSTRUCTION_NAMES.reschedule);
export const SET_RESCHEDULER_DISCRIMINATOR = ixDiscriminator(INSTRUCTION_NAMES.setRescheduler);
export const CANCEL_DISCRIMINATOR = ixDiscriminator(INSTRUCTION_NAMES.cancel);
export const CLOSE_JOB_DISCRIMINATOR = ixDiscriminator(INSTRUCTION_NAMES.closeJob);
/**
 * Build Set 1.5, spec §5.8.
 *
 * **Cross-check at integration.** The program lane added `reap_job`
 * concurrently and the IDL has not been rebuilt, so this is the one
 * discriminator with no entry in `target/idl/coordination.json` to pin it
 * against. It is `sha256("global:reap_job")[0..8]` (the guard test proves it)
 * applied to a handler name read off `programs/coordination/src/lib.rs`. What
 * is left is to re-run `anchor build` and add the bytes to
 * `IDL_DISCRIMINATORS` in `src/__tests__/instructions.test.ts`, which is
 * written to fail loudly the moment the IDL carries it and disagrees.
 */
export const REAP_JOB_DISCRIMINATOR = ixDiscriminator(INSTRUCTION_NAMES.reapJob);

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

const signerWritable = (pubkey: PublicKey): AccountMeta => ({
  pubkey,
  isSigner: true,
  isWritable: true,
});
const signerReadonly = (pubkey: PublicKey): AccountMeta => ({
  pubkey,
  isSigner: true,
  isWritable: false,
});
const writableAccount = (pubkey: PublicKey): AccountMeta => ({
  pubkey,
  isSigner: false,
  isWritable: true,
});
const readonlyAccount = (pubkey: PublicKey): AccountMeta => ({
  pubkey,
  isSigner: false,
  isWritable: false,
});

function instruction(
  programId: PublicKey,
  keys: readonly AccountMeta[],
  data: Uint8Array,
): TransactionInstruction {
  return new TransactionInstruction({
    programId,
    keys: [...keys],
    // web3.js v1's ctor field is typed `Buffer`; `Buffer.from` copies, which is
    // what we want anyway — nothing downstream should alias our encoder output.
    data: Buffer.from(data),
  });
}

// ---------------------------------------------------------------------------
// register_job (spec §5.1)
// ---------------------------------------------------------------------------

/**
 * `RegisterJobParams` (spec §3.1, §5.1), field order mirroring the Rust struct.
 *
 * Optional fields default to the value the program treats as "unset":
 * `beneficiary` and `rescheduler` to `Pubkey::default()` (no phase 0 / resolve
 * the rescheduler to the authority), the window to 0 (→
 * `DEFAULT_BENEFICIARY_WINDOW_SLOTS`), and `ix_data` to empty.
 */
export interface RegisterJobParams {
  /** `Pubkey::default()` (the default here) means no beneficiary and no phase 0. */
  beneficiary?: PublicKey;
  /** `0` (the default) selects `DEFAULT_BENEFICIARY_WINDOW_SLOTS`. */
  beneficiaryWindowSlots?: number;
  /** `Pubkey::default()` (the default) resolves on-chain to the authority. */
  rescheduler?: PublicKey;
  /** Slot `D` at which the job first comes due. MUST be strictly in the future. */
  nextDueSlot: bigint | number;
  /** `0` marks a one-shot job, which then requires `maxExecutions === 1`. */
  intervalSlots?: bigint | number;
  /** `0` means unlimited — legal for recurring jobs only. */
  maxExecutions?: bigint | number;
  /** Phase-0 reward and the phase-2 curve's origin, in lamports. */
  rewardBase: bigint | number;
  /** Slope of the phase-2 Dutch curve, in lamports per slot. */
  rewardSlopePerSlot?: bigint | number;
  /** Ceiling of the phase-2 curve. MUST be `>= rewardBase`. */
  rewardMax: bigint | number;
  /** Compute-unit hint. Advisory in v0 — recorded, never enforced. */
  cuLimit?: number;
  /**
   * Index into `extraMetas` whose supplied account `execute` will require to be
   * the executor, or {@link EXECUTOR_SLOT_NONE} (255, the default) for a job
   * that names no such position (spec §3.1, §5.1, Build Set 1.3).
   *
   * **On the wire this sits BETWEEN `cuLimit` and `ixData`, not at the end** —
   * see {@link encodeRegisterJobParams}.
   *
   * Setting it to anything but 255 is a *request for consent*, not a grant of
   * authority (spec §8.8): the registrant declares that whoever calls `execute`
   * will have their signature — and typically their lamports, e.g. the rent for
   * an account the target initialises — forwarded into the target CPI at this
   * one position. `rewardBase` should price that in.
   *
   * Because the slot **is** that request, the rule it names MUST set `isSigner`
   * (Build Set 1.7, spec §5.1) — see {@link assertValidExecutorSlot}.
   */
  executorSlot?: number;
  /** Static payload forwarded to the target on every execution. */
  ixData?: Uint8Array;
}

/**
 * The Anchor error code of `CoordinationError::InvalidExecutorSlot`.
 *
 * 6021, not the 6019 a straight reading of spec §6's list would give: the
 * program's error enum already carries two variants appended at milestone A1
 * (`RewardMaxBelowBase`, `UnsupportedJobVersion`), and the enum is append-only
 * so that no existing code ever moves. See `programs/coordination/src/errors.rs`.
 */
export const INVALID_EXECUTOR_SLOT_ERROR_CODE = 6021;

/**
 * Spec §5.1's two `executor_slot` rules, checked before a transaction is built.
 *
 * 1. **Range** — `255 || < extraMetas.length`. Note `<` against the *length*, so
 *    with an empty metas list every value except the sentinel is rejected: there
 *    is no position to point at.
 * 2. **Signer** (Build Set 1.7) — when the slot is not 255, the rule it names
 *    MUST set `isSigner`. The slot *is* consent to lend a signature (spec §8.8),
 *    so a slot naming a rule that asks for no signature has no coherent reading;
 *    `register_job` refuses it at registration rather than letting it fail
 *    confusingly at execution time.
 *
 * Both surface on-chain as bare code 6021 — the program appended no variant for
 * the second (spec §5.1) — which is exactly why failing here, with a message
 * that says which of the two rules was broken, is worth the check. Failing here
 * costs nothing; failing on-chain costs a transaction.
 *
 * `extraMetas` may be given as the **rules list** or as a bare **length**. Only
 * the list can be checked against rule 2, so the number form checks the range
 * alone; callers that hold the rules (every builder in this file does) should
 * pass them.
 */
export function assertValidExecutorSlot(
  executorSlot: number,
  extraMetas: number | readonly AnchorExtraAccountMeta[],
): void {
  if (!Number.isInteger(executorSlot) || executorSlot < 0 || executorSlot > 255) {
    throw new RangeError(`executor_slot must be a u8 (0..=255), got ${executorSlot}`);
  }
  if (executorSlot === EXECUTOR_SLOT_NONE) return;

  const rules = typeof extraMetas === 'number' ? null : extraMetas;
  const extraMetasLength = typeof extraMetas === 'number' ? extraMetas : extraMetas.length;

  if (executorSlot >= extraMetasLength) {
    throw new RangeError(
      `executor_slot ${executorSlot} is out of range for ${extraMetasLength} extra_metas ` +
        `(must be ${EXECUTOR_SLOT_NONE} for "none", or < the list length) — register_job ` +
        `would reject this with InvalidExecutorSlot (${INVALID_EXECUTOR_SLOT_ERROR_CODE})`,
    );
  }

  // Checked after the range, and only reachable with the rules in hand: an
  // out-of-range slot names no rule, so there is no `isSigner` to read.
  if (rules !== null && rules[executorSlot]?.isSigner !== true) {
    throw new RangeError(
      `executor_slot ${executorSlot} names a rule that does not set is_signer — the slot ` +
        'IS consent to lend a signature (spec §8.8), so a non-signer rule there means ' +
        `nothing — register_job would reject this with InvalidExecutorSlot ` +
        `(${INVALID_EXECUTOR_SLOT_ERROR_CODE})`,
    );
  }
}

export interface RegisterJobArgs {
  authority: PublicKey;
  jobId: bigint | number;
  targetProgram: PublicKey;
  params: RegisterJobParams;
  extraMetas?: readonly AnchorExtraAccountMeta[];
  programId?: PublicKey;
}

/**
 * Borsh-encode `RegisterJobParams`.
 *
 * Exported so a test can assert the byte layout without reaching through a
 * `TransactionInstruction`.
 *
 * ## `executor_slot` is INSERTED, not appended
 *
 * Build Set 1.3 added `executor_slot: u8` to `RegisterJobParams` **between
 * `cu_limit` and `ix_data`**, mirroring `Job`'s own field order (there it is the
 * last fixed field, and the only two fields between it and `cu_limit` —
 * `created_slot`, `completed_slot` — are derived by the program rather than
 * accepted, so this struct simply skips them).
 *
 * Borsh is positional and self-describes nothing. Encoding this byte *after*
 * `ix_data` instead would still deserialize — the `Vec<u8>` prefix would eat the
 * slot byte as payload length, and the trailing bytes would be read as the slot
 * — so the failure is not a clean "malformed instruction" but a silently
 * mis-encoded registration. `src/__tests__/instructions.test.ts` pins the byte
 * position; `programs/coordination/src/instructions/register_job.rs` is the
 * authority.
 */
export function encodeRegisterJobParams(params: RegisterJobParams): Uint8Array {
  const ixData = params.ixData ?? new Uint8Array(0);
  if (ixData.length > MAX_IX_DATA) {
    throw new RangeError(
      `ix_data is ${ixData.length} bytes, exceeding MAX_IX_DATA (${MAX_IX_DATA}) — ` +
        'register_job would reject this with IxDataTooLarge',
    );
  }

  return concatBytes([
    (params.beneficiary ?? PublicKey.default).toBytes(),
    encodeU16LE(params.beneficiaryWindowSlots ?? 0, 'beneficiary_window_slots'),
    (params.rescheduler ?? PublicKey.default).toBytes(),
    encodeU64LE(params.nextDueSlot, 'next_due_slot'),
    encodeU64LE(params.intervalSlots ?? 0n, 'interval_slots'),
    encodeU64LE(params.maxExecutions ?? 0n, 'max_executions'),
    encodeU64LE(params.rewardBase, 'reward_base'),
    encodeU64LE(params.rewardSlopePerSlot ?? 0n, 'reward_slope_per_slot'),
    encodeU64LE(params.rewardMax, 'reward_max'),
    encodeU32LE(params.cuLimit ?? 0, 'cu_limit'),
    // Build Set 1.3 — here, between cu_limit and ix_data. See the doc comment.
    encodeU8(params.executorSlot ?? EXECUTOR_SLOT_NONE, 'executor_slot'),
    encodeBytesVec(ixData),
  ]);
}

/**
 * `register_job(job_id, params, extra_metas)` — spec §5.1.
 *
 * The three PDAs are derived, never taken from the caller: `job_metas` and
 * `escrow` hang off the *derived* `job` address, so a single wrong seed cannot
 * produce a half-consistent account set.
 *
 * Only the three bounds a caller can check without the clock are validated
 * client-side (`IxDataTooLarge`, `TooManyMetas`, `InvalidExecutorSlot`); failing
 * here costs nothing where failing on-chain costs a transaction. The remaining
 * §5.1 rules (`DueSlotInPast` and friends) need `clock.slot` and stay the
 * program's job.
 */
export function registerJob(args: RegisterJobArgs): TransactionInstruction {
  const programId = args.programId ?? PROGRAM_ID;
  const { job, jobMetas, escrow } = findJobPdas(args.authority, args.jobId, programId);
  const extraMetas = args.extraMetas ?? [];

  // Spec §5.1, Build Sets 1.3 and 1.7. Checked here rather than in
  // `encodeRegisterJobParams` because both rules are against the *metas list*,
  // which that function never sees. The list itself is passed, not its length —
  // the Set 1.7 rule reads `isSigner` off the rule the slot names.
  assertValidExecutorSlot(args.params.executorSlot ?? EXECUTOR_SLOT_NONE, extraMetas);

  const data = concatBytes([
    REGISTER_JOB_DISCRIMINATOR,
    encodeU64LE(args.jobId, 'job_id'),
    encodeRegisterJobParams(args.params),
    encodeExtraAccountMetas(extraMetas),
  ]);

  return instruction(
    programId,
    [
      signerWritable(args.authority),
      writableAccount(job),
      writableAccount(jobMetas),
      writableAccount(escrow),
      // Sixth account. Not in spec §5.1's list, but required by its own
      // executable check — see the module docs.
      readonlyAccount(args.targetProgram),
      readonlyAccount(SystemProgram.programId),
    ],
    data,
  );
}

// ---------------------------------------------------------------------------
// fund (spec §5.2)
// ---------------------------------------------------------------------------

export interface FundArgs {
  /** Anyone: `fund` is permissionless. Pays the lamports and the fee. */
  payer: PublicKey;
  job: PublicKey;
  amount: bigint | number;
  programId?: PublicKey;
}

/** `fund(amount)` — spec §5.2. Permissionless; un-pauses an underfunded job. */
export function fund(args: FundArgs): TransactionInstruction {
  const programId = args.programId ?? PROGRAM_ID;
  const [escrow] = findEscrowPda(args.job, programId);

  return instruction(
    programId,
    [
      signerWritable(args.payer),
      writableAccount(args.job),
      writableAccount(escrow),
      readonlyAccount(SystemProgram.programId),
    ],
    concatBytes([FUND_DISCRIMINATOR, encodeU64LE(args.amount, 'amount')]),
  );
}

// ---------------------------------------------------------------------------
// execute (spec §5.3)
// ---------------------------------------------------------------------------

export interface ExecuteArgs {
  /** Fee payer and reward recipient. Unconstrained outside phase 0. */
  executor: PublicKey;
  job: PublicKey;
  /** Must equal `job.target_program`; Anchor pins it with an `address` constraint. */
  targetProgram: PublicKey;
  /**
   * The resolved forwarded accounts, **in `JobMetas` order**.
   *
   * `execute` step 4 compares these position by position against what the TLV
   * rules resolve to, with a distinct error code per kind of mismatch. Since
   * Build Set 1.3 the key comparison is exact **except at `Job.executor_slot`**,
   * where the supplied account must be the executor whatever the stored rule
   * says, and the privilege comparison is a *sufficiency* check — at least the
   * stored rule's flags, more permitted. Build them with
   * `resolveJobMetaAccounts` from `./executeJob.js` rather than by hand.
   */
  remainingAccounts: readonly AccountMeta[];
  programId?: PublicKey;
}

/** `execute()` — spec §5.3. */
export function execute(args: ExecuteArgs): TransactionInstruction {
  const programId = args.programId ?? PROGRAM_ID;
  const [jobMetas] = findJobMetasPda(args.job, programId);
  const [escrow] = findEscrowPda(args.job, programId);

  return instruction(
    programId,
    [
      signerWritable(args.executor),
      writableAccount(args.job),
      readonlyAccount(jobMetas),
      writableAccount(escrow),
      readonlyAccount(args.targetProgram),
      ...args.remainingAccounts,
    ],
    EXECUTE_DISCRIMINATOR,
  );
}

// ---------------------------------------------------------------------------
// reschedule (spec §5.4)
// ---------------------------------------------------------------------------

export interface RescheduleArgs {
  /** Must equal `job.rescheduler` — checked in the handler, not by `has_one`. */
  rescheduler: PublicKey;
  job: PublicKey;
  /** MUST be strictly greater than the current `next_due_slot` (forward-only). */
  newDueSlot: bigint | number;
  programId?: PublicKey;
}

/** `reschedule(new_due_slot)` — spec §5.4. Forward-only, rescheduler-gated. */
export function reschedule(args: RescheduleArgs): TransactionInstruction {
  const programId = args.programId ?? PROGRAM_ID;
  return instruction(
    programId,
    // Signer, NOT writable: the rescheduler is never debited.
    [signerReadonly(args.rescheduler), writableAccount(args.job)],
    concatBytes([RESCHEDULE_DISCRIMINATOR, encodeU64LE(args.newDueSlot, 'new_due_slot')]),
  );
}

// ---------------------------------------------------------------------------
// set_rescheduler (spec §5.5)
// ---------------------------------------------------------------------------

export interface SetReschedulerArgs {
  /** Bound to `job.authority` by an Anchor `has_one`. */
  authority: PublicKey;
  job: PublicKey;
  newRescheduler: PublicKey;
  programId?: PublicKey;
}

/** `set_rescheduler(new_rescheduler)` — spec §5.5, Build Set 1.2. */
export function setRescheduler(args: SetReschedulerArgs): TransactionInstruction {
  const programId = args.programId ?? PROGRAM_ID;
  return instruction(
    programId,
    [signerReadonly(args.authority), writableAccount(args.job)],
    concatBytes([SET_RESCHEDULER_DISCRIMINATOR, args.newRescheduler.toBytes()]),
  );
}

// ---------------------------------------------------------------------------
// cancel (spec §5.6)
// ---------------------------------------------------------------------------

export interface CancelArgs {
  /** The job's owner and the refund destination. */
  authority: PublicKey;
  job: PublicKey;
  programId?: PublicKey;
}

/** `cancel()` — spec §5.6. Authority-only; refunds the whole spendable escrow. */
export function cancel(args: CancelArgs): TransactionInstruction {
  const programId = args.programId ?? PROGRAM_ID;
  const [escrow] = findEscrowPda(args.job, programId);

  return instruction(
    programId,
    [signerWritable(args.authority), writableAccount(args.job), writableAccount(escrow)],
    CANCEL_DISCRIMINATOR,
  );
}

// ---------------------------------------------------------------------------
// close_job (spec §5.7)
// ---------------------------------------------------------------------------

export interface CloseJobArgs {
  /** The authority (branch a, immediately) or anyone (branch b, after the grace). */
  closer: PublicKey;
  job: PublicKey;
  /**
   * `job.authority`, bound by a `has_one`. In branch (a) this is the same
   * account as `closer`; the runtime deduplicates it.
   */
  authority: PublicKey;
  programId?: PublicKey;
}

/** `close_job()` — spec §5.7. Closes all three accounts and reclaims rent. */
export function closeJob(args: CloseJobArgs): TransactionInstruction {
  const programId = args.programId ?? PROGRAM_ID;
  const [jobMetas] = findJobMetasPda(args.job, programId);
  const [escrow] = findEscrowPda(args.job, programId);

  return instruction(
    programId,
    [
      signerWritable(args.closer),
      writableAccount(args.job),
      writableAccount(jobMetas),
      writableAccount(escrow),
      writableAccount(args.authority),
    ],
    CLOSE_JOB_DISCRIMINATOR,
  );
}

// ---------------------------------------------------------------------------
// reap_job (spec §5.8, Build Set 1.5)
// ---------------------------------------------------------------------------

/**
 * The Anchor error code of `CoordinationError::ReapGraceNotElapsed`.
 *
 * 6022, not the 6020 a straight reading of spec §6's list would give, for the
 * same reason {@link INVALID_EXECUTOR_SLOT_ERROR_CODE} is 6021 and not 6019:
 * `errors.rs` already carries three variants appended after the §6 list
 * (`RewardMaxBelowBase` 6019, `UnsupportedJobVersion` 6020,
 * `InvalidExecutorSlot` 6021), and the enum is append-only so that no existing
 * code ever moves. `ReapGraceNotElapsed` is the fourth such append — DECISIONS
 * 18 fixes it at 6022.
 */
export const REAP_GRACE_NOT_ELAPSED_ERROR_CODE = 6022;

export interface ReapJobArgs {
  /**
   * Anyone. Signs, pays the fee, and receives
   * `min(REAP_TIP_LAMPORTS, spendable)`.
   */
  reaper: PublicKey;
  job: PublicKey;
  /**
   * `job.authority` — the refund destination for whatever spendable balance the
   * tip leaves behind, bound by a `has_one`.
   *
   * Not derivable from `job` without fetching it, and passing the *reaper* here
   * would be a silent self-payment attempt rather than an obvious mistake, so it
   * is required rather than defaulted. `decodeJob(...).authority` from
   * `./job.js`, or `FoundJob.job.authority` from `./findDueJobs.js`.
   */
  authority: PublicKey;
  programId?: PublicKey;
}

/**
 * `reap_job()` — spec §5.8. Recovers a **stranded** escrow.
 *
 * Permissionless, no arguments. The program's two guards are `status == Active`
 * (`InvalidStatus`) and `clock.slot > next_due_slot + REAP_GRACE_SLOTS`
 * ({@link REAP_GRACE_NOT_ELAPSED_ERROR_CODE}); check the second one off-chain
 * with `jobIsReapableAt` from `./job.js` before spending a transaction on it.
 *
 * Why it exists (DECISIONS 18): a job whose target has a one-shot latch —
 * DMV's `ExecutionLog` — becomes permanently unexecutable if another cranker
 * wins ignition first. The CPI reverts forever, the job stays `Active`, and its
 * escrow is stranded. `cancel` is the authority's remedy, and in the motivating
 * case the authority is a vault owner who has just died.
 *
 * `reap_job` never invokes the target, never touches `JobMetas`, and never
 * alters reward parameters (spec §5.8 "Scope"). It leaves the job `Cancelled`,
 * so `close_job` reclaims the rent afterwards under §5.7's terminal-state rules.
 */
export function reapJob(args: ReapJobArgs): TransactionInstruction {
  const programId = args.programId ?? PROGRAM_ID;
  const [escrow] = findEscrowPda(args.job, programId);

  return instruction(
    programId,
    [
      signerWritable(args.reaper),
      writableAccount(args.job),
      writableAccount(escrow),
      // Writable, NOT a signer: the authority is credited the refund and is
      // exactly the party assumed to be unable to sign anything.
      writableAccount(args.authority),
    ],
    REAP_JOB_DISCRIMINATOR,
  );
}

// ---------------------------------------------------------------------------
// re-exports
// ---------------------------------------------------------------------------
//
// The `AnchorExtraAccountMeta` mirror and its rule builders are part of the
// `register_job` contract, so they are reachable from this module as well as
// from `./extraAccountMeta.js`.

export {
  ADDRESS_CONFIG_LEN,
  EXECUTOR_SLOT_PLACEHOLDER_KEY,
  EXTERNAL_PDA_FLAG,
  ExtraAccountMetaKind,
  PubkeyDataKind,
  SeedKind,
  decodeExtraAccountMeta,
  decodeExtraAccountMetaList,
  decodeJobMetas,
  encodeExtraAccountMeta,
  encodeExtraAccountMetas,
  extraAccountMetaForExecutor,
  extraAccountMetaForExternalPda,
  extraAccountMetaForPubkey,
  extraAccountMetaForPubkeyData,
  extraAccountMetaForSeeds,
  extraAccountMetasWithExecutorFirst,
  jobMetasTlvBytes,
  packPubkeyDataIntoAddressConfig,
  packSeedsIntoAddressConfig,
  seedTlvSize,
  unpackAddressConfig,
  unpackPubkeyDataAddressConfig,
} from './extraAccountMeta';

export type {
  AnchorExtraAccountMeta,
  ExecutorSlotRules,
  JobMetasAccount,
  PubkeyDataConfig,
  Seed,
} from './extraAccountMeta';
