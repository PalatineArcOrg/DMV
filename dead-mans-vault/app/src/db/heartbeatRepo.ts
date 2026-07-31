import { getDb } from './database';
import { HeartbeatMethod } from '../types/heartbeat';
import {
  insertConfirmedHeartbeat,
  insertNonAuthoritativeLocalHeartbeat,
  type ConfirmedHeartbeatInsert,
} from './heartbeatRepoCore';

export interface HeartbeatHistoryEntry {
  id: number;
  timestamp: number;
  method: string;
  onChainTx: string | null;
  createdAt: number;
}

export async function recordConfirmedHeartbeat(
  input: ConfirmedHeartbeatInsert,
): Promise<void> {
  const db = getDb();
  await insertConfirmedHeartbeat(input, async (statement, values) => {
    await db.runAsync(statement, values);
  });
}

export async function recordNonAuthoritativeLocalHeartbeat(
  method: HeartbeatMethod,
): Promise<void> {
  const db = getDb();
  const timestamp = Math.floor(Date.now() / 1000);
  await insertNonAuthoritativeLocalHeartbeat(
    method,
    timestamp,
    async (statement, values) => {
      await db.runAsync(statement, values);
    },
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

export async function clearHeartbeatHistory(): Promise<void> {
  const db = getDb();
  await db.runAsync('DELETE FROM heartbeat_history');
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
