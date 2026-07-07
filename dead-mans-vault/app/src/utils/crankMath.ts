// Pure, RN-free helpers for the permissionless-crank INDEX/BATCH math, extracted from
// VaultTransactionService + ExecutionService so they can be unit-tested under
// `node --test` (finding D5). Behavior-preserving: these are the exact inline
// definitions the services used, hoisted into one module. No React Native / expo /
// web3 imports — importable directly by the node test runner.

/** `[0, 1, …, n-1]` — the full beneficiary/assignment index list. */
export function range(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i);
}

/** Split `arr` into consecutive groups of at most `size` (the ≤8 payout batching that
 *  keeps each tx under the CU / 1232-byte limits). */
export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Beneficiary indices `[0, n)` whose bit is NOT set in a u32 paid-mask — the payouts
 *  still owed. `mask >>> i` is an UNSIGNED shift (the masks are u32, n ≤ 20). */
export function unpaidIndices(mask: number, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    if (((mask >>> i) & 1) === 0) out.push(i);
  }
  return out;
}

/** Full u32 beneficiary mask for `n` beneficiaries (n ≤ 20 in practice). Guards n ≥ 32
 *  against the `1 << 32` undefined-shift by clamping to all-ones. */
export function fullU32Mask(n: number): number {
  return n >= 32 ? 0xffffffff : (((1 << n) - 1) >>> 0);
}

/** Full u64 assignment mask for `n` assignments (n ≤ 64). Guards n ≥ 64 against the
 *  `1n << 64n` overflow by returning the full 64-bit all-ones. */
export function fullU64Mask(n: number): bigint {
  return n >= 64 ? 2n ** 64n - 1n : (1n << BigInt(n)) - 1n;
}
