/**
 * TypeScript interfaces for external API responses.
 * Replaces `any` types in PortfolioScanner and DeFiDetector.
 */

// --- Helius DAS API ---

export interface DASAssetItem {
  id: string;
  interface: 'FungibleToken' | 'FungibleAsset' | 'V1_NFT' | 'V2_NFT' | 'ProgrammableNFT' | string;
  content?: {
    metadata?: {
      name?: string;
      symbol?: string;
    };
  };
  token_info?: {
    balance?: number;
    decimals?: number;
    symbol?: string;
    price_info?: {
      price_per_token?: number;
      currency?: string;
    };
  };
}

export interface DASGetAssetsByOwnerResult {
  total: number;
  limit: number;
  page: number;
  items: DASAssetItem[];
}

// --- Helius Enhanced Transactions API ---

export interface HeliusEnhancedTransaction {
  signature: string;
  type: string;
  source: string;
  fee: number;
  feePayer: string;
  slot: number;
  timestamp: number;
  description?: string;
  nativeTransfers?: {
    fromUserAccount: string;
    toUserAccount: string;
    amount: number;
  }[];
}

// --- Helius Priority Fee API ---

export interface PriorityFeeEstimateResult {
  priorityFeeEstimate: number;
}

// --- Pyth Hermes API ---

export interface PythPriceFeed {
  id: string;
  attributes?: {
    base?: string;
    quote_currency?: string;
    asset_type?: string;
  };
}

export interface PythPriceEntry {
  id: string;
  price?: {
    price: string;
    conf: string;
    expo: number;
    publish_time: number;
  };
  ema_price?: {
    price: string;
    conf: string;
    expo: number;
    publish_time: number;
  };
}

export interface PythPriceUpdateResponse {
  binary?: { encoding: string; data: string[] };
  parsed?: PythPriceEntry[];
}

// --- Jupiter Price API ---

export interface JupiterPriceData {
  id: string;
  type: string;
  price: string;
}

export interface JupiterPriceResponse {
  data: Record<string, JupiterPriceData>;
  timeTaken: number;
}
