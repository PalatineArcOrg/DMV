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
}

export interface Beneficiary {
  label: string;
  wallet: PublicKey;
  shareBps: number;
  hasSpecificAssets: boolean;
  specificAssets?: SpecificAssetAssignment[];
  message?: string;
}

export interface SpecificAssetAssignment {
  mint: PublicKey;
  amount?: number;
  isNft: boolean;
}
