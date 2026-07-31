import type { HeartbeatMethod } from '../types/heartbeat';

export interface ConfirmedHeartbeatInsert {
  method: HeartbeatMethod;
  onChainTimestamp: number;
  transactionSignature: string;
}

export type HeartbeatInsertValue = number | string | null;

export type RunHeartbeatInsert = (
  statement: string,
  values: Array<HeartbeatInsertValue>,
) => Promise<void>;

const INSERT_HEARTBEAT =
  'INSERT INTO heartbeat_history (timestamp, method, on_chain_tx) VALUES (?, ?, ?)';

export async function insertConfirmedHeartbeat(
  input: ConfirmedHeartbeatInsert,
  runInsert: RunHeartbeatInsert,
): Promise<void> {
  if (
    !Number.isSafeInteger(input.onChainTimestamp) ||
    input.onChainTimestamp < 0
  ) {
    throw new Error('Confirmed heartbeat timestamp is invalid');
  }
  if (!input.transactionSignature) {
    throw new Error('Confirmed heartbeat signature is required');
  }
  await runInsert(INSERT_HEARTBEAT, [
    input.onChainTimestamp,
    input.method,
    input.transactionSignature,
  ]);
}

export async function insertNonAuthoritativeLocalHeartbeat(
  method: HeartbeatMethod,
  localTimestamp: number,
  runInsert: RunHeartbeatInsert,
): Promise<void> {
  await runInsert(INSERT_HEARTBEAT, [
    localTimestamp,
    method,
    null,
  ]);
}
