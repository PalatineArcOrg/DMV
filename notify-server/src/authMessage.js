// Canonical signed-message format shared by the app and this server. The owner
// wallet signs these so registration/deregistration can't be forged by a holder
// of the (extractable) shared secret. Keep the format byte-for-byte in sync with
// the app's src/services/PushRegistrationService.ts.
import { createHash, createPublicKey, verify as cryptoVerify, randomBytes } from 'node:crypto';
import bs58 from 'bs58';
import { PublicKey } from '@solana/web3.js';

export const REGISTER_DOMAIN = 'DMV_NOTIFY_REGISTER_V1';
export const DEREGISTER_DOMAIN = 'DMV_NOTIFY_DEREGISTER_V1';

/** sha256(text) as lowercase hex. */
export function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Canonical registration message. `deviceTokenHash` = sha256Hex(deviceToken). */
export function registerMessage({ owner, vault, deviceTokenHash, stage1, stage2, stage3, timestamp, nonce }) {
  return [
    REGISTER_DOMAIN,
    `owner=${owner}`,
    `vault=${vault}`,
    `deviceTokenHash=${deviceTokenHash}`,
    `stage1=${stage1}`,
    `stage2=${stage2}`,
    `stage3=${stage3}`,
    `timestamp=${timestamp}`,
    `nonce=${nonce}`,
  ].join('\n');
}

/** Canonical deregistration message. */
export function deregisterMessage({ owner, vault, timestamp, nonce }) {
  return [
    DEREGISTER_DOMAIN,
    `owner=${owner}`,
    `vault=${vault}`,
    `timestamp=${timestamp}`,
    `nonce=${nonce}`,
  ].join('\n');
}

// DER SPKI prefix for an Ed25519 public key; prepend to the raw 32-byte key to
// build a KeyObject that node:crypto can verify with (no external dependency).
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/**
 * Verify a detached Ed25519 signature (as produced by MWA `signMessages` over the
 * raw UTF-8 message bytes) against a raw 32-byte public key. Returns false on any
 * malformed input rather than throwing.
 */
export function verifyEd25519(messageStr, signatureBytes, publicKeyBytes) {
  try {
    if (!(publicKeyBytes?.length === 32) || !(signatureBytes?.length === 64)) return false;
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKeyBytes)]),
      format: 'der',
      type: 'spki',
    });
    return cryptoVerify(null, Buffer.from(messageStr, 'utf8'), key, Buffer.from(signatureBytes));
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// V2 owner-signed notification contract.
//
// V1 (above) is preserved byte-for-byte and stays dormant/legacy; V2 is NOT
// wired into any route or app flow in this work package — it only defines the
// canonical message bytes + input canonicalisation for later phases.
//
// V2 binds the message to the target cluster + program ID + a fixed audience
// (closing V1's cross-cluster / cross-server replay gap) and carries a signed,
// monotonically increasing `revision` (the authoritative anti-rollback ordering
// mechanism; `timestamp` is diagnostics/freshness only, never ordering).
// Keep byte-for-byte in sync with the app's src/utils/notifyAuth.ts.

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

function v2Cluster(c) {
  if (c !== 'devnet' && c !== 'mainnet-beta') throw new Error('invalid cluster');
  return c;
}
function v2Pubkey(k, field) {
  if (typeof k !== 'string' || k.length === 0) throw new Error(`invalid ${field}`);
  let pk;
  try {
    pk = new PublicKey(k);
  } catch {
    throw new Error(`invalid ${field}`);
  }
  if (pk.toBase58() !== k) throw new Error(`noncanonical ${field}`);
  return k;
}
function v2TokenHash(h) {
  if (typeof h !== 'string' || !/^[0-9a-f]{64}$/.test(h)) throw new Error('invalid deviceTokenHash');
  return h;
}
function v2PosInt(n, field) {
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n <= 0) throw new Error(`invalid ${field}`);
  return String(n);
}
function v2Nonce(x) {
  if (typeof x !== 'string' || x.length < 22 || x.length > 64 || !V2_BASE58_CHARS.test(x)) {
    throw new Error('invalid nonce');
  }
  return x;
}

/**
 * Canonical V2 registration message. UTF-8, lines joined by one '\n', no leading
 * and no trailing newline. `version` and `action` are fixed by this builder and
 * cannot be overridden by caller input. `deviceTokenHash` = sha256Hex(deviceToken).
 * Throws on any malformed/noncanonical field rather than silently normalising.
 */
export function registerMessageV2({
  cluster, programId, owner, vault, deviceTokenHash, stage1, stage2, stage3, revision, timestamp, nonce,
}) {
  return [
    REGISTER_DOMAIN_V2,
    `version=${NOTIFY_AUTH_VERSION_V2}`,
    `cluster=${v2Cluster(cluster)}`,
    `programId=${v2Pubkey(programId, 'programId')}`,
    `audience=${NOTIFY_AUDIENCE}`,
    'action=register',
    `owner=${v2Pubkey(owner, 'owner')}`,
    `vault=${v2Pubkey(vault, 'vault')}`,
    `deviceTokenHash=${v2TokenHash(deviceTokenHash)}`,
    `stage1=${v2PosInt(stage1, 'stage1')}`,
    `stage2=${v2PosInt(stage2, 'stage2')}`,
    `stage3=${v2PosInt(stage3, 'stage3')}`,
    `revision=${v2PosInt(revision, 'revision')}`,
    `timestamp=${v2PosInt(timestamp, 'timestamp')}`,
    `nonce=${v2Nonce(nonce)}`,
  ].join('\n');
}

/**
 * Canonical V2 deregistration message. No device token, token hash, stages, or
 * revision. Same canonicalisation + binding as registration.
 */
export function deregisterMessageV2({ cluster, programId, owner, vault, timestamp, nonce }) {
  return [
    DEREGISTER_DOMAIN_V2,
    `version=${NOTIFY_AUTH_VERSION_V2}`,
    `cluster=${v2Cluster(cluster)}`,
    `programId=${v2Pubkey(programId, 'programId')}`,
    `audience=${NOTIFY_AUDIENCE}`,
    'action=deregister',
    `owner=${v2Pubkey(owner, 'owner')}`,
    `vault=${v2Pubkey(vault, 'vault')}`,
    `timestamp=${v2PosInt(timestamp, 'timestamp')}`,
    `nonce=${v2Nonce(nonce)}`,
  ].join('\n');
}

/**
 * Cryptographically-secure Base58 nonce (128-bit entropy). 16 random bytes
 * Base58-encode to 21 or 22 chars; re-draw the rare 21-char result so the output
 * always lands in the validated [22,64] range.
 */
export function generateNonceV2() {
  let n;
  do {
    n = bs58.encode(randomBytes(16));
  } while (n.length < 22);
  return n;
}
