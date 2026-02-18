import { PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { KeyManager } from '../tee/KeyManager';
import { VaultTransactionService } from './VaultTransactionService';
import {
  saveExecutionStep,
  getLastCompletedStep,
  updateStepStatus,
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

  constructor(
    ownerPubkey: PublicKey,
    beneficiaries: Beneficiary[],
    defiPositions: DeFiPosition[] = [],
  ) {
    this.ownerPubkey = ownerPubkey;
    this.beneficiaries = beneficiaries;
    this.defiPositions = defiPositions;
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

    const keyManager = KeyManager.getInstance();
    const agentKeypair = await keyManager.getKeypair();
    const txService = new VaultTransactionService();

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

    const closureService = new DeFiClosureService(txService.getConnection());
    const result = await closureService.closePosition(position, agentKeypair);

    if (!result.success) {
      throw new Error(result.error || 'DeFi position closure failed');
    }

    return result.txSignature;
  }

  private async executeDistributePercentage(step: ExecutionStep): Promise<string> {
    const keyManager = KeyManager.getInstance();
    const agentKeypair = await keyManager.getKeypair();
    const txService = new VaultTransactionService();

    const beneficiaryWallet = new PublicKey(step.metadata?.wallet as string);
    const shareBps = step.metadata?.shareBps as number;

    // Get agent's SOL balance (MVP: distributing from agent's balance)
    const balance = await txService.getConnection().getBalance(agentKeypair.publicKey);
    const distributable = Math.max(0, balance - SOL_RESERVE);

    if (distributable <= 0) {
      throw new Error('Insufficient SOL balance for distribution');
    }

    const amountLamports = Math.floor((distributable * shareBps) / 10000);

    if (amountLamports <= 0) {
      throw new Error('Distribution amount too small');
    }

    return txService.executeDistribution(
      agentKeypair,
      this.ownerPubkey,
      beneficiaryWallet,
      amountLamports,
    );
  }

  private async executeRecordExecution(): Promise<string> {
    const keyManager = KeyManager.getInstance();
    const agentKeypair = await keyManager.getKeypair();
    const txService = new VaultTransactionService();

    // Zero attestation hash for MVP
    const attestationHash = new Array(32).fill(0);

    return txService.recordExecution(agentKeypair, this.ownerPubkey, {
      transferCount: this.beneficiaries.length,
      totalSolDistributed: 0, // Will be updated with actual amounts in future
      tokenTypesDistributed: 0,
      attestationHash,
      completed: true,
    });
  }

  private async executeSelfTerminate(): Promise<void> {
    const keyManager = KeyManager.getInstance();
    await keyManager.destroyKey();
  }
}
