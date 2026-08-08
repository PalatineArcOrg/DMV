import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getHeartbeatAttemptMessage } from './heartbeatAttemptUi.ts';

// Every distinct readiness failure collapsed into one opaque message with its
// `reason` discarded. On a Seeker (2026-08-08) a refused heartbeat read only
// "The on-chain vault state could not be validated safely", which is true of a bad
// RPC, a bad key, a bad vault and a derivation fault alike — leaving the owner and
// the operator with no way to tell them apart. These pin the reason reaching the UI.

test('invalid_on_chain_state surfaces the reason when present', () => {
  const m = getHeartbeatAttemptMessage({
    status: 'invalid_on_chain_state',
    reason: 'vault owner does not match the connected owner',
  });
  assert.ok(m);
  assert.match(m.text, /could not be validated safely/);
  assert.match(m.text, /Reason: vault owner does not match the connected owner/);
  assert.equal(m.tone, 'warning');
});

test('invalid_on_chain_state without a reason keeps the original wording', () => {
  const m = getHeartbeatAttemptMessage({ status: 'invalid_on_chain_state' });
  assert.ok(m);
  assert.match(m.text, /could not be validated safely/);
  assert.ok(!m.text.includes('Reason:'), 'no dangling "Reason:" when absent');
});

test('distinct reasons produce distinguishable messages', () => {
  const a = getHeartbeatAttemptMessage({
    status: 'invalid_on_chain_state',
    reason: 'heartbeat account validation failed',
  });
  const b = getHeartbeatAttemptMessage({
    status: 'invalid_on_chain_state',
    reason: 'canonical PDA derivation failed',
  });
  assert.notEqual(a?.text, b?.text, 'the whole point is that these differ');
});

test('other statuses are unchanged by the reason plumbing', () => {
  for (const status of ['agent_missing', 'agent_unavailable', 'rpc_unavailable'] as const) {
    const m = getHeartbeatAttemptMessage({ status });
    assert.ok(m);
    assert.ok(!m.text.includes('Reason:'), `${status} must not gain a Reason suffix`);
  }
});
