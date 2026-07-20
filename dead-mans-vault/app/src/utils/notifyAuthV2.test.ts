// App-side V2 owner-signed notification contract tests (WP1). Consumes the SAME
// repo-level fixture as the notify-server test (notify-server/test/authMessageV2.test.js);
// byte-for-byte equality here + there is the cross-platform parity guarantee.
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
  type RegisterFieldsV2,
  type DeregisterFieldsV2,
} from './notifyAuth.ts';

const F = JSON.parse(
  readFileSync(new URL('../../../../test-vectors/notify-auth-v2.json', import.meta.url), 'utf8'),
);

const validReg = (): RegisterFieldsV2 => ({
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
const validDereg = (): DeregisterFieldsV2 => ({
  cluster: F.cluster,
  programId: F.programId,
  owner: F.owner,
  vault: F.vault,
  timestamp: F.timestamp,
  nonce: F.nonce,
});
const sha256 = (m: string): string => createHash('sha256').update(m, 'utf8').digest('hex');

// ── Cross-platform parity: app output equals the shared fixture ─────────────
test('app register V2 equals the shared fixture byte-for-byte', () => {
  assert.equal(registerMessageV2(validReg()), F.register.message);
});
test('app register V2 byte length + sha256 match the fixture', () => {
  const m = registerMessageV2(validReg());
  assert.equal(Buffer.byteLength(m, 'utf8'), F.register.byteLength);
  assert.equal(sha256(m), F.register.sha256);
});
test('app deregister V2 equals the shared fixture byte-for-byte', () => {
  assert.equal(deregisterMessageV2(validDereg()), F.deregister.message);
});
test('app deregister V2 byte length + sha256 match the fixture', () => {
  const m = deregisterMessageV2(validDereg());
  assert.equal(Buffer.byteLength(m, 'utf8'), F.deregister.byteLength);
  assert.equal(sha256(m), F.deregister.sha256);
});

// ── Structural invariants (mirror the server) ───────────────────────────────
test('app register V2 has no trailing newline and pins version/audience/action', () => {
  const m = registerMessageV2(validReg());
  assert.equal(m.endsWith('\n'), false);
  assert.equal(m.includes('\r'), false);
  const lines = m.split('\n');
  assert.equal(lines[0], REGISTER_DOMAIN_V2);
  assert.equal(lines[1], `version=${NOTIFY_AUTH_VERSION_V2}`);
  assert.ok(lines.includes(`audience=${NOTIFY_AUDIENCE}`));
  assert.ok(lines.includes('action=register'));
});
test('audience constant is the exact canonical origin', () => {
  assert.equal(NOTIFY_AUDIENCE, 'https://notify.palatinearc.com');
});
test('app register/deregister V2 domains differ', () => {
  assert.notEqual(REGISTER_DOMAIN_V2, DEREGISTER_DOMAIN_V2);
});
test('app V2 builds are deterministic', () => {
  assert.equal(registerMessageV2(validReg()), registerMessageV2(validReg()));
});

// ── V1 regression: unchanged and distinct from V2 ───────────────────────────
test('app V1 register output is unchanged and distinct from V2', () => {
  const v1 = registerMessage({
    owner: F.owner, vault: F.vault, deviceTokenHash: F.deviceTokenHash,
    stage1: F.stage1, stage2: F.stage2, stage3: F.stage3, timestamp: F.timestamp, nonce: F.nonce,
  });
  assert.ok(v1.startsWith(REGISTER_DOMAIN));
  assert.equal(v1.includes('version=2'), false);
  assert.equal(v1.includes('cluster='), false);
  assert.notEqual(v1, registerMessageV2(validReg()));
});
test('app V1 deregister output is unchanged', () => {
  const v1 = deregisterMessage({ owner: F.owner, vault: F.vault, timestamp: F.timestamp, nonce: F.nonce });
  assert.equal(v1.includes('version=2'), false);
});

// ── Adversarial: malformed / noncanonical input must throw (mirror the server)
const rejects = (patch: Partial<RegisterFieldsV2>, label: string) =>
  test(`app register V2 rejects ${label}`, () => {
    assert.throws(() => registerMessageV2({ ...validReg(), ...patch }));
  });

rejects({ cluster: 'mainnet' }, 'cluster alias mainnet');
rejects({ cluster: 'Devnet' }, 'cluster wrong case');
rejects({ cluster: ' devnet' }, 'cluster with leading space');
rejects({ programId: 'not-base58!!' }, 'non-base58 programId');
rejects({ owner: '123' }, 'too-short owner pubkey');
rejects({ owner: F.owner.toLowerCase() }, 'noncanonical owner casing');
rejects({ deviceTokenHash: F.deviceTokenHash.toUpperCase() }, 'uppercase token hash');
rejects({ deviceTokenHash: F.deviceTokenHash.slice(0, 63) }, 'short token hash');
rejects({ stage1: 0 }, 'zero stage1');
rejects({ stage2: -1 }, 'negative stage2');
rejects({ stage3: 1.5 }, 'fractional stage3');
rejects({ stage1: '259200' as unknown as number }, 'string-form stage1');
rejects({ revision: 0 }, 'zero revision');
rejects({ revision: 2.2 }, 'fractional revision');
rejects({ timestamp: -100 }, 'negative timestamp');
rejects({ nonce: 'abc' }, 'short nonce');
rejects({ nonce: '0'.repeat(24) }, 'non-base58 nonce (0)');
rejects({ nonce: F.nonce + '\n' }, 'nonce with newline');
rejects({ nonce: undefined as unknown as string }, 'missing nonce');

test('app deregister V2 rejects malformed cluster/nonce', () => {
  assert.throws(() => deregisterMessageV2({ ...validDereg(), cluster: 'mainnet' }));
  assert.throws(() => deregisterMessageV2({ ...validDereg(), nonce: 'abc' }));
});

test('a caller-supplied action property cannot alter the fixed operation', () => {
  const m = registerMessageV2({ ...validReg(), action: 'deregister' } as unknown as RegisterFieldsV2);
  assert.equal(m, F.register.message);
});

// ── nonce generator produces a builder-accepted Base58 nonce ────────────────
test('app generateNonceV2 output is accepted by the builder', () => {
  for (let i = 0; i < 200; i++) {
    const n = generateNonceV2();
    assert.match(n, /^[1-9A-HJ-NP-Za-km-z]{22,64}$/);
    assert.doesNotThrow(() => registerMessageV2({ ...validReg(), nonce: n }));
  }
  assert.notEqual(generateNonceV2(), generateNonceV2());
});
