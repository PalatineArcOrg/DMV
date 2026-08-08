import { getDb } from './database';
import {
  createPreparedHeartbeatOperation,
  isBlockingHeartbeatOperationState,
  isUnresolvedHeartbeatOperationState,
  transitionHeartbeatOperation,
  validateHeartbeatOperationRecord,
  type HeartbeatOperationIdentity,
  type HeartbeatOperationRecord,
  type HeartbeatOperationState,
  type HeartbeatOperationTransitionPatch,
  type PreparedHeartbeatOperation,
} from './heartbeatOperationRepoCore';

interface HeartbeatOperationRow {
  operation_id: string;
  schema_version: number;
  cluster: string;
  program_id: string;
  owner: string;
  vault: string;
  heartbeat: string;
  agent_pubkey: string;
  method: PreparedHeartbeatOperation['method'];
  method_index: number;
  signature: string;
  blockhash: string;
  last_valid_block_height: number;
  before_last_heartbeat: number;
  before_total_heartbeats: string;
  heartbeat_interval: number;
  grace_period: number;
  state: HeartbeatOperationState;
  created_at: number;
  updated_at: number;
  last_checked_at: number | null;
  resolved_last_heartbeat: number | null;
  resolved_total_heartbeats: string | null;
  local_sync_state: HeartbeatOperationRecord['localSyncState'];
  safe_error_code: HeartbeatOperationRecord['safeErrorCode'];
}

export class InvalidHeartbeatOperationRecordError extends Error {
  constructor() {
    super('Saved heartbeat operation is invalid');
    this.name = 'InvalidHeartbeatOperationRecordError';
  }
}

const OPERATION_COLUMNS = `
  operation_id, schema_version, cluster, program_id, owner, vault,
  heartbeat, agent_pubkey, method, method_index, signature, blockhash,
  last_valid_block_height, before_last_heartbeat,
  before_total_heartbeats, heartbeat_interval, grace_period, state,
  created_at, updated_at, last_checked_at, resolved_last_heartbeat,
  resolved_total_heartbeats, local_sync_state, safe_error_code
`;

function fromRow(row: HeartbeatOperationRow): HeartbeatOperationRecord {
  return validateHeartbeatOperationRecord({
    operationId: row.operation_id,
    schemaVersion: row.schema_version,
    cluster: row.cluster,
    programId: row.program_id,
    owner: row.owner,
    vault: row.vault,
    heartbeat: row.heartbeat,
    agentPubkey: row.agent_pubkey,
    method: row.method,
    methodIndex: row.method_index,
    signature: row.signature,
    blockhash: row.blockhash,
    lastValidBlockHeight: row.last_valid_block_height,
    beforeLastHeartbeat: row.before_last_heartbeat,
    beforeTotalHeartbeats: row.before_total_heartbeats,
    heartbeatInterval: row.heartbeat_interval,
    gracePeriod: row.grace_period,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastCheckedAt: row.last_checked_at,
    resolvedLastHeartbeat: row.resolved_last_heartbeat,
    resolvedTotalHeartbeats: row.resolved_total_heartbeats,
    localSyncState: row.local_sync_state,
    safeErrorCode: row.safe_error_code,
  });
}

function values(record: HeartbeatOperationRecord): Array<string | number | null> {
  return [
    record.operationId,
    record.schemaVersion,
    record.cluster,
    record.programId,
    record.owner,
    record.vault,
    record.heartbeat,
    record.agentPubkey,
    record.method,
    record.methodIndex,
    record.signature,
    record.blockhash,
    record.lastValidBlockHeight,
    record.beforeLastHeartbeat,
    record.beforeTotalHeartbeats,
    record.heartbeatInterval,
    record.gracePeriod,
    record.state,
    record.createdAt,
    record.updatedAt,
    record.lastCheckedAt,
    record.resolvedLastHeartbeat,
    record.resolvedTotalHeartbeats,
    record.localSyncState,
    record.safeErrorCode,
  ];
}

export async function prepareHeartbeatOperation(
  input: Parameters<typeof createPreparedHeartbeatOperation>[0],
): Promise<PreparedHeartbeatOperation> {
  const record = createPreparedHeartbeatOperation(input);
  const db = getDb();
  await db.runAsync(
    `INSERT INTO heartbeat_operations (${OPERATION_COLUMNS})
     VALUES (${Array.from({ length: 25 }, () => '?').join(', ')})`,
    values(record),
  );
  try {
    await pruneTerminalHeartbeatOperations(record, 10);
  } catch {
    // Retention is best-effort. PREPARED durability must remain the only
    // condition controlling whether submission is allowed.
  }
  return record;
}

export async function getHeartbeatOperation(
  signature: string,
): Promise<HeartbeatOperationRecord | null> {
  const row = await getDb().getFirstAsync<HeartbeatOperationRow>(
    `SELECT ${OPERATION_COLUMNS}
       FROM heartbeat_operations WHERE signature = ?`,
    [signature],
  );
  return row ? fromRow(row) : null;
}

export async function getUnresolvedHeartbeatOperation(
  identity: Pick<
    HeartbeatOperationIdentity,
    'cluster' | 'programId' | 'owner' | 'vault'
  >,
): Promise<HeartbeatOperationRecord | null> {
  const records = await getValidatedOperationsForIdentity(identity);
  for (const record of records) {
    if (isUnresolvedHeartbeatOperationState(record.state)) {
      return record;
    }
  }
  return null;
}

async function getValidatedOperationsForIdentity(
  identity: Pick<
    HeartbeatOperationIdentity,
    'cluster' | 'programId' | 'owner' | 'vault'
  >,
): Promise<Array<HeartbeatOperationRecord>> {
  const rows = await getDb().getAllAsync<HeartbeatOperationRow>(
    `SELECT ${OPERATION_COLUMNS}
       FROM heartbeat_operations
      WHERE cluster = ? AND program_id = ? AND owner = ? AND vault = ?
      ORDER BY created_at DESC`,
    [
      identity.cluster,
      identity.programId,
      identity.owner,
      identity.vault,
    ],
  );
  const records: Array<HeartbeatOperationRecord> = [];
  for (const row of rows) {
    let record: HeartbeatOperationRecord;
    try {
      record = fromRow(row);
    } catch {
      await getDb().runAsync(
        `UPDATE heartbeat_operations
            SET state = 'invalid_local_record',
                safe_error_code = 'invalid_local_record',
                updated_at = CAST(strftime('%s', 'now') AS INTEGER)
          WHERE operation_id = ?`,
        [row.operation_id],
      );
      throw new InvalidHeartbeatOperationRecordError();
    }
    records.push(record);
  }
  return records;
}

export async function getBlockingHeartbeatOperation(
  identity: Pick<
    HeartbeatOperationIdentity,
    'cluster' | 'programId' | 'owner' | 'vault'
  >,
): Promise<HeartbeatOperationRecord | null> {
  const records = await getValidatedOperationsForIdentity(identity);
  for (const record of records) {
    if (isBlockingHeartbeatOperationState(record.state)) {
      return record;
    }
  }
  return null;
}

export async function transitionStoredHeartbeatOperation(
  signature: string,
  nextState: HeartbeatOperationState,
  patch: HeartbeatOperationTransitionPatch = {},
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<HeartbeatOperationRecord> {
  const existing = await getHeartbeatOperation(signature);
  if (!existing) {
    throw new Error('Heartbeat operation does not exist');
  }
  const next = transitionHeartbeatOperation(
    existing,
    nextState,
    nowSeconds,
    patch,
  );
  await getDb().runAsync(
    `UPDATE heartbeat_operations
        SET state = ?, updated_at = ?, last_checked_at = ?,
            resolved_last_heartbeat = ?, resolved_total_heartbeats = ?,
            local_sync_state = ?, safe_error_code = ?
      WHERE signature = ?`,
    [
      next.state,
      next.updatedAt,
      next.lastCheckedAt,
      next.resolvedLastHeartbeat,
      next.resolvedTotalHeartbeats,
      next.localSyncState,
      next.safeErrorCode,
      signature,
    ],
  );
  return next;
}

export async function pruneTerminalHeartbeatOperations(
  identity: Pick<
    HeartbeatOperationIdentity,
    'cluster' | 'programId' | 'owner' | 'vault'
  >,
  retain: number,
): Promise<void> {
  if (!Number.isSafeInteger(retain) || retain < 1) {
    throw new Error('Invalid heartbeat operation retention limit');
  }
  await getDb().runAsync(
    `DELETE FROM heartbeat_operations
      WHERE operation_id IN (
        SELECT operation_id FROM heartbeat_operations
         WHERE cluster = ? AND program_id = ? AND owner = ? AND vault = ?
           AND state IN (
             'resolved_confirmed', 'resolved_failed',
             'resolved_expired_not_landed',
             'resolved_chain_advanced_unattributed',
             'invalid_local_record'
           )
         ORDER BY updated_at DESC
         LIMIT -1 OFFSET ?
      )`,
    [
      identity.cluster,
      identity.programId,
      identity.owner,
      identity.vault,
      retain,
    ],
  );
}
