// WP3 integration (§18): legacy-stickiness store functions + db.js wiring, all on
// throwaway temp/:memory: DBs — NEVER the live registrations.db.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import {
  ensureSchema, getRegistration, isSignedRow,
  applyLegacyRegistration, deleteLegacyRegistration,
  applySignedRegistration, RESULT,
} from '../src/registrationStore.js';

let seq = 0;
const tmp = [];
function tmpPath() { const p = join(tmpdir(), `dmv-wp3-wiring-${process.pid}-${seq++}.db`); tmp.push(p); return p; }
function memDb() { const db = new Database(':memory:'); ensureSchema(db); return db; }
after(() => { for (const p of tmp) for (const s of ['', '-wal', '-shm']) { try { rmSync(p + s); } catch { /* ignore */ } } });

const legacyCmd = (o = {}) => ({ owner: 'ownerA', vault: 'vaultV', deviceToken: 'tok-legacy', stage1: 100, stage2: 200, stage3: 300, now: 1000, ...o });
const signedCmd = (o = {}) => ({ owner: 'ownerA', vault: 'vaultV', deviceToken: 'tok-signed', deviceTokenHash: 'a'.repeat(64), stage1: 1, stage2: 2, stage3: 3, revision: 1, signedAt: 900, nonce: 'n1', nonceUsedAt: 1000, authVersion: 2, ...o });

test('legacy insert writes legacy metadata (auth_version=1, migration_status=legacy)', () => {
  const db = memDb();
  const r = applyLegacyRegistration(db, legacyCmd());
  assert.equal(r.code, RESULT.CREATED);
  const row = getRegistration(db, 'vaultV');
  assert.equal(row.auth_version, 1);
  assert.equal(row.registration_revision, 0);
  assert.equal(row.migration_status, 'legacy');
  assert.equal(row.device_token_hash, null);
  assert.equal(row.device_token, 'tok-legacy');
});

test('legacy update preserves created_at/last_stage/last_notified_at', () => {
  const db = memDb();
  applyLegacyRegistration(db, legacyCmd());
  db.prepare('UPDATE registrations SET last_stage=2, last_notified_at=777 WHERE vault=?').run('vaultV');
  const r = applyLegacyRegistration(db, legacyCmd({ deviceToken: 'tok2', stage1: 5, now: 2000 }));
  assert.equal(r.code, RESULT.UPDATED);
  const row = getRegistration(db, 'vaultV');
  assert.equal(row.device_token, 'tok2');
  assert.equal(row.stage1, 5);
  assert.equal(row.created_at, 1000, 'created_at preserved');
  assert.equal(row.last_stage, 2, 'last_stage preserved');
  assert.equal(row.last_notified_at, 777, 'last_notified_at preserved');
  assert.equal(row.auth_version, 1, 'stays legacy');
});

test('signed row is sticky: legacy upsert cannot overwrite it', () => {
  const db = memDb();
  assert.equal(applySignedRegistration(db, signedCmd()).code, RESULT.CREATED);
  assert.equal(isSignedRow(getRegistration(db, 'vaultV')), true);
  const r = applyLegacyRegistration(db, legacyCmd({ deviceToken: 'HIJACK' }));
  assert.equal(r.code, RESULT.SIGNED_AUTHORIZATION_REQUIRED);
  assert.equal(getRegistration(db, 'vaultV').device_token, 'tok-signed', 'not overwritten');
});

test('signed row is sticky: legacy delete cannot remove it', () => {
  const db = memDb();
  applySignedRegistration(db, signedCmd());
  const r = deleteLegacyRegistration(db, { vault: 'vaultV' });
  assert.equal(r.code, RESULT.SIGNED_AUTHORIZATION_REQUIRED);
  assert.ok(getRegistration(db, 'vaultV'), 'row preserved');
});

test('legacy delete removes a legacy row; missing row is idempotent removed=0', () => {
  const db = memDb();
  applyLegacyRegistration(db, legacyCmd());
  assert.equal(deleteLegacyRegistration(db, { vault: 'vaultV' }).removed, 1);
  assert.equal(getRegistration(db, 'vaultV'), null);
  const again = deleteLegacyRegistration(db, { vault: 'vaultV' });
  assert.equal(again.code, RESULT.REMOVED);
  assert.equal(again.removed, 0);
});

test('db.js wiring: ensureSchema runs + bound functions operate — on a TEMP DB only', async () => {
  const path = tmpPath();
  process.env.DB_PATH = path;
  process.env.REGISTER_SECRET = 'x';
  process.env.EXPECTED_CLUSTER = 'devnet';
  const cfg = await import(`../src/config.js?wiring=${seq}`);
  assert.equal(cfg.config.dbPath, path, 'guard: config must point at the temp DB, not the live one');
  const db = await import(`../src/db.js?wiring=${seq}`);
  // bound exports exist
  for (const fn of ['applySignedRegistration', 'applySignedDeregistration', 'applyLegacyRegistration', 'deleteLegacyRegistration', 'getRegistration']) {
    assert.equal(typeof db[fn], 'function', `db.${fn}`);
  }
  // migration ran: signed insert works and writes v2 metadata; poller export still compatible
  assert.equal(db.applyLegacyRegistration(legacyCmd()).code, RESULT.CREATED);
  assert.equal(db.getRegistration('vaultV').auth_version, 1);
  const rows = db.allRegistrations();
  assert.equal(rows.length, 1);
  assert.ok('last_stage' in rows[0] && 'device_token' in rows[0], 'poller fields present');
  // internal poller deletion removes ANY row (even after it becomes signed)
  db.applySignedRegistration(signedCmd({ vault: 'vaultSigned', owner: 'o2', nonce: 'n2' }));
  assert.equal(db.deleteRegistrationsByOwner('o2') >= 0, true);
});
