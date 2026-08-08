import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PublicKey } from '@solana/web3.js';
import {
  createAgentFeeReadinessService,
} from './AgentFeeReadinessService.ts';
import {
  AGENT_RECOMMENDED_RESERVE_LAMPORTS,
  calculateAgentTopUpLamports,
} from './agentFundingPolicy.ts';

const AGENT = new PublicKey(Buffer.alloc(32, 7));
const MESSAGE = { exact: true };

function response(value: unknown, slot = 50) {
  return { context: { slot }, value };
}

function harness(
  fee: unknown = response(5_000, 40),
  balance: unknown = response(5_000_000, 41),
) {
  const balanceAddresses: Array<PublicKey> = [];
  const minimumSlots: Array<number> = [];
  const service = createAgentFeeReadinessService({
    getFeeForMessage: async (message) => {
      assert.strictEqual(message, MESSAGE);
      if (fee instanceof Error) throw fee;
      return fee;
    },
    getAgentBalance: async (address, minimumContextSlot) => {
      balanceAddresses.push(address);
      minimumSlots.push(minimumContextSlot);
      if (balance instanceof Error) throw balance;
      return balance;
    },
  });
  return {
    check: () => service.check(AGENT, MESSAGE),
    balanceAddresses,
    minimumSlots,
  };
}

test('verified balance at or above reserve is ready', async (context) => {
  for (const balance of [5_000_000, 5_000_001]) {
    await context.test(String(balance), async () => {
      const result = await harness(
        response(5_000, 40),
        response(balance, 41),
      ).check();
      assert.equal(result.status, 'ready');
      if (result.status !== 'ready') return;
      assert.equal(
        result.reserveTargetLamports,
        AGENT_RECOMMENDED_RESERVE_LAMPORTS,
      );
      assert.equal(
        result.estimatedHeartbeatsRemaining,
        Math.floor(balance / 5_000),
      );
    });
  }
});

test('an affordable heartbeat below reserve is low_reserve and never blocked', async (context) => {
  for (const balance of [5_000, 5_001, 4_999_999]) {
    await context.test(String(balance), async () => {
      const result = await harness(
        response(5_000, 40),
        response(balance, 41),
      ).check();
      assert.equal(result.status, 'low_reserve');
      if (result.status !== 'low_reserve') return;
      assert.equal(
        result.topUpLamports,
        AGENT_RECOMMENDED_RESERVE_LAMPORTS - balance,
      );
    });
  }
});

test('verified balance below the exact fee is insufficient with an exact shortfall', async (context) => {
  for (const balance of [0, 4_999]) {
    await context.test(String(balance), async () => {
      const result = await harness(
        response(5_000, 40),
        response(balance, 41),
      ).check();
      assert.equal(result.status, 'insufficient');
      if (result.status !== 'insufficient') return;
      assert.equal(result.shortfallLamports, 5_000 - balance);
      assert.equal(result.balanceLamports, balance);
    });
  }
});

test('null fee and auxiliary RPC failures are unavailable, not insufficient', async (context) => {
  const cases = [
    {
      name: 'null fee',
      fee: response(null),
      balance: response(0),
      reason: 'fee_unavailable',
    },
    {
      name: 'fee RPC failure',
      fee: new Error('offline'),
      balance: response(0),
      reason: 'fee_unavailable',
    },
    {
      name: 'balance RPC failure',
      fee: response(5_000),
      balance: new Error('offline'),
      reason: 'balance_unavailable',
    },
  ] as const;
  for (const scenario of cases) {
    await context.test(scenario.name, async () => {
      const result = await harness(
        scenario.fee,
        scenario.balance,
      ).check();
      assert.deepEqual(result, {
        status: 'check_unavailable',
        reason: scenario.reason,
      });
    });
  }
});

test('malformed, fractional, negative, unsafe, and stale-context RPC values are invalid', async (context) => {
  const cases: Array<{
    name: string;
    fee: unknown;
    balance: unknown;
  }> = [
    { name: 'malformed fee', fee: {}, balance: response(1) },
    {
      name: 'fractional fee',
      fee: response(1.5),
      balance: response(1),
    },
    {
      name: 'negative fee',
      fee: response(-1),
      balance: response(1),
    },
    {
      name: 'unsafe fee',
      fee: response(Number.MAX_SAFE_INTEGER + 1),
      balance: response(1),
    },
    {
      name: 'negative balance',
      fee: response(1, 40),
      balance: response(-1, 41),
    },
    {
      name: 'balance predates fee',
      fee: response(1, 40),
      balance: response(1, 39),
    },
  ];
  for (const scenario of cases) {
    await context.test(scenario.name, async () => {
      const result = await harness(
        scenario.fee,
        scenario.balance,
      ).check();
      assert.equal(result.status, 'invalid_response');
    });
  }
});

test('zero balance is a verified value and the agent is the only balance address', async () => {
  const testHarness = harness(
    response(5_000, 40),
    response(0, 41),
  );
  const result = await testHarness.check();
  assert.equal(result.status, 'insufficient');
  assert.deepEqual(testHarness.balanceAddresses, [AGENT]);
  assert.deepEqual(testHarness.minimumSlots, [40]);
});

test('top-up calculation uses integer lamports and exact difference to the existing reserve', () => {
  assert.equal(calculateAgentTopUpLamports(0), 5_000_000);
  assert.equal(calculateAgentTopUpLamports(4_999_999), 1);
  assert.equal(calculateAgentTopUpLamports(5_000_000), 0);
  assert.throws(() => calculateAgentTopUpLamports(-1));
  assert.throws(() =>
    calculateAgentTopUpLamports(Number.MAX_SAFE_INTEGER + 1),
  );
});
