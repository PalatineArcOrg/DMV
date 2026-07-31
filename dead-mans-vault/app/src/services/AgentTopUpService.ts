import {
  PublicKey,
  SystemProgram,
  Transaction,
  type BlockhashWithExpiryBlockHeight,
} from '@solana/web3.js';
import bs58 from 'bs58';
import type { AgentReadinessResult } from './AgentReadinessService';
import { calculateAgentTopUpLamports } from './agentFundingPolicy.ts';

type ReadyAgent = Extract<AgentReadinessResult, { status: 'ready' }>;

export type AgentTopUpResult =
  | {
      status: 'confirmed';
      signature: string;
      transferredLamports: number;
      ownerFeeLamports: number;
      newBalanceLamports: number | null;
    }
  | {
      status: 'already_funded';
      balanceLamports: number;
    }
  | {
      status: 'owner_cancelled';
    }
  | {
      status: 'submission_failed';
      error: unknown;
    }
  | {
      status: 'transaction_failed';
      signature: string;
    }
  | {
      status: 'confirmation_unknown';
      signature: string;
    }
  | {
      status: 'destination_changed';
    }
  | {
      status: 'owner_insufficient_funds';
      requiredLamports: number;
      balanceLamports: number;
    }
  | {
      status: 'precondition_failed';
      reason: Exclude<AgentReadinessResult['status'], 'ready'>;
    };

export interface AgentTopUpConfirmation {
  agent: PublicKey;
  transferLamports: number;
  ownerFeeLamports: number;
}

export interface AgentTopUpDependencies {
  checkAgentReadiness: (
    owner: PublicKey,
  ) => Promise<AgentReadinessResult>;
  assertNetworkVerified: () => void;
  getBalance: (
    address: PublicKey,
    minimumContextSlot?: number,
  ) => Promise<unknown>;
  getLatestBlockhash: () => Promise<BlockhashWithExpiryBlockHeight>;
  getFeeForMessage: (transaction: Transaction) => Promise<unknown>;
  confirmTransfer: (
    confirmation: AgentTopUpConfirmation,
  ) => Promise<boolean>;
  signTransaction: (transaction: Transaction) => Promise<Transaction>;
  sendRawTransaction: (
    serializedTransaction: Uint8Array,
  ) => Promise<string>;
  confirmTransaction: (
    strategy: BlockhashWithExpiryBlockHeight & { signature: string },
  ) => Promise<unknown>;
  isOwnerCancellation: (error: unknown) => boolean;
}

interface ContextLamports {
  slot: number;
  value: number;
}

function parseContextLamports(response: unknown): ContextLamports | null {
  if (!response || typeof response !== 'object') return null;
  const context = Reflect.get(response, 'context');
  if (!context || typeof context !== 'object') return null;
  const slot = Reflect.get(context, 'slot');
  const value = Reflect.get(response, 'value');
  if (
    !Number.isSafeInteger(slot) ||
    slot < 0 ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    return null;
  }
  return { slot, value };
}

function parseConfirmation(response: unknown): 'confirmed' | 'failed' | null {
  if (!response || typeof response !== 'object') return null;
  const value = Reflect.get(response, 'value');
  if (
    !value ||
    typeof value !== 'object' ||
    !Object.prototype.hasOwnProperty.call(value, 'err')
  ) {
    return null;
  }
  const error = Reflect.get(value, 'err');
  if (error === null) return 'confirmed';
  return error === undefined ? null : 'failed';
}

function getSignedTransactionId(
  transaction: Transaction,
  expectedPayer: PublicKey,
): string | null {
  const payerEntry = transaction.signatures.find((entry) =>
    entry.publicKey.equals(expectedPayer),
  );
  if (
    !payerEntry?.signature ||
    !transaction.signature ||
    !Buffer.from(transaction.signature).equals(payerEntry.signature)
  ) {
    return null;
  }
  return bs58.encode(payerEntry.signature);
}

export function createAgentTopUpService(
  dependencies: AgentTopUpDependencies,
) {
  return {
    topUp: async (
      owner: PublicKey,
      expectedAgent: PublicKey,
    ): Promise<AgentTopUpResult> => {
      let readiness: AgentReadinessResult;
      try {
        readiness = await dependencies.checkAgentReadiness(owner);
      } catch {
        return {
          status: 'precondition_failed',
          reason: 'rpc_unavailable',
        };
      }
      if (readiness.status !== 'ready') {
        return {
          status: 'precondition_failed',
          reason: readiness.status,
        };
      }
      const ready: ReadyAgent = readiness;
      if (
        !ready.localAgent.equals(expectedAgent) ||
        !ready.onChainAgent.equals(expectedAgent)
      ) {
        return { status: 'destination_changed' };
      }

      let agentBalance: ContextLamports | null;
      try {
        agentBalance = parseContextLamports(
          await dependencies.getBalance(expectedAgent),
        );
      } catch {
        return {
          status: 'precondition_failed',
          reason: 'rpc_unavailable',
        };
      }
      if (!agentBalance) {
        return {
          status: 'precondition_failed',
          reason: 'invalid_on_chain_state',
        };
      }
      const transferLamports = calculateAgentTopUpLamports(
        agentBalance.value,
      );
      if (transferLamports === 0) {
        return {
          status: 'already_funded',
          balanceLamports: agentBalance.value,
        };
      }

      let transaction: Transaction;
      let blockhashValidity: BlockhashWithExpiryBlockHeight;
      let ownerFee: ContextLamports | null;
      try {
        dependencies.assertNetworkVerified();
        transaction = new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: owner,
            toPubkey: ready.onChainAgent,
            lamports: transferLamports,
          }),
        );
        transaction.feePayer = owner;
        blockhashValidity = await dependencies.getLatestBlockhash();
        transaction.recentBlockhash = blockhashValidity.blockhash;
        ownerFee = parseContextLamports(
          await dependencies.getFeeForMessage(transaction),
        );
      } catch (error: unknown) {
        return { status: 'submission_failed', error };
      }
      if (!ownerFee) {
        return {
          status: 'submission_failed',
          error: new Error('Owner transaction fee estimate was invalid'),
        };
      }

      let ownerBalance: ContextLamports | null;
      try {
        ownerBalance = parseContextLamports(
          await dependencies.getBalance(owner, ownerFee.slot),
        );
      } catch (error: unknown) {
        return { status: 'submission_failed', error };
      }
      if (!ownerBalance) {
        return {
          status: 'submission_failed',
          error: new Error('Owner balance response was invalid'),
        };
      }
      const requiredLamports = transferLamports + ownerFee.value;
      if (!Number.isSafeInteger(requiredLamports)) {
        return {
          status: 'submission_failed',
          error: new Error('Top-up amount and fee exceed safe numeric bounds'),
        };
      }
      if (ownerBalance.value < requiredLamports) {
        return {
          status: 'owner_insufficient_funds',
          requiredLamports,
          balanceLamports: ownerBalance.value,
        };
      }

      let approved: boolean;
      try {
        approved = await dependencies.confirmTransfer({
          agent: ready.onChainAgent,
          transferLamports,
          ownerFeeLamports: ownerFee.value,
        });
      } catch {
        return { status: 'owner_cancelled' };
      }
      if (!approved) return { status: 'owner_cancelled' };

      const expectedMessage = transaction.serializeMessage();
      let signedTransaction: Transaction;
      try {
        signedTransaction =
          await dependencies.signTransaction(transaction);
      } catch (error: unknown) {
        if (dependencies.isOwnerCancellation(error)) {
          return { status: 'owner_cancelled' };
        }
        return { status: 'submission_failed', error };
      }
      const expectedSignature = getSignedTransactionId(
        signedTransaction,
        owner,
      );
      if (
        !expectedSignature ||
        !Buffer.from(signedTransaction.serializeMessage()).equals(
          expectedMessage,
        )
      ) {
        return {
          status: 'submission_failed',
          error: new Error(
            'Owner transaction signature or signed message was invalid',
          ),
        };
      }

      let rpcSignature: string;
      try {
        rpcSignature = await dependencies.sendRawTransaction(
          signedTransaction.serialize(),
        );
      } catch {
        return {
          status: 'confirmation_unknown',
          signature: expectedSignature,
        };
      }
      if (!rpcSignature || rpcSignature !== expectedSignature) {
        return {
          status: 'confirmation_unknown',
          signature: expectedSignature,
        };
      }

      let confirmation: unknown;
      try {
        confirmation = await dependencies.confirmTransaction({
          signature: expectedSignature,
          ...blockhashValidity,
        });
      } catch {
        return {
          status: 'confirmation_unknown',
          signature: expectedSignature,
        };
      }
      const confirmationStatus = parseConfirmation(confirmation);
      if (confirmationStatus === 'failed') {
        return {
          status: 'transaction_failed',
          signature: expectedSignature,
        };
      }
      if (confirmationStatus !== 'confirmed') {
        return {
          status: 'confirmation_unknown',
          signature: expectedSignature,
        };
      }

      let refreshedBalance: ContextLamports | null;
      try {
        refreshedBalance = parseContextLamports(
          await dependencies.getBalance(
            expectedAgent,
            ownerBalance.slot,
          ),
        );
      } catch {
        refreshedBalance = null;
      }
      return {
        status: 'confirmed',
        signature: expectedSignature,
        transferredLamports: transferLamports,
        ownerFeeLamports: ownerFee.value,
        newBalanceLamports: refreshedBalance?.value ?? null,
      };
    },
  };
}
