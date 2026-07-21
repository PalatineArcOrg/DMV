// Registration route handlers (WP3): auth-mode routing, signed-attempt
// classification, rate-limit ordering, and internal-result → HTTP mapping. Pure +
// dependency-injected so the whole matrix is unit-testable with fake req/res and
// mocked authorizers/store — no server, no network, no live DB.
//
// Downgrade resistance is the security core: a request that LOOKS signed is always
// handled by the V2 path and NEVER falls back to the legacy secret path, and a
// signed row is immutable via the legacy path (stickiness lives in the store).
import { AUTH_MODE } from './config.js';
import { RESULT } from './registrationStore.js';

// Any of these own-properties on the body marks a request as a "signed attempt".
// (Deregister naturally omits `revision`, but the rest still identify the path.)
export const V2_ENVELOPE_FIELDS = [
  'version', 'cluster', 'programId', 'audience', 'action', 'revision', 'timestamp', 'nonce', 'signature',
];

export function isSignedAttempt(body) {
  if (!body || typeof body !== 'object') return false;
  return V2_ENVELOPE_FIELDS.some((f) => Object.prototype.hasOwnProperty.call(body, f));
}

// Internal result code → { status, code }. Generic; never leaks internals.
const STATUS = {
  [RESULT.CREATED]: 201,
  [RESULT.UPDATED]: 200,
  [RESULT.REMOVED]: 200,
  [RESULT.OK]: 200,
  [RESULT.INVALID_REQUEST]: 400,
  [RESULT.INVALID_SIGNATURE]: 401,
  [RESULT.STALE_TIMESTAMP]: 401,
  [RESULT.CONTEXT_MISMATCH]: 401,
  [RESULT.NONCE_REUSED]: 401,
  [RESULT.OWNERSHIP_FAILED]: 403,
  [RESULT.SIGNED_NOT_ENABLED]: 409,
  [RESULT.SIGNED_REQUIRED]: 409,
  [RESULT.SIGNED_AUTHORIZATION_REQUIRED]: 409,
  [RESULT.STALE_REVISION]: 409,
  [RESULT.OWNER_CONFLICT]: 409,
  [RESULT.RATE_LIMITED]: 429,
  [RESULT.DEPENDENCY_UNAVAILABLE]: 502,
  [RESULT.DATABASE_ERROR]: 503,
};

export function mapResultToHttp(code) {
  return { status: STATUS[code] ?? 500, code };
}

function short(s) {
  return typeof s === 'string' ? s.slice(0, 8) : '?';
}

export function makeRegistrationHandlers(deps) {
  const {
    mode, expected,
    authorizeRegisterV2, authorizeDeregisterV2, verifyOwnership, getRegistration,
    applySignedRegistration, applySignedDeregistration, applyLegacyRegistration,
    deleteLegacyRegistration, deleteLegacyRegistrationsByOwner,
    legacyOwnerVerify, legacySecretOk,
    limiter, clientIp, now, logger, tokFingerprint, sha256Hex, isPubkey,
  } = deps;

  const log = (line) => { try { logger?.log?.(line); } catch { /* logging must never throw */ } };
  const fail = (res, code, extra) => {
    const { status } = mapResultToHttp(code);
    return res.status(status).json({ ok: false, code, ...(extra || {}) });
  };
  const rate = (res, retryAfter) => {
    res.set('retry-after', String(retryAfter));
    return res.status(429).json({ ok: false, code: RESULT.RATE_LIMITED });
  };

  // Extract the rate-limit facets that are safe to derive without trusting the
  // request. tokenHash is a SHA-256 of the token (never plaintext).
  function facets(body, { withToken }) {
    const owner = isPubkey(body.owner) ? body.owner : undefined;
    const vault = isPubkey(body.vault) ? body.vault : undefined;
    let tokenHash;
    if (withToken && typeof body.deviceToken === 'string' && body.deviceToken.length > 0) {
      tokenHash = sha256Hex(body.deviceToken);
    }
    return { owner, vault, tokenHash };
  }

  async function register(req, res) {
    // 1. Per-IP window BEFORE any signature/RPC/DB work (malformed bodies still cost IP).
    const ipr = limiter.checkIp(clientIp(req));
    if (!ipr.ok) return rate(res, ipr.retryAfter);

    const body = req.body || {};
    const signed = isSignedAttempt(body);

    // 2. Facet windows BEFORE RPC/DB. Legacy + signed share these buckets.
    const fr = limiter.checkFacets(facets(body, { withToken: true }));
    if (!fr.ok) return rate(res, fr.retryAfter);

    if (signed) {
      if (mode === AUTH_MODE.LEGACY_ONLY) return fail(res, RESULT.SIGNED_NOT_ENABLED);
      // dual OR signed → V2 authorization + signed store txn. NEVER legacy fallback.
      const r = await authorizeRegisterV2(body, { expected, verifyOwnership, now });
      if (!r.ok) return fail(res, r.code);
      const t = applySignedRegistration(r.command);
      if (t.code === RESULT.CREATED || t.code === RESULT.UPDATED) {
        log(`[register] signed ${t.code} vault ${short(r.command.vault)} owner ${short(r.command.owner)} rev ${r.command.revision} mode ${mode}`);
        const { status } = mapResultToHttp(t.code);
        return res.status(status).json({ ok: true, result: t.code, revision: r.command.revision });
      }
      return fail(res, t.code);
    }

    // Pure legacy request.
    if (mode === AUTH_MODE.SIGNED_REQUIRED) return fail(res, RESULT.SIGNED_REQUIRED);
    if (!legacySecretOk(req)) return res.status(401).json({ error: 'unauthorized' });

    const { owner, vault, deviceToken, stage1, stage2, stage3 } = body;
    if (!isPubkey(owner) || !isPubkey(vault)) return res.status(400).json({ error: 'invalid owner/vault pubkey' });
    if (typeof deviceToken !== 'string' || deviceToken.length < 10) return res.status(400).json({ error: 'invalid deviceToken' });
    const s1 = Number(stage1), s2 = Number(stage2), s3 = Number(stage3);
    if (![s1, s2, s3].every((n) => Number.isFinite(n) && n > 0)) return res.status(400).json({ error: 'invalid stage durations' });

    // Ownership proof (V1 legacy path). A transport error → 502 (retryable), NOT a 403.
    let verdict;
    try {
      verdict = await legacyOwnerVerify(owner, vault);
    } catch {
      return res.status(502).json({ error: 'vault verification unavailable' });
    }
    if (!verdict.ok) return res.status(403).json({ error: 'vault verification failed' });

    const t = applyLegacyRegistration({ owner, vault, deviceToken, stage1: s1, stage2: s2, stage3: s3, now: now() });
    if (t.code === RESULT.SIGNED_AUTHORIZATION_REQUIRED) return fail(res, t.code);
    if (t.code === RESULT.DATABASE_ERROR) return fail(res, t.code);
    log(`[register] legacy ${t.code} vault ${short(vault)} owner ${short(owner)} ${tokFingerprint(deviceToken)} mode ${mode}`);
    return res.status(200).json({ ok: true }); // preserve legacy response shape for old app compat
  }

  async function deregister(req, res) {
    const ipr = limiter.checkIp(clientIp(req));
    if (!ipr.ok) return rate(res, ipr.retryAfter);

    const body = req.body || {};
    const signed = isSignedAttempt(body);

    const fr = limiter.checkFacets(facets(body, { withToken: false }));
    if (!fr.ok) return rate(res, fr.retryAfter);

    if (signed) {
      if (mode === AUTH_MODE.LEGACY_ONLY) return fail(res, RESULT.SIGNED_NOT_ENABLED);
      const r = await authorizeDeregisterV2(body, { expected, verifyOwnership, getRegistration, now });
      if (!r.ok) return fail(res, r.code);
      const t = applySignedDeregistration(r.command);
      if (t.code === RESULT.REMOVED) {
        log(`[deregister] signed removed=${t.removed} vault ${short(r.command.vault)} owner ${short(r.command.owner)} mode ${mode}`);
        return res.status(200).json({ ok: true, removed: t.removed });
      }
      return fail(res, t.code);
    }

    // Pure legacy request.
    if (mode === AUTH_MODE.SIGNED_REQUIRED) return fail(res, RESULT.SIGNED_REQUIRED);
    if (!legacySecretOk(req)) return res.status(401).json({ error: 'unauthorized' });

    const { vault, owner } = body;

    if (mode === AUTH_MODE.LEGACY_ONLY) {
      // Dev-only legacy compatibility: retain owner-wide deletion.
      if (vault && isPubkey(vault)) {
        const t = deleteLegacyRegistration({ vault });
        if (t.code === RESULT.SIGNED_AUTHORIZATION_REQUIRED) return fail(res, t.code);
        return res.status(200).json({ ok: true, removed: t.removed });
      }
      if (owner && isPubkey(owner)) {
        // Stickiness holds even here: owner-wide legacy delete skips signed rows.
        const t = deleteLegacyRegistrationsByOwner(owner);
        if (t.code === RESULT.DATABASE_ERROR) return fail(res, t.code);
        return res.status(200).json({ ok: true, removed: t.removed });
      }
      return res.status(400).json({ error: 'vault or owner required' });
    }

    // dual mode: a specific vault only; owner-wide legacy deletion is DISABLED.
    if (!vault || !isPubkey(vault)) return res.status(400).json({ error: 'vault required' });
    const t = deleteLegacyRegistration({ vault });
    if (t.code === RESULT.SIGNED_AUTHORIZATION_REQUIRED) return fail(res, t.code);
    if (t.code === RESULT.DATABASE_ERROR) return fail(res, t.code);
    return res.status(200).json({ ok: true, removed: t.removed });
  }

  return { register, deregister };
}
