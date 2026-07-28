// Centralized config from environment. Loaded via `node --env-file=.env`.
import { readFileSync } from 'node:fs';
import { createPrivateKey, sign } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { NOTIFY_AUDIENCE } from './authMessage.js';

// Only an explicit NODE_ENV=development is treated as "dev mode". Anything else
// (including unset) is treated as production, so the fail-closed secret check
// below applies by default.
export const isDev = process.env.NODE_ENV === 'development';

// Canonical Solana genesis hashes per cluster — the ground truth for verifying an RPC is
// serving the cluster this deploy expects (never inferred from the URL string). See
// classifyNetwork() in solana.js.
export const GENESIS_HASHES = {
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  'mainnet-beta': '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
};

// Per-cluster minimum/warning cranker balances (SOL). The MAINNET floor must NOT block the existing
// DEVNET keeper/cranker (which floats ~0.05–0.16 SOL), so devnet defaults are lower.
const _cluster = process.env.EXPECTED_CLUSTER || 'devnet';
// Trim BEFORE the empty check: a whitespace-only value (e.g. MIN_CRANKER_BALANCE_SOL='  ') is not ''
// so Number('  ')===0 would silently DISABLE a funding floor and still pass assertSecureConfig's
// non-neg check. Treating whitespace-only as empty → the default keeps the floor intact.
const _num = (v, dflt) => {
  const s = typeof v === 'string' ? v.trim() : v;
  return s === undefined || s === '' ? dflt : Number(s);
};

export const config = {
  rpcUrl: process.env.RPC_URL || 'https://api.devnet.solana.com',
  expectedCluster: process.env.EXPECTED_CLUSTER || 'devnet',
  programId: process.env.PROGRAM_ID || 'GXCu5964mvgAJDWmcMriZpzU3vDVqPzjYCM1sxCnsoEb',
  port: parseInt(process.env.PORT || '8787', 10),
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || '60000', 10),
  dbPath: process.env.DB_PATH || new URL('../data/registrations.db', import.meta.url).pathname,
  registerSecret: process.env.REGISTER_SECRET || '',
  // Registration authentication mode (WP3): legacy | dual | signed. Raw here;
  // resolveAuthMode()/assertRegistrationAuthConfig() validate it fail-closed at boot.
  registrationAuthMode: process.env.REGISTRATION_AUTH_MODE || '',
  // Server-only admin secret for /poll-now, /execute-now, /debug/push. SEPARATE from
  // REGISTER_SECRET (which is legacy-registration only). Never exposed in health/logs.
  adminSecret: process.env.ADMIN_SECRET || '',
  // The V2 signed-message audience is a FIXED constant, never an env-controlled value.
  expectedAudience: NOTIFY_AUDIENCE,
  // Time-bounded legacy-acceptance cutoff (WP4), Unix seconds. Raw here; parsed +
  // validated (mode-specific) in assertRegistrationAuthConfig. Governs only pure
  // legacy register/deregister in dual mode.
  legacyAcceptUntilRaw: process.env.REGISTRATION_LEGACY_ACCEPT_UNTIL ?? '',
  fcmProjectId: process.env.FCM_PROJECT_ID || '',
  fcmServiceAccountPath: process.env.FCM_SERVICE_ACCOUNT || '',
  // Permissionless executor: keyless crank that distributes a vault's assets
  // once its grace period elapses. Pays its own fees from CRANKER_KEYPAIR.
  executorEnabled: process.env.EXECUTOR_ENABLED === '1',
  crankerKeypairPath: process.env.CRANKER_KEYPAIR || '',
  // Deliberate opt-out of the mainnet "executor must be on" guard, for a notify-only mainnet
  // deploy that delegates cranking to the independent keeper-bot (the documented two-cranker
  // model). Must be set explicitly so a crankerless mainnet can't ship by accident.
  allowNoExecutor: process.env.ALLOW_NO_EXECUTOR === '1',
  // Optional pin: if set, the loaded cranker keypair's pubkey MUST equal this (guards a
  // wrong/rotated keypair file silently signing).
  expectedCrankerPubkey: process.env.EXPECTED_CRANKER_PUBKEY || '',
  // Operational-readiness thresholds (Phase 2). Balances in SOL; NaN/negative/∞ rejected by
  // assertSecureConfig. Mainnet floor 0.10; devnet lower so the live keeper isn't blocked.
  minCrankerBalanceSol: _num(process.env.MIN_CRANKER_BALANCE_SOL, _cluster === 'mainnet-beta' ? 0.1 : 0.02),
  warnCrankerBalanceSol: _num(process.env.WARN_CRANKER_BALANCE_SOL, _cluster === 'mainnet-beta' ? 0.2 : 0.05),
  // FCM is a mandatory escalation dependency on mainnet unless explicitly waived (notify-disabled deploy).
  allowNoFcm: process.env.ALLOW_NO_FCM === '1',
  // Require the on-chain program account to be executable during readiness checks (default on).
  requireProgramExecutable: process.env.REQUIRE_PROGRAM_EXECUTABLE !== '0',
  // Poll-cycle health thresholds. A cycle is a healthy read only if ALL of:
  //   readErrors <= POLL_MAX_FAILURE_ABS  AND  readErrors/checked <= POLL_MAX_FAILURE_RATIO  AND  >=1 read succeeded.
  // (POLL_MAX_FAILURE_ABS is a CAP, not a tolerance floor — see isPollCycleHealthy.) Conservative
  // defaults 0.05 / 2 suit a small fleet; RAISE the abs cap for a large fleet.
  pollMaxFailureRatio: _num(process.env.POLL_MAX_FAILURE_RATIO, 0.05),
  pollMaxFailureAbs: _num(process.env.POLL_MAX_FAILURE_ABS, 2),
};

// Lamports views of the balance thresholds (safe after assertSecureConfig validates the numbers).
export const crankerLamports = () => ({
  min: Math.round(config.minCrankerBalanceSol * 1e9),
  warn: Math.round(config.warnCrankerBalanceSol * 1e9),
});

/**
 * Fail-closed guard, called at startup. The write endpoints (register,
 * deregister, poll-now, execute-now, debug/push) are gated by REGISTER_SECRET;
 * an empty secret opens them. Refuse to boot without a secret unless the
 * operator explicitly opted into dev mode (NODE_ENV=development) — so a
 * production misconfiguration cannot silently expose those endpoints.
 */
export function assertSecureConfig() {
  // Legacy/dual registration is gated by REGISTER_SECRET; signed mode needs no
  // shared secret (owner signatures replace it), so a signed-mode deploy may boot
  // without one. The full mode matrix is validated in assertRegistrationAuthConfig().
  if (!config.registerSecret && !isDev && config.registrationAuthMode !== 'signed') {
    throw new Error(
      'REGISTER_SECRET is not set. Refusing to start with unauthenticated write ' +
        'endpoints. Set REGISTER_SECRET in .env, or set NODE_ENV=development to ' +
        'allow open endpoints for local development only.',
    );
  }
  // Cluster must be a known value (guards the "mainnet" vs "mainnet-beta" typo — the latter
  // is Solana's actual cluster id). This is the sync half; the genesis-hash check that
  // confirms the RPC actually serves it is classifyNetwork() in solana.js (async).
  if (!GENESIS_HASHES[config.expectedCluster]) {
    throw new Error(
      `Invalid EXPECTED_CLUSTER "${config.expectedCluster}" — must be "devnet" or "mainnet-beta".`,
    );
  }
  // Program ID must be a valid pubkey — a malformed PROGRAM_ID is a global static failure.
  try {
    new PublicKey(config.programId); // eslint-disable-line no-new
  } catch {
    throw new Error(`Invalid PROGRAM_ID "${config.programId}" — not a valid base58 pubkey.`);
  }
  if (config.expectedCrankerPubkey) {
    try {
      new PublicKey(config.expectedCrankerPubkey); // eslint-disable-line no-new
    } catch {
      throw new Error('Invalid EXPECTED_CRANKER_PUBKEY — not a valid base58 pubkey.');
    }
  }
  // Strict numeric validation: reject NaN / negative / non-finite / out-of-range thresholds.
  const checkInt = (v, name, min, max) => {
    if (!Number.isInteger(v) || v < min || v > max) {
      throw new Error(`Invalid ${name} (${v}) — must be an integer in [${min}, ${max}].`);
    }
  };
  // A SOL threshold must survive the `* 1e9` lamport conversion used by crankerLamports(): a positive
  // value below half a lamport rounds to 0 (silently disabling the floor), and a huge finite value
  // overflows to an unsafe/Infinite integer. Reject either at config time.
  const checkNonNeg = (v, name) => {
    if (!Number.isFinite(v) || v < 0) throw new Error(`Invalid ${name} (${v}) — must be a finite number >= 0.`);
    const lamports = Math.round(v * 1e9);
    if (!Number.isSafeInteger(lamports) || (v > 0 && lamports === 0)) {
      throw new Error(`Invalid ${name} (${v}) — cannot be represented safely in lamports.`);
    }
  };
  // Node's setTimeout delay is a signed 32-bit int: a value above 2^31-1 ms overflows and is silently
  // reduced to ~1ms, turning "poll rarely" into a tight RPC loop. Cap the poll interval at this bound
  // (floored at 1000ms, matching the keeper).
  const MAX_TIMER_MS = 2_147_483_647;
  checkInt(config.port, 'PORT', 1, 65535);
  checkInt(config.pollIntervalMs, 'POLL_INTERVAL_MS', 1000, MAX_TIMER_MS);
  checkNonNeg(config.minCrankerBalanceSol, 'MIN_CRANKER_BALANCE_SOL');
  checkNonNeg(config.warnCrankerBalanceSol, 'WARN_CRANKER_BALANCE_SOL');
  if (!Number.isFinite(config.pollMaxFailureRatio) || config.pollMaxFailureRatio < 0 || config.pollMaxFailureRatio > 1) {
    throw new Error(`Invalid POLL_MAX_FAILURE_RATIO (${config.pollMaxFailureRatio}) — must be a number in [0, 1].`);
  }
  checkInt(config.pollMaxFailureAbs, 'POLL_MAX_FAILURE_ABS', 0, Number.MAX_SAFE_INTEGER);
  if (config.warnCrankerBalanceSol < config.minCrankerBalanceSol) {
    throw new Error(
      `WARN_CRANKER_BALANCE_SOL (${config.warnCrankerBalanceSol}) must be >= MIN_CRANKER_BALANCE_SOL (${config.minCrankerBalanceSol}).`,
    );
  }
  // Mainnet must verify the program is executable during readiness — it must never report ready with
  // a non-executable program. Relaxation (REQUIRE_PROGRAM_EXECUTABLE=0) is only for controlled
  // non-mainnet diagnostics.
  if (config.expectedCluster === 'mainnet-beta' && !config.requireProgramExecutable) {
    throw new Error('REQUIRE_PROGRAM_EXECUTABLE must be 1 on mainnet-beta.');
  }
  // On mainnet the autonomous executor must be enabled + funded, or the notify-server has no
  // server-side cranker for the dead-man's switch. Fail closed rather than silently ship a
  // mainnet deploy whose switch can't fire. A deliberate notify-only deploy that delegates
  // cranking to the independent keeper-bot can opt out with ALLOW_NO_EXECUTOR=1.
  if (
    config.expectedCluster === 'mainnet-beta' &&
    !config.executorEnabled &&
    !config.allowNoExecutor
  ) {
    throw new Error(
      'EXPECTED_CLUSTER=mainnet-beta requires EXECUTOR_ENABLED=1 (+ a funded CRANKER_KEYPAIR) ' +
        'so the autonomous switch can fire on mainnet. If cranking is delegated to a separate ' +
        'keeper-bot, set ALLOW_NO_EXECUTOR=1 to acknowledge this deploy is notify-only.',
    );
  }
  // FCM is a mandatory escalation dependency on mainnet unless explicitly waived. Validate the
  // service account STATICALLY (before app.listen) so a missing / unreadable / malformed / incomplete
  // credential fails CLOSED — rather than silently booting a mainnet server that can never push an
  // escalation (loadServiceAccount returns null for all of those, which the runtime treats as merely
  // "degraded"). Provider/token endpoint outages AFTER a valid static config remain runtime-degraded
  // (fcm.js probe/send), not a boot failure.
  if (config.expectedCluster === 'mainnet-beta' && !config.allowNoFcm) {
    const sa = loadServiceAccount();
    if (!sa) {
      throw new Error(
        'FCM service account missing/unreadable/malformed on mainnet-beta. Set FCM_SERVICE_ACCOUNT to ' +
          'a valid Firebase service-account JSON, or ALLOW_NO_FCM=1 for a deliberate notify-disabled deploy.',
      );
    }
    // Require NON-EMPTY STRINGS (not merely truthy) — a whitespace-only or non-string field is unusable.
    for (const field of ['project_id', 'client_email', 'private_key']) {
      if (typeof sa[field] !== 'string' || sa[field].trim() === '') {
        throw new Error(`FCM service account "${field}" must be a non-empty string on mainnet-beta.`);
      }
    }
    // Cryptographically validate the private key: a non-empty-but-malformed PEM (which the runtime's
    // google-auth JWT cannot sign with) must FAIL before listening, not at the first push attempt.
    let fcmKey;
    try {
      fcmKey = createPrivateKey(sa.private_key);
    } catch {
      throw new Error('FCM service account "private_key" is not a valid PEM private key on mainnet-beta.');
    }
    // Google service-account OAuth signs the JWT assertion with RS256 (RSA SHA-256). A parseable but
    // NON-RSA key (e.g. Ed25519/EC) cannot produce that assertion — reject it, and self-test that the
    // RSA key can actually sign RS256, so an unusable credential fails before listening.
    if (fcmKey.asymmetricKeyType !== 'rsa') {
      throw new Error('FCM service account "private_key" must be an RSA private key for RS256 on mainnet-beta.');
    }
    try {
      sign('RSA-SHA256', Buffer.from('dmv-fcm-key-validation'), fcmKey);
    } catch {
      throw new Error('FCM service account "private_key" cannot produce an RS256 signature on mainnet-beta.');
    }
    if (config.fcmProjectId && config.fcmProjectId !== sa.project_id) {
      throw new Error(
        `FCM_PROJECT_ID (${config.fcmProjectId}) conflicts with the service-account project_id (${sa.project_id}).`,
      );
    }
  }
}

// ── Registration authentication modes (WP3) ─────────────────────────────────
// legacy: unsigned x-dmv-secret path only (dev only). dual: signed OR legacy,
// with no downgrade from a failed signed attempt. signed: owner-signed only.
export const AUTH_MODE = Object.freeze({
  LEGACY_ONLY: 'legacy',
  DUAL_ACCEPT: 'dual',
  SIGNED_REQUIRED: 'signed',
});
const VALID_AUTH_MODES = new Set(['legacy', 'dual', 'signed']);

/**
 * Resolve + validate REGISTRATION_AUTH_MODE. Fail-closed: a missing mode defaults
 * to 'legacy' ONLY under explicit NODE_ENV=development; outside dev a missing mode
 * is fatal. An unknown value is always fatal. No trim/lowercase/alias/repair.
 */
export function resolveAuthMode() {
  const raw = config.registrationAuthMode; // captured from env at import (single source)
  if (raw === undefined || raw === '') {
    if (isDev) return AUTH_MODE.LEGACY_ONLY;
    throw new Error(
      'REGISTRATION_AUTH_MODE is required (legacy|dual|signed) outside NODE_ENV=development.',
    );
  }
  if (!VALID_AUTH_MODES.has(raw)) {
    throw new Error(`Invalid REGISTRATION_AUTH_MODE "${raw}" — must be exactly legacy, dual, or signed.`);
  }
  return raw;
}

// Max future legacy-acceptance window: 30 days (WP4). A longer window is refused so
// a stale transition config can't keep legacy writes open indefinitely.
const MAX_LEGACY_WINDOW_SEC = 30 * 24 * 60 * 60;

/**
 * Parse REGISTRATION_LEGACY_ACCEPT_UNTIL (WP4). Returns null when absent/empty,
 * otherwise a canonical positive Unix-seconds integer. Rejects leading-zero, sign,
 * whitespace, fraction, exponent, date-string, and unsafe-integer forms — no
 * trimming/coercion/repair. Throws on a malformed value.
 */
export function parseLegacyAcceptUntil(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string' || !/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new Error('Invalid REGISTRATION_LEGACY_ACCEPT_UNTIL — must be a canonical positive Unix-seconds integer.');
  }
  return Number(raw);
}

/**
 * Fail-closed boot validation of the registration-auth surface. Called at boot
 * AFTER assertSecureConfig()/executor static config (so pre-existing static faults
 * surface first). Enforces the full mode/cluster/secret matrix + the WP4 legacy
 * window. Throws (→ exit 1) on any violation. Error messages never contain a
 * secret value. `now()` (Unix seconds) is injectable for tests.
 */
export function assertRegistrationAuthConfig({ now = () => Math.floor(Date.now() / 1000) } = {}) {
  const mode = resolveAuthMode();

  // legacy is a development-only convenience — never a production posture.
  if (mode === AUTH_MODE.LEGACY_ONLY && !isDev) {
    throw new Error('REGISTRATION_AUTH_MODE=legacy is only permitted with NODE_ENV=development.');
  }
  // Mainnet must run signed-only — no legacy/dual downgrade window on mainnet.
  if (config.expectedCluster === 'mainnet-beta' && mode !== AUTH_MODE.SIGNED_REQUIRED) {
    throw new Error('REGISTRATION_AUTH_MODE must be "signed" on mainnet-beta.');
  }
  // legacy/dual accept the shared secret path → they require a non-empty secret.
  // signed mode needs none (owner signatures replace it).
  if ((mode === AUTH_MODE.LEGACY_ONLY || mode === AUTH_MODE.DUAL_ACCEPT) && !config.registerSecret && !isDev) {
    throw new Error('REGISTER_SECRET is required for REGISTRATION_AUTH_MODE=legacy or dual.');
  }
  // Every non-development deployment must have a distinct admin secret for the
  // operational routes (/poll-now, /execute-now, /debug/push).
  if (!config.adminSecret && !isDev) {
    throw new Error('ADMIN_SECRET is required outside NODE_ENV=development.');
  }
  if (config.adminSecret && config.registerSecret && config.adminSecret === config.registerSecret) {
    throw new Error('ADMIN_SECRET must not equal REGISTER_SECRET.');
  }
  // Trusted V2 authorization context must be complete + canonical.
  if (!GENESIS_HASHES[config.expectedCluster]) {
    throw new Error('Registration auth requires a valid EXPECTED_CLUSTER (devnet|mainnet-beta).');
  }
  try {
    new PublicKey(config.programId); // eslint-disable-line no-new
  } catch {
    throw new Error('Registration auth requires a valid PROGRAM_ID.');
  }
  if (config.expectedAudience !== NOTIFY_AUDIENCE) {
    throw new Error('Registration auth audience must equal the approved constant.');
  }

  // ── WP4: legacy-acceptance window (mode-specific) ──────────────────────────
  // Ordered LAST so the WP3 boot/config faults above always surface first.
  if (mode === AUTH_MODE.DUAL_ACCEPT) {
    const until = parseLegacyAcceptUntil(config.legacyAcceptUntilRaw); // throws on malformed
    if (until === null) {
      throw new Error('REGISTRATION_LEGACY_ACCEPT_UNTIL is required for REGISTRATION_AUTH_MODE=dual.');
    }
    const t = now();
    if (until > t && until - t > MAX_LEGACY_WINDOW_SEC) {
      throw new Error('REGISTRATION_LEGACY_ACCEPT_UNTIL must be at most 30 days in the future.');
    }
    // An already-expired cutoff is allowed: the server boots effective signed-only.
  } else {
    // signed + (dev) legacy must NOT carry a cutoff — a non-empty value is a stale
    // transition config and is fatal.
    if (config.legacyAcceptUntilRaw !== '') {
      throw new Error(`REGISTRATION_LEGACY_ACCEPT_UNTIL must be absent for REGISTRATION_AUTH_MODE=${mode}.`);
    }
  }
}

// Lazily load the service account so the server can boot (and serve /health)
// even before the Firebase files are provided.
export function loadServiceAccount() {
  if (!config.fcmServiceAccountPath) return null;
  try {
    return JSON.parse(readFileSync(config.fcmServiceAccountPath, 'utf8'));
  } catch {
    return null;
  }
}
