import * as SQLite from 'expo-sqlite';
import { HEARTBEAT_OPERATION_SCHEMA_SQL } from './heartbeatOperationRepoCore';
import { AGENT_ROTATION_SCHEMA_SQL } from './agentRotationRepoCore';
import { AGENT_CANDIDATE_FUNDING_SCHEMA_SQL } from './agentCandidateFundingRepoCore';

let db: SQLite.SQLiteDatabase | null = null;

export async function initDatabase(): Promise<void> {
  db = await SQLite.openDatabaseAsync('deadmansvault.db');

  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS heartbeat_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      method TEXT NOT NULL,
      on_chain_tx TEXT,
      created_at INTEGER DEFAULT (strftime('%s', 'now'))
    );

    ${HEARTBEAT_OPERATION_SCHEMA_SQL}
    ${AGENT_ROTATION_SCHEMA_SQL}
    ${AGENT_CANDIDATE_FUNDING_SCHEMA_SQL}

    CREATE TABLE IF NOT EXISTS authoritative_heartbeat_cache (
      cluster TEXT NOT NULL,
      program_id TEXT NOT NULL,
      owner TEXT NOT NULL,
      vault TEXT NOT NULL,
      heartbeat TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      method TEXT NOT NULL,
      total_heartbeats TEXT NOT NULL,
      source TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (cluster, program_id, owner, vault)
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
  `);
}

export function getDb(): SQLite.SQLiteDatabase {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return db;
}
