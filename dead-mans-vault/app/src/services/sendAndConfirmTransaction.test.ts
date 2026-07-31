import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import bs58 from 'bs58';
import {
  Keypair,
  SystemProgram,
  Transaction,
} from '@solana/web3.js';
import {
  signSendAndConfirmTransaction,
  signSendAndConfirmPreparedTransaction,
  type SendAndConfirmLifecycle,
  type SignableTransaction,
} from './sendAndConfirmTransaction.ts';

interface FakePublicKey {
  value: string;
}

interface FakeSigner {
  name: string;
  publicKey: FakePublicKey;
}

function makeHarness() {
  const events: Array<string> = [];
  const payer: FakeSigner = {
    name: 'agent',
    publicKey: { value: 'agent-public-key' },
  };
  const transaction: SignableTransaction<FakePublicKey, FakeSigner> = {
    sign: (...signers) => {
      assert.strictEqual(signers[0], payer);
      events.push('sign');
    },
    serialize: () => {
      events.push('serialize');
      return new Uint8Array([1, 2, 3]);
    },
  };
  let sendCalls = 0;
  let confirmCalls = 0;
  const dependencies = {
    getLatestBlockhash: async () => ({
      blockhash: 'mock-blockhash',
      lastValidBlockHeight: 4321,
    }),
    deriveExpectedSignature: () => {
      events.push('derive signature');
      return 'expected-signature';
    },
    sendRawTransaction: async () => {
      sendCalls += 1;
      events.push('send');
      return 'expected-signature';
    },
    confirmTransaction: async () => {
      confirmCalls += 1;
      events.push('confirm');
      return { value: { err: null } };
    },
  };
  const lifecycle: SendAndConfirmLifecycle = {
    onPrepared: async () => {
      events.push('prepared journal');
    },
    onSubmitted: async () => {
      events.push('submitted journal');
    },
    onSubmissionUnknown: async () => {
      events.push('submission unknown journal');
    },
    onConfirmationUnknown: async () => {
      events.push('confirmation unknown journal');
    },
    onConfirmedFailed: async () => {
      events.push('failed journal');
    },
  };
  return {
    payer,
    transaction,
    events,
    dependencies,
    lifecycle,
    sendCalls: () => sendCalls,
    confirmCalls: () => confirmCalls,
  };
}

test('signature is derived after signing and PREPARED is durable before one RPC send', async () => {
  const harness = makeHarness();
  const result = await signSendAndConfirmTransaction(
    harness.transaction,
    harness.payer,
    [],
    harness.dependencies,
    harness.lifecycle,
  );

  assert.deepEqual(result, {
    status: 'confirmed',
    signature: 'expected-signature',
  });
  assert.equal(harness.transaction.feePayer, harness.payer.publicKey);
  assert.equal(harness.transaction.recentBlockhash, 'mock-blockhash');
  assert.deepEqual(harness.events, [
    'sign',
    'derive signature',
    'serialize',
    'prepared journal',
    'send',
    'submitted journal',
    'confirm',
  ]);
  assert.equal(harness.sendCalls(), 1);
  assert.equal(harness.confirmCalls(), 1);
});

test('a pre-blockhashed exact transaction is signed and sent without obtaining another blockhash', async () => {
  const harness = makeHarness();
  let unexpectedBlockhashCalls = 0;
  harness.dependencies.getLatestBlockhash = async () => {
    unexpectedBlockhashCalls += 1;
    throw new Error('must not obtain another blockhash');
  };
  harness.transaction.feePayer = harness.payer.publicKey;
  harness.transaction.recentBlockhash = 'exact-message-blockhash';
  const result = await signSendAndConfirmPreparedTransaction(
    harness.transaction,
    harness.payer,
    [],
    {
      blockhash: 'exact-message-blockhash',
      lastValidBlockHeight: 4321,
    },
    {
      deriveExpectedSignature:
        harness.dependencies.deriveExpectedSignature,
      sendRawTransaction: harness.dependencies.sendRawTransaction,
      confirmTransaction: harness.dependencies.confirmTransaction,
    },
    harness.lifecycle,
  );
  assert.equal(result.status, 'confirmed');
  assert.equal(unexpectedBlockhashCalls, 0);
  assert.equal(harness.sendCalls(), 1);
  assert.equal(harness.confirmCalls(), 1);
});

test('blockhash, signing, signature extraction, and serialization failures are preparation_failed with no send', async (context) => {
  const cases: Array<{
    name: string;
    mutate: (harness: ReturnType<typeof makeHarness>) => void;
  }> = [
    {
      name: 'blockhash',
      mutate: (harness) => {
        harness.dependencies.getLatestBlockhash = async () => {
          throw new Error('blockhash');
        };
      },
    },
    {
      name: 'signing',
      mutate: (harness) => {
        harness.transaction.sign = () => {
          throw new Error('signing');
        };
      },
    },
    {
      name: 'signature extraction',
      mutate: (harness) => {
        harness.dependencies.deriveExpectedSignature = () => {
          throw new Error('signature');
        };
      },
    },
    {
      name: 'serialization',
      mutate: (harness) => {
        harness.transaction.serialize = () => {
          throw new Error('serialization');
        };
      },
    },
  ];

  for (const scenario of cases) {
    await context.test(scenario.name, async () => {
      const harness = makeHarness();
      scenario.mutate(harness);
      const result = await signSendAndConfirmTransaction(
        harness.transaction,
        harness.payer,
        [],
        harness.dependencies,
        harness.lifecycle,
      );
      assert.equal(result.status, 'preparation_failed');
      assert.equal(harness.sendCalls(), 0);
      assert.equal(harness.confirmCalls(), 0);
      assert.equal(harness.events.includes('prepared journal'), false);
    });
  }
});

test('journal failure is fail-closed before send', async () => {
  const harness = makeHarness();
  harness.lifecycle.onPrepared = async () => {
    throw new Error('disk unavailable');
  };
  const result = await signSendAndConfirmTransaction(
    harness.transaction,
    harness.payer,
    [],
    harness.dependencies,
    harness.lifecycle,
  );
  assert.equal(result.status, 'journal_failed');
  assert.equal(harness.sendCalls(), 0);
  assert.equal(harness.confirmCalls(), 0);
});

test('a send exception after PREPARED is submission_unknown and never resent', async () => {
  const harness = makeHarness();
  harness.dependencies.sendRawTransaction = async () => {
    harness.events.push('send');
    throw new Error('connection lost');
  };
  const result = await signSendAndConfirmTransaction(
    harness.transaction,
    harness.payer,
    [],
    harness.dependencies,
    harness.lifecycle,
  );
  assert.equal(result.status, 'submission_unknown');
  if (result.status !== 'submission_unknown') return;
  assert.equal(result.signature, 'expected-signature');
  assert.equal(result.safeErrorCode, 'send_exception');
  assert.equal(harness.events.filter((event) => event === 'send').length, 1);
  assert.equal(harness.confirmCalls(), 0);
});

test('empty or mismatched RPC signature is submission_unknown using only the expected ID', async (context) => {
  for (const rpcSignature of ['', 'different-signature']) {
    await context.test(rpcSignature || 'empty', async () => {
      const harness = makeHarness();
      harness.dependencies.sendRawTransaction = async () => rpcSignature;
      const result = await signSendAndConfirmTransaction(
        harness.transaction,
        harness.payer,
        [],
        harness.dependencies,
        harness.lifecycle,
      );
      assert.equal(result.status, 'submission_unknown');
      if (result.status !== 'submission_unknown') return;
      assert.equal(result.signature, 'expected-signature');
      assert.equal(
        result.safeErrorCode,
        rpcSignature
          ? 'rpc_signature_mismatch'
          : 'empty_rpc_signature',
      );
      assert.equal(
        result.rpcSignature,
        rpcSignature || undefined,
      );
      assert.equal(harness.confirmCalls(), 0);
    });
  }
});

test('confirmation value.err taxonomy preserves the expected signature', async (context) => {
  const scenarios: Array<{
    name: string;
    response: unknown;
    expected: string;
  }> = [
    {
      name: 'confirmed',
      response: { value: { err: null } },
      expected: 'confirmed',
    },
    {
      name: 'confirmed failed',
      response: { value: { err: { custom: 1 } } },
      expected: 'confirmed_failed',
    },
    {
      name: 'malformed',
      response: { value: {} },
      expected: 'confirmation_unknown',
    },
  ];
  for (const scenario of scenarios) {
    await context.test(scenario.name, async () => {
      const harness = makeHarness();
      harness.dependencies.confirmTransaction = async () =>
        scenario.response;
      const result = await signSendAndConfirmTransaction(
        harness.transaction,
        harness.payer,
        [],
        harness.dependencies,
        harness.lifecycle,
      );
      assert.equal(result.status, scenario.expected);
      assert.ok('signature' in result);
      if ('signature' in result) {
        assert.equal(result.signature, 'expected-signature');
      }
      assert.equal(harness.sendCalls(), 1);
    });
  }
});

test('confirmation exception is confirmation_unknown with the durable expected signature', async () => {
  const harness = makeHarness();
  harness.dependencies.confirmTransaction = async () => {
    throw new Error('timeout');
  };
  const result = await signSendAndConfirmTransaction(
    harness.transaction,
    harness.payer,
    [],
    harness.dependencies,
    harness.lifecycle,
  );
  assert.equal(result.status, 'confirmation_unknown');
  if (result.status !== 'confirmation_unknown') return;
  assert.equal(result.signature, 'expected-signature');
  assert.equal(harness.sendCalls(), 1);
  assert.equal(harness.events.includes('confirmation unknown journal'), true);
});

test('legacy web3 Transaction exposes the fee-payer transaction ID signature before send', async () => {
  const payer = Keypair.generate();
  const recipient = Keypair.generate().publicKey;
  const transaction = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: recipient,
      lamports: 1,
    }),
  );
  const blockhash = Keypair.generate().publicKey.toBase58();
  let preparedSignature = '';
  let sentSignature = '';

  const result = await signSendAndConfirmTransaction(
    transaction,
    payer,
    [],
    {
      getLatestBlockhash: async () => ({
        blockhash,
        lastValidBlockHeight: 100,
      }),
      deriveExpectedSignature: (signed, expectedPayer) => {
        const payerEntry = signed.signatures.find((entry) =>
          entry.publicKey.equals(expectedPayer.publicKey));
        assert.ok(payerEntry?.signature);
        assert.ok(signed.signature);
        assert.deepEqual(signed.signature, payerEntry.signature);
        return bs58.encode(payerEntry.signature);
      },
      sendRawTransaction: async () => {
        sentSignature = preparedSignature;
        return sentSignature;
      },
      confirmTransaction: async () => ({ value: { err: null } }),
    },
    {
      onPrepared: async (prepared) => {
        preparedSignature = prepared.signature;
      },
    },
  );

  assert.equal(result.status, 'confirmed');
  assert.equal(preparedSignature, sentSignature);
  assert.equal(bs58.decode(preparedSignature).length, 64);
});

test('helper has one send site and persists neither transaction bytes nor key material', () => {
  const source = readFileSync(
    new URL('./sendAndConfirmTransaction.ts', import.meta.url),
    'utf8',
  );
  assert.equal(
    (source.match(/dependencies\.sendRawTransaction\(/g) ?? []).length,
    1,
  );
  assert.match(
    source,
    /transaction\.sign[\s\S]*deriveExpectedSignature[\s\S]*transaction\.serialize[\s\S]*lifecycle\.onPrepared[\s\S]*sendRawTransaction/,
  );
  assert.doesNotMatch(source, /while\s*\(|setInterval|setTimeout/);
  assert.doesNotMatch(source, /console\.|JSON\.stringify/);
});

test('heartbeat preparation and submission preserve exact agent-paid transaction and journal lifecycle', () => {
  const source = readFileSync(
    new URL('./VaultTransactionService.ts', import.meta.url),
    'utf8',
  );
  const heartbeatMethod = source.slice(
    source.indexOf('async recordHeartbeatOnChain'),
    source.indexOf('async buildUpdateVaultTx'),
  );
  const preparationMethod = source.slice(
    source.indexOf('async prepareHeartbeatTransaction'),
    source.indexOf('async recordHeartbeatOnChain'),
  );
  assert.match(heartbeatMethod, /lifecycle: SendAndConfirmLifecycle/);
  assert.match(
    heartbeatMethod,
    /signSendAndConfirmPreparedTransaction/,
  );
  assert.match(
    heartbeatMethod,
    /agentKeypair\.publicKey\.equals\(prepared\.agent\)/,
  );
  assert.match(preparationMethod, /agent: agentPubkey/);
  assert.match(preparationMethod, /transaction\.compileMessage\(\)/);
  assert.match(preparationMethod, /getFeeForMessage/);
  assert.match(preparationMethod, /getBalanceAndContext/);
  assert.match(
    source,
    /payerEntry[\s\S]*signedTransaction\.signature[\s\S]*bs58\.encode/,
  );
  assert.doesNotMatch(heartbeatMethod, /owner.*sign|signTransaction/);
});
