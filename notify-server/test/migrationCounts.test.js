// WP4 aggregate migration-count tests (§15): empty/all-legacy/all-signed/mixed,
// every anomalous combo, Fox-like legacy row, signed-update flip, dereg reduces,
// no row data, no mutation, stable repeats. Temp :memory: DBs only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
  ensureSchema, migrationCounts, applySignedRegistration, applyLegacyRegistration,
  deleteLegacyRegistration,
} from '../src/registrationStore.js';

function db() {
  const d = new Database(':memory:');
  ensureSchema(d);
  return d;
}
// Insert a row with explicit auth_version/migration_status (for anomalous combos).
function insertRow(d, { vault, owner = 'o', authVersion, migrationStatus }) {
  d.prepare(
    `INSERT INTO registrations (vault, owner, device_token, stage1, stage2, stage3, last_stage, last_notified_at, created_at, updated_at, auth_version, registration_revision, migration_status)
     VALUES (?, ?, 't', 1, 2, 3, 0, 0, 0, 0, ?, 0, ?)`,
  ).run(vault, owner, authVersion, migrationStatus);
}
const legacyCmd = (vault) => ({ owner: 'o' + vault, vault, deviceToken: 'tok-' + vault, stage1: 1, stage2: 2, stage3: 3, now: 100 });
const signedCmd = (vault, revision = 1) => ({
  owner: 'o' + vault, vault, deviceToken: 'tok-' + vault, deviceTokenHash: 'a'.repeat(64),
  stage1: 1, stage2: 2, stage3: 3, revision, signedAt: 100, nonce: 'n-' + vault + '-' + revision, nonceUsedAt: 100, authVersion: 2,
});

test('empty DB → all zero', () => {
  assert.deepEqual(migrationCounts(db()), { total: 0, legacy: 0, signed: 0, anomalous: 0 });
});
test('all legacy', () => {
  const d = db();
  applyLegacyRegistration(d, legacyCmd('v1'));
  applyLegacyRegistration(d, legacyCmd('v2'));
  assert.deepEqual(migrationCounts(d), { total: 2, legacy: 2, signed: 0, anomalous: 0 });
});
test('all signed', () => {
  const d = db();
  applySignedRegistration(d, signedCmd('v1'));
  applySignedRegistration(d, signedCmd('v2'));
  assert.deepEqual(migrationCounts(d), { total: 2, legacy: 0, signed: 2, anomalous: 0 });
});
test('mixed legacy/signed', () => {
  const d = db();
  applyLegacyRegistration(d, legacyCmd('v1'));
  applySignedRegistration(d, signedCmd('v2'));
  assert.deepEqual(migrationCounts(d), { total: 2, legacy: 1, signed: 1, anomalous: 0 });
});
test('every anomalous combination', () => {
  const d = db();
  insertRow(d, { vault: 'a1', authVersion: 2, migrationStatus: 'legacy' }); // signed version but legacy status
  insertRow(d, { vault: 'a2', authVersion: 1, migrationStatus: 'signed' }); // legacy version but signed status
  insertRow(d, { vault: 'a3', authVersion: 1, migrationStatus: 'weird' }); // unknown status
  insertRow(d, { vault: 'a4', authVersion: -1, migrationStatus: 'legacy' }); // negative version -> matches legacy? -1<2 && legacy => legacy, NOT anomalous
  const c = migrationCounts(d);
  assert.equal(c.total, 4);
  assert.equal(c.signed, 0);
  assert.equal(c.legacy, 1); // only a4 is a consistent legacy row
  assert.equal(c.anomalous, 3);
});
test('a synthetic Fox-like legacy row counts as legacy', () => {
  const d = db();
  insertRow(d, { vault: 'FoxVaultPDA', owner: 'FoxOwner', authVersion: 1, migrationStatus: 'legacy' });
  assert.deepEqual(migrationCounts(d), { total: 1, legacy: 1, signed: 0, anomalous: 0 });
});
test('a signed update flips a legacy row to signed', () => {
  const d = db();
  applyLegacyRegistration(d, legacyCmd('v1'));
  assert.equal(migrationCounts(d).legacy, 1);
  applySignedRegistration(d, signedCmd('v1', 5)); // same vault, migrate to signed
  assert.deepEqual(migrationCounts(d), { total: 1, legacy: 0, signed: 1, anomalous: 0 });
});
test('deregistration reduces the aggregate', () => {
  const d = db();
  applyLegacyRegistration(d, legacyCmd('v1'));
  applyLegacyRegistration(d, legacyCmd('v2'));
  deleteLegacyRegistration(d, { vault: 'v1' });
  assert.deepEqual(migrationCounts(d), { total: 1, legacy: 1, signed: 0, anomalous: 0 });
});
test('result contains only the four aggregate keys (no row data)', () => {
  const d = db();
  applySignedRegistration(d, signedCmd('v1'));
  assert.deepEqual(Object.keys(migrationCounts(d)).sort(), ['anomalous', 'legacy', 'signed', 'total']);
});
test('query performs no mutation and repeats are stable', () => {
  const d = db();
  applyLegacyRegistration(d, legacyCmd('v1'));
  const a = migrationCounts(d);
  const b = migrationCounts(d);
  assert.deepEqual(a, b);
  assert.equal(d.prepare('SELECT COUNT(*) AS n FROM registrations').get().n, 1);
});
