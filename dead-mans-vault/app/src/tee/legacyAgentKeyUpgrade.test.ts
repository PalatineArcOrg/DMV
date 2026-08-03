import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from '@solana/web3.js';
import bs58 from 'bs58';
import {
  createAgentKeySlotManager,
  type AgentKeySlotStorage,
} from './AgentKeySlotManagerCore.ts';

// T1.1 — legacy agent-key upgrade compatibility.
//
// Every existing DMV installation stores an agent key written by the
// pre-Phase-4 KeyManager. Phase 4 replaced that single-slot store with
// active/candidate/previous slots and added a completion marker. If the legacy
// compatibility path is wrong, readiness reports `agent_missing` and existing
// owners silently stop heartbeating while their on-chain deadline keeps running.
//
// The fixtures below are reconstructed from the pre-Phase-4 implementation at
// commit cd0264b (`dead-mans-vault/app/src/tee/KeyManager.ts`), which is
// byte-identical to the v1.13.20 release commit c786064 and was the ONLY
// SecureStore call site in the app. It wrote exactly three entries:
//
//   dmv_agent_secret_key   bs58(keypair.secretKey), stored WITH requireAuthentication
//                          when a lock screen was enrolled, WITHOUT otherwise
//   dmv_agent_public_key   keypair.publicKey.toBase58(), never authenticated
//   dmv_agent_key_auth     '1' when the secret was gated, '0' when it was not
//
// and read the secret back with `authed = (auth === '1')`. A legacy install has
// no `dmv_agent_key_complete` — that marker is a Phase 4 addition.

const LEGACY_SECRET = 'dmv_agent_secret_key';
const LEGACY_PUBLIC = 'dmv_agent_public_key';
const LEGACY_AUTH = 'dmv_agent_key_auth';
const MODERN_COMPLETE = 'dmv_agent_key_complete';

const CANDIDATE_SECRET = 'dmv_agent_candidate_secret_key';
const CANDIDATE_PUBLIC = 'dmv_agent_candidate_public_key';
const CANDIDATE_AUTH = 'dmv_agent_candidate_key_auth';
const CANDIDATE_COMPLETE = 'dmv_agent_candidate_key_complete';

const PREVIOUS_SECRET = 'dmv_agent_previous_secret_key';
const PREVIOUS_PUBLIC = 'dmv_agent_previous_public_key';
const PREVIOUS_AUTH = 'dmv_agent_previous_key_auth';
const PREVIOUS_COMPLETE = 'dmv_agent_previous_key_complete';

interface StoredEntry {
  value: string;
  requiresAuth: boolean;
}

interface StorageOp {
  op: 'get' | 'set' | 'remove';
  key: string;
  authenticated?: boolean;
  hit?: boolean;
}

/**
 * Models the SecureStore contract the manager is written against, including the
 * property that makes this test meaningful: on Android a secret written with
 * `requireAuthentication` fails to decrypt when read without it, and vice versa.
 * Returning the value regardless would let a wrong authentication mode pass
 * silently, which is exactly the regression this test exists to detect.
 *
 * The backing map persists independently of any manager instance, so a manager
 * can be discarded and recreated to prove restart behaviour rather than cache
 * behaviour.
 */
function deviceStorage(initial: Record<string, StoredEntry> = {}) {
  const values = new Map<string, StoredEntry>(Object.entries(initial));
  const ops: Array<StorageOp> = [];
  const storage: AgentKeySlotStorage = {
    get: async (key, authenticated) => {
      const entry = values.get(key);
      const hit = entry !== undefined && entry.requiresAuth === authenticated;
      ops.push({ op: 'get', key, authenticated, hit });
      return hit ? (entry as StoredEntry).value : null;
    },
    set: async (key, value, authenticated) => {
      ops.push({ op: 'set', key, authenticated });
      values.set(key, { value, requiresAuth: authenticated });
      return authenticated;
    },
    remove: async (key) => {
      ops.push({ op: 'remove', key });
      values.delete(key);
    },
  };
  return { values, ops, storage };
}

function snapshot(values: Map<string, StoredEntry>): string {
  return JSON.stringify(
    [...values.entries()]
      .map(([key, entry]) => [key, entry.value, entry.requiresAuth])
      .sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
  );
}

/** Exactly what a pre-Phase-4 install left on disk. No completion marker. */
function legacyFixture(
  agent: Keypair,
  auth: '1' | '0' | null,
): Record<string, StoredEntry> {
  const entries: Record<string, StoredEntry> = {
    [LEGACY_SECRET]: {
      value: bs58.encode(agent.secretKey),
      requiresAuth: auth === '1',
    },
    [LEGACY_PUBLIC]: {
      value: agent.publicKey.toBase58(),
      requiresAuth: false,
    },
  };
  if (auth !== null) {
    entries[LEGACY_AUTH] = { value: auth, requiresAuth: false };
  }
  return entries;
}

function forbidGeneration(): Keypair {
  throw new Error('keypair generation must not occur while reading a legacy slot');
}

const FIXED_BLOCKHASH = bs58.encode(Buffer.alloc(32, 7));

function deterministicTransaction(payer: PublicKey): Transaction {
  const transaction = new Transaction();
  transaction.feePayer = payer;
  transaction.recentBlockhash = FIXED_BLOCKHASH;
  transaction.add(
    SystemProgram.transfer({
      fromPubkey: payer,
      toPubkey: payer,
      lamports: 0,
    }),
  );
  return transaction;
}

function secretReads(ops: Array<StorageOp>, key: string): Array<StorageOp> {
  return ops.filter((entry) => entry.op === 'get' && entry.key === key);
}

const SHAPES = [
  {
    id: 'A',
    name: 'biometric/device authentication enabled',
    auth: '1' as const,
    authenticatedRead: true,
  },
  {
    id: 'B',
    name: 'authentication explicitly disabled',
    auth: '0' as const,
    authenticatedRead: false,
  },
  {
    id: 'C',
    name: 'authentication metadata absent',
    auth: null,
    authenticatedRead: false,
  },
];

for (const shape of SHAPES) {
  test(`legacy shape ${shape.id} (${shape.name}) loads unchanged after upgrade`, async () => {
    const agent = Keypair.generate();
    const expectedPublicKey = agent.publicKey.toBase58();
    const store = deviceStorage(legacyFixture(agent, shape.auth));
    const before = snapshot(store.values);

    const manager = createAgentKeySlotManager(store.storage, forbidGeneration);

    assert.equal(await manager.hasCompleteSlot('active'), true);
    assert.equal(await manager.getPublicKey('active'), expectedPublicKey);

    const loaded = await manager.loadSlot('active');
    assert.equal(loaded.publicKey.toBase58(), expectedPublicKey);

    // The secret must have been requested in the mode it was written in.
    // A mismatch would have decrypted to null and surfaced as CorruptSlotError.
    const reads = secretReads(store.ops, LEGACY_SECRET);
    assert.ok(reads.length > 0, 'the legacy secret must actually be read');
    for (const read of reads) {
      assert.equal(read.authenticated, shape.authenticatedRead);
      assert.equal(read.hit, true);
    }

    // Exact on-chain resolution must select the active slot and nothing else.
    const resolution = await manager.resolveForOnChainPublicKey(expectedPublicKey);
    assert.equal(resolution.status, 'active_match');
    assert.equal(
      resolution.status === 'active_match' ? resolution.slot : null,
      'active',
    );

    // The recovered key must genuinely sign. This is ed25519 verification of a
    // real compiled message, not a public-key string comparison.
    const transaction = deterministicTransaction(agent.publicKey);
    await manager.signWithSlot('active', transaction);
    assert.equal(transaction.verifySignatures(), true);
    assert.equal(
      transaction.signatures[0]?.publicKey.toBase58(),
      expectedPublicKey,
    );

    // Reading a legacy slot must not manufacture other slots.
    assert.equal(await manager.getPublicKey('candidate'), null);
    assert.equal(await manager.getPublicKey('previous'), null);

    // Reading must not write. The completion marker stays absent until an
    // operation deliberately writes a modern slot.
    assert.equal(store.values.has(MODERN_COMPLETE), false);
    assert.equal(snapshot(store.values), before);
    assert.deepEqual(
      store.ops.filter((entry) => entry.op !== 'get'),
      [],
      'a read-only load must issue no set or remove',
    );
  });

  test(`legacy shape ${shape.id} survives manager re-instantiation (restart)`, async () => {
    const agent = Keypair.generate();
    const expectedPublicKey = agent.publicKey.toBase58();
    const store = deviceStorage(legacyFixture(agent, shape.auth));

    const first = createAgentKeySlotManager(store.storage, forbidGeneration);
    assert.equal((await first.loadSlot('active')).publicKey.toBase58(), expectedPublicKey);

    // Discard the manager (and its in-memory cache) and rebuild from the same
    // persisted storage, so success cannot come from a warm cache.
    const restarted = createAgentKeySlotManager(store.storage, forbidGeneration);
    assert.equal(await restarted.hasCompleteSlot('active'), true);
    assert.equal(await restarted.getPublicKey('active'), expectedPublicKey);
    assert.equal(
      (await restarted.loadSlot('active')).publicKey.toBase58(),
      expectedPublicKey,
    );

    const transaction = deterministicTransaction(agent.publicKey);
    await restarted.signWithSlot('active', transaction);
    assert.equal(transaction.verifySignatures(), true);

    assert.equal(store.values.has(MODERN_COMPLETE), false);
  });

  test(`legacy shape ${shape.id} promotes a candidate and retains the legacy key`, async () => {
    const legacyAgent = Keypair.generate();
    const candidateAgent = Keypair.generate();
    const legacyPublicKey = legacyAgent.publicKey.toBase58();
    const candidatePublicKey = candidateAgent.publicKey.toBase58();
    const store = deviceStorage(legacyFixture(legacyAgent, shape.auth));

    const manager = createAgentKeySlotManager(
      store.storage,
      () => candidateAgent,
    );

    assert.equal(await manager.generateCandidate(), candidatePublicKey);
    // Creating a candidate must not disturb the legacy active key.
    assert.equal(await manager.getPublicKey('active'), legacyPublicKey);

    await manager.promoteCandidate(legacyPublicKey, candidatePublicKey);

    // Rebuild from persisted storage — promotion must be durable, not cached.
    const restarted = createAgentKeySlotManager(store.storage, forbidGeneration);
    assert.equal(await restarted.getPublicKey('active'), candidatePublicKey);
    assert.equal(await restarted.getPublicKey('previous'), legacyPublicKey);
    assert.equal(await restarted.getPublicKey('candidate'), null);

    // Both surviving slots must now carry modern completion markers.
    assert.equal(store.values.get(MODERN_COMPLETE)?.value, '1');
    assert.equal(store.values.get(PREVIOUS_COMPLETE)?.value, '1');

    // The candidate slot must be fully removed, not merely blanked.
    for (const key of [
      CANDIDATE_SECRET,
      CANDIDATE_PUBLIC,
      CANDIDATE_AUTH,
      CANDIDATE_COMPLETE,
    ]) {
      assert.equal(store.values.has(key), false, `${key} must be removed`);
    }

    // The copied legacy key must retain its original authentication behaviour.
    const expectedRetainedAuth = shape.auth === '1' ? '1' : '0';
    assert.equal(store.values.get(PREVIOUS_AUTH)?.value, expectedRetainedAuth);
    assert.equal(
      store.values.get(PREVIOUS_SECRET)?.requiresAuth,
      shape.authenticatedRead,
    );

    // The original key must still be usable, not merely recorded.
    const retained = await restarted.loadSlot('previous');
    assert.equal(retained.publicKey.toBase58(), legacyPublicKey);
    const retainedTransaction = deterministicTransaction(legacyAgent.publicKey);
    await restarted.signWithSlot('previous', retainedTransaction);
    assert.equal(retainedTransaction.verifySignatures(), true);

    // Exact on-chain resolution must now select each key's correct slot.
    const candidateResolution =
      await restarted.resolveForOnChainPublicKey(candidatePublicKey);
    assert.equal(candidateResolution.status, 'active_match');
    const legacyResolution =
      await restarted.resolveForOnChainPublicKey(legacyPublicKey);
    assert.equal(legacyResolution.status, 'previous_match');
  });

  test(`legacy shape ${shape.id} promotion is restart-idempotent`, async () => {
    const legacyAgent = Keypair.generate();
    const candidateAgent = Keypair.generate();
    const legacyPublicKey = legacyAgent.publicKey.toBase58();
    const candidatePublicKey = candidateAgent.publicKey.toBase58();
    const store = deviceStorage(legacyFixture(legacyAgent, shape.auth));

    const manager = createAgentKeySlotManager(
      store.storage,
      () => candidateAgent,
    );
    await manager.generateCandidate();
    await manager.promoteCandidate(legacyPublicKey, candidatePublicKey);
    const afterFirst = snapshot(store.values);

    // Re-running the completed promotion is the documented crash-recovery path.
    const restarted = createAgentKeySlotManager(store.storage, forbidGeneration);
    await restarted.promoteCandidate(legacyPublicKey, candidatePublicKey);

    assert.equal(
      snapshot(store.values),
      afterFirst,
      'repeating a completed promotion must not change stored keys',
    );
    assert.equal(await restarted.getPublicKey('active'), candidatePublicKey);
    assert.equal(await restarted.getPublicKey('previous'), legacyPublicKey);
    assert.equal(await restarted.getPublicKey('candidate'), null);
  });
}

// ---------------------------------------------------------------------------
// Negative controls: the legacy compatibility path must be narrow. These prove
// it accepts a genuine pre-Phase-4 active slot and nothing else.
// ---------------------------------------------------------------------------

test('legacy compatibility rejects an absent public key when a secret exists', async () => {
  const agent = Keypair.generate();
  const store = deviceStorage({
    [LEGACY_SECRET]: {
      value: bs58.encode(agent.secretKey),
      requiresAuth: true,
    },
    [LEGACY_AUTH]: { value: '1', requiresAuth: false },
  });
  const manager = createAgentKeySlotManager(store.storage, forbidGeneration);

  assert.equal(await manager.hasCompleteSlot('active'), false);
  await assert.rejects(
    () => manager.loadSlot('active'),
    /incomplete or invalid/,
  );
});

test('legacy compatibility rejects a malformed public key', async () => {
  const agent = Keypair.generate();
  const store = deviceStorage({
    ...legacyFixture(agent, '1'),
    [LEGACY_PUBLIC]: { value: 'not a base58 public key', requiresAuth: false },
  });
  const manager = createAgentKeySlotManager(store.storage, forbidGeneration);

  assert.equal(await manager.hasCompleteSlot('active'), false);
  await assert.rejects(
    () => manager.loadSlot('active'),
    /incomplete or invalid/,
  );
});

test('legacy compatibility rejects a public key that does not match the secret', async () => {
  const agent = Keypair.generate();
  const impostor = Keypair.generate();
  const store = deviceStorage({
    ...legacyFixture(agent, '1'),
    [LEGACY_PUBLIC]: {
      value: impostor.publicKey.toBase58(),
      requiresAuth: false,
    },
  });
  const manager = createAgentKeySlotManager(store.storage, forbidGeneration);

  await assert.rejects(
    () => manager.loadSlot('active'),
    /incomplete or invalid/,
  );
});

test('legacy compatibility rejects an invalid authentication value', async () => {
  const agent = Keypair.generate();
  const store = deviceStorage({
    ...legacyFixture(agent, '1'),
    [LEGACY_AUTH]: { value: '2', requiresAuth: false },
  });
  const manager = createAgentKeySlotManager(store.storage, forbidGeneration);

  assert.equal(await manager.hasCompleteSlot('active'), false);
  await assert.rejects(
    () => manager.loadSlot('active'),
    /incomplete or invalid/,
  );
});

test('legacy compatibility rejects a malformed secret', async () => {
  const agent = Keypair.generate();
  const store = deviceStorage({
    ...legacyFixture(agent, '1'),
    [LEGACY_SECRET]: { value: 'not-base58-secret-!!!', requiresAuth: true },
  });
  const manager = createAgentKeySlotManager(store.storage, forbidGeneration);

  await assert.rejects(
    () => manager.loadSlot('active'),
    /incomplete or invalid/,
  );
});

test('the missing-completion-marker path is active-only — candidate is rejected', async () => {
  const agent = Keypair.generate();
  const candidate = Keypair.generate();
  const store = deviceStorage({
    ...legacyFixture(agent, '1'),
    [MODERN_COMPLETE]: { value: '1', requiresAuth: false },
    [CANDIDATE_SECRET]: {
      value: bs58.encode(candidate.secretKey),
      requiresAuth: true,
    },
    [CANDIDATE_PUBLIC]: {
      value: candidate.publicKey.toBase58(),
      requiresAuth: false,
    },
    [CANDIDATE_AUTH]: { value: '1', requiresAuth: false },
  });
  const manager = createAgentKeySlotManager(store.storage, forbidGeneration);

  assert.equal(await manager.hasCompleteSlot('candidate'), false);
  await assert.rejects(
    () => manager.loadSlot('candidate'),
    /incomplete or invalid/,
  );
});

test('the missing-completion-marker path is active-only — previous is rejected', async () => {
  const agent = Keypair.generate();
  const previous = Keypair.generate();
  const store = deviceStorage({
    ...legacyFixture(agent, '1'),
    [MODERN_COMPLETE]: { value: '1', requiresAuth: false },
    [PREVIOUS_SECRET]: {
      value: bs58.encode(previous.secretKey),
      requiresAuth: true,
    },
    [PREVIOUS_PUBLIC]: {
      value: previous.publicKey.toBase58(),
      requiresAuth: false,
    },
    [PREVIOUS_AUTH]: { value: '1', requiresAuth: false },
  });
  const manager = createAgentKeySlotManager(store.storage, forbidGeneration);

  assert.equal(await manager.hasCompleteSlot('previous'), false);
  await assert.rejects(
    () => manager.loadSlot('previous'),
    /incomplete or invalid/,
  );
});

test('a wrong-mode secret read cannot satisfy the legacy path', async () => {
  // Guards the harness itself: if the storage adapter ignored authentication
  // mode, every shape above would pass vacuously. An authenticated secret
  // paired with auth='0' must fail, because the read is issued unauthenticated.
  const agent = Keypair.generate();
  const store = deviceStorage({
    ...legacyFixture(agent, '0'),
    [LEGACY_SECRET]: {
      value: bs58.encode(agent.secretKey),
      requiresAuth: true,
    },
  });
  const manager = createAgentKeySlotManager(store.storage, forbidGeneration);

  await assert.rejects(
    () => manager.loadSlot('active'),
    /incomplete or invalid/,
  );
});
