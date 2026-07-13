// Keeper run-loop integration tests (Phase 2, Blocker 5). Spawns the loop fixture and proves the real
// loop degrades+retries on a classified transient failure but lets an UNEXPECTED exception reach the
// fail-closed process guard (exit 1, no subsequent tick/crank).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = resolve(here, 'fixtures/loop-fixture.mjs');

function run(mode) {
  return new Promise((res) => {
    execFile('node', [fixture, mode], { timeout: 10000 }, (err, stdout, stderr) => {
      // Surface ONLY a genuine numeric exit code. A TIMEOUT/kill (a fixture that logs FATAL but hangs)
      // and a SPAWN error (ENOENT/EACCES → string err.code) must NOT be coerced to 1 — else they would
      // falsely satisfy the "exits 1 on an unexpected fault" assertion instead of proving a real exit.
      const timedOut = !!(err && err.killed && err.signal);
      const code = err ? (typeof err.code === 'number' ? err.code : null) : 0;
      res({ code, timedOut, spawnError: typeof err?.code === 'string' ? err.code : null, stdout, stderr });
    });
  });
}

test('keeper loop: a classified transient failure degrades + retries (stays alive)', async () => {
  const r = await run('transient');
  assert.equal(r.code, 0);
  assert.match(r.stdout, /TICK 1/);
  assert.match(r.stdout, /TICK 2/);
  assert.match(r.stdout, /TICK 3/);
  assert.match(r.stdout, /RETRIED_OK/);
  assert.doesNotMatch(r.stderr, /FATAL/);
});

test('keeper loop: an unexpected exception exits 1; no subsequent tick/crank', async () => {
  const r = await run('unexpected');
  assert.equal(r.code, 1);
  assert.equal(r.timedOut, false);   // a genuine exit, not a hang killed by the timeout
  assert.equal(r.spawnError, null);  // ...and not a spawn failure masquerading as exit 1
  assert.match(r.stderr, /\[keeper\] FATAL/);
  assert.match(r.stdout, /TICK 1/);
  assert.match(r.stdout, /TICK 2/);
  assert.doesNotMatch(r.stdout, /TICK 3/, 'no subsequent tick after the unexpected fault');
});
