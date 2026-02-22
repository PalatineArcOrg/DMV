import { PublicKey } from '@solana/web3.js';
import { BN } from '@coral-xyz/anchor';
import { KeyManager } from '../tee/KeyManager';
import { VaultTransactionService } from './VaultTransactionService';
import {
  saveExecutionStep,
  getLastCompletedStep,
  updateStepStatus,
  clearDistributableSnapshot,
} from '../db/executionRepo';
import { ExecutionStep, ExecutionStepType } from '../types/execution';
import { Beneficiary } from '../types/vault';
import { DeFiPosition } from '../types/defi';
import { DeFiClosureService } from '../defi/closer';

export class ExecutionService {
  private ownerPubkey: PublicKey;
  private beneficiaries: Beneficiary[];
  private defiPositions: DeFiPosition[];
  private isExecuting = false;

  private txService: VaultTransactionService;
  private keyManager: KeyManager;

  // Accumulated total SOL distributed for record_execution
  private totalSolDistributed: BN = new BN(0);

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

      this.totalSolDistributed = new BN(0);

      // Track whether any distribution step failed
      let hasDistributionFailure = false;

      // Execute sequentially, skip completed and pre-skipped steps
      for (const step of steps) {
        if (step.order <= lastCompleted) continue;
        if (step.status === 'skipped') {
          await updateStepStatus(step.id, 'completed');
          continue;
        }

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
          if (step.type === 'submit_presigned_distribution' || step.type === 'close_defi_position') {
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

    // Submit pre-signed distribution TX (single step for all beneficiaries)
    const beneficiaryLabels = this.beneficiaries
      .map((b) => b.label || b.wallet.toString().slice(0, 8))
      .join(', ');
    steps.push(
      this.makeStep(
        order++,
        'submit_presigned_distribution',
        `Distribute SOL to ${this.beneficiaries.length} beneficiar${this.beneficiaries.length === 1 ? 'y' : 'ies'}: ${beneficiaryLabels}`,
        'pending',
      ),
    );

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
      case 'distribute_percentage':
      case 'burn_asset':
      case 'close_accounts':
        return undefined;

      case 'close_defi_position':
        return this.executeCloseDeFiPosition(step);

      case 'submit_presigned_distribution':
        return this.executePresignedDistribution();

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

  /**
   * Submit the pre-signed durable nonce distribution TX.
   * Checks available assets before submission, then agent adds
   * its signature (nonce authority) and submits.
   */
  private async executePresignedDistribution(): Promise<string> {
    const base64Tx = await this.keyManager.getPresignedTx();
    if (!base64Tx) {
      throw new Error('No pre-signed distribution TX found in secure storage');
    }

    // Check what assets are available for distribution
    const ownerBalance = await this.txService.getConnection().getBalance(this.ownerPubkey);
    const storedAmount = await this.keyManager.getDistributionAmount();
    const requiredLamports = storedAmount ? parseInt(storedAmount, 10) : 0;

    if (requiredLamports > 0 && ownerBalance < requiredLamports) {
      throw new Error(
        `Insufficient owner balance for distribution. ` +
        `Required: ${(requiredLamports / 1e9).toFixed(4)} SOL, ` +
        `Available: ${(ownerBalance / 1e9).toFixed(4)} SOL`,
      );
    }

    const agentKeypair = await this.keyManager.getKeypair();
    const txBytes = Buffer.from(base64Tx, 'base64');

    const sig = await this.txService.submitPresignedTx(agentKeypair, txBytes);

    // Use the stored distribution amount for accurate on-chain record
    this.totalSolDistributed = new BN(requiredLamports > 0 ? requiredLamports : 0);

    return sig;
  }

  private async executeRecordExecution(): Promise<string> {
    const agentKeypair = await this.keyManager.getKeypair();

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
    await this.keyManager.clearPresignedTx();
    await this.keyManager.clearNonceAccount();
    await this.keyManager.clearDistributionAmount();
    await this.keyManager.destroyKey();
  }
}
