/**
 * Detector for Jupiter positions: JLP (Jupiter Liquidity Provider) token.
 * Token mint matching only — no program account scanning needed.
 */

import { PublicKey } from '@solana/web3.js';
import { DeFiPosition, TokenBalance } from '../../types/defi';
import { KNOWN_DEFI_MINTS } from '../registry';

export function detectJupiter(
  _wallet: PublicKey,
  tokenBalances: TokenBalance[],
): DeFiPosition[] {
  const positions: DeFiPosition[] = [];

  for (const balance of tokenBalances) {
    const mintStr = balance.mint.toString();
    const mintInfo = KNOWN_DEFI_MINTS[mintStr];
    if (!mintInfo || mintInfo.protocol !== 'jupiter') continue;
    if (balance.amount <= 0) continue;

    positions.push({
      protocol: 'jupiter',
      type: mintInfo.type,
      description: `${balance.amount.toFixed(4)} ${mintInfo.symbol} (${mintInfo.name})`,
      estimatedValueUsd: balance.usdValue,
      estimatedValueSol: 0,
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
