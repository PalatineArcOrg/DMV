// Registration-auth metrics collector (WP4). In-memory, process-local,
// clock-injected, FIXED cardinality, synchronous, and NO-THROW. It never derives
// a metric key from an attacker-controlled string, never stores a token/owner/
// vault/nonce/signature, and never persists to SQLite. A metrics failure must
// never alter route behaviour, so every method swallows its own errors.
//
// Counters reset on process restart (documented, intentional).

// The ONLY failure codes that get their own counter. Anything else → `other`.
const FAILURE_CODES = [
  'invalid_request',
  'invalid_signature',
  'stale_timestamp',
  'context_mismatch',
  'nonce_reused',
  'ownership_failed',
  'signed_not_enabled',
  'signed_required',
  'legacy_window_expired',
  'signed_authorization_required',
  'stale_revision',
  'owner_conflict',
  'rate_limited',
  'dependency_unavailable',
  'database_error',
];

function zeroFailureCodes() {
  const o = {};
  for (const c of FAILURE_CODES) o[c] = 0;
  o.other = 0;
  return o;
}

export function makeAuthMetrics({ now, startedAt } = {}) {
  const clock = typeof now === 'function' ? now : () => Math.floor(Date.now() / 1000);
  const processStartedAt = typeof startedAt === 'number' ? startedAt : clock();

  const register = {
    signedAttempts: 0, signedCreated: 0, signedUpdated: 0, signedRejected: 0,
    legacyAttempts: 0, legacySucceeded: 0, legacyRejected: 0, legacyExpired: 0, stickinessBlocks: 0,
  };
  const deregister = {
    signedAttempts: 0, signedRemoved: 0, signedIdempotent: 0, signedRejected: 0,
    legacyAttempts: 0, legacyRemoved: 0, legacyRejected: 0, legacyExpired: 0, stickinessBlocks: 0,
  };
  const security = {
    downgradeBlocked: 0, rateLimited: 0, dependencyUnavailable: 0, databaseError: 0,
    nonceReused: 0, staleRevision: 0, ownerConflict: 0, adminAuthFailures: 0,
  };
  const failureCodes = zeroFailureCodes();
  const timestamps = {
    lastSignedRegisterAt: null,
    lastSignedDeregisterAt: null,
    lastLegacyRegisterAt: null,
    lastLegacyRejectionAt: null,
    firstLegacyExpiryAt: null,
  };

  // Increment a fixed failure-code counter (or `other`) + the matching security
  // side-counter. NEVER creates a new key.
  function bumpFailure(code) {
    if (Object.prototype.hasOwnProperty.call(failureCodes, code)) failureCodes[code] += 1;
    else failureCodes.other += 1;
    if (code === 'nonce_reused') security.nonceReused += 1;
    else if (code === 'stale_revision') security.staleRevision += 1;
    else if (code === 'owner_conflict') security.ownerConflict += 1;
    else if (code === 'dependency_unavailable') security.dependencyUnavailable += 1;
    else if (code === 'database_error') security.databaseError += 1;
  }

  const guard = (fn) => (...args) => {
    try {
      return fn(...args);
    } catch {
      return undefined; // metrics never throw into a route/fatal boundary
    }
  };

  const registerAttempt = guard((path) => {
    if (path === 'signed') register.signedAttempts += 1;
    else register.legacyAttempts += 1;
  });

  const registerResult = guard((path, code) => {
    if (path === 'signed') {
      if (code === 'created') { register.signedCreated += 1; timestamps.lastSignedRegisterAt = clock(); }
      else if (code === 'updated') { register.signedUpdated += 1; timestamps.lastSignedRegisterAt = clock(); }
      else {
        register.signedRejected += 1;
        if (code === 'signed_authorization_required') register.stickinessBlocks += 1;
        bumpFailure(code);
      }
      return;
    }
    // legacy
    if (code === 'created' || code === 'updated') {
      register.legacySucceeded += 1;
      timestamps.lastLegacyRegisterAt = clock();
    } else if (code === 'legacy_window_expired') {
      register.legacyRejected += 1;
      register.legacyExpired += 1;
      timestamps.lastLegacyRejectionAt = clock();
      bumpFailure(code);
    } else if (code === 'signed_authorization_required') {
      register.legacyRejected += 1;
      register.stickinessBlocks += 1;
      timestamps.lastLegacyRejectionAt = clock();
      bumpFailure(code);
    } else {
      register.legacyRejected += 1;
      timestamps.lastLegacyRejectionAt = clock();
      bumpFailure(code);
    }
  });

  const deregisterAttempt = guard((path) => {
    if (path === 'signed') deregister.signedAttempts += 1;
    else deregister.legacyAttempts += 1;
  });

  const deregisterResult = guard((path, code, removed) => {
    if (path === 'signed') {
      if (code === 'removed') {
        if (removed > 0) deregister.signedRemoved += 1;
        else deregister.signedIdempotent += 1;
        timestamps.lastSignedDeregisterAt = clock();
      } else {
        deregister.signedRejected += 1;
        if (code === 'signed_authorization_required') deregister.stickinessBlocks += 1;
        bumpFailure(code);
      }
      return;
    }
    // legacy
    if (code === 'removed') {
      deregister.legacyRemoved += 1;
    } else if (code === 'legacy_window_expired') {
      deregister.legacyRejected += 1;
      deregister.legacyExpired += 1;
      timestamps.lastLegacyRejectionAt = clock();
      bumpFailure(code);
    } else if (code === 'signed_authorization_required') {
      deregister.legacyRejected += 1;
      deregister.stickinessBlocks += 1;
      bumpFailure(code);
    } else {
      deregister.legacyRejected += 1;
      bumpFailure(code);
    }
  });

  const downgradeBlocked = guard(() => { security.downgradeBlocked += 1; });
  const rateLimited = guard(() => { security.rateLimited += 1; });
  const adminAuthFailure = guard(() => { security.adminAuthFailures += 1; });
  const legacyExpiryObserved = guard((ts) => {
    if (timestamps.firstLegacyExpiryAt == null) timestamps.firstLegacyExpiryAt = typeof ts === 'number' ? ts : clock();
  });

  const snapshot = guard((nowSec) => ({
    processStartedAt,
    snapshotAt: typeof nowSec === 'number' ? nowSec : clock(),
    register: { ...register },
    deregister: { ...deregister },
    security: { ...security },
    failureCodes: { ...failureCodes },
    timestamps: { ...timestamps },
  }));

  return {
    registerAttempt, registerResult, deregisterAttempt, deregisterResult,
    downgradeBlocked, rateLimited, adminAuthFailure, legacyExpiryObserved, snapshot,
  };
}
