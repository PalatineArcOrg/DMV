/**
 * Little-endian / Borsh primitives — the encode-decode floor every other module
 * in this package sits on.
 *
 * Normative source: `docs/coordination-layer-v0-spec.md` §2 — "Integers
 * little-endian (Borsh default); slots and lamports `u64`."
 *
 * ## Why every u64 is a `bigint`
 *
 * `number` is an IEEE-754 double and silently loses integer precision above
 * 2^53. Every quantity this program stores in a `u64` can legitimately exceed
 * that: `reward_max` may be `u64::MAX` (the §4 saturation tests use exactly
 * that), `job_id` is authority-chosen, and `next_due_slot` is the field
 * `findDueJobs` memcmp-filters on. A truncated u64 does not throw — it produces
 * a valid-looking, *wrong* filter or a valid-looking, wrong PDA. Same failure
 * class as encoding a seed big-endian, so it is handled the same way: convert
 * through `bigint`, range-check, and throw rather than truncate.
 *
 * ## Why this is the whole encoder
 *
 * Borsh, restricted to the types this program's instructions actually use, is:
 * fixed-width little-endian integers, raw 32-byte pubkeys, one byte per `bool`,
 * and a `u32` little-endian length prefix on `Vec<T>`. No padding, no
 * alignment, no self-describing tags. That is why the `Job` offsets in
 * `./layout.ts` are a running sum of field widths, and why this module needs no
 * schema machinery.
 */

import { PublicKey } from '@solana/web3.js';

/** Serialized widths, in bytes. */
export const U8_LEN = 1;
export const U16_LEN = 2;
export const U32_LEN = 4;
export const U64_LEN = 8;
export const BOOL_LEN = 1;
export const PUBKEY_LEN = 32;

/** Inclusive upper bounds of the unsigned integer types used here. */
export const U8_MAX = 0xff;
export const U16_MAX = 0xffff;
export const U32_MAX = 0xffff_ffff;
export const U64_MAX = (1n << 64n) - 1n;

/**
 * Normalise a caller-supplied u64 to a range-checked `bigint`.
 *
 * Accepts a `bigint` (preferred) or a non-negative safe-integer `number`.
 * Anything else throws: a `TypeError` for a non-integral `number`, a
 * `RangeError` for one past `Number.MAX_SAFE_INTEGER` (where the value has
 * already lost precision before this function ever saw it) or for a value
 * outside `[0, u64::MAX]`.
 */
export function toU64(value: bigint | number, label = 'u64'): bigint {
  let out: bigint;
  if (typeof value === 'bigint') {
    out = value;
  } else {
    if (!Number.isInteger(value)) {
      throw new TypeError(`${label} must be an integer, got ${value}`);
    }
    if (!Number.isSafeInteger(value)) {
      throw new RangeError(
        `${label} ${value} exceeds Number.MAX_SAFE_INTEGER; pass a bigint instead`,
      );
    }
    out = BigInt(value);
  }
  if (out < 0n || out > U64_MAX) {
    throw new RangeError(`${label} ${out} out of u64 range [0, ${U64_MAX}]`);
  }
  return out;
}

/**
 * Normalise a caller-supplied small unsigned integer (u8/u16/u32).
 *
 * These stay `number` — none of them can exceed 2^53, so there is no precision
 * trap and forcing callers to write `50n` for a window length would be noise.
 */
export function toUint(value: number | bigint, max: number, label: string): number {
  const out = typeof value === 'bigint' ? Number(value) : value;
  if (!Number.isInteger(out)) {
    throw new TypeError(`${label} must be an integer, got ${String(value)}`);
  }
  if (out < 0 || out > max) {
    throw new RangeError(`${label} ${out} out of range [0, ${max}]`);
  }
  return out;
}

/**
 * A `DataView` over exactly the bytes of `data`.
 *
 * `data.byteOffset` / `data.byteLength` are mandatory: a `Uint8Array` produced
 * by `subarray` (which this module uses for zero-copy slices) shares its
 * parent's `ArrayBuffer`, and a `DataView` built from `data.buffer` alone would
 * silently read the parent from index 0.
 */
function view(data: Uint8Array): DataView {
  return new DataView(data.buffer, data.byteOffset, data.byteLength);
}

/** Bounds check with a message that names the field, not just the offset. */
function requireBytes(data: Uint8Array, offset: number, length: number, what: string): void {
  if (offset < 0 || length < 0 || offset + length > data.length) {
    throw new RangeError(
      `${what}: need ${length} byte(s) at offset ${offset}, buffer is ${data.length} byte(s)`,
    );
  }
}

// ---------------------------------------------------------------------------
// encode
// ---------------------------------------------------------------------------

export function encodeU8(value: number | bigint, label = 'u8'): Uint8Array {
  return new Uint8Array([toUint(value, U8_MAX, label)]);
}

export function encodeBool(value: boolean): Uint8Array {
  // Borsh encodes `bool` as a single byte, 0 or 1 — the same byte the
  // `PodBool` in `spl_tlv_account_resolution::account::ExtraAccountMeta`
  // occupies (see `AnchorExtraAccountMeta`'s type docs in register_job.rs).
  return new Uint8Array([value ? 1 : 0]);
}

export function encodeU16LE(value: number | bigint, label = 'u16'): Uint8Array {
  const bytes = new Uint8Array(U16_LEN);
  view(bytes).setUint16(0, toUint(value, U16_MAX, label), true);
  return bytes;
}

export function encodeU32LE(value: number | bigint, label = 'u32'): Uint8Array {
  const bytes = new Uint8Array(U32_LEN);
  view(bytes).setUint32(0, toUint(value, U32_MAX, label), true);
  return bytes;
}

export function encodeU64LE(value: bigint | number, label = 'u64'): Uint8Array {
  const bytes = new Uint8Array(U64_LEN);
  view(bytes).setBigUint64(0, toU64(value, label), true);
  return bytes;
}

/** A Borsh `Vec<u8>`: a `u32` little-endian length prefix, then the raw bytes. */
export function encodeBytesVec(bytes: Uint8Array): Uint8Array {
  return concatBytes([encodeU32LE(bytes.length, 'Vec<u8> length'), bytes]);
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;

  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// decode
// ---------------------------------------------------------------------------

export function decodeU8(data: Uint8Array, offset: number, what = 'u8'): number {
  requireBytes(data, offset, U8_LEN, what);
  return view(data).getUint8(offset);
}

export function decodeU16LE(data: Uint8Array, offset: number, what = 'u16'): number {
  requireBytes(data, offset, U16_LEN, what);
  return view(data).getUint16(offset, true);
}

export function decodeU32LE(data: Uint8Array, offset: number, what = 'u32'): number {
  requireBytes(data, offset, U32_LEN, what);
  return view(data).getUint32(offset, true);
}

export function decodeU64LE(data: Uint8Array, offset: number, what = 'u64'): bigint {
  requireBytes(data, offset, U64_LEN, what);
  return view(data).getBigUint64(offset, true);
}

/** A zero-copy view of `length` bytes at `offset`, bounds-checked. */
export function sliceExact(
  data: Uint8Array,
  offset: number,
  length: number,
  what = 'slice',
): Uint8Array {
  requireBytes(data, offset, length, what);
  return data.subarray(offset, offset + length);
}

export function decodePubkey(data: Uint8Array, offset: number, what = 'pubkey'): PublicKey {
  // Copy rather than hand `subarray` to PublicKey: web3.js keeps the array it
  // is given, and a view into a shared account buffer would alias.
  return new PublicKey(Uint8Array.from(sliceExact(data, offset, PUBKEY_LEN, what)));
}

/** Constant-time-irrelevant, allocation-free byte equality. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** Lowercase hex, for error messages and known-answer test vectors. */
export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}
