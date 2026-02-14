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

const SOL_RESERVE = 0.1 * LAMPORTS_PER_SOL; // 0.1 SOL reserve for fees

export class ExecutionService {
  private ownerPubkey: PublicKey;
  private beneficiaries: Beneficiary[];
  private isExecuting = false;

  constructor(ownerPubkey: PublicKey, beneficiaries: Beneficiary[]) {
    this.ownerPubkey = ownerPubkey;
    this.beneficiaries = beneficiaries;
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

      // Execute sequentially, skip completed steps
      for (const step of steps) {
        if (step.order <= lastCompleted) continue;

        await updateStepStatus(step.id, 'in_progress');

        try {
          const txSig = await this.executeStep(step);
          await updateStepStatus(step.id, 'completed', txSig);
        } catch (err: any) {
          await updateStepStatus(step.id, 'failed', undefined, err.message);
          // Continue to next step — don't halt the entire execution for a single failure
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

    // Step 1: Close DeFi positions (skipped for MVP)
    steps.push(this.makeStep(order++, 'close_defi_position', 'Close DeFi positions', 'skipped'));

    // Step 2: Distribute specific assets (skipped for MVP)
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
      case 'close_defi_position':
      case 'distribute_specific_asset':
      case 'burn_asset':
      case 'close_accounts':
        // Skipped for MVP
        return undefined;

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
