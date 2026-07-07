import { test } from 'node:test';
import assert from 'node:assert/strict';
import { range, chunk, unpaidIndices, fullU32Mask, fullU64Mask } from './crankMath.ts';

test('range: 0, 1, and small n', () => {
  assert.deepEqual(range(0), []);
  assert.deepEqual(range(1), [0]);
  assert.deepEqual(range(3), [0, 1, 2]);
  assert.deepEqual(range(20).length, 20);
  assert.deepEqual(range(20)[19], 19);
});

test('chunk: exact groupings at sizes 0/1/8/9/20, each group ≤ 8', () => {
  assert.deepEqual(chunk([], 8), []);
  assert.deepEqual(chunk([0], 8), [[0]]);
  // exactly one full batch
  assert.deepEqual(chunk(range(8), 8), [[0, 1, 2, 3, 4, 5, 6, 7]]);
  // 9 → 8 + 1
  assert.deepEqual(chunk(range(9), 8), [[0, 1, 2, 3, 4, 5, 6, 7], [8]]);
  // 20 beneficiaries (the max) → 8 + 8 + 4
  assert.deepEqual(chunk(range(20), 8), [
    [0, 1, 2, 3, 4, 5, 6, 7],
    [8, 9, 10, 11, 12, 13, 14, 15],
    [16, 17, 18, 19],
  ]);
  // no group ever exceeds the batch size
  for (const g of chunk(range(20), 8)) assert.ok(g.length <= 8);
});

test('unpaidIndices: empty / partial / full masks', () => {
  // nothing paid → every index owed
  assert.deepEqual(unpaidIndices(0, 3), [0, 1, 2]);
  // bits 0 and 2 set → only index 1 owed
  assert.deepEqual(unpaidIndices(0b101, 3), [1]);
  // bit 1 set → 0 and 2 owed
  assert.deepEqual(unpaidIndices(0b010, 3), [0, 2]);
  // all 3 paid → none owed
  assert.deepEqual(unpaidIndices(0b111, 3), []);
});

test('unpaidIndices: n = 20 full-mask boundary + high bits', () => {
  // fully paid at the 20-beneficiary max → none owed
  assert.deepEqual(unpaidIndices(fullU32Mask(20), 20), []);
  // nothing paid at n=20 → all 20 owed
  assert.deepEqual(unpaidIndices(0, 20), range(20));
  // only the highest bit (19) paid → 0..18 owed, not 19
  assert.deepEqual(unpaidIndices(1 << 19, 20), range(19));
  // bit 19 must be treated as paid via the unsigned shift
  assert.ok(!unpaidIndices(1 << 19, 20).includes(19));
});

test('fullU32Mask: bit 0 / 20 / 31 / 32 boundaries', () => {
  assert.equal(fullU32Mask(0), 0);
  assert.equal(fullU32Mask(1), 1);
  assert.equal(fullU32Mask(20), 0xfffff); // 1_048_575
  assert.equal(fullU32Mask(31), 0x7fffffff);
  // n=32 must NOT do 1<<32 (undefined) — clamp to all-ones u32
  assert.equal(fullU32Mask(32), 0xffffffff);
  assert.equal(fullU32Mask(33), 0xffffffff);
});

test('fullU64Mask: bit 0 / 20 / 63 / 64 boundaries', () => {
  assert.equal(fullU64Mask(0), 0n);
  assert.equal(fullU64Mask(1), 1n);
  assert.equal(fullU64Mask(20), (1n << 20n) - 1n);
  assert.equal(fullU64Mask(63), (1n << 63n) - 1n);
  // n=64 must NOT do 1n<<64n truncation issues — return full 64-bit all-ones
  assert.equal(fullU64Mask(64), 2n ** 64n - 1n);
  assert.equal(fullU64Mask(64), 0xffffffffffffffffn);
  assert.equal(fullU64Mask(65), 2n ** 64n - 1n);
});
