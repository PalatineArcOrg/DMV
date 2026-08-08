import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import {
  createAgentRotationTransactionPreparer,
  validateDualSignedRotationTransaction,
} from './AgentRotationTransaction.ts';

function rotationInstruction(
  owner: PublicKey,
  candidate: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: Keypair.generate().publicKey,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: false },
      { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true },
    ],
    data: candidate.toBuffer(),
  });
}

function harness(
  mutate?: (
    transaction: Transaction,
    owner: Keypair,
  ) => Transaction,
) {
  const owner = Keypair.generate();
  const candidate = Keypair.generate();
  const events: Array<string> = [];
  let built: Transaction | null = null;
  const blockhash = Keypair.generate().publicKey.toBase58();
  const preparer = createAgentRotationTransactionPreparer({
    buildRotationTransaction: async (ownerPublicKey, candidatePublicKey) => {
      events.push('build');
      built = new Transaction().add(
        rotationInstruction(ownerPublicKey, candidatePublicKey),
      );
      return built;
    },
    getLatestBlockhash: async () => {
      events.push('blockhash');
      return { blockhash, lastValidBlockHeight: 500 };
    },
    getFeeForMessage: async (transaction) => {
      events.push('fee');
      assert.equal(transaction, built);
      assert.equal(
        transaction.feePayer?.equals(candidate.publicKey),
        true,
      );
      assert.equal(transaction.recentBlockhash, blockhash);
      return { context: { slot: 44 }, value: 6_000 };
    },
    getCandidateBalance: async (agent, minimumContextSlot) => {
      events.push('balance');
      assert.equal(agent.equals(candidate.publicKey), true);
      assert.equal(minimumContextSlot, 44);
      return { context: { slot: 45 }, value: 10_000 };
    },
    signWithOwnerWallet: async (transaction) => {
      events.push('owner-sign');
      const candidateSignature =
        transaction.signatures[0]?.signature;
      assert.ok(candidateSignature);
      const wire = transaction.serialize({
        requireAllSignatures: false,
        verifySignatures: false,
      });
      const walletTransaction = Transaction.from(wire);
      walletTransaction.partialSign(owner);
      if (mutate) return mutate(walletTransaction, owner);
      return walletTransaction;
    },
    isOwnerCancellation: () => false,
  });
  return { owner, candidate, events, preparer };
}

test('candidate fee payer signs first and survives owner-wallet MWA roundtrip', async () => {
  const { owner, candidate, events, preparer } = harness();

  const result = await preparer.prepare(owner.publicKey, candidate);

  assert.equal(result.status, 'fully_signed');
  if (result.status !== 'fully_signed') return;
  assert.equal(
    result.transaction.signatures[0].publicKey.equals(
      candidate.publicKey,
    ),
    true,
  );
  assert.equal(
    result.transaction.signatures[1].publicKey.equals(owner.publicKey),
    true,
  );
  assert.equal(result.transaction.verifySignatures(), true);
  assert.deepEqual(events, [
    'build',
    'blockhash',
    'fee',
    'balance',
    'owner-sign',
  ]);
});

test('candidate signature is the transaction-ID signature', async () => {
  const { owner, candidate, preparer } = harness();
  const result = await preparer.prepare(owner.publicKey, candidate);
  assert.equal(result.status, 'fully_signed');
  if (result.status !== 'fully_signed') return;
  assert.deepEqual(
    Buffer.from(result.transaction.signature!),
    Buffer.from(
      result.transaction.signatures.find((entry) =>
        entry.publicKey.equals(candidate.publicKey),
      )!.signature!,
    ),
  );
});

test('verified insufficient candidate balance blocks before candidate and owner signing', async () => {
  const owner = Keypair.generate();
  const candidate = Keypair.generate();
  let walletCalls = 0;
  const transaction = new Transaction().add(
    rotationInstruction(owner.publicKey, candidate.publicKey),
  );
  const preparer = createAgentRotationTransactionPreparer({
    buildRotationTransaction: async () => transaction,
    getLatestBlockhash: async () => ({
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 1,
    }),
    getFeeForMessage: async () => ({
      context: { slot: 1 },
      value: 5_000,
    }),
    getCandidateBalance: async () => ({
      context: { slot: 1 },
      value: 4_999,
    }),
    signWithOwnerWallet: async (value) => {
      walletCalls += 1;
      return value;
    },
    isOwnerCancellation: () => false,
  });

  const result = await preparer.prepare(owner.publicKey, candidate);

  assert.deepEqual(result, {
    status: 'candidate_not_funded',
    balanceLamports: 4_999,
    feeLamports: 5_000,
    shortfallLamports: 1,
  });
  assert.equal(walletCalls, 0);
  assert.equal(transaction.signature, null);
});

for (const scenario of [
  'fee payer',
  'blockhash',
  'instruction',
  'added instruction',
] as const) {
  test(`wallet-modified ${scenario} is rejected before send`, async () => {
    const { owner, candidate, preparer } = harness(
      (transaction) => {
        if (scenario === 'fee payer') {
          transaction.feePayer = owner.publicKey;
        } else if (scenario === 'blockhash') {
          transaction.recentBlockhash =
            Keypair.generate().publicKey.toBase58();
        } else if (scenario === 'instruction') {
          transaction.instructions[0].data[0] ^= 1;
        } else {
          transaction.add(
            rotationInstruction(owner.publicKey, candidate.publicKey),
          );
        }
        return transaction;
      },
    );

    const result = await preparer.prepare(owner.publicKey, candidate);

    assert.equal(result.status, 'wallet_transaction_modified');
  });
}

test('wallet removing candidate signature is rejected', async () => {
  const { owner, candidate, preparer } = harness((transaction) => {
    transaction.signatures.find((entry) =>
      entry.publicKey.equals(candidate.publicKey),
    )!.signature = null;
    return transaction;
  });

  assert.equal(
    (await preparer.prepare(owner.publicKey, candidate)).status,
    'wallet_transaction_modified',
  );
});

test('wallet omitting owner signature is rejected', async () => {
  const { owner, candidate, preparer } = harness((transaction) => {
    transaction.signatures.find((entry) =>
      entry.publicKey.equals(owner.publicKey),
    )!.signature = null;
    return transaction;
  });

  assert.equal(
    (await preparer.prepare(owner.publicKey, candidate)).status,
    'wallet_transaction_modified',
  );
});

test('owner cancellation returns owner_cancelled without weakening candidate custody', async () => {
  const owner = Keypair.generate();
  const candidate = Keypair.generate();
  const cancellation = new Error('wallet cancelled');
  const preparer = createAgentRotationTransactionPreparer({
    buildRotationTransaction: async () =>
      new Transaction().add(
        rotationInstruction(owner.publicKey, candidate.publicKey),
      ),
    getLatestBlockhash: async () => ({
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 1,
    }),
    getFeeForMessage: async () => ({
      context: { slot: 1 },
      value: 1,
    }),
    getCandidateBalance: async () => ({
      context: { slot: 1 },
      value: 10,
    }),
    signWithOwnerWallet: async () => {
      throw cancellation;
    },
    isOwnerCancellation: (error) => error === cancellation,
  });

  assert.deepEqual(
    await preparer.prepare(owner.publicKey, candidate),
    { status: 'owner_cancelled' },
  );
});

test('validation requires both signatures and the exact candidate signature', () => {
  const owner = Keypair.generate();
  const candidate = Keypair.generate();
  const transaction = new Transaction({
    feePayer: candidate.publicKey,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
  }).add(rotationInstruction(owner.publicKey, candidate.publicKey));
  transaction.partialSign(candidate);
  const candidateSignature = Buffer.from(transaction.signature!);
  const ownerSigned = Transaction.from(
    transaction.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    }),
  );
  ownerSigned.partialSign(owner);

  assert.equal(
    validateDualSignedRotationTransaction({
      expected: transaction,
      returned: ownerSigned,
      owner: owner.publicKey,
      candidate: candidate.publicKey,
      expectedCandidateSignature: candidateSignature,
    }),
    true,
  );
});
