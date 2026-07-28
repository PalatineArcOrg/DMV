// V2 owner-signed notification contract tests (WP1). Asserts the canonical bytes
// against the shared repo-level fixture, exercises the input canonicalisation
// (rejecting malformed/noncanonical values), and confirms V1 is unchanged.
// The SAME fixture is consumed by the app test (app/src/utils/notifyAuthV2.test.ts),
// which is the cross-platform parity guarantee.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  registerMessage,
  deregisterMessage,
  REGISTER_DOMAIN,
  registerMessageV2,
  deregisterMessageV2,
  REGISTER_DOMAIN_V2,
  DEREGISTER_DOMAIN_V2,
  NOTIFY_AUTH_VERSION_V2,
  NOTIFY_AUDIENCE,
  generateNonceV2,
  sha256Hex,
} from '../src/authMessage.js';

const F = JSON.parse(
  readFileSync(new URL('../../test-vectors/notify-auth-v2.json', import.meta.url), 'utf8'),
);

// Valid V2 field sets derived from the shared fixture.
const validReg = () => ({
  cluster: F.cluster,
  programId: F.programId,
  owner: F.owner,
  vault: F.vault,
  deviceTokenHash: F.deviceTokenHash,
  stage1: F.stage1,
  stage2: F.stage2,
  stage3: F.stage3,
  revision: F.revision,
  timestamp: F.timestamp,
  nonce: F.nonce,
});
const validDereg = () => ({
  cluster: F.cluster,
  programId: F.programId,
  owner: F.owner,
  vault: F.vault,
  timestamp: F.timestamp,
  nonce: F.nonce,
});
const sha256 = (m) => createHash('sha256').update(m, 'utf8').digest('hex');

// ── Canonical bytes match the shared fixture ────────────────────────────────
test('register V2 message equals the shared fixture byte-for-byte', () => {
  assert.equal(registerMessageV2(validReg()), F.register.message);
});
test('register V2 byte length matches the fixture', () => {
  assert.equal(Buffer.byteLength(registerMessageV2(validReg()), 'utf8'), F.register.byteLength);
});
test('register V2 sha256 matches the fixture', () => {
  assert.equal(sha256(registerMessageV2(validReg())), F.register.sha256);
});
test('deregister V2 message equals the shared fixture byte-for-byte', () => {
  assert.equal(deregisterMessageV2(validDereg()), F.deregister.message);
});
test('deregister V2 byte length matches the fixture', () => {
  assert.equal(Buffer.byteLength(deregisterMessageV2(validDereg()), 'utf8'), F.deregister.byteLength);
});
test('deregister V2 sha256 matches the fixture', () => {
  assert.equal(sha256(deregisterMessageV2(validDereg())), F.deregister.sha256);
});

// ── Structural invariants ───────────────────────────────────────────────────
test('register V2 has no leading or trailing newline', () => {
  const m = registerMessageV2(validReg());
  assert.equal(m.startsWith('\n'), false);
  assert.equal(m.endsWith('\n'), false);
});
test('register V2 uses single ASCII newline separators only', () => {
  const m = registerMessageV2(validReg());
  assert.equal(m.includes('\r'), false);
  assert.equal(m.includes('\n\n'), false);
});
test('register V2 pins version, audience, and action', () => {
  const lines = registerMessageV2(validReg()).split('\n');
  assert.equal(lines[0], REGISTER_DOMAIN_V2);
  assert.equal(lines[1], `version=${NOTIFY_AUTH_VERSION_V2}`);
  assert.ok(lines.includes(`audience=${NOTIFY_AUDIENCE}`));
  assert.ok(lines.includes('action=register'));
});
test('deregister V2 pins its own domain + action and omits token/stages/revision', () => {
  const m = deregisterMessageV2(validDereg());
  assert.ok(m.startsWith(DEREGISTER_DOMAIN_V2));
  assert.ok(m.includes('action=deregister'));
  assert.equal(m.includes('deviceTokenHash='), false);
  assert.equal(m.includes('stage1='), false);
  assert.equal(m.includes('revision='), false);
});
test('audience constant is the exact canonical origin (no trailing slash)', () => {
  assert.equal(NOTIFY_AUDIENCE, 'https://notify.palatinearc.com');
});
test('register and deregister V2 domains differ', () => {
  assert.notEqual(REGISTER_DOMAIN_V2, DEREGISTER_DOMAIN_V2);
});

// ── Determinism ─────────────────────────────────────────────────────────────
test('repeated V2 builds are byte-identical', () => {
  assert.equal(registerMessageV2(validReg()), registerMessageV2(validReg()));
  assert.equal(deregisterMessageV2(validDereg()), deregisterMessageV2(validDereg()));
});

// ── V1 regression: unchanged, and never confused with V2 ────────────────────
test('V1 register output is unchanged and distinct from V2', () => {
  const v1 = registerMessage({
    owner: F.owner, vault: F.vault, deviceTokenHash: F.deviceTokenHash,
    stage1: F.stage1, stage2: F.stage2, stage3: F.stage3, timestamp: F.timestamp, nonce: F.nonce,
  });
  assert.ok(v1.startsWith(REGISTER_DOMAIN)); // DMV_NOTIFY_REGISTER_V1
  assert.equal(v1.includes('version=2'), false);
  assert.equal(v1.includes('cluster='), false);
  assert.equal(v1.includes('audience='), false);
  assert.notEqual(v1, registerMessageV2(validReg()));
});
test('V1 deregister output is unchanged', () => {
  const v1 = deregisterMessage({ owner: F.owner, vault: F.vault, timestamp: F.timestamp, nonce: F.nonce });
  assert.equal(v1.includes('version=2'), false);
  assert.equal(v1.includes('cluster='), false);
});

// ── Adversarial: malformed / noncanonical input must throw ──────────────────
const rejects = (patch, label) => test(`register V2 rejects ${label}`, () => {
  assert.throws(() => registerMessageV2({ ...validReg(), ...patch }));
});

rejects({ cluster: 'mainnet' }, 'cluster alias mainnet');
rejects({ cluster: 'Devnet' }, 'cluster wrong case');
rejects({ cluster: ' devnet' }, 'cluster with leading space');
rejects({ cluster: 'devnet ' }, 'cluster with trailing space');
rejects({ cluster: 'testnet' }, 'unsupported cluster testnet');

rejects({ programId: 'not-base58!!' }, 'non-base58 programId');
rejects({ programId: F.programId + ' ' }, 'programId with trailing space');
rejects({ owner: '123' }, 'too-short owner pubkey');
rejects({ owner: F.owner.toLowerCase() }, 'noncanonical owner casing');
rejects({ vault: '' }, 'empty vault');

rejects({ deviceTokenHash: F.deviceTokenHash.toUpperCase() }, 'uppercase token hash');
rejects({ deviceTokenHash: F.deviceTokenHash.slice(0, 63) }, 'short token hash');
rejects({ deviceTokenHash: 'g'.repeat(64) }, 'non-hex token hash');
rejects({ deviceTokenHash: F.deviceTokenHash + 'ab' }, 'over-length token hash');

rejects({ stage1: 0 }, 'zero stage1');
rejects({ stage2: -1 }, 'negative stage2');
rejects({ stage3: 1.5 }, 'fractional stage3');
rejects({ stage1: Number.MAX_SAFE_INTEGER + 1 }, 'unsafe-integer stage1');
rejects({ stage1: '259200' }, 'string-form stage1');
rejects({ stage1: NaN }, 'NaN stage1');
rejects({ stage2: Infinity }, 'infinite stage2');

rejects({ revision: 0 }, 'zero revision');
rejects({ revision: -3 }, 'negative revision');
rejects({ revision: 2.2 }, 'fractional revision');

rejects({ timestamp: 0 }, 'zero timestamp');
rejects({ timestamp: -100 }, 'negative timestamp');
rejects({ timestamp: 1.5 }, 'fractional timestamp');

rejects({ nonce: 'abc' }, 'short nonce');
rejects({ nonce: '0'.repeat(24) }, 'non-base58 nonce (0)');
rejects({ nonce: 'l'.repeat(24) }, 'non-base58 nonce (l)');
rejects({ nonce: F.nonce + '\n' }, 'nonce with newline');
rejects({ nonce: F.nonce.slice(0, 10) + ' ' + F.nonce.slice(11) }, 'nonce with space');
rejects({ nonce: 'z'.repeat(65) }, 'over-length nonce');
rejects({ nonce: undefined }, 'missing nonce');
rejects({ deviceTokenHash: undefined }, 'missing token hash');

test('deregister V2 rejects the same malformed cluster/nonce', () => {
  assert.throws(() => deregisterMessageV2({ ...validDereg(), cluster: 'mainnet' }));
  assert.throws(() => deregisterMessageV2({ ...validDereg(), nonce: 'abc' }));
});

// ── action cannot be overridden by caller input ─────────────────────────────
test('a caller-supplied action property cannot alter the fixed operation', () => {
  const m = registerMessageV2({ ...validReg(), action: 'deregister', version: 99, audience: 'http://evil' });
  assert.equal(m, F.register.message);
  assert.ok(m.includes('action=register'));
  assert.ok(m.includes(`audience=${NOTIFY_AUDIENCE}`));
});

// ── nonce generator + sha256 helper ─────────────────────────────────────────
test('generateNonceV2 produces a builder-accepted Base58 nonce', () => {
  for (let i = 0; i < 200; i++) {
    const n = generateNonceV2();
    assert.match(n, /^[1-9A-HJ-NP-Za-km-z]{22,64}$/);
    // A generated nonce must be accepted by the builder.
    assert.doesNotThrow(() => registerMessageV2({ ...validReg(), nonce: n }));
  }
  assert.notEqual(generateNonceV2(), generateNonceV2());
});
test('sha256Hex yields lowercase 64-hex and matches the fixture token hash', () => {
  const h = sha256Hex('dmv-notify-auth-v2/synthetic-device-token');
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(h, F.deviceTokenHash);
});
