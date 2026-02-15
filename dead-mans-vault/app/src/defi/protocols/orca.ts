/**
 * Detector for Orca Whirlpool concentrated liquidity positions.
 * Scans the Whirlpool program for position accounts owned by the wallet.
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { DeFiPosition } from '../../types/defi';

const ORCA_WHIRLPOOL_PROGRAM = new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');

export async function detectOrca(
  connection: Connection,
  wallet: PublicKey,
): Promise<DeFiPosition[]> {
  const positions: DeFiPosition[] = [];

  try {
    // Whirlpool position accounts have the position owner at offset 8
    const accounts = await connection.getProgramAccounts(ORCA_WHIRLPOOL_PROGRAM, {
      filters: [
        { dataSize: 216 }, // Position account size
        { memcmp: { offset: 8, bytes: wallet.toBase58() } },
      ],
      dataSlice: { offset: 0, length: 0 },
    });

    for (const account of accounts) {
      positions.push({
        protocol: 'orca',
        type: 'whirlpool_position',
        description: `Orca Whirlpool position (${account.pubkey.toString().slice(0, 8)}...)`,
        estimatedValueUsd: 0,
        estimatedValueSol: 0,
        tokens: [],
        action: 'close',
        accountAddress: account.pubkey,
        closureStrategy: 'unsupported',
      });
    }
  } catch {
    // Whirlpool scan failure is non-fatal
  }

  return positions;
}
