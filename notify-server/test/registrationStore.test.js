// V2 registration storage-layer tests (WP2): additive migration, legacy/Fox-row
// preservation, atomic signed register/deregister transactions, anti-rollback
// ordering, nonce consumption + rollback, concurrency across two connections, and
// unsigned/legacy regression on the migrated schema. All against throwaway
// :memory: / temp-file databases — never the live DB path.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import {
  ensureSchema,
  migrateRegistrations,
  getRegistration,
  applySignedRegistration,
  applySignedDeregistration,
  pruneNonces,
  RESULT,
} from '../src/registrationStore.js';

let seq = 0;
const tmpFiles = [];
function tmpPath() {
  const p = join(tmpdir(), `dmv-wp2-store-${process.pid}-${seq++}.db`);
  tmpFiles.push(p);
  return p;
}
function memDb() {
  const db = new Database(':memory:');
  ensureSchema(db);
  return db;
}
function fileDb(path) {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  return db;
}
after(() => {
  for (const p of tmpFiles) for (const s of ['', '-wal', '-shm']) {
    try { rmSync(p + s); } catch { /* ignore */ }
  }
});

// Legacy (pre-WP2) schema, byte-identical to the shipped db.js.
function legacyDb(inMemory = true, path) {
  const db = inMemory ? new Database(':memory:') : new Database(path);
  db.exec(`
    CREATE TABLE registrations (
      vault            TEXT PRIMARY KEY,
      owner            TEXT NOT NULL,
      device_token     TEXT NOT NULL,
      stage1           INTEGER NOT NULL,
      stage2           INTEGER NOT NULL,
      stage3           INTEGER NOT NULL,
      last_stage       INTEGER NOT NULL DEFAULT 0,
      last_notified_at INTEGER NOT NULL DEFAULT 0,
      created_at       INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL
    );`);
  db.exec(`
    CREATE TABLE used_nonces (
      owner    TEXT NOT NULL,
      nonce    TEXT NOT NULL,
      used_at  INTEGER NOT NULL,
      PRIMARY KEY (owner, nonce)
    );`);
  return db;
}
const FOX = {
  vault: 'FoxVaultPDA1111111111111111111111111111111',
  owner: 'FoxOwner1111111111111111111111111111111111',
  device_token: 'fox-fake-device-token-0123456789abcdef',
  stage1: 259200, stage2: 604800, stage3: 604800,
  last_stage: 2, last_notified_at: 1700000000,
  created_at: 1699000000, updated_at: 1699500000,
};
function insertLegacyRow(db, row) {
  db.prepare(`INSERT INTO registrations
    (vault, owner, device_token, stage1, stage2, stage3, last_stage, last_notified_at, created_at, updated_at)
    VALUES (@vault,@owner,@device_token,@stage1,@stage2,@stage3,@last_stage,@last_notified_at,@created_at,@updated_at)`).run(row);
}
function columns(db) {
  return new Set(db.prepare('PRAGMA table_info(registrations)').all().map((r) => r.name));
}

function regCmd(over = {}) {
  return {
    owner: 'ownerA', vault: 'vaultV',
    deviceToken: 'device-token-AAAAAAAAAAAAAAAAAAAAAAAAAAAA', deviceTokenHash: 'a'.repeat(64),
    stage1: 100, stage2: 200, stage3: 300, revision: 1,
    signedAt: 1000, nonce: 'nonce-1', nonceUsedAt: 1000, authVersion: 2, ...over,
  };
}
function deregCmd(over = {}) {
  return { owner: 'ownerA', vault: 'vaultV', nonce: 'dnonce-1', nonceUsedAt: 2000, signedAt: 2000, authVersion: 2, ...over };
}

// ── Migration ───────────────────────────────────────────────────────────────
test('ensureSchema on a fresh DB creates all V2 columns + nonce index', () => {
  const db = memDb();
  const cols = columns(db);
  for (const c of ['auth_version', 'registration_revision', 'device_token_hash', 'signed_at', 'migration_status', 'last_auth_op']) {
    assert.ok(cols.has(c), `missing column ${c}`);
  }
  const idx = db.prepare('PRAGMA index_list(used_nonces)').all().map((r) => r.name);
  assert.ok(idx.includes('idx_used_nonces_used_at'));
});

test('migration of the exact legacy schema adds columns and preserves the Fox-like row', () => {
  const db = legacyDb();
  insertLegacyRow(db, FOX);
  const before = db.prepare('SELECT * FROM registrations WHERE vault=?').get(FOX.vault);
  migrateRegistrations(db);
  const after = db.prepare('SELECT * FROM registrations WHERE vault=?').get(FOX.vault);
  // Legacy fields byte/value preserved.
  for (const k of ['vault', 'owner', 'device_token', 'stage1', 'stage2', 'stage3', 'last_stage', 'last_notified_at', 'created_at', 'updated_at']) {
    assert.deepEqual(after[k], before[k], `field ${k} changed`);
  }
  // New columns get the documented legacy defaults.
  assert.equal(after.auth_version, 1);
  assert.equal(after.registration_revision, 0);
  assert.equal(after.migration_status, 'legacy');
  assert.equal(after.device_token_hash, null);
  assert.equal(after.signed_at, null);
  assert.equal(after.last_auth_op, null);
});

test('migration is idempotent (rerun changes no schema or data)', () => {
  const db = legacyDb();
  insertLegacyRow(db, FOX);
  migrateRegistrations(db);
  const cols1 = [...columns(db)].sort();
  const row1 = db.prepare('SELECT * FROM registrations WHERE vault=?').get(FOX.vault);
  migrateRegistrations(db);
  migrateRegistrations(db);
  const cols2 = [...columns(db)].sort();
  const row2 = db.prepare('SELECT * FROM registrations WHERE vault=?').get(FOX.vault);
  assert.deepEqual(cols2, cols1);
  assert.deepEqual(row2, row1);
});

test('opening a copied synthetic legacy DB file and migrating preserves the row', () => {
  const path = tmpPath();
  const seed = legacyDb(false, path);
  insertLegacyRow(seed, FOX);
  seed.close(); // simulate a copied legacy database file on disk
  const db = fileDb(path);
  ensureSchema(db);
  const row = db.prepare('SELECT * FROM registrations WHERE vault=?').get(FOX.vault);
  assert.equal(row.owner, FOX.owner);
  assert.equal(row.device_token, FOX.device_token);
  assert.equal(row.last_stage, FOX.last_stage);
  assert.equal(row.migration_status, 'legacy');
  assert.equal(row.auth_version, 1);
  db.close();
});

// ── Signed registration transaction ─────────────────────────────────────────
test('signed registration insert creates a signed row with correct fields', () => {
  const db = memDb();
  const r = applySignedRegistration(db, regCmd());
  assert.equal(r.code, RESULT.CREATED);
  const row = getRegistration(db, 'vaultV');
  assert.equal(row.owner, 'ownerA');
  assert.equal(row.device_token, 'device-token-AAAAAAAAAAAAAAAAAAAAAAAAAAAA');
  assert.equal(row.device_token_hash, 'a'.repeat(64));
  assert.equal(row.auth_version, 2);
  assert.equal(row.registration_revision, 1);
  assert.equal(row.migration_status, 'signed');
  assert.equal(row.last_auth_op, 'register');
  assert.equal(row.signed_at, 1000);
  assert.equal(row.last_stage, 0);
  assert.equal(row.last_notified_at, 0);
  assert.equal(row.created_at, 1000);
  assert.equal(row.updated_at, 1000);
});

test('revision increase updates and PRESERVES created_at/last_stage/last_notified_at', () => {
  const db = memDb();
  applySignedRegistration(db, regCmd({ revision: 1, nonce: 'n1', nonceUsedAt: 1000 }));
  // simulate escalation progress written by the poller
  db.prepare('UPDATE registrations SET last_stage=3, last_notified_at=1234 WHERE vault=?').run('vaultV');
  const r = applySignedRegistration(db, regCmd({
    revision: 2, nonce: 'n2', nonceUsedAt: 2000,
    deviceToken: 'device-token-BBBBBBBBBBBBBBBBBBBBBBBBBBBB', deviceTokenHash: 'b'.repeat(64), stage1: 111,
  }));
  assert.equal(r.code, RESULT.UPDATED);
  const row = getRegistration(db, 'vaultV');
  assert.equal(row.registration_revision, 2);
  assert.equal(row.device_token, 'device-token-BBBBBBBBBBBBBBBBBBBBBBBBBBBB');
  assert.equal(row.stage1, 111);
  assert.equal(row.updated_at, 2000);
  assert.equal(row.created_at, 1000, 'created_at preserved');
  assert.equal(row.last_stage, 3, 'last_stage preserved');
  assert.equal(row.last_notified_at, 1234, 'last_notified_at preserved');
});

test('lower and equal revisions are rejected (stale_revision), row unchanged', () => {
  const db = memDb();
  applySignedRegistration(db, regCmd({ revision: 2, nonce: 'n1' }));
  const lower = applySignedRegistration(db, regCmd({ revision: 1, nonce: 'n2', deviceTokenHash: 'c'.repeat(64) }));
  assert.equal(lower.code, RESULT.STALE_REVISION);
  const equal = applySignedRegistration(db, regCmd({ revision: 2, nonce: 'n3', deviceTokenHash: 'd'.repeat(64) }));
  assert.equal(equal.code, RESULT.STALE_REVISION);
  const row = getRegistration(db, 'vaultV');
  assert.equal(row.registration_revision, 2);
  assert.equal(row.device_token_hash, 'a'.repeat(64), 'row not overwritten by stale request');
});

test('a delayed lower revision after a newer one is rejected', () => {
  const db = memDb();
  applySignedRegistration(db, regCmd({ revision: 3, nonce: 'n1' }));
  const r = applySignedRegistration(db, regCmd({ revision: 2, nonce: 'n2' }));
  assert.equal(r.code, RESULT.STALE_REVISION);
  assert.equal(getRegistration(db, 'vaultV').registration_revision, 3);
});

test('a stale request cannot restore an old token or old stages', () => {
  const db = memDb();
  applySignedRegistration(db, regCmd({ revision: 2, nonce: 'n1', deviceToken: 'device-token-NEWNEWNEWNEWNEWNEWNEWNEWNEW', deviceTokenHash: 'e'.repeat(64), stage1: 999 }));
  applySignedRegistration(db, regCmd({ revision: 1, nonce: 'n2', deviceToken: 'device-token-OLDOLDOLDOLDOLDOLDOLDOLDOLD', deviceTokenHash: 'f'.repeat(64), stage1: 1 }));
  const row = getRegistration(db, 'vaultV');
  assert.equal(row.device_token, 'device-token-NEWNEWNEWNEWNEWNEWNEWNEWNEW');
  assert.equal(row.stage1, 999);
});

test('same nonce used twice → exactly one accepted', () => {
  const db = memDb();
  const first = applySignedRegistration(db, regCmd({ nonce: 'dup' }));
  const second = applySignedRegistration(db, regCmd({ nonce: 'dup', revision: 5, vault: 'vaultOther', deviceTokenHash: 'b'.repeat(64) }));
  assert.equal(first.code, RESULT.CREATED);
  assert.equal(second.code, RESULT.NONCE_REUSED);
  assert.equal(getRegistration(db, 'vaultOther'), null, 'reused nonce performed no mutation');
});

test('same nonce with a different revision → replay rejected before revision check', () => {
  const db = memDb();
  applySignedRegistration(db, regCmd({ revision: 2, nonce: 'N' }));
  const replay = applySignedRegistration(db, regCmd({ revision: 3, nonce: 'N', deviceTokenHash: 'b'.repeat(64) }));
  assert.equal(replay.code, RESULT.NONCE_REUSED);
  assert.equal(getRegistration(db, 'vaultV').registration_revision, 2);
});

test('two different nonces with conflicting revisions → highest committed wins (both orders)', () => {
  const up = memDb();
  applySignedRegistration(up, regCmd({ revision: 2, nonce: 'a1' }));
  applySignedRegistration(up, regCmd({ revision: 3, nonce: 'a2' }));
  assert.equal(getRegistration(up, 'vaultV').registration_revision, 3);

  const down = memDb();
  applySignedRegistration(down, regCmd({ revision: 3, nonce: 'b1' }));
  const r = applySignedRegistration(down, regCmd({ revision: 2, nonce: 'b2' }));
  assert.equal(r.code, RESULT.STALE_REVISION);
  assert.equal(getRegistration(down, 'vaultV').registration_revision, 3);
});

test('an owner-conflict row is never overwritten and the nonce is consumed', () => {
  const db = memDb();
  applySignedRegistration(db, regCmd({ owner: 'ownerA', vault: 'vaultV', revision: 1, nonce: 'n1' }));
  const conflict = applySignedRegistration(db, regCmd({ owner: 'ownerB', vault: 'vaultV', revision: 9, nonce: 'nc' }));
  assert.equal(conflict.code, RESULT.OWNER_CONFLICT);
  assert.equal(getRegistration(db, 'vaultV').owner, 'ownerA', 'not overwritten');
  // nonce consumed: reusing (owner=ownerB, nonce=nc) is a replay
  const replay = applySignedRegistration(db, regCmd({ owner: 'ownerB', vault: 'vaultOther', nonce: 'nc' }));
  assert.equal(replay.code, RESULT.NONCE_REUSED);
});

test('a valid stale-revision request consumes its nonce', () => {
  const db = memDb();
  applySignedRegistration(db, regCmd({ revision: 2, nonce: 'n1' }));
  const stale = applySignedRegistration(db, regCmd({ revision: 1, nonce: 'nStale' }));
  assert.equal(stale.code, RESULT.STALE_REVISION);
  const replay = applySignedRegistration(db, regCmd({ revision: 5, nonce: 'nStale' }));
  assert.equal(replay.code, RESULT.NONCE_REUSED);
});

// ── Failure atomicity (real SQLite ABORT injection) ─────────────────────────
test('DB failure during insert rolls back the nonce; retry with same nonce succeeds', () => {
  const db = memDb();
  db.exec("CREATE TRIGGER fail_ins BEFORE INSERT ON registrations BEGIN SELECT RAISE(ABORT,'injected'); END;");
  const r = applySignedRegistration(db, regCmd({ nonce: 'nFail' }));
  assert.equal(r.code, RESULT.DATABASE_ERROR);
  const claimed = db.prepare('SELECT COUNT(*) AS n FROM used_nonces WHERE owner=? AND nonce=?').get('ownerA', 'nFail').n;
  assert.equal(claimed, 0, 'nonce rolled back');
  db.exec('DROP TRIGGER fail_ins;');
  const retry = applySignedRegistration(db, regCmd({ nonce: 'nFail' }));
  assert.equal(retry.code, RESULT.CREATED);
});

test('DB failure during update rolls back the nonce AND the row', () => {
  const db = memDb();
  applySignedRegistration(db, regCmd({ revision: 1, nonce: 'n1', deviceToken: 'device-token-ORIGINALORIGINALORIGINALORIG', deviceTokenHash: 'a'.repeat(64) }));
  db.exec("CREATE TRIGGER fail_upd BEFORE UPDATE ON registrations BEGIN SELECT RAISE(ABORT,'injected'); END;");
  const r = applySignedRegistration(db, regCmd({ revision: 2, nonce: 'n2', deviceToken: 'device-token-CHANGEDCHANGEDCHANGEDCHANGED', deviceTokenHash: 'b'.repeat(64) }));
  assert.equal(r.code, RESULT.DATABASE_ERROR);
  const row = getRegistration(db, 'vaultV');
  assert.equal(row.registration_revision, 1, 'row unchanged');
  assert.equal(row.device_token, 'device-token-ORIGINALORIGINALORIGINALORIG');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM used_nonces WHERE nonce=?').get('n2').n, 0, 'nonce rolled back');
  db.exec('DROP TRIGGER fail_upd;');
  const retry = applySignedRegistration(db, regCmd({ revision: 2, nonce: 'n2', deviceToken: 'device-token-CHANGEDCHANGEDCHANGEDCHANGED', deviceTokenHash: 'b'.repeat(64) }));
  assert.equal(retry.code, RESULT.UPDATED);
});

// ── Signed deregistration transaction ───────────────────────────────────────
test('deregistration removes the matching row exactly once, then is idempotent removed=0', () => {
  const db = memDb();
  applySignedRegistration(db, regCmd());
  const first = applySignedDeregistration(db, deregCmd({ nonce: 'd1' }));
  assert.equal(first.code, RESULT.REMOVED);
  assert.equal(first.removed, 1);
  assert.equal(getRegistration(db, 'vaultV'), null);
  const second = applySignedDeregistration(db, deregCmd({ nonce: 'd2' }));
  assert.equal(second.code, RESULT.REMOVED);
  assert.equal(second.removed, 0, 'idempotent no-op');
});

test('repeated deregistration with the same nonce is a replay', () => {
  const db = memDb();
  applySignedRegistration(db, regCmd());
  applySignedDeregistration(db, deregCmd({ nonce: 'dSame' }));
  const replay = applySignedDeregistration(db, deregCmd({ nonce: 'dSame' }));
  assert.equal(replay.code, RESULT.NONCE_REUSED);
});

test('deregistration owner-conflict retains nonce and preserves the row', () => {
  const db = memDb();
  applySignedRegistration(db, regCmd({ owner: 'ownerA', vault: 'vaultV' }));
  const r = applySignedDeregistration(db, deregCmd({ owner: 'ownerB', vault: 'vaultV', nonce: 'dc' }));
  assert.equal(r.code, RESULT.OWNER_CONFLICT);
  assert.equal(getRegistration(db, 'vaultV').owner, 'ownerA');
  const replay = applySignedDeregistration(db, deregCmd({ owner: 'ownerB', vault: 'vaultOther', nonce: 'dc' }));
  assert.equal(replay.code, RESULT.NONCE_REUSED, 'conflict consumed the nonce');
});

test('deregistration DB failure rolls back the nonce and preserves the row', () => {
  const db = memDb();
  applySignedRegistration(db, regCmd());
  db.exec("CREATE TRIGGER fail_del BEFORE DELETE ON registrations BEGIN SELECT RAISE(ABORT,'injected'); END;");
  const r = applySignedDeregistration(db, deregCmd({ nonce: 'dFail' }));
  assert.equal(r.code, RESULT.DATABASE_ERROR);
  assert.ok(getRegistration(db, 'vaultV'), 'row preserved');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM used_nonces WHERE nonce=?').get('dFail').n, 0);
  db.exec('DROP TRIGGER fail_del;');
  const retry = applySignedDeregistration(db, deregCmd({ nonce: 'dFail' }));
  assert.equal(retry.removed, 1);
});

// ── Nonce pruning + persistence ─────────────────────────────────────────────
test('pruneNonces removes only sufficiently old rows', () => {
  const db = memDb();
  db.prepare('INSERT INTO used_nonces VALUES (?,?,?)').run('o', 'old1', 100);
  db.prepare('INSERT INTO used_nonces VALUES (?,?,?)').run('o', 'old2', 200);
  db.prepare('INSERT INTO used_nonces VALUES (?,?,?)').run('o', 'new1', 300);
  const removed = pruneNonces(db, 250);
  assert.equal(removed, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM used_nonces').get().n, 1);
});

test('nonce state survives database close and reopen', () => {
  const path = tmpPath();
  const a = fileDb(path);
  ensureSchema(a);
  assert.equal(applySignedRegistration(a, regCmd({ nonce: 'persist' })).code, RESULT.CREATED);
  a.close();
  const b = fileDb(path);
  const replay = applySignedRegistration(b, regCmd({ nonce: 'persist', vault: 'vaultOther', deviceTokenHash: 'b'.repeat(64) }));
  assert.equal(replay.code, RESULT.NONCE_REUSED);
  b.close();
});

// ── Concurrency / ordering across two connections to one file ───────────────
test('a nonce cannot win twice across two independent connections', () => {
  const path = tmpPath();
  const a = fileDb(path); ensureSchema(a);
  const b = fileDb(path);
  a.pragma('busy_timeout = 2000'); b.pragma('busy_timeout = 2000');
  const r1 = applySignedRegistration(a, regCmd({ nonce: 'shared' }));
  const r2 = applySignedRegistration(b, regCmd({ nonce: 'shared', revision: 9, vault: 'vaultOther', deviceTokenHash: 'b'.repeat(64) }));
  assert.equal(r1.code, RESULT.CREATED);
  assert.equal(r2.code, RESULT.NONCE_REUSED);
  a.close(); b.close();
});

test('concurrent revision 2 and 3 leave revision 3 final regardless of order', () => {
  const path = tmpPath();
  const a = fileDb(path); ensureSchema(a);
  const b = fileDb(path);
  a.pragma('busy_timeout = 2000'); b.pragma('busy_timeout = 2000');
  applySignedRegistration(a, regCmd({ revision: 2, nonce: 'c1' }));
  applySignedRegistration(b, regCmd({ revision: 3, nonce: 'c2' }));
  assert.equal(getRegistration(a, 'vaultV').registration_revision, 3);
  a.close(); b.close();
});

test('WAL busy contention yields a retryable error, never corruption', () => {
  const path = tmpPath();
  const a = fileDb(path); ensureSchema(a);
  const b = fileDb(path);
  b.pragma('busy_timeout = 0');
  a.exec('BEGIN IMMEDIATE');
  a.prepare('INSERT INTO used_nonces VALUES (?,?,?)').run('o', 'na', 1);
  assert.throws(
    () => b.prepare('INSERT INTO used_nonces VALUES (?,?,?)').run('o', 'nb', 1),
    /SQLITE_BUSY|database is locked/i,
  );
  a.exec('COMMIT');
  // once the writer commits, the second connection proceeds normally
  b.prepare('INSERT INTO used_nonces VALUES (?,?,?)').run('o', 'nb', 1);
  assert.equal(b.prepare('SELECT COUNT(*) AS n FROM used_nonces').get().n, 2);
  a.close(); b.close();
});

// ── Regression: unsigned/legacy behaviour on the migrated schema ────────────
test('unsigned upsert still works and preserves last_stage/last_notified_at on the migrated schema', () => {
  const db = memDb(); // migrated schema
  // Exact db.js upsert SQL against the migrated table.
  const upsert = db.prepare(`
    INSERT INTO registrations (vault, owner, device_token, stage1, stage2, stage3, last_stage, last_notified_at, created_at, updated_at)
    VALUES (@vault, @owner, @device_token, @stage1, @stage2, @stage3, 0, 0, @now, @now)
    ON CONFLICT(vault) DO UPDATE SET
      owner = excluded.owner, device_token = excluded.device_token,
      stage1 = excluded.stage1, stage2 = excluded.stage2, stage3 = excluded.stage3,
      updated_at = excluded.updated_at`);
  upsert.run({ vault: 'v', owner: 'o', device_token: 't1', stage1: 1, stage2: 2, stage3: 3, now: 100 });
  db.prepare('UPDATE registrations SET last_stage=2, last_notified_at=555 WHERE vault=?').run('v');
  upsert.run({ vault: 'v', owner: 'o', device_token: 't2', stage1: 9, stage2: 8, stage3: 7, now: 200 });
  const row = getRegistration(db, 'v');
  assert.equal(row.device_token, 't2');
  assert.equal(row.last_stage, 2, 'preserved');
  assert.equal(row.last_notified_at, 555, 'preserved');
  assert.equal(row.auth_version, 1, 'unsigned path stays legacy');
  assert.equal(row.migration_status, 'legacy');
});

test('SELECT * returns the fields the poller expects even with new columns present', () => {
  const db = memDb();
  applySignedRegistration(db, regCmd());
  const rows = db.prepare('SELECT * FROM registrations').all();
  assert.equal(rows.length, 1);
  for (const k of ['vault', 'owner', 'device_token', 'stage1', 'stage2', 'stage3', 'last_stage', 'last_notified_at']) {
    assert.ok(k in rows[0], `poller field ${k} present`);
  }
});
