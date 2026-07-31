import {
  Keypair,
  PublicKey,
  Transaction,
  type BlockhashWithExpiryBlockHeight,
} from '@solana/web3.js';
import bs58 from 'bs58';

export type AgentRotationTransactionPreparationResult =
  | {
      status: 'fully_signed';
      transaction: Transaction;
      signature: string;
      blockhashValidity: BlockhashWithExpiryBlockHeight;
      feeLamports: number;
      candidateBalanceLamports: number;
    }
  | {
      status: 'candidate_not_funded';
      balanceLamports: number;
      feeLamports: number;
      shortfallLamports: number;
    }
  | { status: 'owner_cancelled' }
  | { status: 'wallet_transaction_modified' }
  | { status: 'preparation_failed'; error: unknown };

export interface AgentRotationTransactionDependencies {
  buildRotationTransaction: (
    owner: PublicKey,
    candidate: PublicKey,
  ) => Promise<Transaction>;
  getLatestBlockhash: () => Promise<BlockhashWithExpiryBlockHeight>;
  getFeeForMessage: (transaction: Transaction) => Promise<unknown>;
  getCandidateBalance: (
    candidate: PublicKey,
    minimumContextSlot: number,
  ) => Promise<unknown>;
  signWithOwnerWallet: (
    transaction: Transaction,
  ) => Promise<Transaction>;
  isOwnerCancellation: (error: unknown) => boolean;
}

interface ContextLamports {
  slot: number;
  value: number;
}

function parseContextLamports(value: unknown): ContextLamports | null {
  if (!value || typeof value !== 'object') return null;
  const context = Reflect.get(value, 'context');
  if (!context || typeof context !== 'object') return null;
  const slot = Reflect.get(context, 'slot');
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

function findSignature(
  transaction: Transaction,
  signer: PublicKey,
): Buffer | null {
  const entry = transaction.signatures.find((candidate) =>
    candidate.publicKey.equals(signer),
  );
  return entry?.signature ? Buffer.from(entry.signature) : null;
}

export function validateDualSignedRotationTransaction(input: {
  expected: Transaction;
  returned: Transaction;
  owner: PublicKey;
  candidate: PublicKey;
  expectedCandidateSignature: Buffer;
}): boolean {
  const { expected, returned, owner, candidate } = input;
  if (
    !returned.feePayer?.equals(candidate) ||
    returned.recentBlockhash !== expected.recentBlockhash
  ) {
    return false;
  }
  if (
    !Buffer.from(returned.serializeMessage()).equals(
      expected.serializeMessage(),
    )
  ) {
    return false;
  }
  const candidateSignature = findSignature(returned, candidate);
  const ownerSignature = findSignature(returned, owner);
  if (
    !candidateSignature ||
    !ownerSignature ||
    !candidateSignature.equals(input.expectedCandidateSignature)
  ) {
    return false;
  }
  const first = returned.signatures[0];
  if (
    !first ||
    !first.publicKey.equals(candidate) ||
    !first.signature ||
    !Buffer.from(first.signature).equals(candidateSignature) ||
    !returned.signature ||
    !Buffer.from(returned.signature).equals(candidateSignature)
  ) {
    return false;
  }
  return returned.verifySignatures();
}

export function createAgentRotationTransactionPreparer(
  dependencies: AgentRotationTransactionDependencies,
) {
  return {
    prepare: async (
      owner: PublicKey,
      candidateKeypair: Keypair,
    ): Promise<AgentRotationTransactionPreparationResult> => {
      let transaction: Transaction;
      let blockhashValidity: BlockhashWithExpiryBlockHeight;
      let fee: ContextLamports | null;
      try {
        transaction = await dependencies.buildRotationTransaction(
          owner,
          candidateKeypair.publicKey,
        );
        transaction.feePayer = candidateKeypair.publicKey;
        blockhashValidity = await dependencies.getLatestBlockhash();
        transaction.recentBlockhash = blockhashValidity.blockhash;
        // This exact compiled message is retained through both signatures.
        transaction.compileMessage();
        fee = parseContextLamports(
          await dependencies.getFeeForMessage(transaction),
        );
      } catch (error: unknown) {
        return { status: 'preparation_failed', error };
      }
      if (!fee) {
        return {
          status: 'preparation_failed',
          error: new Error('Rotation fee response was invalid'),
        };
      }

      let balance: ContextLamports | null;
      try {
        balance = parseContextLamports(
          await dependencies.getCandidateBalance(
            candidateKeypair.publicKey,
            fee.slot,
          ),
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
      if (balance.value < fee.value) {
        return {
          status: 'candidate_not_funded',
          balanceLamports: balance.value,
          feeLamports: fee.value,
          shortfallLamports: fee.value - balance.value,
        };
      }

      try {
        transaction.partialSign(candidateKeypair);
      } catch (error: unknown) {
        return { status: 'preparation_failed', error };
      }
      const candidateSignature = findSignature(
        transaction,
        candidateKeypair.publicKey,
      );
      if (
        !candidateSignature ||
        !transaction.signature ||
        !Buffer.from(transaction.signature).equals(candidateSignature)
      ) {
        return {
          status: 'preparation_failed',
          error: new Error(
            'Candidate fee-payer signature could not be derived',
          ),
        };
      }
      const expectedSignature = bs58.encode(candidateSignature);

      let walletTransaction: Transaction;
      try {
        walletTransaction =
          await dependencies.signWithOwnerWallet(transaction);
      } catch (error: unknown) {
        if (dependencies.isOwnerCancellation(error)) {
          return { status: 'owner_cancelled' };
        }
        return { status: 'preparation_failed', error };
      }
      if (
        !(walletTransaction instanceof Transaction) ||
        !validateDualSignedRotationTransaction({
          expected: transaction,
          returned: walletTransaction,
          owner,
          candidate: candidateKeypair.publicKey,
          expectedCandidateSignature: candidateSignature,
        })
      ) {
        return { status: 'wallet_transaction_modified' };
      }

      // Require fully signed serialisation before the journal boundary. The
      // serialized bytes are never returned to persistence and never logged.
      try {
        walletTransaction.serialize({
          requireAllSignatures: true,
          verifySignatures: true,
        });
      } catch (error: unknown) {
        return { status: 'preparation_failed', error };
      }
      return {
        status: 'fully_signed',
        transaction: walletTransaction,
        signature: expectedSignature,
        blockhashValidity,
        feeLamports: fee.value,
        candidateBalanceLamports: balance.value,
      };
    },
  };
}
