import { PublicKey } from '@solana/web3.js';
import type {
  MigrationNotificationDecision,
  SigningMigrationIdentity,
  SigningMigrationRecord,
  SigningMigrationState,
} from '../db/signingMigrationRepoCore';

export interface IncomingMigrationChainState {
  identity: SigningMigrationIdentity;
  legacyAgent: PublicKey;
  active: boolean;
  executed: boolean;
  finalDeadline: number;
  chainUnixTime: number;
  totalHeartbeats: bigint;
}

export type IncomingMigrationResult =
  | {
      status: 'incoming_migration_available';
      legacyAgent: string;
    }
  | { status: 'candidate_secured'; successorAgent: string }
  | { status: 'candidate_funding_required'; successorAgent: string }
  | { status: 'candidate_funding_pending'; signature: string }
  | { status: 'candidate_funded'; successorAgent: string }
  | { status: 'rotation_pending'; signature: string }
  | { status: 'rotation_confirmation_unknown'; signature: string }
  | { status: 'successor_authorised'; successorAgent: string }
  | { status: 'successor_heartbeat_required' }
  | { status: 'successor_heartbeat_pending'; signature: string }
  | {
      status: 'successor_heartbeat_confirmed';
      signature: string;
      totalHeartbeats: bigint;
    }
  | {
      status:
        | 'notification_decision_required'
        | 'notification_registered'
        | 'notification_declined'
        | 'bridge_retention'
        | 'migration_ready_for_cleanup';
    }
  | {
      status:
        | 'vault_inactive'
        | 'vault_executed'
        | 'deadline_reached'
        | 'active_key_already_present'
        | 'operation_pending'
        | 'identity_changed'
        | 'wrong_migration_state'
        | 'recovery_required';
    };

export interface SideBySideMigrationDependencies {
  fetchChainState: (owner: PublicKey) => Promise<IncomingMigrationChainState>;
  loadRecord: (
    identity: SigningMigrationIdentity
  ) => Promise<SigningMigrationRecord | null>;
  beginRecord: (
    state: IncomingMigrationChainState
  ) => Promise<SigningMigrationRecord>;
  transitionRecord: (
    identity: SigningMigrationIdentity,
    state: SigningMigrationState,
    patch?: Partial<SigningMigrationRecord>
  ) => Promise<SigningMigrationRecord>;
  getSuccessorActivePublicKey: () => Promise<string | null>;
  getSuccessorCandidatePublicKey: () => Promise<string | null>;
  createCandidateDeliberately: () => Promise<string>;
  readBackCandidate: () => Promise<string>;
  hasUnresolvedHeartbeat: (
    identity: SigningMigrationIdentity
  ) => Promise<boolean>;
  hasUnresolvedRotation: (
    identity: SigningMigrationIdentity
  ) => Promise<boolean>;
  hasUnresolvedFunding: (
    identity: SigningMigrationIdentity
  ) => Promise<boolean>;
  fundCandidateDeliberately: (input: {
    owner: PublicKey;
    legacyAgent: PublicKey;
    candidateAgent: PublicKey;
  }) => Promise<
    { status: 'confirmed' } | { status: 'pending'; signature: string }
  >;
  reconcileFundingReadOnly: (
    record: SigningMigrationRecord
  ) => Promise<'confirmed' | 'pending' | 'failed'>;
  rotateIncomingDeliberately: (input: {
    owner: PublicKey;
    legacyAgent: PublicKey;
    candidateAgent: PublicKey;
  }) => Promise<
    | { status: 'confirmed'; signature: string }
    | { status: 'pending'; signature: string }
    | { status: 'confirmation_unknown'; signature: string }
  >;
  reconcileRotationReadOnly: (
    record: SigningMigrationRecord
  ) => Promise<
    | { status: 'confirmed'; signature: string }
    | { status: 'pending'; signature: string }
    | { status: 'recovery_required' }
  >;
  promoteIncomingCandidateAfterVerification: (input: {
    legacyAgent: string;
    successorAgent: string;
  }) => Promise<void>;
  reconcileHeartbeatReadOnly: (record: SigningMigrationRecord) => Promise<
    | {
        status: 'confirmed';
        signature: string;
        totalHeartbeats: bigint;
      }
    | { status: 'pending'; signature: string }
    | { status: 'failed' }
  >;
  submitSuccessorHeartbeatDeliberately: () => Promise<
    | {
        status: 'confirmed';
        signature: string;
        totalHeartbeats: bigint;
      }
    | { status: 'pending'; signature: string }
  >;
  refreshDeadline: () => Promise<{
    status: 'verified';
    finalDeadline: number;
    chainUnixTime: number;
  }>;
  recheckFeeReserve: () => Promise<'ready' | 'acknowledged'>;
}

function sameIdentity(
  left: SigningMigrationIdentity,
  right: SigningMigrationIdentity
): boolean {
  return (
    left.cluster === right.cluster &&
    left.programId === right.programId &&
    left.owner === right.owner &&
    left.vault === right.vault
  );
}

function publicKey(value: string | null): PublicKey | null {
  if (!value) return null;
  try {
    return new PublicKey(value);
  } catch {
    return null;
  }
}

function resultForStoredRecord(
  record: SigningMigrationRecord
): IncomingMigrationResult {
  switch (record.state) {
    case 'legacy_authority_verified':
      return {
        status: 'incoming_migration_available',
        legacyAgent: record.legacyAgent,
      };
    case 'candidate_secured':
    case 'candidate_funding_required':
      return record.successorAgent
        ? {
            status: 'candidate_funding_required',
            successorAgent: record.successorAgent,
          }
        : { status: 'recovery_required' };
    case 'candidate_funding_pending':
      return record.fundingSignature
        ? {
            status: 'candidate_funding_pending',
            signature: record.fundingSignature,
          }
        : { status: 'recovery_required' };
    case 'candidate_funded':
      return record.successorAgent
        ? {
            status: 'candidate_funded',
            successorAgent: record.successorAgent,
          }
        : { status: 'recovery_required' };
    case 'successor_authorised':
    case 'successor_heartbeat_required':
      return { status: 'successor_heartbeat_required' };
    case 'successor_heartbeat_pending':
      return record.heartbeatSignature
        ? {
            status: 'successor_heartbeat_pending',
            signature: record.heartbeatSignature,
          }
        : { status: 'recovery_required' };
    case 'successor_heartbeat_confirmed':
    case 'notification_decision_required':
      return { status: 'notification_decision_required' };
    case 'notification_registered':
    case 'notification_declined':
    case 'bridge_retention':
    case 'migration_ready_for_cleanup':
      return { status: record.state };
    case 'recovery_required':
    case 'invalid_local_record':
    case 'not_started':
    default:
      return { status: 'recovery_required' };
  }
}

export function createSideBySideMigrationCoordinator(
  dependencies: SideBySideMigrationDependencies
) {
  let inFlight = false;

  async function locked(
    action: () => Promise<IncomingMigrationResult>
  ): Promise<IncomingMigrationResult> {
    if (inFlight) return { status: 'operation_pending' };
    inFlight = true;
    try {
      return await action();
    } finally {
      inFlight = false;
    }
  }

  async function inspect(owner: PublicKey) {
    const chain = await dependencies.fetchChainState(owner);
    if (!chain.active) return { status: 'vault_inactive' } as const;
    if (chain.executed) return { status: 'vault_executed' } as const;
    if (chain.chainUnixTime >= chain.finalDeadline) {
      return { status: 'deadline_reached' } as const;
    }
    if (await dependencies.getSuccessorActivePublicKey()) {
      return { status: 'active_key_already_present' } as const;
    }
    if (
      (await dependencies.hasUnresolvedHeartbeat(chain.identity)) ||
      (await dependencies.hasUnresolvedRotation(chain.identity)) ||
      (await dependencies.hasUnresolvedFunding(chain.identity))
    ) {
      return { status: 'operation_pending' } as const;
    }
    let record = await dependencies.loadRecord(chain.identity);
    if (!record) {
      record = await dependencies.beginRecord(chain);
    }
    if (
      !sameIdentity(record, chain.identity) ||
      record.legacyAgent !== chain.legacyAgent.toBase58()
    ) {
      return { status: 'identity_changed' } as const;
    }
    return {
      status: 'incoming_migration_available',
      legacyAgent: chain.legacyAgent.toBase58(),
      chain,
      record,
    } as const;
  }

  return {
    inspect: (owner: PublicKey) => locked(() => inspect(owner)),

    resumeReadOnly: (owner: PublicKey) =>
      locked(async () => {
        const chain = await dependencies.fetchChainState(owner);
        const record = await dependencies.loadRecord(chain.identity);
        if (!record) return inspect(owner);
        if (!sameIdentity(record, chain.identity)) {
          return { status: 'identity_changed' };
        }
        if (record.state === 'candidate_funding_pending') {
          const funding = await dependencies.reconcileFundingReadOnly(record);
          if (funding === 'pending') {
            return resultForStoredRecord(record);
          }
          if (funding === 'failed') {
            await dependencies.transitionRecord(
              chain.identity,
              'candidate_funding_required',
              { fundingSignature: null, safeErrorCode: null }
            );
            return record.successorAgent
              ? {
                  status: 'candidate_funding_required',
                  successorAgent: record.successorAgent,
                }
              : { status: 'recovery_required' };
          }
          const funded = await dependencies.transitionRecord(
            chain.identity,
            'candidate_funded',
            { safeErrorCode: null }
          );
          return resultForStoredRecord(funded);
        }
        if (
          record.state === 'rotation_pending' ||
          record.state === 'rotation_confirmation_unknown'
        ) {
          const reconciled = await dependencies.reconcileRotationReadOnly(
            record
          );
          if (reconciled.status === 'pending') {
            return {
              status: 'rotation_pending',
              signature: reconciled.signature,
            };
          }
          if (reconciled.status === 'recovery_required') {
            return { status: 'recovery_required' };
          }
          if (!record.successorAgent) {
            return { status: 'recovery_required' };
          }
          try {
            await dependencies.promoteIncomingCandidateAfterVerification({
              legacyAgent: record.legacyAgent,
              successorAgent: record.successorAgent,
            });
          } catch {
            await dependencies.transitionRecord(
              chain.identity,
              'recovery_required',
              { safeErrorCode: 'post_state_invalid' }
            );
            return { status: 'recovery_required' };
          }
          await dependencies.transitionRecord(
            chain.identity,
            'successor_authorised',
            {
              rotationSignature: reconciled.signature,
              rotationResolution: 'verified',
            }
          );
          await dependencies.transitionRecord(
            chain.identity,
            'successor_heartbeat_required'
          );
          await dependencies.refreshDeadline();
          return { status: 'successor_heartbeat_required' };
        }
        if (record.state === 'successor_heartbeat_pending') {
          const heartbeat = await dependencies.reconcileHeartbeatReadOnly(
            record
          );
          if (heartbeat.status === 'pending') {
            return {
              status: 'successor_heartbeat_pending',
              signature: heartbeat.signature,
            };
          }
          if (heartbeat.status === 'failed') {
            await dependencies.transitionRecord(
              chain.identity,
              'successor_heartbeat_required',
              { heartbeatSignature: null, safeErrorCode: null }
            );
            return { status: 'successor_heartbeat_required' };
          }
          if (
            heartbeat.totalHeartbeats <=
            BigInt(record.preRotationTotalHeartbeats)
          ) {
            await dependencies.transitionRecord(
              chain.identity,
              'recovery_required',
              { safeErrorCode: 'heartbeat_count_not_advanced' }
            );
            return { status: 'recovery_required' };
          }
          const deadline = await dependencies.refreshDeadline();
          await dependencies.recheckFeeReserve();
          await dependencies.transitionRecord(
            chain.identity,
            'successor_heartbeat_confirmed',
            {
              heartbeatSignature: heartbeat.signature,
              verifiedTotalHeartbeats: heartbeat.totalHeartbeats.toString(10),
              verifiedDeadline: deadline.finalDeadline,
              safeErrorCode: null,
            }
          );
          await dependencies.transitionRecord(
            chain.identity,
            'notification_decision_required'
          );
          return {
            status: 'successor_heartbeat_confirmed',
            signature: heartbeat.signature,
            totalHeartbeats: heartbeat.totalHeartbeats,
          };
        }
        return resultForStoredRecord(record);
      }),

    createCandidate: (owner: PublicKey) =>
      locked(async () => {
        const available = await inspect(owner);
        if (available.status !== 'incoming_migration_available') {
          return available;
        }
        const existingCandidate =
          await dependencies.getSuccessorCandidatePublicKey();
        const candidate =
          existingCandidate ??
          (await dependencies.createCandidateDeliberately());
        const readBack = await dependencies.readBackCandidate();
        if (candidate !== readBack || !publicKey(readBack)) {
          await dependencies.transitionRecord(
            available.chain.identity,
            'recovery_required',
            { safeErrorCode: 'candidate_persistence_failed' }
          );
          return { status: 'recovery_required' };
        }
        await dependencies.transitionRecord(
          available.chain.identity,
          'candidate_secured',
          { successorAgent: candidate }
        );
        await dependencies.transitionRecord(
          available.chain.identity,
          'candidate_funding_required'
        );
        return {
          status: 'candidate_secured',
          successorAgent: candidate,
        };
      }),

    fundCandidate: (owner: PublicKey) =>
      locked(async () => {
        const chain = await dependencies.fetchChainState(owner);
        const record = await dependencies.loadRecord(chain.identity);
        const candidate = publicKey(record?.successorAgent ?? null);
        if (
          !record ||
          record.state !== 'candidate_funding_required' ||
          !candidate
        ) {
          return { status: 'wrong_migration_state' };
        }
        const funded = await dependencies.fundCandidateDeliberately({
          owner,
          legacyAgent: chain.legacyAgent,
          candidateAgent: candidate,
        });
        if (funded.status === 'pending') {
          await dependencies.transitionRecord(
            chain.identity,
            'candidate_funding_pending',
            {
              fundingSignature: funded.signature,
              safeErrorCode: 'funding_unresolved',
            }
          );
          return {
            status: 'candidate_funding_pending',
            signature: funded.signature,
          };
        }
        await dependencies.transitionRecord(
          chain.identity,
          'candidate_funded',
          { safeErrorCode: null }
        );
        return {
          status: 'candidate_funded',
          successorAgent: candidate.toBase58(),
        };
      }),

    rotate: (owner: PublicKey) =>
      locked(async () => {
        const chain = await dependencies.fetchChainState(owner);
        const record = await dependencies.loadRecord(chain.identity);
        const candidate = publicKey(record?.successorAgent ?? null);
        if (!record || record.state !== 'candidate_funded' || !candidate) {
          return { status: 'wrong_migration_state' };
        }
        const rotation = await dependencies.rotateIncomingDeliberately({
          owner,
          legacyAgent: chain.legacyAgent,
          candidateAgent: candidate,
        });
        if (rotation.status !== 'confirmed') {
          await dependencies.transitionRecord(
            chain.identity,
            rotation.status === 'confirmation_unknown'
              ? 'rotation_confirmation_unknown'
              : 'rotation_pending',
            {
              rotationSignature: rotation.signature,
              safeErrorCode: 'rotation_unresolved',
            }
          );
          return {
            status:
              rotation.status === 'confirmation_unknown'
                ? 'rotation_confirmation_unknown'
                : 'rotation_pending',
            signature: rotation.signature,
          };
        }
        await dependencies.transitionRecord(
          chain.identity,
          'rotation_pending',
          { rotationSignature: rotation.signature }
        );
        try {
          await dependencies.promoteIncomingCandidateAfterVerification({
            legacyAgent: chain.legacyAgent.toBase58(),
            successorAgent: candidate.toBase58(),
          });
        } catch {
          await dependencies.transitionRecord(
            chain.identity,
            'recovery_required',
            { safeErrorCode: 'post_state_invalid' }
          );
          return { status: 'recovery_required' };
        }
        await dependencies.transitionRecord(
          chain.identity,
          'successor_authorised',
          {
            rotationResolution: 'verified',
            safeErrorCode: null,
          }
        );
        await dependencies.transitionRecord(
          chain.identity,
          'successor_heartbeat_required'
        );
        await dependencies.refreshDeadline();
        return {
          status: 'successor_authorised',
          successorAgent: candidate.toBase58(),
        };
      }),

    proveSuccessorHeartbeat: (owner: PublicKey) =>
      locked(async () => {
        const chain = await dependencies.fetchChainState(owner);
        const record = await dependencies.loadRecord(chain.identity);
        if (!record || record.state !== 'successor_heartbeat_required') {
          return { status: 'wrong_migration_state' };
        }
        const heartbeat =
          await dependencies.submitSuccessorHeartbeatDeliberately();
        if (heartbeat.status === 'pending') {
          await dependencies.transitionRecord(
            chain.identity,
            'successor_heartbeat_pending',
            {
              heartbeatSignature: heartbeat.signature,
              safeErrorCode: 'heartbeat_unresolved',
            }
          );
          return {
            status: 'successor_heartbeat_pending',
            signature: heartbeat.signature,
          };
        }
        if (
          heartbeat.totalHeartbeats <= BigInt(record.preRotationTotalHeartbeats)
        ) {
          await dependencies.transitionRecord(
            chain.identity,
            'recovery_required',
            {
              safeErrorCode: 'heartbeat_count_not_advanced',
            }
          );
          return { status: 'recovery_required' };
        }
        const deadline = await dependencies.refreshDeadline();
        await dependencies.recheckFeeReserve();
        await dependencies.transitionRecord(
          chain.identity,
          'successor_heartbeat_confirmed',
          {
            heartbeatSignature: heartbeat.signature,
            verifiedTotalHeartbeats: heartbeat.totalHeartbeats.toString(10),
            verifiedDeadline: deadline.finalDeadline,
            safeErrorCode: null,
          }
        );
        await dependencies.transitionRecord(
          chain.identity,
          'notification_decision_required'
        );
        return {
          status: 'successor_heartbeat_confirmed',
          signature: heartbeat.signature,
          totalHeartbeats: heartbeat.totalHeartbeats,
        };
      }),

    recordNotificationDecision: (
      owner: PublicKey,
      decision: Exclude<MigrationNotificationDecision, 'pending'>
    ) =>
      locked(async () => {
        const chain = await dependencies.fetchChainState(owner);
        const record = await dependencies.loadRecord(chain.identity);
        if (!record || record.state !== 'notification_decision_required') {
          return { status: 'wrong_migration_state' };
        }
        const state =
          decision === 'registered'
            ? 'notification_registered'
            : 'notification_declined';
        await dependencies.transitionRecord(chain.identity, state, {
          notificationDecision: decision,
        });
        await dependencies.transitionRecord(chain.identity, 'bridge_retention');
        return { status: state };
      }),
  };
}

export type SideBySideMigrationCoordinator = ReturnType<
  typeof createSideBySideMigrationCoordinator
>;

export interface BridgeRollbackDependencies {
  loadRetainedBridgeKey: () => Promise<PublicKey>;
  fetchOnChainAgent: (owner: PublicKey) => Promise<PublicKey>;
  fundReplacementDeliberately: (
    owner: PublicKey,
    bridgeAgent: PublicKey
  ) => Promise<'funded'>;
  rotateWithReplacementPayerAndOwner: (input: {
    owner: PublicKey;
    currentAgent: PublicKey;
    replacementAgent: PublicKey;
  }) => Promise<{ status: 'confirmed'; signature: string }>;
}

export function createBridgeRollbackCoordinator(
  dependencies: BridgeRollbackDependencies
) {
  return {
    reauthoriseThisInstallation: async (owner: PublicKey) => {
      const replacement = await dependencies.loadRetainedBridgeKey();
      const current = await dependencies.fetchOnChainAgent(owner);
      if (current.equals(replacement)) {
        return { status: 'already_authorised' } as const;
      }
      await dependencies.fundReplacementDeliberately(owner, replacement);
      const result = await dependencies.rotateWithReplacementPayerAndOwner({
        owner,
        currentAgent: current,
        replacementAgent: replacement,
      });
      return {
        status: 'reauthorised',
        signature: result.signature,
      } as const;
    },
  };
}
