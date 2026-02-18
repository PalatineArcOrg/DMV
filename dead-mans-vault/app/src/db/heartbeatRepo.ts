import { getDb } from './database';
import { HeartbeatMethod } from '../types/heartbeat';

export interface HeartbeatHistoryEntry {
  id: number;
  timestamp: number;
  method: string;
  onChainTx: string | null;
  createdAt: number;
}

export async function recordHeartbeat(
  method: HeartbeatMethod,
  onChainTx?: string,
): Promise<void> {
  const db = getDb();
  const timestamp = Math.floor(Date.now() / 1000);
  await db.runAsync(
    'INSERT INTO heartbeat_history (timestamp, method, on_chain_tx) VALUES (?, ?, ?)',
    [timestamp, method, onChainTx ?? null],
  );
}

export async function getLastHeartbeat(): Promise<{
  timestamp: number;
  method: string;
} | null> {
  const db = getDb();
  const row = await db.getFirstAsync<{ timestamp: number; method: string }>(
    'SELECT timestamp, method FROM heartbeat_history ORDER BY timestamp DESC LIMIT 1',
  );
  return row ?? null;
}

export async function getHeartbeatCount(): Promise<number> {
  const db = getDb();
  const row = await db.getFirstAsync<{ count: number }>(
    'SELECT COUNT(*) as count FROM heartbeat_history',
  );
  return row?.count ?? 0;
}

export async function getHeartbeatHistory(
  limit: number = 50,
): Promise<HeartbeatHistoryEntry[]> {
  const db = getDb();
  return db.getAllAsync<HeartbeatHistoryEntry>(
    `SELECT id, timestamp, method, on_chain_tx as onChainTx, created_at as createdAt
     FROM heartbeat_history ORDER BY timestamp DESC LIMIT ?`,
    [limit],
  );
}
