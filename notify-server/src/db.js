import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';
import {
  ensureSchema,
  applySignedRegistration as storeApplySignedRegistration,
  applySignedDeregistration as storeApplySignedDeregistration,
  applyLegacyRegistration as storeApplyLegacyRegistration,
  deleteLegacyRegistration as storeDeleteLegacyRegistration,
  deleteLegacyRegistrationsByOwner as storeDeleteLegacyRegistrationsByOwner,
  getRegistration as storeGetRegistration,
  migrationCounts as storeMigrationCounts,
} from './registrationStore.js';

mkdirSync(dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');

// Base schema + idempotent additive V2 migration (single-sourced in
// registrationStore.js). Runs at import — before server.js opens a listener — so
// a migration failure aborts boot (non-zero exit) rather than serving traffic on
// a half-migrated schema. Additive + idempotent: legacy rows and the unsigned
// upsert below stay valid; notification state is never reset.
ensureSchema(db);

const upsertStmt = db.prepare(`
  INSERT INTO registrations (vault, owner, device_token, stage1, stage2, stage3, last_stage, last_notified_at, created_at, updated_at)
  VALUES (@vault, @owner, @device_token, @stage1, @stage2, @stage3, 0, 0, @now, @now)
  ON CONFLICT(vault) DO UPDATE SET
    owner = excluded.owner,
    device_token = excluded.device_token,
    stage1 = excluded.stage1,
    stage2 = excluded.stage2,
    stage3 = excluded.stage3,
    updated_at = excluded.updated_at
`);

export function upsertRegistration({ vault, owner, deviceToken, stage1, stage2, stage3 }) {
  const now = Math.floor(Date.now() / 1000);
  upsertStmt.run({ vault, owner, device_token: deviceToken, stage1, stage2, stage3, now });
}

const deleteStmt = db.prepare('DELETE FROM registrations WHERE vault = ?');
export function deleteRegistration(vault) {
  return deleteStmt.run(vault).changes;
}

const deleteByOwnerStmt = db.prepare('DELETE FROM registrations WHERE owner = ?');
export function deleteRegistrationsByOwner(owner) {
  return deleteByOwnerStmt.run(owner).changes;
}

const allStmt = db.prepare('SELECT * FROM registrations');
export function allRegistrations() {
  return allStmt.all();
}

const updateStageStmt = db.prepare(
  'UPDATE registrations SET last_stage = ?, last_notified_at = ? WHERE vault = ?',
);
export function updateNotifyState(vault, lastStage, lastNotifiedAt) {
  updateStageStmt.run(lastStage, lastNotifiedAt, vault);
}

export function countRegistrations() {
  return db.prepare('SELECT COUNT(*) AS n FROM registrations').get().n;
}

// Atomically claim a nonce for an owner. Returns true if it was fresh (claimed),
// false if it had already been used — so the caller rejects replays without a
// separate read (no TOCTOU race).
const claimNonceStmt = db.prepare(
  'INSERT OR IGNORE INTO used_nonces (owner, nonce, used_at) VALUES (?, ?, ?)',
);
export function claimNonce(owner, nonce, usedAt) {
  return claimNonceStmt.run(owner, nonce, usedAt).changes === 1;
}

const pruneNoncesStmt = db.prepare('DELETE FROM used_nonces WHERE used_at < ?');
export function pruneNonces(olderThan) {
  return pruneNoncesStmt.run(olderThan).changes;
}

// ── WP3: signed + legacy transactions bound to the live DB ───────────────────
// Thin wrappers over the dependency-injected store functions (unit-tested against
// temp DBs in registrationStore.test.js). The route layer calls these.
export function getRegistration(vault) {
  return storeGetRegistration(db, vault);
}
export function applySignedRegistration(command) {
  return storeApplySignedRegistration(db, command);
}
export function applySignedDeregistration(command) {
  return storeApplySignedDeregistration(db, command);
}
export function applyLegacyRegistration(command) {
  return storeApplyLegacyRegistration(db, command);
}
export function deleteLegacyRegistration(args) {
  return storeDeleteLegacyRegistration(db, args);
}
export function deleteLegacyRegistrationsByOwner(owner) {
  return storeDeleteLegacyRegistrationsByOwner(db, owner);
}
export function migrationCounts() {
  return storeMigrationCounts(db);
}
