import * as Crypto from 'expo-crypto';
import {
  PublicKey,
  SystemProgram,
  Transaction,
} from '@solana/web3.js';
import {
  getBlockingAgentRotationOperation,
  prepareAgentRotationOperation,
  transitionStoredAgentRotation,
} from '../db/agentRotationRepo';
import {
  getUnresolvedCandidateFunding,
  getUnresolvedCandidateFundingForVault,
  prepareCandidateFundingOperation,
  transitionStoredCandidateFunding,
} from '../db/agentCandidateFundingRepo';
import type {
  CandidateFundingOperation,
} from '../db/agentCandidateFundingRepoCore';
import type {
  AgentRotationIdentity,
  AgentRotationOperationRecord,
} from '../db/agentRotationRepoCore';
import { getBlockingHeartbeatOperation } from '../db/heartbeatOperationRepo';
import { assertNetworkVerified } from '../store/useNetworkStore';
import { KeyManager } from '../tee/KeyManager';
import {
  EXPECTED_CLUSTER,
  PROGRAM_ID,
} from '../utils/constants';
import {
  parseHeartbeatRecord,
  parseVaultConfig,
} from '../utils/rawAccountParsers';
import {
  createAgentCandidateFundingService,
  type CandidateFundingResult,
} from './AgentCandidateFundingService';
import {
  createAgentRotationCoordinator,
  type AgentRotationCoordinator,
  type AgentRotationPreflightResult,
} from './AgentRotationCoordinator';
import {
  createAgentRotationReconciler,
  rotationVerificationInputFromOperation,
  type AgentRotationReconciliationResult,
} from './AgentRotationReconciler';
import {
  createAgentRotationTransactionPreparer,
} from './AgentRotationTransaction';
import {
  createAgentRotationVerifier,
  type VerifiedRotationChainState,
} from './AgentRotationVerifier';
import { VaultTransactionService } from './VaultTransactionService';

export interface CandidateFundingConfirmation {
  candidate: PublicKey;
  transferLamports: number;
  ownerFeeLamports: number;
}

export interface AgentRotationWalletDependencies {
  signWithOwnerWallet: (
    transaction: Transaction,
  ) => Promise<Transaction>;
  confirmCandidateFunding: (
    confirmation: CandidateFundingConfirmation,
  ) => Promise<boolean>;
  isOwnerCancellation: (error: unknown) => boolean;
  refreshAuthoritativeDeadline: () => Promise<void>;
}

function safeNumber(value: { toNumber: () => number }): number | null {
  try {
    const numberValue = value.toNumber();
    return Number.isSafeInteger(numberValue) && numberValue >= 0
      ? numberValue
      : null;
  } catch {
    return null;
  }
}

function checkedAdd(left: number, right: number): number | null {
  const result = left + right;
  return Number.isSafeInteger(result) ? result : null;
}

function stableVaultConfig(
  value: NonNullable<ReturnType<typeof parseVaultConfig>>,
): string {
  return JSON.stringify({
    owner: value.owner.toBase58(),
    heartbeatInterval: value.heartbeatInterval.toString(10),
    gracePeriod: value.gracePeriod.toString(10),
    beneficiaries: value.beneficiaries.map((beneficiary) => ({
      wallet: beneficiary.wallet.toBase58(),
      shareBps: beneficiary.shareBps,
    })),
    active: value.active,
    executed: value.executed,
    bump: value.bump,
    isMutable: value.isMutable,
    hasAssetPlan: value.hasAssetPlan,
    openTokenDists: value.openTokenDists,
  });
}

export class DefaultAgentRotationService {
  private readonly transactions = new VaultTransactionService();
  private readonly connection = this.transactions.getConnection();
  private readonly keys = KeyManager.getInstance();
  private readonly programId = new PublicKey(PROGRAM_ID);
  private readonly reconciliationInFlight = new Map<
    string,
    Promise<AgentRotationReconciliationResult>
  >();

  private identity(owner: PublicKey): AgentRotationIdentity {
    const [vault] = this.transactions.getVaultPDA(owner);
    const [heartbeat] = this.transactions.getHeartbeatPDA(vault);
    return {
      cluster: EXPECTED_CLUSTER,
      programId: PROGRAM_ID,
      owner: owner.toBase58(),
      vault: vault.toBase58(),
      heartbeat: heartbeat.toBase58(),
    };
  }

  private async fetchVerifiedState(
    owner: PublicKey,
  ): Promise<VerifiedRotationChainState | null> {
    const [vault, vaultBump] =
      this.transactions.getVaultPDA(owner);
    const [heartbeat, heartbeatBump] =
      this.transactions.getHeartbeatPDA(vault);
    const slot = await this.connection.getSlot('confirmed');
    const chainUnixTime = await this.connection.getBlockTime(slot);
    if (
      !Number.isSafeInteger(slot) ||
      slot < 0 ||
      !Number.isSafeInteger(chainUnixTime) ||
      chainUnixTime === null ||
      chainUnixTime < 0
    ) {
      return null;
    }
    const accounts =
      await this.connection.getMultipleAccountsInfoAndContext(
        [vault, heartbeat],
        { commitment: 'confirmed', minContextSlot: slot },
      );
    if (
      !accounts ||
      !accounts.context ||
      accounts.context.slot < slot ||
      accounts.value.length !== 2 ||
      !accounts.value[0] ||
      !accounts.value[1]
    ) {
      return null;
    }
    const vaultConfig = parseVaultConfig(
      {
        owner: accounts.value[0].owner,
        data: Buffer.from(accounts.value[0].data),
      },
      this.programId,
    );
    const heartbeatRecord = parseHeartbeatRecord(
      {
        owner: accounts.value[1].owner,
        data: Buffer.from(accounts.value[1].data),
      },
      this.programId,
    );
    if (
      !vaultConfig ||
      !heartbeatRecord ||
      !vaultConfig.owner.equals(owner) ||
      vaultConfig.bump !== vaultBump ||
      !heartbeatRecord.vault.equals(vault) ||
      heartbeatRecord.bump !== heartbeatBump
    ) {
      return null;
    }
    const heartbeatInterval = safeNumber(
      vaultConfig.heartbeatInterval,
    );
    const gracePeriod = safeNumber(vaultConfig.gracePeriod);
    const vaultUpdatedAt = safeNumber(vaultConfig.updatedAt);
    const lastHeartbeat = safeNumber(
      heartbeatRecord.lastHeartbeat,
    );
    if (
      heartbeatInterval === null ||
      gracePeriod === null ||
      vaultUpdatedAt === null ||
      lastHeartbeat === null
    ) {
      return null;
    }
    const configFingerprint = await Crypto.digestStringAsync(
      Crypto.CryptoDigestAlgorithm.SHA256,
      stableVaultConfig(vaultConfig),
    );
    return {
      owner,
      vault,
      heartbeat,
      agent: vaultConfig.agentPubkey,
      active: vaultConfig.active,
      executed: vaultConfig.executed,
      vaultUpdatedAt,
      lastHeartbeat,
      totalHeartbeats: heartbeatRecord.totalHeartbeats,
      heartbeatInterval,
      gracePeriod,
      configFingerprint,
      chainUnixTime,
    };
  }

  private async checkPreflight(
    owner: PublicKey,
  ): Promise<AgentRotationPreflightResult> {
    if (EXPECTED_CLUSTER !== 'devnet') {
      return { status: 'invalid_on_chain_state' };
    }
    let state: VerifiedRotationChainState | null;
    try {
      state = await this.fetchVerifiedState(owner);
    } catch {
      return { status: 'rpc_unavailable' };
    }
    if (!state) return { status: 'invalid_on_chain_state' };
    if (!state.active) return { status: 'vault_inactive' };
    if (state.executed) return { status: 'vault_executed' };
    const nextDue = checkedAdd(
      state.lastHeartbeat,
      state.heartbeatInterval,
    );
    const finalDeadline =
      nextDue === null
        ? null
        : checkedAdd(nextDue, state.gracePeriod);
    if (finalDeadline === null) {
      return { status: 'invalid_on_chain_state' };
    }
    if (state.chainUnixTime >= finalDeadline) {
      return { status: 'deadline_reached' };
    }
    return {
      status: 'ready',
      value: {
        identity: this.identity(owner),
        state,
        finalDeadline,
      },
    };
  }

  inspect(
    owner: PublicKey,
  ): Promise<AgentRotationPreflightResult> {
    return this.checkPreflight(owner);
  }

  private async provePromotedCandidate(
    candidateAgent: string,
  ): Promise<boolean> {
    let keypair;
    try {
      keypair =
        await this.keys.loadKeypairByExactPublicKey(candidateAgent);
    } catch {
      return false;
    }
    const transaction = new Transaction({
      feePayer: keypair.publicKey,
      recentBlockhash: PublicKey.default.toBase58(),
    }).add(
      SystemProgram.transfer({
        fromPubkey: keypair.publicKey,
        toPubkey: keypair.publicKey,
        lamports: 0,
      }),
    );
    transaction.partialSign(keypair);
    return transaction.verifySignatures();
  }

  private async verifyOperation(
    operation: AgentRotationOperationRecord,
  ) {
    return createAgentRotationVerifier({
      fetchVerifiedState: (owner) =>
        this.fetchVerifiedState(owner),
    }).verify(rotationVerificationInputFromOperation(operation));
  }

  private async reconcileCandidateFunding(
    operation: CandidateFundingOperation,
  ): Promise<'confirmed' | 'failed' | 'expired' | 'pending'> {
    let response: unknown;
    try {
      response = await this.connection.getSignatureStatuses(
        [operation.signature],
        { searchTransactionHistory: true },
      );
    } catch {
      await transitionStoredCandidateFunding(
        operation.signature,
        operation.state,
        'status_rpc_unavailable',
      );
      return 'pending';
    }
    const statuses =
      response && typeof response === 'object'
        ? Reflect.get(response, 'value')
        : null;
    if (!Array.isArray(statuses) || statuses.length !== 1) {
      await transitionStoredCandidateFunding(
        operation.signature,
        operation.state,
        'status_malformed',
      );
      return 'pending';
    }
    const status = statuses[0];
    if (
      status !== null &&
      (
        typeof status !== 'object' ||
        !Object.prototype.hasOwnProperty.call(status, 'err')
      )
    ) {
      await transitionStoredCandidateFunding(
        operation.signature,
        operation.state,
        'status_malformed',
      );
      return 'pending';
    }
    if (
      status &&
      typeof status === 'object' &&
      Reflect.get(status, 'err') !== null
    ) {
      await transitionStoredCandidateFunding(
        operation.signature,
        'resolved_failed',
        'transaction_failed',
      );
      return 'failed';
    }
    if (
      status &&
      typeof status === 'object' &&
      Reflect.get(status, 'err') === null &&
      (
        Reflect.get(status, 'confirmationStatus') === 'confirmed' ||
        Reflect.get(status, 'confirmationStatus') === 'finalized'
      )
    ) {
      await transitionStoredCandidateFunding(
        operation.signature,
        'resolved_confirmed',
        null,
      );
      return 'confirmed';
    }
    if (status !== null) return 'pending';

    let blockHeight: number;
    try {
      blockHeight =
        await this.connection.getBlockHeight('confirmed');
    } catch {
      await transitionStoredCandidateFunding(
        operation.signature,
        operation.state,
        'block_height_rpc_unavailable',
      );
      return 'pending';
    }
    if (blockHeight <= operation.lastValidBlockHeight) {
      return 'pending';
    }
    await transitionStoredCandidateFunding(
      operation.signature,
      'resolved_expired',
      null,
    );
    return 'expired';
  }

  async reconcile(
    operation: AgentRotationOperationRecord,
  ): Promise<AgentRotationReconciliationResult> {
    const identityKey = [
      operation.cluster,
      operation.programId,
      operation.owner,
      operation.vault,
    ].join(':');
    const existing = this.reconciliationInFlight.get(identityKey);
    if (existing) return existing;
    const task = this.reconcileOnce(operation);
    this.reconciliationInFlight.set(identityKey, task);
    try {
      return await task;
    } finally {
      if (this.reconciliationInFlight.get(identityKey) === task) {
        this.reconciliationInFlight.delete(identityKey);
      }
    }
  }

  private async reconcileOnce(
    operation: AgentRotationOperationRecord,
  ): Promise<AgentRotationReconciliationResult> {
    const reconciler = createAgentRotationReconciler({
      validateIdentity: async (record) => {
        const expected = this.identity(new PublicKey(record.owner));
        return (
          record.cluster === 'devnet' &&
          record.programId === expected.programId &&
          record.vault === expected.vault &&
          record.heartbeat === expected.heartbeat
        );
      },
      getSignatureStatuses: (signatures, config) =>
        this.connection.getSignatureStatuses(signatures, config),
      getBlockHeight: () =>
        this.connection.getBlockHeight('confirmed'),
      verifyPostState: (record) => this.verifyOperation(record),
      promoteCandidate: (oldAgent, candidateAgent) =>
        this.keys.promoteCandidate(oldAgent, candidateAgent),
      provePromotedCandidate: (candidateAgent) =>
        this.provePromotedCandidate(candidateAgent),
      transition: (signature, state, patch) =>
        transitionStoredAgentRotation(signature, state, patch),
    });
    return reconciler.reconcile(operation);
  }

  async reconcileForOwner(
    owner: PublicKey,
  ): Promise<AgentRotationReconciliationResult | null> {
    const funding =
      await getUnresolvedCandidateFundingForVault(
        this.identity(owner),
      );
    if (funding) {
      await this.reconcileCandidateFunding(funding);
    }
    const operation = await getBlockingAgentRotationOperation(
      this.identity(owner),
    );
    return operation ? this.reconcile(operation) : null;
  }

  createCoordinator(
    wallet: AgentRotationWalletDependencies,
  ): AgentRotationCoordinator {
    const preparer = createAgentRotationTransactionPreparer({
      buildRotationTransaction: async (owner, candidate) => {
        assertNetworkVerified('Agent rotation');
        return this.transactions.buildRotateAgentTx(
          owner,
          candidate,
        );
      },
      getLatestBlockhash: () =>
        this.connection.getLatestBlockhash('confirmed'),
      getFeeForMessage: async (transaction) =>
        this.connection.getFeeForMessage(
          transaction.compileMessage(),
          'confirmed',
        ),
      getCandidateBalance: (candidate, minimumContextSlot) =>
        this.connection.getBalanceAndContext(candidate, {
          commitment: 'confirmed',
          minContextSlot: minimumContextSlot,
        }),
      signWithOwnerWallet: wallet.signWithOwnerWallet,
      isOwnerCancellation: wallet.isOwnerCancellation,
    });
    return createAgentRotationCoordinator({
      checkPreflight: (owner) => this.checkPreflight(owner),
      hasBlockingHeartbeatOperation: async (owner) => {
        const identity = this.identity(owner);
        return Boolean(
          await getBlockingHeartbeatOperation({
            cluster: identity.cluster,
            programId: identity.programId,
            owner: identity.owner,
            vault: identity.vault,
          }),
        );
      },
      reconcileCandidateFunding: async (owner) => {
        const identity = this.identity(owner);
        const existing =
          await getUnresolvedCandidateFundingForVault(identity);
        if (!existing) return false;
        await this.reconcileCandidateFunding(existing);
        return Boolean(
          await getUnresolvedCandidateFundingForVault(identity),
        );
      },
      getBlockingRotation: (identity) =>
        getBlockingAgentRotationOperation(identity),
      reconcileRotation: (operation) => this.reconcile(operation),
      resolveStoredAgent: (agent) =>
        this.keys.resolveStoredAgentForOnChainPubkey(agent),
      hasRetainedPreviousKey: async () =>
        (await this.keys.getPreviousAgentPublicKey()) !== null,
      generateCandidate: () =>
        this.keys.generateCandidateAgentKey(),
      loadCandidate: () => this.keys.loadCandidateKeypair(),
      prepareTransaction: (owner, candidate) =>
        preparer.prepare(owner, candidate),
      persistPrepared: async (input) => {
        const now = Math.floor(Date.now() / 1000);
        await prepareAgentRotationOperation({
          ...input.preflight.identity,
          oldAgent:
            input.preflight.state.agent.toBase58(),
          candidateAgent: input.candidateAgent,
          signature: input.signature,
          blockhash: input.blockhash,
          lastValidBlockHeight: input.lastValidBlockHeight,
          beforeLastHeartbeat:
            input.preflight.state.lastHeartbeat,
          beforeTotalHeartbeats:
            input.preflight.state.totalHeartbeats.toString(10),
          beforeVaultUpdatedAt:
            input.preflight.state.vaultUpdatedAt,
          beforeFinalDeadline: input.preflight.finalDeadline,
          beforeConfigFingerprint:
            input.preflight.state.configFingerprint,
          createdAt: now,
          updatedAt: now,
        });
      },
      sendRawTransaction: (serialized) =>
        this.connection.sendRawTransaction(serialized, {
          skipPreflight: false,
          preflightCommitment: 'confirmed',
        }),
      confirmTransaction: (strategy) =>
        this.connection.confirmTransaction(strategy, 'confirmed'),
      transitionRotation: (signature, state, patch) =>
        transitionStoredAgentRotation(signature, state, patch),
      verifyPostState: async (input) =>
        createAgentRotationVerifier({
          fetchVerifiedState: (owner) =>
            this.fetchVerifiedState(owner),
        }).verify({
          owner: input.state.owner,
          vault: input.state.vault,
          heartbeat: input.state.heartbeat,
          oldAgent: input.state.agent,
          candidateAgent: input.candidateAgent,
          beforeVaultUpdatedAt: input.state.vaultUpdatedAt,
          beforeLastHeartbeat: input.state.lastHeartbeat,
          beforeTotalHeartbeats: input.state.totalHeartbeats,
          beforeConfigFingerprint:
            input.state.configFingerprint,
        }),
      promoteCandidate: (oldAgent, candidateAgent) =>
        this.keys.promoteCandidate(oldAgent, candidateAgent),
      provePromotedCandidate: (candidateAgent) =>
        this.provePromotedCandidate(candidateAgent),
      refreshAuthoritativeDeadline:
        wallet.refreshAuthoritativeDeadline,
    });
  }

  async fundCandidate(
    owner: PublicKey,
    expectedCandidate: PublicKey,
    wallet: AgentRotationWalletDependencies,
  ): Promise<CandidateFundingResult> {
    assertNetworkVerified('Candidate-agent funding');
    const identity = {
      ...this.identity(owner),
      candidateAgent: expectedCandidate.toBase58(),
    };
    const existing =
      await getUnresolvedCandidateFunding(identity);
    if (existing) {
      const reconciliation =
        await this.reconcileCandidateFunding(existing);
      if (reconciliation === 'pending') {
        return {
          status: 'confirmation_unknown',
          signature: existing.signature,
        };
      }
    }
    const service = createAgentCandidateFundingService({
      validateCandidate: async (
        currentOwner,
        candidate,
      ) => {
        const preflight = await this.checkPreflight(currentOwner);
        if (preflight.status !== 'ready') return false;
        const stored = await this.keys.getCandidatePublicKey();
        const active =
          await this.keys.resolveStoredAgentForOnChainPubkey(
            preflight.value.state.agent.toBase58(),
          );
        return (
          stored === candidate.toBase58() &&
          candidate.equals(expectedCandidate) &&
          active.status === 'active_match' &&
          !(await getBlockingAgentRotationOperation(
            preflight.value.identity,
          ))
        );
      },
      getBalance: (address, minimumContextSlot) =>
        this.connection.getBalanceAndContext(address, {
          commitment: 'confirmed',
          ...(minimumContextSlot === undefined
            ? {}
            : { minContextSlot: minimumContextSlot }),
        }),
      getLatestBlockhash: () =>
        this.connection.getLatestBlockhash('confirmed'),
      getFeeForMessage: (transaction) =>
        this.connection.getFeeForMessage(
          transaction.compileMessage(),
          'confirmed',
        ),
      confirmTransfer: wallet.confirmCandidateFunding,
      signWithOwnerWallet: wallet.signWithOwnerWallet,
      sendRawTransaction: (serialized) =>
        this.connection.sendRawTransaction(serialized, {
          skipPreflight: false,
          preflightCommitment: 'confirmed',
        }),
      confirmTransaction: (strategy) =>
        this.connection.confirmTransaction(strategy, 'confirmed'),
      persistPrepared: async (prepared) => {
        const now = Math.floor(Date.now() / 1000);
        await prepareCandidateFundingOperation({
          ...identity,
          signature: prepared.signature,
          blockhash: prepared.blockhash,
          lastValidBlockHeight:
            prepared.lastValidBlockHeight,
          transferLamports: prepared.transferLamports,
          createdAt: now,
          updatedAt: now,
        });
      },
      transition: async (signature, state, safeErrorCode) => {
        await transitionStoredCandidateFunding(
          signature,
          state,
          safeErrorCode,
        );
      },
      isOwnerCancellation: wallet.isOwnerCancellation,
    });
    return service.fund(owner, expectedCandidate);
  }
}
