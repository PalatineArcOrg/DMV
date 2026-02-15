/**
 * Detector for Kamino positions: kTokens (vault shares) and kLend accounts.
 * Layer 1: token mint matching for known kTokens.
 * Layer 2: scan Kamino Lending program for accounts owned by wallet.
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { DeFiPosition, TokenBalance } from '../../types/defi';
import { KNOWN_DEFI_MINTS, PROTOCOL_PROGRAMS } from '../registry';

const KAMINO_LENDING_PROGRAM = 'KLend2g3cP87ber41GhHvvPG7Lo2MdixiMwzLTowbhJg';

export async function detectKamino(
  connection: Connection,
  wallet: PublicKey,
  tokenBalances: TokenBalance[],
): Promise<DeFiPosition[]> {
  const positions: DeFiPosition[] = [];

  // Layer 1: Check token balances for known Kamino kToken mints
  for (const balance of tokenBalances) {
    const mintStr = balance.mint.toString();
    const mintInfo = KNOWN_DEFI_MINTS[mintStr];
    if (!mintInfo || mintInfo.protocol !== 'kamino') continue;
    if (balance.amount <= 0) continue;

    positions.push({
      protocol: 'kamino',
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

  // Layer 2: Scan Kamino Lending program for obligation accounts
  try {
    const programId = new PublicKey(KAMINO_LENDING_PROGRAM);
    const accounts = await connection.getProgramAccounts(programId, {
      filters: [
        { memcmp: { offset: 40, bytes: wallet.toBase58() } }, // obligation owner offset
      ],
      dataSlice: { offset: 0, length: 0 }, // we only need to know they exist
    });

    for (const account of accounts) {
      // Avoid duplicating if we already found kTokens
      const alreadyDetected = positions.some(
        (p) => p.accountAddress.toString() === account.pubkey.toString(),
      );
      if (alreadyDetected) continue;

      positions.push({
        protocol: 'kamino',
        type: 'lending',
        description: `Kamino Lending position (${account.pubkey.toString().slice(0, 8)}...)`,
        estimatedValueUsd: 0,
        estimatedValueSol: 0,
        tokens: [],
        action: 'close',
        accountAddress: account.pubkey,
        closureStrategy: 'unsupported',
      });
    }
  } catch {
    // Kamino lending scan failure is non-fatal
  }

  return positions;
}
