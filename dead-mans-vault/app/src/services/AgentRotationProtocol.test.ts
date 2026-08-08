import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  Keypair,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';

test('deployed rotate_agent requires owner but does not protocol-require new agent signer', () => {
  const program = readFileSync(
    new URL(
      '../../../programs/dead-mans-vault/src/instructions/rotate_agent.rs',
      import.meta.url,
    ),
    'utf8',
  );
  assert.match(program, /pub owner: Signer<'info>/);
  assert.match(program, /new_agent_pubkey: Pubkey/);
  assert.doesNotMatch(program, /new_agent: Signer<'info>/);
  assert.match(program, /vault\.agent_pubkey = new_agent_pubkey/);
});

test('installed MWA serializes legacy transactions with partial signatures preserved', () => {
  const adapter = readFileSync(
    new URL(
      '../../node_modules/@solana-mobile/mobile-wallet-adapter-protocol-web3js/lib/cjs/index.native.js',
      import.meta.url,
    ),
    'utf8',
  );
  assert.match(adapter, /requireAllSignatures: false/);
  assert.match(adapter, /verifySignatures: false/);
  assert.match(adapter, /Transaction\.from\(byteArray\)/);
});

test('candidate fee payer and owner instruction signer are both transaction-required signatures', () => {
  const owner = Keypair.generate();
  const candidate = Keypair.generate();
  const transaction = new Transaction({
    feePayer: candidate.publicKey,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
  }).add(
    new TransactionInstruction({
      programId: Keypair.generate().publicKey,
      keys: [
        {
          pubkey: owner.publicKey,
          isSigner: true,
          isWritable: false,
        },
      ],
      data: Buffer.alloc(0),
    }),
  );
  transaction.partialSign(candidate);
  assert.throws(() =>
    transaction.serialize({
      requireAllSignatures: true,
      verifySignatures: true,
    }),
  );
  transaction.partialSign(owner);
  assert.doesNotThrow(() =>
    transaction.serialize({
      requireAllSignatures: true,
      verifySignatures: true,
    }),
  );
  assert.equal(transaction.verifySignatures(), true);
});

test('MWA wire roundtrip retains candidate transaction-ID signature while owner signs', () => {
  const owner = Keypair.generate();
  const candidate = Keypair.generate();
  const transaction = new Transaction({
    feePayer: candidate.publicKey,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
  }).add(
    new TransactionInstruction({
      programId: Keypair.generate().publicKey,
      keys: [
        {
          pubkey: owner.publicKey,
          isSigner: true,
          isWritable: false,
        },
      ],
      data: candidate.publicKey.toBuffer(),
    }),
  );
  transaction.partialSign(candidate);
  const candidateSignature = Buffer.from(transaction.signature!);
  const wire = transaction.serialize({
    requireAllSignatures: false,
    verifySignatures: false,
  });
  const walletTransaction = Transaction.from(wire);
  walletTransaction.partialSign(owner);
  assert.deepEqual(
    Buffer.from(walletTransaction.signature!),
    candidateSignature,
  );
  assert.equal(walletTransaction.verifySignatures(), true);
});

test('extra signer account could require a transaction signature but is not the selected official proof mechanism', () => {
  const owner = Keypair.generate();
  const candidate = Keypair.generate();
  const payer = Keypair.generate();
  const transaction = new Transaction({
    feePayer: payer.publicKey,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
  }).add(
    new TransactionInstruction({
      programId: Keypair.generate().publicKey,
      keys: [
        {
          pubkey: owner.publicKey,
          isSigner: true,
          isWritable: false,
        },
        {
          pubkey: candidate.publicKey,
          isSigner: true,
          isWritable: false,
        },
      ],
      data: Buffer.alloc(0),
    }),
  );
  transaction.partialSign(payer, owner);
  assert.throws(() => transaction.serialize());
  transaction.partialSign(candidate);
  assert.doesNotThrow(() => transaction.serialize());
});
