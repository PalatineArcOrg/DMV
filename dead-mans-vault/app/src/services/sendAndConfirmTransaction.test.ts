import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

function dependencies(
  harness: Harness,
  overrides: {
    getLatestBlockhash?: () => Promise<{
      blockhash: string;
      lastValidBlockHeight: number;
    }>;
    sendRawTransaction?: (
      serializedTransaction: Uint8Array,
    ) => Promise<string>;
    confirmTransaction?: (
      strategy: Harness['confirmationStrategies'][number],
    ) => Promise<unknown>;
  } = {},
) {
  return {
    getLatestBlockhash: async () => {
      harness.calls.latestBlockhash += 1;
      return overrides.getLatestBlockhash
        ? overrides.getLatestBlockhash()
        : {
            blockhash: 'mock-blockhash',
            lastValidBlockHeight: 4321,
          };
    },
    sendRawTransaction: async (
      serializedTransaction: Uint8Array,
    ) => {
      harness.calls.send += 1;
      harness.sentPayloads.push(serializedTransaction);
      return overrides.sendRawTransaction
        ? overrides.sendRawTransaction(serializedTransaction)
        : 'mock-signature';
    },
    confirmTransaction: async (
      strategy: Harness['confirmationStrategies'][number],
    ) => {
      harness.calls.confirm += 1;
      harness.confirmationStrategies.push(strategy);
      return overrides.confirmTransaction
        ? overrides.confirmTransaction(strategy)
        : { value: { err: null } };
    },
  };
}

test('blockhash failure is submission_failed and sends nothing', async () => {
  const harness = makeHarness();
  const failure = new Error('mock blockhash failure');

  const result = await signSendAndConfirmTransaction(
    harness.transaction,
    harness.payer,
    [],
    dependencies(harness, {
      getLatestBlockhash: async () => {
        throw failure;
      },
    }),
  );

  assert.deepEqual(result, { status: 'submission_failed', error: failure });
  assert.equal(harness.calls.send, 0);
  assert.equal(harness.calls.confirm, 0);
});

test('signing failure is submission_failed', async () => {
  const harness = makeHarness();
  const failure = new Error('mock signing failure');
  harness.transaction.sign = () => {
    throw failure;
  };

  const result = await signSendAndConfirmTransaction(
    harness.transaction,
    harness.payer,
    [],
    dependencies(harness),
  );

  assert.deepEqual(result, { status: 'submission_failed', error: failure });
  assert.equal(harness.calls.send, 0);
  assert.equal(harness.calls.confirm, 0);
});

test('serialization failure is submission_failed', async () => {
  const harness = makeHarness();
  const failure = new Error('mock serialization failure');
  harness.transaction.serialize = () => {
    throw failure;
  };

  const result = await signSendAndConfirmTransaction(
    harness.transaction,
    harness.payer,
    [],
    dependencies(harness),
  );

  assert.deepEqual(result, { status: 'submission_failed', error: failure });
  assert.equal(harness.calls.send, 0);
});

test('send failure before a signature is submission_failed', async () => {
  const harness = makeHarness();
  const failure = new Error('mock send failure');

  const result = await signSendAndConfirmTransaction(
    harness.transaction,
    harness.payer,
    [],
    dependencies(harness, {
      sendRawTransaction: async () => {
        throw failure;
      },
    }),
  );

  assert.deepEqual(result, { status: 'submission_failed', error: failure });
  assert.equal(harness.calls.send, 1);
  assert.equal(harness.calls.confirm, 0);
});

test('explicit null confirmation error returns confirmed', async () => {
  const harness = makeHarness();
  const extraSigner: FakeSigner = {
    name: 'extra',
    publicKey: { value: 'extra-public-key' },
  };

  const result = await signSendAndConfirmTransaction(
    harness.transaction,
    harness.payer,
    [extraSigner],
    dependencies(harness),
  );

  assert.deepEqual(result, {
    status: 'confirmed',
    signature: 'mock-signature',
  });
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

test('non-null confirmation error returns confirmed_failed with signature', async () => {
  const harness = makeHarness();
  const transactionError = {
    InstructionError: [0, 'Custom'],
  };

  const result = await signSendAndConfirmTransaction(
    harness.transaction,
    harness.payer,
    [],
    dependencies(harness, {
      confirmTransaction: async () => ({
        value: { err: transactionError },
      }),
    }),
  );

  assert.deepEqual(result, {
    status: 'confirmed_failed',
    signature: 'mock-signature',
    transactionError,
  });
  assert.equal(harness.calls.send, 1);
  assert.equal(harness.calls.confirm, 1);
});

test('confirmation exception returns confirmation_unknown with signature', async () => {
  const harness = makeHarness();
  const failure = new Error('mock confirmation timeout');

  const result = await signSendAndConfirmTransaction(
    harness.transaction,
    harness.payer,
    [],
    dependencies(harness, {
      confirmTransaction: async () => {
        throw failure;
      },
    }),
  );

  assert.deepEqual(result, {
    status: 'confirmation_unknown',
    signature: 'mock-signature',
    error: failure,
  });
  assert.equal(harness.calls.send, 1);
  assert.equal(harness.calls.confirm, 1);
});

test('malformed confirmation response is unknown and preserves signature', async () => {
  for (const malformed of [
    null,
    {},
    { value: null },
    { value: {} },
    { value: { err: undefined } },
  ]) {
    const harness = makeHarness();
    const result = await signSendAndConfirmTransaction(
      harness.transaction,
      harness.payer,
      [],
      dependencies(harness, {
        confirmTransaction: async () => malformed,
      }),
    );

    assert.equal(result.status, 'confirmation_unknown');
    if (result.status !== 'confirmation_unknown') continue;
    assert.equal(result.signature, 'mock-signature');
    assert.equal(harness.calls.send, 1);
    assert.equal(harness.calls.confirm, 1);
  }
});

test('every post-send result uses one send and one confirmation with no resend', async () => {
  const responses: Array<() => Promise<unknown>> = [
    async () => ({ value: { err: null } }),
    async () => ({ value: { err: { custom: 1 } } }),
    async () => {
      throw new Error('unknown');
    },
    async () => ({ malformed: true }),
  ];

  for (const confirmation of responses) {
    const harness = makeHarness();
    const result = await signSendAndConfirmTransaction(
      harness.transaction,
      harness.payer,
      [],
      dependencies(harness, {
        confirmTransaction: confirmation,
      }),
    );

    assert.notEqual(result.status, 'submission_failed');
    if (result.status === 'submission_failed') continue;
    assert.equal(result.signature, 'mock-signature');
    assert.equal(harness.calls.send, 1);
    assert.equal(harness.calls.confirm, 1);
  }
});

test('confirmation helper structurally inspects value.err and contains no retry or logging path', () => {
  const source = readFileSync(
    new URL('./sendAndConfirmTransaction.ts', import.meta.url),
    'utf8',
  );

  assert.match(source, /hasOwnProperty\.call\(value, 'err'\)/);
  assert.match(source, /transactionError === null/);
  assert.doesNotMatch(source, /while\s*\(|setInterval|setTimeout/);
  assert.doesNotMatch(source, /console\.|JSON\.stringify/);
  assert.equal(
    (source.match(/dependencies\.sendRawTransaction\(/g) ?? []).length,
    1,
  );
});

test('recordHeartbeatOnChain returns the structured lifecycle result while retaining the agent payer path', () => {
  const source = readFileSync(
    new URL('./VaultTransactionService.ts', import.meta.url),
    'utf8',
  );
  const heartbeatMethod = source.slice(
    source.indexOf('async recordHeartbeatOnChain'),
    source.indexOf('async buildUpdateVaultTx'),
  );

  assert.match(heartbeatMethod, /Promise<SendAndConfirmResult>/);
  assert.match(heartbeatMethod, /this\.getProgram\(agentKeypair\)/);
  assert.match(heartbeatMethod, /agent: agentKeypair\.publicKey/);
  assert.match(heartbeatMethod, /return this\.sendWithPayerResult\(/);
  assert.doesNotMatch(heartbeatMethod, /owner.*sign|signTransaction/);
});
