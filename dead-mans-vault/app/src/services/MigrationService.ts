import { PublicKey } from '@solana/web3.js';
import { KeyManager } from '../tee/KeyManager';
import { VaultTransactionService } from './VaultTransactionService';

export class MigrationService {
  static async needsAgentRotation(ownerPubkey: PublicKey): Promise<boolean> {
    const txService = new VaultTransactionService();
    const vaultData = await txService.fetchVaultConfig(ownerPubkey);

    // No vault on-chain — no rotation needed
    if (!vaultData) return false;

    // Vault is executed or inactive — no rotation needed
    if (vaultData.executed || !vaultData.active) return false;

    const keyManager = KeyManager.getInstance();
    const hasKey = await keyManager.hasAgentKey();

    if (!hasKey) return true;

    // Key exists but doesn't match on-chain agent
    const localPubkey = await keyManager.getAgentPublicKey();
    const onChainAgent = vaultData.agentPubkey.toBase58();

    return localPubkey !== onChainAgent;
  }

  static async executeRotation(
    ownerPubkey: PublicKey,
    signAndSendTransaction: (tx: any) => Promise<string>,
  ): Promise<{ newPubkey: string; txSig: string }> {
    const keyManager = KeyManager.getInstance();

    // Destroy stale key if it exists
    await keyManager.destroyKey();

    // Generate new agent key
    const newPubkey = await keyManager.generateAgentKey();
    const newAgentPk = new PublicKey(newPubkey);

    // Build rotate_agent transaction (owner-signed via MWA)
    const txService = new VaultTransactionService();
    const tx = await txService.buildRotateAgentTx(ownerPubkey, newAgentPk);

    tx.feePayer = ownerPubkey;
    const { blockhash } = await txService.getConnection().getLatestBlockhash();
    tx.recentBlockhash = blockhash;

    const txSig = await signAndSendTransaction(tx);

    return { newPubkey, txSig };
  }
}
