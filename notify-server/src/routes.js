// Testable admin route handlers (Phase 2). Extracted from server.js so the readiness→submission
// wiring is unit-testable WITHOUT booting the HTTP server / monitor / poller: the guarantee under
// test is that /execute-now hands runExecutor a LIVE fail-closed guard (re-reads readiness before
// every submission), never a constant `true`, and that both routes 503 when their domain is down.

/**
 * POST /execute-now — manually crank one vault's distribution.
 * Deps are injected: `readiness` (live singleton), `executorReady()` (static config), `runExecutor`,
 * `isPubkey`, and `logError`. The handler passes `canSubmit: () => readiness.executorReady` so the
 * executor aborts remaining txs the instant readiness is revoked mid-crank.
 */
export function makeExecuteNowHandler({ readiness, executorReady, runExecutor, isPubkey, logError }) {
  return async (req, res) => {
    const { vault } = req.body || {};
    if (!isPubkey(vault)) return res.status(400).json({ error: 'invalid vault pubkey' });
    if (!executorReady()) return res.status(503).json({ error: 'executor not configured' });
    // Gate the START on the live executor readiness…
    if (!readiness.executorReady) return res.status(503).json({ error: 'executor not ready' });
    try {
      // …and hand the crank a LIVE guard so EVERY submission (incl. ATA creation) re-checks it. A
      // runtime MISMATCH/degrade that clears executorReady mid-crank suppresses the rest cleanly.
      const r = await runExecutor(vault, { canSubmit: () => readiness.executorReady });
      // A crank that ABORTED because readiness was revoked mid-run did NOT distribute — report it as a
      // failure (503), not a success. Reporting ok:true here would let a caller believe the vault was
      // cranked when it was not.
      if (r?.action === 'aborted_readiness_revoked') {
        // ...r first so ok/error always win even if the aborted result ever grows those fields.
        return res.status(503).json({ ...r, ok: false, error: 'readiness revoked mid-execution' });
      }
      res.json({ ok: true, ...r });
    } catch (e) {
      // Do NOT echo the raw error: web3/Anchor messages can embed the RPC URL (Helius api-key).
      if (logError) logError(vault, e);
      res.status(500).json({ ok: false, error: 'execution failed' });
    }
  };
}

/**
 * POST /poll-now — manual poll trigger. Refuses unless the network is positively VERIFIED (never poll
 * on an UNKNOWN/MISMATCH cluster, even via the admin trigger).
 */
export function makePollNowHandler({ readiness, pollOnce }) {
  return async (req, res) => {
    if (!readiness.networkVerified) return res.status(503).json({ ok: false, error: 'network not verified' });
    try {
      const r = await pollOnce();
      res.json({ ok: true, ...r });
    } catch {
      res.status(500).json({ ok: false, error: 'poll failed' });
    }
  };
}
