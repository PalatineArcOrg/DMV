export type HeartbeatAttemptResult =
  | {
      status: 'confirmed_on_chain';
      signature: string;
    }
  | {
      status: 'agent_missing';
    }
  | {
      status: 'on_chain_failed';
      error: unknown;
    }
  | {
      status: 'local_failed';
      error: unknown;
    };

export interface LocalHeartbeatDependencies {
  recordLocalHeartbeat: () => Promise<void>;
  resetLocalEscalation: () => void;
  sendLocalConfirmationNotification: () => void | Promise<void>;
}

export interface HeartbeatCoordinatorDependencies<AgentKeypair> {
  confirmLocalHeartbeat: () => Promise<void>;
  loadAgentKeypair: () => Promise<AgentKeypair | null>;
  recordHeartbeatOnChain: (agentKeypair: AgentKeypair) => Promise<string>;
  reloadVaultState: () => Promise<void>;
  publishExplorerSignature: (signature: string) => void;
  publishOnChainError: (hasError: boolean) => void;
  isMissingAgentError?: (error: unknown) => boolean;
}

const MISSING_AGENT_KEY_MESSAGE = 'No agent key found in secure store';

export function isMissingAgentKeyError(error: unknown): boolean {
  return error instanceof Error && error.message === MISSING_AGENT_KEY_MESSAGE;
}

export async function confirmLocalHeartbeat(
  dependencies: LocalHeartbeatDependencies,
): Promise<void> {
  await dependencies.recordLocalHeartbeat();
  dependencies.resetLocalEscalation();

  // The current hook starts this notification without awaiting it. Keep that
  // fire-and-forget behavior until the authoritative-ordering work package.
  try {
    void dependencies.sendLocalConfirmationNotification();
  } catch {
    // Local notification failure does not fail the current heartbeat flow.
  }
}

async function reloadVaultStateIgnoringFailure(
  reloadVaultState: () => Promise<void>,
): Promise<void> {
  try {
    await reloadVaultState();
  } catch {
    // Dashboard loadVaultState is currently fail-soft.
  }
}

export async function coordinateHeartbeat<AgentKeypair>(
  dependencies: HeartbeatCoordinatorDependencies<AgentKeypair>,
): Promise<HeartbeatAttemptResult> {
  try {
    await dependencies.confirmLocalHeartbeat();
  } catch (error: unknown) {
    return { status: 'local_failed', error };
  }

  try {
    const agentKeypair = await dependencies.loadAgentKeypair();
    if (!agentKeypair) {
      dependencies.publishOnChainError(true);
      await reloadVaultStateIgnoringFailure(dependencies.reloadVaultState);
      return { status: 'agent_missing' };
    }

    const signature = await dependencies.recordHeartbeatOnChain(agentKeypair);
    dependencies.publishExplorerSignature(signature);
    dependencies.publishOnChainError(false);
    await reloadVaultStateIgnoringFailure(dependencies.reloadVaultState);
    return { status: 'confirmed_on_chain', signature };
  } catch (error: unknown) {
    dependencies.publishOnChainError(true);
    await reloadVaultStateIgnoringFailure(dependencies.reloadVaultState);

    const isMissingAgentError =
      dependencies.isMissingAgentError ?? isMissingAgentKeyError;
    if (isMissingAgentError(error)) {
      return { status: 'agent_missing' };
    }
    return { status: 'on_chain_failed', error };
  }
}
