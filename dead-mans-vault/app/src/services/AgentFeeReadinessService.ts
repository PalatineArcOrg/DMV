import type { PublicKey } from '@solana/web3.js';
import {
  AGENT_RECOMMENDED_RESERVE_LAMPORTS,
  calculateAgentTopUpLamports,
} from './agentFundingPolicy.ts';

export type AgentFeeReadinessResult =
  | {
      status: 'ready';
      agent: PublicKey;
      balanceLamports: number;
      feeLamports: number;
      reserveTargetLamports: number;
      estimatedHeartbeatsRemaining: number;
      observedSlot: number;
    }
  | {
      status: 'low_reserve';
      agent: PublicKey;
      balanceLamports: number;
      feeLamports: number;
      reserveTargetLamports: number;
      topUpLamports: number;
      estimatedHeartbeatsRemaining: number;
      observedSlot: number;
    }
  | {
      status: 'insufficient';
      agent: PublicKey;
      balanceLamports: number;
      feeLamports: number;
      shortfallLamports: number;
      reserveTargetLamports: number;
      observedSlot: number;
    }
  | {
      status: 'check_unavailable';
      reason: 'balance_unavailable' | 'fee_unavailable';
    }
  | {
      status: 'invalid_response';
      reason: string;
    };

interface RpcContextValue {
  context: {
    slot: number;
  };
  value: unknown;
}

export interface AgentFeeReadinessDependencies<MessageType> {
  getFeeForMessage: (message: MessageType) => Promise<unknown>;
  getAgentBalance: (
    agent: PublicKey,
    minimumContextSlot: number,
  ) => Promise<unknown>;
}

function parseContextValue(
  response: unknown,
  label: string,
): RpcContextValue | string {
  if (!response || typeof response !== 'object') {
    return `${label} response is not an object`;
  }
  const context = Reflect.get(response, 'context');
  if (!context || typeof context !== 'object') {
    return `${label} response has no context`;
  }
  const slot = Reflect.get(context, 'slot');
  if (!Number.isSafeInteger(slot) || slot < 0) {
    return `${label} response has an invalid context slot`;
  }
  if (!Object.prototype.hasOwnProperty.call(response, 'value')) {
    return `${label} response has no value`;
  }
  return {
    context: { slot },
    value: Reflect.get(response, 'value'),
  };
}

function parseLamports(value: unknown, label: string): number | string {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    return `${label} is not a safe non-negative integer`;
  }
  return value as number;
}

export function createAgentFeeReadinessService<MessageType>(
  dependencies: AgentFeeReadinessDependencies<MessageType>,
) {
  return {
    check: async (
      agent: PublicKey,
      message: MessageType,
    ): Promise<AgentFeeReadinessResult> => {
      let feeResponse: unknown;
      try {
        feeResponse = await dependencies.getFeeForMessage(message);
      } catch {
        return {
          status: 'check_unavailable',
          reason: 'fee_unavailable',
        };
      }

      const feeContext = parseContextValue(feeResponse, 'fee');
      if (typeof feeContext === 'string') {
        return { status: 'invalid_response', reason: feeContext };
      }
      if (feeContext.value === null) {
        return {
          status: 'check_unavailable',
          reason: 'fee_unavailable',
        };
      }
      const feeLamports = parseLamports(feeContext.value, 'fee');
      if (typeof feeLamports === 'string') {
        return { status: 'invalid_response', reason: feeLamports };
      }

      let balanceResponse: unknown;
      try {
        balanceResponse = await dependencies.getAgentBalance(
          agent,
          feeContext.context.slot,
        );
      } catch {
        return {
          status: 'check_unavailable',
          reason: 'balance_unavailable',
        };
      }
      const balanceContext = parseContextValue(balanceResponse, 'balance');
      if (typeof balanceContext === 'string') {
        return { status: 'invalid_response', reason: balanceContext };
      }
      if (balanceContext.context.slot < feeContext.context.slot) {
        return {
          status: 'invalid_response',
          reason: 'balance response predates the fee estimate',
        };
      }
      const balanceLamports = parseLamports(
        balanceContext.value,
        'balance',
      );
      if (typeof balanceLamports === 'string') {
        return {
          status: 'invalid_response',
          reason: balanceLamports,
        };
      }

      const common = {
        agent,
        balanceLamports,
        feeLamports,
        reserveTargetLamports: AGENT_RECOMMENDED_RESERVE_LAMPORTS,
        observedSlot: balanceContext.context.slot,
      };
      if (balanceLamports < feeLamports) {
        return {
          status: 'insufficient',
          ...common,
          shortfallLamports: feeLamports - balanceLamports,
        };
      }

      const estimatedHeartbeatsRemaining = Math.floor(
        balanceLamports / Math.max(feeLamports, 1),
      );
      if (balanceLamports < AGENT_RECOMMENDED_RESERVE_LAMPORTS) {
        return {
          status: 'low_reserve',
          ...common,
          topUpLamports: calculateAgentTopUpLamports(balanceLamports),
          estimatedHeartbeatsRemaining,
        };
      }
      return {
        status: 'ready',
        ...common,
        estimatedHeartbeatsRemaining,
      };
    },
  };
}
