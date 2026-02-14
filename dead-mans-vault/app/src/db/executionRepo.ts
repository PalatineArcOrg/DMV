import { getDb } from './database';
import { ExecutionStep, ExecutionStepStatus } from '../types/execution';

export async function saveExecutionStep(step: ExecutionStep): Promise<void> {
  const db = getDb();
  await db.runAsync(
    `INSERT OR REPLACE INTO execution_steps
      (id, step_order, type, status, description, tx_signature, error, metadata, started_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      step.id,
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

export async function getExecutionSteps(): Promise<ExecutionStep[]> {
  const db = getDb();
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
  }>('SELECT * FROM execution_steps ORDER BY step_order ASC');

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

export async function getLastCompletedStep(): Promise<number> {
  const db = getDb();
  const row = await db.getFirstAsync<{ step_order: number }>(
    `SELECT step_order FROM execution_steps
     WHERE status = 'completed'
     ORDER BY step_order DESC LIMIT 1`,
  );
  return row?.step_order ?? -1;
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
