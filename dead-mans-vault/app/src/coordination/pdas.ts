/**
 * PDA derivation for the Coordination Layer v0 program.
 *
 * Normative source: `docs/coordination-layer-v0-spec.md` §3.
 *
 *   §3.1  Job       — PDA ["job", authority, job_id.to_le_bytes()]
 *   §3.2  JobMetas  — PDA ["job-metas", job]
 *   §3.3  Escrow    — PDA ["escrow", job]
 *
 * All PDA seeds live under the coordination program ID (§2).
 *
 * Encoding note (§2): "Integers little-endian (Borsh default); slots and
 * lamports u64." `job_id` is a u64 and therefore contributes exactly 8
 * LITTLE-ENDIAN bytes to the Job seed — `job_id.to_le_bytes()` in Rust.
 * Getting this backwards produces a syntactically valid but wrong PDA that
 * the program will reject at `init`, so it is unit-tested explicitly.
 *
 * Runtime note: @solana/web3.js v1 needs a global `Buffer` inside
 * findProgramAddressSync. Run every consumer (and every test) in a Node-like
 * environment — see vitest.config.ts. React Native satisfies this: DMV's
 * `src/polyfills.ts` installs `global.Buffer` from the `buffer` package.
 */

import { PublicKey } from '@solana/web3.js';

import { U64_LEN, encodeU64LE } from './borsh';
import { PROGRAM_ID } from './layout';

/** Seed literals exactly as they appear in the Rust `seeds = [...]` attributes. */
export const JOB_SEED_STR = 'job';
export const JOB_METAS_SEED_STR = 'job-metas';
export const ESCROW_SEED_STR = 'escrow';

/**
 * ASCII → bytes, without `TextEncoder`.
 *
 * !! A3.0, same class of bug as DECISIONS 19's `node:crypto` !!  These three
 * seeds are encoded at **module scope**, so whatever they call runs on import —
 * a missing global does not degrade some feature, it throws before any of this
 * package's code can run. `TextEncoder` is the wrong thing to call there in the
 * Expo/React Native target: DMV's `src/polyfills.ts` installs `Buffer`,
 * `structuredClone` and `crypto.getRandomValues` but **not** `TextEncoder`, and
 * DMV's own `NotificationRegistrationService` carries the note "TextEncoder is
 * NOT guaranteed in React Native" plus a regression test that deletes the global
 * to prove its signing path survives without one.
 *
 * All three seed literals are pure ASCII (`job`, `job-metas`, `escrow`), where
 * UTF-8 is one byte per code unit, so this loop is byte-identical to
 * `new TextEncoder().encode(...)` — `src/__tests__/pdas.test.ts` asserts exactly
 * that against the real `TextEncoder` under Node. The `> 0x7f` guard is what
 * keeps the claim honest: add a non-ASCII seed and this throws at import rather
 * than silently deriving a PDA from truncated bytes, which would be a wrong,
 * valid-looking address the program rejects at `init`.
 *
 * Do not "simplify" this back to `TextEncoder`, and do not reach for `Buffer`
 * either — a seed encoder is the last thing that should depend on a polyfill
 * having been imported first.
 */
function asciiSeed(literal: string): Uint8Array {
  const bytes = new Uint8Array(literal.length);
  for (let i = 0; i < literal.length; i += 1) {
    const code = literal.charCodeAt(i);
    if (code > 0x7f) {
      throw new RangeError(`PDA seed ${JSON.stringify(literal)} is not ASCII at index ${i}`);
    }
    bytes[i] = code;
  }
  return bytes;
}

/** UTF-8 encodings of the seed literals — the bytes actually hashed. */
export const JOB_SEED: Uint8Array = asciiSeed(JOB_SEED_STR);
export const JOB_METAS_SEED: Uint8Array = asciiSeed(JOB_METAS_SEED_STR);
export const ESCROW_SEED: Uint8Array = asciiSeed(ESCROW_SEED_STR);

/** Width in bytes of the `job_id` seed component (u64). */
export const JOB_ID_SEED_LEN = U64_LEN;

/**
 * Encode a `job_id` as the 8 little-endian bytes the Job PDA seed requires.
 *
 * Accepts a bigint (preferred — u64 exceeds Number.MAX_SAFE_INTEGER) or a
 * non-negative safe-integer number. Out-of-range or non-integral input throws
 * rather than silently truncating: a truncated job_id derives a *different,
 * valid-looking* address, which is the worst possible failure mode here.
 *
 * Delegates to `encodeU64LE` so this seed and the `job_id` instruction argument
 * in `./instructions.ts` can never disagree about the encoding — they are the
 * same eight bytes, and `register_job`'s `seeds = [.., &job_id.to_le_bytes()]`
 * makes that a hard requirement rather than a nicety.
 */
export function encodeJobIdSeed(jobId: bigint | number): Uint8Array {
  return encodeU64LE(jobId, 'job_id');
}

/** `["job", authority, job_id.to_le_bytes()]` — spec §3.1. */
export function findJobPda(
  authority: PublicKey,
  jobId: bigint | number,
  programId: PublicKey = PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [JOB_SEED, authority.toBuffer(), encodeJobIdSeed(jobId)],
    programId,
  );
}

/** `["job-metas", job]` — spec §3.2. */
export function findJobMetasPda(
  job: PublicKey,
  programId: PublicKey = PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([JOB_METAS_SEED, job.toBuffer()], programId);
}

/** `["escrow", job]` — spec §3.3. */
export function findEscrowPda(
  job: PublicKey,
  programId: PublicKey = PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([ESCROW_SEED, job.toBuffer()], programId);
}

export interface JobPdas {
  job: PublicKey;
  jobBump: number;
  jobMetas: PublicKey;
  jobMetasBump: number;
  escrow: PublicKey;
  escrowBump: number;
}

/**
 * Derive all three accounts for one (authority, job_id) pair in one call.
 * `job_metas` and `escrow` hang off the *derived* Job address, never off the
 * authority — so a single Job seed error propagates to all three.
 */
export function findJobPdas(
  authority: PublicKey,
  jobId: bigint | number,
  programId: PublicKey = PROGRAM_ID,
): JobPdas {
  const [job, jobBump] = findJobPda(authority, jobId, programId);
  const [jobMetas, jobMetasBump] = findJobMetasPda(job, programId);
  const [escrow, escrowBump] = findEscrowPda(job, programId);
  return { job, jobBump, jobMetas, jobMetasBump, escrow, escrowBump };
}
