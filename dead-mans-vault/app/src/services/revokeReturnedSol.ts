// Pure, dependency-free helper for the "SOL returned" summary of a vault revoke.
// Extracted from revokeVault so its fail-soft behavior is unit-testable without React
// Native imports (the balance reader is injected).
//
// The returned-SOL figures are COSMETIC — they are shown in the revoke summary only.
// Reading the post-close owner balance must NEVER reject a revoke whose on-chain close
// already succeeded: a transient RPC failure here (e.g. a 429 on the default RPC) used to
// throw out of `revokeVault`, so the caller's success path — which reconciles the local
// notification state after a close — was skipped, leaving a stale "enabled" for the closed
// vault. On any read failure or missing baseline, fail soft to unknown (0).
export async function computeReturnedSol(
  getBalanceAfter: () => Promise<number>,
  ownerBalBefore: number | null,
  agentRefundedSol: number,
  lamportsPerSol: number,
): Promise<{ totalReturnedSol: number; vaultReturnedSol: number }> {
  let ownerBalAfter: number | null = null;
  try {
    ownerBalAfter = await getBalanceAfter();
  } catch {
    ownerBalAfter = null; // cosmetic figure only — never fail the revoke on a balance-read error
  }
  if (
    ownerBalBefore == null ||
    ownerBalAfter == null ||
    !Number.isFinite(ownerBalBefore) ||
    !Number.isFinite(ownerBalAfter) ||
    !Number.isFinite(lamportsPerSol) ||
    lamportsPerSol <= 0
  ) {
    return { totalReturnedSol: 0, vaultReturnedSol: 0 };
  }
  const totalReturnedSol = Math.max(0, (ownerBalAfter - ownerBalBefore) / lamportsPerSol);
  const vaultReturnedSol = Math.max(0, totalReturnedSol - agentRefundedSol);
  return { totalReturnedSol, vaultReturnedSol };
}
