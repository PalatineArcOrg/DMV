import { PublicKey, Transaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { VaultTransactionService } from './VaultTransactionService';
import { KeyManager } from '../tee/KeyManager';
import { useVaultStore } from '../store/useVaultStore';
import { useHeartbeatStore } from '../store/useHeartbeatStore';
import { useEscalationStore } from '../store/useEscalationStore';
import { deleteSetting } from '../db/settingsRepo';

/** A single on-chain transaction produced during revoke, for the UI breakdown. */
export interface TxRef {
  label: string;
  sig: string;
}

/**
 * Result of a vault revoke. `revoked` means an active vault was withdrawn +
 * closed on-chain this call; `cleared` means there was nothing active to revoke
 * (already executed / inactive / PDAs already closed) and only local cleanup ran.
 *
 * `totalReturnedSol` is the net increase in the owner's wallet across the whole
 * operation (agent refund + vault rent + deposited SOL + token-account rent,
 * minus the small network fee the owner pays for the revoke). It is measured
 * directly from the owner's balance so the UI can show users exactly what came
 * back and head off "the refund never arrived" confusion.
 */
interface RevokeResultBase {
  agentRefunded: boolean;
  agentRefundedSol: number; // SOL swept from the agent key back to owner (0 if none)
  agentAlreadyEmpty: boolean; // agent key existed but held no SOL (already refunded earlier)
  vaultReturnedSol: number; // everything else returned (rent + deposited + ATA rent), net of fee
  totalReturnedSol: number; // net wallet increase = agentRefundedSol + vaultReturnedSol
  txs: TxRef[]; // every transaction, in order, for the breakdown + explorer links
  refundError: string;
}

export type RevokeResult =
  | ({ status: 'revoked'; assetCount: number } & RevokeResultBase)
  | ({ status: 'cleared'; executed: boolean } & RevokeResultBase);

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

  // Server-side push escalation is stopped automatically: once this revoke closes
  // the vault on-chain, the notify-server's poller auto-drops the registration
  // (deregister now requires an owner signature, so we don't do a separate signed
  // call here — the on-chain close is the source of truth and needs no extra prompt).

  // Owner balance BEFORE anything — used to measure the true total returned.
  const ownerBalBefore = await connection.getBalance(publicKey, 'confirmed');
  const txs: TxRef[] = [];

  // Always attempt agent SOL refund regardless of vault state so the agent
  // funding is swept back to the owner before the key is destroyed.
  let agentRefunded = false;
  let agentRefundedSol = 0;
  let agentAlreadyEmpty = false;
  let refundError = '';
  try {
    const keyManager = KeyManager.getInstance();
    if (await keyManager.hasAgentKey()) {
      const agentKeypair = await keyManager.getKeypair();
      const agentBal = await connection.getBalance(agentKeypair.publicKey);
      if (agentBal > 10000) {
        const refundSig = await txService.refundAgentSol(agentKeypair, publicKey);
        agentRefunded = refundSig !== null;
        if (agentRefunded && refundSig) {
          // refundAgentSol sweeps (balance - 5000 fee reserve) to the owner.
          agentRefundedSol = (agentBal - 5000) / LAMPORTS_PER_SOL;
          txs.push({ label: 'Agent key refund', sig: refundSig });
        }
      } else {
        // Key exists but holds no SOL — it was already swept back to the owner
        // in an earlier step (e.g. a prior revoke attempt). Surface this so the
        // summary can say so explicitly instead of silently omitting the agent.
        agentAlreadyEmpty = true;
      }
    } else {
      refundError = 'no agent key on this device';
    }
  } catch (e: any) {
    refundError = e?.message || 'Unknown error';
  }

  const finish = async (): Promise<{ totalReturnedSol: number; vaultReturnedSol: number }> => {
    const ownerBalAfter = await connection.getBalance(publicKey, 'confirmed');
    const totalReturnedSol = Math.max(0, (ownerBalAfter - ownerBalBefore) / LAMPORTS_PER_SOL);
    const vaultReturnedSol = Math.max(0, totalReturnedSol - agentRefundedSol);
    return { totalReturnedSol, vaultReturnedSol };
  };

  if (vault && vault.active && !vault.executed) {
    // Active vault: withdraw assets + revoke on-chain
    const { instructions: withdrawIxs, assetCount } =
      await txService.buildWithdrawAllInstructions(publicKey);
    const batchTxs = await txService.buildBatchedTxs(publicKey, withdrawIxs, {
      includeRevoke: true,
    });

    for (let i = 0; i < batchTxs.length; i++) {
      const batchTx = batchTxs[i];
      batchTx.feePayer = publicKey;
      const { blockhash, lastValidBlockHeight } =
        await connection.getLatestBlockhash('confirmed');
      batchTx.recentBlockhash = blockhash;
      const signed = await signTransaction(batchTx);
      const sig = await connection.sendRawTransaction(signed.serialize(), {
        skipPreflight: false,
        preflightCommitment: 'confirmed',
      });
      await connection.confirmTransaction(
        { signature: sig, blockhash, lastValidBlockHeight },
        'confirmed',
      );
      txs.push({
        label:
          batchTxs.length > 1
            ? `Withdraw + close vault (${i + 1}/${batchTxs.length})`
            : 'Withdraw + close vault',
        sig,
      });
    }

    // Destroy agent key — vault is gone, agent no longer needed
    try {
      await KeyManager.getInstance().destroyKey();
    } catch {}

    useVaultStore.getState().reset();
    useHeartbeatStore.getState().reset();
    useEscalationStore.getState().reset();
    await deleteSetting('heartbeat_config');

    const { totalReturnedSol, vaultReturnedSol } = await finish();
    return {
      status: 'revoked',
      assetCount,
      agentRefunded,
      agentRefundedSol,
      agentAlreadyEmpty,
      vaultReturnedSol,
      totalReturnedSol,
      txs,
      refundError,
    };
  }

  // Vault executed: close it on-chain (owner-signed) so it no longer lingers and
  // reappears on reopen, and reclaim the rent. FIRST close any remaining TokenDists
  // (harvest-aware — transfer-fee mints leave withheld fees that otherwise stick the
  // close and keep open_token_dists > 0), THEN close the core PDAs. Failures PROPAGATE
  // to the caller (which shows a real error) instead of silently "clearing local" and
  // letting the vault reappear.
  if (vault && vault.executed) {
    const sendOwnerTx = async (tx: Transaction, label: string) => {
      tx.feePayer = publicKey;
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
      tx.recentBlockhash = blockhash;
      const signed = await signTransaction(tx);
      const sig = await connection.sendRawTransaction(signed.serialize(), {
        skipPreflight: false,
        preflightCommitment: 'confirmed',
      });
      await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
      txs.push({ label, sig });
    };
    // 1. Close any fully-paid TokenDists still open (each harvests withheld fees first).
    const tdTxs = await txService.buildCloseTokenDistTransactions(publicKey, publicKey);
    for (const { label, tx } of tdTxs) await sendOwnerTx(tx, label);
    // 2. Close the core PDAs (rent → owner). Throws (surfaced) if a residual still blocks it.
    await sendOwnerTx(await txService.buildCloseExecutedVaultTx(publicKey), 'Close vault & reclaim rent');
  }

  // Executed / inactive / already-closed — clean up local state.
  try {
    await KeyManager.getInstance().destroyKey();
  } catch {}

  useVaultStore.getState().reset();
  useHeartbeatStore.getState().reset();
  useEscalationStore.getState().reset();
  await deleteSetting('heartbeat_config');

  const { totalReturnedSol, vaultReturnedSol } = await finish();
  return {
    status: 'cleared',
    executed: !!vault?.executed,
    agentRefunded,
    agentRefundedSol,
    agentAlreadyEmpty,
    vaultReturnedSol,
    totalReturnedSol,
    txs,
    refundError,
  };
}

/** Shorten a base58 signature for compact display. */
function shortSig(sig: string): string {
  return sig.length > 16 ? `${sig.slice(0, 8)}…${sig.slice(-6)}` : sig;
}

/**
 * Build the user-facing revoke summary: a title, a multi-line breakdown
 * (per-line amounts + total + every transaction), and the tx list so the
 * caller can wire "View on Explorer" buttons.
 */
export function formatRevokeSummary(r: RevokeResult): {
  title: string;
  message: string;
  txs: TxRef[];
} {
  const title = r.status === 'revoked' ? 'Vault Revoked' : 'Vault Cleared';

  // Nothing happened on-chain (no active vault, no agent balance).
  if (r.txs.length === 0) {
    const why =
      r.status === 'cleared' && r.executed
        ? 'Vault was already executed.'
        : 'No active vault found on-chain.';
    return { title, message: `${why} Local data cleared.`, txs: [] };
  }

  const lines: string[] = ['Returned to your wallet:'];
  if (r.agentRefunded) {
    lines.push(`  • Agent key refund:   ${r.agentRefundedSol.toFixed(4)} SOL`);
  } else if (r.agentAlreadyEmpty) {
    // The agent had already been swept back earlier — say so explicitly so it
    // never looks like the agent funding silently disappeared.
    lines.push('  • Agent SOL:  already returned earlier');
  }
  if (r.vaultReturnedSol > 0) {
    const assetCount = r.status === 'revoked' ? r.assetCount : 0;
    const label = assetCount > 0 ? 'Vault rent + assets' : 'Vault rent';
    lines.push(`  • ${label}:  ${r.vaultReturnedSol.toFixed(4)} SOL`);
  }
  lines.push('  ─────────────────');
  lines.push(`  Total this revoke:  ${r.totalReturnedSol.toFixed(4)} SOL`);

  lines.push('');
  lines.push(`Transaction${r.txs.length !== 1 ? 's' : ''}:`);
  for (const t of r.txs) {
    lines.push(`  • ${t.label}\n    ${shortSig(t.sig)}`);
  }

  if (
    r.refundError &&
    r.refundError !== 'no agent balance' &&
    r.refundError !== 'no agent key on this device'
  ) {
    lines.push('');
    lines.push(`Note: agent refund failed (${r.refundError}).`);
  }

  return { title, message: lines.join('\n'), txs: r.txs };
}
