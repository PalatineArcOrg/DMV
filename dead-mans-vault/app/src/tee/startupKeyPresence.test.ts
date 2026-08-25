import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import {
  createAgentKeySlotManager,
  type AgentKeySlotStorage,
} from './AgentKeySlotManagerCore.ts';

// Regression: the startup key-presence check must not require authentication.
//
// Observed on a Seeker, 2026-08-08, upgrading v1.13.20 -> 1.13.21: a fingerprint
// prompt appeared at cold start and was followed by "Agent Recovery Required",
// even though the key was intact — Settings then showed the agent matching
// on-chain. Cause: hasAgentKey()/getAgentPublicKey() were routed through
// readSlot(), which loads the SECRET under `requireAuthentication` when
// auth === '1'. At cold start there is no resumed Activity to host the prompt,
// so the read fails and a healthy key is reported missing. RootNavigator then
// tells the owner their agent is unusable and points them at rotation — advice
// that, acted on, would replace a working key.
//
// v1.13.20 read only the public key, unauthenticated, and never had this problem.
// These tests pin that semantic: presence is answered from metadata alone.

const SECRET = 'dmv_agent_secret_key';
const PUBLIC = 'dmv_agent_public_key';
const AUTH = 'dmv_agent_key_auth';
const COMPLETE = 'dmv_agent_key_complete';

interface Entry {
  value: string;
  requiresAuth: boolean;
}

/**
 * Models a cold start: the secret is gated behind authentication and no prompt
 * can be shown, so every authenticated read throws — exactly as expo-secure-store
 * behaves on Android without a resumed Activity. Unauthenticated metadata reads
 * still succeed, because that is how the public key and flags were written.
 */
function coldStartStorage(initial: Record<string, Entry>) {
  const values = new Map<string, Entry>(Object.entries(initial));
  const authenticatedReads: Array<string> = [];
  const storage: AgentKeySlotStorage = {
    get: async (key, authenticated) => {
      if (authenticated) {
        authenticatedReads.push(key);
        throw new Error('Could not authenticate: no resumed activity');
      }
      const entry = values.get(key);
      return entry && !entry.requiresAuth ? entry.value : null;
    },
    set: async (key, value, authenticated) => {
      values.set(key, { value, requiresAuth: authenticated });
      return authenticated;
    },
    remove: async (key) => {
      values.delete(key);
    },
  };
  return { values, authenticatedReads, storage };
}

/** Exactly what a pre-Phase-4 install left behind, with the secret auth-gated. */
function legacyGatedFixture(agent: Keypair): Record<string, Entry> {
  return {
    [SECRET]: { value: bs58.encode(agent.secretKey), requiresAuth: true },
    [PUBLIC]: { value: agent.publicKey.toBase58(), requiresAuth: false },
    [AUTH]: { value: '1', requiresAuth: false },
  };
}

function modernGatedFixture(agent: Keypair): Record<string, Entry> {
  return { ...legacyGatedFixture(agent), [COMPLETE]: { value: '1', requiresAuth: false } };
}

const forbidGeneration = () => {
  throw new Error('key generation must not occur during a presence check');
};

for (const [name, fixture] of [
  ['legacy (no completion marker)', legacyGatedFixture],
  ['modern (completion marker)', modernGatedFixture],
] as const) {
  test(`${name}: presence is reported without any authenticated read`, async () => {
    const agent = Keypair.generate();
    const store = coldStartStorage(fixture(agent));
    const manager = createAgentKeySlotManager(store.storage, forbidGeneration);

    assert.equal(await manager.hasStoredSlot('active'), true);
    assert.equal(
      await manager.getStoredPublicKey('active'),
      agent.publicKey.toBase58(),
    );
    assert.deepEqual(
      store.authenticatedReads,
      [],
      'a presence check must never request an authenticated read',
    );
  });

  test(`${name}: the old authenticated path still fails at cold start (regression pinned)`, async () => {
    const agent = Keypair.generate();
    const store = coldStartStorage(fixture(agent));
    const manager = createAgentKeySlotManager(store.storage, forbidGeneration);

    // This is what hasAgentKey() used to do, and why the false alert appeared.
    assert.equal(await manager.hasCompleteSlot('active'), false);
    assert.ok(
      store.authenticatedReads.includes(SECRET),
      'the secret-loading path is expected to attempt an authenticated read',
    );
  });
}

test('a slot that is genuinely absent still reports absent', async () => {
  const store = coldStartStorage({});
  const manager = createAgentKeySlotManager(store.storage, forbidGeneration);
  assert.equal(await manager.hasStoredSlot('active'), false);
  assert.equal(await manager.getStoredPublicKey('active'), null);
});

test('presence does not accept a malformed or partial slot', async () => {
  const agent = Keypair.generate();
  for (const [label, fixture] of [
    ['missing public key', { [SECRET]: { value: bs58.encode(agent.secretKey), requiresAuth: true }, [AUTH]: { value: '1', requiresAuth: false } }],
    ['malformed public key', { ...legacyGatedFixture(agent), [PUBLIC]: { value: 'not-base58!!', requiresAuth: false } }],
    ['invalid auth flag', { ...legacyGatedFixture(agent), [AUTH]: { value: '2', requiresAuth: false } }],
  ] as const) {
    const store = coldStartStorage(fixture as Record<string, Entry>);
    const manager = createAgentKeySlotManager(store.storage, forbidGeneration);
    assert.equal(await manager.hasStoredSlot('active'), false, label);
  }
});

test('the legacy allowance stays active-only for presence checks', async () => {
  // candidate/previous have no legacy form: a missing completion marker there is
  // a partial write, not a pre-Phase-4 install.
  const agent = Keypair.generate();
  const store = coldStartStorage({
    dmv_agent_candidate_secret_key: { value: bs58.encode(agent.secretKey), requiresAuth: true },
    dmv_agent_candidate_public_key: { value: agent.publicKey.toBase58(), requiresAuth: false },
    dmv_agent_candidate_key_auth: { value: '1', requiresAuth: false },
  });
  const manager = createAgentKeySlotManager(store.storage, forbidGeneration);
  assert.equal(await manager.hasStoredSlot('candidate'), false);
});

test('signing still requires authentication — presence must not weaken custody', async () => {
  const agent = Keypair.generate();
  const store = coldStartStorage(legacyGatedFixture(agent));
  const manager = createAgentKeySlotManager(store.storage, forbidGeneration);

  assert.equal(await manager.hasStoredSlot('active'), true);
  // Loading the key for real must still go through the authenticated read, and
  // must still fail when the device cannot authenticate.
  await assert.rejects(() => manager.loadSlot('active'));
  assert.ok(store.authenticatedReads.includes(SECRET));
});
