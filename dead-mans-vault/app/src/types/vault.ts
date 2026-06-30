import { PublicKey } from '@solana/web3.js';
import { BN } from '@coral-xyz/anchor';

export interface VaultConfig {
  owner: PublicKey;
  agentPubkey: PublicKey;
  heartbeatInterval: BN;
  gracePeriod: BN;
  beneficiaries: Beneficiary[];
  executed: boolean;
  active: boolean;
  createdAt: BN;
  updatedAt: BN;
  bump: number;
  isMutable: boolean;
  /** Whether a canonical AssetPlan PDA exists (set by set_asset_plan). */
  hasAssetPlan: boolean;
  /** Number of open TokenDist PDAs (must be 0 before owner-close). */
  openTokenDists: number;
}

export interface Beneficiary {
  label: string;
  wallet: PublicKey;
  shareBps: number;
  /**
   * UI-only derived flag — NOT an on-chain field. The on-chain Beneficiary is
   * just { wallet, share_bps }. Specific bequests live in the AssetPlan PDA.
   */
  hasSpecificAssets: boolean;
  specificAssets?: SpecificAssetAssignment[];
  message?: string;
}

export interface SpecificAssetAssignment {
  mint: PublicKey;
  amount?: number;
  isNft: boolean;
}

/**
 * One specific bequest in the on-chain AssetPlan (SPL token / NFT only in v1).
 * `beneficiaryIndex` indexes into VaultConfig.beneficiaries.
 */
export interface AssetAssignment {
  mint: PublicKey;
  amount: BN | number;
  beneficiaryIndex: number;
  isNft: boolean;
}
