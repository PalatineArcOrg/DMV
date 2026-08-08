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

export type CurrentHeartbeatStateResult =
  | {
      status: 'verified_state';
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
  readCurrent: (
    input: Pick<HeartbeatVerificationInput, 'vault' | 'heartbeat'>,
  ) => Promise<CurrentHeartbeatStateResult>;
}

function invalidOnChainState(
  reason: string,
): {
  status: 'invalid_on_chain_state';
  reason: string;
} {
  return { status: 'invalid_on_chain_state', reason };
}

export function createHeartbeatConfirmationVerifier(
  dependencies: HeartbeatConfirmationVerifierDependencies,
): HeartbeatConfirmationVerifier {
  const readCurrent = async (
    input: Pick<HeartbeatVerificationInput, 'vault' | 'heartbeat'>,
  ): Promise<CurrentHeartbeatStateResult> => {
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
      heartbeatAccount = await dependencies.fetchAccount(input.heartbeat);
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
    return {
      status: 'verified_state',
      lastHeartbeat,
      lastMethod: heartbeatRecord.lastMethod,
      totalHeartbeats: heartbeatRecord.totalHeartbeats,
    };
  };

  return {
    readCurrent,
    verify: async (
      input: HeartbeatVerificationInput,
    ): Promise<HeartbeatVerificationResult> => {
      const current = await readCurrent(input);
      if (current.status !== 'verified_state') return current;
      const { lastHeartbeat } = current;
      if (lastHeartbeat < input.heartbeatBefore.lastHeartbeat) {
        return invalidOnChainState(
          'heartbeat timestamp regressed after confirmation',
        );
      }
      if (current.lastMethod !== input.expectedMethod) {
        return invalidOnChainState(
          'heartbeat method does not match the submitted method',
        );
      }
      if (
        current.totalHeartbeats <=
        input.heartbeatBefore.totalHeartbeats
      ) {
        return { status: 'not_advanced' };
      }

      return {
        status: 'verified',
        lastHeartbeat,
        lastMethod: current.lastMethod,
        totalHeartbeats: current.totalHeartbeats,
      };
    },
  };
}
