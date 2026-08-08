import { PublicKey } from '@solana/web3.js';
import type {
  AgentRotationOperationRecord,
  AgentRotationOperationState,
  AgentRotationTransitionPatch,
} from '../db/agentRotationRepoCore';
import type {
  AgentRotationVerificationResult,
} from './AgentRotationVerifier';

export type AgentRotationReconciliationResult =
  | { status: 'still_pending'; signature: string }
  | { status: 'reconciliation_unavailable'; signature: string }
  | { status: 'reconciled_promoted'; signature: string }
  | { status: 'reconciled_rotated_unattributed' }
  | { status: 'reconciled_failed'; signature: string }
  | { status: 'reconciled_not_landed'; signature: string }
  | { status: 'post_state_unverified'; signature: string }
  | { status: 'recovery_required'; onChainAgent: string }
  | { status: 'invalid_local_record' };

export interface AgentRotationReconcilerDependencies {
  validateIdentity: (
    operation: AgentRotationOperationRecord,
  ) => Promise<boolean>;
  getSignatureStatuses: (
    signatures: Array<string>,
    config: { searchTransactionHistory: true },
  ) => Promise<unknown>;
  getBlockHeight: () => Promise<number>;
  verifyPostState: (
    operation: AgentRotationOperationRecord,
  ) => Promise<AgentRotationVerificationResult>;
  promoteCandidate: (
    oldAgent: string,
    candidateAgent: string,
  ) => Promise<void>;
  provePromotedCandidate: (candidateAgent: string) => Promise<boolean>;
  transition: (
    signature: string,
    state: AgentRotationOperationState,
    patch?: AgentRotationTransitionPatch,
  ) => Promise<AgentRotationOperationRecord>;
  nowSeconds?: () => number;
}

type ParsedStatus = 'absent' | 'pending' | 'failed' | 'confirmed';

function parseStatus(value: unknown): ParsedStatus | null {
  if (!value || typeof value !== 'object') return null;
  const statuses = Reflect.get(value, 'value');
  if (!Array.isArray(statuses) || statuses.length !== 1) return null;
  const status = statuses[0];
  if (status === null) return 'absent';
  if (!status || typeof status !== 'object') return null;
  if (!Object.prototype.hasOwnProperty.call(status, 'err')) return null;
  if (Reflect.get(status, 'err') !== null) return 'failed';
  const confirmation = Reflect.get(status, 'confirmationStatus');
  if (confirmation === 'confirmed' || confirmation === 'finalized') {
    return 'confirmed';
  }
  if (confirmation === 'processed') return 'pending';
  return null;
}

export function createAgentRotationReconciler(
  dependencies: AgentRotationReconcilerDependencies,
) {
  const nowSeconds =
    dependencies.nowSeconds ?? (() => Math.floor(Date.now() / 1000));

  async function transition(
    operation: AgentRotationOperationRecord,
    state: AgentRotationOperationState,
    patch: AgentRotationTransitionPatch = {},
  ): Promise<boolean> {
    try {
      await dependencies.transition(operation.signature, state, {
        lastCheckedAt: nowSeconds(),
        ...patch,
      });
      return true;
    } catch {
      return false;
    }
  }

  async function promote(
    operation: AgentRotationOperationRecord,
    attributed: boolean,
    verification: Extract<
      AgentRotationVerificationResult,
      { status: 'verified' }
    >,
  ): Promise<AgentRotationReconciliationResult> {
    try {
      await dependencies.promoteCandidate(
        operation.oldAgent,
        operation.candidateAgent,
      );
      if (
        !(await dependencies.provePromotedCandidate(
          operation.candidateAgent,
        ))
      ) {
        throw new Error('Promoted candidate proof failed');
      }
    } catch {
      await transition(operation, 'rotation_confirmed', {
        safeErrorCode: 'promotion_failed',
        resolvedAgent: operation.candidateAgent,
        resolvedLastHeartbeat: verification.lastHeartbeat,
        resolvedVaultUpdatedAt: verification.vaultUpdatedAt,
      });
      return {
        status: 'post_state_unverified',
        signature: operation.signature,
      };
    }
    const terminalState = attributed
      ? 'candidate_promoted'
      : 'resolved_rotated_unattributed';
    const stored = await transition(operation, terminalState, {
      safeErrorCode: null,
      resolvedAgent: operation.candidateAgent,
      resolvedLastHeartbeat: verification.lastHeartbeat,
      resolvedVaultUpdatedAt: verification.vaultUpdatedAt,
    });
    if (!stored) {
      return {
        status: 'reconciliation_unavailable',
        signature: operation.signature,
      };
    }
    return attributed
      ? { status: 'reconciled_promoted', signature: operation.signature }
      : { status: 'reconciled_rotated_unattributed' };
  }

  return {
    reconcile: async (
      operation: AgentRotationOperationRecord,
    ): Promise<AgentRotationReconciliationResult> => {
      let validIdentity: boolean;
      try {
        validIdentity = await dependencies.validateIdentity(operation);
      } catch {
        return {
          status: 'reconciliation_unavailable',
          signature: operation.signature,
        };
      }
      if (!validIdentity) {
        await transition(operation, 'invalid_local_record', {
          safeErrorCode: 'identity_mismatch',
        });
        return { status: 'invalid_local_record' };
      }

      let status: ParsedStatus | null;
      try {
        status = parseStatus(
          await dependencies.getSignatureStatuses(
            [operation.signature],
            { searchTransactionHistory: true },
          ),
        );
      } catch {
        await transition(operation, operation.state, {
          safeErrorCode: 'status_rpc_unavailable',
        });
        return {
          status: 'reconciliation_unavailable',
          signature: operation.signature,
        };
      }
      if (!status) {
        await transition(operation, operation.state, {
          safeErrorCode: 'status_malformed',
        });
        return {
          status: 'reconciliation_unavailable',
          signature: operation.signature,
        };
      }

      const verification =
        await dependencies.verifyPostState(operation);
      if (verification.status === 'verified') {
        return promote(
          operation,
          status === 'confirmed',
          verification,
        );
      }
      if (verification.status === 'different_agent_authorised') {
        await transition(operation, 'recovery_required', {
          safeErrorCode: 'post_state_invalid',
          resolvedAgent: verification.agent.toBase58(),
        });
        return {
          status: 'recovery_required',
          onChainAgent: verification.agent.toBase58(),
        };
      }
      if (
        verification.status === 'rpc_unavailable' ||
        verification.status === 'invalid_on_chain_state'
      ) {
        await transition(operation, 'post_state_unverified', {
          safeErrorCode:
            verification.status === 'rpc_unavailable'
              ? 'post_state_rpc_unavailable'
              : 'post_state_invalid',
        });
        return {
          status: 'post_state_unverified',
          signature: operation.signature,
        };
      }

      // The chain still authorises the old agent.
      if (status === 'failed') {
        await transition(operation, 'resolved_failed', {
          safeErrorCode: 'transaction_failed',
          resolvedAgent: operation.oldAgent,
        });
        return {
          status: 'reconciled_failed',
          signature: operation.signature,
        };
      }
      if (status === 'confirmed') {
        await transition(operation, 'post_state_unverified', {
          safeErrorCode: 'post_state_invalid',
        });
        return {
          status: 'post_state_unverified',
          signature: operation.signature,
        };
      }
      if (status === 'pending') {
        return {
          status: 'still_pending',
          signature: operation.signature,
        };
      }

      let blockHeight: number;
      try {
        blockHeight = await dependencies.getBlockHeight();
      } catch {
        await transition(operation, operation.state, {
          safeErrorCode: 'block_height_rpc_unavailable',
        });
        return {
          status: 'reconciliation_unavailable',
          signature: operation.signature,
        };
      }
      if (!Number.isSafeInteger(blockHeight) || blockHeight < 0) {
        await transition(operation, operation.state, {
          safeErrorCode: 'status_malformed',
        });
        return {
          status: 'reconciliation_unavailable',
          signature: operation.signature,
        };
      }
      if (blockHeight <= operation.lastValidBlockHeight) {
        return {
          status: 'still_pending',
          signature: operation.signature,
        };
      }
      await transition(operation, 'resolved_not_landed', {
        safeErrorCode: null,
        resolvedAgent: operation.oldAgent,
      });
      return {
        status: 'reconciled_not_landed',
        signature: operation.signature,
      };
    },
  };
}

export function rotationVerificationInputFromOperation(
  operation: AgentRotationOperationRecord,
) {
  return {
    owner: new PublicKey(operation.owner),
    vault: new PublicKey(operation.vault),
    heartbeat: new PublicKey(operation.heartbeat),
    oldAgent: new PublicKey(operation.oldAgent),
    candidateAgent: new PublicKey(operation.candidateAgent),
    beforeVaultUpdatedAt: operation.beforeVaultUpdatedAt,
    beforeLastHeartbeat: operation.beforeLastHeartbeat,
    beforeTotalHeartbeats: BigInt(operation.beforeTotalHeartbeats),
    beforeConfigFingerprint: operation.beforeConfigFingerprint,
  };
}
