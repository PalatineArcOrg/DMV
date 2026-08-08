/** Existing vault-activation target for the device heartbeat agent. This is a
 * reliability recommendation, not an onchain minimum. */
export const AGENT_RECOMMENDED_RESERVE_LAMPORTS = 5_000_000;

export function calculateAgentTopUpLamports(
  balanceLamports: number,
  reserveTargetLamports: number = AGENT_RECOMMENDED_RESERVE_LAMPORTS,
): number {
  if (
    !Number.isSafeInteger(balanceLamports) ||
    balanceLamports < 0 ||
    !Number.isSafeInteger(reserveTargetLamports) ||
    reserveTargetLamports < 0
  ) {
    throw new Error('Agent top-up inputs must be safe non-negative integers');
  }
  return Math.max(0, reserveTargetLamports - balanceLamports);
}
