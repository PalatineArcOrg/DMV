import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import {
  AGENT_ROTATION_SCHEMA_SQL,
  createPreparedAgentRotation,
  transitionAgentRotation,
  validateAgentRotationRecord,
} from './agentRotationRepoCore.ts';

function signature(fill: number): string {
  return bs58.encode(Buffer.alloc(64, fill));
}

function blockhash(fill: number): string {
  return bs58.encode(Buffer.alloc(32, fill));
}

function prepared(overrides: Record<string, unknown> = {}) {
  return createPreparedAgentRotation({
    cluster: 'devnet',
    programId: Keypair.generate().publicKey.toBase58(),
    owner: Keypair.generate().publicKey.toBase58(),
    vault: Keypair.generate().publicKey.toBase58(),
    heartbeat: Keypair.generate().publicKey.toBase58(),
    oldAgent: Keypair.generate().publicKey.toBase58(),
    candidateAgent: Keypair.generate().publicKey.toBase58(),
    signature: signature(1),
    blockhash: blockhash(2),
    lastValidBlockHeight: 900,
    beforeLastHeartbeat: 100,
    beforeTotalHeartbeats: '18446744073709551614',
    beforeVaultUpdatedAt: 90,
    beforeFinalDeadline: 1_000,
    beforeConfigFingerprint: 'ab'.repeat(32),
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

const INSERT = `INSERT INTO agent_rotation_operations VALUES (
  ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
  ?, ?, ?, ?
)`;

test('rotation journal survives SQLite reopen and preserves full u64 precision', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dmv-rotation-'));
  const path = join(directory, 'rotation.sqlite');
  const record = prepared();
  try {
    const first = new DatabaseSync(path);
    first.exec(AGENT_ROTATION_SCHEMA_SQL);
    first.prepare(INSERT).run(...values(record));
    first.close();

    const reopened = new DatabaseSync(path);
    const row = reopened.prepare(
      'SELECT * FROM agent_rotation_operations WHERE signature = ?',
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

test('signature uniqueness and one unresolved rotation per identity are enforced', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(AGENT_ROTATION_SCHEMA_SQL);
  const first = prepared();
  db.prepare(INSERT).run(...values(first));
  assert.throws(() => db.prepare(INSERT).run(...values(first)));
  const second = prepared({
    programId: first.programId,
    owner: first.owner,
    vault: first.vault,
    heartbeat: first.heartbeat,
    signature: signature(3),
    blockhash: blockhash(4),
  });
  assert.throws(() => db.prepare(INSERT).run(...values(second)));
  db.close();
});

test('terminal records do not block a later deliberate rotation', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(AGENT_ROTATION_SCHEMA_SQL);
  const first = prepared();
  db.prepare(INSERT).run(...values(first));
  db.prepare(
    `UPDATE agent_rotation_operations
        SET state = 'resolved_failed' WHERE signature = ?`,
  ).run(first.signature);
  const second = prepared({
    programId: first.programId,
    owner: first.owner,
    vault: first.vault,
    heartbeat: first.heartbeat,
    signature: signature(5),
    blockhash: blockhash(6),
  });
  db.prepare(INSERT).run(...values(second));
  assert.equal(
    db.prepare(
      'SELECT COUNT(*) AS count FROM agent_rotation_operations',
    ).get().count,
    2,
  );
  db.close();
});

test('rotation state machine rejects impossible terminal transitions', () => {
  const submitted = transitionAgentRotation(
    prepared(),
    'submitted',
    11,
  );
  const resolved = transitionAgentRotation(
    submitted,
    'resolved_failed',
    12,
  );
  assert.throws(() =>
    transitionAgentRotation(resolved, 'submitted', 13),
  );
});

test('record validation rejects invalid identities, signatures and schema versions', () => {
  const record = prepared();
  for (const invalid of [
    { ...record, schemaVersion: 2 },
    { ...record, cluster: 'mainnet-beta' },
    { ...record, owner: 'invalid' },
    { ...record, candidateAgent: record.oldAgent },
    {
      ...record,
      signature: 'invalid',
      operationId: 'invalid',
    },
    { ...record, beforeTotalHeartbeats: '18446744073709551616' },
    { ...record, beforeConfigFingerprint: 'short' },
  ]) {
    assert.throws(() => validateAgentRotationRecord(invalid));
  }
});

test('journal schema has required identity fields and no secret-bearing columns', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(AGENT_ROTATION_SCHEMA_SQL);
  const columns = db.prepare(
    'PRAGMA table_info(agent_rotation_operations)',
  ).all().map((row) => row.name);
  for (const required of [
    'old_agent',
    'candidate_agent',
    'candidate_slot_id',
    'signature',
    'blockhash',
    'before_total_heartbeats',
    'before_final_deadline',
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
    'wallet_token',
    'rpc_url',
  ]) {
    assert.equal(columns.includes(prohibited), false);
  }
  db.close();
});

test('recovery_required remains blocking while confirmed promotion is terminal', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(AGENT_ROTATION_SCHEMA_SQL);
  const recovery = prepared();
  const recoveryValues = values(recovery);
  recoveryValues[18] = 'recovery_required';
  db.prepare(INSERT).run(...recoveryValues);
  const blocked = prepared({
    programId: recovery.programId,
    owner: recovery.owner,
    vault: recovery.vault,
    heartbeat: recovery.heartbeat,
    signature: signature(8),
    blockhash: blockhash(9),
  });
  assert.throws(() => db.prepare(INSERT).run(...values(blocked)));
  db.close();
});
