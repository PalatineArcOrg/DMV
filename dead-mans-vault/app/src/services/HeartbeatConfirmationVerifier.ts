import type { PublicKey } from '@solana/web3.js';
import type {
  AccountInfoLike,
  RawHeartbeatRecord,
} from '../utils/rawAccountParsers';
import type { VerifiedHeartbeatSnapshot } from './AgentReadinessService';

function toSafeOnChainInteger(
  value: { toNumber: () => number },
): number | null {
  try {
    const converted = value.toNumber();
    return Number.isSafeInteger(converted) ? converted : null;
  } catch {
    return null;
  }
}

export interface HeartbeatVerificationInput {
  vault: PublicKey;
  heartbeat: PublicKey;
  heartbeatBefore: VerifiedHeartbeatSnapshot;
  expectedMethod: number;
}

export type HeartbeatVerificationResult =
  | {
      status: 'verified';
      lastHeartbeat: number;
      lastMethod: number;
      totalHeartbeats: bigint;
    }
  | {
      status: 'rpc_unavailable';
      error?: unknown;
    }
  | {
      status: 'invalid_on_chain_state';
      reason: string;
    }
  | {
      status: 'not_advanced';
    };

export interface HeartbeatConfirmationVerifierDependencies {
  deriveHeartbeatPda: (vault: PublicKey) => [PublicKey, number];
  fetchAccount: (heartbeat: PublicKey) => Promise<AccountInfoLike | null>;
  parseHeartbeatAccount: (
    account: AccountInfoLike,
  ) => RawHeartbeatRecord | null;
}

export interface HeartbeatConfirmationVerifier {
  verify: (
    input: HeartbeatVerificationInput,
  ) => Promise<HeartbeatVerificationResult>;
}

function invalidOnChainState(
  reason: string,
): HeartbeatVerificationResult {
  return { status: 'invalid_on_chain_state', reason };
}

export function createHeartbeatConfirmationVerifier(
  dependencies: HeartbeatConfirmationVerifierDependencies,
): HeartbeatConfirmationVerifier {
  return {
    verify: async (
      input: HeartbeatVerificationInput,
    ): Promise<HeartbeatVerificationResult> => {
      let canonicalHeartbeat: PublicKey;
      let canonicalBump: number;
      try {
        [canonicalHeartbeat, canonicalBump] =
          dependencies.deriveHeartbeatPda(input.vault);
      } catch {
        return invalidOnChainState(
          'canonical heartbeat PDA derivation failed',
        );
      }
      if (!canonicalHeartbeat.equals(input.heartbeat)) {
        return invalidOnChainState(
          'heartbeat address is not the canonical vault heartbeat PDA',
        );
      }

      let heartbeatAccount: AccountInfoLike | null;
      try {
        heartbeatAccount = await dependencies.fetchAccount(
          input.heartbeat,
        );
      } catch (error: unknown) {
        return { status: 'rpc_unavailable', error };
      }
      if (!heartbeatAccount) {
        return invalidOnChainState(
          'canonical heartbeat account is missing',
        );
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
        return invalidOnChainState(
          'heartbeat account validation failed',
        );
      }
      if (!heartbeatRecord.vault.equals(input.vault)) {
        return invalidOnChainState(
          'heartbeat record references a different vault',
        );
      }
      if (heartbeatRecord.bump !== canonicalBump) {
        return invalidOnChainState(
          'heartbeat account bump is not canonical',
        );
      }

      const lastHeartbeat = toSafeOnChainInteger(
        heartbeatRecord.lastHeartbeat,
      );
      if (lastHeartbeat === null) {
        return invalidOnChainState(
          'heartbeat timestamp exceeds safe numeric bounds',
        );
      }
      if (lastHeartbeat < input.heartbeatBefore.lastHeartbeat) {
        return invalidOnChainState(
          'heartbeat timestamp regressed after confirmation',
        );
      }
      if (heartbeatRecord.lastMethod !== input.expectedMethod) {
        return invalidOnChainState(
          'heartbeat method does not match the submitted method',
        );
      }
      if (
        heartbeatRecord.totalHeartbeats <=
        input.heartbeatBefore.totalHeartbeats
      ) {
        return { status: 'not_advanced' };
      }

      return {
        status: 'verified',
        lastHeartbeat,
        lastMethod: heartbeatRecord.lastMethod,
        totalHeartbeats: heartbeatRecord.totalHeartbeats,
      };
    },
  };
}
