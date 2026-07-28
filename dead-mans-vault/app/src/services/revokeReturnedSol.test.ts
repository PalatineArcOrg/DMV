// computeReturnedSol — the cosmetic returned-SOL math for a revoke MUST fail soft.
// The key regression: a post-close balance read that throws (e.g. a 429 on the default RPC)
// must NOT propagate — otherwise revokeVault rejects a successful on-chain close and the
// caller skips notification reconciliation, leaving a stale "enabled". `node --test` compatible.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeReturnedSol } from './revokeReturnedSol.ts';

const LPS = 1_000_000_000;

test('REGRESSION: a throwing balance read (429) does NOT propagate → {0,0}, no throw', async () => {
  const r = await computeReturnedSol(
    async () => { throw new Error('429: Connection rate limits exceeded'); },
    1_000_000_000, // before known
    0,
    LPS,
  );
  assert.deepEqual(r, { totalReturnedSol: 0, vaultReturnedSol: 0 });
});

test('missing baseline (ownerBalBefore null) → {0,0}', async () => {
  const r = await computeReturnedSol(async () => 2_000_000_000, null, 0, LPS);
  assert.deepEqual(r, { totalReturnedSol: 0, vaultReturnedSol: 0 });
});

test('normal case computes total and subtracts the agent refund for vaultReturned', async () => {
  // before 1 SOL, after 2.5 SOL → total 1.5; agent refunded 0.5 → vault 1.0
  const r = await computeReturnedSol(async () => 2_500_000_000, 1_000_000_000, 0.5, LPS);
  assert.equal(r.totalReturnedSol, 1.5);
  assert.equal(r.vaultReturnedSol, 1.0);
});

test('after < before → total clamps to 0 (never negative)', async () => {
  const r = await computeReturnedSol(async () => 900_000_000, 1_000_000_000, 0, LPS);
  assert.equal(r.totalReturnedSol, 0);
  assert.equal(r.vaultReturnedSol, 0);
});

test('agent refund larger than total → vaultReturned clamps to 0', async () => {
  const r = await computeReturnedSol(async () => 1_100_000_000, 1_000_000_000, 5, LPS);
  assert.equal(r.totalReturnedSol, 0.1);
  assert.equal(r.vaultReturnedSol, 0); // 0.1 - 5 clamped
});

test('non-finite / non-positive lamportsPerSol → {0,0} (no divide-by-zero / NaN)', async () => {
  assert.deepEqual(await computeReturnedSol(async () => 2e9, 1e9, 0, 0), { totalReturnedSol: 0, vaultReturnedSol: 0 });
  assert.deepEqual(await computeReturnedSol(async () => 2e9, 1e9, 0, Number.NaN), { totalReturnedSol: 0, vaultReturnedSol: 0 });
});

test('a NaN balance reading → {0,0} (fail soft, never NaN out)', async () => {
  const r = await computeReturnedSol(async () => Number.NaN, 1e9, 0, LPS);
  assert.deepEqual(r, { totalReturnedSol: 0, vaultReturnedSol: 0 });
});
