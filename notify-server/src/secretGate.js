// Shared-secret gates (WP3), split so registration auth and admin auth use
// SEPARATE secrets and headers. Pure + dependency-injected → unit-testable with no
// server. Constant-time comparison avoids a timing side-channel. Secrets are never
// logged, returned, or fingerprinted.
import { timingSafeEqual } from 'node:crypto';

/** Constant-time string equality. Returns false on type/length mismatch. */
export function constantTimeEqual(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string') return false;
  if (provided.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  } catch {
    return false;
  }
}

/**
 * Legacy registration secret check (x-dmv-secret ONLY). Returns (req) => boolean.
 * With no secret configured it returns false — the legacy path is never opened by
 * this check (dev "open" behaviour is a MODE decision, handled by the route, not a
 * secret bypass here). This header is NEVER accepted for admin routes.
 */
export function makeLegacySecretCheck(secret) {
  return (req) => {
    if (!secret) return false;
    return constantTimeEqual(req.get('x-dmv-secret'), secret);
  };
}

/**
 * Admin gate middleware for /poll-now, /execute-now, /debug/push. Uses a DEDICATED
 * header (x-dmv-admin-secret) and the server-only ADMIN_SECRET. The legacy
 * x-dmv-secret is never accepted here. Malformed/wrong → generic 401. A per-IP
 * admin-attempt rate limit bounds secret-guessing. In explicit development with no
 * admin secret configured, a deliberate local bypass is allowed.
 */
export function makeAdminGate({ adminSecret, isDev, limiter, clientIp }) {
  return (req, res, next) => {
    if (limiter) {
      const ip = clientIp ? clientIp(req) : req.ip || 'unknown';
      const rl = limiter.checkAdminIp(ip);
      if (!rl.ok) {
        res.set('retry-after', String(rl.retryAfter));
        return res.status(429).json({ error: 'rate limited' });
      }
    }
    if (!adminSecret) {
      // Deliberate local-dev bypass ONLY; production boot requires ADMIN_SECRET
      // (assertRegistrationAuthConfig), so this branch is unreachable in prod.
      if (isDev) return next();
      return res.status(401).json({ error: 'unauthorized' });
    }
    if (constantTimeEqual(req.get('x-dmv-admin-secret'), adminSecret)) return next();
    return res.status(401).json({ error: 'unauthorized' });
  };
}
