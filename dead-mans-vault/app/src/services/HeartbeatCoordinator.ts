import type { Keypair } from '@solana/web3.js';
import type { HeartbeatMethod } from '../types/heartbeat';
import type { AgentReadinessResult } from './AgentReadinessService';
import type {
  HeartbeatVerificationInput,
  HeartbeatVerificationResult,
} from './HeartbeatConfirmationVerifier';
import type { SendAndConfirmResult } from './sendAndConfirmTransaction';

export type HeartbeatExplorerTransactionStatus =
  | 'confirmed_success'
  | 'confirmed_failed'
  | 'confirmation_unknown'
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
      status: 'submission_failed';
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

export interface HeartbeatCoordinatorDependencies {
  method: HeartbeatMethod;
  checkAgentReadiness: () => Promise<AgentReadinessResult>;
  recordHeartbeatOnChain: (
    agentKeypair: Keypair,
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
            await dependencies.recordHeartbeatOnChain(readiness.keypair);
        } catch (error: unknown) {
          return { status: 'submission_failed', error };
        }

        if (transactionResult.status === 'submission_failed') {
          return transactionResult;
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

        let localSync: 'complete' | 'failed' = 'complete';
        try {
          await dependencies.recordConfirmedHeartbeat({
            method: dependencies.method,
            onChainTimestamp: verification.lastHeartbeat,
            transactionSignature: transactionResult.signature,
          });
        } catch {
          localSync = 'failed';
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
