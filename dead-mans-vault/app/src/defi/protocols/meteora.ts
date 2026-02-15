/**
 * Detector for Meteora DLMM (Dynamic Liquidity Market Maker) positions.
 * Scans the DLMM program for position accounts owned by the wallet.
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { DeFiPosition } from '../../types/defi';

const METEORA_DLMM_PROGRAM = new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');

export async function detectMeteora(
  connection: Connection,
  wallet: PublicKey,
): Promise<DeFiPosition[]> {
  const positions: DeFiPosition[] = [];

  try {
    // DLMM Position accounts have the owner at offset 8
    const accounts = await connection.getProgramAccounts(METEORA_DLMM_PROGRAM, {
      filters: [
        { memcmp: { offset: 8, bytes: wallet.toBase58() } },
      ],
      dataSlice: { offset: 0, length: 0 },
    });

    for (const account of accounts) {
      positions.push({
        protocol: 'meteora',
        type: 'dlmm_position',
        description: `Meteora DLMM position (${account.pubkey.toString().slice(0, 8)}...)`,
        estimatedValueUsd: 0,
        estimatedValueSol: 0,
        tokens: [],
        action: 'close',
        accountAddress: account.pubkey,
        closureStrategy: 'unsupported',
      });
    }
  } catch {
    // Meteora scan failure is non-fatal
  }

  return positions;
}
