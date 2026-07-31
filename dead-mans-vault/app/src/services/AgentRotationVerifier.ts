import type { PublicKey } from '@solana/web3.js';

export interface VerifiedRotationChainState {
  owner: PublicKey;
  vault: PublicKey;
  heartbeat: PublicKey;
  agent: PublicKey;
  active: boolean;
  executed: boolean;
  vaultUpdatedAt: number;
  lastHeartbeat: number;
  totalHeartbeats: bigint;
  heartbeatInterval: number;
  gracePeriod: number;
  configFingerprint: string;
  chainUnixTime: number;
}

export interface AgentRotationVerificationInput {
  owner: PublicKey;
  vault: PublicKey;
  heartbeat: PublicKey;
  oldAgent: PublicKey;
  candidateAgent: PublicKey;
  beforeVaultUpdatedAt: number;
  beforeLastHeartbeat: number;
  beforeTotalHeartbeats: bigint;
  beforeConfigFingerprint: string;
}

export type AgentRotationVerificationResult =
  | {
      status: 'verified';
      agent: PublicKey;
      vaultUpdatedAt: number;
      lastHeartbeat: number;
    }
  | { status: 'old_agent_still_authorised' }
  | {
      status: 'different_agent_authorised';
      agent: PublicKey;
    }
  | { status: 'rpc_unavailable' }
  | { status: 'invalid_on_chain_state'; reason: string };

export interface AgentRotationVerifierDependencies {
  fetchVerifiedState: (
    owner: PublicKey,
  ) => Promise<VerifiedRotationChainState | null>;
}

export function createAgentRotationVerifier(
  dependencies: AgentRotationVerifierDependencies,
) {
  return {
    verify: async (
      input: AgentRotationVerificationInput,
    ): Promise<AgentRotationVerificationResult> => {
      let current: VerifiedRotationChainState | null;
      try {
        current = await dependencies.fetchVerifiedState(input.owner);
      } catch {
        return { status: 'rpc_unavailable' };
      }
      if (!current) {
        return {
          status: 'invalid_on_chain_state',
          reason: 'canonical rotation accounts are unavailable or invalid',
        };
      }
      if (
        !current.owner.equals(input.owner) ||
        !current.vault.equals(input.vault) ||
        !current.heartbeat.equals(input.heartbeat)
      ) {
        return {
          status: 'invalid_on_chain_state',
          reason: 'rotation identity changed',
        };
      }
      if (current.agent.equals(input.oldAgent)) {
        return { status: 'old_agent_still_authorised' };
      }
      if (!current.agent.equals(input.candidateAgent)) {
        return {
          status: 'different_agent_authorised',
          agent: current.agent,
        };
      }
      if (!current.active || current.executed) {
        return {
          status: 'invalid_on_chain_state',
          reason: 'vault is inactive or executed after rotation',
        };
      }
      if (
        current.vaultUpdatedAt < input.beforeVaultUpdatedAt ||
        current.lastHeartbeat < input.beforeLastHeartbeat ||
        current.lastHeartbeat > current.chainUnixTime
      ) {
        return {
          status: 'invalid_on_chain_state',
          reason: 'rotation timestamps are inconsistent',
        };
      }
      if (
        current.totalHeartbeats !== input.beforeTotalHeartbeats
      ) {
        return {
          status: 'invalid_on_chain_state',
          reason: 'rotation unexpectedly changed heartbeat count',
        };
      }
      if (
        current.configFingerprint !== input.beforeConfigFingerprint
      ) {
        return {
          status: 'invalid_on_chain_state',
          reason:
            'rotation unexpectedly changed vault beneficiaries or timing',
        };
      }
      return {
        status: 'verified',
        agent: current.agent,
        vaultUpdatedAt: current.vaultUpdatedAt,
        lastHeartbeat: current.lastHeartbeat,
      };
    },
  };
}
