import type { Keypair } from '@solana/web3.js';
import type { AgentReadinessResult } from './AgentReadinessService';

export type HeartbeatAttemptResult =
  | {
      status: 'confirmed_on_chain';
      signature: string;
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
      status: 'on_chain_failed';
      error: unknown;
    }
  | {
      status: 'local_failed';
      error: unknown;
    };

export interface LocalHeartbeatDependencies {
  recordLocalHeartbeat: () => Promise<void>;
  resetLocalEscalation: () => void;
  sendLocalConfirmationNotification: () => void | Promise<void>;
}

export interface HeartbeatCoordinatorDependencies {
  checkAgentReadiness: () => Promise<AgentReadinessResult>;
  confirmLocalHeartbeat: () => Promise<void>;
  recordHeartbeatOnChain: (agentKeypair: Keypair) => Promise<string>;
  reloadVaultState: () => Promise<void>;
  publishExplorerSignature: (signature: string) => void;
  publishOnChainError: (hasError: boolean) => void;
  publishInFlightState?: (isInFlight: boolean) => void;
}

export interface HeartbeatCoordinator {
  attempt: (
    dependencies: HeartbeatCoordinatorDependencies,
  ) => Promise<HeartbeatAttemptResult>;
  isInFlight: () => boolean;
}

export async function confirmLocalHeartbeat(
  dependencies: LocalHeartbeatDependencies,
): Promise<void> {
  await dependencies.recordLocalHeartbeat();
  dependencies.resetLocalEscalation();

  // The current hook starts this notification without awaiting it. Keep that
  // fire-and-forget behavior until the authoritative-ordering work package.
  try {
    void dependencies.sendLocalConfirmationNotification();
  } catch {
    // Local notification failure does not fail the current heartbeat flow.
  }
}

async function reloadVaultStateIgnoringFailure(
  reloadVaultState: () => Promise<void>,
): Promise<void> {
  try {
    await reloadVaultState();
  } catch {
    // Dashboard loadVaultState is currently fail-soft.
  }
}

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

        try {
          await dependencies.confirmLocalHeartbeat();
        } catch (error: unknown) {
          return { status: 'local_failed', error };
        }

        try {
          const signature = await dependencies.recordHeartbeatOnChain(
            readiness.keypair,
          );
          dependencies.publishExplorerSignature(signature);
          dependencies.publishOnChainError(false);
          await reloadVaultStateIgnoringFailure(
            dependencies.reloadVaultState,
          );
          return { status: 'confirmed_on_chain', signature };
        } catch (error: unknown) {
          dependencies.publishOnChainError(true);
          await reloadVaultStateIgnoringFailure(
            dependencies.reloadVaultState,
          );
          return { status: 'on_chain_failed', error };
        }
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
