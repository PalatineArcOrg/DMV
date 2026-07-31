import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  signSendAndConfirmTransaction,
  type SignableTransaction,
} from './sendAndConfirmTransaction.ts';

interface FakePublicKey {
  value: string;
}

interface FakeSigner {
  name: string;
  publicKey: FakePublicKey;
}

interface Harness {
  payer: FakeSigner;
  transaction: SignableTransaction<FakePublicKey, FakeSigner>;
  signedBy: Array<FakeSigner>;
  sentPayloads: Array<Uint8Array>;
  confirmationStrategies: Array<{
    signature: string;
    blockhash: string;
    lastValidBlockHeight: number;
  }>;
  calls: {
    latestBlockhash: number;
    send: number;
    confirm: number;
  };
}

function makeHarness(): Harness {
  const signedBy: Array<FakeSigner> = [];
  const sentPayloads: Array<Uint8Array> = [];
  const confirmationStrategies: Harness['confirmationStrategies'] = [];
  const payer = {
    name: 'agent',
    publicKey: { value: 'agent-public-key' },
  };
  return {
    payer,
    signedBy,
    sentPayloads,
    confirmationStrategies,
    calls: {
      latestBlockhash: 0,
      send: 0,
      confirm: 0,
    },
    transaction: {
      sign: (...signers) => {
        signedBy.push(...signers);
      },
      serialize: () => new Uint8Array([1, 2, 3]),
    },
  };
}

test('agent is fee payer and signer; transaction is sent and confirmed once with its validity window', async () => {
  const harness = makeHarness();
  const extraSigner: FakeSigner = {
    name: 'extra',
    publicKey: { value: 'extra-public-key' },
  };

  const signature = await signSendAndConfirmTransaction(
    harness.transaction,
    harness.payer,
    [extraSigner],
    {
      getLatestBlockhash: async () => {
        harness.calls.latestBlockhash += 1;
        return {
          blockhash: 'mock-blockhash',
          lastValidBlockHeight: 4321,
        };
      },
      sendRawTransaction: async (serializedTransaction) => {
        harness.calls.send += 1;
        harness.sentPayloads.push(serializedTransaction);
        return 'mock-signature';
      },
      confirmTransaction: async (strategy) => {
        harness.calls.confirm += 1;
        harness.confirmationStrategies.push(strategy);
        return { value: { err: null } };
      },
    },
  );

  assert.equal(signature, 'mock-signature');
  assert.equal(harness.transaction.feePayer, harness.payer.publicKey);
  assert.equal(harness.transaction.recentBlockhash, 'mock-blockhash');
  assert.deepEqual(harness.signedBy, [harness.payer, extraSigner]);
  assert.equal(harness.calls.latestBlockhash, 1);
  assert.equal(harness.calls.send, 1);
  assert.equal(harness.calls.confirm, 1);
  assert.deepEqual(harness.sentPayloads, [new Uint8Array([1, 2, 3])]);
  assert.deepEqual(harness.confirmationStrategies, [{
    signature: 'mock-signature',
    blockhash: 'mock-blockhash',
    lastValidBlockHeight: 4321,
  }]);
});

test('a thrown confirmation error rejects the transaction path', async () => {
  const harness = makeHarness();
  const confirmationError = new Error('mock confirmation timeout');

  await assert.rejects(
    signSendAndConfirmTransaction(
      harness.transaction,
      harness.payer,
      [],
      {
        getLatestBlockhash: async () => ({
          blockhash: 'mock-blockhash',
          lastValidBlockHeight: 4321,
        }),
        sendRawTransaction: async () => {
          harness.calls.send += 1;
          return 'mock-signature';
        },
        confirmTransaction: async () => {
          harness.calls.confirm += 1;
          throw confirmationError;
        },
      },
    ),
    confirmationError,
  );
  assert.equal(harness.calls.send, 1);
  assert.equal(harness.calls.confirm, 1);
});

test('current defect: a resolved confirmation value.err is not rejected', async () => {
  const harness = makeHarness();

  const signature = await signSendAndConfirmTransaction(
    harness.transaction,
    harness.payer,
    [],
    {
      getLatestBlockhash: async () => ({
        blockhash: 'mock-blockhash',
        lastValidBlockHeight: 4321,
      }),
      sendRawTransaction: async () => 'mock-signature',
      confirmTransaction: async () => ({
        value: {
          err: {
            InstructionError: [0, 'Custom'],
          },
        },
      }),
    },
  );

  assert.equal(signature, 'mock-signature');
});
