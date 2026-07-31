import { PublicKey } from '@solana/web3.js';
import { BN } from '@coral-xyz/anchor';

/**
 * Hardened raw parsers for on-chain DMV accounts. The app falls back to raw
 * parsing because Hermes' BigInt gaps make Anchor's deserializer unreliable, but
 * a raw parse must not trust arbitrary bytes from a malicious/broken RPC. Every
 * parser here verifies: account is owned by the program, carries the Anchor
 * discriminator, meets a minimum length, and every read is bounds-checked (a
 * short or oversized buffer yields null, never a misleading partial parse).
 *
 * Discriminators are Anchor's sha256("account:<Name>")[..8]; the test recomputes
 * them so any drift is caught.
 */
const DISCRIMINATORS: Record<string, Buffer> = {
  VaultConfig: Buffer.from('63562bd8b866774d', 'hex'),
  ExecutionLog: Buffer.from('739734d563abc8f0', 'hex'),
  AssetPlan: Buffer.from('b273a24f4e46c32d', 'hex'),
  TokenDist: Buffer.from('fafdae6f2a52b22a', 'hex'),
  HeartbeatRecord: Buffer.from('1d0450269f346acb', 'hex'),
};

export interface AccountInfoLike {
  owner: PublicKey;
  data: Buffer;
}

/** True iff the account is program-owned, long enough, and has the discriminator. */
export function isProgramAccount(
  info: AccountInfoLike | null | undefined,
  name: keyof typeof DISCRIMINATORS,
  minLen: number,
  programId: PublicKey,
): boolean {
  if (!info || !info.owner || !info.owner.equals(programId)) return false;
  if (info.data.length < Math.max(minLen, 8)) return false;
  const disc = DISCRIMINATORS[name];
  return !!disc && info.data.subarray(0, 8).equals(disc);
}

// Bounds-checked sequential reader; throws RangeError on over-read (callers → null).
class Cursor {
  private data: Buffer;
  offset: number;
  constructor(data: Buffer, start = 0) {
    this.data = data;
    this.offset = start;
  }
  private need(n: number): void {
    if (this.offset + n > this.data.length) throw new RangeError('read past end of account buffer');
  }
  u8(): number {
    this.need(1);
    return this.data[this.offset++];
  }
  bool(): boolean {
    return this.u8() !== 0;
  }
  u16(): number {
    this.need(2);
    const v = this.data.readUInt16LE(this.offset);
    this.offset += 2;
    return v;
  }
  u32(): number {
    this.need(4);
    const v = this.data.readUInt32LE(this.offset);
    this.offset += 4;
    return v;
  }
  i64(): BN {
    this.need(8);
    const v = new BN(this.data.subarray(this.offset, this.offset + 8), 'le');
    this.offset += 8;
    return v;
  }
  u64big(): bigint {
    this.need(8);
    const v = this.data.readBigUInt64LE(this.offset);
    this.offset += 8;
    return v;
  }
  pubkey(): PublicKey {
    this.need(32);
    const v = new PublicKey(this.data.subarray(this.offset, this.offset + 32));
    this.offset += 32;
    return v;
  }
}

export interface RawVaultConfig {
  owner: PublicKey;
  agentPubkey: PublicKey;
  heartbeatInterval: BN;
  gracePeriod: BN;
  beneficiaries: { wallet: PublicKey; shareBps: number; hasSpecificAssets: boolean }[];
  executed: boolean;
  active: boolean;
  createdAt: BN;
  updatedAt: BN;
  bump: number;
  isMutable: boolean;
  hasAssetPlan: boolean;
  openTokenDists: number;
}

export interface RawHeartbeatRecord {
  vault: PublicKey;
  lastHeartbeat: BN;
  lastMethod: number;
  totalHeartbeats: bigint;
  bump: number;
}

export function parseVaultConfig(info: AccountInfoLike | null, programId: PublicKey): RawVaultConfig | null {
  if (!isProgramAccount(info, 'VaultConfig', 92, programId)) return null;
  try {
    const c = new Cursor(info!.data, 8);
    const owner = c.pubkey();
    const agentPubkey = c.pubkey();
    const heartbeatInterval = c.i64();
    const gracePeriod = c.i64();
    const beneficiaryCount = c.u32();
    if (beneficiaryCount > 20) return null; // cap before the loop
    const beneficiaries = [];
    for (let i = 0; i < beneficiaryCount; i++) {
      const wallet = c.pubkey();
      const shareBps = c.u16();
      beneficiaries.push({ wallet, shareBps, hasSpecificAssets: false });
    }
    const executed = c.bool();
    const active = c.bool();
    const createdAt = c.i64();
    const updatedAt = c.i64();
    const bump = c.u8();
    const isMutable = c.bool();
    const hasAssetPlan = c.bool();
    const openTokenDists = c.u16();
    return {
      owner, agentPubkey, heartbeatInterval, gracePeriod, beneficiaries,
      executed, active, createdAt, updatedAt, bump, isMutable, hasAssetPlan, openTokenDists,
    };
  } catch {
    return null;
  }
}

export function parseHeartbeatRecord(
  info: AccountInfoLike | null,
  programId: PublicKey,
): RawHeartbeatRecord | null {
  if (!isProgramAccount(info, 'HeartbeatRecord', 58, programId)) return null;
  try {
    const c = new Cursor(info!.data, 8);
    const vault = c.pubkey();
    const lastHeartbeat = c.i64();
    const lastMethod = c.u8();
    if (lastMethod > 4) return null;
    return {
      vault,
      lastHeartbeat,
      lastMethod,
      totalHeartbeats: c.u64big(),
      bump: c.u8(),
    };
  } catch {
    return null;
  }
}

export function parseExecutionLog(
  info: AccountInfoLike | null,
  programId: PublicKey,
): { solSnapshot: BN; solPaidMask: number; completed: boolean } | null {
  if (!isProgramAccount(info, 'ExecutionLog', 66, programId)) return null;
  try {
    const c = new Cursor(info!.data, 8 + 32); // skip disc + vault
    const solSnapshot = c.i64();
    const solPaidMask = c.u32();
    c.i64(); // started_at
    const completed = c.bool();
    return { solSnapshot, solPaidMask, completed };
  } catch {
    return null;
  }
}

export function parseAssetPlan(
  info: AccountInfoLike | null,
  programId: PublicKey,
): { assignments: { mint: PublicKey; amount: BN; beneficiaryIndex: number; isNft: boolean }[]; paidMask: bigint } | null {
  if (!isProgramAccount(info, 'AssetPlan', 44, programId)) return null;
  try {
    const c = new Cursor(info!.data, 8 + 32); // skip disc + vault
    const len = c.u32();
    if (len > 64) return null; // cap before the loop
    const assignments = [];
    for (let i = 0; i < len; i++) {
      const mint = c.pubkey();
      const amount = c.i64();
      const beneficiaryIndex = c.u8();
      const isNft = c.bool();
      assignments.push({ mint, amount, beneficiaryIndex, isNft });
    }
    const paidMask = c.u64big();
    return { assignments, paidMask };
  } catch {
    return null;
  }
}

export function parseTokenDist(
  info: AccountInfoLike | null,
  programId: PublicKey,
): { snapshot: BN; paidMask: number } | null {
  if (!isProgramAccount(info, 'TokenDist', 85, programId)) return null;
  try {
    const c = new Cursor(info!.data, 8 + 32 + 32); // skip disc + vault + mint
    const snapshot = c.i64();
    const paidMask = c.u32();
    return { snapshot, paidMask };
  } catch {
    return null;
  }
}

/** deadline = last_heartbeat + interval + grace, from verified vault + heartbeat accounts. */
export function parseDeadline(
  vaultInfo: AccountInfoLike | null,
  hbInfo: AccountInfoLike | null,
  programId: PublicKey,
): number | null {
  // minLen guards make the fixed-offset reads below in-bounds.
  if (!isProgramAccount(vaultInfo, 'VaultConfig', 88, programId)) return null;
  if (!isProgramAccount(hbInfo, 'HeartbeatRecord', 48, programId)) return null;
  try {
    const interval = Number(new BN(vaultInfo!.data.subarray(72, 80), 'le')); // 8+32+32
    const grace = Number(new BN(vaultInfo!.data.subarray(80, 88), 'le'));
    const lastHeartbeat = Number(new BN(hbInfo!.data.subarray(40, 48), 'le')); // 8+32
    return lastHeartbeat + interval + grace;
  } catch {
    return null;
  }
}
