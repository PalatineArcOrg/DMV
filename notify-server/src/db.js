import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';

mkdirSync(dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS registrations (
    vault            TEXT PRIMARY KEY,   -- vault PDA pubkey (one per owner)
    owner            TEXT NOT NULL,
    device_token     TEXT NOT NULL,      -- native FCM token
    stage1           INTEGER NOT NULL,   -- escalation stage durations (seconds)
    stage2           INTEGER NOT NULL,
    stage3           INTEGER NOT NULL,
    last_stage       INTEGER NOT NULL DEFAULT 0,  -- last escalation stage we notified for
    last_notified_at INTEGER NOT NULL DEFAULT 0,  -- unix ts of last push (for recurring throttle)
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL
  );
`);

// Replay guard for owner-signed register/deregister: each (owner, nonce) is
// single-use. Old rows are pruned (a stale nonce is also rejected by the
// timestamp window, so they don't need to be kept long).
db.exec(`
  CREATE TABLE IF NOT EXISTS used_nonces (
    owner    TEXT NOT NULL,
    nonce    TEXT NOT NULL,
    used_at  INTEGER NOT NULL,
    PRIMARY KEY (owner, nonce)
  );
`);

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
