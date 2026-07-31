import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getHeartbeatAttemptMessage } from './heartbeatAttemptUi.ts';

test('missing and mismatched agent messages are explicit and do not expose addresses', () => {
  const missing = getHeartbeatAttemptMessage({
    status: 'agent_missing',
  });
  const mismatch = getHeartbeatAttemptMessage({
    status: 'agent_mismatch',
    localAgent: 'local-public-key',
    onChainAgent: 'onchain-public-key',
  });

  assert.match(
    missing?.text ?? '',
    /does not have the heartbeat agent key authorised/,
  );
  assert.match(missing?.text ?? '', /Do not uninstall/);
  assert.match(missing?.text ?? '', /owner-authorised rotation is required/);
  assert.match(mismatch?.text ?? '', /does not match/);
  assert.match(mismatch?.text ?? '', /No heartbeat was recorded/);
  assert.doesNotMatch(mismatch?.text ?? '', /local-public-key/);
  assert.doesNotMatch(mismatch?.text ?? '', /onchain-public-key/);
});

test('RPC, inactive and executed messages accurately describe non-success', () => {
  const rpc = getHeartbeatAttemptMessage({
    status: 'rpc_unavailable',
  });
  const inactive = getHeartbeatAttemptMessage({
    status: 'vault_inactive',
  });
  const executed = getHeartbeatAttemptMessage({
    status: 'vault_executed',
  });

  assert.match(rpc?.text ?? '', /could not be verified/);
  assert.match(
    rpc?.text ?? '',
    /No local or on-chain heartbeat was recorded/,
  );
  assert.doesNotMatch(inactive?.text ?? '', /try again/i);
  assert.doesNotMatch(executed?.text ?? '', /try again/i);
});

test('Dashboard confirmation and pending UI are driven by explicit coordinator state', () => {
  const dashboard = readFileSync(
    new URL('../screens/DashboardScreen.tsx', import.meta.url),
    'utf8',
  );
  const button = readFileSync(
    new URL('../components/HeartbeatButton.tsx', import.meta.url),
    'utf8',
  );

  assert.match(
    dashboard,
    /result\.status === 'confirmed_on_chain'/,
  );
  assert.match(
    dashboard,
    /disabled=\{!isVaultSetup \|\| isHeartbeatAttemptInFlight\}/,
  );
  assert.match(dashboard, /Verifying heartbeat…/);
  assert.match(button, /confirmationSucceeded/);
  assert.doesNotMatch(button, /wasLoading/);
  assert.doesNotMatch(
    dashboard,
    /MigrationService|generateAgentKey|destroyKey|rotateAgent/,
  );
});
