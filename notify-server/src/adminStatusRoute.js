// Admin-only registration-auth status endpoint (WP4). Read-only: reports the
// transition state, aggregate migration counts, transition-readiness, and the
// fixed metrics snapshot. Performs NO mutation and exposes NO row/owner/vault/
// token/hash/nonce/signature/secret/RPC-URL. Mounted behind the ADMIN_SECRET gate
// + admin IP limiter by server.js.
export function makeRegistrationAuthStatusHandler({ transition, migrationCounts, metrics, now }) {
  const clock = typeof now === 'function' ? now : () => Math.floor(Date.now() / 1000);
  return (req, res) => {
    const ts = transition.get();
    const c = migrationCounts();
    const signedPercent = c.total === 0 ? 100 : Math.round((c.signed / c.total) * 1000) / 10;
    const blockers = [];
    if (c.legacy > 0) blockers.push('legacy_registrations_remaining');
    if (c.anomalous > 0) blockers.push('anomalous_registration_metadata');
    const readyForSignedMode = c.legacy === 0 && c.anomalous === 0;
    const snapshotAt = clock();
    const snap = metrics.snapshot(snapshotAt);
    res.status(200).json({
      configuredMode: ts.configuredMode,
      effectiveMode: ts.effectiveMode,
      legacyAccepting: ts.legacyAccepting,
      legacyAcceptUntil: ts.legacyAcceptUntil,
      legacyWindowExpired: ts.legacyWindowExpired,
      secondsUntilLegacyClose: ts.secondsUntilLegacyClose,
      registrations: { ...c, signedPercent },
      transition: { readyForSignedMode, blockers },
      metrics: snap,
      processStartedAt: snap ? snap.processStartedAt : null,
      snapshotAt,
    });
  };
}
