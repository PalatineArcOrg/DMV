import { Connection, PublicKey } from '@solana/web3.js';
import { config } from './config.js';

const connection = new Connection(config.rpcUrl, 'confirmed');
const PROGRAM_ID = new PublicKey(config.programId);

export function heartbeatPda(vault) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('heartbeat'), new PublicKey(vault).toBuffer()],
    PROGRAM_ID,
  )[0];
}

/**
 * Parse VaultConfig. Layout (after 8-byte discriminator), v2 permissionless:
 *   owner(32) agent(32) interval(i64 le) grace(i64 le) benCount(u32 le)
 *   benCount*(wallet32 + shareBps u16)        <- 34 B each (dropped hasAssets u8)
 *   executed(u8) active(u8) createdAt(i64) updatedAt(i64) bump(u8) isMutable(u8)
 *   hasAssetPlan(u8) openTokenDists(u16) ...padding
 */
export function parseVaultConfig(data) {
  let o = 8;
  const owner = new PublicKey(data.subarray(o, o + 32)); o += 32;
  o += 32; // agent
  const interval = Number(data.readBigInt64LE(o)); o += 8;
  const grace = Number(data.readBigInt64LE(o)); o += 8;
  const benCount = data.readUInt32LE(o); o += 4;
  o += benCount * (32 + 2); // Beneficiary { wallet:32, share_bps:2 }
  const executed = data[o] !== 0; o += 1;
  const active = data[o] !== 0; o += 1;
  return { owner: owner.toBase58(), interval, grace, executed, active };
}

/**
 * Parse HeartbeatRecord. Layout (after 8-byte discriminator):
 *   vault(32) last_heartbeat(i64 le) last_method(u8) total_heartbeats(u64 le) bump(u8)
 */
export function parseHeartbeat(data) {
  let o = 8;
  o += 32; // vault
  const lastHeartbeat = Number(data.readBigInt64LE(o)); o += 8;
  return { lastHeartbeat };
}

/**
 * Read both accounts for a vault in one RPC round-trip.
 * Returns null fields when an account is missing (e.g. revoked vault).
 */
export async function readVaultState(vault) {
  const vaultPk = new PublicKey(vault);
  const hbPk = heartbeatPda(vault);
  const [vaultAcc, hbAcc] = await connection.getMultipleAccountsInfo([vaultPk, hbPk]);

  const cfg = vaultAcc ? parseVaultConfig(vaultAcc.data) : null;
  const hb = hbAcc ? parseHeartbeat(hbAcc.data) : null;

  return {
    exists: !!vaultAcc,
    config: cfg,
    lastHeartbeat: hb ? hb.lastHeartbeat : null,
  };
}
