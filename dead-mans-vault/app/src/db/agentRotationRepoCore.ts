import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';

export const AGENT_ROTATION_SCHEMA_VERSION = 1;

export const AGENT_ROTATION_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS agent_rotation_operations (
    operation_id TEXT PRIMARY KEY NOT NULL,
    schema_version INTEGER NOT NULL,
    cluster TEXT NOT NULL,
    program_id TEXT NOT NULL,
    owner TEXT NOT NULL,
    vault TEXT NOT NULL,
    heartbeat TEXT NOT NULL,
    old_agent TEXT NOT NULL,
    candidate_agent TEXT NOT NULL,
    candidate_slot_id TEXT NOT NULL,
    signature TEXT NOT NULL UNIQUE,
    blockhash TEXT NOT NULL,
    last_valid_block_height INTEGER NOT NULL,
    before_last_heartbeat INTEGER NOT NULL,
    before_total_heartbeats TEXT NOT NULL,
    before_vault_updated_at INTEGER NOT NULL,
    before_final_deadline INTEGER NOT NULL,
    before_config_fingerprint TEXT NOT NULL,
    state TEXT NOT NULL,
    safe_error_code TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_checked_at INTEGER,
    resolved_agent TEXT,
    resolved_last_heartbeat INTEGER,
    resolved_vault_updated_at INTEGER
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_rotation_unresolved
    ON agent_rotation_operations(cluster, program_id, owner, vault)
    WHERE state IN (
      'prepared', 'submitted', 'submission_unknown',
      'confirmation_unknown', 'post_state_unverified',
      'rotation_confirmed', 'recovery_required'
    );

  CREATE INDEX IF NOT EXISTS idx_agent_rotation_updated
    ON agent_rotation_operations(updated_at DESC);
`;

export type AgentRotationOperationState =
  | 'prepared'
  | 'submitted'
  | 'submission_unknown'
  | 'confirmation_unknown'
  | 'post_state_unverified'
  | 'rotation_confirmed'
  | 'candidate_promoted'
  | 'resolved_failed'
  | 'resolved_not_landed'
  | 'resolved_rotated_unattributed'
  | 'recovery_required'
  | 'invalid_local_record';

export type AgentRotationErrorCode =
  | 'send_exception'
  | 'empty_rpc_signature'
  | 'rpc_signature_mismatch'
  | 'confirmation_exception'
  | 'confirmation_malformed'
  | 'transaction_failed'
  | 'status_rpc_unavailable'
  | 'status_malformed'
  | 'block_height_rpc_unavailable'
  | 'post_state_rpc_unavailable'
  | 'post_state_invalid'
  | 'promotion_failed'
  | 'identity_mismatch'
  | 'invalid_local_record'
  | null;

export interface AgentRotationIdentity {
  cluster: string;
  programId: string;
  owner: string;
  vault: string;
  heartbeat: string;
}

export interface AgentRotationOperationRecord
  extends AgentRotationIdentity {
  operationId: string;
  schemaVersion: number;
  oldAgent: string;
  candidateAgent: string;
  candidateSlotId: 'candidate';
  signature: string;
  blockhash: string;
  lastValidBlockHeight: number;
  beforeLastHeartbeat: number;
  beforeTotalHeartbeats: string;
  beforeVaultUpdatedAt: number;
  beforeFinalDeadline: number;
  beforeConfigFingerprint: string;
  state: AgentRotationOperationState;
  safeErrorCode: AgentRotationErrorCode;
  createdAt: number;
  updatedAt: number;
  lastCheckedAt: number | null;
  resolvedAgent: string | null;
  resolvedLastHeartbeat: number | null;
  resolvedVaultUpdatedAt: number | null;
}

export interface AgentRotationTransitionPatch {
  safeErrorCode?: AgentRotationErrorCode;
  lastCheckedAt?: number | null;
  resolvedAgent?: string | null;
  resolvedLastHeartbeat?: number | null;
  resolvedVaultUpdatedAt?: number | null;
}

export const BLOCKING_AGENT_ROTATION_STATES: ReadonlyArray<AgentRotationOperationState> = [
  'prepared',
  'submitted',
  'submission_unknown',
  'confirmation_unknown',
  'post_state_unverified',
  'rotation_confirmed',
  'recovery_required',
];

export const TERMINAL_AGENT_ROTATION_STATES: ReadonlyArray<AgentRotationOperationState> = [
  'candidate_promoted',
  'resolved_failed',
  'resolved_not_landed',
  'resolved_rotated_unattributed',
  'invalid_local_record',
];

const ALLOWED_TRANSITIONS: Record<
  AgentRotationOperationState,
  ReadonlyArray<AgentRotationOperationState>
> = {
  prepared: [
    'prepared',
    'submitted',
    'submission_unknown',
    'confirmation_unknown',
    'post_state_unverified',
    'rotation_confirmed',
    'candidate_promoted',
    'resolved_failed',
    'resolved_not_landed',
    'resolved_rotated_unattributed',
    'recovery_required',
    'invalid_local_record',
  ],
  submitted: [
    'submitted',
    'confirmation_unknown',
    'post_state_unverified',
    'rotation_confirmed',
    'candidate_promoted',
    'resolved_failed',
    'resolved_not_landed',
    'resolved_rotated_unattributed',
    'recovery_required',
    'invalid_local_record',
  ],
  submission_unknown: [
    'submission_unknown',
    'confirmation_unknown',
    'post_state_unverified',
    'rotation_confirmed',
    'candidate_promoted',
    'resolved_failed',
    'resolved_not_landed',
    'resolved_rotated_unattributed',
    'recovery_required',
    'invalid_local_record',
  ],
  confirmation_unknown: [
    'confirmation_unknown',
    'post_state_unverified',
    'rotation_confirmed',
    'candidate_promoted',
    'resolved_failed',
    'resolved_not_landed',
    'resolved_rotated_unattributed',
    'recovery_required',
    'invalid_local_record',
  ],
  post_state_unverified: [
    'post_state_unverified',
    'rotation_confirmed',
    'candidate_promoted',
    'resolved_failed',
    'resolved_not_landed',
    'resolved_rotated_unattributed',
    'recovery_required',
    'invalid_local_record',
  ],
  rotation_confirmed: [
    'rotation_confirmed',
    'candidate_promoted',
    'recovery_required',
    'invalid_local_record',
  ],
  recovery_required: [
    'recovery_required',
    'candidate_promoted',
    'resolved_rotated_unattributed',
    'invalid_local_record',
  ],
  candidate_promoted: [],
  resolved_failed: [],
  resolved_not_landed: [],
  resolved_rotated_unattributed: [],
  invalid_local_record: [],
};

function isSafeNonNegativeInteger(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}

function isPublicKey(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 64) return false;
  try {
    return new PublicKey(value).toBase58() === value;
  } catch {
    return false;
  }
}

function isSignature(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 100) return false;
  try {
    return bs58.decode(value).length === 64;
  } catch {
    return false;
  }
}

function isBlockhash(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 64) return false;
  try {
    return bs58.decode(value).length === 32;
  } catch {
    return false;
  }
}

function isU64(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9][0-9]{0,19})$/.test(value)
  ) {
    return false;
  }
  try {
    const parsed = BigInt(value);
    return parsed <= 18_446_744_073_709_551_615n;
  } catch {
    return false;
  }
}

function isState(value: unknown): value is AgentRotationOperationState {
  return (
    typeof value === 'string' &&
    (
      (
        BLOCKING_AGENT_ROTATION_STATES as ReadonlyArray<string>
      ).includes(value) ||
      (
        TERMINAL_AGENT_ROTATION_STATES as ReadonlyArray<string>
      ).includes(value)
    )
  );
}

function isErrorCode(value: unknown): value is AgentRotationErrorCode {
  return (
    value === null ||
    value === 'send_exception' ||
    value === 'empty_rpc_signature' ||
    value === 'rpc_signature_mismatch' ||
    value === 'confirmation_exception' ||
    value === 'confirmation_malformed' ||
    value === 'transaction_failed' ||
    value === 'status_rpc_unavailable' ||
    value === 'status_malformed' ||
    value === 'block_height_rpc_unavailable' ||
    value === 'post_state_rpc_unavailable' ||
    value === 'post_state_invalid' ||
    value === 'promotion_failed' ||
    value === 'identity_mismatch' ||
    value === 'invalid_local_record'
  );
}

export function isBlockingAgentRotationState(
  state: AgentRotationOperationState,
): boolean {
  return BLOCKING_AGENT_ROTATION_STATES.includes(state);
}

export function validateAgentRotationRecord(
  record: AgentRotationOperationRecord,
): AgentRotationOperationRecord {
  if (record.schemaVersion !== AGENT_ROTATION_SCHEMA_VERSION) {
    throw new Error('Unsupported agent rotation schema version');
  }
  if (record.cluster !== 'devnet') {
    throw new Error('Agent rotation journal is devnet-only');
  }
  for (const [name, value] of [
    ['program', record.programId],
    ['owner', record.owner],
    ['vault', record.vault],
    ['heartbeat', record.heartbeat],
    ['old agent', record.oldAgent],
    ['candidate agent', record.candidateAgent],
  ] as const) {
    if (!isPublicKey(value)) {
      throw new Error(`Invalid agent rotation ${name}`);
    }
  }
  if (
    record.oldAgent === record.candidateAgent ||
    record.owner === record.candidateAgent
  ) {
    throw new Error('Invalid agent rotation authority relationship');
  }
  if (record.candidateSlotId !== 'candidate') {
    throw new Error('Invalid candidate key slot');
  }
  if (
    !isSignature(record.signature) ||
    record.operationId !== record.signature
  ) {
    throw new Error('Invalid agent rotation signature');
  }
  if (!isBlockhash(record.blockhash)) {
    throw new Error('Invalid agent rotation blockhash');
  }
  for (const [name, value] of [
    ['last-valid block height', record.lastValidBlockHeight],
    ['pre-rotation heartbeat', record.beforeLastHeartbeat],
    ['pre-rotation vault update', record.beforeVaultUpdatedAt],
    ['pre-rotation final deadline', record.beforeFinalDeadline],
    ['created timestamp', record.createdAt],
    ['updated timestamp', record.updatedAt],
  ] as const) {
    if (!isSafeNonNegativeInteger(value)) {
      throw new Error(`Invalid agent rotation ${name}`);
    }
  }
  if (
    record.lastCheckedAt !== null &&
    !isSafeNonNegativeInteger(record.lastCheckedAt)
  ) {
    throw new Error('Invalid rotation last-checked timestamp');
  }
  if (
    record.resolvedLastHeartbeat !== null &&
    !isSafeNonNegativeInteger(record.resolvedLastHeartbeat)
  ) {
    throw new Error('Invalid resolved heartbeat timestamp');
  }
  if (
    record.resolvedVaultUpdatedAt !== null &&
    !isSafeNonNegativeInteger(record.resolvedVaultUpdatedAt)
  ) {
    throw new Error('Invalid resolved vault update timestamp');
  }
  if (
    record.resolvedAgent !== null &&
    !isPublicKey(record.resolvedAgent)
  ) {
    throw new Error('Invalid resolved agent');
  }
  if (!isU64(record.beforeTotalHeartbeats)) {
    throw new Error('Invalid pre-rotation heartbeat count');
  }
  if (
    !/^[0-9a-f]{64}$/.test(record.beforeConfigFingerprint)
  ) {
    throw new Error('Invalid vault configuration fingerprint');
  }
  if (!isState(record.state) || !isErrorCode(record.safeErrorCode)) {
    throw new Error('Invalid agent rotation state');
  }
  return record;
}

export function createPreparedAgentRotation(
  input: Omit<
    AgentRotationOperationRecord,
    | 'operationId'
    | 'schemaVersion'
    | 'candidateSlotId'
    | 'state'
    | 'safeErrorCode'
    | 'lastCheckedAt'
    | 'resolvedAgent'
    | 'resolvedLastHeartbeat'
    | 'resolvedVaultUpdatedAt'
  >,
): AgentRotationOperationRecord {
  return validateAgentRotationRecord({
    ...input,
    operationId: input.signature,
    schemaVersion: AGENT_ROTATION_SCHEMA_VERSION,
    candidateSlotId: 'candidate',
    state: 'prepared',
    safeErrorCode: null,
    lastCheckedAt: null,
    resolvedAgent: null,
    resolvedLastHeartbeat: null,
    resolvedVaultUpdatedAt: null,
  });
}

export function transitionAgentRotation(
  record: AgentRotationOperationRecord,
  state: AgentRotationOperationState,
  nowSeconds: number,
  patch: AgentRotationTransitionPatch = {},
): AgentRotationOperationRecord {
  if (!ALLOWED_TRANSITIONS[record.state].includes(state)) {
    throw new Error(
      `Invalid agent rotation transition ${record.state} -> ${state}`,
    );
  }
  return validateAgentRotationRecord({
    ...record,
    ...patch,
    state,
    updatedAt: nowSeconds,
  });
}
