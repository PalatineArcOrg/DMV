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

export interface AuthoritativeHeartbeatCacheInput {
  cluster: string;
  programId: string;
  owner: string;
  vault: string;
  heartbeat: string;
  timestamp: number;
  method: HeartbeatMethod;
  totalHeartbeats: bigint;
  source: 'chain_advanced_unattributed';
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
    `SELECT timestamp, method FROM (
       SELECT timestamp, method FROM heartbeat_history
       UNION ALL
       SELECT timestamp, method FROM authoritative_heartbeat_cache
     ) ORDER BY timestamp DESC LIMIT 1`,
  );
  return row ?? null;
}

export async function recordAuthoritativeHeartbeatCache(
  input: AuthoritativeHeartbeatCacheInput,
): Promise<void> {
  if (!Number.isSafeInteger(input.timestamp) || input.timestamp < 0) {
    throw new Error('Authoritative heartbeat timestamp is invalid');
  }
  const count = input.totalHeartbeats.toString(10);
  if (!/^(0|[1-9][0-9]{0,19})$/.test(count)) {
    throw new Error('Authoritative heartbeat count is invalid');
  }
  await getDb().runAsync(
    `INSERT INTO authoritative_heartbeat_cache (
       cluster, program_id, owner, vault, heartbeat, timestamp, method,
       total_heartbeats, source, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(cluster, program_id, owner, vault) DO UPDATE SET
       heartbeat = excluded.heartbeat,
       timestamp = excluded.timestamp,
       method = excluded.method,
       total_heartbeats = excluded.total_heartbeats,
       source = excluded.source,
       updated_at = excluded.updated_at
     WHERE excluded.timestamp >= authoritative_heartbeat_cache.timestamp`,
    [
      input.cluster,
      input.programId,
      input.owner,
      input.vault,
      input.heartbeat,
      input.timestamp,
      input.method,
      count,
      input.source,
      Math.floor(Date.now() / 1000),
    ],
  );
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
