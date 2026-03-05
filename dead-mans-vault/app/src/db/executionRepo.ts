import { getDb } from './database';
import { ExecutionStep, ExecutionStepStatus } from '../types/execution';

/**
 * All execution state is scoped to owner wallet address to prevent
 * cross-wallet pollution when switching between wallets on the same device.
 */

export async function saveExecutionStep(step: ExecutionStep, ownerWallet: string): Promise<void> {
  const db = getDb();
  const scopedId = `${ownerWallet}_${step.id}`;
  await db.runAsync(
    `INSERT OR REPLACE INTO execution_steps
      (id, step_order, type, status, description, tx_signature, error, metadata, started_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      scopedId,
      step.order,
      step.type,
      step.status,
      step.description,
      step.txSignature ?? null,
      step.error ?? null,
      step.metadata ? JSON.stringify(step.metadata) : null,
      step.startedAt ?? null,
      step.completedAt ?? null,
    ],
  );
}

export async function getExecutionSteps(ownerWallet?: string): Promise<ExecutionStep[]> {
  const db = getDb();
  const query = ownerWallet
    ? `SELECT * FROM execution_steps WHERE id LIKE ? ORDER BY step_order ASC`
    : `SELECT * FROM execution_steps ORDER BY step_order ASC`;
  const params = ownerWallet ? [`${ownerWallet}_%`] : [];

  const rows = await db.getAllAsync<{
    id: string;
    step_order: number;
    type: string;
    status: string;
    description: string;
    tx_signature: string | null;
    error: string | null;
    metadata: string | null;
    started_at: number | null;
    completed_at: number | null;
  }>(query, params);

  return rows.map((row) => ({
    id: row.id,
    order: row.step_order,
    type: row.type as ExecutionStep['type'],
    status: row.status as ExecutionStepStatus,
    description: row.description,
    txSignature: row.tx_signature ?? undefined,
    error: row.error ?? undefined,
    metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
  }));
}

export async function getLastCompletedStep(ownerWallet: string): Promise<number> {
  const db = getDb();
  const row = await db.getFirstAsync<{ step_order: number }>(
    `SELECT step_order FROM execution_steps
     WHERE status = 'completed' AND id LIKE ?
     ORDER BY step_order DESC LIMIT 1`,
    [`${ownerWallet}_%`],
  );
  return row?.step_order ?? -1;
}

export async function getDistributableSnapshot(ownerWallet: string): Promise<number | null> {
  const db = getDb();
  const row = await db.getFirstAsync<{ value: string }>(
    `SELECT value FROM settings WHERE key = ?`,
    [`distributable_snapshot_${ownerWallet}`],
  );
  return row ? Number(row.value) : null;
}

export async function saveDistributableSnapshot(amount: number, ownerWallet: string): Promise<void> {
  const db = getDb();
  await db.runAsync(
    `INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`,
    [`distributable_snapshot_${ownerWallet}`, String(amount)],
  );
}

export async function clearDistributableSnapshot(ownerWallet: string): Promise<void> {
  const db = getDb();
  await db.runAsync(
    `DELETE FROM settings WHERE key = ?`,
    [`distributable_snapshot_${ownerWallet}`],
  );
}

export interface TokenSnapshotEntry {
  mint: string;
  amount: number;
  decimals: number;
  symbol: string;
}

export async function saveTokenSnapshot(tokens: TokenSnapshotEntry[], ownerWallet: string): Promise<void> {
  const db = getDb();
  await db.runAsync(
    `INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`,
    [`token_snapshot_${ownerWallet}`, JSON.stringify(tokens)],
  );
}

export async function getTokenSnapshot(ownerWallet: string): Promise<TokenSnapshotEntry[] | null> {
  const db = getDb();
  const row = await db.getFirstAsync<{ value: string }>(
    `SELECT value FROM settings WHERE key = ?`,
    [`token_snapshot_${ownerWallet}`],
  );
  return row ? JSON.parse(row.value) : null;
}

export async function clearTokenSnapshot(ownerWallet: string): Promise<void> {
  const db = getDb();
  await db.runAsync(
    `DELETE FROM settings WHERE key = ?`,
    [`token_snapshot_${ownerWallet}`],
  );
}

export async function updateStepStatus(
  id: string,
  status: ExecutionStepStatus,
  txSignature?: string,
  error?: string,
): Promise<void> {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const completedAt = status === 'completed' ? now : null;

  await db.runAsync(
    `UPDATE execution_steps
     SET status = ?, tx_signature = COALESCE(?, tx_signature),
         error = COALESCE(?, error),
         started_at = CASE WHEN ? = 'in_progress' THEN ? ELSE started_at END,
         completed_at = COALESCE(?, completed_at)
     WHERE id = ?`,
    [status, txSignature ?? null, error ?? null, status, now, completedAt, id],
  );
}
