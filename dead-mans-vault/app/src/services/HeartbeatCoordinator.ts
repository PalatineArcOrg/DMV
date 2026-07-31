import type { Keypair } from '@solana/web3.js';
import type {
  HeartbeatOperationErrorCode,
  HeartbeatOperationRecord,
  HeartbeatOperationState,
  HeartbeatOperationTransitionPatch,
} from '../db/heartbeatOperationRepoCore';
import type { HeartbeatMethod } from '../types/heartbeat';
import type { AgentReadinessResult } from './AgentReadinessService';
import type {
  HeartbeatVerificationInput,
  HeartbeatVerificationResult,
} from './HeartbeatConfirmationVerifier';
import type { HeartbeatReconciliationResult } from './HeartbeatOperationReconciler';
import type {
  PreparedTransaction,
  SendAndConfirmLifecycle,
  SendAndConfirmResult,
  SubmissionUnknownCode,
} from './sendAndConfirmTransaction';

export type HeartbeatExplorerTransactionStatus =
  | 'confirmed_success'
  | 'confirmed_failed'
  | 'confirmation_unknown'
  | 'submission_unknown'
  | 'pending_reconciliation'
  | 'post_state_unverified';

export type HeartbeatAttemptResult =
  | {
      status: 'confirmed_on_chain';
      signature: string;
      lastHeartbeat: number;
      totalHeartbeats: bigint;
      localSync: 'complete' | 'failed';
    }
  | {
      status: 'heartbeat_in_flight';
    }
  | {
      status: 'heartbeat_still_pending';
      signature: string;
    }
  | {
      status: 'heartbeat_reconciliation_unavailable';
      signature: string;
    }
  | {
      status: 'heartbeat_reconciled_confirmed';
      signature: string;
      lastHeartbeat: number;
      totalHeartbeats: bigint;
      localSync: 'complete';
    }
  | {
      status: 'heartbeat_reconciled_local_sync_pending';
      signature: string;
      lastHeartbeat: number;
      totalHeartbeats: bigint;
    }
  | {
      status: 'heartbeat_reconciled_failed';
      signature: string;
    }
  | {
      status: 'heartbeat_reconciled_expired';
      signature: string;
    }
  | {
      status: 'heartbeat_reconciled_chain_advanced';
      lastHeartbeat: number;
      totalHeartbeats: bigint;
    }
  | {
      status: 'invalid_local_record';
    }
  | {
      status: 'owner_missing';
    }
  | {
      status: 'agent_missing';
    }
  | {
      status: 'agent_unavailable';
    }
  | {
      status: 'agent_mismatch';
      localAgent: string;
      onChainAgent: string;
    }
  | {
      status: 'vault_missing';
    }
  | {
      status: 'vault_inactive';
    }
  | {
      status: 'vault_executed';
    }
  | {
      status: 'rpc_unavailable';
    }
  | {
      status: 'invalid_on_chain_state';
    }
  | {
      status: 'preparation_failed';
      error: unknown;
    }
  | {
      status: 'journal_failed';
      error: unknown;
    }
  | {
      status: 'submission_unknown';
      signature: string;
      error: unknown;
    }
  | {
      status: 'transaction_failed';
      signature: string;
      transactionError: unknown;
    }
  | {
      status: 'confirmation_unknown';
      signature: string;
      error: unknown;
    }
  | {
      status: 'post_state_unavailable';
      signature: string;
    }
  | {
      status: 'post_state_invalid';
      signature: string;
    }
  | {
      status: 'post_state_not_advanced';
      signature: string;
    };

export interface ConfirmedHeartbeatLocalInput {
  method: HeartbeatMethod;
  onChainTimestamp: number;
  transactionSignature: string;
}

type ReadyAgent = Extract<AgentReadinessResult, { status: 'ready' }>;

export interface HeartbeatCoordinatorDependencies {
  method: HeartbeatMethod;
  getUnresolvedOperation: () => Promise<HeartbeatOperationRecord | null>;
  reconcileOperation: (
    operation: HeartbeatOperationRecord,
  ) => Promise<HeartbeatReconciliationResult>;
  checkAgentReadiness: () => Promise<AgentReadinessResult>;
  prepareOperation: (
    readiness: ReadyAgent,
    prepared: PreparedTransaction,
  ) => Promise<void>;
  transitionOperation: (
    signature: string,
    state: HeartbeatOperationState,
    patch?: HeartbeatOperationTransitionPatch,
  ) => Promise<HeartbeatOperationRecord>;
  recordHeartbeatOnChain: (
    agentKeypair: Keypair,
    lifecycle: SendAndConfirmLifecycle,
  ) => Promise<SendAndConfirmResult>;
  verifyHeartbeatConfirmation: (
    input: HeartbeatVerificationInput,
  ) => Promise<HeartbeatVerificationResult>;
  recordConfirmedHeartbeat: (
    input: ConfirmedHeartbeatLocalInput,
  ) => Promise<void>;
  resetLocalEscalation: () => void;
  sendLocalConfirmationNotification: (
    nextDueDate: Date,
  ) => void | Promise<void>;
  reloadVaultState: () => Promise<void>;
  publishExplorerTransaction: (
    signature: string,
    status: HeartbeatExplorerTransactionStatus,
  ) => void;
  publishInFlightState?: (isInFlight: boolean) => void;
}

export interface HeartbeatCoordinator {
  attempt: (
    dependencies: HeartbeatCoordinatorDependencies,
  ) => Promise<HeartbeatAttemptResult>;
  isInFlight: () => boolean;
}

const HEARTBEAT_METHOD_INDEX: Record<HeartbeatMethod, number> = {
  active_tap: 0,
  biometric_confirm: 1,
  on_chain_activity: 2,
  pin_challenge: 3,
  hardware_switch: 4,
};

function readinessFailureResult(
  readiness: Exclude<AgentReadinessResult, { status: 'ready' }>,
): HeartbeatAttemptResult {
  switch (readiness.status) {
    case 'agent_mismatch':
      return {
        status: 'agent_mismatch',
        localAgent: readiness.localAgent.toBase58(),
        onChainAgent: readiness.onChainAgent.toBase58(),
      };
    case 'owner_missing':
    case 'agent_missing':
    case 'agent_unavailable':
    case 'vault_missing':
    case 'vault_inactive':
    case 'vault_executed':
    case 'rpc_unavailable':
    case 'invalid_on_chain_state':
      return { status: readiness.status };
  }
}

function publishExplorerTransactionIgnoringFailure(
  dependencies: HeartbeatCoordinatorDependencies,
  signature: string,
  status: HeartbeatExplorerTransactionStatus,
): void {
  try {
    dependencies.publishExplorerTransaction(signature, status);
  } catch {
    // UI publication cannot change the transaction result.
  }
}

async function reloadVaultStateIgnoringFailure(
  reloadVaultState: () => Promise<void>,
): Promise<void> {
  try {
    await reloadVaultState();
  } catch {
    // A verified chain heartbeat remains successful if UI reload fails.
  }
}

function postStateFailureResult(
  verification: Exclude<
    HeartbeatVerificationResult,
    { status: 'verified' }
  >,
  signature: string,
): HeartbeatAttemptResult {
  if (verification.status === 'rpc_unavailable') {
    return { status: 'post_state_unavailable', signature };
  }
  if (verification.status === 'not_advanced') {
    return { status: 'post_state_not_advanced', signature };
  }
  return { status: 'post_state_invalid', signature };
}

function safeErrorForPostState(
  verification: Exclude<
    HeartbeatVerificationResult,
    { status: 'verified' }
  >,
): HeartbeatOperationErrorCode {
  if (verification.status === 'rpc_unavailable') {
    return 'post_state_rpc_unavailable';
  }
  if (verification.status === 'not_advanced') {
    return 'post_state_not_advanced';
  }
  return 'post_state_invalid';
}

async function transitionIgnoringFailure(
  dependencies: HeartbeatCoordinatorDependencies,
  signature: string,
  state: HeartbeatOperationState,
  patch: HeartbeatOperationTransitionPatch = {},
): Promise<void> {
  try {
    await dependencies.transitionOperation(signature, state, patch);
  } catch {
    // PREPARED remains durable and restart reconciliation can recover it.
  }
}

function mapReconciliationResult(
  dependencies: HeartbeatCoordinatorDependencies,
  result: HeartbeatReconciliationResult,
): HeartbeatAttemptResult {
  switch (result.status) {
    case 'still_pending':
      publishExplorerTransactionIgnoringFailure(
        dependencies,
        result.signature,
        'pending_reconciliation',
      );
      return {
        status: 'heartbeat_still_pending',
        signature: result.signature,
      };
    case 'reconciliation_unavailable':
    case 'post_state_unverified':
      publishExplorerTransactionIgnoringFailure(
        dependencies,
        result.signature,
        result.status === 'reconciliation_unavailable'
          ? 'pending_reconciliation'
          : 'post_state_unverified',
      );
      return {
        status: 'heartbeat_reconciliation_unavailable',
        signature: result.signature,
      };
    case 'reconciled_confirmed':
      publishExplorerTransactionIgnoringFailure(
        dependencies,
        result.signature,
        'confirmed_success',
      );
      return {
        status: 'heartbeat_reconciled_confirmed',
        signature: result.signature,
        lastHeartbeat: result.lastHeartbeat,
        totalHeartbeats: result.totalHeartbeats,
        localSync: 'complete',
      };
    case 'local_sync_pending':
      publishExplorerTransactionIgnoringFailure(
        dependencies,
        result.signature,
        'confirmed_success',
      );
      return {
        status: 'heartbeat_reconciled_local_sync_pending',
        signature: result.signature,
        lastHeartbeat: result.lastHeartbeat,
        totalHeartbeats: result.totalHeartbeats,
      };
    case 'reconciled_failed':
      publishExplorerTransactionIgnoringFailure(
        dependencies,
        result.signature,
        'confirmed_failed',
      );
      return {
        status: 'heartbeat_reconciled_failed',
        signature: result.signature,
      };
    case 'reconciled_expired':
      return {
        status: 'heartbeat_reconciled_expired',
        signature: result.signature,
      };
    case 'reconciled_chain_advanced':
      return {
        status: 'heartbeat_reconciled_chain_advanced',
        lastHeartbeat: result.lastHeartbeat,
        totalHeartbeats: result.totalHeartbeats,
      };
    case 'invalid_local_record':
      return { status: 'invalid_local_record' };
  }
}

function createJournalLifecycle(
  dependencies: HeartbeatCoordinatorDependencies,
  readiness: ReadyAgent,
): SendAndConfirmLifecycle {
  return {
    onPrepared: (prepared) =>
      dependencies.prepareOperation(readiness, prepared),
    onSubmitted: (prepared) =>
      dependencies.transitionOperation(prepared.signature, 'submitted', {
        safeErrorCode: null,
      }).then(() => undefined),
    onSubmissionUnknown: (
      prepared,
      code: SubmissionUnknownCode,
    ) =>
      dependencies.transitionOperation(
        prepared.signature,
        'submission_unknown',
        { safeErrorCode: code },
      ).then(() => undefined),
    onConfirmationUnknown: (prepared, code) =>
      dependencies.transitionOperation(
        prepared.signature,
        'confirmation_unknown',
        { safeErrorCode: code },
      ).then(() => undefined),
    onConfirmedFailed: (prepared) =>
      dependencies.transitionOperation(
        prepared.signature,
        'resolved_failed',
        {
          localSyncState: 'not_applicable',
          safeErrorCode: 'transaction_failed',
        },
      ).then(() => undefined),
  };
}

export function createHeartbeatCoordinator(): HeartbeatCoordinator {
  let inFlight = false;

  return {
    isInFlight: () => inFlight,
    attempt: async (
      dependencies: HeartbeatCoordinatorDependencies,
    ): Promise<HeartbeatAttemptResult> => {
      if (inFlight) {
        return { status: 'heartbeat_in_flight' };
      }

      inFlight = true;
      try {
        dependencies.publishInFlightState?.(true);

        let unresolved: HeartbeatOperationRecord | null;
        try {
          unresolved = await dependencies.getUnresolvedOperation();
        } catch {
          return { status: 'invalid_local_record' };
        }
        if (unresolved) {
          let reconciliation: HeartbeatReconciliationResult;
          try {
            reconciliation =
              await dependencies.reconcileOperation(unresolved);
          } catch {
            return {
              status: 'heartbeat_reconciliation_unavailable',
              signature: unresolved.signature,
            };
          }
          return mapReconciliationResult(dependencies, reconciliation);
        }

        let readiness: AgentReadinessResult;
        try {
          readiness = await dependencies.checkAgentReadiness();
        } catch {
          return { status: 'invalid_on_chain_state' };
        }
        if (readiness.status !== 'ready') {
          return readinessFailureResult(readiness);
        }

        let transactionResult: SendAndConfirmResult;
        try {
          transactionResult =
            await dependencies.recordHeartbeatOnChain(
              readiness.keypair,
              createJournalLifecycle(dependencies, readiness),
            );
        } catch (error: unknown) {
          return { status: 'preparation_failed', error };
        }

        if (
          transactionResult.status === 'preparation_failed' ||
          transactionResult.status === 'journal_failed'
        ) {
          return transactionResult;
        }
        if (transactionResult.status === 'submission_unknown') {
          publishExplorerTransactionIgnoringFailure(
            dependencies,
            transactionResult.signature,
            'submission_unknown',
          );
          return {
            status: 'submission_unknown',
            signature: transactionResult.signature,
            error: transactionResult.error,
          };
        }
        if (transactionResult.status === 'confirmed_failed') {
          publishExplorerTransactionIgnoringFailure(
            dependencies,
            transactionResult.signature,
            'confirmed_failed',
          );
          return {
            status: 'transaction_failed',
            signature: transactionResult.signature,
            transactionError: transactionResult.transactionError,
          };
        }
        if (transactionResult.status === 'confirmation_unknown') {
          publishExplorerTransactionIgnoringFailure(
            dependencies,
            transactionResult.signature,
            'confirmation_unknown',
          );
          return transactionResult;
        }

        let verification: HeartbeatVerificationResult;
        try {
          verification =
            await dependencies.verifyHeartbeatConfirmation({
              vault: readiness.vault,
              heartbeat: readiness.heartbeat,
              heartbeatBefore: readiness.heartbeatBefore,
              expectedMethod: HEARTBEAT_METHOD_INDEX[dependencies.method],
            });
        } catch {
          verification = {
            status: 'invalid_on_chain_state',
            reason: 'post-heartbeat verification failed unexpectedly',
          };
        }
        if (verification.status !== 'verified') {
          await transitionIgnoringFailure(
            dependencies,
            transactionResult.signature,
            'post_state_unverified',
            {
              safeErrorCode: safeErrorForPostState(verification),
            },
          );
          publishExplorerTransactionIgnoringFailure(
            dependencies,
            transactionResult.signature,
            'post_state_unverified',
          );
          return postStateFailureResult(
            verification,
            transactionResult.signature,
          );
        }

        const resolvedPatch = {
          resolvedLastHeartbeat: verification.lastHeartbeat,
          resolvedTotalHeartbeats:
            verification.totalHeartbeats.toString(10),
        };
        let localSync: 'complete' | 'failed' = 'complete';
        try {
          await dependencies.recordConfirmedHeartbeat({
            method: dependencies.method,
            onChainTimestamp: verification.lastHeartbeat,
            transactionSignature: transactionResult.signature,
          });
          await transitionIgnoringFailure(
            dependencies,
            transactionResult.signature,
            'resolved_confirmed',
            {
              ...resolvedPatch,
              localSyncState: 'complete',
              safeErrorCode: null,
            },
          );
        } catch {
          localSync = 'failed';
          await transitionIgnoringFailure(
            dependencies,
            transactionResult.signature,
            'confirmed_local_sync_pending',
            {
              ...resolvedPatch,
              localSyncState: 'pending',
              safeErrorCode: 'local_sync_failed',
            },
          );
        }

        try {
          dependencies.resetLocalEscalation();
        } catch {
          // In-memory cache failure cannot negate verified chain success.
        }

        const nextDueSeconds =
          verification.lastHeartbeat +
          readiness.vaultConfig.heartbeatInterval;
        const nextDueDate = new Date(nextDueSeconds * 1000);
        if (
          Number.isSafeInteger(nextDueSeconds) &&
          Number.isFinite(nextDueDate.getTime())
        ) {
          try {
            await dependencies.sendLocalConfirmationNotification(
              nextDueDate,
            );
          } catch {
            // Local notification is best-effort after verified chain success.
          }
        }

        publishExplorerTransactionIgnoringFailure(
          dependencies,
          transactionResult.signature,
          'confirmed_success',
        );
        await reloadVaultStateIgnoringFailure(
          dependencies.reloadVaultState,
        );

        return {
          status: 'confirmed_on_chain',
          signature: transactionResult.signature,
          lastHeartbeat: verification.lastHeartbeat,
          totalHeartbeats: verification.totalHeartbeats,
          localSync,
        };
      } finally {
        inFlight = false;
        try {
          dependencies.publishInFlightState?.(false);
        } catch {
          // UI publication must never strand the coordinator lock.
        }
      }
    },
  };
}
