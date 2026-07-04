import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { BN } from '@coral-xyz/anchor';
import {
  parseVaultConfig,
  parseExecutionLog,
  parseAssetPlan,
  parseTokenDist,
  parseDeadline,
  isProgramAccount,
} from './rawAccountParsers.ts';

const PROGRAM = new PublicKey('GXCu5964mvgAJDWmcMriZpzU3vDVqPzjYCM1sxCnsoEb');
const disc = (name: string) => createHash('sha256').update('account:' + name).digest().subarray(0, 8);
const pk = (fill: number) => new PublicKey(Buffer.alloc(32, fill));
const acct = (data: Buffer, owner = PROGRAM) => ({ owner, data });
const i64 = (n: number) => {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(BigInt(n));
  return b;
};
const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};

function buildVaultConfig(o: {
  owner?: PublicKey;
  benefs?: { wallet: PublicKey; shareBps: number }[];
  hasAssetPlan?: boolean;
  discOverride?: Buffer;
} = {}): Buffer {
  const benefs = o.benefs ?? [{ wallet: pk(3), shareBps: 10000 }];
  const parts: Buffer[] = [
    o.discOverride ?? disc('VaultConfig'),
    (o.owner ?? pk(2)).toBuffer(),
    pk(9).toBuffer(), // agent
    i64(86400), // interval
    i64(604800), // grace
    u32(benefs.length),
  ];
  for (const b of benefs) {
    parts.push(b.wallet.toBuffer());
    const s = Buffer.alloc(2);
    s.writeUInt16LE(b.shareBps);
    parts.push(s);
  }
  parts.push(Buffer.from([0])); // executed
  parts.push(Buffer.from([1])); // active
  parts.push(i64(1000)); // created
  parts.push(i64(2000)); // updated
  parts.push(Buffer.from([255])); // bump
  parts.push(Buffer.from([1])); // is_mutable
  parts.push(Buffer.from([o.hasAssetPlan ? 1 : 0]));
  parts.push(Buffer.alloc(2)); // open_token_dists
  return Buffer.concat(parts);
}

test('hardcoded discriminators match sha256 (drift guard)', () => {
  assert.equal(isProgramAccount(acct(buildVaultConfig()), 'VaultConfig', 92, PROGRAM), true);
  const bad = buildVaultConfig({ discOverride: Buffer.alloc(8, 0xff) });
  assert.equal(isProgramAccount(acct(bad), 'VaultConfig', 92, PROGRAM), false);
});

test('valid VaultConfig parses', () => {
  const c = parseVaultConfig(acct(buildVaultConfig({ benefs: [{ wallet: pk(3), shareBps: 6000 }, { wallet: pk(4), shareBps: 4000 }] })), PROGRAM);
  assert.ok(c);
  assert.equal(c!.beneficiaries.length, 2);
  assert.equal(c!.beneficiaries[0].shareBps, 6000);
  assert.equal(c!.heartbeatInterval.toNumber(), 86400);
  assert.equal(c!.active, true);
});

test('VaultConfig wrong owner → null', () => {
  assert.equal(parseVaultConfig(acct(buildVaultConfig(), pk(1)), PROGRAM), null);
});

test('VaultConfig wrong discriminator → null', () => {
  assert.equal(parseVaultConfig(acct(buildVaultConfig({ discOverride: Buffer.alloc(8, 1) })), PROGRAM), null);
});

test('VaultConfig short buffer → null', () => {
  assert.equal(parseVaultConfig(acct(buildVaultConfig().subarray(0, 50)), PROGRAM), null);
});

test('VaultConfig absurd beneficiary count → null (no over-read)', () => {
  const data = buildVaultConfig();
  data.writeUInt32LE(1000, 8 + 32 + 32 + 8 + 8); // overwrite vec_len with a huge count
  assert.equal(parseVaultConfig(acct(data), PROGRAM), null);
});

test('valid ExecutionLog parses; foreign account rejected', () => {
  const data = Buffer.concat([disc('ExecutionLog'), pk(1).toBuffer(), i64(5000), u32(3), i64(0), Buffer.from([0]), Buffer.alloc(20)]);
  const e = parseExecutionLog(acct(data), PROGRAM);
  assert.ok(e);
  assert.equal(e!.solSnapshot.toNumber(), 5000);
  assert.equal(e!.solPaidMask, 3);
  assert.equal(e!.completed, false);
  assert.equal(parseExecutionLog(acct(data, pk(1)), PROGRAM), null); // wrong owner
});

test('valid AssetPlan parses; oversized count rejected', () => {
  const data = Buffer.concat([
    disc('AssetPlan'), pk(1).toBuffer(), u32(1),
    pk(5).toBuffer(), i64(100), Buffer.from([0]), Buffer.from([0]),
    (() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(0n); return b; })(),
  ]);
  const p = parseAssetPlan(acct(data), PROGRAM);
  assert.ok(p);
  assert.equal(p!.assignments.length, 1);
  assert.equal(p!.assignments[0].amount.toNumber(), 100);
  const bad = Buffer.from(data);
  bad.writeUInt32LE(9999, 8 + 32); // huge vec_len
  assert.equal(parseAssetPlan(acct(bad), PROGRAM), null);
});

test('valid TokenDist parses', () => {
  const data = Buffer.concat([disc('TokenDist'), pk(1).toBuffer(), pk(5).toBuffer(), i64(700), u32(1), Buffer.from([1])]);
  const t = parseTokenDist(acct(data), PROGRAM);
  assert.ok(t);
  assert.equal(t!.snapshot.toNumber(), 700);
  assert.equal(t!.paidMask, 1);
});

test('parseDeadline computes from verified vault + heartbeat; rejects foreign', () => {
  const vault = buildVaultConfig();
  const hb = Buffer.concat([disc('HeartbeatRecord'), pk(1).toBuffer(), i64(1000), Buffer.alloc(10)]);
  assert.equal(parseDeadline(acct(vault), acct(hb), PROGRAM), 1000 + 86400 + 604800);
  // foreign heartbeat (wrong discriminator) → null
  const badHb = Buffer.concat([Buffer.alloc(8, 0), pk(1).toBuffer(), i64(1000), Buffer.alloc(10)]);
  assert.equal(parseDeadline(acct(vault), acct(badHb), PROGRAM), null);
});
