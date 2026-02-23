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
          if (step.type === 'distribute_sol' || step.type === 'close_defi_position') {
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

    // Distribute SOL from vault PDA to each beneficiary via on-chain instruction
    for (const b of this.beneficiaries) {
      const label = b.label || b.wallet.toString().slice(0, 8);
      steps.push(
        this.makeStep(
          order++,
          'distribute_sol',
          `Distribute SOL to ${label} (${(b.shareBps / 100).toFixed(1)}%)`,
          'pending',
          { beneficiaryWallet: b.wallet.toString(), shareBps: b.shareBps },
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
      case 'distribute_percentage':
      case 'burn_asset':
      case 'close_accounts':
        return undefined;

      case 'close_defi_position':
        return this.executeCloseDeFiPosition(step);

      case 'distribute_sol':
        return this.executeSolDistribution(step);

      case 'submit_presigned_distribution':
        return undefined;

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
   * Distribute SOL from vault PDA to a single beneficiary via on-chain instruction.
   * The vault PDA holds deposited SOL; the program transfers via lamport manipulation.
   * Only the agent key needs to sign — no owner interaction required.
   */
  private async executeSolDistribution(step: ExecutionStep): Promise<string> {
    const beneficiaryWallet = new PublicKey(step.metadata?.beneficiaryWallet as string);
    const shareBps = step.metadata?.shareBps as number;

    // Get available balance in the vault PDA
    const [vaultPda] = this.txService.getVaultPDA(this.ownerPubkey);
    const vaultBalance = await this.txService.getConnection().getBalance(vaultPda);
    const rent = await this.txService.getConnection().getMinimumBalanceForRentExemption(
      (await this.txService.getConnection().getAccountInfo(vaultPda))?.data.length ?? 0,
    );
    const available = vaultBalance - rent;

    if (available <= 0) {
      throw new Error('Vault PDA has no distributable SOL above rent exemption');
    }

    const amount = new BN(Math.floor(available * shareBps / 10000));
    if (amount.isZero()) {
      throw new Error(`Calculated distribution amount is 0 for ${shareBps} bps`);
    }

    const agentKeypair = await this.keyManager.getKeypair();
    const sig = await this.txService.executeDistribution(
      agentKeypair, this.ownerPubkey, beneficiaryWallet, amount,
    );

    this.totalSolDistributed = this.totalSolDistributed.add(amount);
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
    await this.keyManager.destroyKey();
  }
}
