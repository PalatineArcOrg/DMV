import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PublicKey } from '@solana/web3.js';
import { createHash } from 'node:crypto';
import {
  isProgramAccount,
  programAccountProblem,
  parseVaultConfig,
} from './rawAccountParsers.ts';

// Regression: the account guard must not depend on Buffer-only methods.
//
// It used `info.data.subarray(0, 8).equals(disc)`. buffer@6.0.3 overrides
// Buffer.prototype.slice but NOT subarray, so subarray comes from Uint8Array.
// On Node, species handling returns a Buffer and `.equals` exists. Under Hermes
// that is unreliable and subarray yields a plain Uint8Array with no `.equals`, so
// the call threw — and because isProgramAccount runs OUTSIDE each parser's
// try/catch, the TypeError escaped and agent readiness reported the opaque
// "vault account validation failed", refusing every heartbeat on device.
//
// Passing plain Uint8Array data reproduces that condition exactly: the old code
// throws, the byte-wise compare does not.

const PROGRAM = new PublicKey('GXCu5964mvgAJDWmcMriZpzU3vDVqPzjYCM1sxCnsoEb');
const OTHER = new PublicKey('11111111111111111111111111111111');

function disc(name: string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(`account:${name}`).digest().subarray(0, 8));
}

/** A VaultConfig-shaped account whose data is a PLAIN Uint8Array, as on Hermes. */
function hermesVaultAccount(owner = PROGRAM) {
  const data = new Uint8Array(856);
  data.set(disc('VaultConfig'), 0);
  new PublicKey('FoxVEfLFp6KZ2HNJAbXefvwamzPvtCDAb2YF5JT43KkH').toBytes().forEach((b, i) => { data[8 + i] = b; });
  return { owner, data: data as unknown as Buffer };
}

test('plain Uint8Array data does not throw and is accepted (Hermes shape)', () => {
  const account = hermesVaultAccount();
  assert.equal(typeof (account.data as unknown as { equals?: unknown }).equals, 'undefined',
    'fixture must lack Buffer.equals, or it does not model Hermes');
  assert.doesNotThrow(() => isProgramAccount(account, 'VaultConfig', 92, PROGRAM));
  assert.equal(isProgramAccount(account, 'VaultConfig', 92, PROGRAM), true);
  assert.equal(programAccountProblem(account, 'VaultConfig', 92, PROGRAM), null);
});

test('parseVaultConfig does not throw on plain Uint8Array data', () => {
  assert.doesNotThrow(() => parseVaultConfig(hermesVaultAccount(), PROGRAM));
});

test('the guard still rejects what it should, and says why', () => {
  const cases: Array<[unknown, RegExp]> = [
    [null, /not found/],
    [{ owner: OTHER, data: hermesVaultAccount().data }, /not the DMV program/],
    [{ owner: PROGRAM, data: new Uint8Array(4) }, /too short/],
    [{ owner: PROGRAM, data: new Uint8Array(856) }, /discriminator mismatch/],
  ];
  for (const [account, expected] of cases) {
    const problem = programAccountProblem(account as never, 'VaultConfig', 92, PROGRAM);
    assert.ok(problem, `expected a problem for ${JSON.stringify(expected.source)}`);
    assert.match(problem, expected);
  }
});

test('a wrong discriminator differing only in the last byte is still rejected', () => {
  const account = hermesVaultAccount();
  account.data[7] = (account.data[7] ?? 0) ^ 0xff;
  assert.equal(isProgramAccount(account, 'VaultConfig', 92, PROGRAM), false);
});

test('real Buffer data keeps working (no regression off-device)', () => {
  const src = hermesVaultAccount();
  const account = { owner: PROGRAM, data: Buffer.from(src.data) };
  assert.equal(isProgramAccount(account, 'VaultConfig', 92, PROGRAM), true);
});
