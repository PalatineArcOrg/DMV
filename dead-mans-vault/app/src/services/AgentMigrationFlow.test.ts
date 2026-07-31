import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  isStartupMigrationCheckDue,
  needsAgentRotationForState,
} from './AgentMigrationFlow.ts';

test('startup mismatch detection covers missing, matching, mismatched and inactive states', () => {
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
    needsAgentRotationForState(
      activeVault,
      true,
      'other-agent',
    ),
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
});

test('startup migration check remains delayed until vault age exceeds 120 seconds', () => {
  assert.equal(isStartupMigrationCheckDue(1_000, 1_120), false);
  assert.equal(isStartupMigrationCheckDue(1_000, 1_121), true);
});

test('unsafe destroy-first rotation implementation and production call are removed', () => {
  const flow = readFileSync(
    new URL('./AgentMigrationFlow.ts', import.meta.url),
    'utf8',
  );
  const migration = readFileSync(
    new URL('./MigrationService.ts', import.meta.url),
    'utf8',
  );
  const root = readFileSync(
    new URL('../navigation/RootNavigator.tsx', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(flow, /destroyActiveAgentKey/);
  assert.doesNotMatch(flow, /executeCurrentAgentRotation/);
  assert.doesNotMatch(migration, /destroyKey\(/);
  assert.doesNotMatch(migration, /executeRotation/);
  assert.doesNotMatch(root, /Rotate Now|executeRotation/);
});

test('startup reconciliation is read-only and offers no owner-wallet action', () => {
  const migration = readFileSync(
    new URL('./MigrationService.ts', import.meta.url),
    'utf8',
  );
  assert.match(migration, /reconcileForOwner/);
  assert.doesNotMatch(
    migration,
    /signTransaction|signAndSendTransaction|sendRawTransaction/,
  );
});
