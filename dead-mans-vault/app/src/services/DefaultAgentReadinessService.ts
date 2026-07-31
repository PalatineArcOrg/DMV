import { PublicKey } from '@solana/web3.js';
import { KeyManager } from '../tee/KeyManager';
import { PROGRAM_ID } from '../utils/constants';
import {
  parseHeartbeatRecord,
  parseVaultConfig,
} from '../utils/rawAccountParsers';
import {
  createAgentReadinessService,
  type AgentReadinessService,
} from './AgentReadinessService';
import { VaultTransactionService } from './VaultTransactionService';

const MISSING_AGENT_KEY_MESSAGE = 'No agent key found in secure store';

function isMissingAgentKeyError(error: unknown): boolean {
  return error instanceof Error && error.message === MISSING_AGENT_KEY_MESSAGE;
}

export function createDefaultAgentReadinessService(): AgentReadinessService {
  const transactions = new VaultTransactionService();
  const connection = transactions.getConnection();
  const programId = new PublicKey(PROGRAM_ID);

  return createAgentReadinessService({
    deriveVaultPda: (owner) => transactions.getVaultPDA(owner),
    deriveHeartbeatPda: (vault) =>
      transactions.getHeartbeatPDA(vault),
    fetchAccount: async (address) => {
      const account = await connection.getAccountInfo(address);
      return account
        ? { owner: account.owner, data: Buffer.from(account.data) }
        : null;
    },
    parseVaultAccount: (account) =>
      parseVaultConfig(account, programId),
    parseHeartbeatAccount: (account) =>
      parseHeartbeatRecord(account, programId),
    loadAgentKeypair: () => KeyManager.getInstance().getKeypair(),
    isMissingAgentError: isMissingAgentKeyError,
  });
}
