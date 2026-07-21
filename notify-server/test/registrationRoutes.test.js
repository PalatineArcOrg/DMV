// WP3 registration route matrix (§16): auth-mode routing, signed-attempt
// classification, downgrade resistance, signed-row stickiness, result→HTTP
// mapping. Real authorizers + a real :memory: store; mocked ownership verifier and
// clock. No server, no network, no live DB.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import bs58 from 'bs58';
import Database from 'better-sqlite3';
import { registerMessageV2, deregisterMessageV2, registerMessage, NOTIFY_AUDIENCE, sha256Hex } from '../src/authMessage.js';
import { authorizeRegisterV2, authorizeDeregisterV2, deriveVaultPda } from '../src/registerAuthV2.js';
import {
  ensureSchema, getRegistration as storeGet, applySignedRegistration as storeSignedReg,
  applySignedDeregistration as storeSignedDereg, applyLegacyRegistration as storeLegacyReg,
  deleteLegacyRegistration as storeLegacyDel, deleteLegacyRegistrationsByOwner as storeLegacyDelByOwner,
} from '../src/registrationStore.js';
import { makeRegistrationHandlers } from '../src/registrationRoutes.js';
import { makeWriteRateLimiter } from '../src/writeRateLimiter.js';
import { makeLegacySecretCheck } from '../src/secretGate.js';
import { AUTH_MODE } from '../src/config.js';

const PID = 'GXCu5964mvgAJDWmcMriZpzU3vDVqPzjYCM1sxCnsoEb';
const CLUSTER = 'devnet';
const NOW = 1784500000;
const NONCE = '6DspQZLuktpnPitfWYxbDq';
const TOKEN = 'fMockFCMToken-0123456789abcdefghijklmnopqrstuvwxyz';
const LEGACY_SECRET = 'legacy-secret';

function owner() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return { owner: bs58.encode(raw), sign: (m) => crypto.sign(null, Buffer.from(m, 'utf8'), privateKey) };
}
// Expand a short test nonce seed into a valid 22-64 char Base58 nonce (deterministic per seed).
function vn(seed) {
  return seed.length >= 22 ? seed : bs58.encode(Buffer.from(String(seed).padEnd(22, 'x')));
}
function signedReg(o, f = {}) {
  const b = {
    cluster: CLUSTER, programId: PID, owner: o.owner, vault: deriveVaultPda(o.owner, PID),
    deviceToken: TOKEN, stage1: 259200, stage2: 604800, stage3: 604800, revision: 1, timestamp: NOW, nonce: NONCE, ...f,
  };
  b.nonce = vn(b.nonce);
  const msg = registerMessageV2({
    cluster: b.cluster, programId: b.programId, owner: b.owner, vault: b.vault,
    deviceTokenHash: sha256Hex(b.deviceToken), stage1: b.stage1, stage2: b.stage2, stage3: b.stage3,
    revision: b.revision, timestamp: b.timestamp, nonce: b.nonce,
  });
  return {
    owner: b.owner, vault: b.vault, deviceToken: b.deviceToken, stage1: b.stage1, stage2: b.stage2, stage3: b.stage3,
    revision: b.revision, version: 2, cluster: b.cluster, programId: b.programId, audience: NOTIFY_AUDIENCE,
    action: 'register', timestamp: b.timestamp, nonce: b.nonce, signature: bs58.encode(o.sign(msg)),
  };
}
function signedDereg(o, f = {}) {
  const b = { cluster: CLUSTER, programId: PID, owner: o.owner, vault: deriveVaultPda(o.owner, PID), timestamp: NOW, nonce: NONCE, ...f };
  b.nonce = vn(b.nonce);
  const msg = deregisterMessageV2({ cluster: b.cluster, programId: b.programId, owner: b.owner, vault: b.vault, timestamp: b.timestamp, nonce: b.nonce });
  return {
    owner: b.owner, vault: b.vault, version: 2, cluster: b.cluster, programId: b.programId, audience: NOTIFY_AUDIENCE,
    action: 'deregister', timestamp: b.timestamp, nonce: b.nonce, signature: bs58.encode(o.sign(msg)),
  };
}
function legacyReg(o, f = {}) {
  return { owner: o.owner, vault: deriveVaultPda(o.owner, PID), deviceToken: TOKEN, stage1: 259200, stage2: 604800, stage3: 604800, ...f };
}
function isPubkey(s) { try { bs58.decode(s); return typeof s === 'string' && s.length >= 32 && s.length <= 44; } catch { return false; } }

function req(body, headers = {}) {
  const h = {}; for (const [k, v] of Object.entries(headers)) h[k.toLowerCase()] = v;
  return { body, ip: '1.1.1.1', headers: h, get: (n) => h[n.toLowerCase()] };
}
function res() {
  return {
    _s: null, _j: null, _h: {},
    status(c) { this._s = c; return this; },
    json(o) { this._j = o; return this; },
    set(k, v) { this._h[k.toLowerCase()] = v; return this; },
  };
}

function harness(mode, over = {}) {
  const db = new Database(':memory:'); ensureSchema(db);
  const verifyOwnership = over.verifyOwnership || (async () => ({ ok: true }));
  const legacyOwnerVerify = over.legacyOwnerVerify || (async () => ({ ok: true }));
  const handlers = makeRegistrationHandlers({
    mode,
    expected: { cluster: CLUSTER, programId: PID, audience: NOTIFY_AUDIENCE },
    authorizeRegisterV2, authorizeDeregisterV2, verifyOwnership,
    getRegistration: (v) => storeGet(db, v),
    applySignedRegistration: over.applySignedRegistration || ((c) => storeSignedReg(db, c)),
    applySignedDeregistration: (c) => storeSignedDereg(db, c),
    applyLegacyRegistration: (c) => storeLegacyReg(db, c),
    deleteLegacyRegistration: (a) => storeLegacyDel(db, a),
    deleteLegacyRegistrationsByOwner: (ownerKey) => storeLegacyDelByOwner(db, ownerKey),
    legacyOwnerVerify,
    legacySecretOk: makeLegacySecretCheck(LEGACY_SECRET),
    limiter: makeWriteRateLimiter({ now: () => NOW * 1000 }),
    clientIp: (r) => r.ip,
    now: () => NOW,
    logger: { log() {} },
    tokFingerprint: () => 'tok#xxxxxxxx',
    sha256Hex, isPubkey,
  });
  return { db, handlers };
}
const call = async (fn, r) => { const rs = res(); await fn(r, rs); return rs; };
const secret = { 'x-dmv-secret': LEGACY_SECRET };

// ── Mode / classification ───────────────────────────────────────────────────
test('pure legacy register — legacy mode → 200 {ok:true}', async () => {
  const o = owner(); const { handlers } = harness(AUTH_MODE.LEGACY_ONLY);
  const r = await call(handlers.register, req(legacyReg(o), secret));
  assert.equal(r._s, 200); assert.deepEqual(r._j, { ok: true });
});
test('pure legacy register — dual mode → 200 {ok:true}', async () => {
  const o = owner(); const { handlers } = harness(AUTH_MODE.DUAL_ACCEPT);
  const r = await call(handlers.register, req(legacyReg(o), secret));
  assert.equal(r._s, 200); assert.deepEqual(r._j, { ok: true });
});
test('pure legacy register — signed mode → 409 signed_required', async () => {
  const o = owner(); const { handlers } = harness(AUTH_MODE.SIGNED_REQUIRED);
  const r = await call(handlers.register, req(legacyReg(o), secret));
  assert.equal(r._s, 409); assert.equal(r._j.code, 'signed_required');
});
test('valid signed register — dual mode → 201 created + revision', async () => {
  const o = owner(); const { handlers } = harness(AUTH_MODE.DUAL_ACCEPT);
  const r = await call(handlers.register, req(signedReg(o)));
  assert.equal(r._s, 201); assert.deepEqual(r._j, { ok: true, result: 'created', revision: 1 });
});
test('valid signed register — signed mode → 201 (no secret needed)', async () => {
  const o = owner(); const { handlers } = harness(AUTH_MODE.SIGNED_REQUIRED);
  const r = await call(handlers.register, req(signedReg(o)));
  assert.equal(r._s, 201);
});
test('signed attempt in legacy mode → 409 signed_not_enabled', async () => {
  const o = owner(); const { handlers } = harness(AUTH_MODE.LEGACY_ONLY);
  const r = await call(handlers.register, req(signedReg(o)));
  assert.equal(r._s, 409); assert.equal(r._j.code, 'signed_not_enabled');
});
test('invalid signed request WITH a valid legacy secret does NOT downgrade', async () => {
  const o = owner(); const { db, handlers } = harness(AUTH_MODE.DUAL_ACCEPT);
  const body = { ...signedReg(o), signature: bs58.encode(Buffer.alloc(64, 1)) }; // bad sig
  const r = await call(handlers.register, req(body, secret));
  assert.equal(r._s, 401); assert.equal(r._j.code, 'invalid_signature');
  assert.equal(getRegistrationCount(db), 0, 'nothing stored via a legacy fallback');
});
test('missing signature + V2 fields is a signed attempt (no downgrade) → 401', async () => {
  const o = owner(); const { handlers } = harness(AUTH_MODE.DUAL_ACCEPT);
  const body = signedReg(o); delete body.signature;
  const r = await call(handlers.register, req(body, secret));
  assert.equal(r._s, 401); assert.equal(r._j.code, 'invalid_signature');
});
test('V1 signed payload does not activate or downgrade → 400 invalid_request', async () => {
  const o = owner();
  const vault = deriveVaultPda(o.owner, PID);
  const msg = registerMessage({ owner: o.owner, vault, deviceTokenHash: sha256Hex(TOKEN), stage1: 1, stage2: 2, stage3: 3, timestamp: NOW, nonce: 'v1nonce123' });
  const body = { owner: o.owner, vault, deviceToken: TOKEN, stage1: 1, stage2: 2, stage3: 3, timestamp: NOW, nonce: 'v1nonce123', signature: bs58.encode(o.sign(msg)) };
  const { handlers } = harness(AUTH_MODE.DUAL_ACCEPT);
  const r = await call(handlers.register, req(body, secret));
  assert.equal(r._s, 400); assert.equal(r._j.code, 'invalid_request');
});
test('admin secret cannot authenticate a legacy registration', async () => {
  const o = owner(); const { handlers } = harness(AUTH_MODE.DUAL_ACCEPT);
  const r = await call(handlers.register, req(legacyReg(o), { 'x-dmv-admin-secret': LEGACY_SECRET }));
  assert.equal(r._s, 401); assert.deepEqual(r._j, { error: 'unauthorized' });
});

// ── Registration results ────────────────────────────────────────────────────
test('signed update returns 200 updated with new revision', async () => {
  const o = owner(); const { handlers } = harness(AUTH_MODE.DUAL_ACCEPT);
  await call(handlers.register, req(signedReg(o, { revision: 1, nonce: 'n1' })));
  const r = await call(handlers.register, req(signedReg(o, { revision: 2, nonce: 'n2' })));
  assert.equal(r._s, 200); assert.deepEqual(r._j, { ok: true, result: 'updated', revision: 2 });
});
test('replay (reused nonce) → 401 nonce_reused', async () => {
  const o = owner(); const { handlers } = harness(AUTH_MODE.DUAL_ACCEPT);
  await call(handlers.register, req(signedReg(o, { nonce: 'dup' })));
  const r = await call(handlers.register, req(signedReg(o, { nonce: 'dup', revision: 2 })));
  assert.equal(r._s, 401); assert.equal(r._j.code, 'nonce_reused');
});
test('stale revision → 409', async () => {
  const o = owner(); const { handlers } = harness(AUTH_MODE.DUAL_ACCEPT);
  await call(handlers.register, req(signedReg(o, { revision: 2, nonce: 'n1' })));
  const r = await call(handlers.register, req(signedReg(o, { revision: 1, nonce: 'n2' })));
  assert.equal(r._s, 409); assert.equal(r._j.code, 'stale_revision');
});
test('ownership failure → 403; transient dependency → 502; no nonce claimed', async () => {
  const o = owner();
  const denied = harness(AUTH_MODE.DUAL_ACCEPT, { verifyOwnership: async () => ({ ok: false, transient: false }) });
  const r1 = await call(denied.handlers.register, req(signedReg(o, { nonce: 'nA' })));
  assert.equal(r1._s, 403); assert.equal(r1._j.code, 'ownership_failed');
  assert.equal(nonceCount(denied.db, 'nA'), 0, 'no nonce claimed on ownership failure');

  const transient = harness(AUTH_MODE.DUAL_ACCEPT, { verifyOwnership: async () => ({ ok: false, transient: true }) });
  const r2 = await call(transient.handlers.register, req(signedReg(o, { nonce: 'nB' })));
  assert.equal(r2._s, 502); assert.equal(r2._j.code, 'dependency_unavailable');
  assert.equal(nonceCount(transient.db, 'nB'), 0, 'no nonce claimed on transient failure');
});
test('database failure → 503', async () => {
  const o = owner();
  const { handlers } = harness(AUTH_MODE.DUAL_ACCEPT, { applySignedRegistration: () => ({ ok: false, code: 'database_error' }) });
  const r = await call(handlers.register, req(signedReg(o)));
  assert.equal(r._s, 503); assert.equal(r._j.code, 'database_error');
});
test('legacy update of a signed row → 409 signed_authorization_required (no downgrade)', async () => {
  const o = owner(); const { handlers } = harness(AUTH_MODE.DUAL_ACCEPT);
  await call(handlers.register, req(signedReg(o))); // migrate to signed
  const r = await call(handlers.register, req(legacyReg(o, { deviceToken: 'HIJACKED-device-token' }), secret));
  assert.equal(r._s, 409); assert.equal(r._j.code, 'signed_authorization_required');
});

// ── Deregistration ──────────────────────────────────────────────────────────
test('signed deregistration of a live/stored vault → 200 removed=1; idempotent removed=0', async () => {
  const o = owner(); const { handlers } = harness(AUTH_MODE.DUAL_ACCEPT);
  await call(handlers.register, req(signedReg(o, { nonce: 'r1' })));
  const d1 = await call(handlers.deregister, req(signedDereg(o, { nonce: 'd1' })));
  assert.equal(d1._s, 200); assert.deepEqual(d1._j, { ok: true, removed: 1 });
  const d2 = await call(handlers.deregister, req(signedDereg(o, { nonce: 'd2' })));
  assert.deepEqual(d2._j, { ok: true, removed: 0 });
});
test('signed post-close deregistration (stored owner match) needs no RPC', async () => {
  const o = owner();
  let allow = true; // vault exists at register; "closed" (RPC would fail) at dereg
  const { handlers } = harness(AUTH_MODE.SIGNED_REQUIRED, { verifyOwnership: async () => (allow ? { ok: true } : { ok: false, transient: false }) });
  await call(handlers.register, req(signedReg(o, { nonce: 'r1' })));
  allow = false;
  const d = await call(handlers.deregister, req(signedDereg(o, { nonce: 'd1' })));
  assert.equal(d._s, 200); assert.equal(d._j.removed, 1);
});
test('signed deregistration owner mismatch → 409 owner_conflict', async () => {
  const o1 = owner(); const o2 = owner();
  const { db, handlers } = harness(AUTH_MODE.DUAL_ACCEPT);
  // seed a row for o1's vault owned by o1
  await call(handlers.register, req(signedReg(o1, { nonce: 'r1' })));
  // o2 signs a dereg for o1's vault (context ok, sig by o2, PDA(o2)!=o1 vault → invalid_request actually)
  // Use the stored-owner-mismatch path: craft a dereg where vault has a stored owner != signer.
  // Simplest: o2 deregisters their OWN vault but we pre-seed that vault owned by o1.
  const o2vault = deriveVaultPda(o2.owner, PID);
  db.prepare("INSERT INTO registrations (vault,owner,device_token,stage1,stage2,stage3,last_stage,last_notified_at,created_at,updated_at,auth_version,registration_revision,migration_status) VALUES (?,?,?,1,2,3,0,0,1,1,1,0,'legacy')").run(o2vault, o1.owner, 'tk');
  const d = await call(handlers.deregister, req(signedDereg(o2, { nonce: 'd1' })));
  assert.equal(d._s, 409); assert.equal(d._j.code, 'owner_conflict');
});
test('pure legacy deregistration of a legacy row (dual, specific vault) → 200 removed', async () => {
  const o = owner(); const { handlers } = harness(AUTH_MODE.DUAL_ACCEPT);
  await call(handlers.register, req(legacyReg(o), secret));
  const d = await call(handlers.deregister, req({ vault: deriveVaultPda(o.owner, PID) }, secret));
  assert.equal(d._s, 200); assert.equal(d._j.removed, 1);
});
test('pure legacy deletion of a signed row → 409 signed_authorization_required', async () => {
  const o = owner(); const { handlers } = harness(AUTH_MODE.DUAL_ACCEPT);
  await call(handlers.register, req(signedReg(o)));
  const d = await call(handlers.deregister, req({ vault: deriveVaultPda(o.owner, PID) }, secret));
  assert.equal(d._s, 409); assert.equal(d._j.code, 'signed_authorization_required');
});
test('owner-wide legacy deregistration is DISABLED in dual mode → 400', async () => {
  const o = owner(); const { handlers } = harness(AUTH_MODE.DUAL_ACCEPT);
  const d = await call(handlers.deregister, req({ owner: o.owner }, secret));
  assert.equal(d._s, 400);
});
test('owner-wide legacy deregistration is retained in dev legacy mode', async () => {
  const o = owner(); const { db, handlers } = harness(AUTH_MODE.LEGACY_ONLY);
  await call(handlers.register, req(legacyReg(o), secret));
  const d = await call(handlers.deregister, req({ owner: o.owner }, secret));
  assert.equal(d._s, 200);
  assert.equal(getRegistrationCount(db), 0);
});
test('owner-wide legacy deregistration (dev) does NOT delete a signed row (stickiness holds)', async () => {
  const o = owner(); const { db, handlers } = harness(AUTH_MODE.LEGACY_ONLY);
  const vault = deriveVaultPda(o.owner, PID);
  // Seed a signed row directly (LEGACY_ONLY rejects a signed attempt at the handler).
  const cmd = {
    owner: o.owner, vault, deviceToken: TOKEN, deviceTokenHash: sha256Hex(TOKEN),
    stage1: 1, stage2: 2, stage3: 3, revision: 1, signedAt: NOW, nonce: vn('seed'), nonceUsedAt: NOW, authVersion: 2,
  };
  assert.equal(storeSignedReg(db, cmd).code, 'created');
  const d = await call(handlers.deregister, req({ owner: o.owner }, secret));
  assert.equal(d._s, 200);
  assert.equal(d._j.removed, 0, 'signed row not force-deleted');
  assert.equal(getRegistrationCount(db), 1, 'signed row survives owner-wide legacy delete');
});

function getRegistrationCount(db) { return db.prepare('SELECT COUNT(*) AS n FROM registrations').get().n; }
function nonceCount(db, nonce) { return db.prepare('SELECT COUNT(*) AS n FROM used_nonces WHERE nonce=?').get(nonce).n; }
