import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Keypair,
  PublicKey,
  SystemInstruction,
  SystemProgram,
  Transaction,
} from '@solana/web3.js';
import type { AgentReadinessResult } from './AgentReadinessService.ts';
import { createAgentTopUpService } from './AgentTopUpService.ts';

const OWNER = Keypair.generate();
const AGENT = Keypair.generate();
const VAULT = Keypair.generate().publicKey;
const HEARTBEAT = Keypair.generate().publicKey;
const BLOCKHASH = Keypair.generate().publicKey.toBase58();

const READY: AgentReadinessResult = {
  status: 'ready',
  owner: OWNER.publicKey,
  vault: VAULT,
  heartbeat: HEARTBEAT,
  localAgent: AGENT.publicKey,
  onChainAgent: AGENT.publicKey,
  keypair: AGENT,
  vaultConfig: {
    heartbeatInterval: 86_400,
    gracePeriod: 604_800,
    active: true,
    executed: false,
  },
  heartbeatBefore: {
    lastHeartbeat: 1_000,
    lastMethod: 0,
    totalHeartbeats: 1n,
  },
};

function rpcValue(value: number, slot: number) {
  return { context: { slot }, value };
}

function makeHarness(overrides: {
  readiness?: AgentReadinessResult;
  initialAgentBalance?: number;
  ownerBalance?: number;
  approved?: boolean;
  signError?: Error;
  mutateSignedMessage?: boolean;
  wrongWallet?: boolean;
  sendError?: Error;
  rpcSignature?: string;
  confirmation?: unknown;
} = {}) {
  const events: Array<string> = [];
  const signedTransactions: Array<Transaction> = [];
  let expectedSignature = '';
  let balanceCalls = 0;
  let sendCalls = 0;
  let signCalls = 0;
  let confirmationCalls = 0;
  const initialAgentBalance =
    overrides.initialAgentBalance ?? 1_000_000;
  const service = createAgentTopUpService({
    checkAgentReadiness: async () => {
      events.push('readiness');
      return overrides.readiness ?? READY;
    },
    assertNetworkVerified: () => {
      events.push('network verified');
    },
    getBalance: async (address, minimumContextSlot) => {
      balanceCalls += 1;
      if (address.equals(AGENT.publicKey)) {
        if (balanceCalls === 1) {
          return rpcValue(initialAgentBalance, 10);
        }
        return rpcValue(5_000_000, minimumContextSlot ?? 13);
      }
      assert.ok(address.equals(OWNER.publicKey));
      return rpcValue(overrides.ownerBalance ?? 10_000_000, 12);
    },
    getLatestBlockhash: async () => {
      events.push('blockhash');
      return {
        blockhash: BLOCKHASH,
        lastValidBlockHeight: 500,
      };
    },
    getFeeForMessage: async (transaction) => {
      events.push('fee');
      assert.ok(transaction.feePayer?.equals(OWNER.publicKey));
      return rpcValue(5_000, 11);
    },
    confirmTransfer: async (confirmation) => {
      events.push('explicit confirmation');
      assert.ok(confirmation.agent.equals(AGENT.publicKey));
      assert.equal(
        confirmation.transferLamports,
        5_000_000 - initialAgentBalance,
      );
      assert.equal(confirmation.ownerFeeLamports, 5_000);
      return overrides.approved ?? true;
    },
    signTransaction: async (transaction) => {
      signCalls += 1;
      events.push('owner sign');
      if (overrides.signError) throw overrides.signError;
      assert.ok(transaction.feePayer?.equals(OWNER.publicKey));
      assert.equal(transaction.instructions.length, 1);
      assert.ok(
        transaction.instructions[0].programId.equals(
          SystemProgram.programId,
        ),
      );
      const decoded = SystemInstruction.decodeTransfer(
        transaction.instructions[0],
      );
      assert.ok(decoded.fromPubkey.equals(OWNER.publicKey));
      assert.ok(decoded.toPubkey.equals(AGENT.publicKey));
      if (overrides.mutateSignedMessage) {
        transaction.add(
          SystemProgram.transfer({
            fromPubkey: OWNER.publicKey,
            toPubkey: AGENT.publicKey,
            lamports: 1,
          }),
        );
      }
      transaction.sign(overrides.wrongWallet ? Keypair.generate() : OWNER);
      expectedSignature = transaction.signature
        ? (await import('bs58')).default.encode(transaction.signature)
        : '';
      signedTransactions.push(transaction);
      return transaction;
    },
    sendRawTransaction: async () => {
      sendCalls += 1;
      events.push('send');
      if (overrides.sendError) throw overrides.sendError;
      return overrides.rpcSignature ?? expectedSignature;
    },
    confirmTransaction: async () => {
      confirmationCalls += 1;
      events.push('confirm');
      return overrides.confirmation ?? { value: { err: null } };
    },
    isOwnerCancellation: (error) =>
      error instanceof Error && error.message === 'cancelled',
  });
  return {
    run: () => service.topUp(OWNER.publicKey, AGENT.publicKey),
    events,
    signedTransactions,
    counters: {
      balance: () => balanceCalls,
      send: () => sendCalls,
      sign: () => signCalls,
      confirmation: () => confirmationCalls,
    },
  };
}

test('explicit top-up sends one owner-paid System Program transfer to the canonical agent', async () => {
  const harness = makeHarness();
  const result = await harness.run();
  assert.equal(result.status, 'confirmed');
  if (result.status !== 'confirmed') return;
  assert.equal(result.transferredLamports, 4_000_000);
  assert.equal(result.ownerFeeLamports, 5_000);
  assert.equal(result.newBalanceLamports, 5_000_000);
  assert.equal(harness.counters.sign(), 1);
  assert.equal(harness.counters.send(), 1);
  assert.equal(harness.counters.confirmation(), 1);
  assert.deepEqual(harness.events, [
    'readiness',
    'network verified',
    'blockhash',
    'fee',
    'explicit confirmation',
    'owner sign',
    'send',
    'confirm',
  ]);
});

test('already-funded agent creates no transaction, signature request, or send', async () => {
  const harness = makeHarness({ initialAgentBalance: 5_000_000 });
  const result = await harness.run();
  assert.deepEqual(result, {
    status: 'already_funded',
    balanceLamports: 5_000_000,
  });
  assert.equal(harness.counters.sign(), 0);
  assert.equal(harness.counters.send(), 0);
});

test('missing, mismatched, inactive, and executed readiness block top-up', async (context) => {
  const cases: Array<AgentReadinessResult> = [
    { status: 'agent_missing' },
    {
      status: 'agent_mismatch',
      localAgent: AGENT.publicKey,
      onChainAgent: Keypair.generate().publicKey,
    },
    { status: 'vault_inactive' },
    { status: 'vault_executed' },
  ];
  for (const readiness of cases) {
    await context.test(readiness.status, async () => {
      const harness = makeHarness({ readiness });
      const result = await harness.run();
      assert.equal(result.status, 'precondition_failed');
      assert.equal(harness.counters.sign(), 0);
      assert.equal(harness.counters.send(), 0);
    });
  }
});

test('a changed expected destination is rejected before transaction construction', async () => {
  const serviceHarness = makeHarness();
  const service = createAgentTopUpService({
    checkAgentReadiness: async () => READY,
    assertNetworkVerified: () => {
      throw new Error('must not reach');
    },
    getBalance: async () => rpcValue(0, 1),
    getLatestBlockhash: async () => ({
      blockhash: BLOCKHASH,
      lastValidBlockHeight: 1,
    }),
    getFeeForMessage: async () => rpcValue(1, 1),
    confirmTransfer: async () => true,
    signTransaction: async (transaction) => transaction,
    sendRawTransaction: async () => '',
    confirmTransaction: async () => ({ value: { err: null } }),
    isOwnerCancellation: () => false,
  });
  const result = await service.topUp(
    OWNER.publicKey,
    Keypair.generate().publicKey,
  );
  assert.equal(result.status, 'destination_changed');
  assert.equal(serviceHarness.counters.send(), 0);
});

test('explicit owner cancellation and wallet cancellation send nothing', async (context) => {
  const cases = [
    { name: 'confirmation cancelled', approved: false },
    {
      name: 'wallet cancelled',
      approved: true,
      signError: new Error('cancelled'),
    },
  ];
  for (const scenario of cases) {
    await context.test(scenario.name, async () => {
      const harness = makeHarness(scenario);
      const result = await harness.run();
      assert.equal(result.status, 'owner_cancelled');
      assert.equal(harness.counters.send(), 0);
    });
  }
});

test('owner balance must cover the full top-up and network fee without partial transfer', async () => {
  const harness = makeHarness({ ownerBalance: 4_004_999 });
  const result = await harness.run();
  assert.equal(result.status, 'owner_insufficient_funds');
  if (result.status !== 'owner_insufficient_funds') return;
  assert.equal(result.requiredLamports, 4_005_000);
  assert.equal(harness.counters.sign(), 0);
  assert.equal(harness.counters.send(), 0);
});

test('wallet identity change or signed-message mutation is rejected before send', async (context) => {
  for (const overrides of [
    { wrongWallet: true },
    { mutateSignedMessage: true },
  ]) {
    await context.test(JSON.stringify(overrides), async () => {
      const harness = makeHarness(overrides);
      const result = await harness.run();
      assert.equal(result.status, 'submission_failed');
      assert.equal(harness.counters.send(), 0);
    });
  }
});

test('confirmation error and ambiguity preserve the submitted signature without retry', async (context) => {
  const cases = [
    {
      name: 'confirmed failed',
      confirmation: { value: { err: { custom: 1 } } },
      expected: 'transaction_failed',
    },
    {
      name: 'malformed confirmation',
      confirmation: {},
      expected: 'confirmation_unknown',
    },
    {
      name: 'send exception',
      sendError: new Error('offline'),
      expected: 'confirmation_unknown',
    },
  ];
  for (const scenario of cases) {
    await context.test(scenario.name, async () => {
      const harness = makeHarness(scenario);
      const result = await harness.run();
      assert.equal(result.status, scenario.expected);
      assert.ok('signature' in result && result.signature.length > 0);
      assert.equal(harness.counters.send(), 1);
    });
  }
});

test('top-up and heartbeat paths remain statically separated', () => {
  const topUpSource = readFileSync(
    new URL('./AgentTopUpService.ts', import.meta.url),
    'utf8',
  );
  const heartbeatSource = readFileSync(
    new URL('./HeartbeatCoordinator.ts', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(
    topUpSource,
    /recordHeartbeat|recordConfirmedHeartbeat|resetEscalation|notification|heartbeatOperation/,
  );
  assert.doesNotMatch(heartbeatSource, /AgentTopUp|SystemProgram|signTransaction/);
  assert.doesNotMatch(topUpSource, /setInterval|while\s*\(|retry|server.*payer|vault.*payer/i);
  assert.match(topUpSource, /toPubkey: ready\.onChainAgent/);
});
