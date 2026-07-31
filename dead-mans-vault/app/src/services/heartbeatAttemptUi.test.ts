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
  assert.doesNotMatch(dashboard, /confirmLocalHeartbeat|confirmHeartbeat\(/);
  assert.doesNotMatch(
    dashboard,
    /recordNonAuthoritativeLocalHeartbeat|Date\.now/,
  );
  assert.match(dashboard, /recordConfirmedHeartbeat/);
  assert.match(dashboard, /verifyHeartbeatConfirmation/);
  assert.match(dashboard, /lastConfirmedHeartbeatTx/);
  assert.match(dashboard, /currentHeartbeatTx/);
});

test('verified chain success and local-cache failure are distinguished', () => {
  const synced = getHeartbeatAttemptMessage({
    status: 'confirmed_on_chain',
    signature: 'confirmed-signature',
    lastHeartbeat: 1_001,
    totalHeartbeats: 5n,
    localSync: 'complete',
  });
  const cacheFailed = getHeartbeatAttemptMessage({
    status: 'confirmed_on_chain',
    signature: 'confirmed-signature',
    lastHeartbeat: 1_001,
    totalHeartbeats: 5n,
    localSync: 'failed',
  });

  assert.equal(synced, null);
  assert.match(cacheFailed?.text ?? '', /confirmed on Solana/);
  assert.match(
    cacheFailed?.text ?? '',
    /on-chain liveness deadline was reset successfully/,
  );
  assert.doesNotMatch(cacheFailed?.text ?? '', /tap again/i);
});

test('ambiguous and failed transaction messages never claim success', () => {
  const submission = getHeartbeatAttemptMessage({
    status: 'submission_failed',
    error: new Error('not shown'),
  });
  const failed = getHeartbeatAttemptMessage({
    status: 'transaction_failed',
    signature: 'failed-signature',
    transactionError: { custom: 1 },
  });
  const unknown = getHeartbeatAttemptMessage({
    status: 'confirmation_unknown',
    signature: 'unknown-signature',
    error: new Error('not shown'),
  });
  const postState = getHeartbeatAttemptMessage({
    status: 'post_state_unavailable',
    signature: 'unverified-signature',
  });
  const integrity = getHeartbeatAttemptMessage({
    status: 'post_state_not_advanced',
    signature: 'integrity-signature',
  });

  assert.match(submission?.text ?? '', /was not submitted/);
  assert.match(failed?.text ?? '', /confirmed as failed/);
  assert.match(unknown?.text ?? '', /Do not tap again yet/);
  assert.match(postState?.text ?? '', /could not be verified/);
  assert.equal(integrity?.tone, 'critical');
  for (const message of [
    submission,
    failed,
    unknown,
    postState,
    integrity,
  ]) {
    assert.doesNotMatch(message?.text ?? '', /Vault Secured/);
  }
});
