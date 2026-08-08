import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HEARTBEAT_OPERATION_SCHEMA_SQL } from './heartbeatOperationRepoCore.ts';
import { AGENT_ROTATION_SCHEMA_SQL } from './agentRotationRepoCore.ts';
import { AGENT_CANDIDATE_FUNDING_SCHEMA_SQL } from './agentCandidateFundingRepoCore.ts';

// T1.2 — populated pre-Phase-4 database migration.
//
// Phase 4 adds three journal tables and an authoritative cache to a database
// that, on every existing installation, already contains real heartbeat history.
// Unit tests elsewhere use fresh in-memory databases; nothing has opened a
// POPULATED legacy file. This test does, on disk, closing and reopening between
// phases so results reflect persistence rather than connection state.
//
// The legacy fixture below is the verbatim schema from the pre-Phase-4
// `database.ts` at commit cd0264b — SHA-256
// f4dc94ecf383b8281740f1263ff49be9e479706407fe8a2a0d2e7c48a0507d1d — which is
// byte-identical to the v1.13.20 release commit c786064. It is NOT derived by
// subtracting Phase 4 tables from the current schema.

const LEGACY_SCHEMA_SQL = `
    CREATE TABLE IF NOT EXISTS heartbeat_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      method TEXT NOT NULL,
      on_chain_tx TEXT,
      created_at INTEGER DEFAULT (strftime('%s', 'now'))
    );

    CREATE TABLE IF NOT EXISTS escalation_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_stage INTEGER NOT NULL,
      to_stage INTEGER NOT NULL,
      timestamp INTEGER NOT NULL,
      reason TEXT
    );

    CREATE TABLE IF NOT EXISTS execution_steps (
      id TEXT PRIMARY KEY,
      step_order INTEGER NOT NULL,
      type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      description TEXT NOT NULL,
      tx_signature TEXT,
      error TEXT,
      metadata TEXT,
      started_at INTEGER,
      completed_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS price_history (
      mint TEXT NOT NULL,
      price REAL NOT NULL,
      date TEXT NOT NULL,
      PRIMARY KEY (mint, date)
    );

    CREATE TABLE IF NOT EXISTS defi_positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_wallet TEXT NOT NULL,
      protocol TEXT NOT NULL,
      type TEXT NOT NULL,
      description TEXT NOT NULL,
      estimated_value_usd REAL NOT NULL DEFAULT 0,
      estimated_value_sol REAL NOT NULL DEFAULT 0,
      action TEXT NOT NULL DEFAULT 'close',
      account_address TEXT NOT NULL,
      closure_strategy TEXT NOT NULL,
      token_mint TEXT,
      token_amount REAL,
      token_decimals INTEGER,
      tokens_json TEXT,
      updated_at INTEGER DEFAULT (strftime('%s', 'now'))
    );

    CREATE INDEX IF NOT EXISTS idx_heartbeat_timestamp
      ON heartbeat_history(timestamp DESC);

    CREATE INDEX IF NOT EXISTS idx_execution_order
      ON execution_steps(step_order ASC);

    CREATE INDEX IF NOT EXISTS idx_defi_positions_owner
      ON defi_positions(owner_wallet);
`;

const LEGACY_TABLES = [
  'heartbeat_history',
  'escalation_history',
  'execution_steps',
  'settings',
  'price_history',
  'defi_positions',
] as const;

const LEGACY_INDEXES = [
  'idx_heartbeat_timestamp',
  'idx_execution_order',
  'idx_defi_positions_owner',
] as const;

const PHASE4_TABLES = [
  'heartbeat_operations',
  'agent_rotation_operations',
  'agent_candidate_funding_operations',
  'authoritative_heartbeat_cache',
] as const;

const PHASE4_INDEXES = [
  'idx_heartbeat_operation_unresolved',
  'idx_heartbeat_operation_updated',
  'idx_agent_rotation_unresolved',
  'idx_agent_rotation_updated',
  'idx_candidate_funding_unresolved',
] as const;

const ORDER_BY: Record<string, string> = {
  heartbeat_history: 'id',
  escalation_history: 'id',
  execution_steps: 'id',
  settings: 'key',
  price_history: 'mint, date',
  defi_positions: 'id',
};

/**
 * Resolves the ACTUAL migration SQL shipped by database.ts, rather than a copy
 * that could silently drift from production. The file body is read at runtime,
 * the single execAsync template is extracted, and the three schema constants are
 * substituted with their real imported values.
 */
function resolveCurrentMigrationSql(): string {
  const path = fileURLToPath(new URL('./database.ts', import.meta.url));
  const source = readFileSync(path, 'utf8');
  const match = source.match(/await db\.execAsync\(`([\s\S]*?)`\);/);
  assert.ok(match, 'could not extract the execAsync template from database.ts');
  const substitutions: Record<string, string> = {
    '${HEARTBEAT_OPERATION_SCHEMA_SQL}': HEARTBEAT_OPERATION_SCHEMA_SQL,
    '${AGENT_ROTATION_SCHEMA_SQL}': AGENT_ROTATION_SCHEMA_SQL,
    '${AGENT_CANDIDATE_FUNDING_SCHEMA_SQL}': AGENT_CANDIDATE_FUNDING_SCHEMA_SQL,
  };
  let resolved = match[1];
  for (const [token, value] of Object.entries(substitutions)) {
    resolved = resolved.split(token).join(value);
  }
  // If production ever grows an interpolation this test does not know about,
  // fail loudly rather than execute SQL containing a literal ${...}.
  assert.equal(
    /\$\{/.test(resolved),
    false,
    'unresolved interpolation remains in the extracted migration SQL',
  );
  return resolved;
}

interface Workspace {
  dir: string;
  file: string;
}

function createWorkspace(): Workspace {
  const dir = mkdtempSync(join(tmpdir(), 'dmv-t12-'));
  return { dir, file: join(dir, 'deadmansvault.db') };
}

function open(workspace: Workspace): DatabaseSync {
  return new DatabaseSync(workspace.file);
}

function destroy(workspace: Workspace): void {
  rmSync(workspace.dir, { recursive: true, force: true });
}

function rows(db: DatabaseSync, sql: string): Array<Record<string, unknown>> {
  return db.prepare(sql).all() as Array<Record<string, unknown>>;
}

function integrityCheck(db: DatabaseSync): unknown {
  const result = db.prepare('PRAGMA integrity_check').get() as Record<string, unknown>;
  return result.integrity_check;
}

function tableInfo(db: DatabaseSync, table: string): Array<Record<string, unknown>> {
  return rows(db, `PRAGMA table_info(${table})`);
}

function indexDefinition(db: DatabaseSync, name: string): string | null {
  const found = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?`)
    .get(name) as { sql?: string } | undefined;
  return found?.sql ?? null;
}

function objectExists(db: DatabaseSync, type: string, name: string): boolean {
  const found = db
    .prepare(`SELECT 1 AS present FROM sqlite_master WHERE type = ? AND name = ?`)
    .get(type, name);
  return Boolean(found);
}

/** Deterministic snapshot of legacy data + shape only. Excludes Phase 4 objects. */
function legacySnapshot(db: DatabaseSync): string {
  const payload: Record<string, unknown> = {};
  for (const table of LEGACY_TABLES) {
    payload[`rows:${table}`] = rows(
      db,
      `SELECT * FROM ${table} ORDER BY ${ORDER_BY[table]}`,
    );
    payload[`info:${table}`] = tableInfo(db, table);
  }
  for (const index of LEGACY_INDEXES) {
    payload[`index:${index}`] = indexDefinition(db, index);
  }
  payload['sqlite_sequence'] = rows(
    db,
    `SELECT name, seq FROM sqlite_sequence ORDER BY name`,
  );
  return JSON.stringify(payload);
}

/** Everything, including Phase 4 objects — used for idempotency comparison. */
function fullSnapshot(db: DatabaseSync): string {
  const payload: Record<string, unknown> = {
    schema: rows(
      db,
      `SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name`,
    ),
    legacy: legacySnapshot(db),
  };
  for (const table of PHASE4_TABLES) {
    payload[`rows:${table}`] = rows(db, `SELECT * FROM ${table}`);
  }
  return JSON.stringify(payload);
}

function populateLegacy(db: DatabaseSync): void {
  const heartbeat = db.prepare(
    `INSERT INTO heartbeat_history (id, timestamp, method, on_chain_tx, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  heartbeat.run(1, 1751000000, 'active_tap', null, 1751000001);
  heartbeat.run(2, 1751086400, 'active_tap', '4pre9RnEXAMPLEsigAAAAAAAAAAAAAAAAAAAAAAAAAAA', 1751086401);
  heartbeat.run(3, 1751172800, 'biometric_confirm', null, 1751172801);
  heartbeat.run(4, 1751259200, 'active_tap', '5pre9RnEXAMPLEsigBBBBBBBBBBBBBBBBBBBBBBBBBBB', 1751259201);

  const escalation = db.prepare(
    `INSERT INTO escalation_history (id, from_stage, to_stage, timestamp, reason)
     VALUES (?, ?, ?, ?, ?)`,
  );
  escalation.run(1, 0, 1, 1751300000, 'heartbeat overdue');
  escalation.run(2, 1, 2, 1751400000, null);
  escalation.run(3, 2, 0, 1751500000, 'heartbeat received');

  const step = db.prepare(
    `INSERT INTO execution_steps
       (id, step_order, type, status, description, tx_signature, error, metadata, started_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  step.run('step-pending', 1, 'begin_execution', 'pending', 'Begin execution', null, null, null, null, null);
  step.run('step-failed', 2, 'execute_sol_shares', 'failed', 'Distribute SOL', null, 'simulated failure', '{"indices":[0,1]}', 1751600000, null);
  step.run('step-done', 3, 'finalize_execution', 'completed', 'Finalize', '6pre9RnEXAMPLEsigCCCCCCCCCCCCCCCCCCCCCCCCCCC', null, '{"bounty":true}', 1751600100, 1751600200);

  const setting = db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)`);
  setting.run('demo_mode', 'false');
  setting.run('custom_rpc_url', '');
  setting.run('onboarding_complete', 'true');

  const price = db.prepare(
    `INSERT INTO price_history (mint, price, date) VALUES (?, ?, ?)`,
  );
  price.run('So11111111111111111111111111111111111111112', 152.25, '2026-07-01');
  price.run('So11111111111111111111111111111111111111112', 149.8, '2026-07-02');
  price.run('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 1.0, '2026-07-01');
  price.run('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 0.9998, '2026-07-02');

  const position = db.prepare(
    `INSERT INTO defi_positions
       (id, owner_wallet, protocol, type, description, estimated_value_usd,
        estimated_value_sol, action, account_address, closure_strategy,
        token_mint, token_amount, token_decimals, tokens_json, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  position.run(
    1, 'OwnerDisposable1111111111111111111111111111', 'kamino', 'lend',
    'Kamino lending position', 120.5, 0.79, 'close',
    'AcctDisposable111111111111111111111111111111', 'withdraw',
    null, null, null, null, 1751700000,
  );
  position.run(
    2, 'OwnerDisposable2222222222222222222222222222', 'orca', 'lp',
    'Orca LP position', 340.75, 2.24, 'close',
    'AcctDisposable222222222222222222222222222222', 'decrease_liquidity',
    'So11111111111111111111111111111111111111112', 1.5, 9,
    '[{"mint":"So11111111111111111111111111111111111111112","amount":1.5}]',
    1751700100,
  );
}

const LEGACY_ROW_COUNTS: Record<string, number> = {
  heartbeat_history: 4,
  escalation_history: 3,
  execution_steps: 3,
  settings: 3,
  price_history: 4,
  defi_positions: 2,
};

/** Builds a populated legacy database, closed and ready to be reopened. */
function buildPopulatedLegacyDatabase(): Workspace {
  const workspace = createWorkspace();
  const db = open(workspace);
  db.exec(LEGACY_SCHEMA_SQL);
  populateLegacy(db);
  db.close();
  return workspace;
}

const MIGRATION_SQL = resolveCurrentMigrationSql();

const IDENTITY = {
  cluster: 'devnet',
  programId: 'GXCu5964mvgAJDWmcMriZpzU3vDVqPzjYCM1sxCnsoEb',
  owner: 'OwnerDisposable1111111111111111111111111111',
  vault: 'VaultDisposable1111111111111111111111111111',
  heartbeat: 'HbDisposable11111111111111111111111111111111',
  agent: 'AgentDisposable111111111111111111111111111',
  candidate: 'CandDisposable1111111111111111111111111111',
};

const BIG_U64 = '18446744073709551615';

function insertHeartbeatOperation(
  db: DatabaseSync,
  signature: string,
  state: string,
): void {
  db.prepare(
    `INSERT INTO heartbeat_operations (
       operation_id, schema_version, cluster, program_id, owner, vault, heartbeat,
       agent_pubkey, method, method_index, signature, blockhash,
       last_valid_block_height, before_last_heartbeat, before_total_heartbeats,
       heartbeat_interval, grace_period, state, created_at, updated_at,
       local_sync_state
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    signature, 1, IDENTITY.cluster, IDENTITY.programId, IDENTITY.owner,
    IDENTITY.vault, IDENTITY.heartbeat, IDENTITY.agent, 'active_tap', 0,
    signature, 'BlockhashDisposable1111111111111111111111', 1000,
    1751000000, BIG_U64, 86400, 604800, state, 1751000000, 1751000000,
    'not_started',
  );
}

function insertRotationOperation(
  db: DatabaseSync,
  signature: string,
  state: string,
): void {
  db.prepare(
    `INSERT INTO agent_rotation_operations (
       operation_id, schema_version, cluster, program_id, owner, vault, heartbeat,
       old_agent, candidate_agent, candidate_slot_id, signature, blockhash,
       last_valid_block_height, before_last_heartbeat, before_total_heartbeats,
       before_vault_updated_at, before_final_deadline, before_config_fingerprint,
       state, created_at, updated_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    signature, 1, IDENTITY.cluster, IDENTITY.programId, IDENTITY.owner,
    IDENTITY.vault, IDENTITY.heartbeat, IDENTITY.agent, IDENTITY.candidate,
    'candidate', signature, 'BlockhashDisposable1111111111111111111111', 1000,
    1751000000, BIG_U64, 1751000000, 1752300000, 'fingerprint-disposable',
    state, 1751000000, 1751000000,
  );
}

function insertFundingOperation(
  db: DatabaseSync,
  signature: string,
  state: string,
): void {
  db.prepare(
    `INSERT INTO agent_candidate_funding_operations (
       operation_id, schema_version, cluster, program_id, owner, vault,
       candidate_agent, signature, blockhash, last_valid_block_height,
       transfer_lamports, state, created_at, updated_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    signature, 1, IDENTITY.cluster, IDENTITY.programId, IDENTITY.owner,
    IDENTITY.vault, IDENTITY.candidate, signature,
    'BlockhashDisposable1111111111111111111111', 1000, 5000000, state,
    1751000000, 1751000000,
  );
}

function rejects(action: () => void): string {
  try {
    action();
  } catch (error: unknown) {
    return (error as { code?: string }).code ?? 'ERROR';
  }
  return '';
}

test('the migration SQL is extracted from database.ts with every interpolation resolved', () => {
  assert.ok(MIGRATION_SQL.length > 0);
  assert.equal(/\$\{/.test(MIGRATION_SQL), false);
  // Proves the real constants were substituted, not a hand-copied approximation.
  assert.ok(MIGRATION_SQL.includes('CREATE TABLE IF NOT EXISTS heartbeat_operations'));
  assert.ok(MIGRATION_SQL.includes('CREATE TABLE IF NOT EXISTS agent_rotation_operations'));
  assert.ok(
    MIGRATION_SQL.includes('CREATE TABLE IF NOT EXISTS agent_candidate_funding_operations'),
  );
  assert.ok(MIGRATION_SQL.includes('idx_heartbeat_operation_unresolved'));
});

test('a populated legacy database survives the first migration unchanged', () => {
  const workspace = buildPopulatedLegacyDatabase();
  try {
    assert.equal(existsSync(workspace.file), true, 'must be a real file-backed database');

    let db = open(workspace);
    for (const [table, count] of Object.entries(LEGACY_ROW_COUNTS)) {
      const found = db.prepare(`SELECT count(*) AS c FROM ${table}`).get() as { c: number };
      assert.equal(found.c, count, `${table} fixture row count`);
    }
    const before = legacySnapshot(db);
    assert.equal(integrityCheck(db), 'ok');
    db.close();

    db = open(workspace);
    db.exec(MIGRATION_SQL);
    db.close();

    db = open(workspace);
    assert.equal(
      legacySnapshot(db),
      before,
      'legacy rows, column definitions, indexes and sequences must be identical',
    );
    for (const table of LEGACY_TABLES) {
      assert.equal(objectExists(db, 'table', table), true, `${table} must survive`);
    }
    for (const index of LEGACY_INDEXES) {
      assert.notEqual(indexDefinition(db, index), null, `${index} must survive`);
    }
    assert.equal(integrityCheck(db), 'ok');
    db.close();
  } finally {
    destroy(workspace);
  }
});

test('the first migration creates every Phase 4 table, column and index', () => {
  const workspace = buildPopulatedLegacyDatabase();
  try {
    let db = open(workspace);
    db.exec(MIGRATION_SQL);
    db.close();

    db = open(workspace);
    for (const table of PHASE4_TABLES) {
      assert.equal(objectExists(db, 'table', table), true, `${table} must exist`);
      assert.ok(tableInfo(db, table).length > 0, `${table} must have columns`);
    }

    // Column-level verification, not just table presence.
    const heartbeatColumns = tableInfo(db, 'heartbeat_operations');
    const signature = heartbeatColumns.find((column) => column.name === 'signature');
    assert.equal(signature?.notnull, 1, 'signature must be NOT NULL');
    const totals = heartbeatColumns.find(
      (column) => column.name === 'before_total_heartbeats',
    );
    assert.equal(totals?.type, 'TEXT', 'u64 counts must be stored as TEXT');
    assert.equal(
      heartbeatColumns.find((column) => column.name === 'operation_id')?.pk,
      1,
      'operation_id must be the primary key',
    );
    assert.equal(
      heartbeatColumns.find((column) => column.name === 'safe_error_code')?.notnull,
      0,
      'safe_error_code must be nullable',
    );

    const cacheColumns = tableInfo(db, 'authoritative_heartbeat_cache');
    const cachePk = cacheColumns
      .filter((column) => Number(column.pk) > 0)
      .map((column) => column.name)
      .sort();
    assert.deepEqual(cachePk, ['cluster', 'owner', 'program_id', 'vault']);

    // Index definitions, including the partial predicates.
    for (const index of PHASE4_INDEXES) {
      assert.notEqual(indexDefinition(db, index), null, `${index} must exist`);
    }
    const heartbeatPartial = indexDefinition(db, 'idx_heartbeat_operation_unresolved');
    assert.ok(heartbeatPartial?.includes('UNIQUE'));
    assert.ok(heartbeatPartial?.includes('WHERE'));
    assert.ok(heartbeatPartial?.includes('post_state_unverified'));
    const rotationPartial = indexDefinition(db, 'idx_agent_rotation_unresolved');
    assert.ok(rotationPartial?.includes('UNIQUE'));
    assert.ok(rotationPartial?.includes('recovery_required'));
    const fundingPartial = indexDefinition(db, 'idx_candidate_funding_unresolved');
    assert.ok(fundingPartial?.includes('UNIQUE'));
    assert.ok(fundingPartial?.includes('candidate_agent'));

    assert.equal(integrityCheck(db), 'ok');
    db.close();
  } finally {
    destroy(workspace);
  }
});

test('heartbeat history remains writable after migration', () => {
  const workspace = buildPopulatedLegacyDatabase();
  try {
    let db = open(workspace);
    db.exec(MIGRATION_SQL);
    db.close();

    db = open(workspace);
    const before = rows(db, 'SELECT * FROM heartbeat_history ORDER BY id');
    db.prepare(
      `INSERT INTO heartbeat_history (timestamp, method, on_chain_tx, created_at)
       VALUES (?, ?, ?, ?)`,
    ).run(1751345600, 'active_tap', '7pre9RnEXAMPLEsigDDDDDDDDDDDDDDDDDDDDDDDDDDD', 1751345601);

    const inserted = db
      .prepare('SELECT * FROM heartbeat_history WHERE id = ?')
      .get(5) as Record<string, unknown>;
    assert.equal(inserted.id, 5, 'AUTOINCREMENT must continue after the legacy rows');
    assert.equal(inserted.timestamp, 1751345600);
    assert.equal(inserted.method, 'active_tap');
    assert.equal(
      inserted.on_chain_tx,
      '7pre9RnEXAMPLEsigDDDDDDDDDDDDDDDDDDDDDDDDDDD',
    );
    assert.equal(inserted.created_at, 1751345601);

    const after = rows(db, 'SELECT * FROM heartbeat_history WHERE id <= 4 ORDER BY id');
    assert.deepEqual(after, before, 'older heartbeat rows must be untouched');
    db.close();
  } finally {
    destroy(workspace);
  }
});

test('running the migration a second time is idempotent', () => {
  const workspace = buildPopulatedLegacyDatabase();
  try {
    let db = open(workspace);
    db.exec(MIGRATION_SQL);
    db.close();

    db = open(workspace);
    // Journal rows are present before the second run so idempotency is proven
    // against a populated new schema, not just empty tables.
    insertHeartbeatOperation(db, 'SigIdempotentHeartbeat1111111111111111111111', 'prepared');
    insertRotationOperation(db, 'SigIdempotentRotation11111111111111111111111', 'prepared');
    insertFundingOperation(db, 'SigIdempotentFunding111111111111111111111111', 'prepared');
    const afterFirst = fullSnapshot(db);
    db.close();

    db = open(workspace);
    db.exec(MIGRATION_SQL);
    db.close();

    db = open(workspace);
    assert.equal(
      fullSnapshot(db),
      afterFirst,
      'second migration must not alter schema or data',
    );
    const duplicateObjects = rows(
      db,
      `SELECT name, count(*) AS c FROM sqlite_master GROUP BY name HAVING c > 1`,
    );
    assert.deepEqual(duplicateObjects, [], 'no duplicated tables or indexes');
    assert.equal(integrityCheck(db), 'ok');
    db.close();
  } finally {
    destroy(workspace);
  }
});

test('heartbeat_operations enforces one unresolved operation per identity', () => {
  const workspace = buildPopulatedLegacyDatabase();
  try {
    let db = open(workspace);
    db.exec(MIGRATION_SQL);
    db.close();

    db = open(workspace);
    insertHeartbeatOperation(db, 'SigHbUnresolvedAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'prepared');

    // A second unresolved operation for the same identity must be refused.
    assert.notEqual(
      rejects(() =>
        insertHeartbeatOperation(db, 'SigHbUnresolvedBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', 'submitted'),
      ),
      '',
      'a second unresolved heartbeat operation must fail',
    );

    // Terminal records may coexist with an unresolved one.
    insertHeartbeatOperation(db, 'SigHbTerminalCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC', 'resolved_confirmed');
    insertHeartbeatOperation(db, 'SigHbTerminalDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD', 'resolved_failed');

    // Duplicate signatures must still fail regardless of state.
    assert.notEqual(
      rejects(() =>
        insertHeartbeatOperation(db, 'SigHbTerminalCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC', 'resolved_failed'),
      ),
      '',
      'duplicate signature must fail',
    );

    // After resolution a new unresolved operation is permitted again.
    db.prepare(`UPDATE heartbeat_operations SET state = ? WHERE signature = ?`).run(
      'resolved_confirmed',
      'SigHbUnresolvedAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    );
    insertHeartbeatOperation(db, 'SigHbUnresolvedEEEEEEEEEEEEEEEEEEEEEEEEEEEEE', 'prepared');
    db.close();
  } finally {
    destroy(workspace);
  }
});

test('agent_rotation_operations enforces one unresolved rotation per identity', () => {
  const workspace = buildPopulatedLegacyDatabase();
  try {
    let db = open(workspace);
    db.exec(MIGRATION_SQL);
    db.close();

    db = open(workspace);
    insertRotationOperation(db, 'SigRotUnresolvedAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'prepared');

    assert.notEqual(
      rejects(() =>
        insertRotationOperation(db, 'SigRotUnresolvedBBBBBBBBBBBBBBBBBBBBBBBBBBBB', 'rotation_confirmed'),
      ),
      '',
      'a second unresolved rotation must fail',
    );

    insertRotationOperation(db, 'SigRotTerminalCCCCCCCCCCCCCCCCCCCCCCCCCCCCC', 'candidate_promoted');
    insertRotationOperation(db, 'SigRotTerminalDDDDDDDDDDDDDDDDDDDDDDDDDDDDD', 'resolved_failed');

    assert.notEqual(
      rejects(() =>
        insertRotationOperation(db, 'SigRotTerminalCCCCCCCCCCCCCCCCCCCCCCCCCCCCC', 'resolved_failed'),
      ),
      '',
      'duplicate signature must fail',
    );

    db.prepare(`UPDATE agent_rotation_operations SET state = ? WHERE signature = ?`).run(
      'candidate_promoted',
      'SigRotUnresolvedAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    );
    insertRotationOperation(db, 'SigRotUnresolvedEEEEEEEEEEEEEEEEEEEEEEEEEEEE', 'prepared');
    db.close();
  } finally {
    destroy(workspace);
  }
});

test('agent_candidate_funding_operations enforces one unresolved funding per identity', () => {
  const workspace = buildPopulatedLegacyDatabase();
  try {
    let db = open(workspace);
    db.exec(MIGRATION_SQL);
    db.close();

    db = open(workspace);
    insertFundingOperation(db, 'SigFundUnresolvedAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'prepared');

    assert.notEqual(
      rejects(() =>
        insertFundingOperation(db, 'SigFundUnresolvedBBBBBBBBBBBBBBBBBBBBBBBBBBB', 'submitted'),
      ),
      '',
      'a second unresolved funding operation must fail',
    );

    insertFundingOperation(db, 'SigFundTerminalCCCCCCCCCCCCCCCCCCCCCCCCCCCC', 'resolved_confirmed');
    insertFundingOperation(db, 'SigFundTerminalDDDDDDDDDDDDDDDDDDDDDDDDDDDD', 'resolved_expired');

    assert.notEqual(
      rejects(() =>
        insertFundingOperation(db, 'SigFundTerminalCCCCCCCCCCCCCCCCCCCCCCCCCCCC', 'resolved_failed'),
      ),
      '',
      'duplicate signature must fail',
    );

    db.prepare(
      `UPDATE agent_candidate_funding_operations SET state = ? WHERE signature = ?`,
    ).run('resolved_confirmed', 'SigFundUnresolvedAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    insertFundingOperation(db, 'SigFundUnresolvedEEEEEEEEEEEEEEEEEEEEEEEEEEE', 'prepared');
    db.close();
  } finally {
    destroy(workspace);
  }
});

test('journal rows survive close and reopen with exact text affinity', () => {
  const workspace = buildPopulatedLegacyDatabase();
  try {
    let db = open(workspace);
    db.exec(MIGRATION_SQL);
    insertHeartbeatOperation(db, 'SigAffinityHeartbeatAAAAAAAAAAAAAAAAAAAAAAAA', 'prepared');
    insertRotationOperation(db, 'SigAffinityRotationBBBBBBBBBBBBBBBBBBBBBBBBB', 'prepared');
    insertFundingOperation(db, 'SigAffinityFundingCCCCCCCCCCCCCCCCCCCCCCCCCC', 'prepared');
    db.prepare(
      `INSERT INTO authoritative_heartbeat_cache
         (cluster, program_id, owner, vault, heartbeat, timestamp, method,
          total_heartbeats, source, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      IDENTITY.cluster, IDENTITY.programId, IDENTITY.owner, IDENTITY.vault,
      IDENTITY.heartbeat, 1751000000, 'active_tap', BIG_U64,
      'chain_advanced_unattributed', 1751000000,
    );
    db.close();

    db = open(workspace);
    const heartbeat = db
      .prepare('SELECT * FROM heartbeat_operations WHERE signature = ?')
      .get('SigAffinityHeartbeatAAAAAAAAAAAAAAAAAAAAAAAA') as Record<string, unknown>;
    // A u64 beyond IEEE-754 exactness must come back as the identical string.
    assert.equal(typeof heartbeat.before_total_heartbeats, 'string');
    assert.equal(heartbeat.before_total_heartbeats, BIG_U64);
    assert.equal(heartbeat.safe_error_code, null);
    assert.equal(heartbeat.resolved_last_heartbeat, null);
    assert.equal(heartbeat.resolved_total_heartbeats, null);
    assert.equal(heartbeat.last_checked_at, null);

    const rotation = db
      .prepare('SELECT * FROM agent_rotation_operations WHERE signature = ?')
      .get('SigAffinityRotationBBBBBBBBBBBBBBBBBBBBBBBBB') as Record<string, unknown>;
    assert.equal(rotation.before_total_heartbeats, BIG_U64);
    assert.equal(rotation.safe_error_code, null);
    assert.equal(rotation.resolved_agent, null);

    const funding = db
      .prepare('SELECT * FROM agent_candidate_funding_operations WHERE signature = ?')
      .get('SigAffinityFundingCCCCCCCCCCCCCCCCCCCCCCCCCC') as Record<string, unknown>;
    assert.equal(funding.transfer_lamports, 5000000);
    assert.equal(funding.safe_error_code, null);
    assert.equal(funding.last_checked_at, null);

    const cache = db
      .prepare('SELECT * FROM authoritative_heartbeat_cache WHERE vault = ?')
      .get(IDENTITY.vault) as Record<string, unknown>;
    assert.equal(typeof cache.total_heartbeats, 'string');
    assert.equal(cache.total_heartbeats, BIG_U64);

    assert.equal(integrityCheck(db), 'ok');
    db.close();
  } finally {
    destroy(workspace);
  }
});
