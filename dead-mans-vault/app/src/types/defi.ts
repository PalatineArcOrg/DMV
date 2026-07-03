import { PublicKey } from '@solana/web3.js';

export interface TokenBalance {
  mint: PublicKey;
  symbol: string;
  amount: number;
  decimals: number;
  usdValue: number;
  change24h?: number | null;
  logoUri?: string | null;
  isNft?: boolean;
  image?: string;
}

export type DeFiProtocol =
  | 'marginfi'
  | 'raydium'
  | 'orca'
  | 'meteora'
  | 'marinade'
  | 'jito'
  | 'sanctum'
  | 'kamino'
  | 'jupiter'
  | 'native_stake';

export type DeFiPositionAction = 'close' | 'transfer' | 'ignore';

export type ClosureStrategy =
  | 'jupiter_swap'
  | 'protocol_native'
  | 'unsupported';

export interface DeFiPosition {
  protocol: DeFiProtocol;
  type: string;
  description: string;
  estimatedValueUsd: number;
  estimatedValueSol: number;
  tokens: TokenBalance[];
  action: DeFiPositionAction;
  accountAddress: PublicKey;
  closureStrategy: ClosureStrategy;
  tokenMint?: string;
  tokenAmount?: number;
  tokenDecimals?: number;
  rawData?: unknown;
}

export interface ClosureResult {
  success: boolean;
  txSignature?: string;
  solRecovered?: number;
  error?: string;
  simulated: boolean;
}
