import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  executeCurrentAgentRotation,
  isStartupMigrationCheckDue,
  needsAgentRotationForState,
} from './AgentMigrationFlow.ts';

interface FakeTransaction {
  instructions: Array<string>;
}

interface MigrationHarness {
  events: Array<string>;
  activeKeyDestroyed: boolean;
  replacementGenerated: boolean;
  transaction: FakeTransaction;
  run: () => ReturnType<
    typeof executeCurrentAgentRotation<FakeTransaction>
  >;
}

function makeMigrationHarness(overrides: {
  buildRotationTransaction?: (
    newPubkey: string,
  ) => Promise<FakeTransaction>;
  signAndSendTransaction?: (
    transaction: FakeTransaction,
  ) => Promise<string>;
  confirmRotation?: () => Promise<void>;
} = {}): MigrationHarness {
  const events: Array<string> = [];
  const transaction = { instructions: ['rotate_agent'] };
  const harness: MigrationHarness = {
    events,
    activeKeyDestroyed: false,
    replacementGenerated: false,
    transaction,
    run: () => executeCurrentAgentRotation({
      destroyActiveAgentKey: async () => {
        harness.activeKeyDestroyed = true;
        events.push('destroy active key');
      },
      generateReplacementAgentKey: async () => {
        harness.replacementGenerated = true;
        events.push('generate replacement');
        return 'replacement-public-key';
      },
      buildRotationTransaction:
        overrides.buildRotationTransaction ?? (async () => {
          events.push('build rotation');
          return transaction;
        }),
      prepareRotationTransaction: async (rotationTransaction) => {
        events.push('prepare rotation');
        return {
          transaction: rotationTransaction,
          blockhash: 'mock-blockhash',
          lastValidBlockHeight: 4321,
        };
      },
      signAndSendTransaction:
        overrides.signAndSendTransaction ?? (async () => {
          events.push('owner sign and send');
          return 'mock-signature';
        }),
      confirmRotation: async () => {
        events.push('confirm rotation');
        if (overrides.confirmRotation) {
          await overrides.confirmRotation();
        }
      },
    }),
  };
  return harness;
}

test('current behavior: active key is destroyed before replacement generation, owner signing and confirmation', async () => {
  const harness = makeMigrationHarness();

  const result = await harness.run();

  assert.deepEqual(result, {
    newPubkey: 'replacement-public-key',
    txSig: 'mock-signature',
  });
  assert.deepEqual(harness.events, [
    'destroy active key',
    'generate replacement',
    'build rotation',
    'prepare rotation',
    'owner sign and send',
    'confirm rotation',
  ]);
});

test('current behavior: rotation transaction contains no candidate-funding step', async () => {
  const migrationServiceSource = readFileSync(
    new URL('./MigrationService.ts', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(
    migrationServiceSource,
    /SystemProgram|transfer|fund/i,
  );

  const harness = makeMigrationHarness({
    signAndSendTransaction: async (transaction) => {
      harness.events.push('owner sign and send');
      assert.deepEqual(transaction.instructions, ['rotate_agent']);
      return 'mock-signature';
    },
  });

  await harness.run();
});

test('current behavior: owner cancellation leaves the active key destroyed and the replacement unconfirmed', async () => {
  const cancellation = new Error('owner cancelled');
  const harness = makeMigrationHarness({
    signAndSendTransaction: async () => {
      harness.events.push('owner sign and send');
      throw cancellation;
    },
  });

  await assert.rejects(harness.run(), cancellation);
  assert.equal(harness.activeKeyDestroyed, true);
  assert.equal(harness.replacementGenerated, true);
  assert.equal(harness.events.includes('confirm rotation'), false);
});

test('current behavior: rotation confirmation failure leaves the active key destroyed', async () => {
  const confirmationFailure = new Error('mock rotation failure');
  const harness = makeMigrationHarness({
    confirmRotation: async () => {
      throw confirmationFailure;
    },
  });

  await assert.rejects(harness.run(), confirmationFailure);
  assert.equal(harness.activeKeyDestroyed, true);
  assert.equal(harness.replacementGenerated, true);
  assert.equal(harness.events.at(-1), 'confirm rotation');
});

test('startup mismatch detection covers missing, matching, mismatched and inactive agent states', () => {
  const activeVault = {
    active: true,
    executed: false,
    agentPublicKey: 'registered-agent',
  };

  assert.equal(
    needsAgentRotationForState(activeVault, false, null),
    true,
  );
  assert.equal(
    needsAgentRotationForState(
      activeVault,
      true,
      'registered-agent',
    ),
    false,
  );
  assert.equal(
    needsAgentRotationForState(activeVault, true, 'other-agent'),
    true,
  );
  assert.equal(
    needsAgentRotationForState(
      { ...activeVault, active: false },
      false,
      null,
    ),
    false,
  );
  assert.equal(
    needsAgentRotationForState(
      { ...activeVault, executed: true },
      false,
      null,
    ),
    false,
  );
  assert.equal(needsAgentRotationForState(null, false, null), false);
});

test('startup migration check remains delayed until vault age exceeds 120 seconds', () => {
  const createdAt = 1_000;

  assert.equal(isStartupMigrationCheckDue(createdAt, 1_120), false);
  assert.equal(isStartupMigrationCheckDue(createdAt, 1_121), true);
});
