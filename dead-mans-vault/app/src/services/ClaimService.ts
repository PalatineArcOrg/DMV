import { PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js';
import { VaultTransactionService } from './VaultTransactionService';

// Matches the MWA signer returned by useWallet(); we only ever hand it legacy
// Transactions, so the returned value is narrowed back to Transaction internally.
type MwaSign = (tx: Transaction | VersionedTransaction) => Promise<Transaction | VersionedTransaction>;

// Module-level guard: one claim at a time across the app.
let claimInProgress = false;

export type ClaimProgress = (label: string, index: number, total: number) => void;

/**
 * Beneficiary "claim" — an heir triggers a vault's estate distribution from their
 * own wallet. Runs the exact same permissionless crank the owner app / notify-
 * server run, but MWA-signed with the heir as fee payer (they control nothing
 * about where funds go — the program enforces destinations). Distributes the
 * WHOLE estate to ALL beneficiaries. Idempotent + resumable via on-chain masks,
 * so a retry after a failed step safely continues.
 */
export class ClaimService {
  /**
   * @param owner            the vault owner's wallet pubkey
   * @param heir             the connected (claiming) wallet pubkey — pays fees
   * @param signTransaction  MWA signer (from useWallet)
   * @param onProgress       optional per-step progress callback
   */
  static async runClaim(
    owner: PublicKey,
    heir: PublicKey,
    signTransaction: MwaSign,
    onProgress?: ClaimProgress,
  ): Promise<{ steps: number }> {
    if (claimInProgress) throw new Error('A claim is already in progress.');
    claimInProgress = true;
    try {
      const svc = new VaultTransactionService();
      const connection = svc.getConnection();

      // Re-check on-chain that grace has actually elapsed (defence in depth — the
      // list already gates on "claimable", but a manual import might not have).
      const deadline = await svc.getOnChainDeadline(owner);
      if (deadline !== null) {
        const slot = await connection.getSlot('confirmed');
        const blockTime = await connection.getBlockTime(slot);
        if (blockTime !== null && blockTime < deadline) {
          throw new Error('This estate is not claimable yet — the owner is still active.');
        }
      }

      // Resumable loop: buildClaimTransactions returns the steps currently doable
      // from live on-chain state (idempotent — done work is skipped). Some steps
      // depend on accounts an earlier step creates (e.g. token residual shares need
      // the TokenDist that begin_token_dist creates), so we re-build after each pass
      // until nothing remains. A pure-SOL estate finishes in one pass (one tx).
      let i = 0;
      const firstPass = await svc.buildClaimTransactions(heir, owner);
      if (firstPass.length === 0) {
        throw new Error('This estate has already been distributed.');
      }
      let pass = firstPass;
      const MAX_PASSES = 10; // safety bound; each pass strictly advances on-chain state
      for (let p = 0; p < MAX_PASSES && pass.length > 0; p += 1) {
        for (const { label, tx } of pass) {
          onProgress?.(label, i, i + pass.length);
          await ClaimService.signSend(connection, tx, heir, signTransaction);
          i += 1;
        }
        pass = await svc.buildClaimTransactions(heir, owner);
      }

      // Best-effort cleanup: close fully-paid token dists (sweeps dust, reclaims
      // rent). The distribution is already complete if this fails.
      try {
        const closes = await svc.buildCloseTokenDistTransactions(heir, owner);
        for (const { label, tx } of closes) {
          onProgress?.(label, i, i + closes.length);
          await ClaimService.signSend(connection, tx, heir, signTransaction);
          i += 1;
        }
      } catch {
        // non-fatal — beneficiaries already received every asset
      }

      return { steps: i };
    } finally {
      claimInProgress = false;
    }
  }

  private static async signSend(
    connection: ReturnType<VaultTransactionService['getConnection']>,
    tx: Transaction,
    heir: PublicKey,
    signTransaction: MwaSign,
  ): Promise<string> {
    tx.feePayer = heir;
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    tx.recentBlockhash = blockhash;
    const signed = (await signTransaction(tx)) as Transaction;
    const sig = await connection.sendRawTransaction(signed.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    });
    await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
    return sig;
  }
}
