// Priority fee + explicit compute-unit limits for the permissionless crank.
//
// On mainnet a 0-priority-fee tx may never land under congestion, silently
// stalling the autonomous distribution; and the implicit 200k CU default is
// tight for execute_token_shares (up to 8 transfer_checked CPIs, more on
// transfer-fee / transfer-hook mints). Both are ComputeBudget instructions,
// ~52 bytes total — the heaviest crank tx stays well under the 1232-byte limit
// (~671 B, verified; ATA-creates are separate txs and the batch stays at 8).
import { ComputeBudgetProgram } from '@solana/web3.js';

// Per-instruction CU limits. The priority fee is billed on the REQUESTED limit,
// so keep these tight rather than a blanket 1.4M. execute_token_shares carries
// extra headroom for Token-2022 transfer-fee / (future) transfer-hook CPIs.
export const CU = {
  beginExecution: 150_000,
  beginTokenDist: 150_000,
  executeSpecificSol: 120_000,
  executeSpecificAsset: 200_000,
  executeSolShares: 250_000,
  executeTokenShares: 300_000,
  finalize: 120_000,
  closeTokenDist: 150_000,
  closeExecutedVault: 100_000,
  ensureAta: 80_000,
};

const DEFAULT_FEE = 1000; // µLamports/CU — static fallback

/**
 * Best-effort priority fee (µLamports/CU). **NEVER THROWS** — a throw here would
 * break third-party keepers on non-Helius RPCs and the stress harness (which
 * injects 429s). Tries Helius `getPriorityFeeEstimate` → universal
 * `getRecentPrioritizationFees` → static default.
 */
export async function getPriorityFee(connection, rpcUrl) {
  try {
    // 1. Helius getPriorityFeeEstimate (keyed by the RPC URL; no separate key).
    if (rpcUrl) {
      try {
        const res = await fetch(rpcUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getPriorityFeeEstimate',
            params: [{ options: { recommended: true } }],
          }),
        });
        const json = await res.json();
        const est = json?.result?.priorityFeeEstimate;
        if (typeof est === 'number' && est > 0) return Math.ceil(est);
      } catch {
        /* not Helius / network error — fall through */
      }
    }
    // 2. Universal getRecentPrioritizationFees (the local test-validator returns []).
    try {
      const fees = await connection.getRecentPrioritizationFees();
      const vals = (fees ?? []).map((f) => f.prioritizationFee).filter((v) => v > 0);
      if (vals.length) {
        vals.sort((a, b) => a - b);
        return Math.max(vals[Math.floor(vals.length / 2)], 1);
      }
    } catch {
      /* method unsupported by the RPC — fall through */
    }
  } catch {
    /* anything unexpected — fall through to the default */
  }
  return DEFAULT_FEE;
}

/**
 * The two ComputeBudget instructions to prepend to a crank tx. Defensive on the
 * fee value so an undefined/NaN never reaches setComputeUnitPrice.
 */
export function cuIxs(units, microLamports) {
  const fee = Number.isFinite(microLamports) && microLamports > 0 ? Math.ceil(microLamports) : DEFAULT_FEE;
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: fee }),
  ];
}
