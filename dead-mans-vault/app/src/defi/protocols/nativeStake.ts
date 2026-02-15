/**
 * Detector for native SOL stake accounts.
 * Queries the Stake program for accounts with the wallet as authorized staker.
 */

import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { DeFiPosition } from '../../types/defi';

const STAKE_PROGRAM = new PublicKey('Stake11111111111111111111111111111111111111');

export async function detectNativeStake(
  connection: Connection,
  wallet: PublicKey,
): Promise<DeFiPosition[]> {
  const stakeAccounts = await connection.getParsedProgramAccounts(
    STAKE_PROGRAM,
    { filters: [{ memcmp: { offset: 12, bytes: wallet.toBase58() } }] },
  );

  return stakeAccounts.map((account) => {
    const parsed = (account.account.data as any)?.parsed;
    const stakeInfo = parsed?.info?.stake;
    const lamports = account.account.lamports;
    const solAmount = lamports / LAMPORTS_PER_SOL;
    const delegation = stakeInfo?.delegation;
    const validator = delegation?.voter
      ? `Validator: ${delegation.voter.toString().slice(0, 8)}...`
      : '';

    return {
      protocol: 'native_stake' as const,
      type: 'staking',
      description: `${solAmount.toFixed(4)} SOL staked${validator ? ` (${validator})` : ''} — ${account.pubkey.toString().slice(0, 8)}...`,
      estimatedValueUsd: 0,
      estimatedValueSol: solAmount,
      tokens: [],
      action: 'close' as const,
      accountAddress: account.pubkey,
      closureStrategy: 'protocol_native' as const,
      tokenAmount: solAmount,
    };
  });
}
