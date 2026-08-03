/**
 * Program identity + on-chain account layout constants.
 *
 * Normative source: `docs/coordination-layer-v0-spec.md` §2 (conventions),
 * §3 (accounts), §7 (client library contract).
 *
 * Ground truth for the byte offsets below is the Rust struct itself —
 * `programs/coordination/src/state/job.rs`, whose declaration order is
 * load-bearing and whose `Job::FIXED_LEN` doc comment carries the same table.
 * Spec §7 requires these constants be "generated from the Rust layout, guarded
 * by a layout test"; see the two halves of that requirement below and in
 * `src/__tests__/layout.test.ts`.
 */

import { PublicKey } from '@solana/web3.js';

import { PUBKEY_LEN, U16_LEN, U32_LEN, U64_LEN, U8_LEN } from './borsh';

/** The `coordination` program (devnet keypair at `keys/coordination-devnet.json`). */
export const COORDINATION_PROGRAM_ID_STR = 'GapcihvhnBpRkW84gdBStApgPtZBhgMecXGP1KLBtGMC';

export const PROGRAM_ID = new PublicKey(COORDINATION_PROGRAM_ID_STR);

/** Length of an Anchor account discriminator, in bytes. */
export const DISCRIMINATOR_LEN = 8;

// ===========================================================================
// Discriminators — PRECOMPUTED CONSTANTS, no hashing at runtime
// ===========================================================================
//
// !! A3.0 / DECISIONS 19 !!  This package is vendored into DMV's Expo/React
// Native app, where `node:crypto` DOES NOT EXIST — the app polyfills only
// `crypto -> expo-crypto`. Until A3.0 these eight-byte values were computed at
// module load with `createHash('sha256')`, which means every discriminator —
// and therefore `findDueJobs`, `decodeJob` and every instruction builder —
// would have thrown on the first import inside the APK.
//
// The ratified fix (DECISIONS 19): **the runtime carries the answer, the test
// carries the derivation.** Nothing below imports from `node:*`, and this
// package no longer hashes anything at all. `src/__tests__/layout.test.ts`
// recomputes every entry of the table from its key with node-side sha256 and
// asserts byte equality, so a hand-typed byte cannot survive a test run.
//
// Do not reintroduce a `sha256()` helper here, not even a pure-JS one: the
// point is not "which sha256" but that the runtime needs none.

/** Exactly eight bytes — a tuple so a transcription slip fails to compile. */
type DiscriminatorBytes = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

const disc = (...bytes: DiscriminatorBytes): Uint8Array => Uint8Array.from(bytes);

/**
 * Every 8-byte discriminator this client needs, keyed by its **exact sha256
 * preimage**, value = `sha256(key)[0..8]`.
 *
 * Keying by the preimage rather than by a friendly name is what makes the guard
 * test total: it walks this record and rehashes each *key*, so there is no way
 * to add a constant here without also stating the string it must hash from, and
 * no way to state the wrong string and still pass.
 *
 * Three preimage families, and mixing them up is a silent failure rather than a
 * loud one, so they are spelled out:
 *
 * - `account:<PascalCaseStructName>` — Anchor account discriminators. The Rust
 *   struct name (`Job`, `JobMetas`, `Escrow`), **not** the camelCase name the
 *   Anchor TS coder takes for `coder.accounts.decode`.
 * - `global:<snake_case_handler_name>` — Anchor instruction discriminators. The
 *   handler name as it appears in the `#[program]` module and in the built IDL
 *   (`register_job`, `close_job`, `set_rescheduler`), **not** camelCase.
 * - bare, no prefix — `spl-tlv-account-resolution` TLV type tags, produced by
 *   `#[derive(SplDiscriminate)]` from `#[discriminator_hash_input("...")]`
 *   (see `spl-discriminator-syn`'s `get_discriminator_bytes`), which hashes the
 *   input verbatim.
 *
 * Every value except `global:reap_job` is cross-checked against the literal
 * bytes in the built `target/idl/coordination.json` — see the trailing comment
 * on that entry, and `src/__tests__/instructions.test.ts`.
 */
export const DISCRIMINATORS_BY_PREIMAGE = Object.freeze({
  // --- accounts (spec §3) --------------------------------------------------
  /** 4b7c50cba1b4ca50 */
  'account:Job': disc(75, 124, 80, 203, 161, 180, 202, 80),
  /** a895df61f6961ed8 */
  'account:JobMetas': disc(168, 149, 223, 97, 246, 150, 30, 216),
  /** 1fd57bbbba16da9b */
  'account:Escrow': disc(31, 213, 123, 187, 186, 22, 218, 155),

  // --- instructions (spec §5) ----------------------------------------------
  /** 57d5b1ff8311b22d */
  'global:register_job': disc(87, 213, 177, 255, 131, 17, 178, 45),
  /** dabc6fdd9871ae07 */
  'global:fund': disc(218, 188, 111, 221, 152, 113, 174, 7),
  /** 82ddf29a0dc1bd1d */
  'global:execute': disc(130, 221, 242, 154, 13, 193, 189, 29),
  /** 6f11c7705b273176 */
  'global:reschedule': disc(111, 17, 199, 112, 91, 39, 49, 118),
  /** 88d70aa542d2522d */
  'global:set_rescheduler': disc(136, 215, 10, 165, 66, 210, 82, 45),
  /** e8dbdf29dbecdcbe */
  'global:cancel': disc(232, 219, 223, 41, 219, 236, 220, 190),
  /** 5a64b4c8c8a378b6 */
  'global:close_job': disc(90, 100, 180, 200, 200, 163, 120, 182),
  /**
   * ab878e86a643526c
   *
   * !! CROSS-CHECK AT INTEGRATION !!  Build Set 1.5 (spec §5.8). This is the
   * ONE entry with no IDL to compare against: `reap_job` was added to the
   * program in a concurrent A3.0 lane and `target/idl/coordination.json` has
   * not been rebuilt since.
   *
   * Two of the three links are already proven. The guard test proves this is
   * `sha256("global:reap_job")[0..8]`, and the handler was read directly from
   * `programs/coordination/src/lib.rs` (`pub fn reap_job(ctx: Context<ReapJob>)`)
   * to confirm the name the rule is applied to. What remains is mechanical:
   * re-run `anchor build` and pin the bytes in
   * `src/__tests__/instructions.test.ts` like the other seven.
   */
  'global:reap_job': disc(171, 135, 142, 134, 166, 67, 82, 108),

  // --- SPL TLV type tags (spec §3.2) ---------------------------------------
  /** 9f769e607cef5f7b */
  'coordination:job-metas': disc(159, 118, 158, 96, 124, 239, 95, 123),
});

/** Rust struct names of the three v0 accounts (spec §3). */
export const JOB_ACCOUNT_NAME = 'Job';
export const JOB_METAS_ACCOUNT_NAME = 'JobMetas';
export const ESCROW_ACCOUNT_NAME = 'Escrow';

/**
 * Discriminators for the three v0 accounts. Used as the offset-0 memcmp filter
 * of every `getProgramAccounts` query (spec §7 `findDueJobs`).
 */
export const JOB_DISCRIMINATOR: Uint8Array = DISCRIMINATORS_BY_PREIMAGE['account:Job'];
export const JOB_METAS_DISCRIMINATOR: Uint8Array = DISCRIMINATORS_BY_PREIMAGE['account:JobMetas'];
export const ESCROW_DISCRIMINATOR: Uint8Array = DISCRIMINATORS_BY_PREIMAGE['account:Escrow'];

// ===========================================================================
// Spec §2 compile-time constants
// ===========================================================================
//
// Mirror of `programs/coordination/src/constants.rs`. v0 has no config account
// (that is a v1 feature), so these are compile-time on both sides and a change
// is a program upgrade, not a transaction.

/** `DEFAULT_BENEFICIARY_WINDOW_SLOTS` — applied when `beneficiary_window_slots == 0`. */
export const DEFAULT_BENEFICIARY_WINDOW_SLOTS = 50;

/** `MAX_IX_DATA` — upper bound on `Job.ix_data`. */
export const MAX_IX_DATA = 512;

/**
 * `MAX_EXTRA_METAS` — upper bound on the `JobMetas` entry count.
 *
 * **Build Set 1.3 lowered this from 24 to 20.** Spec §2 records the measurement
 * behind the number: 21 rules ≈ 1,213 bytes against the 1,232-byte legacy
 * transaction limit, so 20 is the last count that reliably fits. It is not a
 * storage bound — `JobMetas` would happily hold more — it is the point past
 * which the `execute` transaction stops being sendable, which is a far worse
 * failure mode (a job that registers cleanly and can never be fired). Raise it
 * only alongside versioned-transaction/ALT support in v1.
 */
export const MAX_EXTRA_METAS = 20;

/**
 * `Job.executor_slot`'s "this job names no executor position" sentinel
 * (spec §3.1, Build Set 1.3).
 *
 * 255 rather than an out-of-band `Option`: the field is a plain `u8` in a
 * fixed-width layout, and `MAX_EXTRA_METAS` (20) is far below 255, so the
 * sentinel can never collide with a legal index.
 */
export const EXECUTOR_SLOT_NONE = 255;

/**
 * `Job::executor_slot_index` — the stored byte as an index, or `null` for the
 * {@link EXECUTOR_SLOT_NONE} sentinel.
 *
 * One decode, one place to be wrong: both the key-substitution rule and the
 * `is_signer` satisfiability rule in spec §5.3 step 4 ask the same question.
 */
export function executorSlotIndex(executorSlot: number): number | null {
  return executorSlot === EXECUTOR_SLOT_NONE ? null : executorSlot;
}

/** `CLOSE_GRACE_SLOTS` — third-party `close_job` grace period (~2 days). */
export const CLOSE_GRACE_SLOTS = 432_000n;

/** `MIN_BASE_REWARD` — spam floor on `reward_base`, in lamports. */
export const MIN_BASE_REWARD = 10_000n;

/**
 * `REAP_GRACE_SLOTS` — how far past its due slot an `Active` job must sit before
 * anyone may `reap_job` it (spec §2, §5.8, Build Set 1.5). ~30 days.
 *
 * Deliberately an order of magnitude longer than {@link CLOSE_GRACE_SLOTS}:
 * reaping is a last resort for a **stranded** job, not a competing execution
 * path. DECISIONS 18 records why it cannot cannibalise a live one — §5.4's
 * `reschedule` is forward-only, so any job whose target is still heartbeating
 * has a due slot in the *future* and can never reach a threshold 30 days in the
 * past, while a job that is genuinely due and executable gets executed by
 * someone long before the grace elapses, for a rising reward.
 */
export const REAP_GRACE_SLOTS = 6_480_000n;

/**
 * `REAP_TIP_LAMPORTS` — the reaper's fixed bounty, in lamports (spec §2, §5.8).
 *
 * The reaper is paid `min(REAP_TIP_LAMPORTS, spendable)`; the remainder of the
 * spendable balance is refunded to the authority. So on a thin escrow the tip is
 * whatever is left, not a debt.
 */
export const REAP_TIP_LAMPORTS = 1_000_000n;

// ===========================================================================
// `JobStatus` (spec §3.1)
// ===========================================================================
//
// Borsh serialises a fieldless enum as a single-byte variant tag in declaration
// order. That order is observable to clients — it is the byte `findDueJobs`
// memcmp-filters at `OFF_JOB_STATUS` — so it is pinned here and in the Rust
// enum's own doc comment.
//
// Modelled as a frozen object plus a union type rather than a TS `enum`: a
// `const enum` breaks under `isolatedModules`, and a plain `enum` emits a
// runtime object with reverse mappings nobody here wants.

export const JobStatus = {
  Active: 0,
  Paused: 1,
  Completed: 2,
  Cancelled: 3,
} as const;

export type JobStatus = (typeof JobStatus)[keyof typeof JobStatus];

/** Human-readable name of a status byte, or `undefined` if it is not a v0 variant. */
export function jobStatusName(status: number): string | undefined {
  for (const [name, value] of Object.entries(JobStatus)) {
    if (value === status) return name;
  }
  return undefined;
}

/** The two terminal states — they admit only `close_job` (spec §8.6). */
export function isTerminalStatus(status: number): boolean {
  return status === JobStatus.Completed || status === JobStatus.Cancelled;
}

// ===========================================================================
// `Job` byte offsets — GENERATED, not typed out (spec §7)
// ===========================================================================
//
// Borsh packs with NO alignment padding, so every fixed-position field's offset
// is exactly `DISCRIMINATOR_LEN` plus the running sum of the widths declared
// before it. The cursor below performs that sum; the ONLY thing written by hand
// is the field order and each field's width, which is a direct transcription of
// the `#[account] pub struct Job` declaration in
// `programs/coordination/src/state/job.rs`.
//
// That is the point: to change an offset you must change a *field*, and the
// layout-offset guard test then fails against its independently-transcribed
// table. Hand-written offset literals would drift silently instead.
//
// !! BUILD SET 1.1 !!  The ratified `reschedule` amendment inserted
// `rescheduler: Pubkey` BETWEEN `beneficiary_window_slots` and `job_id`. That
// is a 32-byte insertion in the MIDDLE of the struct: every field from `job_id`
// onward — including `next_due_slot`, the field `findDueJobs` filters on — sits
// exactly +32 relative to any pre-1.1 draft layout. `next_due_slot` is at 150
// (8 + 142), not 118. An offset table carried over from a pre-1.1 note is wrong
// by exactly 32 bytes from `job_id` down; regenerate, never patch by hand.
//
// !! BUILD SET 1.3 !!  `executor_slot: u8` was APPENDED after `completed_slot`,
// i.e. in the last fixed position, immediately before `ix_data`. That placement
// is the whole point: `ix_data` is the only variable-width field and carries its
// own length prefix, so it has no offset any client memcmp can depend on.
// Consequently EVERY offset through `completed_slot` (226) is unchanged —
// `next_due_slot` still sits at 150 and `findDueJobs` needs no change — and only
// `ix_data` moved: length prefix 234 → 235, payload 238 → 239. `JOB_FIXED_LEN`
// 226 → 227, `JOB_BASE_LEN` 238 → 239, `JOB_MAX_SPACE` 750 → 751. Appending
// anywhere earlier would have shifted `next_due_slot` and silently broken gPA
// filtering; `src/__tests__/layout.test.ts` pins both halves of that claim.
//
// All multi-byte integers are little-endian (spec §2, Borsh default), so a
// memcmp comparand for `next_due_slot` must be encoded LE — the same trap
// `encodeJobIdSeed` in ./pdas.ts guards for the Job seed.
//
// v1: `flags` bit meanings are reserved and MUST be 0 in v0 (spec §3.1, §10).

function layoutCursor(start: number): { field: (width: number) => number; readonly at: number } {
  let at = start;
  return {
    field(width: number): number {
      const offset = at;
      at += width;
      return offset;
    },
    get at(): number {
      return at;
    },
  };
}

const jobLayout = layoutCursor(DISCRIMINATOR_LEN);

export const OFF_JOB_VERSION = jobLayout.field(U8_LEN);
export const OFF_JOB_BUMP = jobLayout.field(U8_LEN);
/** Single-byte `JobStatus` tag. The cheapest `findDueJobs` filter. */
export const OFF_JOB_STATUS = jobLayout.field(U8_LEN);
export const OFF_JOB_FLAGS = jobLayout.field(U8_LEN);
export const OFF_JOB_AUTHORITY = jobLayout.field(PUBKEY_LEN);
export const OFF_JOB_TARGET_PROGRAM = jobLayout.field(PUBKEY_LEN);
export const OFF_JOB_BENEFICIARY = jobLayout.field(PUBKEY_LEN);
export const OFF_JOB_BENEFICIARY_WINDOW_SLOTS = jobLayout.field(U16_LEN);
/** Build Set 1.1 insertion — everything below shifted +32 because of it. */
export const OFF_JOB_RESCHEDULER = jobLayout.field(PUBKEY_LEN);
export const OFF_JOB_JOB_ID = jobLayout.field(U64_LEN);
/** The field spec §7's `findDueJobs` memcmp-filters on. Absolute offset 150. */
export const OFF_JOB_NEXT_DUE_SLOT = jobLayout.field(U64_LEN);
export const OFF_JOB_INTERVAL_SLOTS = jobLayout.field(U64_LEN);
export const OFF_JOB_EXECUTION_COUNT = jobLayout.field(U64_LEN);
export const OFF_JOB_MAX_EXECUTIONS = jobLayout.field(U64_LEN);
export const OFF_JOB_LAST_EXECUTION_SLOT = jobLayout.field(U64_LEN);
export const OFF_JOB_REWARD_BASE = jobLayout.field(U64_LEN);
export const OFF_JOB_REWARD_SLOPE_PER_SLOT = jobLayout.field(U64_LEN);
export const OFF_JOB_REWARD_MAX = jobLayout.field(U64_LEN);
export const OFF_JOB_CU_LIMIT = jobLayout.field(U32_LEN);
export const OFF_JOB_CREATED_SLOT = jobLayout.field(U64_LEN);
export const OFF_JOB_COMPLETED_SLOT = jobLayout.field(U64_LEN);
/**
 * Build Set 1.3 append — the LAST fixed field, at absolute offset 234.
 *
 * Index into the resolved meta list whose supplied account MUST equal the
 * executor, or {@link EXECUTOR_SLOT_NONE} (255) for a job that names no such
 * position. Because it lands here rather than beside a related field, every
 * offset above it is byte-for-byte what it was at Build Set 1.1.
 */
export const OFF_JOB_EXECUTOR_SLOT = jobLayout.field(U8_LEN);
/** `Vec<u8>` length prefix of `ix_data`; also the end of the fixed region. */
export const OFF_JOB_IX_DATA_LEN = jobLayout.field(U32_LEN);
/** First byte of `ix_data`'s payload. Equals `JOB_BASE_LEN`. */
export const OFF_JOB_IX_DATA = jobLayout.at;

/** `Job::FIXED_LEN` — every fixed-position field, excluding the discriminator. */
export const JOB_FIXED_LEN = OFF_JOB_IX_DATA_LEN - DISCRIMINATOR_LEN;

/** `Job::BASE_LEN` — discriminator + fixed fields + the `Vec` length prefix. */
export const JOB_BASE_LEN = OFF_JOB_IX_DATA;

/** `Job::MAX_SPACE` — `space(MAX_IX_DATA)`, the largest legal `Job` account. */
export const JOB_MAX_SPACE = JOB_BASE_LEN + MAX_IX_DATA;

/** `Job::space(ix_data_len)` — the account size for a given payload. */
export function jobSpace(ixDataLen: number): number {
  if (!Number.isInteger(ixDataLen) || ixDataLen < 0) {
    throw new RangeError(`ix_data length must be a non-negative integer, got ${ixDataLen}`);
  }
  return JOB_BASE_LEN + ixDataLen;
}

/**
 * Every exported `Job` offset, keyed by its Rust field name.
 *
 * Convenience for generic tooling (building a memcmp filter from a field name);
 * the named constants above remain the canonical form.
 */
export const JOB_OFFSETS = Object.freeze({
  version: OFF_JOB_VERSION,
  bump: OFF_JOB_BUMP,
  status: OFF_JOB_STATUS,
  flags: OFF_JOB_FLAGS,
  authority: OFF_JOB_AUTHORITY,
  target_program: OFF_JOB_TARGET_PROGRAM,
  beneficiary: OFF_JOB_BENEFICIARY,
  beneficiary_window_slots: OFF_JOB_BENEFICIARY_WINDOW_SLOTS,
  rescheduler: OFF_JOB_RESCHEDULER,
  job_id: OFF_JOB_JOB_ID,
  next_due_slot: OFF_JOB_NEXT_DUE_SLOT,
  interval_slots: OFF_JOB_INTERVAL_SLOTS,
  execution_count: OFF_JOB_EXECUTION_COUNT,
  max_executions: OFF_JOB_MAX_EXECUTIONS,
  last_execution_slot: OFF_JOB_LAST_EXECUTION_SLOT,
  reward_base: OFF_JOB_REWARD_BASE,
  reward_slope_per_slot: OFF_JOB_REWARD_SLOPE_PER_SLOT,
  reward_max: OFF_JOB_REWARD_MAX,
  cu_limit: OFF_JOB_CU_LIMIT,
  created_slot: OFF_JOB_CREATED_SLOT,
  completed_slot: OFF_JOB_COMPLETED_SLOT,
  executor_slot: OFF_JOB_EXECUTOR_SLOT,
  ix_data_len: OFF_JOB_IX_DATA_LEN,
  ix_data: OFF_JOB_IX_DATA,
} as const);

// ===========================================================================
// `JobMetas` layout (spec §3.2)
// ===========================================================================
//
//   0..8    Anchor discriminator
//   8..9    bump: u8
//   9..     ExtraAccountMetaList TLV blob      <- JOB_METAS_TLV_OFFSET
//
// The TLV blob is raw bytes appended after the Borsh-serialized struct, not a
// `Vec<u8>` field — `spl-tlv-account-resolution` frames it itself and needs a
// contiguous slice whose index 0 is the start of that framing.

export const OFF_JOB_METAS_BUMP = DISCRIMINATOR_LEN;

/** `JobMetas::HEADER_LEN` / `JobMetas::TLV_OFFSET` — discriminator + `bump`. */
export const JOB_METAS_TLV_OFFSET = DISCRIMINATOR_LEN + U8_LEN;

/**
 * TLV framing, from `spl-type-length-value` 0.8.0's `get_base_len()`:
 * an 8-byte `ArrayDiscriminator` followed by a 4-byte little-endian `Length`.
 */
export const TLV_DISCRIMINATOR_LEN = 8;
export const TLV_LENGTH_LEN = 4;
export const TLV_BASE_LEN = TLV_DISCRIMINATOR_LEN + TLV_LENGTH_LEN;

/** `PodSlice`'s own `u32` little-endian item count, inside the TLV value. */
export const POD_SLICE_LENGTH_LEN = 4;

/**
 * `size_of::<ExtraAccountMeta>()` — `#[repr(C)]`, align 1:
 * `discriminator: u8` + `address_config: [u8; 32]` + two `PodBool`s.
 *
 * The Borsh wire form of `AnchorExtraAccountMeta` is the same 35 bytes, which
 * is convenient but deliberately not relied on: the program converts field by
 * field, and so does this client.
 */
export const EXTRA_ACCOUNT_META_LEN = 1 + PUBKEY_LEN + 1 + 1;

/** `ExtraAccountMetaList::size_of(n)` — TLV header + `PodSlice` of `n` entries. */
export function extraAccountMetaListSize(numMetas: number): number {
  if (!Number.isInteger(numMetas) || numMetas < 0) {
    throw new RangeError(`meta count must be a non-negative integer, got ${numMetas}`);
  }
  return TLV_BASE_LEN + POD_SLICE_LENGTH_LEN + numMetas * EXTRA_ACCOUNT_META_LEN;
}

/** `JobMetas::space(n)` — the header plus the crate's own sizing. */
export function jobMetasSpace(numMetas: number): number {
  return JOB_METAS_TLV_OFFSET + extraAccountMetaListSize(numMetas);
}

/**
 * Inverse of `jobMetasSpace`, mirroring `execute`'s `expected_meta_count`.
 *
 * `register_job` sizes the account with no slack, so the blob length determines
 * the entry count exactly. Returns `undefined` for a length that matches no
 * legal capacity — which means the account is not a well-formed `JobMetas`,
 * not that the count is wrong.
 */
export function expectedMetaCount(tlvLen: number): number | undefined {
  for (let count = 0; count <= MAX_EXTRA_METAS; count += 1) {
    const candidate = extraAccountMetaListSize(count);
    if (candidate === tlvLen) return count;
    if (candidate > tlvLen) break;
  }
  return undefined;
}

/**
 * The `#[discriminator_hash_input(..)]` of `register_job::JobMetasEntry`, the
 * marker type whose `SplDiscriminate` tags this program's TLV entry.
 *
 * LANE COUPLING: `register_job` writes the blob with
 * `ExtraAccountMetaList::init::<JobMetasEntry>` and `execute` reads it back
 * with `add_to_cpi_instruction::<JobMetasEntry>`. A client that walks the TLV
 * looking for a different tag finds no entry at all.
 */
export const JOB_METAS_TLV_HASH_INPUT = 'coordination:job-metas';

export const JOB_METAS_TLV_DISCRIMINATOR: Uint8Array =
  DISCRIMINATORS_BY_PREIMAGE[JOB_METAS_TLV_HASH_INPUT];

// ===========================================================================
// `Escrow` layout (spec §3.3)
// ===========================================================================
//
// Discriminator + `bump: u8`. The meaningful state is the lamport balance;
// spendable = lamports − rent-exempt minimum.

export const OFF_ESCROW_BUMP = DISCRIMINATOR_LEN;
export const ESCROW_SPACE = DISCRIMINATOR_LEN + U8_LEN;
