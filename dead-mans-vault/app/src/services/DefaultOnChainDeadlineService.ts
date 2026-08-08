import { PublicKey } from '@solana/web3.js';
import {
  EXPECTED_CLUSTER,
  PROGRAM_ID,
} from '../utils/constants';
import type { DeadlineStageDurations } from '../utils/deadlineStageConfig';
import {
  parseHeartbeatRecord,
  parseVaultConfig,
} from '../utils/rawAccountParsers';
import {
  createConfirmedChainTimeReader,
  createOnChainDeadlineService,
  type OnChainDeadlineService,
} from './OnChainDeadlineService';
import { VaultTransactionService } from './VaultTransactionService';

function monotonicNowMs(): number {
  const value = globalThis.performance?.now();
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error('monotonic clock unavailable');
  }
  return value;
}

export function createDefaultOnChainDeadlineService(
  stageDurations: DeadlineStageDurations,
): OnChainDeadlineService {
  const transactions = new VaultTransactionService();
  const connection = transactions.getConnection();
  const programId = new PublicKey(PROGRAM_ID);
  return createOnChainDeadlineService({
    cluster: EXPECTED_CLUSTER,
    programId,
    stageDurations,
    deriveVaultPda: (owner) => transactions.getVaultPDA(owner),
    deriveHeartbeatPda: (vault) =>
      transactions.getHeartbeatPDA(vault),
    fetchAccount: async (address, minContextSlot) => {
      const account = await connection.getAccountInfo(address, {
        commitment: 'confirmed',
        minContextSlot,
      });
      return account
        ? { owner: account.owner, data: Buffer.from(account.data) }
        : null;
    },
    parseVaultAccount: (account) =>
      parseVaultConfig(account, programId),
    parseHeartbeatAccount: (account) =>
      parseHeartbeatRecord(account, programId),
    getConfirmedChainTime: createConfirmedChainTimeReader({
      getSlot: (commitment) => connection.getSlot(commitment),
      getBlockTime: (slot) => connection.getBlockTime(slot),
    }),
    monotonicNowMs,
  });
}

export function getMonotonicNowMs(): number {
  return monotonicNowMs();
}
