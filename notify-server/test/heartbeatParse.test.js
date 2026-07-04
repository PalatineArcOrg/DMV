import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { config } from '../src/config.js';
import { readHeartbeatFromAccount } from '../src/solana.js';

const PROGRAM_ID = new PublicKey(config.programId);
const HEARTBEAT_DISC = createHash('sha256').update('account:HeartbeatRecord').digest().subarray(0, 8);
const VAULT = new PublicKey(Buffer.alloc(32, 7)).toBase58();

function buildHeartbeatData({ disc = HEARTBEAT_DISC, vault, lastHeartbeat = 1_700_000_000 }) {
  const buf = Buffer.alloc(8 + 32 + 8 + 1 + 8 + 1 + 32); // full HeartbeatRecord SPACE
  Buffer.from(disc).copy(buf, 0);
  new PublicKey(vault).toBuffer().copy(buf, 8);
  buf.writeBigInt64LE(BigInt(lastHeartbeat), 8 + 32);
  return buf;
}

const acct = (data, owner = PROGRAM_ID) => ({ owner, data });

test('valid heartbeat parses', () => {
  const data = buildHeartbeatData({ vault: VAULT, lastHeartbeat: 1_712_345_678 });
  assert.equal(readHeartbeatFromAccount(acct(data), VAULT), 1_712_345_678);
});

test('wrong discriminator rejected', () => {
  const data = buildHeartbeatData({ disc: Buffer.alloc(8, 0), vault: VAULT });
  assert.equal(readHeartbeatFromAccount(acct(data), VAULT), null);
});

test('wrong owner rejected', () => {
  const data = buildHeartbeatData({ vault: VAULT });
  const wrongOwner = new PublicKey(Buffer.alloc(32, 1));
  assert.equal(readHeartbeatFromAccount(acct(data, wrongOwner), VAULT), null);
});

test('stored vault mismatch rejected', () => {
  const data = buildHeartbeatData({ vault: VAULT }); // stores VAULT
  const otherVault = new PublicKey(Buffer.alloc(32, 9)).toBase58();
  assert.equal(readHeartbeatFromAccount(acct(data), otherVault), null);
});

test('short buffer rejected', () => {
  const short = Buffer.concat([HEARTBEAT_DISC, Buffer.alloc(10)]); // < 8+32+8
  assert.equal(readHeartbeatFromAccount(acct(short), VAULT), null);
});

test('null account rejected', () => {
  assert.equal(readHeartbeatFromAccount(null, VAULT), null);
});
