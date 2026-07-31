import { PublicKey } from '@solana/web3.js';
import { PROGRAM_ID } from '../utils/constants';
import { parseHeartbeatRecord } from '../utils/rawAccountParsers';
import {
  createHeartbeatConfirmationVerifier,
  type HeartbeatConfirmationVerifier,
} from './HeartbeatConfirmationVerifier';
import { VaultTransactionService } from './VaultTransactionService';

export function createDefaultHeartbeatConfirmationVerifier(): HeartbeatConfirmationVerifier {
  const transactions = new VaultTransactionService();
  const connection = transactions.getConnection();
  const programId = new PublicKey(PROGRAM_ID);

  return createHeartbeatConfirmationVerifier({
    deriveHeartbeatPda: (vault) =>
      transactions.getHeartbeatPDA(vault),
    fetchAccount: async (heartbeat) => {
      const account = await connection.getAccountInfo(heartbeat);
      return account
        ? { owner: account.owner, data: Buffer.from(account.data) }
        : null;
    },
    parseHeartbeatAccount: (account) =>
      parseHeartbeatRecord(account, programId),
  });
}
