import { PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { KeyManager } from '../tee/KeyManager';
import { VaultTransactionService } from './VaultTransactionService';
import {
  saveExecutionStep,
  getLastCompletedStep,
  updateStepStatus,
  getDistributableSnapshot,
  saveDistributableSnapshot,
  clearDistributableSnapshot,
} from '../db/executionRepo';
import { ExecutionStep, ExecutionStepType } from '../types/execution';
import { Beneficiary } from '../types/vault';
import { DeFiPosition } from '../types/defi';
import { DeFiClosureService } from '../defi/closer';

const SOL_RESERVE = 0.1 * LAMPORTS_PER_SOL; // 0.1 SOL reserve for fees

export class ExecutionService {
  private ownerPubkey: PublicKey;
  private beneficiaries: Beneficiary[];
  private defiPositions: DeFiPosition[];
  private isExecuting = false;

  // Shared instances lifted from per-step creation (P1 fix)
  private txService: VaultTransactionService;
  private keyManager: KeyManager;

  // Snapshot of distributable balance taken once before any distributions (S4 fix)
  private distributableSnapshot: number = 0;

  // Accumulated total SOL distributed for record_execution (B3 fix)
  private totalSolDistributed: number = 0;

  constructor(
    ownerPubkey: PublicKey,
    beneficiaries: Beneficiary[],
    defiPositions: DeFiPosition[] = [],
  ) {
    this.ownerPubkey = ownerPubkey;
    this.beneficiaries = beneficiaries;
    this.defiPositions = defiPositions;
    this.txService = new VaultTransactionService();
    this.keyManager = KeyManager.getInstance();
  }

  async execute(): Promise<void> {
    if (this.isExecuting) return;
    this.isExecuting = true;

    try {
      const lastCompleted = await getLastCompletedStep();
      const steps = this.buildExecutionPlan();

      // Save all steps to SQLite
      for (const step of steps) {
        if (step.order > lastCompleted) {
          await saveExecutionStep(step);
        }
      }

      // Recover persisted snapshot if resuming after crash, or compute fresh.
      // This ensures each beneficiary gets their exact entitled percentage
      // even across crash/recovery cycles (S4 + crash recovery fix).
      const savedSnapshot = await getDistributableSnapshot();
      if (savedSnapshot !== null && lastCompleted >= 0) {
        this.distributableSnapshot = savedSnapshot;
      } else {
        const [vaultPda] = this.txService.getVaultPDA(this.ownerPubkey);
        const balance = await this.txService.getConnection().getBalance(vaultPda);
        this.distributableSnapshot = Math.max(0, balance - SOL_RESERVE);
        await saveDistributableSnapshot(this.distributableSnapshot);
      }
      this.totalSolDistributed = 0;

      // Track whether any distribution step failed
      let hasDistributionFailure = false;

      // Execute sequentially, skip completed steps
      for (const step of steps) {
        if (step.order <= lastCompleted) continue;

        // If a distribution failed, skip record_execution and self_terminate
        // to preserve the agent key for manual recovery
        if (hasDistributionFailure && (step.type === 'record_execution_log' || step.type === 'self_terminate')) {
          await updateStepStatus(step.id, 'failed', undefined,
            'Skipped: prior distribution step failed. Agent key preserved for recovery.');
          continue;
        }

        await updateStepStatus(step.id, 'in_progress');

        try {
          const txSig = await this.executeStep(step);
          await updateStepStatus(step.id, 'completed', txSig);
        } catch (err: any) {
          await updateStepStatus(step.id, 'failed', undefined, err.message);
          if (step.type === 'distribute_percentage' || step.type === 'close_defi_position') {
            hasDistributionFailure = true;
          }
        }
      }
    } finally {
      this.isExecuting = false;
    }
  }

  private buildExecutionPlan(): ExecutionStep[] {
    const steps: ExecutionStep[] = [];
    let order = 0;

    // Step 0: Revoke approvals (skipped for MVP)
    steps.push(this.makeStep(order++, 'revoke_approvals', 'Revoke token approvals', 'skipped'));

    // Steps: Close each DeFi position with action === 'close'
    const closablePositions = this.defiPositions.filter((p) => p.action === 'close');
    if (closablePositions.length === 0) {
      steps.push(this.makeStep(order++, 'close_defi_position', 'No DeFi positions to close', 'skipped'));
    } else {
      for (const position of closablePositions) {
        const desc = position.closureStrategy === 'unsupported'
          ? `Detected ${position.protocol} ${position.type} (closure unsupported)`
          : `Close ${position.protocol}: ${position.description}`;
        const status = position.closureStrategy === 'unsupported' ? 'skipped' : 'pending';
        steps.push(
          this.makeStep(order++, 'close_defi_position', desc, status, {
            protocol: position.protocol,
            closureStrategy: position.closureStrategy,
            tokenMint: position.tokenMint,
            tokenAmount: position.tokenAmount,
            tokenDecimals: position.tokenDecimals,
            accountAddress: position.accountAddress.toString(),
          }),
        );
      }
    }

    // Distribute specific assets (skipped for MVP)
    steps.push(this.makeStep(order++, 'distribute_specific_asset', 'Distribute specific assets', 'skipped'));

    // Steps 3+N: Distribute percentage to each beneficiary
    for (const beneficiary of this.beneficiaries) {
      const label = beneficiary.label || beneficiary.wallet.toString().slice(0, 8);
      steps.push(
        this.makeStep(
          order++,
          'distribute_percentage',
          `Distribute ${(beneficiary.shareBps / 100).toFixed(1)}% to ${label}`,
          'pending',
          { wallet: beneficiary.wallet.toString(), shareBps: beneficiary.shareBps },
        ),
      );
    }

    // Burn assets (skipped for MVP)
    steps.push(this.makeStep(order++, 'burn_asset', 'Burn designated assets', 'skipped'));

    // Close accounts (skipped for MVP)
    steps.push(this.makeStep(order++, 'close_accounts', 'Close empty accounts', 'skipped'));

    // Record execution log on-chain
    steps.push(this.makeStep(order++, 'record_execution_log', 'Record execution on-chain', 'pending'));

    // Self-terminate agent key
    steps.push(this.makeStep(order++, 'self_terminate', 'Destroy agent key', 'pending'));

    return steps;
  }

  private makeStep(
    order: number,
    type: ExecutionStepType,
    description: string,
    status: 'pending' | 'skipped',
    metadata?: Record<string, unknown>,
  ): ExecutionStep {
    return {
      id: `exec_${type}_${order}`,
      type,
      status,
      description,
      order,
      metadata,
    };
  }

  private async executeStep(step: ExecutionStep): Promise<string | undefined> {
    switch (step.type) {
      case 'revoke_approvals':
      case 'distribute_specific_asset':
      case 'burn_asset':
      case 'close_accounts':
        // Skipped for MVP
        return undefined;

      case 'close_defi_position':
        return this.executeCloseDeFiPosition(step);

      case 'distribute_percentage':
        return this.executeDistributePercentage(step);

      case 'record_execution_log':
        return this.executeRecordExecution();

      case 'self_terminate':
        await this.executeSelfTerminate();
        return undefined;

      default:
        return undefined;
    }
  }

  private async executeCloseDeFiPosition(step: ExecutionStep): Promise<string | undefined> {
    const strategy = step.metadata?.closureStrategy as string;
    if (strategy === 'unsupported') return undefined;

    const agentKeypair = await this.keyManager.getKeypair();

    // Reconstruct a minimal position from step metadata
    const position: DeFiPosition = {
      protocol: step.metadata?.protocol as any,
      type: '',
      description: step.description,
      estimatedValueUsd: 0,
      estimatedValueSol: 0,
      tokens: [],
      action: 'close',
      accountAddress: new PublicKey(step.metadata?.accountAddress as string),
      closureStrategy: strategy as any,
      tokenMint: step.metadata?.tokenMint as string | undefined,
      tokenAmount: step.metadata?.tokenAmount as number | undefined,
      tokenDecimals: step.metadata?.tokenDecimals as number | undefined,
    };

    const closureService = new DeFiClosureService(this.txService.getConnection());
    const result = await closureService.closePosition(position, agentKeypair);

    if (!result.success) {
      throw new Error(result.error || 'DeFi position closure failed');
    }

    return result.txSignature;
  }

  private async executeDistributePercentage(step: ExecutionStep): Promise<string> {
    const agentKeypair = await this.keyManager.getKeypair();

    const beneficiaryWallet = new PublicKey(step.metadata?.wallet as string);
    const shareBps = step.metadata?.shareBps as number;

    // Use the frozen distributableSnapshot instead of re-reading balance.
    // This ensures each beneficiary gets their exact entitled share
    // regardless of execution order (S4 fix).
    if (this.distributableSnapshot <= 0) {
      throw new Error('Insufficient SOL in vault for distribution');
    }

    const amountLamports = Math.floor((this.distributableSnapshot * shareBps) / 10000);

    if (amountLamports <= 0) {
      throw new Error('Distribution amount too small');
    }

    // On-chain enforced: program verifies grace period, beneficiary whitelist,
    // vault state, and agent authorization before transferring from vault PDA
    const sig = await this.txService.executeDistribution(
      agentKeypair,
      this.ownerPubkey,
      beneficiaryWallet,
      amountLamports,
    );

    // Accumulate for record_execution (B3 fix)
    this.totalSolDistributed += amountLamports;

    return sig;
  }

  private async executeRecordExecution(): Promise<string> {
    const agentKeypair = await this.keyManager.getKeypair();

    // Zero attestation hash for MVP
    const attestationHash = new Array(32).fill(0);

    return this.txService.recordExecution(agentKeypair, this.ownerPubkey, {
      transferCount: this.beneficiaries.length,
      totalSolDistributed: this.totalSolDistributed,
      tokenTypesDistributed: 0,
      attestationHash,
      completed: true,
    });
  }

  private async executeSelfTerminate(): Promise<void> {
    await clearDistributableSnapshot();
    await this.keyManager.destroyKey();
  }
}
