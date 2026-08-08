import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Keypair } from '@solana/web3.js';
import {
  createAgentRotationVerifier,
  type VerifiedRotationChainState,
} from './AgentRotationVerifier.ts';

function fixture() {
  const owner = Keypair.generate().publicKey;
  const vault = Keypair.generate().publicKey;
  const heartbeat = Keypair.generate().publicKey;
  const oldAgent = Keypair.generate().publicKey;
  const candidateAgent = Keypair.generate().publicKey;
  const state: VerifiedRotationChainState = {
    owner,
    vault,
    heartbeat,
    agent: candidateAgent,
    active: true,
    executed: false,
    vaultUpdatedAt: 101,
    lastHeartbeat: 102,
    totalHeartbeats: 9n,
    heartbeatInterval: 100,
    gracePeriod: 200,
    configFingerprint: 'ab'.repeat(32),
    chainUnixTime: 103,
  };
  return {
    state,
    input: {
      owner,
      vault,
      heartbeat,
      oldAgent,
      candidateAgent,
      beforeVaultUpdatedAt: 100,
      beforeLastHeartbeat: 100,
      beforeTotalHeartbeats: 9n,
      beforeConfigFingerprint: 'ab'.repeat(32),
    },
  };
}

test('canonical candidate authority with unchanged heartbeat count verifies', async () => {
  const { state, input } = fixture();
  const result = await createAgentRotationVerifier({
    fetchVerifiedState: async () => state,
  }).verify(input);

  assert.equal(result.status, 'verified');
});

test('old authority is distinguished from a failed postcondition', async () => {
  const { state, input } = fixture();
  state.agent = input.oldAgent;
  const result = await createAgentRotationVerifier({
    fetchVerifiedState: async () => state,
  }).verify(input);
  assert.equal(result.status, 'old_agent_still_authorised');
});

test('a third on-chain agent enters recovery-required taxonomy', async () => {
  const { state, input } = fixture();
  state.agent = Keypair.generate().publicKey;
  const result = await createAgentRotationVerifier({
    fetchVerifiedState: async () => state,
  }).verify(input);
  assert.equal(result.status, 'different_agent_authorised');
});

for (const scenario of [
  'owner',
  'vault',
  'heartbeat',
] as const) {
  test(`wrong canonical ${scenario} identity is rejected`, async () => {
    const { state, input } = fixture();
    state[scenario] = Keypair.generate().publicKey;
    const result = await createAgentRotationVerifier({
      fetchVerifiedState: async () => state,
    }).verify(input);
    assert.equal(result.status, 'invalid_on_chain_state');
  });
}

test('inactive or executed post-state is rejected', async () => {
  for (const patch of [
    { active: false },
    { executed: true },
  ]) {
    const { state, input } = fixture();
    Object.assign(state, patch);
    const result = await createAgentRotationVerifier({
      fetchVerifiedState: async () => state,
    }).verify(input);
    assert.equal(result.status, 'invalid_on_chain_state');
  }
});

test('rotation heartbeat timestamp may advance but cannot regress or be in the future', async () => {
  for (const patch of [
    { lastHeartbeat: 99 },
    { lastHeartbeat: 104 },
  ]) {
    const { state, input } = fixture();
    Object.assign(state, patch);
    const result = await createAgentRotationVerifier({
      fetchVerifiedState: async () => state,
    }).verify(input);
    assert.equal(result.status, 'invalid_on_chain_state');
  }
});

test('rotation must not increment total heartbeat count', async () => {
  const { state, input } = fixture();
  state.totalHeartbeats += 1n;
  const result = await createAgentRotationVerifier({
    fetchVerifiedState: async () => state,
  }).verify(input);
  assert.equal(result.status, 'invalid_on_chain_state');
});

test('unexpected beneficiary/timing fingerprint change is rejected', async () => {
  const { state, input } = fixture();
  state.configFingerprint = 'cd'.repeat(32);
  const result = await createAgentRotationVerifier({
    fetchVerifiedState: async () => state,
  }).verify(input);
  assert.equal(result.status, 'invalid_on_chain_state');
});

test('RPC failure is not misclassified as old or candidate authority', async () => {
  const { input } = fixture();
  const result = await createAgentRotationVerifier({
    fetchVerifiedState: async () => {
      throw new Error('offline');
    },
  }).verify(input);
  assert.equal(result.status, 'rpc_unavailable');
});
