// Minimal fixture exercising the REAL installFatalGuards() (Phase 2 fatal-handler tests).
// Usage: node fatal-fixture.mjs <reject|throw|contained>
import { installFatalGuards } from '../../src/fatalGuards.js';

const mode = process.argv[2];
const submitTx = () => console.log('TX_SUBMITTED'); // a "transaction submission" mock

installFatalGuards({ label: 'notify' });

// A "later poll/crank" callback that would submit a tx — it must NOT run after a fatal fault
// (the process must exit(1) first).
setTimeout(() => {
  console.log('LATER_CALLBACK_RAN');
  submitTx();
}, 800);

if (mode === 'reject') {
  Promise.reject(new Error('injected_unhandled_rejection'));
} else if (mode === 'throw') {
  setImmediate(() => {
    throw new Error('injected_uncaught_exception');
  });
} else if (mode === 'secret') {
  // A secret-bearing exception — the fatal log MUST NOT leak these values.
  Promise.reject(new Error('request failed: https://rpc.example.com/?api-key=supersecret token=abc123 password=hunter2 Bearer zzztoken'));
} else if (mode === 'contained') {
  // Expected operational errors caught at LOCAL boundaries (mirrors the poller/executor/route
  // try-catch) → must NOT trip the fatal guard; the process survives and exits 0.
  try {
    throw new Error('injected_local_executor_error');
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
