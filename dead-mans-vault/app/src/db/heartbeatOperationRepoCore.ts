import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import type { HeartbeatMethod } from '../types/heartbeat';

export const HEARTBEAT_OPERATION_SCHEMA_VERSION = 1;

export const HEARTBEAT_OPERATION_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS heartbeat_operations (
    operation_id TEXT PRIMARY KEY NOT NULL,
    schema_version INTEGER NOT NULL,
    cluster TEXT NOT NULL,
    program_id TEXT NOT NULL,
    owner TEXT NOT NULL,
    vault TEXT NOT NULL,
    heartbeat TEXT NOT NULL,
    agent_pubkey TEXT NOT NULL,
    method TEXT NOT NULL,
    method_index INTEGER NOT NULL,
    signature TEXT NOT NULL UNIQUE,
    blockhash TEXT NOT NULL,
    last_valid_block_height INTEGER NOT NULL,
    before_last_heartbeat INTEGER NOT NULL,
    before_total_heartbeats TEXT NOT NULL,
    heartbeat_interval INTEGER NOT NULL,
    grace_period INTEGER NOT NULL,
    state TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_checked_at INTEGER,
    resolved_last_heartbeat INTEGER,
    resolved_total_heartbeats TEXT,
    local_sync_state TEXT NOT NULL,
    safe_error_code TEXT
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_heartbeat_operation_unresolved
    ON heartbeat_operations(cluster, program_id, owner, vault)
    WHERE state IN (
      'prepared', 'submitted', 'submission_unknown',
      'confirmation_unknown', 'post_state_unverified'
    );

  CREATE INDEX IF NOT EXISTS idx_heartbeat_operation_updated
    ON heartbeat_operations(updated_at DESC);
`;

export const HEARTBEAT_METHOD_INDEX: Record<HeartbeatMethod, number> = {
  active_tap: 0,
  biometric_confirm: 1,
  on_chain_activity: 2,
  pin_challenge: 3,
  hardware_switch: 4,
};

export type HeartbeatOperationState =
  | 'prepared'
  | 'submitted'
  | 'submission_unknown'
  | 'confirmation_unknown'
  | 'post_state_unverified'
  | 'confirmed_local_sync_pending'
  | 'resolved_confirmed'
  | 'resolved_failed'
  | 'resolved_expired_not_landed'
  | 'resolved_chain_advanced_unattributed'
  | 'invalid_local_record';

export type HeartbeatOperationLocalSyncState =
  | 'not_started'
  | 'pending'
  | 'complete'
  | 'not_applicable';

export type HeartbeatOperationErrorCode =
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
  | 'post_state_not_advanced'
  | 'local_sync_failed'
  | 'identity_mismatch'
  | 'invalid_local_record'
  | null;

export interface HeartbeatOperationIdentity {
  cluster: string;
  programId: string;
  owner: string;
  vault: string;
  heartbeat: string;
  agentPubkey: string;
}

export interface PreparedHeartbeatOperation
  extends HeartbeatOperationIdentity {
  operationId: string;
  schemaVersion: number;
  method: HeartbeatMethod;
  methodIndex: number;
  signature: string;
  blockhash: string;
  lastValidBlockHeight: number;
  beforeLastHeartbeat: number;
  beforeTotalHeartbeats: string;
  heartbeatInterval: number;
  gracePeriod: number;
  state: 'prepared';
  createdAt: number;
  updatedAt: number;
  lastCheckedAt: number | null;
  resolvedLastHeartbeat: number | null;
  resolvedTotalHeartbeats: string | null;
  localSyncState: HeartbeatOperationLocalSyncState;
  safeErrorCode: HeartbeatOperationErrorCode;
}

export interface HeartbeatOperationRecord
  extends Omit<PreparedHeartbeatOperation, 'state'> {
  state: HeartbeatOperationState;
}

export interface HeartbeatOperationTransitionPatch {
  lastCheckedAt?: number | null;
  resolvedLastHeartbeat?: number | null;
  resolvedTotalHeartbeats?: string | null;
  localSyncState?: HeartbeatOperationLocalSyncState;
  safeErrorCode?: HeartbeatOperationErrorCode;
}

export const UNRESOLVED_HEARTBEAT_OPERATION_STATES: ReadonlyArray<HeartbeatOperationState> = [
  'prepared',
  'submitted',
  'submission_unknown',
  'confirmation_unknown',
  'post_state_unverified',
  'confirmed_local_sync_pending',
];

export const BLOCKING_HEARTBEAT_OPERATION_STATES: ReadonlyArray<HeartbeatOperationState> = [
  'prepared',
  'submitted',
  'submission_unknown',
  'confirmation_unknown',
  'post_state_unverified',
];

export const TERMINAL_HEARTBEAT_OPERATION_STATES: ReadonlyArray<HeartbeatOperationState> = [
  'resolved_confirmed',
  'resolved_failed',
  'resolved_expired_not_landed',
  'resolved_chain_advanced_unattributed',
  'invalid_local_record',
];

const ALLOWED_TRANSITIONS: Record<
  HeartbeatOperationState,
  ReadonlyArray<HeartbeatOperationState>
> = {
  prepared: [
    'prepared',
    'submitted',
    'submission_unknown',
    'confirmation_unknown',
    'post_state_unverified',
    'confirmed_local_sync_pending',
    'resolved_confirmed',
    'resolved_failed',
    'resolved_expired_not_landed',
    'resolved_chain_advanced_unattributed',
    'invalid_local_record',
  ],
  submitted: [
    'submitted',
    'confirmation_unknown',
    'post_state_unverified',
    'confirmed_local_sync_pending',
    'resolved_confirmed',
    'resolved_failed',
    'resolved_expired_not_landed',
    'resolved_chain_advanced_unattributed',
    'invalid_local_record',
  ],
  submission_unknown: [
    'submission_unknown',
    'confirmation_unknown',
    'post_state_unverified',
    'confirmed_local_sync_pending',
    'resolved_confirmed',
    'resolved_failed',
    'resolved_expired_not_landed',
    'resolved_chain_advanced_unattributed',
    'invalid_local_record',
  ],
  confirmation_unknown: [
    'confirmation_unknown',
    'post_state_unverified',
    'confirmed_local_sync_pending',
    'resolved_confirmed',
    'resolved_failed',
    'resolved_expired_not_landed',
    'resolved_chain_advanced_unattributed',
    'invalid_local_record',
  ],
  post_state_unverified: [
    'post_state_unverified',
    'confirmed_local_sync_pending',
    'resolved_confirmed',
    'resolved_failed',
    'resolved_expired_not_landed',
    'resolved_chain_advanced_unattributed',
    'invalid_local_record',
  ],
  confirmed_local_sync_pending: [
    'confirmed_local_sync_pending',
    'resolved_confirmed',
    'invalid_local_record',
  ],
  resolved_confirmed: [],
  resolved_failed: [],
  resolved_expired_not_landed: [],
  resolved_chain_advanced_unattributed: [],
  invalid_local_record: [],
};

function isSafeNonNegativeInteger(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}

function isCanonicalPublicKey(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 64) return false;
  try {
    return new PublicKey(value).toBase58() === value;
  } catch {
    return false;
  }
}

function isTransactionSignature(value: unknown): value is string {
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

function isU64Decimal(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9][0-9]{0,19})$/.test(value)
  ) {
    return false;
  }
  try {
    const parsed = BigInt(value);
    return parsed >= 0n && parsed <= 18_446_744_073_709_551_615n;
  } catch {
    return false;
  }
}

function isState(value: unknown): value is HeartbeatOperationState {
  return (
    typeof value === 'string' &&
    (
      (
        UNRESOLVED_HEARTBEAT_OPERATION_STATES as ReadonlyArray<string>
      ).includes(value) ||
      (
        TERMINAL_HEARTBEAT_OPERATION_STATES as ReadonlyArray<string>
      ).includes(value)
    )
  );
}

function isLocalSyncState(
  value: unknown,
): value is HeartbeatOperationLocalSyncState {
  return (
    value === 'not_started' ||
    value === 'pending' ||
    value === 'complete' ||
    value === 'not_applicable'
  );
}

function isSafeErrorCode(
  value: unknown,
): value is HeartbeatOperationErrorCode {
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
    value === 'post_state_not_advanced' ||
    value === 'local_sync_failed' ||
    value === 'identity_mismatch' ||
    value === 'invalid_local_record'
  );
}

export function isUnresolvedHeartbeatOperationState(
  state: HeartbeatOperationState,
): boolean {
  return UNRESOLVED_HEARTBEAT_OPERATION_STATES.includes(state);
}

export function isBlockingHeartbeatOperationState(
  state: HeartbeatOperationState,
): boolean {
  return BLOCKING_HEARTBEAT_OPERATION_STATES.includes(state);
}

export function heartbeatOperationIdentityKey(
  identity: HeartbeatOperationIdentity,
): string {
  return [
    identity.cluster,
    identity.programId,
    identity.owner,
    identity.vault,
  ].join(':');
}

export function validateHeartbeatOperationRecord(
  value: HeartbeatOperationRecord,
): HeartbeatOperationRecord {
  if (value.schemaVersion !== HEARTBEAT_OPERATION_SCHEMA_VERSION) {
    throw new Error('Unsupported heartbeat operation schema version');
  }
  if (value.cluster !== 'devnet' && value.cluster !== 'mainnet-beta') {
    throw new Error('Invalid heartbeat operation cluster');
  }
  for (const [name, publicKey] of [
    ['program', value.programId],
    ['owner', value.owner],
    ['vault', value.vault],
    ['heartbeat', value.heartbeat],
    ['agent', value.agentPubkey],
  ] as const) {
    if (!isCanonicalPublicKey(publicKey)) {
      throw new Error(`Invalid heartbeat operation ${name} public key`);
    }
  }
  if (!isTransactionSignature(value.signature)) {
    throw new Error('Invalid heartbeat operation signature');
  }
  if (value.operationId !== value.signature) {
    throw new Error('Heartbeat operation ID must equal its signature');
  }
  if (!isBlockhash(value.blockhash)) {
    throw new Error('Invalid heartbeat operation blockhash');
  }
  if (
    !Object.prototype.hasOwnProperty.call(
      HEARTBEAT_METHOD_INDEX,
      value.method,
    ) ||
    HEARTBEAT_METHOD_INDEX[value.method] !== value.methodIndex
  ) {
    throw new Error('Heartbeat operation method/index mismatch');
  }
  for (const [name, numberValue] of [
    ['last-valid block height', value.lastValidBlockHeight],
    ['before heartbeat timestamp', value.beforeLastHeartbeat],
    ['heartbeat interval', value.heartbeatInterval],
    ['grace period', value.gracePeriod],
    ['created timestamp', value.createdAt],
    ['updated timestamp', value.updatedAt],
  ] as const) {
    if (!isSafeNonNegativeInteger(numberValue)) {
      throw new Error(`Invalid heartbeat operation ${name}`);
    }
  }
  if (
    value.lastCheckedAt !== null &&
    !isSafeNonNegativeInteger(value.lastCheckedAt)
  ) {
    throw new Error('Invalid heartbeat operation last-checked timestamp');
  }
  if (
    value.resolvedLastHeartbeat !== null &&
    !isSafeNonNegativeInteger(value.resolvedLastHeartbeat)
  ) {
    throw new Error('Invalid resolved heartbeat timestamp');
  }
  if (!isU64Decimal(value.beforeTotalHeartbeats)) {
    throw new Error('Invalid pre-heartbeat count');
  }
  if (
    value.resolvedTotalHeartbeats !== null &&
    !isU64Decimal(value.resolvedTotalHeartbeats)
  ) {
    throw new Error('Invalid resolved heartbeat count');
  }
  if (!isState(value.state)) {
    throw new Error('Invalid heartbeat operation state');
  }
  if (!isLocalSyncState(value.localSyncState)) {
    throw new Error('Invalid heartbeat operation local sync state');
  }
  if (!isSafeErrorCode(value.safeErrorCode)) {
    throw new Error('Invalid heartbeat operation safe error code');
  }
  return value;
}

export function createPreparedHeartbeatOperation(
  input: Omit<
    PreparedHeartbeatOperation,
    | 'operationId'
    | 'schemaVersion'
    | 'state'
    | 'lastCheckedAt'
    | 'resolvedLastHeartbeat'
    | 'resolvedTotalHeartbeats'
    | 'localSyncState'
    | 'safeErrorCode'
  >,
): PreparedHeartbeatOperation {
  const record: PreparedHeartbeatOperation = {
    ...input,
    operationId: input.signature,
    schemaVersion: HEARTBEAT_OPERATION_SCHEMA_VERSION,
    state: 'prepared',
    lastCheckedAt: null,
    resolvedLastHeartbeat: null,
    resolvedTotalHeartbeats: null,
    localSyncState: 'not_started',
    safeErrorCode: null,
  };
  validateHeartbeatOperationRecord(record);
  return record;
}

export function transitionHeartbeatOperation(
  record: HeartbeatOperationRecord,
  nextState: HeartbeatOperationState,
  updatedAt: number,
  patch: HeartbeatOperationTransitionPatch = {},
): HeartbeatOperationRecord {
  validateHeartbeatOperationRecord(record);
  if (!ALLOWED_TRANSITIONS[record.state].includes(nextState)) {
    throw new Error(
      `Invalid heartbeat operation transition ${record.state} -> ${nextState}`,
    );
  }
  const next: HeartbeatOperationRecord = {
    ...record,
    ...patch,
    state: nextState,
    updatedAt,
  };
  return validateHeartbeatOperationRecord(next);
}
