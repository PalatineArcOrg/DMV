import * as SQLite from 'expo-sqlite';

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

    CREATE INDEX IF NOT EXISTS idx_heartbeat_timestamp
      ON heartbeat_history(timestamp DESC);

    CREATE INDEX IF NOT EXISTS idx_execution_order
      ON execution_steps(step_order ASC);
  `);
}

export function getDb(): SQLite.SQLiteDatabase {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return db;
}
