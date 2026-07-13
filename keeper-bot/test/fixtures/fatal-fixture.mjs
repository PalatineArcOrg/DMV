// Minimal keeper fixture exercising the REAL installFatalGuards() (Phase 2 fatal-handler tests).
// Usage: node fatal-fixture.mjs <reject|throw|contained>. Does NOT import the crank.
import { installFatalGuards } from '../../src/fatalGuards.js';

const mode = process.argv[2];
const crankTx = () => console.log('CRANK_SUBMITTED'); // a "crank submission" mock

installFatalGuards({ label: 'keeper' });

// A "later crank tick" that would submit a tx — must NOT run after a fatal fault.
setTimeout(() => {
  console.log('LATER_TICK_RAN');
  crankTx();
}, 800);

if (mode === 'reject') {
  Promise.reject(new Error('injected_unhandled_rejection'));
} else if (mode === 'throw') {
  setImmediate(() => {
    throw new Error('injected_uncaught_exception');
  });
} else if (mode === 'secret') {
  Promise.reject(new Error('request failed: https://rpc.example.com/?api-key=supersecret token=abc123 password=hunter2 Bearer zzztoken'));
} else if (mode === 'contained') {
  try {
    throw new Error('injected_local_crank_error');
  } catch (e) {
    console.log(`CONTAINED ${e.message}`);
  }
  (async () => {
    try {
      await Promise.reject(new Error('injected_local_rpc_error'));
    } catch {
      console.log('CONTAINED_ASYNC');
    }
    console.log('SURVIVED');
    process.exit(0);
  })();
}
