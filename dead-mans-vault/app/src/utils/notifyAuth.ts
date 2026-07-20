// Canonical signed-message format for notify-server registration/deregistration.
// MUST stay byte-for-byte identical to notify-server/src/authMessage.js.

import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';

export const REGISTER_DOMAIN = 'DMV_NOTIFY_REGISTER_V1';
export const DEREGISTER_DOMAIN = 'DMV_NOTIFY_DEREGISTER_V1';

export interface RegisterFields {
  owner: string;
  vault: string;
  deviceTokenHash: string; // sha256(deviceToken), lowercase hex
  stage1: number;
  stage2: number;
  stage3: number;
  timestamp: number; // unix seconds
  nonce: string;
}

export function registerMessage(f: RegisterFields): string {
  return [
    REGISTER_DOMAIN,
    `owner=${f.owner}`,
    `vault=${f.vault}`,
    `deviceTokenHash=${f.deviceTokenHash}`,
    `stage1=${f.stage1}`,
    `stage2=${f.stage2}`,
    `stage3=${f.stage3}`,
    `timestamp=${f.timestamp}`,
    `nonce=${f.nonce}`,
  ].join('\n');
}

export interface DeregisterFields {
  owner: string;
  vault: string;
  timestamp: number;
  nonce: string;
}

export function deregisterMessage(f: DeregisterFields): string {
  return [
    DEREGISTER_DOMAIN,
    `owner=${f.owner}`,
    `vault=${f.vault}`,
    `timestamp=${f.timestamp}`,
    `nonce=${f.nonce}`,
  ].join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// V2 owner-signed notification contract.
//
// V1 (above) is preserved byte-for-byte and stays dormant/legacy; V2 is NOT
// wired into any registration flow in this work package — it only defines the
// canonical message bytes + input canonicalisation for later phases.
//
// V2 binds the message to the target cluster + program ID + a fixed audience
// (closing V1's cross-cluster / cross-server replay gap) and carries a signed,
// monotonically increasing `revision` (the authoritative anti-rollback ordering
// mechanism; `timestamp` is diagnostics/freshness only, never ordering).
// Keep byte-for-byte in sync with notify-server/src/authMessage.js.

export const REGISTER_DOMAIN_V2 = 'DMV_NOTIFY_REGISTER_V2';
export const DEREGISTER_DOMAIN_V2 = 'DMV_NOTIFY_DEREGISTER_V2';
export const NOTIFY_AUTH_VERSION_V2 = 2;

// The audience is a fixed configuration constant (decision O-1), NOT a request
// value: the exact canonical HTTPS origin — lowercase scheme + host, no path,
// no trailing slash.
export const NOTIFY_AUDIENCE = 'https://notify.palatinearc.com';

// Bitcoin/Solana Base58 alphabet (excludes 0 O I l); rejects any whitespace,
// control character, punctuation, or delimiter by construction.
const V2_BASE58_CHARS = /^[1-9A-HJ-NP-Za-km-z]+$/;

function v2Cluster(c: string): string {
  if (c !== 'devnet' && c !== 'mainnet-beta') throw new Error('invalid cluster');
  return c;
}
function v2Pubkey(k: string, field: string): string {
  if (typeof k !== 'string' || k.length === 0) throw new Error(`invalid ${field}`);
  let pk: PublicKey;
  try {
    pk = new PublicKey(k);
  } catch {
    throw new Error(`invalid ${field}`);
  }
  if (pk.toBase58() !== k) throw new Error(`noncanonical ${field}`);
  return k;
}
function v2TokenHash(h: string): string {
  if (typeof h !== 'string' || !/^[0-9a-f]{64}$/.test(h)) throw new Error('invalid deviceTokenHash');
  return h;
}
function v2PosInt(n: number, field: string): string {
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n <= 0) throw new Error(`invalid ${field}`);
  return String(n);
}
function v2Nonce(x: string): string {
  if (typeof x !== 'string' || x.length < 22 || x.length > 64 || !V2_BASE58_CHARS.test(x)) {
    throw new Error('invalid nonce');
  }
  return x;
}

export interface RegisterFieldsV2 {
  cluster: string;
  programId: string;
  owner: string;
  vault: string;
  deviceTokenHash: string; // sha256(deviceToken), lowercase hex
  stage1: number;
  stage2: number;
  stage3: number;
  revision: number; // signed monotonic anti-rollback ordinal (> 0)
  timestamp: number; // unix seconds — freshness/diagnostics only
  nonce: string; // Base58, >= 128 bits entropy
}

/**
 * Canonical V2 registration message. UTF-8, lines joined by one '\n', no leading
 * and no trailing newline. `version` and `action` are fixed by this builder and
 * cannot be overridden by caller input. Throws on any malformed/noncanonical
 * field rather than silently normalising.
 */
export function registerMessageV2(f: RegisterFieldsV2): string {
  return [
    REGISTER_DOMAIN_V2,
    `version=${NOTIFY_AUTH_VERSION_V2}`,
    `cluster=${v2Cluster(f.cluster)}`,
    `programId=${v2Pubkey(f.programId, 'programId')}`,
    `audience=${NOTIFY_AUDIENCE}`,
    'action=register',
    `owner=${v2Pubkey(f.owner, 'owner')}`,
    `vault=${v2Pubkey(f.vault, 'vault')}`,
    `deviceTokenHash=${v2TokenHash(f.deviceTokenHash)}`,
    `stage1=${v2PosInt(f.stage1, 'stage1')}`,
    `stage2=${v2PosInt(f.stage2, 'stage2')}`,
    `stage3=${v2PosInt(f.stage3, 'stage3')}`,
    `revision=${v2PosInt(f.revision, 'revision')}`,
    `timestamp=${v2PosInt(f.timestamp, 'timestamp')}`,
    `nonce=${v2Nonce(f.nonce)}`,
  ].join('\n');
}

export interface DeregisterFieldsV2 {
  cluster: string;
  programId: string;
  owner: string;
  vault: string;
  timestamp: number;
  nonce: string;
}

/**
 * Canonical V2 deregistration message. No device token, token hash, stages, or
 * revision. Same canonicalisation + binding as registration.
 */
export function deregisterMessageV2(f: DeregisterFieldsV2): string {
  return [
    DEREGISTER_DOMAIN_V2,
    `version=${NOTIFY_AUTH_VERSION_V2}`,
    `cluster=${v2Cluster(f.cluster)}`,
    `programId=${v2Pubkey(f.programId, 'programId')}`,
    `audience=${NOTIFY_AUDIENCE}`,
    'action=deregister',
    `owner=${v2Pubkey(f.owner, 'owner')}`,
    `vault=${v2Pubkey(f.vault, 'vault')}`,
    `timestamp=${v2PosInt(f.timestamp, 'timestamp')}`,
    `nonce=${v2Nonce(f.nonce)}`,
  ].join('\n');
}

/**
 * Cryptographically-secure Base58 nonce: 16 random bytes → ~22 Base58 chars.
 * Uses the platform Web Crypto RNG (Node's global `crypto` and, in the app, the
 * expo-crypto polyfill installed on `global.crypto`).
 */
export function generateNonceV2(): string {
  let n: string;
  do {
    const b = new Uint8Array(16);
    globalThis.crypto.getRandomValues(b);
    n = bs58.encode(b);
  } while (n.length < 22); // re-draw the rare 21-char encoding so length is always in [22,64]
  return n;
}
