import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Keypair, Transaction } from '@solana/web3.js';
import {
  createAgentKeySlotManager,
  type AgentKeySlotStorage,
} from './AgentKeySlotManagerCore.ts';

function memoryStorage() {
  const values = new Map<string, string>();
  const storage: AgentKeySlotStorage = {
    get: async (key) => values.get(key) ?? null,
    set: async (key, value, authenticated) => {
      values.set(key, value);
      return authenticated;
    },
    remove: async (key) => {
      values.delete(key);
    },
  };
  return { values, storage };
}

function managerWithKeys(keys: Array<Keypair>) {
  const memory = memoryStorage();
  let index = 0;
  return {
    ...memory,
    manager: createAgentKeySlotManager(memory.storage, () => keys[index++]),
  };
}

test('candidate creation leaves the active key unchanged and validates readback', async () => {
  const active = Keypair.generate();
  const candidate = Keypair.generate();
  const { manager } = managerWithKeys([active, candidate]);
  await manager.generateActive();

  const generated = await manager.generateCandidate();

  assert.equal(generated, candidate.publicKey.toBase58());
  assert.equal(
    (await manager.loadSlot('active')).publicKey.toBase58(),
    active.publicKey.toBase58(),
  );
  assert.equal(
    (await manager.loadSlot('candidate')).publicKey.toBase58(),
    generated,
  );
});

test('candidate write failure leaves the active key usable', async () => {
  const active = Keypair.generate();
  const candidate = Keypair.generate();
  const memory = memoryStorage();
  let generated = 0;
  const manager = createAgentKeySlotManager(
    {
      ...memory.storage,
      set: async (key, value, authenticated) => {
        if (key === 'dmv_agent_candidate_public_key') {
          throw new Error('mock candidate metadata failure');
        }
        return memory.storage.set(key, value, authenticated);
      },
    },
    () => [active, candidate][generated++],
  );
  await manager.generateActive();

  await assert.rejects(manager.generateCandidate());
  assert.equal(
    (await manager.loadSlot('active')).publicKey.toBase58(),
    active.publicKey.toBase58(),
  );
});

test('incomplete candidate metadata is detected without corrupting active', async () => {
  const active = Keypair.generate();
  const { manager, values } = managerWithKeys([active]);
  await manager.generateActive();
  values.set(
    'dmv_agent_candidate_public_key',
    Keypair.generate().publicKey.toBase58(),
  );

  const resolution = await manager.resolveForOnChainPublicKey(
    active.publicKey.toBase58(),
  );

  assert.deepEqual(resolution, {
    status: 'corrupt_slot',
    slot: 'candidate',
  });
  assert.equal(
    (await manager.loadSlot('active')).publicKey.toBase58(),
    active.publicKey.toBase58(),
  );
});

test('resolver reports active, candidate and previous matches exactly', async () => {
  const active = Keypair.generate();
  const candidate = Keypair.generate();
  const nextCandidate = Keypair.generate();
  const { manager } = managerWithKeys([active, candidate, nextCandidate]);
  await manager.generateActive();
  await manager.generateCandidate();
  await manager.promoteCandidate(
    active.publicKey.toBase58(),
    candidate.publicKey.toBase58(),
  );
  await manager.generateCandidate();

  assert.equal(
    (await manager.resolveForOnChainPublicKey(candidate.publicKey.toBase58()))
      .status,
    'active_match',
  );
  assert.equal(
    (
      await manager.resolveForOnChainPublicKey(
        nextCandidate.publicKey.toBase58(),
      )
    ).status,
    'candidate_match',
  );
  assert.equal(
    (await manager.resolveForOnChainPublicKey(active.publicKey.toBase58()))
      .status,
    'previous_match',
  );
});

test('resolver reports no match and does not generate a key', async () => {
  const active = Keypair.generate();
  let generations = 0;
  const memory = memoryStorage();
  const manager = createAgentKeySlotManager(memory.storage, () => {
    generations += 1;
    return active;
  });
  await manager.generateActive();

  const resolution = await manager.resolveForOnChainPublicKey(
    Keypair.generate().publicKey.toBase58(),
  );

  assert.equal(resolution.status, 'no_match');
  assert.equal(generations, 1);
});

test('resolver rejects multiple matching slots instead of first-key wins', async () => {
  const key = Keypair.generate();
  const { manager, values } = managerWithKeys([key]);
  await manager.generateActive();
  for (const suffix of [
    'secret_key',
    'public_key',
    'key_auth',
    'key_complete',
  ]) {
    const activeName = `dmv_agent_${suffix}`;
    const candidateName = `dmv_agent_candidate_${suffix}`;
    values.set(candidateName, values.get(activeName)!);
  }

  const resolution = await manager.resolveForOnChainPublicKey(
    key.publicKey.toBase58(),
  );

  assert.equal(resolution.status, 'multiple_matches');
});

test('loading by public key requires an exact single match', async () => {
  const active = Keypair.generate();
  const { manager } = managerWithKeys([active]);
  await manager.generateActive();

  await assert.rejects(
    manager.loadByExactPublicKey(Keypair.generate().publicKey.toBase58()),
  );
  assert.equal(
    (
      await manager.loadByExactPublicKey(active.publicKey.toBase58())
    ).publicKey.toBase58(),
    active.publicKey.toBase58(),
  );
});

test('legacy active slot without auth/complete markers remains readable and exact', async () => {
  const key = Keypair.generate();
  const { manager, values } = managerWithKeys([]);
  values.set(
    'dmv_agent_secret_key',
    (await import('bs58')).default.encode(key.secretKey),
  );
  values.set('dmv_agent_public_key', key.publicKey.toBase58());

  assert.equal(
    (await manager.loadSlot('active')).publicKey.toBase58(),
    key.publicKey.toBase58(),
  );
});

test('promotion retains previous, activates candidate and removes only duplicate candidate slot', async () => {
  const active = Keypair.generate();
  const candidate = Keypair.generate();
  const { manager } = managerWithKeys([active, candidate]);
  await manager.generateActive();
  await manager.generateCandidate();

  await manager.promoteCandidate(
    active.publicKey.toBase58(),
    candidate.publicKey.toBase58(),
  );

  assert.equal(
    await manager.getPublicKey('active'),
    candidate.publicKey.toBase58(),
  );
  assert.equal(
    await manager.getPublicKey('previous'),
    active.publicKey.toBase58(),
  );
  assert.equal(await manager.getPublicKey('candidate'), null);
});

test('promotion is idempotently repairable after active and previous were copied', async () => {
  const active = Keypair.generate();
  const candidate = Keypair.generate();
  const { manager, values } = managerWithKeys([active, candidate]);
  await manager.generateActive();
  await manager.generateCandidate();
  await manager.promoteCandidate(
    active.publicKey.toBase58(),
    candidate.publicKey.toBase58(),
  );
  // Recreate a crash-left duplicate candidate from active.
  for (const suffix of [
    'secret_key',
    'public_key',
    'key_auth',
    'key_complete',
  ]) {
    values.set(
      `dmv_agent_candidate_${suffix}`,
      values.get(`dmv_agent_${suffix}`)!,
    );
  }

  await manager.promoteCandidate(
    active.publicKey.toBase58(),
    candidate.publicKey.toBase58(),
  );

  assert.equal(await manager.getPublicKey('candidate'), null);
  assert.equal(
    await manager.getPublicKey('previous'),
    active.publicKey.toBase58(),
  );
});

test('promotion never overwrites a different retained previous key', async () => {
  const first = Keypair.generate();
  const active = Keypair.generate();
  const candidate = Keypair.generate();
  const { manager } = managerWithKeys([first, active, candidate]);
  await manager.generateActive();
  await manager.generateCandidate();
  await manager.promoteCandidate(
    first.publicKey.toBase58(),
    active.publicKey.toBase58(),
  );
  await manager.generateCandidate();

  await assert.rejects(
    manager.promoteCandidate(
      active.publicKey.toBase58(),
      candidate.publicKey.toBase58(),
    ),
    /different previous key/,
  );
  assert.equal(
    await manager.getPublicKey('active'),
    active.publicKey.toBase58(),
  );
  assert.equal(
    await manager.getPublicKey('previous'),
    first.publicKey.toBase58(),
  );
  assert.equal(
    await manager.getPublicKey('candidate'),
    candidate.publicKey.toBase58(),
  );
});

test('explicit slot removal wipes the cached secret before deleting storage', async () => {
  const active = Keypair.generate();
  const { manager } = managerWithKeys([active]);
  await manager.generateActive();
  const loaded = await manager.loadSlot('active');

  await manager.removeSlot('active');

  const internal = Reflect.get(loaded, '_keypair') as {
    secretKey: Uint8Array;
  };
  assert.equal(
    internal.secretKey.every((byte) => byte === 0),
    true,
  );
  assert.equal(await manager.getPublicKey('active'), null);
});

test('slot signing never serialises or persists the private key', async () => {
  const active = Keypair.generate();
  const { manager, values } = managerWithKeys([active]);
  await manager.generateActive();
  const transaction = new Transaction({
    feePayer: active.publicKey,
    recentBlockhash: PublicKeyDefault,
  });

  await manager.signWithSlot('active', transaction);

  assert.ok(transaction.signature);
  assert.equal(
    Array.from(values.keys()).some((key) => key.includes('transaction')),
    false,
  );
});

test('side-by-side successor promotes a verified candidate from an empty active slot', async () => {
  const candidate = Keypair.generate();
  const legacyPublicKey = Keypair.generate().publicKey.toBase58();
  const { manager } = managerWithKeys([candidate]);
  await manager.generateCandidate();

  await manager.promoteIncomingCandidate(
    legacyPublicKey,
    candidate.publicKey.toBase58(),
  );
  await manager.promoteIncomingCandidate(
    legacyPublicKey,
    candidate.publicKey.toBase58(),
  );

  assert.equal(
    await manager.getPublicKey('active'),
    candidate.publicKey.toBase58(),
  );
  assert.equal(await manager.getPublicKey('candidate'), null);
  assert.equal(await manager.getPublicKey('previous'), null);
});

test('ordinary same-installation promotion still requires its active old key', async () => {
  const candidate = Keypair.generate();
  const { manager } = managerWithKeys([candidate]);
  await manager.generateCandidate();
  await assert.rejects(
    manager.promoteCandidate(
      Keypair.generate().publicKey.toBase58(),
      candidate.publicKey.toBase58(),
    ),
    /missing/i,
  );
});

const PublicKeyDefault = '11111111111111111111111111111111';
