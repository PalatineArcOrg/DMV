import { PublicKey } from '@solana/web3.js';
import type {
  HeartbeatOperationIdentity,
  HeartbeatOperationRecord,
  HeartbeatOperationState,
  HeartbeatOperationTransitionPatch,
} from '../db/heartbeatOperationRepoCore';
import type { ConfirmedHeartbeatLocalInput } from './HeartbeatCoordinator';
import type {
  CurrentHeartbeatStateResult,
  HeartbeatVerificationResult,
} from './HeartbeatConfirmationVerifier';
import type { HeartbeatMethod } from '../types/heartbeat';

const HEARTBEAT_METHODS: ReadonlyArray<HeartbeatMethod> = [
  'active_tap',
  'biometric_confirm',
  'on_chain_activity',
  'pin_challenge',
  'hardware_switch',
];

export type HeartbeatReconciliationResult =
  | {
      status: 'still_pending';
      signature: string;
      operationState: HeartbeatOperationState;
    }
  | {
      status: 'reconciliation_unavailable';
      signature: string;
    }
  | {
      status: 'post_state_unverified';
      signature: string;
    }
  | {
      status: 'reconciled_confirmed';
      signature: string;
      lastHeartbeat: number;
      totalHeartbeats: bigint;
      localSync: 'complete';
    }
  | {
      status: 'local_sync_pending';
      signature: string;
      lastHeartbeat: number;
      totalHeartbeats: bigint;
    }
  | {
      status: 'reconciled_failed';
      signature: string;
    }
  | {
      status: 'reconciled_expired';
      signature: string;
    }
  | {
      status: 'reconciled_chain_advanced';
      lastHeartbeat: number;
      totalHeartbeats: bigint;
    }
  | {
      status: 'invalid_local_record';
    };

export interface HeartbeatOperationReconcilerDependencies {
  currentIdentity: HeartbeatOperationIdentity;
  validateOperationIdentity: (
    operation: HeartbeatOperationRecord,
  ) => Promise<boolean>;
  getSignatureStatuses: (
    signatures: Array<string>,
    config: { searchTransactionHistory: true },
  ) => Promise<unknown>;
  getBlockHeight: () => Promise<number>;
  verifyHeartbeatConfirmation: (input: {
    vault: PublicKey;
    heartbeat: PublicKey;
    heartbeatBefore: {
      lastHeartbeat: number;
      lastMethod: number;
      totalHeartbeats: bigint;
    };
    expectedMethod: number;
  }) => Promise<HeartbeatVerificationResult>;
  readCurrentHeartbeat: (input: {
    vault: PublicKey;
    heartbeat: PublicKey;
  }) => Promise<CurrentHeartbeatStateResult>;
  recordConfirmedHeartbeat: (
    input: ConfirmedHeartbeatLocalInput,
  ) => Promise<void>;
  recordAuthoritativeUnattributedHeartbeat: (input: {
    identity: HeartbeatOperationIdentity;
    method: HeartbeatOperationRecord['method'];
    lastHeartbeat: number;
    totalHeartbeats: bigint;
  }) => Promise<void>;
  resetLocalEscalation: () => void;
  reloadVaultState: () => Promise<void>;
  transitionOperation: (
    signature: string,
    state: HeartbeatOperationState,
    patch?: HeartbeatOperationTransitionPatch,
  ) => Promise<HeartbeatOperationRecord>;
  nowSeconds?: () => number;
}

export interface HeartbeatOperationReconciler {
  reconcile: (
    operation: HeartbeatOperationRecord,
  ) => Promise<HeartbeatReconciliationResult>;
}

interface ParsedSignatureStatus {
  kind: 'absent' | 'failed' | 'pending' | 'confirmed';
}

function sameIdentity(
  left: HeartbeatOperationIdentity,
  right: HeartbeatOperationIdentity,
): boolean {
  return (
    left.cluster === right.cluster &&
    left.programId === right.programId &&
    left.owner === right.owner &&
    left.vault === right.vault &&
    left.heartbeat === right.heartbeat &&
    left.agentPubkey === right.agentPubkey
  );
}

function operationIdentity(
  operation: HeartbeatOperationRecord,
): HeartbeatOperationIdentity {
  return {
    cluster: operation.cluster,
    programId: operation.programId,
    owner: operation.owner,
    vault: operation.vault,
    heartbeat: operation.heartbeat,
    agentPubkey: operation.agentPubkey,
  };
}

function parseSignatureStatus(response: unknown): ParsedSignatureStatus | null {
  if (!response || typeof response !== 'object') return null;
  const value = Reflect.get(response, 'value');
  if (!Array.isArray(value) || value.length !== 1) return null;
  const status = value[0];
  if (status === null) return { kind: 'absent' };
  if (!status || typeof status !== 'object') return null;
  if (!Object.prototype.hasOwnProperty.call(status, 'err')) return null;
  if (Reflect.get(status, 'err') !== null) return { kind: 'failed' };
  const confirmationStatus = Reflect.get(status, 'confirmationStatus');
  if (
    confirmationStatus === 'confirmed' ||
    confirmationStatus === 'finalized'
  ) {
    return { kind: 'confirmed' };
  }
  if (confirmationStatus === 'processed') return { kind: 'pending' };
  return null;
}

async function resetAndReload(
  dependencies: HeartbeatOperationReconcilerDependencies,
): Promise<void> {
  try {
    dependencies.resetLocalEscalation();
  } catch {
    // Canonical chain truth remains authoritative.
  }
  try {
    await dependencies.reloadVaultState();
  } catch {
    // A later focus refresh can repair UI state.
  }
}

export function createHeartbeatOperationReconciler(
  dependencies: HeartbeatOperationReconcilerDependencies,
): HeartbeatOperationReconciler {
  const nowSeconds =
    dependencies.nowSeconds ?? (() => Math.floor(Date.now() / 1000));

  async function transition(
    operation: HeartbeatOperationRecord,
    state: HeartbeatOperationState,
    patch: HeartbeatOperationTransitionPatch = {},
  ): Promise<boolean> {
    try {
      await dependencies.transitionOperation(
        operation.signature,
        state,
        {
          lastCheckedAt: nowSeconds(),
          ...patch,
        },
      );
      return true;
    } catch {
      // The durable earlier state remains recoverable.
      return false;
    }
  }

  async function repairConfirmedLocalSync(
    operation: HeartbeatOperationRecord,
  ): Promise<HeartbeatReconciliationResult> {
    if (
      operation.resolvedLastHeartbeat === null ||
      operation.resolvedTotalHeartbeats === null
    ) {
      await transition(operation, 'invalid_local_record', {
        safeErrorCode: 'invalid_local_record',
      });
      return { status: 'invalid_local_record' };
    }
    const totalHeartbeats = BigInt(operation.resolvedTotalHeartbeats);
    try {
      await dependencies.recordConfirmedHeartbeat({
        method: operation.method,
        onChainTimestamp: operation.resolvedLastHeartbeat,
        transactionSignature: operation.signature,
      });
    } catch {
      await transition(operation, 'confirmed_local_sync_pending', {
        localSyncState: 'pending',
        safeErrorCode: 'local_sync_failed',
      });
      return {
        status: 'local_sync_pending',
        signature: operation.signature,
        lastHeartbeat: operation.resolvedLastHeartbeat,
        totalHeartbeats,
      };
    }
    await transition(operation, 'resolved_confirmed', {
      localSyncState: 'complete',
      safeErrorCode: null,
    });
    await resetAndReload(dependencies);
    return {
      status: 'reconciled_confirmed',
      signature: operation.signature,
      lastHeartbeat: operation.resolvedLastHeartbeat,
      totalHeartbeats,
      localSync: 'complete',
    };
  }

  return {
    reconcile: async (
      operation: HeartbeatOperationRecord,
    ): Promise<HeartbeatReconciliationResult> => {
      if (!sameIdentity(operationIdentity(operation), dependencies.currentIdentity)) {
        await transition(operation, 'invalid_local_record', {
          safeErrorCode: 'identity_mismatch',
        });
        return { status: 'invalid_local_record' };
      }
      let identityIsValid: boolean;
      try {
        identityIsValid =
          await dependencies.validateOperationIdentity(operation);
      } catch {
        return {
          status: 'reconciliation_unavailable',
          signature: operation.signature,
        };
      }
      if (!identityIsValid) {
        await transition(operation, 'invalid_local_record', {
          safeErrorCode: 'identity_mismatch',
        });
        return { status: 'invalid_local_record' };
      }

      if (operation.state === 'confirmed_local_sync_pending') {
        return repairConfirmedLocalSync(operation);
      }

      let parsedStatus: ParsedSignatureStatus | null;
      try {
        const response = await dependencies.getSignatureStatuses(
          [operation.signature],
          { searchTransactionHistory: true },
        );
        parsedStatus = parseSignatureStatus(response);
      } catch {
        await transition(operation, operation.state, {
          safeErrorCode: 'status_rpc_unavailable',
        });
        return {
          status: 'reconciliation_unavailable',
          signature: operation.signature,
        };
      }
      if (!parsedStatus) {
        await transition(operation, operation.state, {
          safeErrorCode: 'status_malformed',
        });
        return {
          status: 'reconciliation_unavailable',
          signature: operation.signature,
        };
      }

      if (parsedStatus.kind === 'failed') {
        const resolved = await transition(operation, 'resolved_failed', {
          localSyncState: 'not_applicable',
          safeErrorCode: 'transaction_failed',
        });
        if (!resolved) {
          return {
            status: 'reconciliation_unavailable',
            signature: operation.signature,
          };
        }
        return {
          status: 'reconciled_failed',
          signature: operation.signature,
        };
      }

      if (parsedStatus.kind === 'pending') {
        return {
          status: 'still_pending',
          signature: operation.signature,
          operationState: operation.state,
        };
      }

      const vault = new PublicKey(operation.vault);
      const heartbeat = new PublicKey(operation.heartbeat);
      const heartbeatBefore = {
        lastHeartbeat: operation.beforeLastHeartbeat,
        lastMethod: operation.methodIndex,
        totalHeartbeats: BigInt(operation.beforeTotalHeartbeats),
      };

      if (parsedStatus.kind === 'confirmed') {
        const verification = await dependencies.verifyHeartbeatConfirmation({
          vault,
          heartbeat,
          heartbeatBefore,
          expectedMethod: operation.methodIndex,
        });
        if (verification.status !== 'verified') {
          await transition(operation, 'post_state_unverified', {
            safeErrorCode:
              verification.status === 'rpc_unavailable'
                ? 'post_state_rpc_unavailable'
                : verification.status === 'not_advanced'
                  ? 'post_state_not_advanced'
                  : 'post_state_invalid',
          });
          return {
            status: 'post_state_unverified',
            signature: operation.signature,
          };
        }

        const resolvedPatch = {
          resolvedLastHeartbeat: verification.lastHeartbeat,
          resolvedTotalHeartbeats:
            verification.totalHeartbeats.toString(10),
        };
        try {
          await dependencies.recordConfirmedHeartbeat({
            method: operation.method,
            onChainTimestamp: verification.lastHeartbeat,
            transactionSignature: operation.signature,
          });
        } catch {
          await transition(operation, 'confirmed_local_sync_pending', {
            ...resolvedPatch,
            localSyncState: 'pending',
            safeErrorCode: 'local_sync_failed',
          });
          await resetAndReload(dependencies);
          return {
            status: 'local_sync_pending',
            signature: operation.signature,
            lastHeartbeat: verification.lastHeartbeat,
            totalHeartbeats: verification.totalHeartbeats,
          };
        }
        await transition(operation, 'resolved_confirmed', {
          ...resolvedPatch,
          localSyncState: 'complete',
          safeErrorCode: null,
        });
        await resetAndReload(dependencies);
        return {
          status: 'reconciled_confirmed',
          signature: operation.signature,
          lastHeartbeat: verification.lastHeartbeat,
          totalHeartbeats: verification.totalHeartbeats,
          localSync: 'complete',
        };
      }

      let currentBlockHeight: number;
      try {
        currentBlockHeight = await dependencies.getBlockHeight();
      } catch {
        await transition(operation, operation.state, {
          safeErrorCode: 'block_height_rpc_unavailable',
        });
        return {
          status: 'reconciliation_unavailable',
          signature: operation.signature,
        };
      }
      if (
        !Number.isSafeInteger(currentBlockHeight) ||
        currentBlockHeight < 0
      ) {
        await transition(operation, operation.state, {
          safeErrorCode: 'status_malformed',
        });
        return {
          status: 'reconciliation_unavailable',
          signature: operation.signature,
        };
      }
      if (currentBlockHeight <= operation.lastValidBlockHeight) {
        return {
          status: 'still_pending',
          signature: operation.signature,
          operationState: operation.state,
        };
      }

      const current = await dependencies.readCurrentHeartbeat({
        vault,
        heartbeat,
      });
      if (current.status !== 'verified_state') {
        await transition(operation, 'post_state_unverified', {
          safeErrorCode:
            current.status === 'rpc_unavailable'
              ? 'post_state_rpc_unavailable'
              : 'post_state_invalid',
        });
        return {
          status: 'post_state_unverified',
          signature: operation.signature,
        };
      }
      if (current.lastHeartbeat < operation.beforeLastHeartbeat) {
        await transition(operation, 'post_state_unverified', {
          safeErrorCode: 'post_state_invalid',
        });
        return {
          status: 'post_state_unverified',
          signature: operation.signature,
        };
      }
      if (
        current.totalHeartbeats >
        BigInt(operation.beforeTotalHeartbeats)
      ) {
        const currentMethod = HEARTBEAT_METHODS[current.lastMethod];
        if (!currentMethod) {
          await transition(operation, 'post_state_unverified', {
            safeErrorCode: 'post_state_invalid',
          });
          return {
            status: 'post_state_unverified',
            signature: operation.signature,
          };
        }
        try {
          await dependencies.recordAuthoritativeUnattributedHeartbeat({
            identity: operationIdentity(operation),
            method: currentMethod,
            lastHeartbeat: current.lastHeartbeat,
            totalHeartbeats: current.totalHeartbeats,
          });
        } catch {
          await transition(operation, 'post_state_unverified', {
            resolvedLastHeartbeat: current.lastHeartbeat,
            resolvedTotalHeartbeats:
              current.totalHeartbeats.toString(10),
            safeErrorCode: 'local_sync_failed',
          });
          return {
            status: 'post_state_unverified',
            signature: operation.signature,
          };
        }
        const resolved = await transition(
          operation,
          'resolved_chain_advanced_unattributed',
          {
            resolvedLastHeartbeat: current.lastHeartbeat,
            resolvedTotalHeartbeats:
              current.totalHeartbeats.toString(10),
            localSyncState: 'complete',
            safeErrorCode: null,
          },
        );
        await resetAndReload(dependencies);
        if (!resolved) {
          return {
            status: 'reconciliation_unavailable',
            signature: operation.signature,
          };
        }
        return {
          status: 'reconciled_chain_advanced',
          lastHeartbeat: current.lastHeartbeat,
          totalHeartbeats: current.totalHeartbeats,
        };
      }

      const resolved = await transition(
        operation,
        'resolved_expired_not_landed',
        {
        localSyncState: 'not_applicable',
        safeErrorCode: null,
        },
      );
      if (!resolved) {
        return {
          status: 'reconciliation_unavailable',
          signature: operation.signature,
        };
      }
      return {
        status: 'reconciled_expired',
        signature: operation.signature,
      };
    },
  };
}
