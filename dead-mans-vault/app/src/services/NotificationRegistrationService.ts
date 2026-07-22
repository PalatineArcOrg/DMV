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
  tokenFingerprint: string; // sha256(token)[:16] — never the token
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
      const tokenFingerprint = deviceTokenHash.slice(0, 16); // reuse the local hash; no recompute/throw
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
      return { ok: true, result, revision, record };
    }
    const code = res.code || mapStatusToCode(res.status);
    return { ok: false, stage: 'server', code, retryable: RETRYABLE_CODES.has(code) };
  } finally {
    inFlight = false;
  }
}
