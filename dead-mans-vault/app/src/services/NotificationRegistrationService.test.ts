// WP5 coordinator + revision + mapping tests. Real WP1 builder + real Ed25519 keys;
// all I/O mocked. No wallet, no network, no expo/RN. `node --test` compatible.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import bs58 from 'bs58';
import { PublicKey } from '@solana/web3.js';
import { registerMessageV2, deregisterMessageV2, generateNonceV2 } from '../utils/notifyAuth.ts';
import {
  attemptSignedRegistration,
  attemptSignedDeregistration,
  computeNextRevision,
  revisionKey,
  successKey,
  mapRegistrationError,
  mapStatusToCode,
  mapDeregisterError,
  mapDeregisterStatusToCode,
} from './NotificationRegistrationService.ts';

const PROGRAM = 'GXCu5964mvgAJDWmcMriZpzU3vDVqPzjYCM1sxCnsoEb';
const CLUSTER = 'devnet';
const TOKEN = 'fMockFCMToken-0123456789abcdefghijklmnopqrstuvwxyz';
const NOW_MS = 1784500000000;
const NOW_SEC = 1784500000;

function makeOwner() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return { owner: bs58.encode(raw), sign: (m: Uint8Array) => new Uint8Array(crypto.sign(null, Buffer.from(m), privateKey)) };
}
const deriveVault = (owner: string) =>
  PublicKey.findProgramAddressSync([Buffer.from('vault'), new PublicKey(owner).toBuffer()], new PublicKey(PROGRAM))[0].toBase58();
const sha256Hex = async (t: string) => crypto.createHash('sha256').update(t, 'utf8').digest('hex');
const ED_SPKI = Buffer.from('302a300506032b6570032100', 'hex');
function verifyEd(msg: string, sig: Uint8Array, ownerBase58: string): boolean {
  try {
    const pub = crypto.createPublicKey({ key: Buffer.concat([ED_SPKI, Buffer.from(bs58.decode(ownerBase58))]), format: 'der', type: 'spki' });
    return crypto.verify(null, Buffer.from(msg, 'utf8'), pub, Buffer.from(sig));
  } catch {
    return false;
  }
}

type Over = Partial<Record<string, unknown>>;
function harness(o: makeOwnerT, over: Over = {}) {
  const store = new Map<string, string>();
  const order: string[] = [];
  const spies = { signMessage: 0, postRegister: 0, getDeviceToken: 0, setSettingRevision: 0, setSettingSuccess: 0 };
  const deps: any = {
    cluster: over.cluster ?? CLUSTER,
    programId: over.programId ?? PROGRAM,
    deriveVault: over.deriveVault ?? deriveVault,
    getDeviceToken: over.getDeviceToken ?? (async () => { spies.getDeviceToken++; return TOKEN; }),
    getSetting: async (k: string) => store.get(k) ?? null,
    setSetting: over.setSetting ?? (async (k: string, v: string) => { store.set(k, v); order.push('set:' + (k.startsWith('notif_rev') ? 'rev' : 'success')); if (k.startsWith('notif_rev')) spies.setSettingRevision++; else spies.setSettingSuccess++; }),
    signMessage: over.signMessage ?? (async (bytes: Uint8Array) => { spies.signMessage++; order.push('sign'); return o.sign(bytes); }),
    buildRegisterMessage: registerMessageV2,
    generateNonce: over.generateNonce ?? generateNonceV2,
    sha256Hex: over.sha256Hex ?? sha256Hex,
    postRegister: over.postRegister ?? (async () => { spies.postRegister++; order.push('post'); return { status: 201 }; }),
    nowSec: over.nowSec ?? (() => NOW_SEC),
    nowMs: over.nowMs ?? (() => NOW_MS),
  };
  return { deps, store, spies, order };
}
type makeOwnerT = ReturnType<typeof makeOwner>;
const stages = { stage1: 259200, stage2: 604800, stage3: 604800 };
const run = (o: makeOwnerT, over: Over = {}) => {
  const h = harness(o, over);
  return attemptSignedRegistration({ owner: o.owner, stages }, h.deps).then((r) => ({ r, ...h }));
};

// ── computeNextRevision (pure) ──────────────────────────────────────────────
test('revision: first uses nowMs', () => assert.equal(computeNextRevision(null, NOW_MS), NOW_MS));
test('revision: later is strictly higher', () => assert.ok(computeNextRevision(String(NOW_MS), NOW_MS + 5) > NOW_MS));
test('revision: same-ms increases (watermark+1)', () => assert.equal(computeNextRevision(String(NOW_MS), NOW_MS), NOW_MS + 1));
test('revision: backward clock does not reduce below stored', () => assert.equal(computeNextRevision(String(NOW_MS), NOW_MS - 10000), NOW_MS + 1));
test('revision: corrupt stored fails closed', () => {
  for (const bad of ['abc', '-1', '1.5', '0', ' 12', '01', '99999999999999999999']) assert.throws(() => computeNextRevision(bad, NOW_MS));
});
test('revision: invalid clock fails closed', () => assert.throws(() => computeNextRevision(null, 1.5)));
test('revisionKey/successKey are namespaced by cluster+program+owner+vault', () => {
  const k = { cluster: 'devnet', programId: PROGRAM, owner: 'O', vault: 'V' };
  assert.equal(revisionKey(k), 'notif_rev/devnet/' + PROGRAM + '/O/V');
  assert.equal(successKey(k), 'notif_signed_reg/devnet/' + PROGRAM + '/O/V');
});

// ── V2 request construction ─────────────────────────────────────────────────
test('valid attempt builds a correct V2 body, signs the exact WP1 bytes, sends no secret', async () => {
  const o = makeOwner();
  let sentBody: any = null;
  const { r, spies } = await run(o, { postRegister: async (b: any) => { sentBody = b; return { status: 201 }; } });
  assert.equal(r.ok, true);
  assert.equal(spies.signMessage, 1);
  // body shape
  assert.equal(sentBody.version, 2);
  assert.equal(sentBody.cluster, 'devnet');
  assert.equal(sentBody.programId, PROGRAM);
  assert.equal(sentBody.audience, 'https://notify.palatinearc.com');
  assert.equal(sentBody.action, 'register');
  assert.equal(sentBody.owner, o.owner);
  assert.equal(sentBody.vault, deriveVault(o.owner));
  assert.equal(sentBody.deviceToken, TOKEN);
  assert.equal(typeof sentBody.timestamp, 'number');
  assert.ok(/^[1-9A-HJ-NP-Za-km-z]{22,64}$/.test(sentBody.nonce));
  // NO shared secret / token hash field
  assert.equal('x-dmv-secret' in sentBody, false);
  assert.equal('x-dmv-admin-secret' in sentBody, false);
  assert.equal('deviceTokenHash' in sentBody, false);
  // signature is a valid 64-byte detached Ed25519 over the exact WP1 message
  const sig = bs58.decode(sentBody.signature);
  assert.equal(sig.length, 64);
  const msg = registerMessageV2({
    cluster: 'devnet', programId: PROGRAM, owner: sentBody.owner, vault: sentBody.vault,
    deviceTokenHash: await sha256Hex(TOKEN), stage1: sentBody.stage1, stage2: sentBody.stage2, stage3: sentBody.stage3,
    revision: sentBody.revision, timestamp: sentBody.timestamp, nonce: sentBody.nonce,
  });
  assert.equal(msg.endsWith('\n'), false);
  assert.equal(verifyEd(msg, sig, o.owner), true);
});

// ── revision persistence order ──────────────────────────────────────────────
test('the revision high-watermark is persisted BEFORE the request', async () => {
  const o = makeOwner();
  const { r, order } = await run(o);
  assert.equal(r.ok, true);
  assert.ok(order.indexOf('set:rev') < order.indexOf('post'), 'revision persisted before post');
  assert.ok(order.indexOf('set:rev') < order.indexOf('sign'), 'revision persisted before signing');
});
test('a failed request does not lower the persisted high-watermark', async () => {
  const o = makeOwner();
  const { store } = await run(o, { postRegister: async () => ({ status: 503 }) });
  const rk = revisionKey({ cluster: CLUSTER, programId: PROGRAM, owner: o.owner, vault: deriveVault(o.owner) });
  assert.equal(store.get(rk), String(NOW_MS)); // persisted, not reduced
});
test('a manual retry allocates a strictly higher revision', async () => {
  const o = makeOwner();
  const h = harness(o);
  const rk = revisionKey({ cluster: CLUSTER, programId: PROGRAM, owner: o.owner, vault: deriveVault(o.owner) });
  await attemptSignedRegistration({ owner: o.owner, stages }, { ...h.deps, nowMs: () => NOW_MS });
  const first = Number(h.store.get(rk));
  await attemptSignedRegistration({ owner: o.owner, stages }, { ...h.deps, nowMs: () => NOW_MS }); // same ms
  const second = Number(h.store.get(rk));
  assert.ok(second > first);
});

// ── deliberate flow / fail-closed / no fallback ─────────────────────────────
test('valid flow makes exactly one signature and one request', async () => {
  const o = makeOwner();
  const { r, spies } = await run(o);
  assert.equal(r.ok, true);
  assert.equal(spies.signMessage, 1);
  assert.equal(spies.postRegister, 1);
});
test('wallet cancel/reject → no request, no fallback', async () => {
  const o = makeOwner();
  const { r, spies } = await run(o, { signMessage: async () => { throw new Error('user rejected'); } });
  assert.equal(r.ok, false); assert.equal((r as any).stage, 'wallet'); assert.equal((r as any).retryable, true);
  assert.equal(spies.postRegister, 0);
});
test('signature of wrong length → fail, no request', async () => {
  const o = makeOwner();
  for (const len of [63, 65]) {
    const { r, spies } = await run(o, { signMessage: async () => new Uint8Array(len) });
    assert.equal((r as any).stage, 'signature'); assert.equal(spies.postRegister, 0);
  }
});
test('secure-RNG unavailable → no signing', async () => {
  const o = makeOwner();
  const { r, spies } = await run(o, { generateNonce: () => { throw new Error('no rng'); } });
  assert.equal((r as any).stage, 'rng'); assert.equal(spies.signMessage, 0);
});
test('device-token acquisition failure → no signing', async () => {
  const o = makeOwner();
  const { r, spies } = await run(o, { getDeviceToken: async () => null });
  assert.equal((r as any).stage, 'device_token'); assert.equal(spies.signMessage, 0);
});
test('cluster / program mismatch fails BEFORE signing', async () => {
  const o = makeOwner();
  const a = await run(o, { cluster: 'mainnet-beta' });
  assert.equal((a.r as any).stage, 'context'); assert.equal(a.spies.signMessage, 0);
  const b = await run(o, { programId: '11111111111111111111111111111111' });
  assert.equal((b.r as any).stage, 'context'); assert.equal(b.spies.signMessage, 0);
});
test('non-canonical owner fails before signing', async () => {
  const { r, spies } = await run({ owner: 'not-a-pubkey', sign: () => new Uint8Array(64) } as any);
  assert.equal((r as any).stage, 'validate'); assert.equal(spies.signMessage, 0);
});
test('repeated concurrent taps send exactly one request (in-flight guard)', async () => {
  const o = makeOwner();
  const h = harness(o);
  const [a, b] = await Promise.all([
    attemptSignedRegistration({ owner: o.owner, stages }, h.deps),
    attemptSignedRegistration({ owner: o.owner, stages }, h.deps),
  ]);
  const inflight = [a, b].filter((x) => !x.ok && (x as any).stage === 'in_flight');
  assert.equal(inflight.length, 1);
  assert.equal(h.spies.postRegister, 1);
});
test('network error → dependency_unavailable, no auto-retry (one request attempt)', async () => {
  const o = makeOwner();
  let calls = 0;
  const { r } = await run(o, { postRegister: async () => { calls++; throw new Error('ECONNRESET'); } });
  assert.equal((r as any).code, 'dependency_unavailable'); assert.equal((r as any).retryable, true);
  assert.equal(calls, 1);
});

// ── server responses ────────────────────────────────────────────────────────
test('201 → created, 200 → updated', async () => {
  const o1 = makeOwner(); const c = await run(o1, { postRegister: async () => ({ status: 201 }) });
  assert.deepEqual({ ok: (c.r as any).ok, result: (c.r as any).result }, { ok: true, result: 'created' });
  const o2 = makeOwner(); const u = await run(o2, { postRegister: async () => ({ status: 200 }) });
  assert.equal((u.r as any).result, 'updated');
});
for (const [status, code] of [[401, 'invalid_signature'], [401, 'stale_timestamp'], [401, 'context_mismatch'], [401, 'nonce_reused'], [409, 'stale_revision'], [409, 'owner_conflict'], [429, 'rate_limited'], [502, 'dependency_unavailable'], [503, 'database_error'], [410, 'legacy_window_expired']] as [number, string][]) {
  test(`server ${status}/${code} → failed with code ${code}`, async () => {
    const o = makeOwner();
    const { r } = await run(o, { postRegister: async () => ({ status, code }) });
    assert.equal((r as any).ok, false); assert.equal((r as any).code, code);
  });
}
test('stale_revision is retryable and preserves the watermark', async () => {
  const o = makeOwner();
  const { r, store } = await run(o, { postRegister: async () => ({ status: 409, code: 'stale_revision' }) });
  assert.equal((r as any).retryable, true);
  const rk = revisionKey({ cluster: CLUSTER, programId: PROGRAM, owner: o.owner, vault: deriveVault(o.owner) });
  assert.equal(store.get(rk), String(NOW_MS));
});
test('unknown/unexpected status fails closed', async () => {
  const o = makeOwner();
  const { r } = await run(o, { postRegister: async () => ({ status: 418 }) });
  assert.equal((r as any).ok, false); assert.equal((r as any).code, 'unknown'); assert.equal((r as any).retryable, false);
});

// ── local success state ─────────────────────────────────────────────────────
test('success record persisted only after 201/200, with no plaintext token/sig/nonce/message', async () => {
  const o = makeOwner();
  const { r, store, spies } = await run(o);
  assert.equal(r.ok, true);
  assert.equal(spies.setSettingSuccess, 1);
  const sk = successKey({ cluster: CLUSTER, programId: PROGRAM, owner: o.owner, vault: deriveVault(o.owner) });
  const rec = JSON.parse(store.get(sk)!);
  assert.equal(rec.authVersion, 2);
  assert.equal(typeof rec.revision, 'number');
  assert.match(rec.tokenFingerprint, /^[0-9a-f]{32}$/); // WP6: 128-bit fingerprint
  assert.equal(rec.cluster, 'devnet'); assert.equal(rec.programId, PROGRAM);
  const j = store.get(sk)!;
  assert.equal(j.includes(TOKEN), false, 'no plaintext device token');
  assert.equal(/"signature"|"nonce"|DMV_NOTIFY_REGISTER/.test(j), false, 'no signature/nonce/message');
});
test('failure persists no success record', async () => {
  const o = makeOwner();
  const { spies } = await run(o, { postRegister: async () => ({ status: 401, code: 'invalid_signature' }) });
  assert.equal(spies.setSettingSuccess, 0);
});

// ── mapping helpers ─────────────────────────────────────────────────────────
test('mapStatusToCode covers the mapped statuses', () => {
  assert.equal(mapStatusToCode(400), 'invalid_request');
  assert.equal(mapStatusToCode(403), 'ownership_failed');
  assert.equal(mapStatusToCode(429), 'rate_limited');
  assert.equal(mapStatusToCode(502), 'dependency_unavailable');
  assert.equal(mapStatusToCode(503), 'database_error');
  assert.equal(mapStatusToCode(410), 'legacy_window_expired');
  assert.equal(mapStatusToCode(418), 'unknown');
});
test('mapRegistrationError returns a non-empty message + correct retryability', () => {
  for (const code of ['invalid_request', 'invalid_signature', 'stale_timestamp', 'context_mismatch', 'nonce_reused', 'ownership_failed', 'stale_revision', 'owner_conflict', 'rate_limited', 'dependency_unavailable', 'database_error', 'legacy_window_expired', 'weird_unknown']) {
    const m = mapRegistrationError(code);
    assert.ok(m.message.length > 0);
  }
  assert.equal(mapRegistrationError('rate_limited').retryable, true);
  assert.equal(mapRegistrationError('stale_revision').retryable, true);
  assert.equal(mapRegistrationError('dependency_unavailable').retryable, true);
  assert.equal(mapRegistrationError('database_error').retryable, true);
  assert.equal(mapRegistrationError('invalid_signature').retryable, false);
  assert.equal(mapRegistrationError('context_mismatch').retryable, false);
  assert.equal(mapRegistrationError('weird_unknown').retryable, false);
});

// ── Runtime-robustness (WP5 review HIGH + MEDIUM) ───────────────────────────
test('review HIGH: signs via Buffer, not TextEncoder — a missing global TextEncoder does not break or masquerade as a wallet cancel', async () => {
  const saved = (globalThis as any).TextEncoder;
  try {
    delete (globalThis as any).TextEncoder; // simulate a Hermes runtime without TextEncoder
    const { r, spies } = await run(makeOwner());
    assert.equal(r.ok, true, 'flow completes without TextEncoder (Buffer path)');
    assert.equal(spies.signMessage, 1);
    assert.equal(spies.postRegister, 1);
  } finally {
    if (saved) (globalThis as any).TextEncoder = saved;
  }
});
test('review MEDIUM: a rejecting sha256Hex returns a discrete failure stage, never a thrown rejection', async () => {
  const { r, spies } = await run(makeOwner(), { sha256Hex: async () => { throw new Error('crypto unavailable'); } });
  assert.equal(r.ok, false);
  assert.equal((r as any).stage, 'hash');
  assert.equal(spies.signMessage, 0, 'no signature attempted when the token hash fails');
  assert.equal(spies.postRegister, 0);
});
test('review LOW-1: server 201 + a failing success-record write still reports success (server truth wins, not a false failure)', async () => {
  // The registration is accepted server-side; a best-effort local-cache write failure
  // must NOT be reported as a failed registration (that would flip the UI to "failed"
  // and re-add duplicate local warnings). The revision write still succeeds.
  const o = makeOwner();
  let successWriteAttempted = false;
  const { r, spies } = await run(o, {
    setSetting: async (k: string) => {
      if (k.startsWith('notif_signed_reg')) { successWriteAttempted = true; throw new Error('sqlite write failed'); }
      // revision key persists normally
    },
  });
  assert.equal(r.ok, true, 'accepted server registration reported as success despite cache-write failure');
  assert.equal((r as any).result, 'created');
  assert.equal(successWriteAttempted, true, 'the success-record write was attempted');
  assert.equal(spies.postRegister, 1, 'exactly one server request');
});

// ── WP6: signed deregistration ───────────────────────────────────────────────
function deregHarness(o: makeOwnerT, over: Over = {}) {
  const key = { cluster: CLUSTER, programId: PROGRAM, owner: o.owner, vault: deriveVault(o.owner) };
  const store = new Map<string, string>();
  if (over.seedRecord !== undefined) store.set(successKey(key), over.seedRecord as string);
  if (over.seedRevision !== undefined) store.set(revisionKey(key), over.seedRevision as string);
  const spies = { signMessage: 0, postDeregister: 0 };
  const sent: { body: any } = { body: null };
  const deps: any = {
    cluster: over.cluster ?? CLUSTER,
    programId: over.programId ?? PROGRAM,
    deriveVault: over.deriveVault ?? deriveVault,
    getSetting: over.getSetting ?? (async (k: string) => store.get(k) ?? null),
    setSetting: over.setSetting ?? (async (k: string, v: string) => { store.set(k, v); }),
    signMessage: over.signMessage ?? (async (bytes: Uint8Array) => { spies.signMessage++; return o.sign(bytes); }),
    buildDeregisterMessage: deregisterMessageV2,
    generateNonce: over.generateNonce ?? generateNonceV2,
    postDeregister: over.postDeregister ?? (async (b: any) => { spies.postDeregister++; sent.body = b; return { status: 200, removed: 1 }; }),
    nowSec: over.nowSec ?? (() => NOW_SEC),
  };
  return { deps, store, spies, sent, key };
}
const runDereg = (o: makeOwnerT, over: Over = {}) => {
  const h = deregHarness(o, over);
  return attemptSignedDeregistration({ owner: o.owner }, h.deps).then((r) => ({ r, ...h }));
};

test('deregister: exact V2 bytes, one signature, canonical envelope, no token/hash/stages/revision/secret', async () => {
  const o = makeOwner();
  const { r, sent, spies } = await runDereg(o);
  assert.equal(r.ok, true);
  assert.equal(spies.signMessage, 1);
  assert.equal(spies.postDeregister, 1);
  const b = sent.body;
  assert.equal(b.version, 2);
  assert.equal(b.action, 'deregister');
  assert.equal(b.cluster, 'devnet');
  assert.equal(b.programId, PROGRAM);
  assert.equal(b.audience, 'https://notify.palatinearc.com');
  assert.equal(b.owner, o.owner);
  assert.equal(b.vault, deriveVault(o.owner));
  for (const f of ['deviceToken', 'deviceTokenHash', 'stage1', 'stage2', 'stage3', 'revision', 'x-dmv-secret', 'x-dmv-admin-secret']) {
    assert.equal(f in b, false, `body must not contain ${f}`);
  }
  const msg = deregisterMessageV2({ cluster: 'devnet', programId: PROGRAM, owner: o.owner, vault: deriveVault(o.owner), timestamp: NOW_SEC, nonce: b.nonce });
  assert.equal(msg.endsWith('\n'), false, 'no trailing newline');
  assert.equal(verifyEd(msg, bs58.decode(b.signature), o.owner), true, '64-byte detached sig over the exact bytes verifies');
});
test('deregister: signs via Buffer even without a global TextEncoder (Hermes-safe)', async () => {
  const saved = (globalThis as any).TextEncoder;
  try {
    delete (globalThis as any).TextEncoder;
    const { r, spies } = await runDereg(makeOwner());
    assert.equal(r.ok, true);
    assert.equal(spies.signMessage, 1);
  } finally {
    if (saved) (globalThis as any).TextEncoder = saved;
  }
});
test('deregister: removed=1 → success', async () => {
  const { r } = await runDereg(makeOwner(), { postDeregister: async () => ({ status: 200, removed: 1 }) });
  assert.equal(r.ok, true); assert.equal((r as any).removed, 1);
});
test('deregister: removed=0 (idempotent, nothing to remove) → success, not an error', async () => {
  const { r } = await runDereg(makeOwner(), { postDeregister: async () => ({ status: 200, removed: 0 }) });
  assert.equal(r.ok, true); assert.equal((r as any).removed, 0);
});
test('deregister: wallet cancellation sends no request', async () => {
  const { r, spies } = await runDereg(makeOwner(), { signMessage: async () => { throw new Error('user rejected'); } });
  assert.equal(r.ok, false); assert.equal((r as any).stage, 'wallet');
  assert.equal(spies.postDeregister, 0);
});
test('deregister: a stored record owned by a DIFFERENT owner fails BEFORE the wallet (no owner-wide delete)', async () => {
  const o = makeOwner();
  const other = makeOwner();
  const record = JSON.stringify({ owner: other.owner, vault: deriveVault(o.owner), cluster: CLUSTER, programId: PROGRAM });
  const { r, spies } = await runDereg(o, { seedRecord: record });
  assert.equal(r.ok, false); assert.equal((r as any).stage, 'owner_mismatch');
  assert.equal(spies.signMessage, 0);
  assert.equal(spies.postDeregister, 0);
});
test('deregister: post-close with a stored record needs no live vault read (coordinator never touches chain)', async () => {
  const o = makeOwner();
  const record = JSON.stringify({ owner: o.owner, vault: deriveVault(o.owner), revision: 5000, tokenFingerprint: 'a'.repeat(32), cluster: CLUSTER, programId: PROGRAM });
  const { r } = await runDereg(o, { seedRecord: record, postDeregister: async () => ({ status: 200, removed: 1 }) });
  assert.equal(r.ok, true);
});
test('deregister: no local record → idempotent removed=0 success', async () => {
  const { r } = await runDereg(makeOwner(), { postDeregister: async () => ({ status: 200, removed: 0 }) });
  assert.equal(r.ok, true); assert.equal((r as any).removed, 0);
});
test('deregister (review LOW-3): no local record + removed=0 writes NO tombstone (does not overstate a removal)', async () => {
  const o = makeOwner();
  const key = { cluster: CLUSTER, programId: PROGRAM, owner: o.owner, vault: deriveVault(o.owner) };
  const { r, store } = await runDereg(o, { postDeregister: async () => ({ status: 200, removed: 0 }) });
  assert.equal(r.ok, true); assert.equal((r as any).removed, 0);
  assert.equal(store.get(successKey(key)), undefined, 'a pure no-op leaves local state untouched');
});
test('deregister: removed=1 with no prior record still tombstones (the server removed a row)', async () => {
  const o = makeOwner();
  const key = { cluster: CLUSTER, programId: PROGRAM, owner: o.owner, vault: deriveVault(o.owner) };
  const { r, store } = await runDereg(o, { postDeregister: async () => ({ status: 200, removed: 1 }) });
  assert.equal(r.ok, true);
  assert.ok(JSON.parse(store.get(successKey(key))!).deregisteredAt > 0);
});
test('deregister: success tombstones the local record and PRESERVES the revision watermark', async () => {
  const o = makeOwner();
  const key = { cluster: CLUSTER, programId: PROGRAM, owner: o.owner, vault: deriveVault(o.owner) };
  const record = JSON.stringify({ owner: o.owner, vault: key.vault, revision: 7777, tokenFingerprint: 'b'.repeat(32), cluster: CLUSTER, programId: PROGRAM });
  const { r, store } = await runDereg(o, { seedRecord: record, seedRevision: '7777', postDeregister: async () => ({ status: 200, removed: 1 }) });
  assert.equal(r.ok, true);
  const tomb = JSON.parse(store.get(successKey(key))!);
  assert.ok(tomb.deregisteredAt > 0, 'confirmed record tombstoned');
  assert.equal('tokenFingerprint' in tomb, false, 'fingerprint dropped from tombstone');
  assert.equal(store.get(revisionKey(key)), '7777', 'revision high-watermark preserved, not deleted/lowered');
});
test('deregister: a local-cleanup write failure after server success → success + localCleanupPending (server truth wins)', async () => {
  const { r } = await runDereg(makeOwner(), {
    postDeregister: async () => ({ status: 200, removed: 1 }),
    setSetting: async (k: string) => { if (k.startsWith('notif_signed_reg')) throw new Error('sqlite write failed'); },
  });
  assert.equal(r.ok, true);
  assert.equal((r as any).localCleanupPending, true);
});
test('deregister: network error → dependency_unavailable, exactly one attempt (no auto-retry)', async () => {
  let calls = 0;
  const { r } = await runDereg(makeOwner(), { postDeregister: async () => { calls++; throw new Error('ECONNRESET'); } });
  assert.equal(r.ok, false); assert.equal((r as any).code, 'dependency_unavailable'); assert.equal((r as any).retryable, true);
  assert.equal(calls, 1);
});
test('deregister: rate_limited is NOT auto-retried (one request)', async () => {
  let calls = 0;
  const { r } = await runDereg(makeOwner(), { postDeregister: async () => { calls++; return { status: 429, code: 'rate_limited' }; } });
  assert.equal(r.ok, false); assert.equal((r as any).code, 'rate_limited');
  assert.equal(calls, 1);
});
test('deregister: server owner_conflict (409) → mapped error, local record NOT tombstoned', async () => {
  const o = makeOwner();
  const key = { cluster: CLUSTER, programId: PROGRAM, owner: o.owner, vault: deriveVault(o.owner) };
  const record = JSON.stringify({ owner: o.owner, vault: key.vault, revision: 1, tokenFingerprint: 'c'.repeat(32), cluster: CLUSTER, programId: PROGRAM });
  const { r, store } = await runDereg(o, { seedRecord: record, postDeregister: async () => ({ status: 409, code: 'owner_conflict' }) });
  assert.equal(r.ok, false); assert.equal((r as any).code, 'owner_conflict');
  assert.equal(JSON.parse(store.get(successKey(key))!).deregisteredAt, undefined, 'not tombstoned on a rejected deregister');
});
test('deregister: repeated concurrent taps → one request (single-flight)', async () => {
  const o = makeOwner();
  const h = deregHarness(o);
  const [a, b] = await Promise.all([
    attemptSignedDeregistration({ owner: o.owner }, h.deps),
    attemptSignedDeregistration({ owner: o.owner }, h.deps),
  ]);
  assert.equal([a, b].filter((x) => !x.ok && (x as any).stage === 'in_flight').length, 1);
  assert.equal(h.spies.postDeregister, 1);
});
test('deregister mapping: stale_revision/legacy_window_expired = server inconsistency; rate_limited retryable', () => {
  assert.equal(mapDeregisterError('stale_revision').retryable, false);
  assert.equal(mapDeregisterError('legacy_window_expired').retryable, false);
  assert.equal(mapDeregisterError('rate_limited').retryable, true);
  assert.equal(mapDeregisterError('owner_conflict').retryable, false);
  assert.equal(mapDeregisterStatusToCode(403), 'ownership_failed');
  assert.equal(mapDeregisterStatusToCode(409), 'owner_conflict');
});
test('rotation: a successful register records the ACCEPTED token fingerprint + revision (race handled by reconcile at the lifecycle layer)', async () => {
  const o = makeOwner();
  const { r, store } = await run(o);
  assert.equal(r.ok, true);
  const key = { cluster: CLUSTER, programId: PROGRAM, owner: o.owner, vault: deriveVault(o.owner) };
  const rec = JSON.parse(store.get(successKey(key))!);
  assert.equal(rec.tokenFingerprint, (await sha256Hex(TOKEN)).slice(0, 32), 'record carries the accepted token fingerprint');
  assert.equal(rec.revision, (r as any).revision, 'record carries the accepted revision (preserved for the race compare)');
});
