export type ExecutionStepType =
  | 'revoke_approvals'
  | 'close_defi_position'
  | 'distribute_specific_asset'
  | 'distribute_sol'
  | 'burn_asset'
  | 'close_accounts'
  | 'record_execution_log'
  | 'self_terminate';

export type ExecutionStepStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'skipped';

export interface ExecutionStep {
  id: string;
  type: ExecutionStepType;
  status: ExecutionStepStatus;
  description: string;
  txSignature?: string;
  error?: string;
  order: number;
  metadata?: Record<string, unknown>;
  startedAt?: number;
  completedAt?: number;
}
