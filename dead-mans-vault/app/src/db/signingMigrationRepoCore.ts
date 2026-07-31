import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';

export const SIGNING_MIGRATION_SCHEMA_VERSION = 1;

export const SIGNING_MIGRATION_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS signing_identity_migrations (
    operation_id TEXT PRIMARY KEY NOT NULL,
    schema_version INTEGER NOT NULL,
    cluster TEXT NOT NULL,
    program_id TEXT NOT NULL,
    owner TEXT NOT NULL,
    vault TEXT NOT NULL,
    legacy_agent TEXT NOT NULL,
    successor_agent TEXT,
    funding_signature TEXT,
    rotation_signature TEXT,
    rotation_resolution TEXT,
    heartbeat_signature TEXT,
    pre_rotation_total_heartbeats TEXT NOT NULL,
    verified_total_heartbeats TEXT,
    verified_deadline INTEGER,
    notification_decision TEXT NOT NULL,
    state TEXT NOT NULL,
    safe_error_code TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_signing_migration_identity
    ON signing_identity_migrations(cluster, program_id, owner, vault);
`;

export type SigningMigrationState =
  | 'not_started'
  | 'legacy_authority_verified'
  | 'candidate_secured'
  | 'candidate_funding_required'
  | 'candidate_funding_pending'
  | 'candidate_funded'
  | 'rotation_pending'
  | 'rotation_confirmation_unknown'
  | 'successor_authorised'
  | 'successor_heartbeat_required'
  | 'successor_heartbeat_pending'
  | 'successor_heartbeat_confirmed'
  | 'notification_decision_required'
  | 'notification_registered'
  | 'notification_declined'
  | 'bridge_retention'
  | 'migration_ready_for_cleanup'
  | 'recovery_required'
  | 'invalid_local_record';

export type MigrationNotificationDecision =
  | 'pending'
  | 'registered'
  | 'declined';

export type SigningMigrationErrorCode =
  | 'identity_changed'
  | 'candidate_persistence_failed'
  | 'funding_unresolved'
  | 'rotation_unresolved'
  | 'heartbeat_unresolved'
  | 'heartbeat_count_not_advanced'
  | 'post_state_invalid'
  | 'invalid_local_record'
  | null;

export interface SigningMigrationIdentity {
  cluster: 'devnet';
  programId: string;
  owner: string;
  vault: string;
}

export interface SigningMigrationRecord extends SigningMigrationIdentity {
  operationId: string;
  schemaVersion: number;
  legacyAgent: string;
  successorAgent: string | null;
  fundingSignature: string | null;
  rotationSignature: string | null;
  rotationResolution: string | null;
  heartbeatSignature: string | null;
  preRotationTotalHeartbeats: string;
  verifiedTotalHeartbeats: string | null;
  verifiedDeadline: number | null;
  notificationDecision: MigrationNotificationDecision;
  state: SigningMigrationState;
  safeErrorCode: SigningMigrationErrorCode;
  createdAt: number;
  updatedAt: number;
}

const TRANSITIONS: Record<
  SigningMigrationState,
  ReadonlyArray<SigningMigrationState>
> = {
  not_started: ['legacy_authority_verified', 'recovery_required'],
  legacy_authority_verified: ['candidate_secured', 'recovery_required'],
  candidate_secured: [
    'candidate_funding_required',
    'candidate_funded',
    'recovery_required',
  ],
  candidate_funding_required: [
    'candidate_funding_pending',
    'candidate_funded',
    'recovery_required',
  ],
  candidate_funding_pending: [
    'candidate_funding_pending',
    'candidate_funding_required',
    'candidate_funded',
    'recovery_required',
  ],
  candidate_funded: ['rotation_pending', 'recovery_required'],
  rotation_pending: [
    'rotation_pending',
    'rotation_confirmation_unknown',
    'successor_authorised',
    'recovery_required',
  ],
  rotation_confirmation_unknown: [
    'rotation_confirmation_unknown',
    'successor_authorised',
    'recovery_required',
  ],
  successor_authorised: ['successor_heartbeat_required', 'recovery_required'],
  successor_heartbeat_required: [
    'successor_heartbeat_pending',
    'successor_heartbeat_confirmed',
    'recovery_required',
  ],
  successor_heartbeat_pending: [
    'successor_heartbeat_pending',
    'successor_heartbeat_required',
    'successor_heartbeat_confirmed',
    'recovery_required',
  ],
  successor_heartbeat_confirmed: [
    'notification_decision_required',
    'recovery_required',
  ],
  notification_decision_required: [
    'notification_registered',
    'notification_declined',
    'recovery_required',
  ],
  notification_registered: ['bridge_retention'],
  notification_declined: ['bridge_retention'],
  bridge_retention: ['migration_ready_for_cleanup'],
  migration_ready_for_cleanup: [],
  recovery_required: ['recovery_required'],
  invalid_local_record: [],
};

function isPublicKey(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    return new PublicKey(value).toBase58() === value;
  } catch {
    return false;
  }
}

function isSignature(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    return bs58.decode(value).length === 64;
  } catch {
    return false;
  }
}

function isU64(value: unknown): value is string {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(value)) {
    return false;
  }
  try {
    return BigInt(value) <= 18_446_744_073_709_551_615n;
  } catch {
    return false;
  }
}

function safe(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function validateSigningMigrationRecord(
  record: SigningMigrationRecord
): SigningMigrationRecord {
  if (
    record.schemaVersion !== SIGNING_MIGRATION_SCHEMA_VERSION ||
    record.cluster !== 'devnet' ||
    record.operationId !==
      [record.cluster, record.programId, record.owner, record.vault].join(':')
  ) {
    throw new Error('Invalid signing migration schema or identity');
  }
  for (const value of [
    record.programId,
    record.owner,
    record.vault,
    record.legacyAgent,
  ]) {
    if (!isPublicKey(value)) {
      throw new Error('Invalid signing migration public key');
    }
  }
  if (
    record.successorAgent !== null &&
    (!isPublicKey(record.successorAgent) ||
      record.successorAgent === record.legacyAgent)
  ) {
    throw new Error('Invalid successor agent');
  }
  for (const signature of [
    record.fundingSignature,
    record.rotationSignature,
    record.heartbeatSignature,
  ]) {
    if (signature !== null && !isSignature(signature)) {
      throw new Error('Invalid signing migration signature');
    }
  }
  if (
    !isU64(record.preRotationTotalHeartbeats) ||
    (record.verifiedTotalHeartbeats !== null &&
      !isU64(record.verifiedTotalHeartbeats))
  ) {
    throw new Error('Invalid signing migration heartbeat count');
  }
  if (
    !safe(record.createdAt) ||
    !safe(record.updatedAt) ||
    (record.verifiedDeadline !== null && !safe(record.verifiedDeadline))
  ) {
    throw new Error('Invalid signing migration timestamp');
  }
  if (
    !Object.prototype.hasOwnProperty.call(TRANSITIONS, record.state) ||
    !['pending', 'registered', 'declined'].includes(
      record.notificationDecision
    ) ||
    ![
      null,
      'identity_changed',
      'candidate_persistence_failed',
      'funding_unresolved',
      'rotation_unresolved',
      'heartbeat_unresolved',
      'heartbeat_count_not_advanced',
      'post_state_invalid',
      'invalid_local_record',
    ].includes(record.safeErrorCode)
  ) {
    throw new Error('Invalid signing migration state');
  }
  return record;
}

export function createSigningMigrationRecord(input: {
  identity: SigningMigrationIdentity;
  legacyAgent: string;
  preRotationTotalHeartbeats: bigint;
  verifiedDeadline: number;
  nowSeconds: number;
}): SigningMigrationRecord {
  const operationId = [
    input.identity.cluster,
    input.identity.programId,
    input.identity.owner,
    input.identity.vault,
  ].join(':');
  return validateSigningMigrationRecord({
    ...input.identity,
    operationId,
    schemaVersion: SIGNING_MIGRATION_SCHEMA_VERSION,
    legacyAgent: input.legacyAgent,
    successorAgent: null,
    fundingSignature: null,
    rotationSignature: null,
    rotationResolution: null,
    heartbeatSignature: null,
    preRotationTotalHeartbeats: input.preRotationTotalHeartbeats.toString(10),
    verifiedTotalHeartbeats: null,
    verifiedDeadline: input.verifiedDeadline,
    notificationDecision: 'pending',
    state: 'legacy_authority_verified',
    safeErrorCode: null,
    createdAt: input.nowSeconds,
    updatedAt: input.nowSeconds,
  });
}

export type SigningMigrationPatch = Partial<
  Pick<
    SigningMigrationRecord,
    | 'successorAgent'
    | 'fundingSignature'
    | 'rotationSignature'
    | 'rotationResolution'
    | 'heartbeatSignature'
    | 'verifiedTotalHeartbeats'
    | 'verifiedDeadline'
    | 'notificationDecision'
    | 'safeErrorCode'
  >
>;

export function transitionSigningMigration(
  record: SigningMigrationRecord,
  state: SigningMigrationState,
  nowSeconds: number,
  patch: SigningMigrationPatch = {}
): SigningMigrationRecord {
  if (!TRANSITIONS[record.state].includes(state)) {
    throw new Error(
      `Invalid signing migration transition ${record.state} -> ${state}`
    );
  }
  return validateSigningMigrationRecord({
    ...record,
    ...patch,
    state,
    updatedAt: nowSeconds,
  });
}

export interface MigrationCompletionEvidence {
  distinctPackage: boolean;
  signingFingerprintRecorded: boolean;
  successorAuthorised: boolean;
  successorKeyResolvesAfterRestart: boolean;
  successorHeartbeatConfirmed: boolean;
  heartbeatCountAdvanced: boolean;
  freshDeadlineHealthy: boolean;
  feeReserveAccepted: boolean;
  noUnresolvedHeartbeat: boolean;
  noUnresolvedRotation: boolean;
  noUnresolvedFunding: boolean;
  notificationDecisionComplete: boolean;
  legacyBridgeInstalled: boolean;
  rollbackValidated: boolean;
  evidenceCaptured: boolean;
}

export function isMigrationReadyForCleanup(
  evidence: MigrationCompletionEvidence
): boolean {
  return Object.values(evidence).every(Boolean);
}
