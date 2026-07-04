// Canonical signed-message format shared by the app and this server. The owner
// wallet signs these so registration/deregistration can't be forged by a holder
// of the (extractable) shared secret. Keep the format byte-for-byte in sync with
// the app's src/services/PushRegistrationService.ts.
import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto';

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
