import { getDb } from './database';
import {
  createSigningMigrationRecord,
  transitionSigningMigration,
  validateSigningMigrationRecord,
  type SigningMigrationIdentity,
  type SigningMigrationPatch,
  type SigningMigrationRecord,
  type SigningMigrationState,
} from './signingMigrationRepoCore';

interface Row {
  operation_id: string;
  schema_version: number;
  cluster: 'devnet';
  program_id: string;
  owner: string;
  vault: string;
  legacy_agent: string;
  successor_agent: string | null;
  funding_signature: string | null;
  rotation_signature: string | null;
  rotation_resolution: string | null;
  heartbeat_signature: string | null;
  pre_rotation_total_heartbeats: string;
  verified_total_heartbeats: string | null;
  verified_deadline: number | null;
  notification_decision: SigningMigrationRecord['notificationDecision'];
  state: SigningMigrationState;
  safe_error_code: SigningMigrationRecord['safeErrorCode'];
  created_at: number;
  updated_at: number;
}

const COLUMNS = `
  operation_id, schema_version, cluster, program_id, owner, vault,
  legacy_agent, successor_agent, funding_signature, rotation_signature,
  rotation_resolution, heartbeat_signature,
  pre_rotation_total_heartbeats, verified_total_heartbeats,
  verified_deadline, notification_decision, state, safe_error_code,
  created_at, updated_at
`;

function fromRow(row: Row): SigningMigrationRecord {
  return validateSigningMigrationRecord({
    operationId: row.operation_id,
    schemaVersion: row.schema_version,
    cluster: row.cluster,
    programId: row.program_id,
    owner: row.owner,
    vault: row.vault,
    legacyAgent: row.legacy_agent,
    successorAgent: row.successor_agent,
    fundingSignature: row.funding_signature,
    rotationSignature: row.rotation_signature,
    rotationResolution: row.rotation_resolution,
    heartbeatSignature: row.heartbeat_signature,
    preRotationTotalHeartbeats: row.pre_rotation_total_heartbeats,
    verifiedTotalHeartbeats: row.verified_total_heartbeats,
    verifiedDeadline: row.verified_deadline,
    notificationDecision: row.notification_decision,
    state: row.state,
    safeErrorCode: row.safe_error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function values(record: SigningMigrationRecord): Array<string | number | null> {
  return [
    record.operationId,
    record.schemaVersion,
    record.cluster,
    record.programId,
    record.owner,
    record.vault,
    record.legacyAgent,
    record.successorAgent,
    record.fundingSignature,
    record.rotationSignature,
    record.rotationResolution,
    record.heartbeatSignature,
    record.preRotationTotalHeartbeats,
    record.verifiedTotalHeartbeats,
    record.verifiedDeadline,
    record.notificationDecision,
    record.state,
    record.safeErrorCode,
    record.createdAt,
    record.updatedAt,
  ];
}

export async function beginSigningMigration(
  input: Parameters<typeof createSigningMigrationRecord>[0]
): Promise<SigningMigrationRecord> {
  const record = createSigningMigrationRecord(input);
  await getDb().runAsync(
    `INSERT INTO signing_identity_migrations (${COLUMNS})
     VALUES (${Array.from({ length: 20 }, () => '?').join(', ')})`,
    values(record)
  );
  return record;
}

export async function getSigningMigration(
  identity: SigningMigrationIdentity
): Promise<SigningMigrationRecord | null> {
  const row = await getDb().getFirstAsync<Row>(
    `SELECT ${COLUMNS}
       FROM signing_identity_migrations
      WHERE cluster = ? AND program_id = ? AND owner = ? AND vault = ?`,
    [identity.cluster, identity.programId, identity.owner, identity.vault]
  );
  return row ? fromRow(row) : null;
}

export async function transitionStoredSigningMigration(
  identity: SigningMigrationIdentity,
  state: SigningMigrationState,
  patch: SigningMigrationPatch = {}
): Promise<SigningMigrationRecord> {
  const current = await getSigningMigration(identity);
  if (!current) throw new Error('Signing migration record not found');
  const next = transitionSigningMigration(
    current,
    state,
    Math.floor(Date.now() / 1000),
    patch
  );
  await getDb().runAsync(
    `UPDATE signing_identity_migrations
        SET successor_agent = ?, funding_signature = ?,
            rotation_signature = ?,
            rotation_resolution = ?, heartbeat_signature = ?,
            verified_total_heartbeats = ?, verified_deadline = ?,
            notification_decision = ?, state = ?, safe_error_code = ?,
            updated_at = ?
      WHERE operation_id = ?`,
    [
      next.successorAgent,
      next.fundingSignature,
      next.rotationSignature,
      next.rotationResolution,
      next.heartbeatSignature,
      next.verifiedTotalHeartbeats,
      next.verifiedDeadline,
      next.notificationDecision,
      next.state,
      next.safeErrorCode,
      next.updatedAt,
      next.operationId,
    ]
  );
  return next;
}
