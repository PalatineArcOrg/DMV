/**
 * `AnchorExtraAccountMeta` — the TypeScript mirror of the mirror.
 *
 * Normative sources, in order of authority:
 *   - `programs/coordination/src/instructions/register_job.rs`
 *     (`AnchorExtraAccountMeta`, the Borsh wire form the instruction accepts)
 *   - the vendored crate at
 *     `~/.cargo/registry/src/*​/spl-tlv-account-resolution-0.10.0/src/`
 *     — `account.rs` (the Pod type + resolution), `seeds.rs` (seed packing),
 *     `pubkey_data.rs` (discriminator-2 rules), `state.rs` (the TLV blob)
 *   - spec §3.2.
 *
 * ## Why there are two mirrors
 *
 * The crate's `ExtraAccountMeta` is a `bytemuck` Pod type: `#[repr(C)]`, with
 * `is_signer` / `is_writable` typed `PodBool`. Pod is not Borsh, so it cannot
 * appear in an Anchor instruction argument and cannot be described in the IDL.
 * `register_job` therefore takes `Vec<AnchorExtraAccountMeta>`, a Borsh struct
 * with the same four fields, and converts field by field. This module is the
 * TypeScript form of that same struct.
 *
 * Borsh encodes `bool` as one byte and `[u8; 32]` as 32 raw bytes with no
 * length prefix and no padding, so the wire form is 35 bytes — the same 35 the
 * align-1 Pod type occupies. That coincidence is what lets one encoder serve
 * both the instruction argument (Borsh) and the `PodSlice` read back out of
 * `JobMetas` (Pod). It is asserted in the tests rather than assumed.
 *
 * ## `discriminator` and `address_config` are a tagged union
 *
 * - `0`   — a literal key; `address_config` is the pubkey.
 * - `1`   — a PDA of the *executing* program (at `execute` time, the **target**
 *           program, because the crate derives under `cpi_instruction.program_id`);
 *           `address_config` is packed seeds.
 * - `2`   — a pubkey read out of instruction or account data.
 * - `>=128` — a PDA of another program in the forwarded list, the low 7 bits
 *           being that program's index in the list.
 *
 * The program forwards the pair opaquely and validates nothing about it; a
 * malformed pair can only fail inside the crate's resolver at `execute` step 4.
 */

import { PublicKey } from '@solana/web3.js';

import {
  U8_MAX,
  bytesEqual,
  concatBytes,
  decodeU32LE,
  decodeU8,
  encodeBool,
  encodeU32LE,
  encodeU8,
  sliceExact,
  toHex,
  toUint,
} from './borsh';
import {
  DISCRIMINATOR_LEN,
  EXTRA_ACCOUNT_META_LEN,
  JOB_METAS_DISCRIMINATOR,
  JOB_METAS_TLV_DISCRIMINATOR,
  JOB_METAS_TLV_OFFSET,
  MAX_EXTRA_METAS,
  OFF_JOB_METAS_BUMP,
  POD_SLICE_LENGTH_LEN,
  TLV_BASE_LEN,
  TLV_DISCRIMINATOR_LEN,
  expectedMetaCount,
} from './layout';

/** Width of the packed `address_config` blob, in bytes. */
export const ADDRESS_CONFIG_LEN = 32;

/** The top bit of `discriminator`, marking an external-program PDA rule. */
export const EXTERNAL_PDA_FLAG = 1 << 7;

/** Rule kinds, by `discriminator` value (the `>= 128` case has no single value). */
export const ExtraAccountMetaKind = {
  LiteralKey: 0,
  ProgramPda: 1,
  PubkeyData: 2,
} as const;

/**
 * Borsh/Pod mirror of `AnchorExtraAccountMeta`.
 *
 * `addressConfig` is always exactly 32 bytes — {@link encodeExtraAccountMeta}
 * rejects anything else rather than padding, because a short config that
 * happened to encode would derive a different PDA on-chain.
 */
export interface AnchorExtraAccountMeta {
  readonly discriminator: number;
  readonly addressConfig: Uint8Array;
  readonly isSigner: boolean;
  readonly isWritable: boolean;
}

// ---------------------------------------------------------------------------
// Seed configurations (`seeds.rs`)
// ---------------------------------------------------------------------------

/**
 * Seed discriminators, verbatim from `Seed::pack`.
 *
 * `Uninitialized` is `0` and is what terminates an `address_config` walk; it is
 * never written deliberately.
 */
export const SeedKind = {
  Uninitialized: 0,
  Literal: 1,
  InstructionData: 2,
  AccountKey: 3,
  AccountData: 4,
} as const;

/**
 * A seed rule.
 *
 * **Index space warning.** `accountKey.index` and `accountData.accountIndex`
 * index into the **forwarded list itself** — the accounts `JobMetas` describes,
 * and only those already resolved at that point — NOT into `execute`'s five
 * named accounts. On-chain, `add_to_cpi_instruction` starts `cpi_account_infos`
 * empty and grows it entry by entry, so entry `i` can only reference entries
 * `0..i`. The resolver in `./executeJob.ts` uses the same base; anything else
 * derives a different PDA off-chain than on-chain.
 */
export type Seed =
  | { readonly kind: 'literal'; readonly bytes: Uint8Array }
  | { readonly kind: 'instructionData'; readonly index: number; readonly length: number }
  | { readonly kind: 'accountKey'; readonly index: number }
  | {
      readonly kind: 'accountData';
      readonly accountIndex: number;
      readonly dataIndex: number;
      readonly length: number;
    };

/** `Seed::tlv_size` — the packed width of one seed rule. */
export function seedTlvSize(seed: Seed): number {
  switch (seed.kind) {
    case 'literal':
      return 1 + 1 + seed.bytes.length;
    case 'instructionData':
      return 1 + 1 + 1;
    case 'accountKey':
      return 1 + 1;
    case 'accountData':
      return 1 + 1 + 1 + 1;
  }
}

function packSeed(seed: Seed): Uint8Array {
  switch (seed.kind) {
    case 'literal': {
      if (seed.bytes.length > U8_MAX) {
        throw new RangeError(`literal seed of ${seed.bytes.length} bytes exceeds a u8 length`);
      }
      return concatBytes([
        encodeU8(SeedKind.Literal),
        encodeU8(seed.bytes.length, 'literal seed length'),
        seed.bytes,
      ]);
    }
    case 'instructionData':
      return concatBytes([
        encodeU8(SeedKind.InstructionData),
        encodeU8(seed.index, 'instruction-data seed index'),
        encodeU8(seed.length, 'instruction-data seed length'),
      ]);
    case 'accountKey':
      return concatBytes([
        encodeU8(SeedKind.AccountKey),
        encodeU8(seed.index, 'account-key seed index'),
      ]);
    case 'accountData':
      return concatBytes([
        encodeU8(SeedKind.AccountData),
        encodeU8(seed.accountIndex, 'account-data seed account index'),
        encodeU8(seed.dataIndex, 'account-data seed data index'),
        encodeU8(seed.length, 'account-data seed length'),
      ]);
  }
}

/**
 * `Seed::pack_into_address_config` — pack seeds into the 32-byte config,
 * zero-filling the tail.
 *
 * Throws where the crate returns `SeedConfigsTooLarge`: the combined packed
 * size must be ≤ 32 bytes. The zero tail is what terminates
 * {@link unpackAddressConfig}'s walk.
 */
export function packSeedsIntoAddressConfig(seeds: readonly Seed[]): Uint8Array {
  const packed = new Uint8Array(ADDRESS_CONFIG_LEN);
  let at = 0;
  for (const seed of seeds) {
    const bytes = packSeed(seed);
    if (at + bytes.length > ADDRESS_CONFIG_LEN) {
      throw new RangeError(
        `seed configs exceed ${ADDRESS_CONFIG_LEN} bytes (SeedConfigsTooLarge)`,
      );
    }
    packed.set(bytes, at);
    at += bytes.length;
  }
  return packed;
}

type UnpackedSeed = Seed | { readonly kind: 'uninitialized' };

/** `Seed::unpack` over one slice, mirroring the crate's error conditions. */
function unpackSeed(bytes: Uint8Array): UnpackedSeed {
  if (bytes.length === 0) throw new RangeError('seed config: empty slice');
  const discriminator = decodeU8(bytes, 0, 'seed discriminator');
  const rest = bytes.subarray(1);

  switch (discriminator) {
    case SeedKind.Uninitialized:
      return { kind: 'uninitialized' };
    case SeedKind.Literal: {
      if (rest.length === 0) throw new RangeError('literal seed: missing length byte');
      const length = decodeU8(rest, 0, 'literal seed length');
      if (rest.length - 1 < length) {
        throw new RangeError(`literal seed: declares ${length} bytes, only ${rest.length - 1} left`);
      }
      return { kind: 'literal', bytes: Uint8Array.from(rest.subarray(1, 1 + length)) };
    }
    case SeedKind.InstructionData: {
      if (rest.length < 2) throw new RangeError('instruction-data seed: needs index and length');
      return {
        kind: 'instructionData',
        index: decodeU8(rest, 0),
        length: decodeU8(rest, 1),
      };
    }
    case SeedKind.AccountKey: {
      if (rest.length < 1) throw new RangeError('account-key seed: needs an index');
      return { kind: 'accountKey', index: decodeU8(rest, 0) };
    }
    case SeedKind.AccountData: {
      if (rest.length < 3) {
        throw new RangeError('account-data seed: needs account index, data index and length');
      }
      return {
        kind: 'accountData',
        accountIndex: decodeU8(rest, 0),
        dataIndex: decodeU8(rest, 1),
        length: decodeU8(rest, 2),
      };
    }
    default:
      throw new RangeError(`seed config: unknown discriminator ${discriminator}`);
  }
}

/**
 * `Seed::unpack_address_config` — walk a 32-byte config, stopping at the first
 * uninitialized (zero) byte.
 *
 * The stop condition matters: a config is zero-filled to 32 bytes, so the walk
 * is what distinguishes "two seeds then padding" from "two seeds then garbage".
 */
export function unpackAddressConfig(addressConfig: Uint8Array): Seed[] {
  if (addressConfig.length !== ADDRESS_CONFIG_LEN) {
    throw new RangeError(
      `address_config must be ${ADDRESS_CONFIG_LEN} bytes, got ${addressConfig.length}`,
    );
  }

  const seeds: Seed[] = [];
  let at = 0;
  while (at < ADDRESS_CONFIG_LEN) {
    const seed = unpackSeed(addressConfig.subarray(at));
    if (seed.kind === 'uninitialized') break;
    at += seedTlvSize(seed);
    seeds.push(seed);
  }
  return seeds;
}

// ---------------------------------------------------------------------------
// PubkeyData configurations (`pubkey_data.rs`, discriminator 2)
// ---------------------------------------------------------------------------

export const PubkeyDataKind = {
  Uninitialized: 0,
  InstructionData: 1,
  AccountData: 2,
} as const;

/** A discriminator-2 rule: a pubkey read out of some data. Length is always 32. */
export type PubkeyDataConfig =
  | { readonly kind: 'instructionData'; readonly index: number }
  | {
      readonly kind: 'accountData';
      readonly accountIndex: number;
      readonly dataIndex: number;
    };

/** `PubkeyData::pack_into_address_config`. */
export function packPubkeyDataIntoAddressConfig(config: PubkeyDataConfig): Uint8Array {
  const packed = new Uint8Array(ADDRESS_CONFIG_LEN);
  if (config.kind === 'instructionData') {
    packed[0] = PubkeyDataKind.InstructionData;
    packed[1] = toUint(config.index, U8_MAX, 'pubkey-data instruction index');
  } else {
    packed[0] = PubkeyDataKind.AccountData;
    packed[1] = toUint(config.accountIndex, U8_MAX, 'pubkey-data account index');
    packed[2] = toUint(config.dataIndex, U8_MAX, 'pubkey-data data index');
  }
  return packed;
}

/** `PubkeyData::unpack`. */
export function unpackPubkeyDataAddressConfig(addressConfig: Uint8Array): PubkeyDataConfig {
  if (addressConfig.length !== ADDRESS_CONFIG_LEN) {
    throw new RangeError(
      `address_config must be ${ADDRESS_CONFIG_LEN} bytes, got ${addressConfig.length}`,
    );
  }
  const discriminator = decodeU8(addressConfig, 0, 'pubkey-data discriminator');
  switch (discriminator) {
    case PubkeyDataKind.InstructionData:
      return { kind: 'instructionData', index: decodeU8(addressConfig, 1) };
    case PubkeyDataKind.AccountData:
      return {
        kind: 'accountData',
        accountIndex: decodeU8(addressConfig, 1),
        dataIndex: decodeU8(addressConfig, 2),
      };
    default:
      throw new RangeError(`pubkey-data config: unknown discriminator ${discriminator}`);
  }
}

// ---------------------------------------------------------------------------
// Rule builders
// ---------------------------------------------------------------------------

/**
 * A literal key — `ExtraAccountMeta::new_with_pubkey`.
 *
 * Discriminator `0`, `address_config` = the 32 pubkey bytes. This is the only
 * rule kind DMV needs (`docs/DECISIONS.md` 7), and the only one whose
 * resolution needs no RPC round trip.
 */
export function extraAccountMetaForPubkey(
  pubkey: PublicKey,
  isSigner: boolean,
  isWritable: boolean,
): AnchorExtraAccountMeta {
  return {
    discriminator: ExtraAccountMetaKind.LiteralKey,
    addressConfig: Uint8Array.from(pubkey.toBytes()),
    isSigner,
    isWritable,
  };
}

/**
 * A PDA of the executing program — `ExtraAccountMeta::new_with_seeds`.
 *
 * Discriminator `1`. At `execute` time the crate derives under
 * `cpi_instruction.program_id`, i.e. the **target** program — the right
 * semantics for accounts that belong to the callee, and *not* the coordination
 * program.
 */
export function extraAccountMetaForSeeds(
  seeds: readonly Seed[],
  isSigner: boolean,
  isWritable: boolean,
): AnchorExtraAccountMeta {
  return {
    discriminator: ExtraAccountMetaKind.ProgramPda,
    addressConfig: packSeedsIntoAddressConfig(seeds),
    isSigner,
    isWritable,
  };
}

/**
 * A PDA of another program in the forwarded list —
 * `ExtraAccountMeta::new_external_pda_with_seeds`.
 *
 * `programIndex` indexes the forwarded list (see {@link Seed}'s index-space
 * warning), and must refer to an entry that resolves *before* this one.
 */
export function extraAccountMetaForExternalPda(
  programIndex: number,
  seeds: readonly Seed[],
  isSigner: boolean,
  isWritable: boolean,
): AnchorExtraAccountMeta {
  const index = toUint(programIndex, EXTERNAL_PDA_FLAG - 1, 'external PDA program index');
  return {
    discriminator: index + EXTERNAL_PDA_FLAG,
    addressConfig: packSeedsIntoAddressConfig(seeds),
    isSigner,
    isWritable,
  };
}

// ---------------------------------------------------------------------------
// The `executor_slot` position (spec §3.1, §5.3 step 4, Build Set 1.3)
// ---------------------------------------------------------------------------

/**
 * The stored pubkey for the rule sitting at `Job.executor_slot`.
 *
 * At that index `execute` ignores the rule's resolved pubkey entirely and
 * requires the supplied account to *be* the executor, so whatever is stored is a
 * placeholder. `PublicKey.default` (all zero) is used because it is the one key
 * guaranteed not to be either of the two things a placeholder must not be:
 *
 *  - **the `Job` PDA** — that is spec §3.2's *other* route to satisfying an
 *    `is_signer` rule (the program signs for itself), so using it here would
 *    make an `executor_slot` test pass for the wrong reason; and
 *  - **any of `execute`'s five named accounts** — those carry message-level
 *    privileges the registrar did not choose.
 *
 * Note only that it is byte-wise the System Program id, which may separately and
 * legitimately appear elsewhere in the same forwarded list.
 */
export const EXECUTOR_SLOT_PLACEHOLDER_KEY = PublicKey.default;

/**
 * The rule to store at `Job.executor_slot` — a literal-key rule whose key is a
 * placeholder and whose **flags are not**.
 *
 * Spec §5.3 step 6 forwards each account to the target with exactly the stored
 * flags, so `isSigner: true, isWritable: true` (the defaults, and DMV's
 * `begin_execution` shape) is precisely what makes the executor arrive at the
 * target as a spendable `Signer` funding an `init`. The message-level side costs
 * the registrant nothing: `execute`'s own `executor [signer, w]` already grants
 * both privileges, and Build Set 1.3 made the check a sufficiency test.
 *
 * This is the *only* index at which an `is_signer` rule is satisfiable other
 * than one resolving to the `Job` PDA (spec §3.2); anywhere else it reverts
 * `SignerFlagMismatch`.
 */
export function extraAccountMetaForExecutor(
  options: {
    readonly isSigner?: boolean;
    readonly isWritable?: boolean;
    readonly placeholder?: PublicKey;
  } = {},
): AnchorExtraAccountMeta {
  return extraAccountMetaForPubkey(
    options.placeholder ?? EXECUTOR_SLOT_PLACEHOLDER_KEY,
    options.isSigner ?? true,
    options.isWritable ?? true,
  );
}

/** A metas list plus the `executor_slot` that goes with it. */
export interface ExecutorSlotRules {
  /** Pass as `registerJob({ extraMetas })`. */
  readonly extraMetas: AnchorExtraAccountMeta[];
  /** Pass as `registerJob({ params: { executorSlot } })`. */
  readonly executorSlot: number;
}

/**
 * Build the "payer first" forwarded list — the DMV `begin_execution` shape, and
 * the mock target's `begin_log`:
 *
 * | # | account | `is_signer` | `is_writable` |
 * |---|---|---|---|
 * | 0 | the executor, via `executorSlot = 0` | `true` | `true` |
 * | 1.. | `rest`, verbatim | as given | as given |
 *
 * The executor's position comes first because that is where a target that funds
 * an `init` puts its payer, which also makes `executor_slot` the smallest index
 * a registrar can get wrong. The two halves — the placeholder rule and the
 * `executor_slot` byte — are returned together because they are only ever
 * correct together: a list built without the matching slot forwards a
 * meaningless placeholder key, and a slot without the matching rule points at
 * whatever happens to be at index 0.
 */
export function extraAccountMetasWithExecutorFirst(
  rest: readonly AnchorExtraAccountMeta[],
  options: {
    readonly isSigner?: boolean;
    readonly isWritable?: boolean;
    readonly placeholder?: PublicKey;
  } = {},
): ExecutorSlotRules {
  return {
    extraMetas: [extraAccountMetaForExecutor(options), ...rest],
    executorSlot: 0,
  };
}

/** A pubkey read out of data — `ExtraAccountMeta::new_with_pubkey_data`. */
export function extraAccountMetaForPubkeyData(
  config: PubkeyDataConfig,
  isSigner: boolean,
  isWritable: boolean,
): AnchorExtraAccountMeta {
  return {
    discriminator: ExtraAccountMetaKind.PubkeyData,
    addressConfig: packPubkeyDataIntoAddressConfig(config),
    isSigner,
    isWritable,
  };
}

// ---------------------------------------------------------------------------
// Wire form
// ---------------------------------------------------------------------------

/**
 * The 35-byte wire form: `discriminator | address_config | is_signer | is_writable`.
 *
 * Identical under Borsh (the instruction argument) and under `bytemuck` (the
 * `PodSlice` inside `JobMetas`), which is why one encoder serves both.
 */
export function encodeExtraAccountMeta(meta: AnchorExtraAccountMeta): Uint8Array {
  if (meta.addressConfig.length !== ADDRESS_CONFIG_LEN) {
    throw new RangeError(
      `address_config must be ${ADDRESS_CONFIG_LEN} bytes, got ${meta.addressConfig.length}`,
    );
  }
  return concatBytes([
    encodeU8(meta.discriminator, 'meta discriminator'),
    meta.addressConfig,
    encodeBool(meta.isSigner),
    encodeBool(meta.isWritable),
  ]);
}

export function decodeExtraAccountMeta(data: Uint8Array, offset = 0): AnchorExtraAccountMeta {
  const entry = sliceExact(data, offset, EXTRA_ACCOUNT_META_LEN, 'ExtraAccountMeta');
  return {
    discriminator: decodeU8(entry, 0, 'meta discriminator'),
    addressConfig: Uint8Array.from(sliceExact(entry, 1, ADDRESS_CONFIG_LEN, 'address_config')),
    isSigner: decodeU8(entry, 1 + ADDRESS_CONFIG_LEN, 'is_signer') !== 0,
    isWritable: decodeU8(entry, 2 + ADDRESS_CONFIG_LEN, 'is_writable') !== 0,
  };
}

/** The Borsh `Vec<AnchorExtraAccountMeta>` `register_job` takes as its third argument. */
export function encodeExtraAccountMetas(metas: readonly AnchorExtraAccountMeta[]): Uint8Array {
  if (metas.length > MAX_EXTRA_METAS) {
    throw new RangeError(
      `extra_metas has ${metas.length} entries, exceeding MAX_EXTRA_METAS (${MAX_EXTRA_METAS}) — ` +
        'register_job would reject this with TooManyMetas',
    );
  }
  return concatBytes([
    encodeU32LE(metas.length, 'extra_metas length'),
    ...metas.map(encodeExtraAccountMeta),
  ]);
}

// ---------------------------------------------------------------------------
// Reading the blob back out of a `JobMetas` account
// ---------------------------------------------------------------------------

/**
 * `JobMetas::tlv_bytes` — everything from `JOB_METAS_TLV_OFFSET` onward.
 *
 * Takes the account's full data. The Anchor discriminator is NOT checked here;
 * {@link decodeJobMetas} does that.
 */
export function jobMetasTlvBytes(accountData: Uint8Array): Uint8Array {
  if (accountData.length < JOB_METAS_TLV_OFFSET) {
    throw new RangeError(
      `JobMetas account is ${accountData.length} bytes, shorter than its ${JOB_METAS_TLV_OFFSET}-byte header`,
    );
  }
  return accountData.subarray(JOB_METAS_TLV_OFFSET);
}

/**
 * Walk the TLV framing for this program's entry and unpack the `PodSlice`.
 *
 * Mirrors `TlvStateBorrowed::get_first_bytes::<JobMetasEntry>` followed by
 * `PodSlice::<ExtraAccountMeta>::unpack`. Each TLV entry is an 8-byte type tag,
 * a 4-byte little-endian length, then the value; an all-zero tag marks
 * uninitialized space and ends the walk.
 */
export function decodeExtraAccountMetaList(tlv: Uint8Array): AnchorExtraAccountMeta[] {
  let start = 0;
  while (start < tlv.length) {
    if (start + TLV_BASE_LEN > tlv.length) {
      throw new RangeError('JobMetas TLV: truncated entry header');
    }
    const tag = tlv.subarray(start, start + TLV_DISCRIMINATOR_LEN);
    if (tag.every((b) => b === 0)) {
      throw new Error(
        `JobMetas TLV: no entry tagged ${toHex(JOB_METAS_TLV_DISCRIMINATOR)} ` +
          '(hit uninitialized space) — is this a JobMetas account of this program?',
      );
    }

    const valueLen = decodeU32LE(tlv, start + TLV_DISCRIMINATOR_LEN, 'TLV length');
    const valueStart = start + TLV_BASE_LEN;

    if (bytesEqual(tag, JOB_METAS_TLV_DISCRIMINATOR)) {
      return unpackExtraAccountMetaPodSlice(
        sliceExact(tlv, valueStart, valueLen, 'JobMetas TLV value'),
      );
    }
    start = valueStart + valueLen;
  }

  throw new Error(
    `JobMetas TLV: no entry tagged ${toHex(JOB_METAS_TLV_DISCRIMINATOR)} in ${tlv.length} bytes`,
  );
}

function unpackExtraAccountMetaPodSlice(value: Uint8Array): AnchorExtraAccountMeta[] {
  const count = decodeU32LE(value, 0, 'PodSlice length');
  const metas: AnchorExtraAccountMeta[] = [];
  for (let i = 0; i < count; i += 1) {
    metas.push(
      decodeExtraAccountMeta(value, POD_SLICE_LENGTH_LEN + i * EXTRA_ACCOUNT_META_LEN),
    );
  }
  return metas;
}

/** A decoded `JobMetas` account (spec §3.2). */
export interface JobMetasAccount {
  readonly bump: number;
  readonly metas: AnchorExtraAccountMeta[];
}

/**
 * Decode a whole `JobMetas` account: discriminator check, `bump`, TLV list.
 *
 * The account's own size is cross-checked against `JobMetas::space(n)` for the
 * decoded entry count — the same invariant `execute`'s `expected_meta_count`
 * relies on. A mismatch means the account was not written by `register_job`.
 */
export function decodeJobMetas(accountData: Uint8Array): JobMetasAccount {
  const found = sliceExact(accountData, 0, DISCRIMINATOR_LEN, 'JobMetas discriminator');
  if (!bytesEqual(found, JOB_METAS_DISCRIMINATOR)) {
    throw new Error(
      `not a JobMetas account: discriminator ${toHex(found)} != ${toHex(JOB_METAS_DISCRIMINATOR)}`,
    );
  }

  const tlv = jobMetasTlvBytes(accountData);
  const declared = expectedMetaCount(tlv.length);
  const metas = decodeExtraAccountMetaList(tlv);

  if (declared === undefined || declared !== metas.length) {
    throw new Error(
      `JobMetas is ${accountData.length} bytes (capacity ${String(declared)}) but holds ` +
        `${metas.length} entries — the account was not sized by register_job`,
    );
  }

  return { bump: decodeU8(accountData, OFF_JOB_METAS_BUMP, 'JobMetas bump'), metas };
}
