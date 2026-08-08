import { PublicKey } from '@solana/web3.js';
import { VaultTransactionService } from './VaultTransactionService';
import {
  needsAgentRotationForState,
} from './AgentMigrationFlow';
import { KeyManager } from '../tee/KeyManager';
import { DefaultAgentRotationService } from './DefaultAgentRotationService';

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

  static async reconcileRotation(ownerPubkey: PublicKey) {
    // Startup/focus repair is strictly read-only: the reconciler has no
    // transaction builder, signer, wallet callback or send dependency.
    return new DefaultAgentRotationService().reconcileForOwner(
      ownerPubkey,
    );
  }
}
