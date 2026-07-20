// V2 registration storage layer (WP2). Pure, dependency-injected: every function
// takes an explicit better-sqlite3 `db` instance so it is unit-testable against a
// throwaway/:memory: database and never touches the production DB path.
//
// WP2 defines and tests these primitives. They are NOT wired into db.js, any HTTP
// route, or the live schema in this work package — WP3 performs that wiring at
// deploy time. The active unsigned path and V1 behaviour are unchanged.

// ─────────────────────────────────────────────────────────────────────────────
// Stable internal result codes. HTTP-status mapping is WP3 work. Never build
// control flow by parsing human-readable strings.
export const RESULT = Object.freeze({
  OK: 'ok',
  CREATED: 'created',
  UPDATED: 'updated',
  REMOVED: 'removed',
  NOT_FOUND: 'not_found',
  NONCE_REUSED: 'nonce_reused',
  STALE_REVISION: 'stale_revision',
  OWNER_CONFLICT: 'owner_conflict',
  INVALID_REQUEST: 'invalid_request',
  INVALID_SIGNATURE: 'invalid_signature',
  STALE_TIMESTAMP: 'stale_timestamp',
  CONTEXT_MISMATCH: 'context_mismatch',
  OWNERSHIP_FAILED: 'ownership_failed',
  DEPENDENCY_UNAVAILABLE: 'dependency_unavailable',
  DATABASE_ERROR: 'database_error',
});

// The additive V2 columns and their DDL. `auth_version`/`registration_revision`/
// `migration_status` carry NOT NULL defaults so legacy rows and the existing
// unsigned INSERT (which does not list them) stay valid; the signed fields are
// nullable and only populated by the signed path.
const V2_COLUMNS = [
  ['auth_version', "auth_version INTEGER NOT NULL DEFAULT 1"],
  ['registration_revision', "registration_revision INTEGER NOT NULL DEFAULT 0"],
  ['device_token_hash', 'device_token_hash TEXT'],
  ['signed_at', 'signed_at INTEGER'],
  ['migration_status', "migration_status TEXT NOT NULL DEFAULT 'legacy'"],
  ['last_auth_op', 'last_auth_op TEXT'],
];

// Base schema — MUST match notify-server/src/db.js byte-for-byte in column
// names/types so a store-migrated DB is compatible with the live poller/upsert.
// (WP3 will single-source this by having db.js call ensureSchema.)
function baseSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS registrations (
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
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS used_nonces (
      owner    TEXT NOT NULL,
      nonce    TEXT NOT NULL,
      used_at  INTEGER NOT NULL,
      PRIMARY KEY (owner, nonce)
    );
  `);
}

/**
 * Idempotent additive migration of the `registrations` table + the nonce-prune
 * index. Inspects the live column set before each ALTER, adds only missing
 * columns, never drops/recreates a table, never deletes a row, never rewrites
 * notification state or timestamps. Safe on a fresh DB, the exact legacy schema,
 * and repeated runs.
 */
export function migrateRegistrations(db) {
  const cols = new Set(db.prepare('PRAGMA table_info(registrations)').all().map((r) => r.name));
  for (const [name, ddl] of V2_COLUMNS) {
    if (!cols.has(name)) db.exec(`ALTER TABLE registrations ADD COLUMN ${ddl}`);
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_used_nonces_used_at ON used_nonces(used_at)');
}

/** Create base tables (if missing) then apply the additive migration. */
export function ensureSchema(db) {
  baseSchema(db);
  migrateRegistrations(db);
}

/** Read a single registration row (or null). Read-only. */
export function getRegistration(db, vault) {
  return db.prepare('SELECT * FROM registrations WHERE vault = ?').get(vault) || null;
}

/**
 * Atomic signed registration. One SQLite transaction contains nonce claiming AND
 * the registration mutation, so a thrown DB error rolls back BOTH (the caller can
 * retry the same nonce once the DB is healthy).
 *
 * `command` is the normalized, already-authorized command from authorizeRegisterV2.
 * Returns { ok, code, ... }. Never throws (a DB error becomes RESULT.DATABASE_ERROR
 * AFTER the transaction has rolled back).
 */
export function applySignedRegistration(db, command) {
  const claim = db.prepare('INSERT OR IGNORE INTO used_nonces (owner, nonce, used_at) VALUES (?, ?, ?)');
  // Only owner + revision drive the decision; created_at/last_stage/last_notified_at
  // are preserved by being omitted from the UPDATE SET, so we do not read them.
  const read = db.prepare('SELECT owner, registration_revision FROM registrations WHERE vault = ?');
  const insert = db.prepare(`
    INSERT INTO registrations
      (vault, owner, device_token, stage1, stage2, stage3, last_stage, last_notified_at,
       created_at, updated_at, auth_version, registration_revision, device_token_hash,
       signed_at, migration_status, last_auth_op)
    VALUES
      (@vault, @owner, @device_token, @stage1, @stage2, @stage3, 0, 0,
       @now, @now, 2, @revision, @device_token_hash,
       @signed_at, 'signed', 'register')
  `);
  const update = db.prepare(`
    UPDATE registrations SET
      device_token = @device_token,
      stage1 = @stage1, stage2 = @stage2, stage3 = @stage3,
      updated_at = @now,
      auth_version = 2,
      registration_revision = @revision,
      device_token_hash = @device_token_hash,
      signed_at = @signed_at,
      migration_status = 'signed',
      last_auth_op = 'register'
    WHERE vault = @vault
  `);

  const txn = db.transaction((cmd) => {
    const claimed = claim.run(cmd.owner, cmd.nonce, cmd.nonceUsedAt).changes === 1;
    if (!claimed) return { ok: false, code: RESULT.NONCE_REUSED };

    const row = read.get(cmd.vault);
    // A signed request for a vault owned by someone else is a definitive failure:
    // keep the just-consumed nonce (do not let it be replayed) but never overwrite.
    if (row && row.owner !== cmd.owner) return { ok: false, code: RESULT.OWNER_CONFLICT };
    // Anti-rollback: revision must strictly increase. Equal/lower is a definitive
    // stale request; keep the nonce, do not mutate.
    if (row && cmd.revision <= row.registration_revision) return { ok: false, code: RESULT.STALE_REVISION };

    const params = {
      vault: cmd.vault,
      owner: cmd.owner,
      device_token: cmd.deviceToken,
      stage1: cmd.stage1,
      stage2: cmd.stage2,
      stage3: cmd.stage3,
      now: cmd.nonceUsedAt,
      revision: cmd.revision,
      device_token_hash: cmd.deviceTokenHash,
      signed_at: cmd.signedAt,
    };
    if (!row) {
      insert.run(params); // fresh row: notification state initialised as legacy insert does (0/0)
      return { ok: true, code: RESULT.CREATED };
    }
    update.run(params); // existing row: created_at/last_stage/last_notified_at preserved (not in SET)
    return { ok: true, code: RESULT.UPDATED };
  });

  try {
    return txn(command);
  } catch {
    // db.transaction already rolled back the nonce + any mutation before rethrowing.
    return { ok: false, code: RESULT.DATABASE_ERROR };
  }
}

/**
 * Atomic signed deregistration. One transaction: claim nonce → (owner-conflict
 * guard) → delete only by (vault, owner). Idempotent: a missing/already-removed
 * row returns removed=0 with the nonce committed. A DB error rolls back nonce +
 * deletion together.
 */
export function applySignedDeregistration(db, command) {
  const claim = db.prepare('INSERT OR IGNORE INTO used_nonces (owner, nonce, used_at) VALUES (?, ?, ?)');
  const readOwner = db.prepare('SELECT owner FROM registrations WHERE vault = ?');
  const del = db.prepare('DELETE FROM registrations WHERE vault = ? AND owner = ?');

  const txn = db.transaction((cmd) => {
    const claimed = claim.run(cmd.owner, cmd.nonce, cmd.nonceUsedAt).changes === 1;
    if (!claimed) return { ok: false, code: RESULT.NONCE_REUSED };

    const row = readOwner.get(cmd.vault);
    if (row && row.owner !== cmd.owner) return { ok: false, code: RESULT.OWNER_CONFLICT };

    const removed = del.run(cmd.vault, cmd.owner).changes;
    return { ok: true, code: RESULT.REMOVED, removed };
  });

  try {
    return txn(command);
  } catch {
    return { ok: false, code: RESULT.DATABASE_ERROR };
  }
}

/**
 * Prune nonces older than `olderThan` (uses the idx_used_nonces_used_at index).
 *
 * INVARIANT (WP3 callers): `olderThan` MUST stay well behind the signature
 * freshness window. Replay protection is the single-use nonce; freshness is
 * ±SIG_WINDOW_SEC (600s). A nonce may only be pruned once NO still-fresh signed
 * request could still carry it — so pass `olderThan <= now - SIG_WINDOW_SEC` at
 * the very least, and in practice a much larger margin (e.g. now - hours).
 * Pruning younger rows would delete a live nonce and reopen a replay window.
 */
export function pruneNonces(db, olderThan) {
  return db.prepare('DELETE FROM used_nonces WHERE used_at < ?').run(olderThan).changes;
}
