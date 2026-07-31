import { PublicKey } from '@solana/web3.js';
import { KeyManager } from '../tee/KeyManager';
import { VaultTransactionService } from './VaultTransactionService';
import {
  executeCurrentAgentRotation,
  needsAgentRotationForState,
} from './AgentMigrationFlow';

export class MigrationService {
  static async needsAgentRotation(ownerPubkey: PublicKey): Promise<boolean> {
    const txService = new VaultTransactionService();
    const vaultData = await txService.fetchVaultConfig(ownerPubkey);

    if (!vaultData || vaultData.executed || !vaultData.active) return false;

    const keyManager = KeyManager.getInstance();
    const hasKey = await keyManager.hasAgentKey();
    const localPubkey = hasKey
      ? await keyManager.getAgentPublicKey()
      : null;

    return needsAgentRotationForState(
      {
        active: vaultData.active,
        executed: vaultData.executed,
        agentPublicKey: vaultData.agentPubkey.toBase58(),
      },
      hasKey,
      localPubkey,
    );
  }

  static async executeRotation(
    ownerPubkey: PublicKey,
    signAndSendTransaction: (tx: any) => Promise<string>,
  ): Promise<{ newPubkey: string; txSig: string }> {
    const keyManager = KeyManager.getInstance();
    const txService = new VaultTransactionService();
    const connection = txService.getConnection();

    return executeCurrentAgentRotation({
      destroyActiveAgentKey: () => keyManager.destroyKey(),
      generateReplacementAgentKey: () => keyManager.generateAgentKey(),
      buildRotationTransaction: (newPubkey) =>
        txService.buildRotateAgentTx(
          ownerPubkey,
          new PublicKey(newPubkey),
        ),
      prepareRotationTransaction: async (transaction) => {
        transaction.feePayer = ownerPubkey;
        const { blockhash, lastValidBlockHeight } =
          await connection.getLatestBlockhash();
        transaction.recentBlockhash = blockhash;
        return { transaction, blockhash, lastValidBlockHeight };
      },
      signAndSendTransaction,
      confirmRotation: async (strategy) => {
        await connection.confirmTransaction(strategy, 'confirmed');
      },
    });
  }
}
