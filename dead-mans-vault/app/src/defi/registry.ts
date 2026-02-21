/**
 * Known DeFi token mints and protocol program IDs for position detection.
 * Covers: Marinade, Jito, Sanctum LSTs, Jupiter JLP, Kamino kTokens, Raydium LP tokens.
 */

import { ClosureStrategy, DeFiProtocol } from '../types/defi';

export interface MintInfo {
  protocol: DeFiProtocol;
  type: string;
  name: string;
  symbol: string;
  decimals: number;
  closureStrategy: ClosureStrategy;
}

/**
 * Map of known DeFi token mint addresses to their metadata.
 * Used by Layer 1 detection (token mint matching).
 */
export const KNOWN_DEFI_MINTS: Record<string, MintInfo> = {
  // --- Marinade ---
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So': {
    protocol: 'marinade',
    type: 'liquid_staking',
    name: 'Marinade Staked SOL',
    symbol: 'mSOL',
    decimals: 9,
    closureStrategy: 'jupiter_swap',
  },

  // --- Jito ---
  'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn': {
    protocol: 'jito',
    type: 'liquid_staking',
    name: 'Jito Staked SOL',
    symbol: 'jitoSOL',
    decimals: 9,
    closureStrategy: 'jupiter_swap',
  },

  // --- Sanctum LSTs ---
  'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1': {
    protocol: 'sanctum',
    type: 'liquid_staking',
    name: 'BlazeStake Staked SOL',
    symbol: 'bSOL',
    decimals: 9,
    closureStrategy: 'jupiter_swap',
  },
  '5oVNBeEEQvYi1cX3ir8Dx5n1P7pdxydbGF2X4TxVusJm': {
    protocol: 'sanctum',
    type: 'liquid_staking',
    name: 'Sanctum Infinity',
    symbol: 'INF',
    decimals: 9,
    closureStrategy: 'jupiter_swap',
  },
  'LSTxxxnJzKDFSLr4dUkPcmCf5VyryEqzPLz5j4bpxFp': {
    protocol: 'sanctum',
    type: 'liquid_staking',
    name: 'Liquid Staking Token',
    symbol: 'LST',
    decimals: 9,
    closureStrategy: 'jupiter_swap',
  },
  'he1iusmfkpAdwvxLNGV8Y1iSbj4rUy6yMhEA3fotn9A': {
    protocol: 'sanctum',
    type: 'liquid_staking',
    name: 'Helius Staked SOL',
    symbol: 'hSOL',
    decimals: 9,
    closureStrategy: 'jupiter_swap',
  },
  'jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v': {
    protocol: 'sanctum',
    type: 'liquid_staking',
    name: 'Jupiter Staked SOL',
    symbol: 'jupSOL',
    decimals: 9,
    closureStrategy: 'jupiter_swap',
  },
  'edge86g9cVz87xcpKpy3J77vbp4wYd9idEV562CCntt': {
    protocol: 'sanctum',
    type: 'liquid_staking',
    name: 'Edgevana Staked SOL',
    symbol: 'edgeSOL',
    decimals: 9,
    closureStrategy: 'jupiter_swap',
  },
  'picobAEvs6w7QEknPce34wAE4gknZA9v5tTonnmHYdX': {
    protocol: 'sanctum',
    type: 'liquid_staking',
    name: 'Picasso SOL',
    symbol: 'picoSOL',
    decimals: 9,
    closureStrategy: 'jupiter_swap',
  },
  'pathdXw4He1Xk3eX84pDdDZnGKEme3GivBamGCVPZ5a': {
    protocol: 'sanctum',
    type: 'liquid_staking',
    name: 'Pathfinders SOL',
    symbol: 'pathSOL',
    decimals: 9,
    closureStrategy: 'jupiter_swap',
  },
  'Comp4ssDzXcLeu2MnLuGNNFC4cmLPMng8qWHPvzAMU1h': {
    protocol: 'sanctum',
    type: 'liquid_staking',
    name: 'Compass SOL',
    symbol: 'compassSOL',
    decimals: 9,
    closureStrategy: 'jupiter_swap',
  },

  // --- Jupiter ---
  '27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4': {
    protocol: 'jupiter',
    type: 'perpetuals_lp',
    name: 'Jupiter Liquidity Provider',
    symbol: 'JLP',
    decimals: 6,
    closureStrategy: 'jupiter_swap',
  },

  // --- Kamino ---
  'KMNo3nJsBXfcpJTVhZcXLW7RmTwTt4GVFE7suUBo9sS': {
    protocol: 'kamino',
    type: 'vault',
    name: 'Kamino SOL',
    symbol: 'kSOL',
    decimals: 9,
    closureStrategy: 'jupiter_swap',
  },
};

/**
 * Known DeFi protocol program IDs for account scanning (Layer 2).
 */
export const PROTOCOL_PROGRAMS: Record<string, { protocol: DeFiProtocol; name: string }> = {
  // Orca Whirlpool (mainnet)
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc': {
    protocol: 'orca',
    name: 'Orca Whirlpool',
  },
  // Orca Whirlpool (devnet)
  '2LecshUwdy9xi7meFgHtFJQNSKk4KdTrcpvaB56dP2NQ': {
    protocol: 'orca',
    name: 'Orca Whirlpool (Devnet)',
  },
  // Raydium AMM V4
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8': {
    protocol: 'raydium',
    name: 'Raydium AMM V4',
  },
  // Raydium CLMM
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK': {
    protocol: 'raydium',
    name: 'Raydium CLMM',
  },
  // Meteora DLMM
  'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo': {
    protocol: 'meteora',
    name: 'Meteora DLMM',
  },
  // MarginFi
  'MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA': {
    protocol: 'marginfi',
    name: 'MarginFi V2',
  },
  // Kamino Lending
  'KLend2g3cP87ber41GhHvvPG7Lo2MdixiMwzLTowbhJg': {
    protocol: 'kamino',
    name: 'Kamino Lending',
  },
  // Marinade Finance
  'MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD': {
    protocol: 'marinade',
    name: 'Marinade Finance',
  },
};

export const WRAPPED_SOL_MINT = 'So11111111111111111111111111111111111111112';

/**
 * Well-known token symbols for devnet fallback.
 * Helius devnet API doesn't return symbol metadata, so we map them here.
 */
export const KNOWN_TOKEN_SYMBOLS: Record<string, { symbol: string; name: string }> = {
  // Wrapped SOL
  'So11111111111111111111111111111111111111112': { symbol: 'SOL', name: 'Wrapped SOL' },
  // USDC (devnet)
  '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU': { symbol: 'USDC', name: 'USD Coin' },
  // EURC (devnet)
  'HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr': { symbol: 'EURC', name: 'Euro Coin' },
  // USDC (mainnet)
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': { symbol: 'USDC', name: 'USD Coin' },
  // USDT
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': { symbol: 'USDT', name: 'Tether USD' },
  // Marinade mSOL
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So': { symbol: 'mSOL', name: 'Marinade Staked SOL' },
  // Jito jitoSOL
  'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn': { symbol: 'jitoSOL', name: 'Jito Staked SOL' },
  // Sanctum bSOL
  'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1': { symbol: 'bSOL', name: 'BlazeStake SOL' },
  // Sanctum INF
  '5oVNBeEEQvYi1cX3ir8Dx5n1P7pdxydbGF2X4TxVusJm': { symbol: 'INF', name: 'Sanctum Infinity' },
  // Jupiter JLP
  '27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4': { symbol: 'JLP', name: 'Jupiter LP' },
  // jupSOL
  'jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v': { symbol: 'jupSOL', name: 'Jupiter Staked SOL' },
  // Kamino kSOL
  'KMNo3nJsBXfcpJTVhZcXLW7RmTwTt4GVFE7suUBo9sS': { symbol: 'kSOL', name: 'Kamino SOL' },
  // MNDE (Marinade governance, devnet)
  'MNDEFzGvMt87ueuHvVU9VcTqsAP5b3fTGPsHuuPA5ey': { symbol: 'MNDE', name: 'Marinade' },
};

/**
 * Helius Enhanced Transaction source labels mapped to our DeFi protocols.
 */
export const HELIUS_SOURCE_MAP: Record<string, DeFiProtocol> = {
  'JUPITER': 'jupiter',
  'RAYDIUM': 'raydium',
  'ORCA': 'orca',
  'ORCA_WHIRLPOOLS': 'orca',
  'METEORA': 'meteora',
  'MARINADE': 'marinade',
  'MARGINFI': 'marginfi',
  'KAMINO': 'kamino',
  'JITO': 'jito',
};
