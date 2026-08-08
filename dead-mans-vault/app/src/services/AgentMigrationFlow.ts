export interface VaultAgentState {
  active: boolean;
  executed: boolean;
  agentPublicKey: string;
}

export const STARTUP_MIGRATION_DELAY_SECONDS = 120;

export function isStartupMigrationCheckDue(
  createdAtSeconds: number,
  nowSeconds: number,
): boolean {
  return nowSeconds - createdAtSeconds > STARTUP_MIGRATION_DELAY_SECONDS;
}

export function needsAgentRotationForState(
  vault: VaultAgentState | null,
  hasLocalAgentKey: boolean,
  localAgentPublicKey: string | null,
): boolean {
  if (!vault || vault.executed || !vault.active) return false;
  if (!hasLocalAgentKey) return true;
  return localAgentPublicKey !== vault.agentPublicKey;
}
