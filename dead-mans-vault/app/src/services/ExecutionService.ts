import { PublicKey } from '@solana/web3.js';
import { BN } from '@coral-xyz/anchor';
import { KeyManager } from '../tee/KeyManager';
import { VaultTransactionService } from './VaultTransactionService';
import {
  saveExecutionStep,
  getLastCompletedStep,
  updateStepStatus,
  clearDistributableSnapshot,
  saveDistributableSnapshot,
  getDistributableSnapshot,
  saveTokenSnapshot,
  getTokenSnapshot,
  clearTokenSnapshot,
  TokenSnapshotEntry,
} from '../db/executionRepo';
import { ExecutionStep, ExecutionStepType } from '../types/execution';
import { Beneficiary } from '../types/vault';
import { DeFiPosition } from '../types/defi';
import { DeFiClosureService } from '../defi/closer';

// Module-level guard prevents concurrent execution across multiple instances
let globalExecutionInProgress = false;

export class ExecutionService {
  private ownerPubkey: PublicKey;
  private beneficiaries: Beneficiary[];
  private defiPositions: DeFiPosition[];

  private txService: VaultTransactionService;
  private keyManager: KeyManager;

  private totalSolDistributed: BN = new BN(0);
  private tokenTypesDistributed: number = 0;
  private vaultTokens: TokenSnapshotEntry[] = [];

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
    if (globalExecutionInProgress) return;
    globalExecutionInProgress = true;

    try {
      // Wait for the on-chain grace period to fully elapse before attempting execution.
      // The client-side escalation may fire Stage 4 slightly before the on-chain deadline
      // due to clock drift or TX confirmation delays on heartbeat recording.
      await this.waitForOnChainDeadline();

      const ownerWallet = this.ownerPubkey.toString();
      const lastCompleted = await getLastCompletedStep(ownerWallet);

      // Scan vault PDA's token balances (or recover from snapshot)
      let tokenSnapshot = await getTokenSnapshot(ownerWallet);
      if (!tokenSnapshot) {
        const [vaultPda] = this.txService.getVaultPDA(this.ownerPubkey);
        const vaultTokens = await this.txService.getVaultTokenBalances(vaultPda);
        tokenSnapshot = vaultTokens.map((t) => ({
          mint: t.mint.toString(),
          amount: t.amount,
          decimals: t.decimals,
          symbol: '',
        }));
        if (tokenSnapshot.length > 0) {
          await saveTokenSnapshot(tokenSnapshot, ownerWallet);
        }
      }
      this.vaultTokens = tokenSnapshot;

      const steps = this.buildExecutionPlan();

      // Save all steps to SQLite
      for (const step of steps) {
        if (step.order > lastCompleted) {
          await saveExecutionStep(step, ownerWallet);
        }
      }

      // Reconstitute totalSolDistributed from already-completed distribute_sol steps
      // so crash recovery doesn't reset the running total to zero
      this.totalSolDistributed = new BN(0);
      for (const step of steps) {
        if (step.order <= lastCompleted && step.type === 'distribute_sol' && step.metadata?.shareBps) {
          const snapshot = await getDistributableSnapshot(ownerWallet);
          if (snapshot !== null) {
            const amount = Math.floor(snapshot * (step.metadata.shareBps as number) / 10000);
            this.totalSolDistributed = this.totalSolDistributed.add(new BN(amount));
          }
        }
      }

      // Track failures to protect agent key for recovery
      let hasDistributionFailure = false;
      let recordExecutionSucceeded = false;

      // Execute sequentially, skip completed and pre-skipped steps
      for (const step of steps) {
        if (step.order <= lastCompleted) continue;
        const scopedId = `${ownerWallet}_${step.id}`;
        if (step.status === 'skipped') {
          await updateStepStatus(scopedId, 'completed');
          continue;
        }

        // If a distribution failed, skip record_execution, close_executed_vault, and self_terminate
        // to preserve the agent key for manual recovery
        if (hasDistributionFailure && (step.type === 'record_execution_log' || step.type === 'close_executed_vault' || step.type === 'self_terminate')) {
          await updateStepStatus(scopedId, 'failed', undefined,
            'Skipped: prior distribution step failed. Agent key preserved for recovery.');
          continue;
        }

        // Defense in depth: never close vault or destroy agent key unless record_execution succeeded
        if ((step.type === 'close_executed_vault' || step.type === 'self_terminate') && !recordExecutionSucceeded) {
          await updateStepStatus(scopedId, 'failed', undefined,
            'Skipped: record_execution did not succeed. Agent key preserved for recovery.');
          continue;
        }

        await updateStepStatus(scopedId, 'in_progress');

        try {
          const txSig = await this.executeStep(step);
          await updateStepStatus(scopedId, 'completed', txSig);
          if (step.type === 'record_execution_log') {
            recordExecutionSucceeded = true;
          }
        } catch (err: any) {
          // Set failure flag BEFORE updateStepStatus to guarantee it's always set
          // even if the DB write throws
          if (step.type === 'distribute_sol' || step.type === 'distribute_token' || step.type === 'close_defi_position') {
            hasDistributionFailure = true;
          }
          try {
            await updateStepStatus(scopedId, 'failed', undefined, err.message);
          } catch {
            // DB write failed — hasDistributionFailure is already set above
          }
        }
      }
    } finally {
      globalExecutionInProgress = false;
    }
  }

  /**
   * Poll the on-chain deadline until it has passed, with a small buffer.
   * Uses the Solana cluster clock (via getBlockTime) as the reference,
   * not the local device clock, to match what the program sees.
   */
  private async waitForOnChainDeadline(): Promise<void> {
    const MAX_WAIT_MS = 120_000;
    const POLL_INTERVAL_MS = 5_000;
    const BUFFER_SECONDS = 2;
    const start = Date.now();

    while (Date.now() - start < MAX_WAIT_MS) {
      const deadline = await this.txService.getOnChainDeadline(this.ownerPubkey);
      if (deadline === null) return; // Can't read accounts — proceed anyway

      // Use cluster clock: get latest slot's block time
      const slot = await this.txService.getConnection().getSlot('confirmed');
      const blockTime = await this.txService.getConnection().getBlockTime(slot);
      if (blockTime === null) return; // Can't get cluster time — proceed anyway

      if (blockTime > deadline + BUFFER_SECONDS) {
        return; // On-chain deadline has passed — safe to execute
      }

      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    // Max wait exceeded — proceed anyway (execution will fail on-chain if too early,
    // and the failure guards will preserve the agent key)
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

    // Distribute SOL from vault PDA to each beneficiary
    for (const b of this.beneficiaries) {
      const label = b.label || b.wallet.toString().slice(0, 8);
      steps.push(
        this.makeStep(
          order++,
          'distribute_sol',
          `Distribute ${(b.shareBps / 100).toFixed(1)}% SOL to ${label}`,
          'pending',
          { beneficiaryWallet: b.wallet.toString(), shareBps: b.shareBps },
        ),
      );
    }

    // Distribute SPL tokens from vault PDA's ATAs to each beneficiary
    for (const token of this.vaultTokens) {
      for (const b of this.beneficiaries) {
        const label = b.label || b.wallet.toString().slice(0, 8);
        const tokenLabel = token.symbol || token.mint.slice(0, 6);
        const shareAmount = Math.floor(token.amount * b.shareBps / 10000);
        if (shareAmount <= 0) continue;

        steps.push(
          this.makeStep(
            order++,
            'distribute_token',
            `Distribute ${(b.shareBps / 100).toFixed(1)}% ${tokenLabel} to ${label}`,
            'pending',
            {
              beneficiaryWallet: b.wallet.toString(),
              shareBps: b.shareBps,
              mint: token.mint,
              amount: shareAmount,
              decimals: token.decimals,
              symbol: token.symbol,
            },
          ),
        );
      }
    }

    // Burn assets (skipped for MVP)
    steps.push(this.makeStep(order++, 'burn_asset', 'Burn designated assets', 'skipped'));

    // Close accounts (skipped for MVP)
    steps.push(this.makeStep(order++, 'close_accounts', 'Close empty accounts', 'skipped'));

    // Record execution log on-chain
    steps.push(this.makeStep(order++, 'record_execution_log', 'Record execution on-chain', 'pending'));

    // Close executed vault PDAs (return rent to owner)
    steps.push(this.makeStep(order++, 'close_executed_vault', 'Close vault PDAs, return rent', 'pending'));

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
        return undefined;

      case 'close_defi_position':
        return this.executeCloseDeFiPosition(step);

      case 'distribute_sol':
        return this.executeDistributeSol(step);

      case 'distribute_token':
        return this.executeDistributeToken(step);

      case 'record_execution_log':
        return this.executeRecordExecution();

      case 'close_executed_vault':
        return this.executeCloseExecutedVault();

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
   * Distribute SOL from vault PDA to a single beneficiary.
   * Uses a snapshot of the vault balance (taken on first distribution step)
   * to ensure consistent amounts across crash recovery.
   */
  private async executeDistributeSol(step: ExecutionStep): Promise<string | undefined> {
    const agentKeypair = await this.keyManager.getKeypair();
    const connection = this.txService.getConnection();
    const [vaultPda] = this.txService.getVaultPDA(this.ownerPubkey);

    // Get or create distributable snapshot for consistent amounts
    const ownerWallet = this.ownerPubkey.toString();
    let distributable = await getDistributableSnapshot(ownerWallet);
    if (distributable === null) {
      const vaultBalance = await connection.getBalance(vaultPda);
      const vaultAccountInfo = await connection.getAccountInfo(vaultPda);
      const dataLen = vaultAccountInfo?.data.length ?? 800;
      const rent = await connection.getMinimumBalanceForRentExemption(dataLen);
      distributable = Math.max(0, vaultBalance - rent);
      await saveDistributableSnapshot(distributable, ownerWallet);
    }

    // No SOL deposited — skip gracefully (vault may only have SPL tokens)
    if (distributable <= 0) {
      return undefined;
    }

    const beneficiaryWallet = new PublicKey(step.metadata?.beneficiaryWallet as string);
    const shareBps = step.metadata?.shareBps as number;
    const amountLamports = Math.floor(distributable * shareBps / 10000);

    if (amountLamports <= 0) {
      return undefined;
    }

    const sig = await this.txService.executeDistribution(
      agentKeypair,
      this.ownerPubkey,
      beneficiaryWallet,
      new BN(amountLamports),
    );

    this.totalSolDistributed = this.totalSolDistributed.add(new BN(amountLamports));
    return sig;
  }

  private async executeDistributeToken(step: ExecutionStep): Promise<string> {
    const agentKeypair = await this.keyManager.getKeypair();
    const beneficiaryWallet = new PublicKey(step.metadata?.beneficiaryWallet as string);
    const mint = new PublicKey(step.metadata?.mint as string);
    const amount = new BN(step.metadata?.amount as number);

    const sig = await this.txService.executeSplDistribution(
      agentKeypair,
      this.ownerPubkey,
      beneficiaryWallet,
      mint,
      amount,
    );

    this.tokenTypesDistributed++;
    return sig;
  }

  private async executeRecordExecution(): Promise<string> {
    const agentKeypair = await this.keyManager.getKeypair();

    const attestationHash = new Array(32).fill(0);
    const uniqueTokenCount = new Set(this.vaultTokens.map((t) => t.mint)).size;
    const solTransfers = this.beneficiaries.length;
    const tokenTransfers = this.vaultTokens.length > 0
      ? this.beneficiaries.length * uniqueTokenCount
      : 0;

    return this.txService.recordExecution(agentKeypair, this.ownerPubkey, {
      transferCount: solTransfers + tokenTransfers,
      totalSolDistributed: this.totalSolDistributed,
      tokenTypesDistributed: uniqueTokenCount,
      attestationHash,
      completed: true,
    });
  }

  private async executeCloseExecutedVault(): Promise<string> {
    const agentKeypair = await this.keyManager.getKeypair();
    return this.txService.closeExecutedVault(agentKeypair, this.ownerPubkey);
  }

  private async executeSelfTerminate(): Promise<void> {
    const ownerWallet = this.ownerPubkey.toString();
    await clearDistributableSnapshot(ownerWallet);
    await clearTokenSnapshot(ownerWallet);
    await this.keyManager.destroyKey();
  }
}
