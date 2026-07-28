// WP6 — token lifecycle: reconcile (pure), local-only observer, and the
// identity-scoped operation lock. All mocked; `node --test` compatible. Proves the
// observer NEVER signs or mutates the server, and that the operation lock enforces
// mutual exclusion of register/update/deregister per identity.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import {
  tokenFingerprint,
  isLegacyFingerprint,
  reconcile,
  makeTokenObserver,
  pendingKey,
  runExclusive,
  isOperationActive,
  operationIdentity,
} from './notificationLifecycle.ts';
import { successKey, deregPendingKey, closedVaultKey } from './NotificationRegistrationService.ts';

const PROGRAM = 'GXCu5964mvgAJDWmcMriZpzU3vDVqPzjYCM1sxCnsoEb';
const CLUSTER = 'devnet';
const OWNER = 'DX5qF21LFK67wjfEAw1idZm9eRyrqKDSjFBVUxZdUunM';
const TOKEN_A = 'fMockFCMToken-AAAA0123456789abcdefghijklmnopqrstuvwxyz';
const TOKEN_B = 'fMockFCMToken-BBBB0123456789abcdefghijklmnopqrstuvwxyz';

const sha = (t: string) => crypto.createHash('sha256').update(t, 'utf8').digest('hex');
const sha256Hex = async (t: string) => sha(t);
const deriveVault = (owner: string) =>
  PublicKey.findProgramAddressSync([Buffer.from('vault'), new PublicKey(owner).toBuffer()], new PublicKey(PROGRAM))[0].toBase58();
const VAULT = deriveVault(OWNER);
const KEY = { cluster: CLUSTER, programId: PROGRAM, owner: OWNER, vault: VAULT };
const fpA = tokenFingerprint(sha(TOKEN_A));
const fpB = tokenFingerprint(sha(TOKEN_B));

function confirmedRecord(fingerprint: string) {
  return JSON.stringify({ owner: OWNER, vault: VAULT, revision: 1000, tokenFingerprint: fingerprint, cluster: CLUSTER, programId: PROGRAM });
}

// ── fingerprint ──────────────────────────────────────────────────────────────
test('tokenFingerprint is 32 lowercase hex (128-bit)', () => {
  assert.match(fpA, /^[0-9a-f]{32}$/);
  assert.equal(fpA, sha(TOKEN_A).slice(0, 32));
});
test('isLegacyFingerprint detects a 16-char WP5 fingerprint', () => {
  assert.equal(isLegacyFingerprint(sha(TOKEN_A).slice(0, 16)), true);
  assert.equal(isLegacyFingerprint(fpA), false);
});

// ── reconcile (pure) ─────────────────────────────────────────────────────────
test('reconcile: no record → not_enabled', () => {
  assert.equal(reconcile({ record: null, currentTokenHashHex: sha(TOKEN_A), connectedOwner: OWNER }).state, 'not_enabled');
});
test('reconcile: matching 128-bit fingerprint → enabled', () => {
  const rec = { owner: OWNER, vault: VAULT, tokenFingerprint: fpA, cluster: CLUSTER, programId: PROGRAM };
  assert.equal(reconcile({ record: rec, currentTokenHashHex: sha(TOKEN_A), connectedOwner: OWNER }).state, 'enabled');
});
test('reconcile: changed token → update_required', () => {
  const rec = { owner: OWNER, vault: VAULT, tokenFingerprint: fpA, cluster: CLUSTER, programId: PROGRAM };
  const r = reconcile({ record: rec, currentTokenHashHex: sha(TOKEN_B), connectedOwner: OWNER });
  assert.equal(r.state, 'update_required');
  assert.equal(r.fingerprint, fpB);
});
test('reconcile: legacy 16-char fingerprint → update_required (never claims confirmed)', () => {
  const rec = { owner: OWNER, vault: VAULT, tokenFingerprint: sha(TOKEN_A).slice(0, 16), cluster: CLUSTER, programId: PROGRAM };
  // even though the current token matches the 16-char prefix, a signed refresh is required
  assert.equal(reconcile({ record: rec, currentTokenHashHex: sha(TOKEN_A), connectedOwner: OWNER }).state, 'update_required');
});
test('reconcile: token unavailable → token_unavailable (record preserved)', () => {
  const rec = { owner: OWNER, vault: VAULT, tokenFingerprint: fpA, cluster: CLUSTER, programId: PROGRAM };
  assert.equal(reconcile({ record: rec, currentTokenHashHex: null, connectedOwner: OWNER }).state, 'token_unavailable');
});
test('reconcile: corrupt confirmed fingerprint → error (fail closed)', () => {
  const rec = { owner: OWNER, vault: VAULT, tokenFingerprint: 'not-hex', cluster: CLUSTER, programId: PROGRAM };
  assert.equal(reconcile({ record: rec, currentTokenHashHex: sha(TOKEN_A), connectedOwner: OWNER }).state, 'error');
});
test('reconcile: owner mismatch → owner_mismatch (do not touch the original record)', () => {
  const rec = { owner: 'AnotherOwner1111111111111111111111111111111', vault: VAULT, tokenFingerprint: fpA, cluster: CLUSTER, programId: PROGRAM };
  assert.equal(reconcile({ record: rec, currentTokenHashHex: sha(TOKEN_A), connectedOwner: OWNER }).state, 'owner_mismatch');
});
test('reconcile: tombstoned (deregistered) record → disabled', () => {
  const rec = { owner: OWNER, vault: VAULT, cluster: CLUSTER, programId: PROGRAM, deregisteredAt: 123 };
  assert.equal(reconcile({ record: rec, currentTokenHashHex: sha(TOKEN_A), connectedOwner: OWNER }).state, 'disabled');
});

// ── observer harness ─────────────────────────────────────────────────────────
function observerHarness(over: Record<string, any> = {}) {
  const store = new Map<string, string>();
  if (over.seedRecord) store.set(successKey(KEY), over.seedRecord);
  const states: string[] = [];
  const spies = { setCount: 0, signMessage: 0, post: 0 };
  let seq = 0;
  const deps: any = {
    cluster: CLUSTER,
    programId: PROGRAM,
    getConnectedOwner: over.getConnectedOwner ?? (() => OWNER),
    deriveVault,
    getCurrentToken: over.getCurrentToken ?? (async () => TOKEN_A),
    sha256Hex,
    getSetting: over.getSetting ?? (async (k: string) => store.get(k) ?? null),
    setSetting: over.setSetting ?? (async (k: string, v: string) => { spies.setCount++; store.set(k, v); }),
    successKeyFor: successKey,
    deregPendingKeyFor: deregPendingKey,
    closedVaultKeyFor: closedVaultKey,
    subscribe: over.subscribe,
    nowMs: () => 1784500000000 + (seq++),
    onState: (s: string) => states.push(s),
  };
  // NOTE: deps intentionally has NO signMessage / postRegister / postDeregister.
  return { deps, store, states, spies };
}

test('observer: no record → not_enabled, no persistence', async () => {
  const h = observerHarness();
  const obs = makeTokenObserver(h.deps);
  assert.equal(await obs.checkNow(), 'not_enabled');
  assert.equal(h.spies.setCount, 0);
});
test('observer: matching token → enabled, writes nothing', async () => {
  const h = observerHarness({ seedRecord: confirmedRecord(fpA) });
  const obs = makeTokenObserver(h.deps);
  assert.equal(await obs.checkNow(), 'enabled');
  assert.equal(h.spies.setCount, 0);
});
test('observer: changed token → update_required, persists a pending marker with the NEW fingerprint', async () => {
  const h = observerHarness({ seedRecord: confirmedRecord(fpA), getCurrentToken: async () => TOKEN_B });
  const obs = makeTokenObserver(h.deps);
  assert.equal(await obs.checkNow(), 'update_required');
  const marker = JSON.parse(h.store.get(pendingKey(KEY))!);
  assert.equal(marker.fingerprint, fpB);
  assert.equal(marker.rotationRequired, true);
});
test('observer: legacy 16-char record → update_required', async () => {
  const h = observerHarness({ seedRecord: confirmedRecord(sha(TOKEN_A).slice(0, 16)) });
  const obs = makeTokenObserver(h.deps);
  assert.equal(await obs.checkNow(), 'update_required');
});
test('observer: token unavailable → token_unavailable, record preserved, no pending write', async () => {
  const h = observerHarness({ seedRecord: confirmedRecord(fpA), getCurrentToken: async () => null });
  const obs = makeTokenObserver(h.deps);
  assert.equal(await obs.checkNow(), 'token_unavailable');
  assert.equal(h.spies.setCount, 0);
  assert.ok(h.store.get(successKey(KEY))); // record still there
});
test('observer: corrupt confirmed record → error (fail closed)', async () => {
  const h = observerHarness({ seedRecord: '{not json' });
  const obs = makeTokenObserver(h.deps);
  assert.equal(await obs.checkNow(), 'error');
});
test('observer: repeated same changed-token event is idempotent (one pending write, no growth)', async () => {
  const h = observerHarness({ seedRecord: confirmedRecord(fpA), getCurrentToken: async () => TOKEN_B });
  const obs = makeTokenObserver(h.deps);
  await obs.checkNow();
  const afterFirst = h.spies.setCount;
  await obs.checkNow();
  await obs.checkNow();
  assert.equal(h.spies.setCount, afterFirst, 'same fingerprint does not rewrite the marker');
});
test('observer: newest token event wins (sequence increments across distinct fingerprints)', async () => {
  let token = TOKEN_B;
  const h = observerHarness({ seedRecord: confirmedRecord(fpA), getCurrentToken: async () => token });
  const obs = makeTokenObserver(h.deps);
  await obs.checkNow();
  const s1 = JSON.parse(h.store.get(pendingKey(KEY))!).sequence;
  token = 'fMockFCMToken-CCCC0123456789abcdefghijklmnopqrstuvwxyz';
  await obs.checkNow();
  const m2 = JSON.parse(h.store.get(pendingKey(KEY))!);
  assert.ok(m2.sequence > s1);
  assert.equal(m2.fingerprint, tokenFingerprint(sha(token)));
});
test('observer: update_required marker survives a reload (persisted, not in-memory only)', async () => {
  const h = observerHarness({ seedRecord: confirmedRecord(fpA), getCurrentToken: async () => TOKEN_B });
  makeTokenObserver(h.deps); // run once
  await makeTokenObserver(h.deps).checkNow();
  // A brand-new observer instance (simulating reload) still sees the persisted marker.
  const raw = h.store.get(pendingKey(KEY));
  assert.ok(raw && JSON.parse(raw).rotationRequired === true);
});
test('observer: dispose() unsubscribes the token listener', async () => {
  let subscribed = false, unsubscribed = false;
  const h = observerHarness({ seedRecord: confirmedRecord(fpA), subscribe: (_cb: any) => { subscribed = true; return () => { unsubscribed = true; }; } });
  const obs = makeTokenObserver(h.deps);
  obs.start();
  assert.equal(subscribed, true);
  obs.dispose();
  assert.equal(unsubscribed, true);
});
test('observer: the injected token event triggers a local check but NEVER signs or mutates the server', async () => {
  let fire: any;
  const h = observerHarness({ seedRecord: confirmedRecord(fpA), getCurrentToken: async () => TOKEN_B, subscribe: (cb: any) => { fire = cb; return () => {}; } });
  const obs = makeTokenObserver(h.deps);
  obs.start();
  fire();
  await new Promise((r) => setTimeout(r, 5));
  // Only a local pending marker may be written; no signing/HTTP dependency even exists.
  assert.equal(h.spies.signMessage, 0);
  assert.equal(h.spies.post, 0);
  assert.equal('signMessage' in h.deps, false);
  assert.equal('postRegister' in h.deps, false);
  assert.equal('postDeregister' in h.deps, false);
});
test('observer: a stale async check cannot overwrite the state of a newer check (generation guard)', async () => {
  // Two overlapping checks; the FIRST resolves its token slowly. The generation guard
  // must prevent the stale (older) completion from emitting after the newer one.
  let calls = 0;
  const h = observerHarness({ seedRecord: confirmedRecord(fpA) });
  h.deps.getCurrentToken = async () => {
    calls++;
    if (calls === 1) { await new Promise((r) => setTimeout(r, 20)); return TOKEN_B; } // stale: would say update_required
    return TOKEN_A; // newer: enabled
  };
  const obs = makeTokenObserver(h.deps);
  const p1 = obs.checkNow();
  const p2 = obs.checkNow();
  await Promise.all([p1, p2]);
  // The LAST emitted state must be the newer check's result (enabled), not the stale one.
  assert.equal(h.states[h.states.length - 1], 'enabled');
});

// ── operation lock ───────────────────────────────────────────────────────────
const IDA = operationIdentity(KEY);
const IDB = operationIdentity({ ...KEY, owner: 'AnotherOwner1111111111111111111111111111111' });

test('runExclusive: repeated identical action while active → noop', async () => {
  let release: any;
  const gate = new Promise((r) => { release = r; });
  const running = runExclusive(IDA, 'update', async () => { await gate; return 'done'; });
  const second = await runExclusive(IDA, 'update', async () => 'second');
  assert.deepEqual(second, { ran: false, reason: 'noop', activeOp: 'update' });
  release();
  await running;
});
test('runExclusive: update and deregister are mutually exclusive (conflict)', async () => {
  let release: any;
  const gate = new Promise((r) => { release = r; });
  const running = runExclusive(IDA, 'update', async () => { await gate; return 'u'; });
  const dereg = await runExclusive(IDA, 'deregister', async () => 'd');
  assert.equal(dereg.ran, false);
  assert.equal((dereg as any).reason, 'conflict');
  release();
  await running;
});
test('runExclusive: register and deregister share the lock (conflict on the same identity)', async () => {
  let release: any;
  const gate = new Promise((r) => { release = r; });
  const running = runExclusive(IDA, 'register', async () => { await gate; return 'r'; });
  const dereg = await runExclusive(IDA, 'deregister', async () => 'd');
  assert.equal(dereg.ran, false);
  release();
  await running;
});
test('runExclusive: releases in finally even when fn throws', async () => {
  await runExclusive(IDA, 'update', async () => { throw new Error('boom'); }).catch(() => {});
  assert.equal(isOperationActive(IDA), false); // lock released despite the throw
  const next = await runExclusive(IDA, 'deregister', async () => 'ok');
  assert.equal(next.ran, true);
});
test('runExclusive: an unrelated identity is never blocked', async () => {
  let release: any;
  const gate = new Promise((r) => { release = r; });
  const running = runExclusive(IDA, 'update', async () => { await gate; return 'a'; });
  const other = await runExclusive(IDB, 'update', async () => 'b'); // different identity → runs
  assert.equal(other.ran, true);
  release();
  await running;
});

// ── deregistration dominance / stale-listener safety ─────────────────────────
test('reconcile: a deregistered (tombstoned) record dominates a concurrent token change → stays disabled', () => {
  const rec = { owner: OWNER, vault: VAULT, cluster: CLUSTER, programId: PROGRAM, deregisteredAt: 555 };
  assert.equal(reconcile({ record: rec, currentTokenHashHex: sha(TOKEN_B), connectedOwner: OWNER }).state, 'disabled');
});
test('observer: a stale token event cannot re-enable a tombstoned record', async () => {
  const tomb = JSON.stringify({ owner: OWNER, vault: VAULT, cluster: CLUSTER, programId: PROGRAM, deregisteredAt: 900 });
  const h = observerHarness({ seedRecord: tomb, getCurrentToken: async () => TOKEN_A });
  const obs = makeTokenObserver(h.deps);
  assert.equal(await obs.checkNow(), 'disabled'); // never 'enabled'
  assert.equal(h.spies.setCount, 0);
});
test('observer (review MEDIUM): a DURABLE dereg-pending marker recovers to disabled after "restart", never enabled', async () => {
  // Server deregistered, but the local tombstone write failed → only a durable marker persists;
  // the confirmed record is still intact (fingerprint matches the current token). A fresh
  // observer must NOT report enabled — it repairs the tombstone locally and reports disabled.
  const h = observerHarness({ seedRecord: confirmedRecord(fpA) });
  h.store.set(deregPendingKey(KEY), '1784500000'); // durable pending marker
  const obs = makeTokenObserver(h.deps);
  assert.equal(await obs.checkNow(), 'disabled', 'recovered to disabled, not enabled');
  assert.equal(h.store.get(deregPendingKey(KEY)) || '', '', 'marker cleared after local repair');
  assert.ok(JSON.parse(h.store.get(successKey(KEY))!).deregisteredAt > 0, 'tombstone written on repair');
});
test('observer: if the local repair write keeps failing, it stays local_cleanup_pending (never enabled)', async () => {
  const seed = confirmedRecord(fpA);
  const store = new Map<string, string>([[successKey(KEY), seed], [deregPendingKey(KEY), '1784500000']]);
  const h = observerHarness({
    seedRecord: seed,
    getSetting: async (k: string) => store.get(k) ?? null,
    setSetting: async () => { throw new Error('sqlite write failed'); }, // repair can't complete
  });
  const obs = makeTokenObserver(h.deps);
  assert.equal(await obs.checkNow(), 'local_cleanup_pending'); // never 'enabled'
});
test('observer: invalidate() prevents a stale in-flight check from emitting (deliberate-action stomp guard)', async () => {
  // A deliberate Disable/Enable calls invalidate() so a slow observer check started during the
  // wallet approval cannot emit afterward and stomp the terminal UI state.
  const h = observerHarness({ seedRecord: confirmedRecord(fpA), getCurrentToken: async () => { await new Promise((r) => setTimeout(r, 20)); return TOKEN_B; } });
  const obs = makeTokenObserver(h.deps);
  const p = obs.checkNow(); // slow; would emit update_required after ~20ms
  obs.invalidate(); // deliberate action bumps the generation
  await p;
  assert.equal(h.states.length, 0, 'the stale check did not emit after invalidate()');
  assert.equal(h.spies.setCount, 0, 'and did not persist a pending marker');
});

// ── WP6.1 vault-closed cleanup precedence ────────────────────────────────────
function closedTomb(over: Record<string, unknown> = {}) {
  return JSON.stringify({ schemaVersion: 1, owner: OWNER, vault: VAULT, cluster: CLUSTER, programId: PROGRAM, revokedAt: 1784500000, revokeSig: 'S'.repeat(64), needsServerReconcile: true, ...over });
}
test('observer (WP6.1): closed-vault marker + active record → vault_closed_cleanup_pending (never enabled)', async () => {
  const h = observerHarness({ seedRecord: confirmedRecord(fpA), getCurrentToken: async () => TOKEN_A });
  h.store.set(closedVaultKey(KEY), closedTomb());
  assert.equal(await makeTokenObserver(h.deps).checkNow(), 'vault_closed_cleanup_pending');
});
test('observer (WP6.1): cleanup_pending survives a "restart" — a fresh observer never returns enabled', async () => {
  const store = new Map<string, string>([[successKey(KEY), confirmedRecord(fpA)], [closedVaultKey(KEY), closedTomb()]]);
  const h = observerHarness({ getSetting: async (k: string) => store.get(k) ?? null, getCurrentToken: async () => TOKEN_A });
  assert.equal(await makeTokenObserver(h.deps).checkNow(), 'vault_closed_cleanup_pending');
});
test('observer (WP6.1): a token event cannot restore enabled while cleanup pending', async () => {
  let fire: any;
  const h = observerHarness({ seedRecord: confirmedRecord(fpA), getCurrentToken: async () => TOKEN_A, subscribe: (cb: any) => { fire = cb; return () => {}; } });
  h.store.set(closedVaultKey(KEY), closedTomb());
  const obs = makeTokenObserver(h.deps); obs.start(); fire(); await new Promise((r) => setTimeout(r, 5));
  assert.equal(await obs.checkNow(), 'vault_closed_cleanup_pending');
});
test('observer (WP6.1): closed-vault marker + tombstoned record → disabled + marker cleared', async () => {
  const rec = JSON.stringify({ owner: OWNER, vault: VAULT, cluster: CLUSTER, programId: PROGRAM, deregisteredAt: 900 });
  const h = observerHarness({ seedRecord: rec, getCurrentToken: async () => TOKEN_A });
  h.store.set(closedVaultKey(KEY), closedTomb());
  assert.equal(await makeTokenObserver(h.deps).checkNow(), 'disabled');
  assert.equal(h.store.get(closedVaultKey(KEY)) || '', '', 'marker cleared once cleanup is done');
});
test('observer (WP6.1): closed-vault marker + NO record → clears the pointless marker, not_enabled', async () => {
  const h = observerHarness({ getCurrentToken: async () => TOKEN_A });
  h.store.set(closedVaultKey(KEY), closedTomb());
  assert.equal(await makeTokenObserver(h.deps).checkNow(), 'not_enabled');
  assert.equal(h.store.get(closedVaultKey(KEY)) || '', '', 'pointless marker cleared');
});
test('observer (WP6.1): a closed-vault marker whose body owner differs is ignored (owner guard)', async () => {
  const h = observerHarness({ seedRecord: confirmedRecord(fpA), getCurrentToken: async () => TOKEN_A });
  h.store.set(closedVaultKey(KEY), closedTomb({ owner: 'AnotherOwner1111111111111111111111111111111' }));
  assert.equal(await makeTokenObserver(h.deps).checkNow(), 'enabled'); // body-owner mismatch → not treated as closed
});

test('observer (WP6.1 MED): a record whose revision post-dates the closure → live (enabled) + stale tombstone cleared', async () => {
  const rec = JSON.stringify({ owner: OWNER, vault: VAULT, revision: 2000, tokenFingerprint: fpA, cluster: CLUSTER, programId: PROGRAM });
  const h = observerHarness({ seedRecord: rec, getCurrentToken: async () => TOKEN_A });
  h.store.set(closedVaultKey(KEY), closedTomb({ priorRevision: 1000 }));
  assert.equal(await makeTokenObserver(h.deps).checkNow(), 'enabled'); // record newer than closure → live
  assert.equal(h.store.get(closedVaultKey(KEY)) || '', '', 'stale tombstone cleared');
});
test('observer (WP6.1): a same-revision record (not newer than the closure) stays cleanup_pending', async () => {
  const rec = JSON.stringify({ owner: OWNER, vault: VAULT, revision: 1000, tokenFingerprint: fpA, cluster: CLUSTER, programId: PROGRAM });
  const h = observerHarness({ seedRecord: rec, getCurrentToken: async () => TOKEN_A });
  h.store.set(closedVaultKey(KEY), closedTomb({ priorRevision: 1000 }));
  assert.equal(await makeTokenObserver(h.deps).checkNow(), 'vault_closed_cleanup_pending');
});
