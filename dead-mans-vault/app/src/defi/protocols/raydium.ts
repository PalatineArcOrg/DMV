/**
 * Detector for Raydium positions: LP tokens and AMM/CLMM position accounts.
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { DeFiPosition, TokenBalance } from '../../types/defi';
import { KNOWN_DEFI_MINTS, PROTOCOL_PROGRAMS } from '../registry';

const RAYDIUM_AMM_V4 = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
const RAYDIUM_CLMM = 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK';

export async function detectRaydium(
  connection: Connection,
  wallet: PublicKey,
  tokenBalances: TokenBalance[],
): Promise<DeFiPosition[]> {
  const positions: DeFiPosition[] = [];

  // Layer 1: Check token balances for known Raydium LP mints
  for (const balance of tokenBalances) {
    const mintStr = balance.mint.toString();
    const mintInfo = KNOWN_DEFI_MINTS[mintStr];
    if (!mintInfo || mintInfo.protocol !== 'raydium') continue;
    if (balance.amount <= 0) continue;

    positions.push({
      protocol: 'raydium',
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

  // Layer 2: Scan CLMM program for position accounts owned by wallet
  try {
    const clmmProgram = new PublicKey(RAYDIUM_CLMM);
    const accounts = await connection.getProgramAccounts(clmmProgram, {
      filters: [
        { dataSize: 216 }, // PersonalPosition account size
        { memcmp: { offset: 8, bytes: wallet.toBase58() } }, // owner field
      ],
      dataSlice: { offset: 0, length: 0 },
    });

    for (const account of accounts) {
      positions.push({
        protocol: 'raydium',
        type: 'clmm_position',
        description: `Raydium CLMM position (${account.pubkey.toString().slice(0, 8)}...)`,
        estimatedValueUsd: 0,
        estimatedValueSol: 0,
        tokens: [],
        action: 'close',
        accountAddress: account.pubkey,
        closureStrategy: 'unsupported',
      });
    }
  } catch {
    // CLMM scan failure is non-fatal
  }

  return positions;
}
