// V2 authorization tests (WP2): context binding, canonical validation via the WP1
// builders, real Ed25519 signature verification, transient-aware ownership,
// deregistration-after-close, the ownership-verifier classifier, and V1
// regression. No network, no config, no live DB.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import bs58 from 'bs58';
import { PublicKey } from '@solana/web3.js';
import {
  registerMessageV2, deregisterMessageV2, registerMessage, NOTIFY_AUDIENCE, sha256Hex,
} from '../src/authMessage.js';
import {
  authorizeRegisterV2, authorizeDeregisterV2, makeOwnershipVerifier, deriveVaultPda,
} from '../src/registerAuthV2.js';
import { validateRegister } from '../src/registerAuth.js';
import { RESULT } from '../src/registrationStore.js';

const PROGRAM_ID = 'GXCu5964mvgAJDWmcMriZpzU3vDVqPzjYCM1sxCnsoEb'; // public devnet program id
const OTHER_PROGRAM = '11111111111111111111111111111111';
const CLUSTER = 'devnet';
const EXPECTED = { cluster: CLUSTER, programId: PROGRAM_ID, audience: NOTIFY_AUDIENCE };
const NOW = 1784500000;
const DEFAULT_TOKEN = 'fMockFCMToken-0123456789abcdefghijklmnopqrstuvwxyz';
const NONCE_A = '6DspQZLuktpnPitfWYxbDq';
const NONCE_B = bs58.encode(Buffer.alloc(16, 9));
const VAULT_DISC = crypto.createHash('sha256').update('account:VaultConfig').digest().subarray(0, 8);

function makeOwner() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return { owner: bs58.encode(raw), sign: (msg) => crypto.sign(null, Buffer.from(msg, 'utf8'), privateKey) };
}
function buildReg(o, fields = {}) {
  const f = {
    cluster: CLUSTER, programId: PROGRAM_ID, owner: o.owner, vault: deriveVaultPda(o.owner, PROGRAM_ID),
    deviceToken: DEFAULT_TOKEN, stage1: 259200, stage2: 604800, stage3: 604800,
    revision: 1, timestamp: NOW, nonce: NONCE_A, ...fields,
  };
  const message = registerMessageV2({
    cluster: f.cluster, programId: f.programId, owner: f.owner, vault: f.vault,
    deviceTokenHash: sha256Hex(f.deviceToken), stage1: f.stage1, stage2: f.stage2, stage3: f.stage3,
    revision: f.revision, timestamp: f.timestamp, nonce: f.nonce,
  });
  const signature = bs58.encode(o.sign(message));
  const body = {
    owner: f.owner, vault: f.vault, deviceToken: f.deviceToken, stage1: f.stage1, stage2: f.stage2, stage3: f.stage3,
    revision: f.revision, version: 2, cluster: f.cluster, programId: f.programId, audience: NOTIFY_AUDIENCE,
    action: 'register', timestamp: f.timestamp, nonce: f.nonce, signature,
  };
  return { body, message };
}
function buildDereg(o, fields = {}) {
  const f = {
    cluster: CLUSTER, programId: PROGRAM_ID, owner: o.owner, vault: deriveVaultPda(o.owner, PROGRAM_ID),
    timestamp: NOW, nonce: NONCE_A, ...fields,
  };
  const message = deregisterMessageV2({
    cluster: f.cluster, programId: f.programId, owner: f.owner, vault: f.vault, timestamp: f.timestamp, nonce: f.nonce,
  });
  const signature = bs58.encode(o.sign(message));
  const body = {
    owner: f.owner, vault: f.vault, version: 2, cluster: f.cluster, programId: f.programId, audience: NOTIFY_AUDIENCE,
    action: 'deregister', timestamp: f.timestamp, nonce: f.nonce, signature,
  };
  return { body, message };
}
function regDeps(over = {}) {
  return { expected: EXPECTED, now: () => NOW, verifyOwnership: async () => ({ ok: true }), ...over };
}
function deregDeps(over = {}) {
  return { expected: EXPECTED, now: () => NOW, verifyOwnership: async () => ({ ok: true }), getRegistration: () => null, ...over };
}
function spy(result) {
  const fn = async (owner, vault) => { fn.calls.push({ owner, vault }); return typeof result === 'function' ? result() : result; };
  fn.calls = [];
  return fn;
}

// ── Register: happy path + WP1 compatibility ────────────────────────────────
test('valid V2 registration authorizes and returns a clean command', async () => {
  const o = makeOwner();
  const { body } = buildReg(o);
  const r = await authorizeRegisterV2(body, regDeps());
  assert.equal(r.ok, true);
  assert.equal(r.code, RESULT.OK);
  assert.equal(r.command.owner, body.owner);
  assert.equal(r.command.deviceToken, DEFAULT_TOKEN);
  assert.equal(r.command.deviceTokenHash, sha256Hex(DEFAULT_TOKEN));
  assert.equal(r.command.revision, 1);
  assert.equal(r.command.signedAt, NOW);
  assert.equal(r.command.nonceUsedAt, NOW);
  assert.equal(r.command.authVersion, 2);
});
test('a signature over the exact WP1 registerMessageV2 bytes verifies', async () => {
  const o = makeOwner();
  const { body, message } = buildReg(o);
  // sanity: the message we signed is exactly what the WP1 builder produces
  const rebuilt = registerMessageV2({
    cluster: CLUSTER, programId: PROGRAM_ID, owner: body.owner, vault: body.vault,
    deviceTokenHash: sha256Hex(body.deviceToken), stage1: body.stage1, stage2: body.stage2, stage3: body.stage3,
    revision: body.revision, timestamp: body.timestamp, nonce: body.nonce,
  });
  assert.equal(rebuilt, message);
  assert.equal((await authorizeRegisterV2(body, regDeps())).ok, true);
});
test('successful authorization command carries no signature or signed-message bytes', async () => {
  const o = makeOwner();
  const { body, message } = buildReg(o);
  const r = await authorizeRegisterV2(body, regDeps());
  assert.equal('signature' in r.command, false);
  assert.equal('message' in r.command, false);
  const json = JSON.stringify(r.command);
  assert.equal(json.includes(body.signature), false);
  assert.equal(json.includes(message), false);
});

// ── Register: context binding ───────────────────────────────────────────────
for (const [label, patch] of [
  ['request cluster differs from trusted cluster', { cluster: 'mainnet-beta' }],
  ['request program id differs from trusted program', { programId: OTHER_PROGRAM }],
  ['request audience differs from approved audience', { audience: 'https://notify.palatinearc.com/' }],
]) {
  test(`register rejects when ${label} (context_mismatch, no RPC)`, async () => {
    const o = makeOwner();
    const { body } = buildReg(o);
    const v = spy({ ok: true });
    const r = await authorizeRegisterV2({ ...body, ...patch }, regDeps({ verifyOwnership: v }));
    assert.equal(r.code, RESULT.CONTEXT_MISMATCH);
    assert.equal(v.calls.length, 0);
  });
}
test('register rejects a misconfigured expected audience (fail closed)', async () => {
  const o = makeOwner();
  const { body } = buildReg(o);
  const r = await authorizeRegisterV2(body, regDeps({ expected: { ...EXPECTED, audience: 'https://elsewhere.example' } }));
  assert.equal(r.code, RESULT.CONTEXT_MISMATCH);
});
test('register rejects wrong version and wrong action (invalid_request)', async () => {
  const o = makeOwner();
  const { body } = buildReg(o);
  assert.equal((await authorizeRegisterV2({ ...body, version: 3 }, regDeps())).code, RESULT.INVALID_REQUEST);
  assert.equal((await authorizeRegisterV2({ ...body, action: 'deregister' }, regDeps())).code, RESULT.INVALID_REQUEST);
});

// ── Register: signature + tamper ────────────────────────────────────────────
test('register rejects an invalid signature and does no RPC', async () => {
  const o = makeOwner();
  const { body } = buildReg(o);
  const v = spy({ ok: true });
  const r = await authorizeRegisterV2({ ...body, signature: bs58.encode(Buffer.alloc(64, 1)) }, regDeps({ verifyOwnership: v }));
  assert.equal(r.code, RESULT.INVALID_SIGNATURE);
  assert.equal(v.calls.length, 0);
});
test('register rejects a signature made by a different owner', async () => {
  const o1 = makeOwner();
  const o2 = makeOwner();
  const { body, message } = buildReg(o1);
  const r = await authorizeRegisterV2({ ...body, signature: bs58.encode(o2.sign(message)) }, regDeps());
  assert.equal(r.code, RESULT.INVALID_SIGNATURE);
});
for (const [label, patch] of [
  ['token', { deviceToken: 'different-token-AAAAAAAAAAAAAAAAAAAAAAAAAAAA' }],
  ['stages', { stage1: 999999 }],
  ['revision', { revision: 7 }],
  ['nonce', { nonce: NONCE_B }],
]) {
  test(`register rejects when ${label} changed after signing`, async () => {
    const o = makeOwner();
    const { body } = buildReg(o);
    const r = await authorizeRegisterV2({ ...body, ...patch }, regDeps());
    assert.equal(r.code, RESULT.INVALID_SIGNATURE);
  });
}
test('register rejects a fractional timestamp (invalid_request)', async () => {
  const o = makeOwner();
  const { body } = buildReg(o);
  assert.equal((await authorizeRegisterV2({ ...body, timestamp: 1.5 }, regDeps())).code, RESULT.INVALID_REQUEST);
});
test('register rejects stale and excessively future timestamps', async () => {
  const o = makeOwner();
  const past = buildReg(o, { timestamp: NOW - 601 });
  const future = buildReg(o, { timestamp: NOW + 601 });
  assert.equal((await authorizeRegisterV2(past.body, regDeps())).code, RESULT.STALE_TIMESTAMP);
  assert.equal((await authorizeRegisterV2(future.body, regDeps())).code, RESULT.STALE_TIMESTAMP);
});
for (const [label, sig] of [
  ['malformed base58', 'not base58 !!!'],
  ['63-byte signature', bs58.encode(Buffer.alloc(63, 2))],
  ['65-byte signature', bs58.encode(Buffer.alloc(65, 2))],
]) {
  test(`register rejects a ${label} signature`, async () => {
    const o = makeOwner();
    const { body } = buildReg(o);
    assert.equal((await authorizeRegisterV2({ ...body, signature: sig }, regDeps())).code, RESULT.INVALID_SIGNATURE);
  });
}
test('register: an invalid local request performs no RPC', async () => {
  const o = makeOwner();
  const { body } = buildReg(o);
  const v = spy({ ok: true });
  await authorizeRegisterV2({ ...body, version: 9 }, regDeps({ verifyOwnership: v }));
  assert.equal(v.calls.length, 0);
});

// ── Register: ownership verification ────────────────────────────────────────
test('valid registration performs live ownership verification exactly once', async () => {
  const o = makeOwner();
  const { body } = buildReg(o);
  const v = spy({ ok: true });
  const r = await authorizeRegisterV2(body, regDeps({ verifyOwnership: v }));
  assert.equal(r.ok, true);
  assert.equal(v.calls.length, 1);
  assert.deepEqual(v.calls[0], { owner: body.owner, vault: body.vault });
});
test('definitive ownership failure → ownership_failed', async () => {
  const o = makeOwner();
  const { body } = buildReg(o);
  const r = await authorizeRegisterV2(body, regDeps({ verifyOwnership: async () => ({ ok: false, transient: false, reason: 'x' }) }));
  assert.equal(r.code, RESULT.OWNERSHIP_FAILED);
  assert.equal(r.command, undefined);
});
test('transient ownership failure → dependency_unavailable and no command', async () => {
  const o = makeOwner();
  const { body } = buildReg(o);
  const r = await authorizeRegisterV2(body, regDeps({ verifyOwnership: async () => ({ ok: false, transient: true, reason: 'rpc' }) }));
  assert.equal(r.code, RESULT.DEPENDENCY_UNAVAILABLE);
  assert.equal(r.command, undefined);
});
test('a thrown ownership verifier → dependency_unavailable', async () => {
  const o = makeOwner();
  const { body } = buildReg(o);
  const r = await authorizeRegisterV2(body, regDeps({ verifyOwnership: async () => { throw new Error('boom'); } }));
  assert.equal(r.code, RESULT.DEPENDENCY_UNAVAILABLE);
});

// ── Deregistration after close (§12) ────────────────────────────────────────
test('dereg: stored owner matches → authorizes without RPC', async () => {
  const o = makeOwner();
  const { body } = buildDereg(o);
  const v = spy({ ok: false, transient: false }); // would fail if called
  const r = await authorizeDeregisterV2(body, deregDeps({ verifyOwnership: v, getRegistration: () => ({ owner: body.owner }) }));
  assert.equal(r.ok, true);
  assert.equal(v.calls.length, 0);
});
test('dereg: stored owner differs → owner_conflict, no RPC, no command', async () => {
  const o = makeOwner();
  const { body } = buildDereg(o);
  const v = spy({ ok: true });
  const r = await authorizeDeregisterV2(body, deregDeps({ verifyOwnership: v, getRegistration: () => ({ owner: 'someone-else' }) }));
  assert.equal(r.code, RESULT.OWNER_CONFLICT);
  assert.equal(v.calls.length, 0);
  assert.equal(r.command, undefined);
});
test('dereg: no stored row, live vault matches → authorizes with RPC', async () => {
  const o = makeOwner();
  const { body } = buildDereg(o);
  const v = spy({ ok: true });
  const r = await authorizeDeregisterV2(body, deregDeps({ verifyOwnership: v, getRegistration: () => null }));
  assert.equal(r.ok, true);
  assert.equal(v.calls.length, 1);
  assert.ok(r.command);
});
test('dereg: no stored row, definitive invalid → ownership_failed', async () => {
  const o = makeOwner();
  const { body } = buildDereg(o);
  const r = await authorizeDeregisterV2(body, deregDeps({ verifyOwnership: async () => ({ ok: false, transient: false }), getRegistration: () => null }));
  assert.equal(r.code, RESULT.OWNERSHIP_FAILED);
});
test('dereg: no stored row, RPC unavailable → dependency_unavailable, no command', async () => {
  const o = makeOwner();
  const { body } = buildDereg(o);
  const r = await authorizeDeregisterV2(body, deregDeps({ verifyOwnership: async () => ({ ok: false, transient: true }), getRegistration: () => null }));
  assert.equal(r.code, RESULT.DEPENDENCY_UNAVAILABLE);
  assert.equal(r.command, undefined);
});
test('dereg: vault is not the canonical PDA → context_mismatch before storage or RPC', async () => {
  const o = makeOwner();
  // sign a message whose vault is a valid-but-wrong pubkey (not PDA(owner))
  const wrongVault = OTHER_PROGRAM;
  const { body } = buildDereg(o, { vault: wrongVault });
  const v = spy({ ok: true });
  let readCalls = 0;
  const r = await authorizeDeregisterV2(body, deregDeps({ verifyOwnership: v, getRegistration: () => { readCalls++; return null; } }));
  assert.equal(r.code, RESULT.CONTEXT_MISMATCH);
  assert.equal(v.calls.length, 0);
  assert.equal(readCalls, 0);
});
test('dereg rejects an invalid signature', async () => {
  const o = makeOwner();
  const { body } = buildDereg(o);
  assert.equal((await authorizeDeregisterV2({ ...body, signature: bs58.encode(Buffer.alloc(64, 3)) }, deregDeps())).code, RESULT.INVALID_SIGNATURE);
});

// ── makeOwnershipVerifier classifier ────────────────────────────────────────
function vaultAccount(ownerBase58, { programId = PROGRAM_ID } = {}) {
  return { owner: new PublicKey(programId), data: Buffer.concat([VAULT_DISC, bs58.decode(ownerBase58), Buffer.alloc(80)]) };
}
test('ownership verifier accepts a valid program-owned VaultConfig with matching owner', async () => {
  const o = makeOwner();
  const vault = deriveVaultPda(o.owner, PROGRAM_ID);
  const verify = makeOwnershipVerifier(async () => vaultAccount(o.owner), { programId: PROGRAM_ID });
  assert.deepEqual(await verify(o.owner, vault), { ok: true });
});
test('ownership verifier classifies a transport throw as transient', async () => {
  const o = makeOwner();
  const vault = deriveVaultPda(o.owner, PROGRAM_ID);
  const verify = makeOwnershipVerifier(async () => { throw new Error('ECONNRESET'); }, { programId: PROGRAM_ID });
  const r = await verify(o.owner, vault);
  assert.equal(r.ok, false);
  assert.equal(r.transient, true);
});
test('ownership verifier: null account, wrong program, and owner mismatch are definitive', async () => {
  const o = makeOwner();
  const other = makeOwner();
  const vault = deriveVaultPda(o.owner, PROGRAM_ID);
  const nul = makeOwnershipVerifier(async () => null, { programId: PROGRAM_ID });
  assert.equal((await nul(o.owner, vault)).transient, false);
  const wrongProg = makeOwnershipVerifier(async () => ({ owner: new PublicKey(OTHER_PROGRAM), data: Buffer.concat([VAULT_DISC, bs58.decode(o.owner), Buffer.alloc(80)]) }), { programId: PROGRAM_ID });
  assert.equal((await wrongProg(o.owner, vault)).ok, false);
  const mismatch = makeOwnershipVerifier(async () => vaultAccount(other.owner), { programId: PROGRAM_ID });
  const rm = await mismatch(o.owner, vault);
  assert.equal(rm.ok, false);
  assert.equal(rm.transient, false);
});
test('ownership verifier rejects a non-canonical PDA without fetching', async () => {
  const o = makeOwner();
  let fetched = 0;
  const verify = makeOwnershipVerifier(async () => { fetched++; return vaultAccount(o.owner); }, { programId: PROGRAM_ID });
  const r = await verify(o.owner, 'not-the-pda');
  assert.equal(r.ok, false);
  assert.equal(r.transient, false);
  assert.equal(fetched, 0);
});

// ── V1 regression (unchanged) ───────────────────────────────────────────────
test('V1 validateRegister still authorizes a valid V1 signed request', async () => {
  const o = makeOwner();
  const vault = deriveVaultPda(o.owner, PROGRAM_ID);
  const deviceToken = 'v1-fake-token-0123456789abcdef';
  const timestamp = NOW;
  const nonce = 'v1nonce12345';
  const message = registerMessage({
    owner: o.owner, vault, deviceTokenHash: sha256Hex(deviceToken), stage1: 259200, stage2: 604800, stage3: 604800, timestamp, nonce,
  });
  const body = { owner: o.owner, vault, deviceToken, stage1: 259200, stage2: 604800, stage3: 604800, signature: bs58.encode(o.sign(message)), timestamp, nonce };
  const res = await validateRegister(body, { verifyVaultForOwner: async () => ({ ok: true }), claimNonce: () => true, now: () => NOW });
  assert.equal(res.ok, true);
});
test('V1 validateRegister still rejects a malformed body with status 400', async () => {
  const res = await validateRegister({ owner: 'bad', vault: 'bad' }, { verifyVaultForOwner: async () => ({ ok: true }), claimNonce: () => true, now: () => NOW });
  assert.equal(res.ok, false);
  assert.equal(res.status, 400);
});
