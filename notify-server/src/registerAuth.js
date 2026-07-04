// Pure(ish) validation for owner-signed register/deregister, split out so it can
// be unit-tested without booting the HTTP server or hitting RPC. The on-chain
// vault check and the nonce store are injected as `deps`.
import bs58 from 'bs58';
import { PublicKey } from '@solana/web3.js';
import { registerMessage, deregisterMessage, sha256Hex, verifyEd25519 } from './authMessage.js';

export const SIG_WINDOW_SEC = 600; // ±10 minutes

function isPubkey(s) {
  try {
    // eslint-disable-next-line no-new
    new PublicKey(s);
    return true;
  } catch {
    return false;
  }
}

// Validate the { timestamp, nonce, signature } envelope shape + freshness.
function checkEnvelope({ timestamp, nonce, signature }, now) {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { ok: false, status: 400, error: 'invalid timestamp' };
  if (Math.abs(now - ts) > SIG_WINDOW_SEC) return { ok: false, status: 401, error: 'stale timestamp' };
  if (typeof nonce !== 'string' || nonce.length < 8 || nonce.length > 128) {
    return { ok: false, status: 400, error: 'invalid nonce' };
  }
  if (typeof signature !== 'string' || signature.length < 64 || signature.length > 128) {
    return { ok: false, status: 400, error: 'invalid signature' };
  }
  return { ok: true, ts };
}

function verifyOwnerSig(ownerBase58, message, signatureBase58) {
  let sigBytes;
  let pubBytes;
  try {
    sigBytes = bs58.decode(signatureBase58);
    pubBytes = bs58.decode(ownerBase58);
  } catch {
    return false;
  }
  return verifyEd25519(message, sigBytes, pubBytes);
}

/**
 * deps: {
 *   verifyVaultForOwner: async (owner, vault) => { ok, reason? },
 *   claimNonce: (owner, nonce, ts) => boolean,   // true if fresh, false if reused
 *   now: () => unix seconds,
 * }
 * Returns { ok: true, registration } or { ok: false, status, error }.
 */
export async function validateRegister(body, deps) {
  const { owner, vault, deviceToken, stage1, stage2, stage3, signature, timestamp, nonce } = body || {};
  if (!isPubkey(owner) || !isPubkey(vault)) return { ok: false, status: 400, error: 'invalid owner/vault pubkey' };
  if (typeof deviceToken !== 'string' || deviceToken.length < 10) return { ok: false, status: 400, error: 'invalid deviceToken' };
  const s1 = Number(stage1), s2 = Number(stage2), s3 = Number(stage3);
  if (![s1, s2, s3].every((n) => Number.isFinite(n) && n > 0)) return { ok: false, status: 400, error: 'invalid stage durations' };

  const now = deps.now();
  const env = checkEnvelope({ timestamp, nonce, signature }, now);
  if (!env.ok) return env;

  // Owner signature over the canonical message. The device token is bound via its
  // hash, so a shared-secret holder cannot rebind another owner's vault token.
  const deviceTokenHash = sha256Hex(deviceToken);
  const message = registerMessage({
    owner, vault, deviceTokenHash, stage1: s1, stage2: s2, stage3: s3, timestamp: env.ts, nonce,
  });
  if (!verifyOwnerSig(owner, message, signature)) return { ok: false, status: 401, error: 'signature verification failed' };

  // Single-use nonce (atomic) — reject replay before the RPC.
  if (!deps.claimNonce(owner, nonce, now)) return { ok: false, status: 401, error: 'nonce already used' };

  // Vault must be the canonical PDA for owner + a real on-chain VaultConfig it owns.
  let verdict;
  try {
    verdict = await deps.verifyVaultForOwner(owner, vault);
  } catch {
    return { ok: false, status: 502, error: 'vault verification unavailable' };
  }
  if (!verdict.ok) return { ok: false, status: 403, error: `vault verification failed: ${verdict.reason}` };

  return { ok: true, registration: { owner, vault, deviceToken, stage1: s1, stage2: s2, stage3: s3 } };
}

/** Returns { ok: true, vault } or { ok: false, status, error }. */
export async function validateDeregister(body, deps) {
  const { owner, vault, signature, timestamp, nonce } = body || {};
  if (!isPubkey(owner) || !isPubkey(vault)) return { ok: false, status: 400, error: 'invalid owner/vault pubkey' };

  const now = deps.now();
  const env = checkEnvelope({ timestamp, nonce, signature }, now);
  if (!env.ok) return env;

  const message = deregisterMessage({ owner, vault, timestamp: env.ts, nonce });
  if (!verifyOwnerSig(owner, message, signature)) return { ok: false, status: 401, error: 'signature verification failed' };

  if (!deps.claimNonce(owner, nonce, now)) return { ok: false, status: 401, error: 'nonce already used' };

  let verdict;
  try {
    verdict = await deps.verifyVaultForOwner(owner, vault);
  } catch {
    return { ok: false, status: 502, error: 'vault verification unavailable' };
  }
  if (!verdict.ok) return { ok: false, status: 403, error: `vault verification failed: ${verdict.reason}` };

  return { ok: true, vault };
}
