// V2 owner-signed authorization (WP2). Pure + dependency-injected: the ownership
// verifier, the stored-registration reader, and the clock are all injected, so
// these functions unit-test with no network, no config, and no live database.
//
// They produce a normalized, already-authorized *command* for the storage layer
// (registrationStore.applySigned*). They NEVER claim a nonce or mutate storage —
// that happens atomically in the transaction, so a transient RPC failure or an
// invalid signature can never consume a nonce.
//
// WP2 defines + tests these. No HTTP route calls them (that is WP3). V1 and the
// active unsigned path are unchanged.
import bs58 from 'bs58';
import { PublicKey } from '@solana/web3.js';
import { createHash } from 'node:crypto';
import {
  registerMessageV2,
  deregisterMessageV2,
  NOTIFY_AUDIENCE,
  NOTIFY_AUTH_VERSION_V2,
  sha256Hex,
  verifyEd25519,
} from './authMessage.js';
import { RESULT } from './registrationStore.js';

export const SIG_WINDOW_SEC = 600; // ±10 minutes; freshness only, never ordering
const DEVICE_TOKEN_MIN = 32;
const DEVICE_TOKEN_MAX = 4096;
// Reject whitespace + C0/C1/DEL controls + line/paragraph separators; printable ASCII (incl. '-', ':', '_') is allowed.
const TOKEN_DISALLOWED = /[\s\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

// Anchor 8-byte account discriminator = sha256("account:VaultConfig")[..8].
// Mirrors notify-server/src/solana.js (asserted equal by a test).
const VAULT_CONFIG_DISCRIMINATOR = createHash('sha256').update('account:VaultConfig').digest().subarray(0, 8);

/** Pure canonical vault PDA (["vault", owner]) for a program. No RPC. */
export function deriveVaultPda(owner, programId) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('vault'), new PublicKey(owner).toBuffer()],
    new PublicKey(programId),
  )[0].toBase58();
}

// Decode a Base58 Ed25519 signature to exactly 64 bytes, requiring a canonical
// round-trip. Returns the bytes or null.
function decodeSignature(sig) {
  if (typeof sig !== 'string') return null;
  let bytes;
  try {
    bytes = bs58.decode(sig);
  } catch {
    return null;
  }
  if (bytes.length !== 64) return null;
  if (bs58.encode(bytes) !== sig) return null;
  return bytes;
}

function decodeOwnerBytes(owner) {
  try {
    const b = bs58.decode(owner);
    return b.length === 32 ? b : null;
  } catch {
    return null;
  }
}

function validDeviceToken(t) {
  return (
    typeof t === 'string' &&
    t.length >= DEVICE_TOKEN_MIN &&
    t.length <= DEVICE_TOKEN_MAX &&
    !TOKEN_DISALLOWED.test(t)
  );
}

// Trusted deployment context comparison. The audience must be the approved
// constant (a misconfigured deployment fails closed), and every context field in
// the request must equal the trusted server value EXACTLY — no trim/lowercase/
// coerce. Rejected before any RPC or crypto.
function contextMismatch(body, expected) {
  if (!expected || expected.audience !== NOTIFY_AUDIENCE) return true;
  if (body.cluster !== expected.cluster) return true;
  if (body.programId !== expected.programId) return true;
  if (body.audience !== expected.audience) return true;
  return false;
}

// Freshness: timestamp must be an integer (no Number() coercion) within the
// ±SIG_WINDOW_SEC window of server time. Returns a RESULT code or null.
function freshnessError(timestamp, now) {
  if (typeof timestamp !== 'number' || !Number.isInteger(timestamp) || timestamp <= 0) {
    return RESULT.INVALID_REQUEST;
  }
  if (Math.abs(now - timestamp) > SIG_WINDOW_SEC) return RESULT.STALE_TIMESTAMP;
  return null;
}

/**
 * Build a transient-aware ownership verifier from an account fetcher. Injected in
 * WP3 with the live connection; unit-tested here with a mock fetcher.
 *   getAccountInfo(vaultBase58) -> web3 AccountInfo | null  (throws on transport error)
 * Returns async (owner, vault) => { ok:true } | { ok:false, transient, reason }.
 * A transport throw is classified TRANSIENT (retryable) — never a definitive 403.
 */
export function makeOwnershipVerifier(getAccountInfo, { programId }) {
  const programPk = new PublicKey(programId);
  return async (owner, vault) => {
    let pda;
    try {
      pda = deriveVaultPda(owner, programId);
    } catch {
      return { ok: false, transient: false, reason: 'invalid owner' };
    }
    if (pda !== vault) return { ok: false, transient: false, reason: 'not canonical pda' };

    let acc;
    try {
      acc = await getAccountInfo(vault);
    } catch {
      return { ok: false, transient: true, reason: 'rpc unavailable' };
    }
    if (!acc) return { ok: false, transient: false, reason: 'vault not found' };
    if (!acc.owner || !programPk.equals(acc.owner)) return { ok: false, transient: false, reason: 'not a program account' };
    const data = acc.data;
    if (!Buffer.isBuffer(data) || data.length < 40 || !data.subarray(0, 8).equals(VAULT_CONFIG_DISCRIMINATOR)) {
      return { ok: false, transient: false, reason: 'not a VaultConfig' };
    }
    let storedOwner;
    try {
      storedOwner = new PublicKey(data.subarray(8, 40)).toBase58();
    } catch {
      return { ok: false, transient: false, reason: 'unparseable owner' };
    }
    if (storedOwner !== owner) return { ok: false, transient: false, reason: 'on-chain owner mismatch' };
    return { ok: true };
  };
}

function classifyOwnership(verdict) {
  if (verdict && verdict.transient) return RESULT.DEPENDENCY_UNAVAILABLE;
  if (!verdict || !verdict.ok) return RESULT.OWNERSHIP_FAILED;
  return null;
}

/**
 * deps: {
 *   expected: { cluster, programId, audience },  // trusted server-side values
 *   verifyOwnership: async (owner, vault) => { ok, transient?, reason? },
 *   now: () => unix seconds,
 * }
 * Returns { ok:true, code:'ok', command } or { ok:false, code }.
 * Does NOT claim a nonce or mutate storage.
 */
export async function authorizeRegisterV2(body, deps) {
  const b = body || {};
  const { expected, verifyOwnership, now } = deps;

  if (b.version !== NOTIFY_AUTH_VERSION_V2) return { ok: false, code: RESULT.INVALID_REQUEST };
  if (b.action !== 'register') return { ok: false, code: RESULT.INVALID_REQUEST };
  if (contextMismatch(b, expected)) return { ok: false, code: RESULT.CONTEXT_MISMATCH };
  if (!validDeviceToken(b.deviceToken)) return { ok: false, code: RESULT.INVALID_REQUEST };

  const serverNow = now();
  const freshErr = freshnessError(b.timestamp, serverNow);
  if (freshErr) return { ok: false, code: freshErr };

  // The plaintext token is hashed LOCALLY — a client-supplied token hash is never
  // trusted. The WP1 builder is the canonical validator: it throws on any
  // noncanonical owner/vault/programId/cluster/stage/revision/timestamp/nonce.
  const deviceTokenHash = sha256Hex(b.deviceToken);
  let message;
  try {
    message = registerMessageV2({
      cluster: b.cluster,
      programId: b.programId,
      owner: b.owner,
      vault: b.vault,
      deviceTokenHash,
      stage1: b.stage1,
      stage2: b.stage2,
      stage3: b.stage3,
      revision: b.revision,
      timestamp: b.timestamp,
      nonce: b.nonce,
    });
  } catch {
    return { ok: false, code: RESULT.INVALID_REQUEST };
  }

  const sigBytes = decodeSignature(b.signature);
  if (!sigBytes) return { ok: false, code: RESULT.INVALID_SIGNATURE };
  const ownerBytes = decodeOwnerBytes(b.owner);
  if (!ownerBytes) return { ok: false, code: RESULT.INVALID_REQUEST };
  // No nonce claim and no RPC has happened yet: an invalid signature stops here.
  if (!verifyEd25519(message, sigBytes, ownerBytes)) return { ok: false, code: RESULT.INVALID_SIGNATURE };

  let verdict;
  try {
    verdict = await verifyOwnership(b.owner, b.vault);
  } catch {
    return { ok: false, code: RESULT.DEPENDENCY_UNAVAILABLE };
  }
  const ownershipErr = classifyOwnership(verdict);
  if (ownershipErr) return { ok: false, code: ownershipErr };

  return {
    ok: true,
    code: RESULT.OK,
    command: {
      owner: b.owner,
      vault: b.vault,
      deviceToken: b.deviceToken,
      deviceTokenHash,
      stage1: b.stage1,
      stage2: b.stage2,
      stage3: b.stage3,
      revision: b.revision,
      signedAt: b.timestamp,
      nonce: b.nonce,
      nonceUsedAt: serverNow,
      authVersion: 2,
    },
  };
}

function deregisterCommand(b, serverNow) {
  return {
    owner: b.owner,
    vault: b.vault,
    nonce: b.nonce,
    nonceUsedAt: serverNow,
    signedAt: b.timestamp,
    authVersion: 2,
  };
}

/**
 * deps: { expected, verifyOwnership, getRegistration: (vault) => row|null, now }.
 * Deregistration after owner-close/revoke: when a stored row's owner matches the
 * signer, authorize WITHOUT any RPC (the vault may no longer exist on-chain). Only
 * when there is no stored row do we fall back to live ownership verification.
 */
export async function authorizeDeregisterV2(body, deps) {
  const b = body || {};
  const { expected, verifyOwnership, getRegistration, now } = deps;

  if (b.version !== NOTIFY_AUTH_VERSION_V2) return { ok: false, code: RESULT.INVALID_REQUEST };
  if (b.action !== 'deregister') return { ok: false, code: RESULT.INVALID_REQUEST };
  if (contextMismatch(b, expected)) return { ok: false, code: RESULT.CONTEXT_MISMATCH };

  const serverNow = now();
  const freshErr = freshnessError(b.timestamp, serverNow);
  if (freshErr) return { ok: false, code: freshErr };

  let message;
  try {
    message = deregisterMessageV2({
      cluster: b.cluster,
      programId: b.programId,
      owner: b.owner,
      vault: b.vault,
      timestamp: b.timestamp,
      nonce: b.nonce,
    });
  } catch {
    return { ok: false, code: RESULT.INVALID_REQUEST };
  }

  // Pure canonical-PDA check (no RPC): the vault must be PDA(owner).
  let pda;
  try {
    pda = deriveVaultPda(b.owner, b.programId);
  } catch {
    return { ok: false, code: RESULT.INVALID_REQUEST };
  }
  if (pda !== b.vault) return { ok: false, code: RESULT.CONTEXT_MISMATCH };

  const sigBytes = decodeSignature(b.signature);
  if (!sigBytes) return { ok: false, code: RESULT.INVALID_SIGNATURE };
  const ownerBytes = decodeOwnerBytes(b.owner);
  if (!ownerBytes) return { ok: false, code: RESULT.INVALID_REQUEST };
  if (!verifyEd25519(message, sigBytes, ownerBytes)) return { ok: false, code: RESULT.INVALID_SIGNATURE };

  const row = getRegistration(b.vault);
  if (row && row.owner === b.owner) {
    // Existing registration owned by the signer → clean up without RPC.
    return { ok: true, code: RESULT.OK, command: deregisterCommand(b, serverNow) };
  }
  if (row && row.owner !== b.owner) {
    // Never delete another owner's row on a syntactically valid request.
    return { ok: false, code: RESULT.OWNER_CONFLICT };
  }

  // No stored row → require live ownership (idempotent removal → removed=0).
  let verdict;
  try {
    verdict = await verifyOwnership(b.owner, b.vault);
  } catch {
    return { ok: false, code: RESULT.DEPENDENCY_UNAVAILABLE };
  }
  const ownershipErr = classifyOwnership(verdict);
  if (ownershipErr) return { ok: false, code: ownershipErr };

  return { ok: true, code: RESULT.OK, command: deregisterCommand(b, serverNow) };
}
