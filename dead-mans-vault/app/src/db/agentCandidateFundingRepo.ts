import { getDb } from './database';
import {
  createPreparedCandidateFunding,
  isUnresolvedCandidateFundingState,
  transitionCandidateFunding,
  validateCandidateFundingOperation,
  type CandidateFundingIdentity,
  type CandidateFundingOperation,
  type CandidateFundingOperationState,
  type CandidateFundingErrorCode,
} from './agentCandidateFundingRepoCore';

interface Row {
  operation_id: string;
  schema_version: number;
  cluster: string;
  program_id: string;
  owner: string;
  vault: string;
  candidate_agent: string;
  signature: string;
  blockhash: string;
  last_valid_block_height: number;
  transfer_lamports: number;
  state: CandidateFundingOperationState;
  safe_error_code: CandidateFundingErrorCode;
  created_at: number;
  updated_at: number;
  last_checked_at: number | null;
}

const COLUMNS = `
  operation_id, schema_version, cluster, program_id, owner, vault,
  candidate_agent, signature, blockhash, last_valid_block_height,
  transfer_lamports, state, safe_error_code, created_at, updated_at,
  last_checked_at
`;

export class InvalidCandidateFundingRecordError extends Error {
  constructor() {
    super('Saved candidate funding operation is invalid');
    this.name = 'InvalidCandidateFundingRecordError';
  }
}

function fromRow(row: Row): CandidateFundingOperation {
  return validateCandidateFundingOperation({
    operationId: row.operation_id,
    schemaVersion: row.schema_version,
    cluster: row.cluster,
    programId: row.program_id,
    owner: row.owner,
    vault: row.vault,
    candidateAgent: row.candidate_agent,
    signature: row.signature,
    blockhash: row.blockhash,
    lastValidBlockHeight: row.last_valid_block_height,
    transferLamports: row.transfer_lamports,
    state: row.state,
    safeErrorCode: row.safe_error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastCheckedAt: row.last_checked_at,
  });
}

async function fromStoredRow(
  row: Row,
): Promise<CandidateFundingOperation> {
  try {
    return fromRow(row);
  } catch {
    await getDb().runAsync(
      `UPDATE agent_candidate_funding_operations
          SET state = 'invalid_local_record',
              safe_error_code = 'invalid_local_record',
              updated_at = CAST(strftime('%s', 'now') AS INTEGER)
        WHERE operation_id = ?`,
      [row.operation_id],
    );
    throw new InvalidCandidateFundingRecordError();
  }
}

export async function prepareCandidateFundingOperation(
  input: Parameters<typeof createPreparedCandidateFunding>[0],
): Promise<CandidateFundingOperation> {
  const record = createPreparedCandidateFunding(input);
  await getDb().runAsync(
    `INSERT INTO agent_candidate_funding_operations (${COLUMNS})
     VALUES (${Array.from({ length: 16 }, () => '?').join(', ')})`,
    [
      record.operationId,
      record.schemaVersion,
      record.cluster,
      record.programId,
      record.owner,
      record.vault,
      record.candidateAgent,
      record.signature,
      record.blockhash,
      record.lastValidBlockHeight,
      record.transferLamports,
      record.state,
      record.safeErrorCode,
      record.createdAt,
      record.updatedAt,
      record.lastCheckedAt,
    ],
  );
  return record;
}

export async function getUnresolvedCandidateFunding(
  identity: CandidateFundingIdentity,
): Promise<CandidateFundingOperation | null> {
  const rows = await getDb().getAllAsync<Row>(
    `SELECT ${COLUMNS}
       FROM agent_candidate_funding_operations
      WHERE cluster = ? AND program_id = ? AND owner = ? AND vault = ?
        AND candidate_agent = ?
      ORDER BY created_at DESC`,
    [
      identity.cluster,
      identity.programId,
      identity.owner,
      identity.vault,
      identity.candidateAgent,
    ],
  );
  for (const row of rows) {
    const record = await fromStoredRow(row);
    if (isUnresolvedCandidateFundingState(record.state)) return record;
  }
  return null;
}

export async function getUnresolvedCandidateFundingForVault(
  identity: Pick<
    CandidateFundingIdentity,
    'cluster' | 'programId' | 'owner' | 'vault'
  >,
): Promise<CandidateFundingOperation | null> {
  const rows = await getDb().getAllAsync<Row>(
    `SELECT ${COLUMNS}
       FROM agent_candidate_funding_operations
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
    const record = await fromStoredRow(row);
    if (isUnresolvedCandidateFundingState(record.state)) return record;
  }
  return null;
}

export async function transitionStoredCandidateFunding(
  signature: string,
  state: CandidateFundingOperationState,
  safeErrorCode: CandidateFundingErrorCode = null,
): Promise<CandidateFundingOperation> {
  const row = await getDb().getFirstAsync<Row>(
    `SELECT ${COLUMNS}
       FROM agent_candidate_funding_operations WHERE signature = ?`,
    [signature],
  );
  if (!row) throw new Error('Candidate funding operation not found');
  const next = transitionCandidateFunding(
    fromRow(row),
    state,
    Math.floor(Date.now() / 1000),
    safeErrorCode,
  );
  await getDb().runAsync(
    `UPDATE agent_candidate_funding_operations
        SET state = ?, safe_error_code = ?, updated_at = ?,
            last_checked_at = ?
      WHERE signature = ?`,
    [
      next.state,
      next.safeErrorCode,
      next.updatedAt,
      next.lastCheckedAt,
      signature,
    ],
  );
  return next;
}
