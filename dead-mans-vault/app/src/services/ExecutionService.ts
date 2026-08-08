import { PublicKey, Keypair } from '@solana/web3.js';
import { KeyManager } from '../tee/KeyManager';
import { NotificationService } from '../notifications/NotificationService';
import { VaultTransactionService } from './VaultTransactionService';
import {
  saveExecutionStep,
  updateStepStatus,
  clearExecutionSteps,
  clearDistributableSnapshot,
  clearTokenSnapshot,
  getLastCompletedStep,
} from '../db/executionRepo';
import { ExecutionStep, ExecutionStepType } from '../types/execution';
import { Beneficiary } from '../types/vault';
import { useEscalationStore } from '../store/useEscalationStore';
import { useVaultStore } from '../store/useVaultStore';
import { chunk, unpaidIndices, fullU32Mask, fullU64Mask } from '../utils/crankMath';

// Module-level guard prevents concurrent execution across multiple instances.
let globalExecutionInProgress = false;

const MAX_BATCH = 8; // payouts per tx (CU / 1232-byte tx-size headroom)

// chunk / unpaidIndices / fullU32Mask / fullU64Mask now live in ../utils/crankMath
// (extracted so the index/batch math is unit-tested — finding D5).

/**
 * Drives the on-chain permissionless execution crank. Idempotent and resumable:
 * every payout is gated by an on-chain bitmask, so re-running after a crash or
 * partial completion simply continues from where the masks left off. The local
 * SQLite step list is a progress MIRROR for the UI — the masks are the source
 * of truth. The agent key pays fees (app-driven); the same instructions are
 * permissionless, so the notify-server / any keeper can crank too.
 *
 * The final core-PDA close is owner-signed (close_executed_vault_by_owner, B2)
 * and is NOT performed here.
 */
export class ExecutionService {
  private ownerPubkey: PublicKey;
  private beneficiaries: Beneficiary[];
  private txService: VaultTransactionService;
  private keyManager: KeyManager;

  private completedDistributions = 0;
  private totalDistributions = 0;

  constructor(ownerPubkey: PublicKey, beneficiaries: Beneficiary[]) {
    this.ownerPubkey = ownerPubkey;
    this.beneficiaries = beneficiaries;
    this.txService = new VaultTransactionService();
    this.keyManager = KeyManager.getInstance();
  }

  // NOTE: the Stage-4 crank is intentionally NOT network-gated (unlike fund-moving owner
  // writes, which fail closed via assertNetworkVerified). Like the heartbeat, it must not be
  // blocked on an UNKNOWN-but-possibly-fine network: MISMATCH is already hard-blocked at app
  // boot (this never mounts on a confirmed-wrong cluster), execution is permissionless and
  // computed on-chain, and a blocked crank would only delay a distribution any keeper/server
  // completes anyway.
  async execute(): Promise<void> {
    if (globalExecutionInProgress) return;
    globalExecutionInProgress = true;

    const owner = this.ownerPubkey;
    const ownerWallet = owner.toString();

    try {
      const config = await this.txService.fetchVaultConfig(owner);
      if (!config) return;

      // Fresh-run guard: if a prior run left steps but this vault isn't executed
      // yet, clear the stale mirror so the UI reflects this run.
      const last = await getLastCompletedStep(ownerWallet);
      if (last >= 0 && !config.executed) {
        await clearExecutionSteps(ownerWallet);
        await clearDistributableSnapshot(ownerWallet);
        await clearTokenSnapshot(ownerWallet);
      }

      const agent = await this.keyManager.getKeypair();
      const hasAssetPlan = !!config.hasAssetPlan;
      const onChainBenefs: { wallet: PublicKey; shareBps: number }[] = config.beneficiaries.map(
        (b: any) => ({ wallet: new PublicKey(b.wallet), shareBps: b.shareBps }),
      );
      const benefWallets = onChainBenefs.map((b) => b.wallet);
      const n = benefWallets.length;
      const fullSol = fullU32Mask(n);
      const largestBenef = VaultTransactionService.largestShareWallet(onChainBenefs);

      // A1 mitigation (mirrors keeper-bot/src/crank.js + notify-server executor.js):
      // a mint the issuer paused / froze / hook-switched / made non-transferable makes
      // its transfer_checked revert. Skip a stuck mint for this run instead of throwing
      // out of the whole crank — every distributable asset still reaches the heirs; only
      // the stuck mint's residual + rent strand (the tolerable A1 outcome, pending the
      // program-level escape hatch — external-audit scope). On-chain masks keep this
      // idempotent, so a transiently-stuck mint retries on the next Stage-4 pass.
      const stuckMints = new Set<string>();
      const markStuck = (mint: PublicKey) => stuckMints.add(mint.toString());
      const isStuck = (mint: PublicKey) => stuckMints.has(mint.toString());

      // 1. begin_execution (idempotent — account already existing == done).
      let execLog = await this.txService.fetchExecutionLog(owner);
      if (!execLog) {
        await this.txService.crankBeginExecution(agent, owner, hasAssetPlan);
        execLog = await this.txService.fetchExecutionLog(owner);
      }

      // 2. Enumerate mints = vault token balances ∪ assignment mints.
      const [vaultPda] = this.txService.getVaultPDA(owner);
      const tokenBalances = await this.txService.getVaultTokenBalances(vaultPda);
      const mintMap = new Map<string, PublicKey>();
      for (const t of tokenBalances) mintMap.set(t.mint.toString(), t.mint);
      let assetPlan = hasAssetPlan ? await this.txService.fetchAssetPlan(owner) : null;
      if (assetPlan) {
        // Skip specific-SOL bequests (zero-pubkey sentinel) — they have no token dist.
        for (const a of assetPlan.assignments) {
          if (a.mint.equals(PublicKey.default)) continue;
          mintMap.set(a.mint.toString(), a.mint);
        }
      }
      const mints = [...mintMap.values()];

      // Build the progress mirror once we know the plan shape.
      await this.buildMirror(ownerWallet, assetPlan, n, mints);

      // 3. begin_token_dist per mint (idempotent).
      for (const mint of mints) {
        const td = await this.txService.fetchTokenDist(owner, mint);
        if (!td) {
          try {
            await this.txService.crankBeginTokenDist(agent, owner, mint, hasAssetPlan);
          } catch { markStuck(mint); }
        }
      }

      // 4. Specific bequests in ascending assignment index (per-mint order is
      //    enforced on-chain; the natural index order satisfies it).
      if (assetPlan) {
        assetPlan = await this.txService.fetchAssetPlan(owner);
        if (assetPlan) {
          for (let j = 0; j < assetPlan.assignments.length; j++) {
            if ((assetPlan.paidMask & (1n << BigInt(j))) !== 0n) {
              await this.markDone(ownerWallet, `spec_${j}`);
              continue;
            }
            const a = assetPlan.assignments[j];
            const benef = benefWallets[a.beneficiaryIndex];
            const isSol = a.mint.equals(PublicKey.default);
            // A stuck mint's earlier bequest already failed → its later ones would
            // revert SpecificOutOfOrder anyway; skip them so the loop reaches other
            // mints' bequests.
            if (!isSol && isStuck(a.mint)) continue;
            try {
              await this.runStep(ownerWallet, `spec_${j}`, () =>
                isSol
                  ? this.txService.crankExecuteSpecificSol(agent, owner, j, benef)
                  : this.txService.crankExecuteSpecificAsset(agent, owner, a.mint, j, benef),
              );
            } catch { if (!isSol) markStuck(a.mint); }
          }
        }
      }

      // 5. SOL pro-rata for unpaid indices, batched.
      execLog = await this.txService.fetchExecutionLog(owner);
      const unpaidSol = unpaidIndices(execLog ? execLog.solPaidMask : 0, n);
      for (const idxs of chunk(unpaidSol, MAX_BATCH)) {
        await this.runBatch(ownerWallet, idxs.map((i) => `sol_${i}`), () =>
          this.txService.crankExecuteSolShares(agent, owner, idxs, idxs.map((i) => benefWallets[i])),
        );
      }

      // 6. Finalize when SOL mask full AND asset mask full.
      execLog = await this.txService.fetchExecutionLog(owner);
      const solDone = execLog ? (execLog.solPaidMask >>> 0) === fullSol : false;
      let assetDone = true;
      if (hasAssetPlan) {
        const ap = await this.txService.fetchAssetPlan(owner);
        assetDone = ap ? ap.paidMask === fullU64Mask(ap.assignments.length) : true;
      }
      if (execLog && !execLog.completed && solDone && assetDone) {
        await this.runStep(ownerWallet, 'finalize', () =>
          this.txService.crankFinalize(agent, owner, hasAssetPlan),
        );
      }

      // 7. Token residual pro-rata per mint, batched (gated on grace only — runs
      //    after finalize).
      for (const mint of mints) {
        if (isStuck(mint)) continue;
        const td = await this.txService.fetchTokenDist(owner, mint);
        if (!td) continue;
        const unpaid = unpaidIndices(td.paidMask, n);
        try {
          for (const idxs of chunk(unpaid, MAX_BATCH)) {
            await this.runBatch(ownerWallet, idxs.map((i) => `tok_${mint.toString()}_${i}`), () =>
              this.txService.crankExecuteTokenShares(agent, owner, mint, idxs, idxs.map((i) => benefWallets[i])),
            );
          }
        } catch { markStuck(mint); }
      }

      // 8. Close each TokenDist once its residual is fully paid (sweeps dust to
      //    the largest-share beneficiary, closes the ATA + TokenDist).
      for (const mint of mints) {
        if (isStuck(mint)) continue;
        const td = await this.txService.fetchTokenDist(owner, mint);
        if (!td) continue;
        if ((td.paidMask >>> 0) === fullSol) {
          try {
            await this.runStep(ownerWallet, `close_${mint.toString()}`, () =>
              this.txService.crankCloseTokenDist(agent, owner, mint, largestBenef),
            );
          } catch { markStuck(mint); }
        }
      }

      // 9. Done. Reset escalation + reflect in the store. Core PDAs are closed
      //    later by the owner (B2).
      const finalLog = await this.txService.fetchExecutionLog(owner);
      if (finalLog?.completed) {
        useEscalationStore.getState().reset();
        useVaultStore.getState().markExecutionCompleted();
        try {
          const solDisplay = (Number(finalLog.solSnapshot.toString()) / 1e9).toFixed(4);
          NotificationService.sendExecutionComplete(this.completedDistributions, solDisplay);
        } catch {}
      }
    } catch (err: any) {
      // Resumable by design — the next Stage-4 evaluation re-enters and continues
      // from the on-chain masks. Surface a failure notification for visibility.
      try { NotificationService.sendExecutionFailed(err?.message ?? 'execution step failed'); } catch {}
    } finally {
      globalExecutionInProgress = false;
    }
  }

  private async runStep(ownerWallet: string, id: string, fn: () => Promise<string>): Promise<void> {
    const scoped = `${ownerWallet}_${id}`;
    try { await updateStepStatus(scoped, 'in_progress'); } catch {}
    const sig = await fn();
    try { await updateStepStatus(scoped, 'completed', sig); } catch {}
    this.bumpProgress(id);
  }

  private async runBatch(ownerWallet: string, ids: string[], fn: () => Promise<string>): Promise<void> {
    for (const id of ids) {
      try { await updateStepStatus(`${ownerWallet}_${id}`, 'in_progress'); } catch {}
    }
    const sig = await fn();
    for (const id of ids) {
      try { await updateStepStatus(`${ownerWallet}_${id}`, 'completed', sig); } catch {}
      this.bumpProgress(id);
    }
  }

  private async markDone(ownerWallet: string, id: string): Promise<void> {
    try { await updateStepStatus(`${ownerWallet}_${id}`, 'completed'); } catch {}
    this.bumpProgress(id);
  }

  private bumpProgress(id: string): void {
    if (id === 'finalize' || id.startsWith('close_')) return;
    this.completedDistributions++;
    try {
      NotificationService.sendDistributionProgress(
        Math.min(this.completedDistributions, this.totalDistributions),
        this.totalDistributions,
        id,
      );
    } catch {}
  }

  /** Materialize the SQLite step mirror for the UI (best-effort). */
  private async buildMirror(
    ownerWallet: string,
    assetPlan: { assignments: { mint: PublicKey }[] } | null,
    n: number,
    mints: PublicKey[],
  ): Promise<void> {
    let order = 0;
    const steps: ExecutionStep[] = [];
    const add = (id: string, type: ExecutionStepType, description: string) => {
      steps.push({ id, type, status: 'pending', description, order: order++ });
    };

    if (assetPlan) {
      assetPlan.assignments.forEach((a, j) =>
        add(
          `spec_${j}`,
          'distribute_specific_asset',
          `Bequest #${j + 1} (${a.mint.equals(PublicKey.default) ? 'SOL' : a.mint.toString().slice(0, 6) + '…'})`,
        ),
      );
    }
    for (let i = 0; i < n; i++) {
      add(`sol_${i}`, 'distribute_sol', `Distribute SOL share to beneficiary ${i + 1}`);
    }
    for (const mint of mints) {
      for (let i = 0; i < n; i++) {
        add(`tok_${mint.toString()}_${i}`, 'distribute_token', `Distribute ${mint.toString().slice(0, 6)}… to beneficiary ${i + 1}`);
      }
    }
    add('finalize', 'record_execution_log', 'Finalize execution on-chain');
    for (const mint of mints) {
      add(`close_${mint.toString()}`, 'close_accounts', `Close ${mint.toString().slice(0, 6)}… distribution`);
    }

    this.totalDistributions = steps.filter(
      (s) => s.type === 'distribute_sol' || s.type === 'distribute_token' || s.type === 'distribute_specific_asset',
    ).length;

    try {
      for (const step of steps) await saveExecutionStep(step, ownerWallet);
    } catch {}
  }

}
