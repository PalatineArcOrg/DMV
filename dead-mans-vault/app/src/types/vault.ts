import { PublicKey } from '@solana/web3.js';

export interface VaultConfig {
  owner: PublicKey;
  agentPubkey: PublicKey;
  heartbeatInterval: number;
  gracePeriod: number;
  beneficiaries: Beneficiary[];
  executed: boolean;
  active: boolean;
  createdAt: number;
  updatedAt: number;
  bump: number;
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
