import type { Keypair, PublicKey } from '@solana/web3.js';
import type {
  AccountInfoLike,
  RawHeartbeatRecord,
  RawVaultConfig,
} from '../utils/rawAccountParsers';

export type AgentReadinessResult =
  | {
      status: 'ready';
      owner: PublicKey;
      vault: PublicKey;
      heartbeat: PublicKey;
      localAgent: PublicKey;
      onChainAgent: PublicKey;
      keypair: Keypair;
    }
  | {
      status: 'owner_missing';
    }
  | {
      status: 'agent_missing';
    }
  | {
      status: 'agent_unavailable';
    }
  | {
      status: 'agent_mismatch';
      localAgent: PublicKey;
      onChainAgent: PublicKey;
    }
  | {
      status: 'vault_missing';
    }
  | {
      status: 'vault_inactive';
    }
  | {
      status: 'vault_executed';
    }
  | {
      status: 'rpc_unavailable';
      error?: unknown;
    }
  | {
      status: 'invalid_on_chain_state';
      reason: string;
    };

export interface AgentReadinessDependencies {
  deriveVaultPda: (owner: PublicKey) => [PublicKey, number];
  deriveHeartbeatPda: (vault: PublicKey) => [PublicKey, number];
  fetchAccount: (address: PublicKey) => Promise<AccountInfoLike | null>;
  parseVaultAccount: (account: AccountInfoLike) => RawVaultConfig | null;
  parseHeartbeatAccount: (
    account: AccountInfoLike,
  ) => RawHeartbeatRecord | null;
  loadAgentKeypair: () => Promise<Keypair>;
  isMissingAgentError: (error: unknown) => boolean;
}

export interface AgentReadinessService {
  check: (owner: PublicKey | null) => Promise<AgentReadinessResult>;
}

function invalidOnChainState(reason: string): AgentReadinessResult {
  return { status: 'invalid_on_chain_state', reason };
}

export function createAgentReadinessService(
  dependencies: AgentReadinessDependencies,
): AgentReadinessService {
  return {
    check: async (
      owner: PublicKey | null,
    ): Promise<AgentReadinessResult> => {
      if (!owner) {
        return { status: 'owner_missing' };
      }

      let vault: PublicKey;
      let heartbeat: PublicKey;
      let vaultBump: number;
      let heartbeatBump: number;
      try {
        [vault, vaultBump] = dependencies.deriveVaultPda(owner);
        [heartbeat, heartbeatBump] =
          dependencies.deriveHeartbeatPda(vault);
      } catch {
        return invalidOnChainState('canonical PDA derivation failed');
      }

      let vaultAccount: AccountInfoLike | null;
      try {
        vaultAccount = await dependencies.fetchAccount(vault);
      } catch (error: unknown) {
        return { status: 'rpc_unavailable', error };
      }
      if (!vaultAccount) {
        return { status: 'vault_missing' };
      }

      let vaultConfig: RawVaultConfig | null;
      try {
        vaultConfig = dependencies.parseVaultAccount(vaultAccount);
      } catch {
        return invalidOnChainState('vault account validation failed');
      }
      if (!vaultConfig) {
        return invalidOnChainState('vault account validation failed');
      }
      if (!vaultConfig.owner.equals(owner)) {
        return invalidOnChainState(
          'vault owner does not match the connected owner',
        );
      }
      if (vaultConfig.bump !== vaultBump) {
        return invalidOnChainState(
          'vault account bump does not match the canonical PDA',
        );
      }
      if (!vaultConfig.active) {
        return { status: 'vault_inactive' };
      }
      if (vaultConfig.executed) {
        return { status: 'vault_executed' };
      }

      let heartbeatAccount: AccountInfoLike | null;
      try {
        heartbeatAccount = await dependencies.fetchAccount(heartbeat);
      } catch (error: unknown) {
        return { status: 'rpc_unavailable', error };
      }
      if (!heartbeatAccount) {
        return invalidOnChainState('canonical heartbeat account is missing');
      }

      let heartbeatRecord: RawHeartbeatRecord | null;
      try {
        heartbeatRecord =
          dependencies.parseHeartbeatAccount(heartbeatAccount);
      } catch {
        return invalidOnChainState(
          'heartbeat account validation failed',
        );
      }
      if (!heartbeatRecord) {
        return invalidOnChainState('heartbeat account validation failed');
      }
      if (!heartbeatRecord.vault.equals(vault)) {
        return invalidOnChainState(
          'heartbeat record does not reference the canonical vault',
        );
      }
      if (heartbeatRecord.bump !== heartbeatBump) {
        return invalidOnChainState(
          'heartbeat account bump does not match the canonical PDA',
        );
      }

      let keypair: Keypair;
      try {
        keypair = await dependencies.loadAgentKeypair();
      } catch (error: unknown) {
        if (dependencies.isMissingAgentError(error)) {
          return { status: 'agent_missing' };
        }
        return { status: 'agent_unavailable' };
      }

      const localAgent = keypair.publicKey;
      const onChainAgent = vaultConfig.agentPubkey;
      if (!localAgent.equals(onChainAgent)) {
        return {
          status: 'agent_mismatch',
          localAgent,
          onChainAgent,
        };
      }

      return {
        status: 'ready',
        owner,
        vault,
        heartbeat,
        localAgent,
        onChainAgent,
        keypair,
      };
    },
  };
}
