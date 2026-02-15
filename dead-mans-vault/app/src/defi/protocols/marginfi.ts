/**
 * Detector for MarginFi V2 lending/borrowing positions.
 * Scans the MarginFi program for marginfi accounts where the wallet is the authority.
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { DeFiPosition } from '../../types/defi';

const MARGINFI_PROGRAM = new PublicKey('MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA');

export async function detectMarginFi(
  connection: Connection,
  wallet: PublicKey,
): Promise<DeFiPosition[]> {
  const positions: DeFiPosition[] = [];

  try {
    // MarginFi account has authority at offset 40 (after discriminator + group)
    const accounts = await connection.getProgramAccounts(MARGINFI_PROGRAM, {
      filters: [
        { memcmp: { offset: 40, bytes: wallet.toBase58() } },
      ],
      dataSlice: { offset: 0, length: 0 },
    });

    for (const account of accounts) {
      positions.push({
        protocol: 'marginfi',
        type: 'lending',
        description: `MarginFi lending account (${account.pubkey.toString().slice(0, 8)}...)`,
        estimatedValueUsd: 0,
        estimatedValueSol: 0,
        tokens: [],
        action: 'close',
        accountAddress: account.pubkey,
        closureStrategy: 'unsupported',
      });
    }
  } catch {
    // MarginFi scan failure is non-fatal
  }

  return positions;
}
