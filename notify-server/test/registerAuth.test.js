import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import bs58 from 'bs58';
import { registerMessage, deregisterMessage, sha256Hex } from '../src/authMessage.js';
import { validateRegister, validateDeregister } from '../src/registerAuth.js';

// --- helpers: real Ed25519 keypair (Solana-style base58 pubkey) + detached sign ---
function newOwner() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pubBytes = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url'); // raw 32-byte key
  return { ownerB58: bs58.encode(pubBytes), privateKey };
}
function signB58(privateKey, message) {
  return bs58.encode(cryptoSign(null, Buffer.from(message, 'utf8'), privateKey));
}
function randomVault() {
  return bs58.encode(Buffer.from(generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }).x, 'base64url'));
}

const STAGES = { s1: 10, s2: 10, s3: 10 };
const NOW = 1_800_000_000;

function makeDeps({ vaultOk = true, now = NOW } = {}) {
  const nonces = new Set();
  return {
    verifyVaultForOwner: async () => (vaultOk ? { ok: true } : { ok: false, reason: 'vault not found on-chain' }),
    claimNonce: (owner, nonce) => {
      const k = `${owner}|${nonce}`;
      if (nonces.has(k)) return false;
      nonces.add(k);
      return true;
    },
    now: () => now,
  };
}

function registerBody({ ownerB58, privateKey, vault, deviceToken, ts = NOW, nonce = 'nonce-abcdef', hashToken }) {
  const deviceTokenHash = sha256Hex(hashToken ?? deviceToken);
  const message = registerMessage({ owner: ownerB58, vault, deviceTokenHash, stage1: STAGES.s1, stage2: STAGES.s2, stage3: STAGES.s3, timestamp: ts, nonce });
  return { owner: ownerB58, vault, deviceToken, stage1: STAGES.s1, stage2: STAGES.s2, stage3: STAGES.s3, timestamp: ts, nonce, signature: signB58(privateKey, message) };
}

test('valid signed registration succeeds', async () => {
  const { ownerB58, privateKey } = newOwner();
  const body = registerBody({ ownerB58, privateKey, vault: randomVault(), deviceToken: 'fcm-device-token-123' });
  const r = await validateRegister(body, makeDeps());
  assert.equal(r.ok, true);
  assert.equal(r.registration.owner, ownerB58);
  assert.equal(r.registration.deviceToken, 'fcm-device-token-123');
});

test('invalid signature fails', async () => {
  const { ownerB58, privateKey } = newOwner();
  const body = registerBody({ ownerB58, privateKey, vault: randomVault(), deviceToken: 'fcm-device-token-123' });
  body.signature = bs58.encode(Buffer.alloc(64, 7)); // wrong signature
  const r = await validateRegister(body, makeDeps());
  assert.equal(r.ok, false);
  assert.equal(r.status, 401);
});

test('expired timestamp fails', async () => {
  const { ownerB58, privateKey } = newOwner();
  const staleTs = NOW - 3600; // 1h old, window is 10m
  const body = registerBody({ ownerB58, privateKey, vault: randomVault(), deviceToken: 'fcm-device-token-123', ts: staleTs });
  const r = await validateRegister(body, makeDeps());
  assert.equal(r.ok, false);
  assert.equal(r.status, 401);
});

test('reused nonce fails', async () => {
  const { ownerB58, privateKey } = newOwner();
  const deps = makeDeps();
  const vault = randomVault();
  const first = await validateRegister(registerBody({ ownerB58, privateKey, vault, deviceToken: 'device-token-aaa', nonce: 'shared-nonce-x' }), deps);
  assert.equal(first.ok, true);
  // Same nonce again (fresh valid signature, same nonce string) must be rejected.
  const second = await validateRegister(registerBody({ ownerB58, privateKey, vault, deviceToken: 'device-token-aaa', nonce: 'shared-nonce-x' }), deps);
  assert.equal(second.ok, false);
  assert.equal(second.status, 401);
});

test('mismatched deviceTokenHash fails', async () => {
  const { ownerB58, privateKey } = newOwner();
  // Sign over the hash of "real-token" but submit a different deviceToken.
  const body = registerBody({ ownerB58, privateKey, vault: randomVault(), deviceToken: 'attacker-token', hashToken: 'real-token' });
  const r = await validateRegister(body, makeDeps());
  assert.equal(r.ok, false);
  assert.equal(r.status, 401);
});

test('no owner signature fails', async () => {
  const { ownerB58, privateKey } = newOwner();
  const body = registerBody({ ownerB58, privateKey, vault: randomVault(), deviceToken: 'fcm-device-token-123' });
  delete body.signature;
  const r = await validateRegister(body, makeDeps());
  assert.equal(r.ok, false);
  assert.ok(r.status === 400 || r.status === 401);
});

test('registration for an unowned/unreal vault is rejected (403)', async () => {
  const { ownerB58, privateKey } = newOwner();
  const body = registerBody({ ownerB58, privateKey, vault: randomVault(), deviceToken: 'fcm-device-token-123' });
  const r = await validateRegister(body, makeDeps({ vaultOk: false }));
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
});

test('valid deregister signature removes registration', async () => {
  const { ownerB58, privateKey } = newOwner();
  const vault = randomVault();
  const message = deregisterMessage({ owner: ownerB58, vault, timestamp: NOW, nonce: 'dereg-nonce-1' });
  const body = { owner: ownerB58, vault, timestamp: NOW, nonce: 'dereg-nonce-1', signature: signB58(privateKey, message) };
  const r = await validateDeregister(body, makeDeps());
  assert.equal(r.ok, true);
  assert.equal(r.vault, vault);
});

test('invalid deregister signature fails', async () => {
  const { ownerB58 } = newOwner();
  const vault = randomVault();
  const body = { owner: ownerB58, vault, timestamp: NOW, nonce: 'dereg-nonce-2', signature: bs58.encode(Buffer.alloc(64, 9)) };
  const r = await validateDeregister(body, makeDeps());
  assert.equal(r.ok, false);
  assert.equal(r.status, 401);
});
