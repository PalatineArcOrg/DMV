// Keeper run-loop (Phase 2). Deliberately has NO blanket try/catch: runOnce() converts EXPECTED
// operational failures (network/program/balance/per-vault crank) into a boolean result at its LOCAL
// boundaries, so any exception that escapes runOnce is a genuine UNEXPECTED fault → it propagates to
// the fail-closed process guard (installFatalGuards → redacted fatal log + exit 1), stopping the
// scheduler instead of cranking on with possibly-inconsistent state. Injectable for unit tests.
export async function runLoop({ runOnce, sleep, pollMs, nextBackoff }) {
  let backoffAttempt = 0;
  for (;;) {
    const ok = await runOnce(); // no catch — unexpected throws escape to the fatal guard
    if (ok) backoffAttempt = 0;
    const wait = ok ? pollMs : nextBackoff(++backoffAttempt, { baseMs: 1000, maxMs: 60000 });
    await sleep(wait);
  }
}
