import { Connection, PublicKey } from '@solana/web3.js';
import { createHash } from 'node:crypto';
import { config } from './config.js';

const connection = new Connection(config.rpcUrl, 'confirmed');
const PROGRAM_ID = new PublicKey(config.programId);

// Anchor 8-byte account discriminator = sha256("account:VaultConfig")[..8].
// Verified before parsing so a foreign or attacker-crafted account cannot be
// parsed as a VaultConfig.
const VAULT_CONFIG_DISCRIMINATOR = createHash('sha256')
  .update('account:VaultConfig')
  .digest()
  .subarray(0, 8);

// On-chain VaultConfig beneficiary cap. Bounds the parse loop so a crafted
// account with a huge benCount can't drive an out-of-bounds read / CPU DoS.
const MAX_BENEFICIARIES = 20;

export function heartbeatPda(vault) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('heartbeat'), new PublicKey(vault).toBuffer()],
    PROGRAM_ID,
  )[0];
}

/** Canonical vault PDA for an owner: ["vault", owner]. */
export function vaultConfigPda(owner) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('vault'), new PublicKey(owner).toBuffer()],
    PROGRAM_ID,
  )[0];
}

function hasVaultDiscriminator(data) {
  return data.length >= 8 && data.subarray(0, 8).equals(VAULT_CONFIG_DISCRIMINATOR);
}

/**
 * Parse VaultConfig. Layout (after 8-byte discriminator), v2 permissionless:
 *   owner(32) agent(32) interval(i64 le) grace(i64 le) benCount(u32 le)
 *   benCount*(wallet32 + shareBps u16)        <- 34 B each
 *   executed(u8) active(u8) ...
 * Bounds-checked: throws on a malformed/too-short buffer or an out-of-range
 * beneficiary count rather than reading past the buffer.
 */
export function parseVaultConfig(data) {
  let o = 8;
  if (data.length < o + 32 + 32 + 8 + 8 + 4) throw new Error('vault buffer too short');
  const owner = new PublicKey(data.subarray(o, o + 32)); o += 32;
  o += 32; // agent
  const interval = Number(data.readBigInt64LE(o)); o += 8;
  const grace = Number(data.readBigInt64LE(o)); o += 8;
  const benCount = data.readUInt32LE(o); o += 4;
  if (benCount > MAX_BENEFICIARIES) throw new Error('vault beneficiary count out of range');
  if (data.length < o + benCount * 34 + 2) throw new Error('vault buffer too short for beneficiaries');
  const beneficiaries = [];
  for (let i = 0; i < benCount; i++) {
    const wallet = new PublicKey(data.subarray(o, o + 32)); o += 32;
    const shareBps = data.readUInt16LE(o); o += 2;
    beneficiaries.push({ wallet: wallet.toBase58(), shareBps });
  }
  const executed = data[o] !== 0; o += 1;
  const active = data[o] !== 0; o += 1;
  return { owner: owner.toBase58(), interval, grace, executed, active, beneficiaries };
}

/**
 * Parse HeartbeatRecord. Layout (after 8-byte discriminator):
 *   vault(32) last_heartbeat(i64 le) last_method(u8) total_heartbeats(u64 le) bump(u8)
 */
export function parseHeartbeat(data) {
  let o = 8;
  if (data.length < o + 32 + 8) throw new Error('heartbeat buffer too short');
  o += 32; // vault
  const lastHeartbeat = Number(data.readBigInt64LE(o)); o += 8;
  return { lastHeartbeat };
}

/**
 * Read both accounts for a vault in one RPC round-trip. Only returns a parsed
 * config when the vault account is owned by the DMV program AND carries the
 * VaultConfig discriminator — a foreign/spoofed account yields config=null, so
 * callers treat it as absent (and the poller drops the junk registration).
 * `exists` therefore means "a valid DMV vault", not "some account is present".
 */
export async function readVaultState(vault) {
  const vaultPk = new PublicKey(vault);
  const hbPk = heartbeatPda(vault);
  const [vaultAcc, hbAcc] = await connection.getMultipleAccountsInfo([vaultPk, hbPk]);

  let cfg = null;
  if (vaultAcc && vaultAcc.owner.equals(PROGRAM_ID) && hasVaultDiscriminator(vaultAcc.data)) {
    try {
      cfg = parseVaultConfig(vaultAcc.data);
    } catch {
      cfg = null;
    }
  }

  let lastHeartbeat = null;
  if (hbAcc && hbAcc.owner.equals(PROGRAM_ID)) {
    try {
      lastHeartbeat = parseHeartbeat(hbAcc.data).lastHeartbeat;
    } catch {
      lastHeartbeat = null;
    }
  }

  return { exists: !!cfg, config: cfg, lastHeartbeat };
}

/**
 * Verify an (owner, vault) pair for registration:
 *   1. `vault` is the canonical PDA derived from `owner`, and
 *   2. the on-chain account is program-owned, is a VaultConfig, and its stored
 *      owner equals `owner`.
 * Returns { ok: true } or { ok: false, reason }.
 *
 * NOTE: this proves the vault is real and belongs to `owner`; it does NOT prove
 * the caller controls the owner wallet. Binding the device token to the owner
 * (to stop a third party hijacking another owner's notification channel) needs
 * an owner-wallet signature — see the server's register handler comment.
 */
export async function verifyVaultForOwner(owner, vault) {
  let expected;
  try {
    expected = vaultConfigPda(owner).toBase58();
  } catch {
    return { ok: false, reason: 'invalid owner' };
  }
  if (expected !== vault) return { ok: false, reason: 'vault is not the canonical PDA for owner' };

  let acc;
  try {
    acc = await connection.getAccountInfo(new PublicKey(vault));
  } catch {
    return { ok: false, reason: 'rpc error' };
  }
  if (!acc) return { ok: false, reason: 'vault not found on-chain' };
  if (!acc.owner.equals(PROGRAM_ID)) return { ok: false, reason: 'not a DMV program account' };
  if (!hasVaultDiscriminator(acc.data)) return { ok: false, reason: 'not a VaultConfig account' };

  let cfg;
  try {
    cfg = parseVaultConfig(acc.data);
  } catch {
    return { ok: false, reason: 'unparseable vault' };
  }
  if (cfg.owner !== owner) return { ok: false, reason: 'on-chain owner mismatch' };
  return { ok: true };
}
