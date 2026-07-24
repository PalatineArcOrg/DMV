// WP5 — deliberate owner-signed notification registration coordinator.
//
// Signing happens ONLY from an explicit user action (Settings). This module is
// dependency-injected and imports ONLY packages, so it unit-tests under
// `node --test` with mocks (no wallet, no network, no expo/RN modules). The UI
// wires the real dependencies (the WP1 `registerMessageV2` builder, `generateNonceV2`,
// expo-crypto SHA-256, MWA `signMessage`, `settingsRepo`, the `/register` fetch).
//
// Hard rules enforced here: fail closed, NO auto-retry, NO legacy shared-secret
// fallback ever, exactly one signature + one request per attempt, persist the
// monotonic revision BEFORE the request, persist the success record ONLY after
// HTTP 201/200, and never place a token/signature/nonce/message/secret in stored
// state. No `console.*` — outcomes are returned, never logged.
import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { Buffer } from 'buffer';

// The audience is the fixed WP1 constant (mirrors notifyAuth.NOTIFY_AUDIENCE).
const AUDIENCE = 'https://notify.palatinearc.com';
// The DMV devnet program this build targets (mirrors constants.PROGRAM_ID; a
// static check asserts they match — see the WP5 validation).
const EXPECTED_PROGRAM_ID = 'GXCu5964mvgAJDWmcMriZpzU3vDVqPzjYCM1sxCnsoEb';
const EXPECTED_CLUSTER = 'devnet';

// Base58 nonce shape (22–64 chars, no 0/O/I/l) — must match the WP1 generator.
const BASE58_NONCE = /^[1-9A-HJ-NP-Za-km-z]{22,64}$/;

export interface KeyParts {
  cluster: string;
  programId: string;
  owner: string;
  vault: string;
}
/** Persistent monotonic-revision high-watermark key. */
export function revisionKey(k: KeyParts): string {
  return `notif_rev/${k.cluster}/${k.programId}/${k.owner}/${k.vault}`;
}
/** Local signed-registration success-record key. */
export function successKey(k: KeyParts): string {
  return `notif_signed_reg/${k.cluster}/${k.programId}/${k.owner}/${k.vault}`;
}
/**
 * Durable "server deregistered, local tombstone write pending" marker key. Written
 * (best-effort) when a signed deregistration succeeds server-side but the local
 * tombstone write fails, so the disabled state survives an app restart and the
 * local tombstone can be repaired on the next reconcile (never a second server call).
 */
export function deregPendingKey(k: KeyParts): string {
  return `notif_dereg_pending/${k.cluster}/${k.programId}/${k.owner}/${k.vault}`;
}
/**
 * WP6.1 — durable "this exact vault was revoked through the app" tombstone key
 * (mirrors notificationLifecycle.closedVaultKey). Written by `recordVaultClosure`
 * after a CONFIRMED revoke; it is the local proof that lets the explicit post-close
 * cleanup interpret the server's `ownership_failed` (closed vault) as already-absent.
 */
export function closedVaultKey(k: KeyParts): string {
  return `notif_vault_closed/${k.cluster}/${k.programId}/${k.owner}/${k.vault}`;
}

/**
 * Next monotonic revision (pure). `next = max(nowMs, storedHighWatermark + 1)`.
 * Strictly increases even for multiple attempts in the same millisecond; a
 * backward clock cannot lower it while storage survives. Throws (fail closed) on a
 * corrupt stored value or an invalid clock.
 */
export function computeNextRevision(stored: string | null, nowMs: number): number {
  let watermark = 0;
  if (stored != null && stored !== '') {
    if (!/^[1-9][0-9]*$/.test(stored)) throw new Error('corrupt revision high-watermark');
    const parsed = Number(stored);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error('corrupt revision high-watermark');
    watermark = parsed;
  }
  if (typeof nowMs !== 'number' || !Number.isSafeInteger(nowMs) || nowMs <= 0) throw new Error('invalid clock');
  const next = Math.max(nowMs, watermark + 1);
  if (!Number.isSafeInteger(next) || next <= 0) throw new Error('revision overflow');
  return next;
}

export type RegisterV2Fields = {
  cluster: string;
  programId: string;
  owner: string;
  vault: string;
  deviceTokenHash: string;
  stage1: number;
  stage2: number;
  stage3: number;
  revision: number;
  timestamp: number;
  nonce: string;
};

export interface RegistrationDeps {
  cluster: string;
  programId: string;
  deriveVault: (owner: string) => string;
  getDeviceToken: () => Promise<string | null>;
  getSetting: (key: string) => Promise<string | null>;
  setSetting: (key: string, value: string) => Promise<void>;
  signMessage: (bytes: Uint8Array) => Promise<Uint8Array>;
  buildRegisterMessage: (f: RegisterV2Fields) => string; // WP1 registerMessageV2
  generateNonce: () => string; // WP1 generateNonceV2 (fails closed w/o secure RNG)
  sha256Hex: (text: string) => Promise<string>;
  postRegister: (body: Record<string, unknown>) => Promise<{ status: number; code?: string; retryAfter?: string | null }>;
  nowSec: () => number;
  nowMs: () => number;
}

export interface RegistrationInput {
  owner: string;
  stages: { stage1: number; stage2: number; stage3: number };
}

export interface SuccessRecord {
  owner: string;
  vault: string;
  revision: number;
  tokenFingerprint: string; // sha256(token)[:32] — 128-bit, never the token
  stage1: number;
  stage2: number;
  stage3: number;
  confirmedAt: number;
  authVersion: 2;
  cluster: string;
  programId: string;
}

export type RegistrationResult =
  | { ok: true; result: 'created' | 'updated'; revision: number; record: SuccessRecord }
  | { ok: false; stage: string; code?: string; retryable: boolean };

function isCanonicalPubkey(s: unknown): s is string {
  try {
    return typeof s === 'string' && s.length > 0 && new PublicKey(s).toBase58() === s;
  } catch {
    return false;
  }
}
function isSafePosInt(n: unknown): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n) && n > 0;
}

export function mapStatusToCode(status: number): string {
  switch (status) {
    case 400:
      return 'invalid_request';
    case 401:
      return 'invalid_request';
    case 403:
      return 'ownership_failed';
    case 410:
      return 'legacy_window_expired';
    case 429:
      return 'rate_limited';
    case 502:
      return 'dependency_unavailable';
    case 503:
      return 'database_error';
    default:
      return 'unknown';
  }
}

const RETRYABLE_CODES = new Set(['rate_limited', 'dependency_unavailable', 'database_error', 'stale_revision']);

/** Map a stable server/flow code → a user-safe message + whether a deliberate retry may succeed. */
export function mapRegistrationError(code: string): { message: string; retryable: boolean } {
  switch (code) {
    case 'invalid_request':
      return { message: 'The registration request was invalid.', retryable: false };
    case 'invalid_signature':
      return { message: 'The wallet signature could not be verified.', retryable: false };
    case 'stale_timestamp':
      return { message: 'The request expired (a slow wallet approval or an incorrect device clock). Check the time, then tap to register again.', retryable: true };
    case 'context_mismatch':
      return { message: 'Your app network settings differ from the server. Check your network/cluster.', retryable: false };
    case 'nonce_reused':
      return { message: 'That request was already used. Start a new registration.', retryable: false };
    case 'ownership_failed':
      return { message: 'This vault could not be verified as yours on-chain.', retryable: false };
    case 'stale_revision':
      return { message: 'A newer registration already exists. Tap to register again.', retryable: true };
    case 'owner_conflict':
      return { message: 'This vault is registered to a different owner.', retryable: false };
    case 'rate_limited':
      return { message: 'Too many attempts. Wait a moment, then tap to register again.', retryable: true };
    case 'dependency_unavailable':
      return { message: 'The service is temporarily unavailable. Tap to try again.', retryable: true };
    case 'database_error':
      return { message: 'The server had a temporary error. Tap to try again.', retryable: true };
    case 'legacy_window_expired':
      return { message: 'Server configuration inconsistency — please try again later.', retryable: false };
    default:
      return { message: 'Registration failed. Please try again.', retryable: false };
  }
}

// Process-local single-flight guard: repeated deliberate taps while one attempt is
// active make no second request.
let inFlight = false;

/**
 * One deliberate signed-registration attempt. Returns a discriminated result; never
 * throws for expected failures; never auto-retries; never falls back to legacy.
 */
export async function attemptSignedRegistration(
  input: RegistrationInput,
  deps: RegistrationDeps,
): Promise<RegistrationResult> {
  if (inFlight) return { ok: false, stage: 'in_flight', retryable: false };
  inFlight = true;
  try {
    const owner = input?.owner;
    // 1–4: local validation BEFORE opening the wallet.
    if (!isCanonicalPubkey(owner)) return { ok: false, stage: 'validate', retryable: false };
    const vault = deps.deriveVault(owner);
    if (!isCanonicalPubkey(vault)) return { ok: false, stage: 'validate', retryable: false };
    if (deps.cluster !== EXPECTED_CLUSTER || deps.programId !== EXPECTED_PROGRAM_ID) {
      return { ok: false, stage: 'context', retryable: false };
    }
    const { stage1, stage2, stage3 } = input.stages ?? {};
    if (!isSafePosInt(stage1) || !isSafePosInt(stage2) || !isSafePosInt(stage3)) {
      return { ok: false, stage: 'validate', retryable: false };
    }
    // 5: current device token.
    const deviceToken = await deps.getDeviceToken();
    if (typeof deviceToken !== 'string' || deviceToken.length < 10) {
      return { ok: false, stage: 'device_token', retryable: true };
    }
    // 6: secure-RNG readiness — produce the nonce BEFORE signing; fail closed if unavailable.
    let nonce: string;
    try {
      nonce = deps.generateNonce();
    } catch {
      return { ok: false, stage: 'rng', retryable: false };
    }
    if (!BASE58_NONCE.test(nonce)) return { ok: false, stage: 'rng', retryable: false };
    // 7: monotonic revision — persist the high-watermark BEFORE the request.
    let revision: number;
    try {
      const rk = revisionKey({ cluster: deps.cluster, programId: deps.programId, owner, vault });
      const stored = await deps.getSetting(rk);
      revision = computeNextRevision(stored, deps.nowMs());
      await deps.setSetting(rk, String(revision));
    } catch {
      return { ok: false, stage: 'revision', retryable: false };
    }
    // 8: timestamp + LOCAL device-token hash (never trust a client hash server-side).
    const timestamp = deps.nowSec();
    if (!isSafePosInt(timestamp)) return { ok: false, stage: 'validate', retryable: false };
    let deviceTokenHash: string;
    try {
      deviceTokenHash = (await deps.sha256Hex(deviceToken)).toLowerCase();
    } catch {
      return { ok: false, stage: 'hash', retryable: true };
    }
    // 9: exact V2 message (the builder throws on any noncanonical field).
    let message: string;
    try {
      message = deps.buildRegisterMessage({
        cluster: deps.cluster,
        programId: deps.programId,
        owner,
        vault,
        deviceTokenHash,
        stage1,
        stage2,
        stage3,
        revision,
        timestamp,
        nonce,
      });
    } catch {
      return { ok: false, stage: 'validate', retryable: false };
    }
    // Encode the exact UTF-8 bytes with Buffer (globally polyfilled on Hermes;
    // TextEncoder is NOT guaranteed in React Native). Done OUTSIDE the wallet try
    // so an encoder failure is a distinct stage, never misread as a cancellation.
    let messageBytes: Uint8Array;
    try {
      messageBytes = Buffer.from(message, 'utf8');
    } catch {
      return { ok: false, stage: 'encode', retryable: false };
    }
    // 10: one owner signature. Wallet cancel/reject → NO request, NO fallback.
    let sigBytes: Uint8Array;
    try {
      sigBytes = await deps.signMessage(messageBytes);
    } catch {
      return { ok: false, stage: 'wallet', retryable: true };
    }
    if (!sigBytes || sigBytes.length !== 64) return { ok: false, stage: 'signature', retryable: false };
    let signature: string;
    try {
      signature = bs58.encode(sigBytes);
    } catch {
      return { ok: false, stage: 'signature', retryable: false };
    }
    // 11: one signed request with NO legacy or admin shared-secret header. Plaintext token
    // is in the body (server needs it for FCM); no client token-hash field is sent.
    const body: Record<string, unknown> = {
      owner,
      vault,
      deviceToken,
      stage1,
      stage2,
      stage3,
      revision,
      version: 2,
      cluster: deps.cluster,
      programId: deps.programId,
      audience: AUDIENCE,
      action: 'register',
      timestamp,
      nonce,
      signature,
    };
    let res: { status: number; code?: string; retryAfter?: string | null };
    try {
      res = await deps.postRegister(body);
    } catch {
      return { ok: false, stage: 'network', code: 'dependency_unavailable', retryable: true };
    }
    // 12: map response. Success record persisted ONLY on 201/200.
    if (res.status === 201 || res.status === 200) {
      const result = res.status === 201 ? 'created' : 'updated';
      const tokenFingerprint = deviceTokenHash.slice(0, 32); // 128-bit (WP6); reuse local hash, no recompute/throw
      const record: SuccessRecord = {
        owner,
        vault,
        revision,
        tokenFingerprint,
        stage1,
        stage2,
        stage3,
        confirmedAt: deps.nowSec(),
        authVersion: 2,
        cluster: deps.cluster,
        programId: deps.programId,
      };
      // Server truth wins: the registration is already accepted server-side. The local
      // success record is a best-effort cache — if persisting it fails, still report
      // success. A missing local record only re-adds duplicate LOCAL warnings (the
      // fail-safe direction) and self-heals on the next deliberate re-tap; it must never
      // turn an accepted registration into a reported failure.
      try {
        await deps.setSetting(
          successKey({ cluster: deps.cluster, programId: deps.programId, owner, vault }),
          JSON.stringify(record),
        );
      } catch {
        /* best-effort cache write; server already accepted the registration */
      }
      // WP6.1 — a fresh accepted registration means a LIVE vault at this PDA. Clear any stale
      // closed-vault tombstone (e.g. a new vault re-initialized at the same owner PDA after a
      // prior revoke) so the observer shows `enabled`, not `vault_closed_cleanup_pending`.
      try { await deps.setSetting(closedVaultKey({ cluster: deps.cluster, programId: deps.programId, owner, vault }), ''); } catch { /* best-effort */ }
      return { ok: true, result, revision, record };
    }
    const code = res.code || mapStatusToCode(res.status);
    return { ok: false, stage: 'server', code, retryable: RETRYABLE_CODES.has(code) };
  } finally {
    inFlight = false;
  }
}

// ── WP6: deliberate owner-signed DEREGISTRATION ──────────────────────────────
// Same hard rules as registration: fail closed, NO auto-retry, NO legacy fallback
// ever, exactly one signature + one request, and never store a token/signature/
// nonce/message/secret. The deregistration envelope carries NO device token, token
// hash, stages, or revision. Both `removed=1` and `removed=0` are idempotent
// success. The revision high-watermark is PRESERVED (never deleted/lowered) so a
// later re-enable cannot reuse a lower revision.

export type DeregisterV2Fields = {
  cluster: string;
  programId: string;
  owner: string;
  vault: string;
  timestamp: number;
  nonce: string;
};

export interface DeregisterDeps {
  cluster: string;
  programId: string;
  deriveVault: (owner: string) => string;
  getSetting: (key: string) => Promise<string | null>;
  setSetting: (key: string, value: string) => Promise<void>;
  signMessage: (bytes: Uint8Array) => Promise<Uint8Array>;
  buildDeregisterMessage: (f: DeregisterV2Fields) => string; // WP1 deregisterMessageV2
  generateNonce: () => string; // WP1 generateNonceV2
  postDeregister: (
    body: Record<string, unknown>,
  ) => Promise<{ status: number; code?: string; removed?: number; retryAfter?: string | null }>;
  nowSec: () => number;
}

export interface DeregisterInput {
  owner: string;
  /**
   * WP6.1 — set to 'post_close_cleanup' ONLY for the explicit post-revoke cleanup action.
   * In that context, and ONLY when a valid closed-vault tombstone proves this exact vault
   * was revoked through the app, a server `ownership_failed` (closed vault, poller may have
   * already dropped the row) is interpreted as an idempotent already-absent success. In any
   * other context `ownership_failed` remains a hard failure.
   */
  context?: 'post_close_cleanup';
}

export type DeregisterResult =
  | { ok: true; removed: number; localCleanupPending?: boolean; alreadyAbsentAfterClose?: boolean }
  | { ok: false; stage: string; code?: string; retryable: boolean };

export interface VaultClosureInput {
  owner: string;
  revokeSig: string; // the CONFIRMED revoke transaction signature (caller confirms first)
  revokedAt: number; // unix seconds — revoke confirmation time
}
export interface VaultClosureDeps {
  cluster: string;
  programId: string;
  deriveVault: (owner: string) => string;
  getSetting: (key: string) => Promise<string | null>;
  setSetting: (key: string, value: string) => Promise<void>;
}
/**
 * WP6.1 — record a CONFIRMED owner-authorized vault revoke as a durable closed-vault
 * tombstone. LOCAL-ONLY: never signs, never calls the server, never touches the revision
 * high-watermark. The caller MUST have confirmed the revoke transaction before calling this
 * (`revokeSig` is the confirmed signature). Writes the tombstone ONLY when an active (not
 * already-tombstoned) notification record exists for this identity — otherwise there is
 * nothing to reconcile. Idempotent; returns whether a tombstone was written.
 */
export async function recordVaultClosure(input: VaultClosureInput, deps: VaultClosureDeps): Promise<boolean> {
  const owner = input?.owner;
  if (!isCanonicalPubkey(owner)) return false;
  if (typeof input.revokeSig !== 'string' || input.revokeSig.length < 32) return false; // require a real confirmed signature
  if (!isSafePosInt(input.revokedAt)) return false;
  let vault: string;
  try {
    vault = deps.deriveVault(owner);
  } catch {
    return false;
  }
  if (!isCanonicalPubkey(vault)) return false;
  if (deps.cluster !== EXPECTED_CLUSTER || deps.programId !== EXPECTED_PROGRAM_ID) return false;
  const key = { cluster: deps.cluster, programId: deps.programId, owner, vault };
  // Only meaningful if there is an active notification record to reconcile.
  let priorRevision: number | undefined;
  try {
    const raw = await deps.getSetting(successKey(key));
    const rec = raw ? (JSON.parse(raw) as SuccessRecord & { deregisteredAt?: number }) : null;
    if (!rec || rec.owner !== owner || rec.vault !== vault || rec.deregisteredAt) return false; // nothing to reconcile
    if (typeof rec.revision === 'number') priorRevision = rec.revision;
  } catch {
    return false; // unreadable record → do not fabricate a cleanup state
  }
  const tomb = {
    schemaVersion: 1,
    owner,
    vault,
    cluster: deps.cluster,
    programId: deps.programId,
    revokedAt: input.revokedAt,
    revokeSig: input.revokeSig,
    priorRevision,
    needsServerReconcile: true,
  };
  try {
    await deps.setSetting(closedVaultKey(key), JSON.stringify(tomb));
    return true;
  } catch {
    return false;
  }
}

/** Deregistration status → stable code (200 is handled by the caller as success). */
export function mapDeregisterStatusToCode(status: number): string {
  switch (status) {
    case 400:
      return 'invalid_request';
    case 401:
      return 'invalid_signature';
    case 403:
      return 'ownership_failed';
    case 409:
      return 'owner_conflict';
    case 410:
      return 'legacy_window_expired';
    case 429:
      return 'rate_limited';
    case 502:
      return 'dependency_unavailable';
    case 503:
      return 'database_error';
    default:
      return 'unknown';
  }
}

// Codes for which a *deliberate* retry may succeed (there is NO automatic retry).
const DEREG_RETRYABLE_CODES = new Set(['rate_limited', 'dependency_unavailable', 'database_error']);

/** Map a deregistration code → a user-safe message. `removed=0` is success, not an error. */
export function mapDeregisterError(code: string): { message: string; retryable: boolean } {
  switch (code) {
    case 'invalid_request':
      return { message: 'The deregistration request was invalid.', retryable: false };
    case 'invalid_signature':
      return { message: 'The wallet signature could not be verified.', retryable: false };
    case 'stale_timestamp':
      return { message: 'The request expired (a slow wallet approval or an incorrect device clock). Check the time, then try again.', retryable: true };
    case 'context_mismatch':
      return { message: 'Your app network settings differ from the server. Check your network/cluster.', retryable: false };
    case 'nonce_reused':
      return { message: 'That request was already used. Try the action again.', retryable: false };
    case 'ownership_failed':
      return { message: 'This vault could not be verified as yours.', retryable: false };
    case 'owner_conflict':
      return { message: 'This vault is registered to a different owner.', retryable: false };
    case 'rate_limited':
      return { message: 'Too many attempts. Wait a moment, then try again.', retryable: true };
    case 'dependency_unavailable':
      return { message: 'The service is temporarily unavailable. Try again.', retryable: true };
    case 'database_error':
      return { message: 'The server had a temporary error. Try again.', retryable: true };
    // These do not apply to a signed deregistration; if seen, it is a server inconsistency.
    case 'stale_revision':
    case 'legacy_window_expired':
      return { message: 'Server configuration inconsistency — please try again later.', retryable: false };
    default:
      return { message: 'Deregistration failed. Please try again.', retryable: false };
  }
}

// Process-local single-flight guard for deregistration (separate from register).
let deregInFlight = false;

/**
 * One deliberate signed-deregistration attempt. Returns a discriminated result;
 * never throws for expected failures; never auto-retries; never falls back to
 * legacy; never deletes by owner. Caller guarantees this is a deliberate action.
 */
export async function attemptSignedDeregistration(input: DeregisterInput, deps: DeregisterDeps): Promise<DeregisterResult> {
  if (deregInFlight) return { ok: false, stage: 'in_flight', retryable: false };
  deregInFlight = true;
  try {
    const owner = input?.owner;
    if (!isCanonicalPubkey(owner)) return { ok: false, stage: 'validate', retryable: false };
    let vault: string;
    try {
      vault = deps.deriveVault(owner);
    } catch {
      return { ok: false, stage: 'validate', retryable: false };
    }
    if (!isCanonicalPubkey(vault)) return { ok: false, stage: 'validate', retryable: false };
    if (deps.cluster !== EXPECTED_CLUSTER || deps.programId !== EXPECTED_PROGRAM_ID) {
      return { ok: false, stage: 'context', retryable: false };
    }
    const key = { cluster: deps.cluster, programId: deps.programId, owner, vault };
    // If a local record exists, require owner + canonical vault match BEFORE the wallet.
    // A missing/unreadable record is allowed (post-close / recovery → idempotent removal).
    let record: SuccessRecord | null = null;
    try {
      const raw = await deps.getSetting(successKey(key));
      record = raw ? (JSON.parse(raw) as SuccessRecord) : null;
    } catch {
      record = null;
    }
    if (record && (record.owner !== owner || record.vault !== vault)) {
      return { ok: false, stage: 'owner_mismatch', retryable: false };
    }
    // WP6.1 — closure proof: a valid closed-vault tombstone (written only after a CONFIRMED
    // owner-authorized revoke, with a real revokeSig) for THIS owner+vault. Used ONLY in the
    // explicit post-close cleanup context to interpret a later `ownership_failed` (closed
    // vault, poller may already have dropped the row) as already-absent. A missing/invalid
    // tombstone, or any other context, leaves `ownership_failed` a hard failure.
    let closureProven = false;
    try {
      const rawTomb = await deps.getSetting(closedVaultKey(key));
      const tomb = rawTomb ? (JSON.parse(rawTomb) as { owner?: string; vault?: string; revokedAt?: number; revokeSig?: string }) : null;
      closureProven =
        input?.context === 'post_close_cleanup' &&
        !!tomb &&
        tomb.owner === owner &&
        tomb.vault === vault &&
        isSafePosInt(tomb.revokedAt) &&
        typeof tomb.revokeSig === 'string' &&
        tomb.revokeSig.length >= 32;
    } catch {
      closureProven = false; // unreadable/corrupt tombstone → fail closed (no masking)
    }
    const timestamp = deps.nowSec();
    if (!isSafePosInt(timestamp)) return { ok: false, stage: 'validate', retryable: false };
    let nonce: string;
    try {
      nonce = deps.generateNonce();
    } catch {
      return { ok: false, stage: 'rng', retryable: false };
    }
    if (!BASE58_NONCE.test(nonce)) return { ok: false, stage: 'rng', retryable: false };
    // Exact V2 deregistration message (no token/hash/stages/revision).
    let message: string;
    try {
      message = deps.buildDeregisterMessage({ cluster: deps.cluster, programId: deps.programId, owner, vault, timestamp, nonce });
    } catch {
      return { ok: false, stage: 'validate', retryable: false };
    }
    // Hermes-safe encoding, OUTSIDE the wallet try (a non-wallet throw is not a cancel).
    let messageBytes: Uint8Array;
    try {
      messageBytes = Buffer.from(message, 'utf8');
    } catch {
      return { ok: false, stage: 'encode', retryable: false };
    }
    let sigBytes: Uint8Array;
    try {
      sigBytes = await deps.signMessage(messageBytes);
    } catch {
      return { ok: false, stage: 'wallet', retryable: true };
    }
    if (!sigBytes || sigBytes.length !== 64) return { ok: false, stage: 'signature', retryable: false };
    let signature: string;
    try {
      signature = bs58.encode(sigBytes);
    } catch {
      return { ok: false, stage: 'signature', retryable: false };
    }
    const body: Record<string, unknown> = {
      owner,
      vault,
      version: 2,
      cluster: deps.cluster,
      programId: deps.programId,
      audience: AUDIENCE,
      action: 'deregister',
      timestamp,
      nonce,
      signature,
    };
    let res: { status: number; code?: string; removed?: number; retryAfter?: string | null };
    try {
      res = await deps.postDeregister(body);
    } catch {
      return { ok: false, stage: 'network', code: 'dependency_unavailable', retryable: true };
    }
    // Idempotent success: HTTP 200 with removed 0 or 1. Server truth = registration absent.
    if (res.status === 200 && (res.removed === 0 || res.removed === 1)) {
      const removed = res.removed;
      // Only tombstone when there was something to clear — a prior local record or a
      // server-side removal (removed=1). A pure no-op ("Clear" with no local record and
      // removed=0) leaves local state untouched so the UI does not overstate that a
      // registration existed. Tombstoning PRESERVES the revision watermark (revisionKey is
      // never touched here); a local write failure after server success does NOT flip the
      // result to failure — server truth wins.
      if (record || removed === 1) {
        let localCleanupPending = false;
        try {
          const tombstone = {
            owner,
            vault,
            cluster: deps.cluster,
            programId: deps.programId,
            deregisteredAt: deps.nowSec(),
            localCleanupPending: false,
          };
          await deps.setSetting(successKey(key), JSON.stringify(tombstone));
        } catch {
          localCleanupPending = true;
          // Best-effort DURABLE marker so a kill-before-repair can't resurface a stale
          // "enabled" UI: on the next reconcile the tombstone is repaired locally.
          try {
            await deps.setSetting(deregPendingKey(key), String(deps.nowSec()));
          } catch {
            /* best-effort; the in-session UI still shows disabled */
          }
        }
        // WP6.1 — the vault-closed cleanup (if any) is now reconciled; clear the marker.
        try { await deps.setSetting(closedVaultKey(key), ''); } catch { /* best-effort */ }
        return localCleanupPending ? { ok: true, removed, localCleanupPending: true } : { ok: true, removed };
      }
      try { await deps.setSetting(closedVaultKey(key), ''); } catch { /* best-effort */ }
      return { ok: true, removed };
    }
    const code = res.code || mapDeregisterStatusToCode(res.status);
    // WP6.1 — ONLY in the explicit post-close cleanup context, with locally-proven closure,
    // interpret `ownership_failed` (closed vault + no server row; the poller won the race) as
    // an idempotent already-absent success. Tombstone the confirmed record + clear the
    // closed-vault marker; PRESERVE the revision watermark; no second request. In every other
    // case `ownership_failed` stays a failure (it must not mask a live/owner/vault error).
    if (code === 'ownership_failed' && closureProven) {
      let localCleanupPending = false;
      try {
        const tombstone = {
          owner,
          vault,
          cluster: deps.cluster,
          programId: deps.programId,
          deregisteredAt: deps.nowSec(),
          localCleanupPending: false,
        };
        await deps.setSetting(successKey(key), JSON.stringify(tombstone));
      } catch {
        // Mirror the 200 path: on a tombstone-write failure surface localCleanupPending so the UI
        // engages its in-session guard and cannot resurface a stale "enabled" for the closed vault.
        localCleanupPending = true;
        try { await deps.setSetting(deregPendingKey(key), String(deps.nowSec())); } catch { /* best-effort */ }
      }
      try { await deps.setSetting(closedVaultKey(key), ''); } catch { /* best-effort */ }
      return localCleanupPending
        ? { ok: true, removed: 0, alreadyAbsentAfterClose: true, localCleanupPending: true }
        : { ok: true, removed: 0, alreadyAbsentAfterClose: true };
    }
    return { ok: false, stage: 'server', code, retryable: DEREG_RETRYABLE_CODES.has(code) };
  } finally {
    deregInFlight = false;
  }
}
