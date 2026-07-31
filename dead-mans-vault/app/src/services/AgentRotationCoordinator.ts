import {
  PublicKey,
  type Keypair,
  type Transaction,
} from '@solana/web3.js';
import type {
  AgentRotationIdentity,
  AgentRotationOperationRecord,
  AgentRotationOperationState,
  AgentRotationTransitionPatch,
} from '../db/agentRotationRepoCore';
import type {
  AgentRotationReconciliationResult,
} from './AgentRotationReconciler';
import type {
  AgentRotationTransactionPreparationResult,
} from './AgentRotationTransaction';
import type {
  AgentRotationVerificationResult,
  VerifiedRotationChainState,
} from './AgentRotationVerifier';

export interface AgentRotationPreflight {
  identity: AgentRotationIdentity;
  state: VerifiedRotationChainState;
  finalDeadline: number;
}

export type AgentRotationPreflightResult =
  | { status: 'ready'; value: AgentRotationPreflight }
  | {
      status:
        | 'vault_missing'
        | 'vault_inactive'
        | 'vault_executed'
        | 'deadline_reached'
        | 'rpc_unavailable'
        | 'invalid_on_chain_state';
    };

export type AgentRotationResult =
  | {
      status: 'candidate_secured';
      candidateAgent: string;
      currentAgent: string;
    }
  | {
      status: 'confirmed';
      signature: string;
      candidateAgent: string;
      previousAgent: string;
    }
  | { status: 'rotation_in_flight' }
  | { status: 'heartbeat_operation_pending' }
  | { status: 'candidate_funding_pending' }
  | {
      status: 'rotation_pending';
      signature: string;
      reconciliation: AgentRotationReconciliationResult;
    }
  | { status: 'active_agent_mismatch' }
  | { status: 'previous_key_cleanup_required' }
  | { status: 'candidate_missing' }
  | { status: 'candidate_not_funded'; shortfallLamports: number }
  | { status: 'owner_cancelled' }
  | { status: 'wallet_transaction_modified' }
  | { status: 'journal_failed'; error: unknown }
  | { status: 'preparation_failed'; error: unknown }
  | { status: 'submission_unknown'; signature: string }
  | { status: 'transaction_failed'; signature: string }
  | { status: 'confirmation_unknown'; signature: string }
  | { status: 'post_state_unverified'; signature: string }
  | { status: 'promotion_failed'; signature: string }
  | Exclude<AgentRotationPreflightResult, { status: 'ready' }>;

export interface AgentRotationCoordinatorDependencies {
  checkPreflight: (
    owner: PublicKey,
  ) => Promise<AgentRotationPreflightResult>;
  hasBlockingHeartbeatOperation: (
    owner: PublicKey,
  ) => Promise<boolean>;
  reconcileCandidateFunding: (
    owner: PublicKey,
  ) => Promise<boolean>;
  getBlockingRotation: (
    identity: AgentRotationIdentity,
  ) => Promise<AgentRotationOperationRecord | null>;
  reconcileRotation: (
    operation: AgentRotationOperationRecord,
  ) => Promise<AgentRotationReconciliationResult>;
  resolveStoredAgent: (onChainAgent: string) => Promise<
    | { status: 'active_match'; keypair: Keypair }
    | { status: string }
  >;
  hasRetainedPreviousKey: () => Promise<boolean>;
  generateCandidate: () => Promise<string>;
  loadCandidate: () => Promise<Keypair>;
  prepareTransaction: (
    owner: PublicKey,
    candidate: Keypair,
  ) => Promise<AgentRotationTransactionPreparationResult>;
  persistPrepared: (input: {
    preflight: AgentRotationPreflight;
    signature: string;
    blockhash: string;
    lastValidBlockHeight: number;
    candidateAgent: string;
  }) => Promise<void>;
  sendRawTransaction: (serialized: Uint8Array) => Promise<string>;
  confirmTransaction: (input: {
    signature: string;
    blockhash: string;
    lastValidBlockHeight: number;
  }) => Promise<unknown>;
  transitionRotation: (
    signature: string,
    state: AgentRotationOperationState,
    patch?: AgentRotationTransitionPatch,
  ) => Promise<AgentRotationOperationRecord>;
  verifyPostState: (
    input: AgentRotationPreflight & {
      candidateAgent: PublicKey;
    },
  ) => Promise<AgentRotationVerificationResult>;
  promoteCandidate: (
    oldAgent: string,
    candidateAgent: string,
  ) => Promise<void>;
  provePromotedCandidate: (candidateAgent: string) => Promise<boolean>;
  refreshAuthoritativeDeadline: () => Promise<void>;
}

function parseConfirmation(
  response: unknown,
): 'confirmed' | 'failed' | null {
  if (!response || typeof response !== 'object') return null;
  const value = Reflect.get(response, 'value');
  if (
    !value ||
    typeof value !== 'object' ||
    !Object.prototype.hasOwnProperty.call(value, 'err')
  ) {
    return null;
  }
  const error = Reflect.get(value, 'err');
  if (error === null) return 'confirmed';
  return error === undefined ? null : 'failed';
}

export function createAgentRotationCoordinator(
  dependencies: AgentRotationCoordinatorDependencies,
) {
  let inFlight = false;

  async function withLock(
    action: () => Promise<AgentRotationResult>,
  ): Promise<AgentRotationResult> {
    if (inFlight) return { status: 'rotation_in_flight' };
    inFlight = true;
    try {
      return await action();
    } finally {
      inFlight = false;
    }
  }

  async function commonPreflight(
    owner: PublicKey,
  ): Promise<
    | { status: 'ready'; value: AgentRotationPreflight }
    | AgentRotationResult
  > {
    if (await dependencies.hasBlockingHeartbeatOperation(owner)) {
      return { status: 'heartbeat_operation_pending' };
    }
    if (await dependencies.reconcileCandidateFunding(owner)) {
      return { status: 'candidate_funding_pending' };
    }
    const preflight = await dependencies.checkPreflight(owner);
    if (preflight.status !== 'ready') return preflight;
    const existing = await dependencies.getBlockingRotation(
      preflight.value.identity,
    );
    if (existing) {
      return {
        status: 'rotation_pending',
        signature: existing.signature,
        reconciliation:
          await dependencies.reconcileRotation(existing),
      };
    }
    const stored = await dependencies.resolveStoredAgent(
      preflight.value.state.agent.toBase58(),
    );
    if (stored.status !== 'active_match') {
      return { status: 'active_agent_mismatch' };
    }
    if (await dependencies.hasRetainedPreviousKey()) {
      return { status: 'previous_key_cleanup_required' };
    }
    return preflight;
  }

  return {
    createCandidate: (owner: PublicKey) =>
      withLock(async () => {
        const preflight = await commonPreflight(owner);
        if (preflight.status !== 'ready') return preflight;
        let candidateAgent: string;
        try {
          candidateAgent = await dependencies.generateCandidate();
          const readBack = await dependencies.loadCandidate();
          if (readBack.publicKey.toBase58() !== candidateAgent) {
            throw new Error('Candidate read-back public key mismatch');
          }
        } catch (error: unknown) {
          return { status: 'preparation_failed', error };
        }
        return {
          status: 'candidate_secured',
          candidateAgent,
          currentAgent: preflight.value.state.agent.toBase58(),
        };
      }),

    rotate: (owner: PublicKey) =>
      withLock(async () => {
        const preflight = await commonPreflight(owner);
        if (preflight.status !== 'ready') return preflight;

        let candidate: Keypair;
        try {
          candidate = await dependencies.loadCandidate();
        } catch {
          return { status: 'candidate_missing' };
        }
        const prepared = await dependencies.prepareTransaction(
          owner,
          candidate,
        );
        if (prepared.status === 'candidate_not_funded') {
          return {
            status: 'candidate_not_funded',
            shortfallLamports: prepared.shortfallLamports,
          };
        }
        if (
          prepared.status === 'owner_cancelled' ||
          prepared.status === 'wallet_transaction_modified' ||
          prepared.status === 'preparation_failed'
        ) {
          return prepared;
        }

        try {
          await dependencies.persistPrepared({
            preflight: preflight.value,
            signature: prepared.signature,
            blockhash: prepared.blockhashValidity.blockhash,
            lastValidBlockHeight:
              prepared.blockhashValidity.lastValidBlockHeight,
            candidateAgent: candidate.publicKey.toBase58(),
          });
        } catch (error: unknown) {
          return { status: 'journal_failed', error };
        }

        let rpcSignature: string;
        try {
          rpcSignature = await dependencies.sendRawTransaction(
            prepared.transaction.serialize({
              requireAllSignatures: true,
              verifySignatures: true,
            }),
          );
        } catch {
          await dependencies.transitionRotation(
            prepared.signature,
            'submission_unknown',
            { safeErrorCode: 'send_exception' },
          );
          return {
            status: 'submission_unknown',
            signature: prepared.signature,
          };
        }
        if (
          !rpcSignature ||
          rpcSignature !== prepared.signature
        ) {
          await dependencies.transitionRotation(
            prepared.signature,
            'submission_unknown',
            {
              safeErrorCode: rpcSignature
                ? 'rpc_signature_mismatch'
                : 'empty_rpc_signature',
            },
          );
          return {
            status: 'submission_unknown',
            signature: prepared.signature,
          };
        }
        await dependencies.transitionRotation(
          prepared.signature,
          'submitted',
        );

        let confirmation: unknown;
        try {
          confirmation = await dependencies.confirmTransaction({
            signature: prepared.signature,
            ...prepared.blockhashValidity,
          });
        } catch {
          await dependencies.transitionRotation(
            prepared.signature,
            'confirmation_unknown',
            { safeErrorCode: 'confirmation_exception' },
          );
          return {
            status: 'confirmation_unknown',
            signature: prepared.signature,
          };
        }
        const confirmationStatus = parseConfirmation(confirmation);
        if (confirmationStatus === 'failed') {
          await dependencies.transitionRotation(
            prepared.signature,
            'resolved_failed',
            { safeErrorCode: 'transaction_failed' },
          );
          return {
            status: 'transaction_failed',
            signature: prepared.signature,
          };
        }
        if (confirmationStatus !== 'confirmed') {
          await dependencies.transitionRotation(
            prepared.signature,
            'confirmation_unknown',
            { safeErrorCode: 'confirmation_malformed' },
          );
          return {
            status: 'confirmation_unknown',
            signature: prepared.signature,
          };
        }

        const verification = await dependencies.verifyPostState({
          ...preflight.value,
          candidateAgent: candidate.publicKey,
        });
        if (verification.status !== 'verified') {
          await dependencies.transitionRotation(
            prepared.signature,
            verification.status === 'different_agent_authorised'
              ? 'recovery_required'
              : 'post_state_unverified',
            {
              safeErrorCode: 'post_state_invalid',
              resolvedAgent:
                verification.status ===
                'different_agent_authorised'
                  ? verification.agent.toBase58()
                  : null,
            },
          );
          return {
            status: 'post_state_unverified',
            signature: prepared.signature,
          };
        }
        await dependencies.transitionRotation(
          prepared.signature,
          'rotation_confirmed',
          {
            resolvedAgent: candidate.publicKey.toBase58(),
            resolvedLastHeartbeat: verification.lastHeartbeat,
            resolvedVaultUpdatedAt: verification.vaultUpdatedAt,
          },
        );
        try {
          await dependencies.promoteCandidate(
            preflight.value.state.agent.toBase58(),
            candidate.publicKey.toBase58(),
          );
          if (
            !(await dependencies.provePromotedCandidate(
              candidate.publicKey.toBase58(),
            ))
          ) {
            throw new Error('Promoted candidate signing proof failed');
          }
        } catch {
          await dependencies.transitionRotation(
            prepared.signature,
            'rotation_confirmed',
            { safeErrorCode: 'promotion_failed' },
          );
          return {
            status: 'promotion_failed',
            signature: prepared.signature,
          };
        }
        await dependencies.transitionRotation(
          prepared.signature,
          'candidate_promoted',
          { safeErrorCode: null },
        );
        try {
          await dependencies.refreshAuthoritativeDeadline();
        } catch {
          // Rotation truth remains on-chain; focus refresh repairs UI.
        }
        return {
          status: 'confirmed',
          signature: prepared.signature,
          candidateAgent: candidate.publicKey.toBase58(),
          previousAgent: preflight.value.state.agent.toBase58(),
        };
      }),
  };
}

export type AgentRotationCoordinator = ReturnType<
  typeof createAgentRotationCoordinator
>;
