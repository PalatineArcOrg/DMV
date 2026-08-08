import {
  PublicKey,
  SystemProgram,
  Transaction,
  type BlockhashWithExpiryBlockHeight,
} from '@solana/web3.js';
import bs58 from 'bs58';
import {
  AGENT_RECOMMENDED_RESERVE_LAMPORTS,
  calculateAgentTopUpLamports,
} from './agentFundingPolicy.ts';

export type CandidateFundingResult =
  | {
      status: 'confirmed';
      signature: string;
      transferredLamports: number;
      newBalanceLamports: number | null;
    }
  | { status: 'already_funded'; balanceLamports: number }
  | { status: 'owner_cancelled' }
  | { status: 'candidate_changed' }
  | { status: 'owner_insufficient_funds' }
  | { status: 'journal_failed'; error: unknown }
  | { status: 'transaction_failed'; signature: string }
  | { status: 'confirmation_unknown'; signature: string }
  | { status: 'preparation_failed'; error: unknown };

export interface CandidateFundingDependencies {
  validateCandidate: (
    owner: PublicKey,
    expectedCandidate: PublicKey,
  ) => Promise<boolean>;
  getBalance: (
    address: PublicKey,
    minimumContextSlot?: number,
  ) => Promise<unknown>;
  getLatestBlockhash: () => Promise<BlockhashWithExpiryBlockHeight>;
  getFeeForMessage: (transaction: Transaction) => Promise<unknown>;
  confirmTransfer: (input: {
    candidate: PublicKey;
    transferLamports: number;
    ownerFeeLamports: number;
  }) => Promise<boolean>;
  signWithOwnerWallet: (
    transaction: Transaction,
  ) => Promise<Transaction>;
  sendRawTransaction: (bytes: Uint8Array) => Promise<string>;
  confirmTransaction: (
    input: BlockhashWithExpiryBlockHeight & { signature: string },
  ) => Promise<unknown>;
  persistPrepared: (input: {
    signature: string;
    blockhash: string;
    lastValidBlockHeight: number;
    transferLamports: number;
  }) => Promise<void>;
  transition: (
    signature: string,
    state:
      | 'submitted'
      | 'submission_unknown'
      | 'confirmation_unknown'
      | 'resolved_confirmed'
      | 'resolved_failed',
    safeErrorCode:
      | 'send_exception'
      | 'rpc_signature_mismatch'
      | 'confirmation_exception'
      | 'confirmation_malformed'
      | 'transaction_failed'
      | null,
  ) => Promise<void>;
  isOwnerCancellation: (error: unknown) => boolean;
}

interface ContextLamports {
  slot: number;
  value: number;
}

function parseLamports(value: unknown): ContextLamports | null {
  if (!value || typeof value !== 'object') return null;
  const context = Reflect.get(value, 'context');
  const slot =
    context && typeof context === 'object'
      ? Reflect.get(context, 'slot')
      : null;
  const lamports = Reflect.get(value, 'value');
  if (
    !Number.isSafeInteger(slot) ||
    slot < 0 ||
    !Number.isSafeInteger(lamports) ||
    lamports < 0
  ) {
    return null;
  }
  return { slot, value: lamports };
}

function confirmation(value: unknown): 'confirmed' | 'failed' | null {
  if (!value || typeof value !== 'object') return null;
  const response = Reflect.get(value, 'value');
  if (
    !response ||
    typeof response !== 'object' ||
    !Object.prototype.hasOwnProperty.call(response, 'err')
  ) {
    return null;
  }
  const error = Reflect.get(response, 'err');
  if (error === null) return 'confirmed';
  return error === undefined ? null : 'failed';
}

function signedId(
  transaction: Transaction,
  owner: PublicKey,
): string | null {
  const ownerSignature = transaction.signatures.find((entry) =>
    entry.publicKey.equals(owner),
  )?.signature;
  if (
    !ownerSignature ||
    !transaction.signature ||
    !Buffer.from(transaction.signature).equals(ownerSignature)
  ) {
    return null;
  }
  return bs58.encode(ownerSignature);
}

export function createAgentCandidateFundingService(
  dependencies: CandidateFundingDependencies,
) {
  return {
    fund: async (
      owner: PublicKey,
      candidate: PublicKey,
    ): Promise<CandidateFundingResult> => {
      if (!(await dependencies.validateCandidate(owner, candidate))) {
        return { status: 'candidate_changed' };
      }
      let balance: ContextLamports | null;
      try {
        balance = parseLamports(
          await dependencies.getBalance(candidate),
        );
      } catch (error: unknown) {
        return { status: 'preparation_failed', error };
      }
      if (!balance) {
        return {
          status: 'preparation_failed',
          error: new Error('Candidate balance response was invalid'),
        };
      }
      const transferLamports = calculateAgentTopUpLamports(
        balance.value,
        AGENT_RECOMMENDED_RESERVE_LAMPORTS,
      );
      if (transferLamports === 0) {
        return {
          status: 'already_funded',
          balanceLamports: balance.value,
        };
      }

      let transaction: Transaction;
      let blockhash: BlockhashWithExpiryBlockHeight;
      let ownerFee: ContextLamports | null;
      try {
        transaction = new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: owner,
            toPubkey: candidate,
            lamports: transferLamports,
          }),
        );
        transaction.feePayer = owner;
        blockhash = await dependencies.getLatestBlockhash();
        transaction.recentBlockhash = blockhash.blockhash;
        ownerFee = parseLamports(
          await dependencies.getFeeForMessage(transaction),
        );
      } catch (error: unknown) {
        return { status: 'preparation_failed', error };
      }
      if (!ownerFee) {
        return {
          status: 'preparation_failed',
          error: new Error('Candidate funding fee was invalid'),
        };
      }
      let ownerBalance: ContextLamports | null;
      try {
        ownerBalance = parseLamports(
          await dependencies.getBalance(owner, ownerFee.slot),
        );
      } catch (error: unknown) {
        return { status: 'preparation_failed', error };
      }
      if (
        !ownerBalance ||
        ownerBalance.value < transferLamports + ownerFee.value
      ) {
        return { status: 'owner_insufficient_funds' };
      }
      if (
        !(await dependencies.confirmTransfer({
          candidate,
          transferLamports,
          ownerFeeLamports: ownerFee.value,
        }))
      ) {
        return { status: 'owner_cancelled' };
      }
      if (!(await dependencies.validateCandidate(owner, candidate))) {
        return { status: 'candidate_changed' };
      }

      const message = transaction.serializeMessage();
      let signed: Transaction;
      try {
        signed = await dependencies.signWithOwnerWallet(transaction);
      } catch (error: unknown) {
        if (dependencies.isOwnerCancellation(error)) {
          return { status: 'owner_cancelled' };
        }
        return { status: 'preparation_failed', error };
      }
      const expectedSignature = signedId(signed, owner);
      if (
        !expectedSignature ||
        !Buffer.from(signed.serializeMessage()).equals(message) ||
        !signed.verifySignatures()
      ) {
        return {
          status: 'preparation_failed',
          error: new Error('Owner wallet modified candidate funding'),
        };
      }
      try {
        await dependencies.persistPrepared({
          signature: expectedSignature,
          blockhash: blockhash.blockhash,
          lastValidBlockHeight: blockhash.lastValidBlockHeight,
          transferLamports,
        });
      } catch (error: unknown) {
        return { status: 'journal_failed', error };
      }
      let rpcSignature: string;
      try {
        rpcSignature = await dependencies.sendRawTransaction(
          signed.serialize(),
        );
      } catch {
        await dependencies.transition(
          expectedSignature,
          'submission_unknown',
          'send_exception',
        );
        return {
          status: 'confirmation_unknown',
          signature: expectedSignature,
        };
      }
      if (rpcSignature !== expectedSignature) {
        await dependencies.transition(
          expectedSignature,
          'submission_unknown',
          'rpc_signature_mismatch',
        );
        return {
          status: 'confirmation_unknown',
          signature: expectedSignature,
        };
      }
      await dependencies.transition(
        expectedSignature,
        'submitted',
        null,
      );
      let confirmed: unknown;
      try {
        confirmed = await dependencies.confirmTransaction({
          signature: expectedSignature,
          ...blockhash,
        });
      } catch {
        await dependencies.transition(
          expectedSignature,
          'confirmation_unknown',
          'confirmation_exception',
        );
        return {
          status: 'confirmation_unknown',
          signature: expectedSignature,
        };
      }
      const confirmationStatus = confirmation(confirmed);
      if (confirmationStatus === 'failed') {
        await dependencies.transition(
          expectedSignature,
          'resolved_failed',
          'transaction_failed',
        );
        return {
          status: 'transaction_failed',
          signature: expectedSignature,
        };
      }
      if (confirmationStatus !== 'confirmed') {
        await dependencies.transition(
          expectedSignature,
          'confirmation_unknown',
          'confirmation_malformed',
        );
        return {
          status: 'confirmation_unknown',
          signature: expectedSignature,
        };
      }
      await dependencies.transition(
        expectedSignature,
        'resolved_confirmed',
        null,
      );
      let refreshed: ContextLamports | null = null;
      try {
        refreshed = parseLamports(
          await dependencies.getBalance(candidate, balance.slot),
        );
      } catch {
        // The transfer is conclusively confirmed. Rotation performs its own
        // fresh candidate-balance check before signing.
      }
      return {
        status: 'confirmed',
        signature: expectedSignature,
        transferredLamports: transferLamports,
        newBalanceLamports: refreshed?.value ?? null,
      };
    },
  };
}
