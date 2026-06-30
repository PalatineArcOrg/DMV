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

// Module-level guard prevents concurrent execution across multiple instances.
let globalExecutionInProgress = false;

const MAX_BATCH = 8; // payouts per tx (CU / 1232-byte tx-size headroom)

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Full u32 beneficiary mask for `n` beneficiaries (n <= 20 in practice). */
function fullU32Mask(n: number): number {
  return n >= 32 ? 0xffffffff : (((1 << n) - 1) >>> 0);
}

/** Full u64 assignment mask for `n` assignments. */
function fullU64Mask(n: number): bigint {
  return n >= 64 ? (2n ** 64n - 1n) : ((1n << BigInt(n)) - 1n);
}

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

  async execute(): Promise<void> {
    if (globalExecutionInProgress) return;
    globalExecutionInProgress = true;

    const owner = this.ownerPubkey;
    const ownerWallet = owner.toString();

    try {
      // The client escalation may reach Stage 4 slightly before the on-chain
      // deadline (clock drift / heartbeat-confirmation lag) — wait it out.
      await this.waitForOnChainDeadline();

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

      // 1. begin_execution (idempotent — account already existing == done).
      let execLog = await this.txService.fetchExecutionLog(owner);
      if (!execLog) {
        await this.txService.crankBeginExecution(agent, owner);
        execLog = await this.txService.fetchExecutionLog(owner);
      }

      // 2. Enumerate mints = vault token balances ∪ assignment mints.
      const [vaultPda] = this.txService.getVaultPDA(owner);
      const tokenBalances = await this.txService.getVaultTokenBalances(vaultPda);
      const mintMap = new Map<string, PublicKey>();
      for (const t of tokenBalances) mintMap.set(t.mint.toString(), t.mint);
      let assetPlan = hasAssetPlan ? await this.txService.fetchAssetPlan(owner) : null;
      if (assetPlan) {
        for (const a of assetPlan.assignments) mintMap.set(a.mint.toString(), a.mint);
      }
      const mints = [...mintMap.values()];

      // Build the progress mirror once we know the plan shape.
      await this.buildMirror(ownerWallet, assetPlan, n, mints);

      // 3. begin_token_dist per mint (idempotent).
      for (const mint of mints) {
        const td = await this.txService.fetchTokenDist(owner, mint);
        if (!td) {
          await this.txService.crankBeginTokenDist(agent, owner, mint, hasAssetPlan);
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
            await this.runStep(ownerWallet, `spec_${j}`, () =>
              this.txService.crankExecuteSpecificAsset(agent, owner, a.mint, j, benef),
            );
          }
        }
      }

      // 5. SOL pro-rata for unpaid indices, batched.
      execLog = await this.txService.fetchExecutionLog(owner);
      const unpaidSol = this.unpaidIndices(execLog ? execLog.solPaidMask : 0, n);
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
        const td = await this.txService.fetchTokenDist(owner, mint);
        if (!td) continue;
        const unpaid = this.unpaidIndices(td.paidMask, n);
        for (const idxs of chunk(unpaid, MAX_BATCH)) {
          await this.runBatch(ownerWallet, idxs.map((i) => `tok_${mint.toString()}_${i}`), () =>
            this.txService.crankExecuteTokenShares(agent, owner, mint, idxs, idxs.map((i) => benefWallets[i])),
          );
        }
      }

      // 8. Close each TokenDist once its residual is fully paid (sweeps dust to
      //    the largest-share beneficiary, closes the ATA + TokenDist).
      for (const mint of mints) {
        const td = await this.txService.fetchTokenDist(owner, mint);
        if (!td) continue;
        if ((td.paidMask >>> 0) === fullSol) {
          await this.runStep(ownerWallet, `close_${mint.toString()}`, () =>
            this.txService.crankCloseTokenDist(agent, owner, mint, largestBenef),
          );
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

  // ─── crank helpers ───

  private unpaidIndices(mask: number, n: number): number[] {
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      if (((mask >>> i) & 1) === 0) out.push(i);
    }
    return out;
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
        add(`spec_${j}`, 'distribute_specific_asset', `Bequest #${j + 1} (${a.mint.toString().slice(0, 6)}…)`),
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

  private async waitForOnChainDeadline(): Promise<void> {
    const MAX_WAIT_MS = 120_000;
    const POLL_INTERVAL_MS = 5_000;
    const BUFFER_SECONDS = 2;
    const start = Date.now();

    while (Date.now() - start < MAX_WAIT_MS) {
      const deadline = await this.txService.getOnChainDeadline(this.ownerPubkey);
      if (deadline === null) return;
      const slot = await this.txService.getConnection().getSlot('confirmed');
      const blockTime = await this.txService.getConnection().getBlockTime(slot);
      if (blockTime === null) return;
      if (blockTime > deadline + BUFFER_SECONDS) return;
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }
}
