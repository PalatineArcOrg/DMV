import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';

export const AGENT_CANDIDATE_FUNDING_SCHEMA_VERSION = 1;

export const AGENT_CANDIDATE_FUNDING_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS agent_candidate_funding_operations (
    operation_id TEXT PRIMARY KEY NOT NULL,
    schema_version INTEGER NOT NULL,
    cluster TEXT NOT NULL,
    program_id TEXT NOT NULL,
    owner TEXT NOT NULL,
    vault TEXT NOT NULL,
    candidate_agent TEXT NOT NULL,
    signature TEXT NOT NULL UNIQUE,
    blockhash TEXT NOT NULL,
    last_valid_block_height INTEGER NOT NULL,
    transfer_lamports INTEGER NOT NULL,
    state TEXT NOT NULL,
    safe_error_code TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_checked_at INTEGER
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_candidate_funding_unresolved
    ON agent_candidate_funding_operations(
      cluster, program_id, owner, vault, candidate_agent
    )
    WHERE state IN (
      'prepared', 'submitted', 'submission_unknown',
      'confirmation_unknown'
    );
`;

export type CandidateFundingOperationState =
  | 'prepared'
  | 'submitted'
  | 'submission_unknown'
  | 'confirmation_unknown'
  | 'resolved_confirmed'
  | 'resolved_failed'
  | 'resolved_expired'
  | 'invalid_local_record';

export type CandidateFundingErrorCode =
  | 'send_exception'
  | 'rpc_signature_mismatch'
  | 'confirmation_exception'
  | 'confirmation_malformed'
  | 'transaction_failed'
  | 'status_rpc_unavailable'
  | 'status_malformed'
  | 'block_height_rpc_unavailable'
  | 'invalid_local_record'
  | null;

export interface CandidateFundingIdentity {
  cluster: string;
  programId: string;
  owner: string;
  vault: string;
  candidateAgent: string;
}

export interface CandidateFundingOperation
  extends CandidateFundingIdentity {
  operationId: string;
  schemaVersion: number;
  signature: string;
  blockhash: string;
  lastValidBlockHeight: number;
  transferLamports: number;
  state: CandidateFundingOperationState;
  safeErrorCode: CandidateFundingErrorCode;
  createdAt: number;
  updatedAt: number;
  lastCheckedAt: number | null;
}

export const UNRESOLVED_CANDIDATE_FUNDING_STATES: ReadonlyArray<CandidateFundingOperationState> = [
  'prepared',
  'submitted',
  'submission_unknown',
  'confirmation_unknown',
];

const TRANSITIONS: Record<
  CandidateFundingOperationState,
  ReadonlyArray<CandidateFundingOperationState>
> = {
  prepared: [
    'prepared',
    'submitted',
    'submission_unknown',
    'confirmation_unknown',
    'resolved_confirmed',
    'resolved_failed',
    'resolved_expired',
    'invalid_local_record',
  ],
  submitted: [
    'submitted',
    'confirmation_unknown',
    'resolved_confirmed',
    'resolved_failed',
    'resolved_expired',
    'invalid_local_record',
  ],
  submission_unknown: [
    'submission_unknown',
    'confirmation_unknown',
    'resolved_confirmed',
    'resolved_failed',
    'resolved_expired',
    'invalid_local_record',
  ],
  confirmation_unknown: [
    'confirmation_unknown',
    'resolved_confirmed',
    'resolved_failed',
    'resolved_expired',
    'invalid_local_record',
  ],
  resolved_confirmed: [],
  resolved_failed: [],
  resolved_expired: [],
  invalid_local_record: [],
};

function isPublicKey(value: string): boolean {
  try {
    return new PublicKey(value).toBase58() === value;
  } catch {
    return false;
  }
}

function isBytes(value: string, length: number): boolean {
  try {
    return bs58.decode(value).length === length;
  } catch {
    return false;
  }
}

function safeInteger(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}

function isErrorCode(
  value: unknown,
): value is CandidateFundingErrorCode {
  return (
    value === null ||
    value === 'send_exception' ||
    value === 'rpc_signature_mismatch' ||
    value === 'confirmation_exception' ||
    value === 'confirmation_malformed' ||
    value === 'transaction_failed' ||
    value === 'status_rpc_unavailable' ||
    value === 'status_malformed' ||
    value === 'block_height_rpc_unavailable' ||
    value === 'invalid_local_record'
  );
}

export function isUnresolvedCandidateFundingState(
  state: CandidateFundingOperationState,
): boolean {
  return UNRESOLVED_CANDIDATE_FUNDING_STATES.includes(state);
}

export function validateCandidateFundingOperation(
  record: CandidateFundingOperation,
): CandidateFundingOperation {
  if (
    record.schemaVersion !==
      AGENT_CANDIDATE_FUNDING_SCHEMA_VERSION ||
    record.cluster !== 'devnet'
  ) {
    throw new Error('Invalid candidate funding schema or cluster');
  }
  for (const value of [
    record.programId,
    record.owner,
    record.vault,
    record.candidateAgent,
  ]) {
    if (!isPublicKey(value)) {
      throw new Error('Invalid candidate funding identity');
    }
  }
  if (
    !isBytes(record.signature, 64) ||
    record.operationId !== record.signature ||
    !isBytes(record.blockhash, 32)
  ) {
    throw new Error('Invalid candidate funding transaction identity');
  }
  for (const value of [
    record.lastValidBlockHeight,
    record.transferLamports,
    record.createdAt,
    record.updatedAt,
  ]) {
    if (!safeInteger(value)) {
      throw new Error('Invalid candidate funding numeric field');
    }
  }
  if (
    record.lastCheckedAt !== null &&
    !safeInteger(record.lastCheckedAt)
  ) {
    throw new Error('Invalid candidate funding check timestamp');
  }
  if (
    !Object.prototype.hasOwnProperty.call(TRANSITIONS, record.state) ||
    !isErrorCode(record.safeErrorCode)
  ) {
    throw new Error('Invalid candidate funding state');
  }
  return record;
}

export function createPreparedCandidateFunding(
  input: Omit<
    CandidateFundingOperation,
    | 'operationId'
    | 'schemaVersion'
    | 'state'
    | 'safeErrorCode'
    | 'lastCheckedAt'
  >,
): CandidateFundingOperation {
  return validateCandidateFundingOperation({
    ...input,
    operationId: input.signature,
    schemaVersion: AGENT_CANDIDATE_FUNDING_SCHEMA_VERSION,
    state: 'prepared',
    safeErrorCode: null,
    lastCheckedAt: null,
  });
}

export function transitionCandidateFunding(
  record: CandidateFundingOperation,
  state: CandidateFundingOperationState,
  nowSeconds: number,
  safeErrorCode: CandidateFundingErrorCode = record.safeErrorCode,
): CandidateFundingOperation {
  if (!TRANSITIONS[record.state].includes(state)) {
    throw new Error(
      `Invalid candidate funding transition ${record.state} -> ${state}`,
    );
  }
  return validateCandidateFundingOperation({
    ...record,
    state,
    safeErrorCode,
    updatedAt: nowSeconds,
    lastCheckedAt: nowSeconds,
  });
}
