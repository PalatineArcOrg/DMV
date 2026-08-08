import { getDb } from './database';
import {
  createPreparedAgentRotation,
  isBlockingAgentRotationState,
  transitionAgentRotation,
  validateAgentRotationRecord,
  type AgentRotationIdentity,
  type AgentRotationOperationRecord,
  type AgentRotationOperationState,
  type AgentRotationTransitionPatch,
} from './agentRotationRepoCore';

interface AgentRotationRow {
  operation_id: string;
  schema_version: number;
  cluster: string;
  program_id: string;
  owner: string;
  vault: string;
  heartbeat: string;
  old_agent: string;
  candidate_agent: string;
  candidate_slot_id: 'candidate';
  signature: string;
  blockhash: string;
  last_valid_block_height: number;
  before_last_heartbeat: number;
  before_total_heartbeats: string;
  before_vault_updated_at: number;
  before_final_deadline: number;
  before_config_fingerprint: string;
  state: AgentRotationOperationState;
  safe_error_code: AgentRotationOperationRecord['safeErrorCode'];
  created_at: number;
  updated_at: number;
  last_checked_at: number | null;
  resolved_agent: string | null;
  resolved_last_heartbeat: number | null;
  resolved_vault_updated_at: number | null;
}

const COLUMNS = `
  operation_id, schema_version, cluster, program_id, owner, vault,
  heartbeat, old_agent, candidate_agent, candidate_slot_id, signature,
  blockhash, last_valid_block_height, before_last_heartbeat,
  before_total_heartbeats, before_vault_updated_at, before_final_deadline,
  before_config_fingerprint, state, safe_error_code, created_at, updated_at,
  last_checked_at, resolved_agent, resolved_last_heartbeat,
  resolved_vault_updated_at
`;

export class InvalidAgentRotationRecordError extends Error {
  constructor() {
    super('Saved agent rotation operation is invalid');
    this.name = 'InvalidAgentRotationRecordError';
  }
}

function fromRow(row: AgentRotationRow): AgentRotationOperationRecord {
  return validateAgentRotationRecord({
    operationId: row.operation_id,
    schemaVersion: row.schema_version,
    cluster: row.cluster,
    programId: row.program_id,
    owner: row.owner,
    vault: row.vault,
    heartbeat: row.heartbeat,
    oldAgent: row.old_agent,
    candidateAgent: row.candidate_agent,
    candidateSlotId: row.candidate_slot_id,
    signature: row.signature,
    blockhash: row.blockhash,
    lastValidBlockHeight: row.last_valid_block_height,
    beforeLastHeartbeat: row.before_last_heartbeat,
    beforeTotalHeartbeats: row.before_total_heartbeats,
    beforeVaultUpdatedAt: row.before_vault_updated_at,
    beforeFinalDeadline: row.before_final_deadline,
    beforeConfigFingerprint: row.before_config_fingerprint,
    state: row.state,
    safeErrorCode: row.safe_error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastCheckedAt: row.last_checked_at,
    resolvedAgent: row.resolved_agent,
    resolvedLastHeartbeat: row.resolved_last_heartbeat,
    resolvedVaultUpdatedAt: row.resolved_vault_updated_at,
  });
}

function values(
  record: AgentRotationOperationRecord,
): Array<string | number | null> {
  return [
    record.operationId,
    record.schemaVersion,
    record.cluster,
    record.programId,
    record.owner,
    record.vault,
    record.heartbeat,
    record.oldAgent,
    record.candidateAgent,
    record.candidateSlotId,
    record.signature,
    record.blockhash,
    record.lastValidBlockHeight,
    record.beforeLastHeartbeat,
    record.beforeTotalHeartbeats,
    record.beforeVaultUpdatedAt,
    record.beforeFinalDeadline,
    record.beforeConfigFingerprint,
    record.state,
    record.safeErrorCode,
    record.createdAt,
    record.updatedAt,
    record.lastCheckedAt,
    record.resolvedAgent,
    record.resolvedLastHeartbeat,
    record.resolvedVaultUpdatedAt,
  ];
}

export async function prepareAgentRotationOperation(
  input: Parameters<typeof createPreparedAgentRotation>[0],
): Promise<AgentRotationOperationRecord> {
  const record = createPreparedAgentRotation(input);
  await getDb().runAsync(
    `INSERT INTO agent_rotation_operations (${COLUMNS})
     VALUES (${Array.from({ length: 26 }, () => '?').join(', ')})`,
    values(record),
  );
  return record;
}

export async function getAgentRotationOperation(
  signature: string,
): Promise<AgentRotationOperationRecord | null> {
  const row = await getDb().getFirstAsync<AgentRotationRow>(
    `SELECT ${COLUMNS}
       FROM agent_rotation_operations WHERE signature = ?`,
    [signature],
  );
  return row ? fromRow(row) : null;
}

export async function getBlockingAgentRotationOperation(
  identity: Pick<
    AgentRotationIdentity,
    'cluster' | 'programId' | 'owner' | 'vault'
  >,
): Promise<AgentRotationOperationRecord | null> {
  const rows = await getDb().getAllAsync<AgentRotationRow>(
    `SELECT ${COLUMNS}
       FROM agent_rotation_operations
      WHERE cluster = ? AND program_id = ? AND owner = ? AND vault = ?
      ORDER BY created_at DESC`,
    [
      identity.cluster,
      identity.programId,
      identity.owner,
      identity.vault,
    ],
  );
  for (const row of rows) {
    let record: AgentRotationOperationRecord;
    try {
      record = fromRow(row);
    } catch {
      await getDb().runAsync(
        `UPDATE agent_rotation_operations
            SET state = 'invalid_local_record',
                safe_error_code = 'invalid_local_record',
                updated_at = CAST(strftime('%s', 'now') AS INTEGER)
          WHERE operation_id = ?`,
        [row.operation_id],
      );
      throw new InvalidAgentRotationRecordError();
    }
    if (isBlockingAgentRotationState(record.state)) return record;
  }
  return null;
}

export async function transitionStoredAgentRotation(
  signature: string,
  state: AgentRotationOperationState,
  patch: AgentRotationTransitionPatch = {},
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<AgentRotationOperationRecord> {
  const current = await getAgentRotationOperation(signature);
  if (!current) throw new Error('Agent rotation operation does not exist');
  const next = transitionAgentRotation(
    current,
    state,
    nowSeconds,
    patch,
  );
  await getDb().runAsync(
    `UPDATE agent_rotation_operations
        SET state = ?, safe_error_code = ?, updated_at = ?,
            last_checked_at = ?, resolved_agent = ?,
            resolved_last_heartbeat = ?, resolved_vault_updated_at = ?
      WHERE signature = ?`,
    [
      next.state,
      next.safeErrorCode,
      next.updatedAt,
      next.lastCheckedAt,
      next.resolvedAgent,
      next.resolvedLastHeartbeat,
      next.resolvedVaultUpdatedAt,
      signature,
    ],
  );
  return next;
}
