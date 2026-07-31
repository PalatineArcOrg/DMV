import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import {
  createSigningMigrationRecord,
  isMigrationReadyForCleanup,
  SIGNING_MIGRATION_SCHEMA_SQL,
  transitionSigningMigration,
  validateSigningMigrationRecord,
  type MigrationCompletionEvidence,
} from './signingMigrationRepoCore.ts';

function fixture(nowSeconds = 100) {
  const programId = Keypair.generate().publicKey.toBase58();
  const owner = Keypair.generate().publicKey.toBase58();
  const vault = Keypair.generate().publicKey.toBase58();
  const legacyAgent = Keypair.generate().publicKey.toBase58();
  return createSigningMigrationRecord({
    identity: {
      cluster: 'devnet',
      programId,
      owner,
      vault,
    },
    legacyAgent,
    preRotationTotalHeartbeats: 18_446_744_073_709_551_615n,
    verifiedDeadline: 500,
    nowSeconds,
  });
}

const signature = () =>
  bs58.encode(Uint8Array.from({ length: 64 }, (_, index) => index));

test('migration journal preserves full u64 counts and contains no secret fields', () => {
  const record = fixture();
  assert.equal(record.preRotationTotalHeartbeats, '18446744073709551615');
  assert.equal(
    Object.keys(record).some((key) =>
      /secret|private|transaction_bytes|token|credential/i.test(key)
    ),
    false
  );
  assert.equal(validateSigningMigrationRecord(record), record);
});

test('incoming migration state advances only through deliberate gates', () => {
  let record = fixture();
  const successor = Keypair.generate().publicKey.toBase58();
  record = transitionSigningMigration(record, 'candidate_secured', 101, {
    successorAgent: successor,
  });
  record = transitionSigningMigration(
    record,
    'candidate_funding_required',
    102
  );
  record = transitionSigningMigration(record, 'candidate_funded', 103);
  record = transitionSigningMigration(record, 'rotation_pending', 104, {
    rotationSignature: signature(),
  });
  record = transitionSigningMigration(record, 'successor_authorised', 105, {
    rotationResolution: 'verified',
  });
  record = transitionSigningMigration(
    record,
    'successor_heartbeat_required',
    106
  );
  assert.equal(record.state, 'successor_heartbeat_required');
  assert.throws(() =>
    transitionSigningMigration(fixture(), 'migration_ready_for_cleanup', 999)
  );
});

test('rotation alone cannot complete migration', () => {
  const record = transitionSigningMigration(
    transitionSigningMigration(
      transitionSigningMigration(
        transitionSigningMigration(fixture(), 'candidate_secured', 101, {
          successorAgent: Keypair.generate().publicKey.toBase58(),
        }),
        'candidate_funded',
        102
      ),
      'rotation_pending',
      103,
      { rotationSignature: signature() }
    ),
    'successor_authorised',
    104
  );
  assert.equal(record.heartbeatSignature, null);
  assert.notEqual(record.state, 'migration_ready_for_cleanup');
});

test('completion gate requires every piece of evidence', () => {
  const complete: MigrationCompletionEvidence = {
    distinctPackage: true,
    signingFingerprintRecorded: true,
    successorAuthorised: true,
    successorKeyResolvesAfterRestart: true,
    successorHeartbeatConfirmed: true,
    heartbeatCountAdvanced: true,
    freshDeadlineHealthy: true,
    feeReserveAccepted: true,
    noUnresolvedHeartbeat: true,
    noUnresolvedRotation: true,
    noUnresolvedFunding: true,
    notificationDecisionComplete: true,
    legacyBridgeInstalled: true,
    rollbackValidated: true,
    evidenceCaptured: true,
  };
  assert.equal(isMigrationReadyForCleanup(complete), true);
  for (const name of Object.keys(complete) as Array<
    keyof MigrationCompletionEvidence
  >) {
    assert.equal(
      isMigrationReadyForCleanup({ ...complete, [name]: false }),
      false,
      name
    );
  }
});

test('invalid package-independent record evidence is rejected', () => {
  const record = fixture();
  assert.throws(() =>
    validateSigningMigrationRecord({
      ...record,
      rotationSignature: 'not-a-signature',
    })
  );
  assert.throws(() =>
    validateSigningMigrationRecord({
      ...record,
      cluster: 'mainnet-beta' as 'devnet',
    })
  );
});

test('migration progress survives SQLite reopen without secret-bearing columns', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dmv-signing-migration-'));
  const path = join(directory, 'migration.sqlite');
  const record = fixture();
  try {
    const first = new DatabaseSync(path);
    first.exec(SIGNING_MIGRATION_SCHEMA_SQL);
    first
      .prepare(
        `INSERT INTO signing_identity_migrations VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )`
      )
      .run(
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
        record.updatedAt
      );
    first.close();

    const reopened = new DatabaseSync(path);
    const row = reopened
      .prepare(
        'SELECT * FROM signing_identity_migrations WHERE operation_id = ?'
      )
      .get(record.operationId) as Record<string, unknown>;
    const columns = reopened
      .prepare('PRAGMA table_info(signing_identity_migrations)')
      .all()
      .map((value) => String(value.name));
    reopened.close();
    assert.equal(row.pre_rotation_total_heartbeats, '18446744073709551615');
    assert.equal(row.state, 'legacy_authority_verified');
    assert.equal(
      columns.some((name) =>
        /secret|private|raw_transaction|signed_transaction|token|credential/i.test(
          name
        )
      ),
      false
    );
  } finally {
    rmSync(directory, { recursive: true });
  }
});
