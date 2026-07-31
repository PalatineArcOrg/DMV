import { PublicKey } from '@solana/web3.js';
import {
  getBlockingHeartbeatOperation,
  getUnresolvedHeartbeatOperation,
  prepareHeartbeatOperation,
  transitionStoredHeartbeatOperation,
} from '../db/heartbeatOperationRepo';
import type {
  HeartbeatOperationIdentity,
  HeartbeatOperationRecord,
  HeartbeatOperationState,
  HeartbeatOperationTransitionPatch,
} from '../db/heartbeatOperationRepoCore';
import { heartbeatOperationIdentityKey } from '../db/heartbeatOperationRepoCore';
import type {
  AuthoritativeHeartbeatCacheInput,
} from '../db/heartbeatRepo';
import type { HeartbeatMethod } from '../types/heartbeat';
import {
  EXPECTED_CLUSTER,
  PROGRAM_ID,
} from '../utils/constants';
import { parseVaultConfig } from '../utils/rawAccountParsers';
import type { AgentReadinessResult } from './AgentReadinessService';
import {
  createDefaultHeartbeatConfirmationVerifier,
} from './DefaultHeartbeatConfirmationVerifier';
import {
  createHeartbeatOperationReconciler,
  type HeartbeatReconciliationResult,
} from './HeartbeatOperationReconciler';
import type { ConfirmedHeartbeatLocalInput } from './HeartbeatCoordinator';
import type { PreparedTransaction } from './sendAndConfirmTransaction';
import { VaultTransactionService } from './VaultTransactionService';

type ReadyAgent = Extract<AgentReadinessResult, { status: 'ready' }>;

export interface HeartbeatReconciliationCallbacks {
  recordConfirmedHeartbeat: (
    input: ConfirmedHeartbeatLocalInput,
  ) => Promise<void>;
  recordAuthoritativeUnattributedHeartbeat: (
    input: AuthoritativeHeartbeatCacheInput,
  ) => Promise<void>;
  resetLocalEscalation: () => void;
  reloadVaultState: () => Promise<void>;
}

export class DefaultHeartbeatOperationService {
  private readonly transactions = new VaultTransactionService();
  private readonly connection = this.transactions.getConnection();
  private readonly verifier =
    createDefaultHeartbeatConfirmationVerifier();
  private readonly reconciliationInFlight = new Map<
    string,
    Promise<HeartbeatReconciliationResult>
  >();

  identityFor(
    owner: PublicKey,
    agentPubkey: PublicKey,
  ): HeartbeatOperationIdentity {
    const [vault] = this.transactions.getVaultPDA(owner);
    const [heartbeat] = this.transactions.getHeartbeatPDA(vault);
    return {
      cluster: EXPECTED_CLUSTER,
      programId: PROGRAM_ID,
      owner: owner.toBase58(),
      vault: vault.toBase58(),
      heartbeat: heartbeat.toBase58(),
      agentPubkey: agentPubkey.toBase58(),
    };
  }

  async getUnresolved(
    owner: PublicKey,
  ): Promise<HeartbeatOperationRecord | null> {
    const [vault] = this.transactions.getVaultPDA(owner);
    return getBlockingHeartbeatOperation({
      cluster: EXPECTED_CLUSTER,
      programId: PROGRAM_ID,
      owner: owner.toBase58(),
      vault: vault.toBase58(),
    });
  }

  async getReconciliable(
    owner: PublicKey,
  ): Promise<HeartbeatOperationRecord | null> {
    const [vault] = this.transactions.getVaultPDA(owner);
    return getUnresolvedHeartbeatOperation({
      cluster: EXPECTED_CLUSTER,
      programId: PROGRAM_ID,
      owner: owner.toBase58(),
      vault: vault.toBase58(),
    });
  }

  async prepare(
    readiness: ReadyAgent,
    method: HeartbeatMethod,
    prepared: PreparedTransaction,
  ): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    await prepareHeartbeatOperation({
      ...this.identityFor(readiness.owner, readiness.localAgent),
      method,
      methodIndex: {
        active_tap: 0,
        biometric_confirm: 1,
        on_chain_activity: 2,
        pin_challenge: 3,
        hardware_switch: 4,
      }[method],
      signature: prepared.signature,
      blockhash: prepared.blockhash,
      lastValidBlockHeight: prepared.lastValidBlockHeight,
      beforeLastHeartbeat: readiness.heartbeatBefore.lastHeartbeat,
      beforeTotalHeartbeats:
        readiness.heartbeatBefore.totalHeartbeats.toString(10),
      heartbeatInterval: readiness.vaultConfig.heartbeatInterval,
      gracePeriod: readiness.vaultConfig.gracePeriod,
      createdAt: now,
      updatedAt: now,
    });
  }

  transition(
    signature: string,
    state: HeartbeatOperationState,
    patch: HeartbeatOperationTransitionPatch = {},
  ): Promise<HeartbeatOperationRecord> {
    return transitionStoredHeartbeatOperation(signature, state, patch);
  }

  async reconcile(
    operation: HeartbeatOperationRecord,
    callbacks: HeartbeatReconciliationCallbacks,
  ): Promise<HeartbeatReconciliationResult> {
    const key = heartbeatOperationIdentityKey(operation);
    const existing = this.reconciliationInFlight.get(key);
    if (existing) {
      return existing;
    }
    const task = this.reconcileOnce(operation, callbacks);
    this.reconciliationInFlight.set(key, task);
    try {
      return await task;
    } finally {
      if (this.reconciliationInFlight.get(key) === task) {
        this.reconciliationInFlight.delete(key);
      }
    }
  }

  private async reconcileOnce(
    operation: HeartbeatOperationRecord,
    callbacks: HeartbeatReconciliationCallbacks,
  ): Promise<HeartbeatReconciliationResult> {
    const currentIdentity: HeartbeatOperationIdentity = {
      cluster: operation.cluster,
      programId: operation.programId,
      owner: operation.owner,
      vault: operation.vault,
      heartbeat: operation.heartbeat,
      agentPubkey: operation.agentPubkey,
    };
    const reconciler = createHeartbeatOperationReconciler({
      currentIdentity,
      validateOperationIdentity: async (candidate) => {
        if (
          candidate.cluster !== EXPECTED_CLUSTER ||
          candidate.programId !== PROGRAM_ID
        ) {
          return false;
        }
        const owner = new PublicKey(candidate.owner);
        const [vault, vaultBump] =
          this.transactions.getVaultPDA(owner);
        const [heartbeat] =
          this.transactions.getHeartbeatPDA(vault);
        if (
          vault.toBase58() !== candidate.vault ||
          heartbeat.toBase58() !== candidate.heartbeat
        ) {
          return false;
        }
        const account = await this.connection.getAccountInfo(vault);
        if (!account) return false;
        const parsed = parseVaultConfig(
          {
            owner: account.owner,
            data: Buffer.from(account.data),
          },
          new PublicKey(PROGRAM_ID),
        );
        return Boolean(
          parsed &&
          parsed.bump === vaultBump &&
          parsed.owner.equals(owner) &&
          parsed.agentPubkey.toBase58() === candidate.agentPubkey,
        );
      },
      getSignatureStatuses: (signatures, config) =>
        this.connection.getSignatureStatuses(signatures, config),
      getBlockHeight: () =>
        this.connection.getBlockHeight('confirmed'),
      verifyHeartbeatConfirmation: (input) =>
        this.verifier.verify(input),
      readCurrentHeartbeat: (input) =>
        this.verifier.readCurrent(input),
      recordConfirmedHeartbeat: callbacks.recordConfirmedHeartbeat,
      recordAuthoritativeUnattributedHeartbeat: async (input) => {
        await callbacks.recordAuthoritativeUnattributedHeartbeat({
          ...input.identity,
          timestamp: input.lastHeartbeat,
          method: input.method,
          totalHeartbeats: input.totalHeartbeats,
          source: 'chain_advanced_unattributed',
        });
      },
      resetLocalEscalation: callbacks.resetLocalEscalation,
      reloadVaultState: callbacks.reloadVaultState,
      transitionOperation: (signature, state, patch) =>
        this.transition(signature, state, patch),
    });
    return reconciler.reconcile(operation);
  }
}
