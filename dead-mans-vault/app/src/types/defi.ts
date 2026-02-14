import { PublicKey } from '@solana/web3.js';

export interface TokenBalance {
  mint: PublicKey;
  symbol: string;
  amount: number;
  decimals: number;
  usdValue: number;
}

export type DeFiProtocol =
  | 'marginfi'
  | 'raydium'
  | 'orca'
  | 'meteora'
  | 'marinade'
  | 'jito'
  | 'native_stake';

export type DeFiPositionAction = 'close' | 'transfer' | 'ignore';

export interface DeFiPosition {
  protocol: DeFiProtocol;
  type: string;
  description: string;
  estimatedValueUsd: number;
  estimatedValueSol: number;
  tokens: TokenBalance[];
  action: DeFiPositionAction;
  accountAddress: PublicKey;
  rawData?: unknown;
}
