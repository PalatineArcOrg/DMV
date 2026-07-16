// Pure keeper run-once orchestration (Phase 2, Blocker 3). Injectable so the readiness→scan→crank
// DECISION flow is unit-testable without a live RPC. index.js supplies the real gate()/tick()/exit.
//
// Returns TRUE only for a COMPLETED pass (a scan ran to completion). A degraded gate, a SCAN FAILURE
// (the bug being fixed — previously reported as success), or a mid-tick readiness revocation all
// return FALSE → the loop uses degraded backoff and `--once` exits non-zero. A fatal gate calls
// exit() (process.exit(1) in prod, a spy in tests) and returns false.
export async function runKeeperOnce({ gate, tick, exit, setLive, onDegraded, onReady, onFatal }) {
  const g = await gate();
  if (g.fatal) {
    if (onFatal) onFatal(g);
    exit(g);
    return false;
  }
  if (!g.ok) {
    if (onDegraded) onDegraded(g.reason || 'degraded');
    return false;
  }
  if (onReady) onReady(g);
  if (setLive) setLive(true); // gate passed → allow cranking this tick (per-vault reverify refines it)

  const t = await tick();
  // A scan failure or a mid-tick halt is NOT a completed pass — must NOT be reported as success.
  if (t.scanFailed) {
    if (onDegraded) onDegraded('scan_failed');
    return false;
  }
  if (!t.ok) {
    if (onDegraded) onDegraded(t.reason || 'halted');
    return false;
  }
  return true;
}
