import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  Keypair,
  SystemProgram,
  Transaction,
} from '@solana/web3.js';
import bs58 from 'bs58';
import {
  createAgentCandidateFundingService,
} from './AgentCandidateFundingService.ts';
import {
  AGENT_RECOMMENDED_RESERVE_LAMPORTS,
} from './agentFundingPolicy.ts';

function harness(overrides: Record<string, unknown> = {}) {
  const owner = Keypair.generate();
  const candidate = Keypair.generate();
  const events: Array<string> = [];
  const service = createAgentCandidateFundingService({
    validateCandidate: async (_owner, expected) => {
      events.push('validate');
      return expected.equals(candidate.publicKey);
    },
    getBalance: async (address) => {
      events.push(
        address.equals(candidate.publicKey)
          ? 'candidate-balance'
          : 'owner-balance',
      );
      return {
        context: { slot: 10 },
        value: address.equals(candidate.publicKey)
          ? 0
          : 10_000_000,
      };
    },
    getLatestBlockhash: async () => ({
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 100,
    }),
    getFeeForMessage: async (transaction) => {
      events.push('fee');
      const instruction = transaction.instructions[0];
      assert.equal(
        instruction.programId.equals(SystemProgram.programId),
        true,
      );
      return { context: { slot: 10 }, value: 5_000 };
    },
    confirmTransfer: async (input) => {
      events.push('confirm-ui');
      assert.equal(input.candidate.equals(candidate.publicKey), true);
      assert.equal(
        input.transferLamports,
        AGENT_RECOMMENDED_RESERVE_LAMPORTS,
      );
      return true;
    },
    signWithOwnerWallet: async (transaction) => {
      events.push('owner-sign');
      transaction.partialSign(owner);
      return transaction;
    },
    sendRawTransaction: async (bytes) => {
      events.push('send');
      return Transaction.from(bytes).signature
        ? bs58.encode(Transaction.from(bytes).signature!)
        : '';
    },
    confirmTransaction: async () => {
      events.push('confirm-chain');
      return { value: { err: null } };
    },
    persistPrepared: async () => {
      events.push('journal-prepared');
    },
    transition: async (_signature, state) => {
      events.push(`transition:${state}`);
    },
    isOwnerCancellation: () => false,
    ...overrides,
  });
  return { owner, candidate, events, service };
}

test('candidate funding transfers exact difference to recommended reserve', async () => {
  const setup = harness();
  const result = await setup.service.fund(
    setup.owner.publicKey,
    setup.candidate.publicKey,
  );
  assert.equal(result.status, 'confirmed');
  if (result.status === 'confirmed') {
    assert.equal(
      result.transferredLamports,
      AGENT_RECOMMENDED_RESERVE_LAMPORTS,
    );
  }
});

test('arbitrary destination is rejected before transaction construction', async () => {
  const setup = harness();
  const result = await setup.service.fund(
    setup.owner.publicKey,
    Keypair.generate().publicKey,
  );
  assert.equal(result.status, 'candidate_changed');
  assert.equal(setup.events.includes('fee'), false);
  assert.equal(setup.events.includes('send'), false);
});

test('already funded candidate creates no wallet prompt or transaction', async () => {
  const setup = harness({
    getBalance: async () => ({
      context: { slot: 1 },
      value: AGENT_RECOMMENDED_RESERVE_LAMPORTS,
    }),
  });
  const result = await setup.service.fund(
    setup.owner.publicKey,
    setup.candidate.publicKey,
  );
  assert.equal(result.status, 'already_funded');
  assert.equal(setup.events.includes('confirm-ui'), false);
  assert.equal(setup.events.includes('send'), false);
});

test('explicit owner cancellation sends nothing', async () => {
  const setup = harness({
    confirmTransfer: async () => false,
  });
  const result = await setup.service.fund(
    setup.owner.publicKey,
    setup.candidate.publicKey,
  );
  assert.equal(result.status, 'owner_cancelled');
  assert.equal(setup.events.includes('send'), false);
});

test('owner is fee payer and exactly one System Program transfer is signed', async () => {
  let signed: Transaction | null = null;
  const setup = harness({
    signWithOwnerWallet: async (transaction: Transaction) => {
      signed = transaction;
      transaction.partialSign(setup.owner);
      return transaction;
    },
  });
  await setup.service.fund(
    setup.owner.publicKey,
    setup.candidate.publicKey,
  );
  assert.ok(signed);
  assert.equal(signed!.feePayer!.equals(setup.owner.publicKey), true);
  assert.equal(signed!.instructions.length, 1);
  assert.equal(
    signed!.instructions[0].programId.equals(SystemProgram.programId),
    true,
  );
});

test('send ambiguity preserves owner signature and never retries', async () => {
  let sends = 0;
  const setup = harness({
    sendRawTransaction: async () => {
      sends += 1;
      setup.events.push('send');
      throw new Error('timeout');
    },
  });
  const result = await setup.service.fund(
    setup.owner.publicKey,
    setup.candidate.publicKey,
  );
  assert.equal(result.status, 'confirmation_unknown');
  assert.equal(sends, 1);
  assert.equal('signature' in result, true);
  assert.ok(
    setup.events.indexOf('journal-prepared') <
      setup.events.indexOf('send'),
  );
});

test('candidate funding journal failure prevents send', async () => {
  const setup = harness({
    persistPrepared: async () => {
      throw new Error('disk full');
    },
  });
  const result = await setup.service.fund(
    setup.owner.publicKey,
    setup.candidate.publicKey,
  );
  assert.equal(result.status, 'journal_failed');
  assert.equal(setup.events.includes('send'), false);
});

test('confirmation value.err is treated as a failed funding transaction', async () => {
  const setup = harness({
    confirmTransaction: async () => ({
      value: { err: { InstructionError: [0, 1] } },
    }),
  });
  const result = await setup.service.fund(
    setup.owner.publicKey,
    setup.candidate.publicKey,
  );
  assert.equal(result.status, 'transaction_failed');
});

test('candidate is revalidated immediately before owner signing', async () => {
  let validations = 0;
  const setup = harness({
    validateCandidate: async () => {
      validations += 1;
      return validations === 1;
    },
  });
  const result = await setup.service.fund(
    setup.owner.publicKey,
    setup.candidate.publicKey,
  );
  assert.equal(result.status, 'candidate_changed');
  assert.equal(setup.events.includes('send'), false);
});
