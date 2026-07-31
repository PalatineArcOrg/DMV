export interface VaultAgentState {
  active: boolean;
  executed: boolean;
  agentPublicKey: string;
}

export interface PreparedRotation<Transaction> {
  transaction: Transaction;
  blockhash: string;
  lastValidBlockHeight: number;
}

export interface CurrentAgentRotationDependencies<Transaction> {
  destroyActiveAgentKey: () => Promise<void>;
  generateReplacementAgentKey: () => Promise<string>;
  buildRotationTransaction: (
    replacementAgentPublicKey: string,
  ) => Promise<Transaction>;
  prepareRotationTransaction: (
    transaction: Transaction,
  ) => Promise<PreparedRotation<Transaction>>;
  signAndSendTransaction: (transaction: Transaction) => Promise<string>;
  confirmRotation: (strategy: {
    signature: string;
    blockhash: string;
    lastValidBlockHeight: number;
  }) => Promise<void>;
}

export interface AgentRotationResult {
  newPubkey: string;
  txSig: string;
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

export async function executeCurrentAgentRotation<Transaction>(
  dependencies: CurrentAgentRotationDependencies<Transaction>,
): Promise<AgentRotationResult> {
  await dependencies.destroyActiveAgentKey();
  const newPubkey = await dependencies.generateReplacementAgentKey();
  const transaction =
    await dependencies.buildRotationTransaction(newPubkey);
  const prepared =
    await dependencies.prepareRotationTransaction(transaction);
  const txSig =
    await dependencies.signAndSendTransaction(prepared.transaction);
  await dependencies.confirmRotation({
    signature: txSig,
    blockhash: prepared.blockhash,
    lastValidBlockHeight: prepared.lastValidBlockHeight,
  });
  return { newPubkey, txSig };
}
