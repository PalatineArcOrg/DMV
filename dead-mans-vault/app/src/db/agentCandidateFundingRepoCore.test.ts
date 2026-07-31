import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import {
  AGENT_CANDIDATE_FUNDING_SCHEMA_SQL,
  createPreparedCandidateFunding,
  transitionCandidateFunding,
  validateCandidateFundingOperation,
} from './agentCandidateFundingRepoCore.ts';

function operation(fill = 1) {
  return createPreparedCandidateFunding({
    cluster: 'devnet',
    programId: Keypair.generate().publicKey.toBase58(),
    owner: Keypair.generate().publicKey.toBase58(),
    vault: Keypair.generate().publicKey.toBase58(),
    candidateAgent: Keypair.generate().publicKey.toBase58(),
    signature: bs58.encode(Buffer.alloc(64, fill)),
    blockhash: bs58.encode(Buffer.alloc(32, fill + 1)),
    lastValidBlockHeight: 100,
    transferLamports: 5_000_000,
    createdAt: 1,
    updatedAt: 1,
  });
}

function values(record: ReturnType<typeof operation>) {
  return [
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
  ];
}

const INSERT =
  'INSERT INTO agent_candidate_funding_operations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';

test('candidate funding prepared evidence round-trips without transaction bytes', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(AGENT_CANDIDATE_FUNDING_SCHEMA_SQL);
  const record = operation();
  db.prepare(INSERT).run(...values(record));
  const row = db.prepare(
    'SELECT * FROM agent_candidate_funding_operations',
  ).get() as Record<string, unknown>;
  assert.equal(row.signature, record.signature);
  assert.equal(row.state, 'prepared');
  assert.equal(row.transfer_lamports, 5_000_000);
  db.close();
});

test('one unresolved candidate funding operation per identity is enforced', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(AGENT_CANDIDATE_FUNDING_SCHEMA_SQL);
  const first = operation();
  db.prepare(INSERT).run(...values(first));
  const second = operation(3);
  Object.assign(second, {
    programId: first.programId,
    owner: first.owner,
    vault: first.vault,
    candidateAgent: first.candidateAgent,
  });
  assert.throws(() => db.prepare(INSERT).run(...values(second)));
  db.close();
});

test('resolved funding evidence permits a later deliberate funding operation', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(AGENT_CANDIDATE_FUNDING_SCHEMA_SQL);
  const first = operation();
  db.prepare(INSERT).run(...values(first));
  db.prepare(
    `UPDATE agent_candidate_funding_operations
        SET state = 'resolved_expired'`,
  ).run();
  const second = operation(4);
  Object.assign(second, {
    programId: first.programId,
    owner: first.owner,
    vault: first.vault,
    candidateAgent: first.candidateAgent,
  });
  db.prepare(INSERT).run(...values(second));
  db.close();
});

test('candidate funding state machine rejects resend-style terminal transitions', () => {
  const confirmed = transitionCandidateFunding(
    operation(),
    'resolved_confirmed',
    2,
  );
  assert.throws(() =>
    transitionCandidateFunding(confirmed, 'submitted', 3),
  );
});

test('candidate funding journal validates identity and contains no secret columns', () => {
  const record = operation();
  assert.throws(() =>
    validateCandidateFundingOperation({
      ...record,
      candidateAgent: 'invalid',
    }),
  );
  const db = new DatabaseSync(':memory:');
  db.exec(AGENT_CANDIDATE_FUNDING_SCHEMA_SQL);
  const columns = db.prepare(
    'PRAGMA table_info(agent_candidate_funding_operations)',
  ).all().map((row) => row.name);
  for (const prohibited of [
    'secret_key',
    'private_key',
    'raw_transaction',
    'signed_transaction',
  ]) {
    assert.equal(columns.includes(prohibited), false);
  }
  db.close();
});
