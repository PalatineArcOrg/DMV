// Registration-auth transition controller (WP4). Pure + clock-injected. Governs
// the time-bounded legacy-acceptance window in `dual` mode with a ONE-WAY
// in-process latch: once expiry is observed, legacy writes stay closed for the
// life of the process even if the system clock jumps backwards. Signed requests
// are never affected. Not persisted to the registration DB.
//
// `mode` is the resolved auth mode ('legacy'|'dual'|'signed'); `legacyAcceptUntil`
// is a Unix-seconds number or null (parsed + validated by config.js);
// `now()` returns Unix seconds; `onFirstExpiry(ts)` (optional) fires EXACTLY once
// the first time expiry is observed (dual only).
export function makeTransitionController({ mode, legacyAcceptUntil, now, onFirstExpiry }) {
  const clock = typeof now === 'function' ? now : () => Math.floor(Date.now() / 1000);
  const until = typeof legacyAcceptUntil === 'number' ? legacyAcceptUntil : null;
  let expiredLatched = false;
  let firstExpiryAt = null;

  function get() {
    const t = clock();
    // One-way latch: observe expiry once, then it can never reopen.
    if (mode === 'dual' && until != null && !expiredLatched && t >= until) {
      expiredLatched = true;
      firstExpiryAt = t;
      try {
        onFirstExpiry?.(t);
      } catch {
        /* observer must never break the controller */
      }
    }
    const legacyAccepting =
      mode === 'legacy'
        ? true
        : mode === 'dual' && until != null && !expiredLatched && t < until;
    const effectiveMode =
      mode === 'signed' ? 'signed' : mode === 'legacy' ? 'legacy' : legacyAccepting ? 'dual' : 'signed';
    const legacyWindowExpired = mode === 'dual' && expiredLatched;
    const secondsUntilLegacyClose =
      mode === 'dual' && until != null && !expiredLatched ? Math.max(0, until - t) : 0;
    return {
      configuredMode: mode,
      effectiveMode,
      legacyAccepting,
      legacyAcceptUntil: until,
      legacyWindowExpired,
      secondsUntilLegacyClose,
    };
  }

  return { get, firstExpiryAt: () => firstExpiryAt };
}
