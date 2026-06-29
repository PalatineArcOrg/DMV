import { PublicKey, Transaction } from '@solana/web3.js';
import { VaultTransactionService } from './VaultTransactionService';
import { KeyManager } from '../tee/KeyManager';
import { useVaultStore } from '../store/useVaultStore';
import { useHeartbeatStore } from '../store/useHeartbeatStore';
import { useEscalationStore } from '../store/useEscalationStore';

/**
 * Result of a vault revoke. `revoked` means an active vault was withdrawn +
 * closed on-chain this call; `cleared` means there was nothing active to revoke
 * (already executed / inactive / PDAs already closed) and only local cleanup ran.
 */
export type RevokeResult =
  | {
      status: 'revoked';
      assetCount: number;
      txSig: string;
      agentRefunded: boolean;
      refundError: string;
    }
  | {
      status: 'cleared';
      executed: boolean;
      agentRefunded: boolean;
      refundError: string;
    };

/** Thrown when the connected wallet does not own the on-chain vault. */
export class NotOwnerError extends Error {
  constructor() {
    super('NOT_OWNER');
    this.name = 'NotOwnerError';
  }
}

/**
 * Single source of truth for revoking a vault. Used by both the Settings and
 * Vault-tab (SetupWizard) revoke handlers so the two can never drift again.
 *
 * Order of operations (matches the previously-correct Settings flow):
 *   1. Refund the agent key's SOL back to the owner (regardless of vault state)
 *      so the ~0.05 SOL funding is never stranded.
 *   2. If the vault is active & un-executed: withdraw all assets + revoke
 *      on-chain in one batched, owner-signed transaction set.
 *   3. Destroy the agent key and reset local stores.
 */
export async function revokeVault(
  publicKey: PublicKey,
  signTransaction: (tx: Transaction) => Promise<Transaction>,
): Promise<RevokeResult> {
  const txService = new VaultTransactionService();
  const connection = txService.getConnection();
  const vault = await txService.fetchVaultConfig(publicKey);

  if (vault && vault.owner && vault.owner.toBase58() !== publicKey.toBase58()) {
    throw new NotOwnerError();
  }

  // Always attempt agent SOL refund regardless of vault state so the agent
  // funding is swept back to the owner before the key is destroyed.
  let agentRefunded = false;
  let refundError = '';
  try {
    const keyManager = KeyManager.getInstance();
    if (await keyManager.hasAgentKey()) {
      const agentKeypair = await keyManager.getKeypair();
      const agentBal = await connection.getBalance(agentKeypair.publicKey);
      if (agentBal > 10000) {
        const refundSig = await txService.refundAgentSol(agentKeypair, publicKey);
        agentRefunded = refundSig !== null;
      }
    }
  } catch (e: any) {
    refundError = e?.message || 'Unknown error';
  }

  if (vault && vault.active && !vault.executed) {
    // Active vault: withdraw assets + revoke on-chain
    const { instructions: withdrawIxs, assetCount } =
      await txService.buildWithdrawAllInstructions(publicKey);
    const txs = await txService.buildBatchedTxs(publicKey, withdrawIxs, {
      includeRevoke: true,
    });

    let txSig = '';
    for (const batchTx of txs) {
      batchTx.feePayer = publicKey;
      const { blockhash, lastValidBlockHeight } =
        await connection.getLatestBlockhash('confirmed');
      batchTx.recentBlockhash = blockhash;
      const signed = await signTransaction(batchTx);
      txSig = await connection.sendRawTransaction(signed.serialize(), {
        skipPreflight: false,
        preflightCommitment: 'confirmed',
      });
      await connection.confirmTransaction(
        { signature: txSig, blockhash, lastValidBlockHeight },
        'confirmed',
      );
    }

    // Destroy agent key — vault is gone, agent no longer needed
    try {
      await KeyManager.getInstance().destroyKey();
    } catch {}

    useVaultStore.getState().reset();
    useHeartbeatStore.getState().reset();
    useEscalationStore.getState().reset();

    return { status: 'revoked', assetCount, txSig, agentRefunded, refundError };
  }

  // Vault executed, inactive, or PDAs already closed — just clean up
  try {
    await KeyManager.getInstance().destroyKey();
  } catch {}

  useVaultStore.getState().reset();
  useHeartbeatStore.getState().reset();
  useEscalationStore.getState().reset();

  return {
    status: 'cleared',
    executed: !!vault?.executed,
    agentRefunded,
    refundError,
  };
}
