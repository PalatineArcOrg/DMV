import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import bs58 from 'bs58';
import { Keypair } from '@solana/web3.js';
import {
  HEARTBEAT_OPERATION_SCHEMA_SQL,
  createPreparedHeartbeatOperation,
  isUnresolvedHeartbeatOperationState,
  transitionHeartbeatOperation,
  validateHeartbeatOperationRecord,
} from './heartbeatOperationRepoCore.ts';

function signature(fill: number): string {
  return bs58.encode(Buffer.alloc(64, fill));
}

function blockhash(fill: number): string {
  return bs58.encode(Buffer.alloc(32, fill));
}

function prepared(overrides: Record<string, unknown> = {}) {
  const programId = Keypair.generate().publicKey.toBase58();
  const owner = Keypair.generate().publicKey.toBase58();
  const vault = Keypair.generate().publicKey.toBase58();
  const heartbeat = Keypair.generate().publicKey.toBase58();
  const agentPubkey = Keypair.generate().publicKey.toBase58();
  return createPreparedHeartbeatOperation({
    cluster: 'devnet',
    programId,
    owner,
    vault,
    heartbeat,
    agentPubkey,
    method: 'active_tap',
    methodIndex: 0,
    signature: signature(1),
    blockhash: blockhash(2),
    lastValidBlockHeight: 200,
    beforeLastHeartbeat: 100,
    beforeTotalHeartbeats: '18446744073709551614',
    heartbeatInterval: 86_400,
    gracePeriod: 604_800,
    createdAt: 10,
    updatedAt: 10,
    ...overrides,
  });
}

function values(record: ReturnType<typeof prepared>) {
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

const INSERT = `INSERT INTO heartbeat_operations VALUES (
  ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
)`;

test('valid journal operation round-trips through an isolated reopened SQLite database with full u64 precision', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dmv-heartbeat-journal-'));
  const path = join(directory, 'journal.sqlite');
  const record = prepared();
  try {
    const first = new DatabaseSync(path);
    first.exec(HEARTBEAT_OPERATION_SCHEMA_SQL);
    first.prepare(INSERT).run(...values(record));
    first.close();

    const reopened = new DatabaseSync(path);
    const row = reopened.prepare(
      'SELECT * FROM heartbeat_operations WHERE signature = ?',
    ).get(record.signature) as Record<string, unknown>;
    reopened.close();
    assert.equal(
      row.before_total_heartbeats,
      '18446744073709551614',
    );
    assert.equal(row.state, 'prepared');
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test('signature uniqueness and one-unresolved-operation-per-identity are enforced by SQLite', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(HEARTBEAT_OPERATION_SCHEMA_SQL);
  const first = prepared();
  db.prepare(INSERT).run(...values(first));
  assert.throws(() => db.prepare(INSERT).run(...values(first)));

  const second = prepared({
    programId: first.programId,
    owner: first.owner,
    vault: first.vault,
    heartbeat: first.heartbeat,
    agentPubkey: first.agentPubkey,
    signature: signature(3),
    blockhash: blockhash(4),
  });
  assert.throws(() => db.prepare(INSERT).run(...values(second)));
  db.close();
});

test('terminal operation does not block a new unresolved operation for the identity', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(HEARTBEAT_OPERATION_SCHEMA_SQL);
  const first = prepared();
  db.prepare(INSERT).run(...values(first));
  db.prepare(
    `UPDATE heartbeat_operations
        SET state = 'resolved_failed' WHERE signature = ?`,
  ).run(first.signature);
  const second = prepared({
    programId: first.programId,
    owner: first.owner,
    vault: first.vault,
    heartbeat: first.heartbeat,
    agentPubkey: first.agentPubkey,
    signature: signature(5),
    blockhash: blockhash(6),
  });
  db.prepare(INSERT).run(...values(second));
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM heartbeat_operations')
      .get().count,
    2,
  );
  db.close();
});

test('confirmed local-sync repair does not block a future heartbeat submission record', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(HEARTBEAT_OPERATION_SCHEMA_SQL);
  const first = prepared();
  db.prepare(INSERT).run(...values(first));
  db.prepare(
    `UPDATE heartbeat_operations
        SET state = 'confirmed_local_sync_pending',
            resolved_last_heartbeat = 101,
            resolved_total_heartbeats = '5',
            local_sync_state = 'pending'
      WHERE signature = ?`,
  ).run(first.signature);
  const second = prepared({
    programId: first.programId,
    owner: first.owner,
    vault: first.vault,
    heartbeat: first.heartbeat,
    agentPubkey: first.agentPubkey,
    signature: signature(40),
    blockhash: blockhash(41),
  });
  db.prepare(INSERT).run(...values(second));
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM heartbeat_operations')
      .get().count,
    2,
  );
  db.close();
});

test('state machine rejects impossible transitions and accepts recoverable ones', () => {
  const record = prepared();
  const submitted = transitionHeartbeatOperation(
    record,
    'submitted',
    11,
  );
  assert.equal(isUnresolvedHeartbeatOperationState(submitted.state), true);
  const resolved = transitionHeartbeatOperation(
    submitted,
    'resolved_failed',
    12,
  );
  assert.equal(isUnresolvedHeartbeatOperationState(resolved.state), false);
  assert.throws(
    () => transitionHeartbeatOperation(resolved, 'submitted', 13),
    /Invalid heartbeat operation transition/,
  );
});

test('schema, key, signature, number, and method/index validation fail closed', () => {
  const record = prepared();
  const invalidRecords = [
    { ...record, schemaVersion: 99 },
    { ...record, owner: 'not-a-public-key' },
    { ...record, signature: 'not-a-signature', operationId: 'not-a-signature' },
    { ...record, lastValidBlockHeight: Number.MAX_SAFE_INTEGER + 1 },
    { ...record, methodIndex: 3 },
    { ...record, beforeTotalHeartbeats: '18446744073709551616' },
  ];
  for (const invalid of invalidRecords) {
    assert.throws(() => validateHeartbeatOperationRecord(invalid));
  }
});

test('bounded terminal pruning never removes unresolved evidence', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(HEARTBEAT_OPERATION_SCHEMA_SQL);
  const active = prepared();
  db.prepare(INSERT).run(...values(active));
  for (let index = 0; index < 4; index += 1) {
    const terminal = prepared({
      programId: active.programId,
      owner: active.owner,
      vault: `${Keypair.generate().publicKey.toBase58()}`,
      signature: signature(10 + index),
      blockhash: blockhash(20 + index),
      createdAt: index,
      updatedAt: index,
    });
    const terminalValues = values(terminal);
    terminalValues[17] = 'resolved_failed';
    db.prepare(INSERT).run(...terminalValues);
  }
  db.prepare(
    `DELETE FROM heartbeat_operations WHERE operation_id IN (
       SELECT operation_id FROM heartbeat_operations
        WHERE state IN (
          'resolved_confirmed', 'resolved_failed',
          'resolved_expired_not_landed',
          'resolved_chain_advanced_unattributed',
          'invalid_local_record'
        )
        ORDER BY updated_at DESC LIMIT -1 OFFSET 2
     )`,
  ).run();
  assert.equal(
    db.prepare(
      `SELECT COUNT(*) AS count FROM heartbeat_operations
        WHERE state = 'prepared'`,
    ).get().count,
    1,
  );
  assert.equal(
    db.prepare(
      `SELECT COUNT(*) AS count FROM heartbeat_operations
        WHERE state = 'resolved_failed'`,
    ).get().count,
    2,
  );
  db.close();
});

test('journal schema has explicit fields and no secret-bearing or raw-transaction columns', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(HEARTBEAT_OPERATION_SCHEMA_SQL);
  const columns = db.prepare(
    'PRAGMA table_info(heartbeat_operations)',
  ).all().map((row) => row.name);
  for (const required of [
    'signature',
    'blockhash',
    'last_valid_block_height',
    'before_total_heartbeats',
    'state',
    'safe_error_code',
  ]) {
    assert.equal(columns.includes(required), true);
  }
  for (const prohibited of [
    'private_key',
    'secret_key',
    'seed',
    'raw_transaction',
    'signed_transaction',
    'rpc_url',
    'notification_token',
  ]) {
    assert.equal(columns.includes(prohibited), false);
  }
  db.close();
});
