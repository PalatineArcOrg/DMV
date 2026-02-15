/**
 * Detector for liquid staking tokens: Marinade (mSOL), Jito (jitoSOL), Sanctum LSTs.
 * Zero RPC calls — just filters the already-fetched token balance list.
 */

import { PublicKey } from '@solana/web3.js';
import { DeFiPosition, TokenBalance } from '../../types/defi';
import { KNOWN_DEFI_MINTS, MintInfo } from '../registry';

const LST_TYPES = new Set(['liquid_staking']);

export function detectLiquidStaking(
  _wallet: PublicKey,
  tokenBalances: TokenBalance[],
): DeFiPosition[] {
  const positions: DeFiPosition[] = [];

  for (const balance of tokenBalances) {
    const mintStr = balance.mint.toString();
    const mintInfo: MintInfo | undefined = KNOWN_DEFI_MINTS[mintStr];
    if (!mintInfo || !LST_TYPES.has(mintInfo.type)) continue;
    if (balance.amount <= 0) continue;

    positions.push({
      protocol: mintInfo.protocol,
      type: mintInfo.type,
      description: `${balance.amount.toFixed(4)} ${mintInfo.symbol} (${mintInfo.name})`,
      estimatedValueUsd: balance.usdValue,
      estimatedValueSol: 0, // filled by detector orchestrator
      tokens: [balance],
      action: 'close',
      accountAddress: balance.mint,
      closureStrategy: mintInfo.closureStrategy,
      tokenMint: mintStr,
      tokenAmount: balance.amount,
      tokenDecimals: mintInfo.decimals,
    });
  }

  return positions;
}
