// Keeper run-loop fixture (Phase 2, Blocker 5). Runs the REAL runLoop with the REAL fatal guards and
// an injected runOnce, to prove: a classified transient failure degrades + retries (stays alive);
// an UNEXPECTED exception escapes the loop to the fatal guard (exit 1, no subsequent tick).
// Usage: node loop-fixture.mjs <transient|unexpected>
import { installFatalGuards } from '../../src/fatalGuards.js';
import { runLoop } from '../../src/loop.js';

const mode = process.argv[2];
installFatalGuards({ label: 'keeper' });

let n = 0;
const runOnce = async () => {
  n++;
  console.log(`TICK ${n}`);
  if (mode === 'transient') {
    // classified operational failure → degrade (return false); loop retries with backoff
    if (n >= 3) {
      console.log('RETRIED_OK');
      process.exit(0);
    }
    return false;
  }
  if (mode === 'unexpected') {
    if (n === 1) return true; // first tick ok
    throw new Error('injected_unexpected_bug'); // 2nd tick: unexpected fault BEFORE any crank tx
  }
  return true;
};

await runLoop({
  runOnce,
  sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 15))),
  pollMs: 10,
  nextBackoff: () => 10,
});
