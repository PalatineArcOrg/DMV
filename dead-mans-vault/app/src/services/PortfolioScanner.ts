import { Connection, PublicKey } from '@solana/web3.js';
import { TokenBalance, DeFiPosition } from '../types';
import { RPC_URL, KNOWN_TOKEN_LOGOS } from '../utils/constants';
import { DeFiDetector } from '../defi/detector';
import { KNOWN_TOKEN_SYMBOLS } from '../defi/registry';
import { fetchWithRetry, rpcWithRetry } from '../utils/fetchWithRetry';
import type {
  DASGetAssetsByOwnerResult,
  PythPriceFeed,
  PythPriceUpdateResponse,
  JupiterPriceResponse,
} from '../types/api';

// In-memory cache: symbol → Pyth feed ID (persists for app session)
const pythFeedCache = new Map<string, string>();
// Symbols we already know have no Pyth feed
const pythNoFeedSet = new Set<string>();

// Price cache with TTL (symbol → { price, timestamp })
const priceCache = new Map<string, { price: number; ts: number }>();
const PRICE_CACHE_TTL_MS = 60_000; // 60 seconds

const PYTH_HERMES_BASE = 'https://hermes.pyth.network';

export class PortfolioScanner {
  private connection: Connection;
  private heliusApiKey: string;
  private rpcUrl: string;

  constructor(rpcUrl: string, heliusApiKey: string) {
    this.connection = new Connection(rpcUrl);
    this.heliusApiKey = heliusApiKey;
    this.rpcUrl = rpcUrl;
  }

  async getTokenBalances(wallet: PublicKey): Promise<TokenBalance[]> {
    const balances: TokenBalance[] = [];

    // Always fetch native SOL balance via RPC (works without Helius key)
    const lamports = await this.connection.getBalance(wallet);
    balances.push({
      mint: PublicKey.default,
      symbol: 'SOL',
      amount: lamports / 1e9,
      decimals: 9,
      usdValue: 0,
    });

    // Fetch SPL tokens — try DAS getAssetsByOwner first, then Helius Balances, then RPC
    let gotTokens = false;
    if (this.heliusApiKey) {
      gotTokens = await this.fetchViaDAS(wallet, balances);
    }

    // RPC fallback: fetch SPL token accounts directly
    if (!gotTokens) {
      try {
        const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(
          wallet,
          { programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') },
        );
        for (const { account } of tokenAccounts.value) {
          const parsed = account.data.parsed?.info;
          if (!parsed) continue;
          const amount = parsed.tokenAmount;
          if (Number(amount.amount) <= 0) continue;
          const mintStr = parsed.mint as string;
          const known = KNOWN_TOKEN_SYMBOLS[mintStr];
          balances.push({
            mint: new PublicKey(mintStr),
            symbol: known?.symbol || mintStr.slice(0, 6),
            amount: Number(amount.uiAmountString),
            decimals: amount.decimals,
            usdValue: 0,
          });
        }
      } catch {
        // RPC token fetch is non-fatal
      }
    }

    await this.enrichWithPrices(balances);

    // Attach logo URIs from known token registry
    for (const balance of balances) {
      const mintStr = balance.mint.toString();
      const logo = KNOWN_TOKEN_LOGOS[mintStr];
      if (logo) {
        balance.logoUri = logo;
      }
    }

    return balances;
  }

  /**
   * Fetch tokens via Helius DAS getAssetsByOwner (modern replacement for Balances API).
   * Returns true if successful.
   */
  private async fetchViaDAS(wallet: PublicKey, balances: TokenBalance[]): Promise<boolean> {
    try {
      const result = await rpcWithRetry<DASGetAssetsByOwnerResult>(this.rpcUrl, 'getAssetsByOwner', [{
        ownerAddress: wallet.toString(),
        page: 1,
        limit: 1000,
        displayOptions: {
          showFungible: true,
          showNativeBalance: false,
          showZeroBalance: false,
        },
      }]);

      const items = result?.items || [];
      for (const item of items) {
        // Only process fungible tokens (skip NFTs, compressed NFTs)
        if (item.interface !== 'FungibleToken' && item.interface !== 'FungibleAsset') continue;

        const mintStr = item.id;
        if (!mintStr) continue;

        const tokenInfo = item.token_info;
        const balance = tokenInfo?.balance;
        const decimals = tokenInfo?.decimals ?? 0;

        if (!balance || Number(balance) <= 0) continue;

        const amount = Number(balance) / Math.pow(10, decimals);
        const known = KNOWN_TOKEN_SYMBOLS[mintStr];
        const symbol = tokenInfo?.symbol || item.content?.metadata?.symbol || known?.symbol || mintStr.slice(0, 6);

        balances.push({
          mint: new PublicKey(mintStr),
          symbol,
          amount,
          decimals,
          usdValue: 0,
        });
      }

      return true;
    } catch {
      return false;
    }
  }

  /**
   * Resolve Pyth feed IDs for a list of token symbols.
   * Uses in-memory cache to avoid repeated lookups.
   */
  private async resolvePythFeedIds(symbols: string[]): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    const uncached: string[] = [];

    for (const sym of symbols) {
      const upper = sym.toUpperCase();
      if (pythFeedCache.has(upper)) {
        result.set(upper, pythFeedCache.get(upper)!);
      } else if (!pythNoFeedSet.has(upper)) {
        uncached.push(upper);
      }
    }

    if (uncached.length === 0) return result;

    // Query Pyth for each uncached symbol in parallel
    const lookups = uncached.map(async (sym) => {
      try {
        const url = `${PYTH_HERMES_BASE}/v2/price_feeds?query=${sym}&asset_type=crypto`;
        const resp = await fetchWithRetry(url);
        if (!resp.ok) return;
        const feeds: PythPriceFeed[] = await resp.json();

        // Find exact match: base === symbol AND quote_currency === "USD"
        const match = feeds.find((f) => {
          const base = (f.attributes?.base || '').toUpperCase();
          const quote = (f.attributes?.quote_currency || '').toUpperCase();
          return base === sym && quote === 'USD';
        });

        if (match?.id) {
          pythFeedCache.set(sym, match.id);
          result.set(sym, match.id);
        } else {
          pythNoFeedSet.add(sym);
        }
      } catch {
        // Non-fatal — this symbol just won't have Pyth pricing
      }
    });

    await Promise.all(lookups);
    return result;
  }

  /**
   * Enrich balances with prices from Pyth Hermes REST API.
   * Uses a 60-second price cache to avoid redundant network calls.
   * Returns the number of balances that received prices.
   */
  private async enrichWithPythPrices(balances: TokenBalance[]): Promise<number> {
    const now = Date.now();
    const symbols = balances
      .filter((b) => b.amount > 0)
      .map((b) => b.symbol.toUpperCase());

    if (symbols.length === 0) return 0;

    // Check cache first — apply cached prices immediately
    let enriched = 0;
    const uncachedSymbols: string[] = [];
    for (const balance of balances) {
      const sym = balance.symbol.toUpperCase();
      const cached = priceCache.get(sym);
      if (cached && now - cached.ts < PRICE_CACHE_TTL_MS) {
        balance.usdValue = balance.amount * cached.price;
        enriched++;
      } else {
        uncachedSymbols.push(sym);
      }
    }

    if (uncachedSymbols.length === 0) return enriched;

    const feedMap = await this.resolvePythFeedIds(uncachedSymbols);
    if (feedMap.size === 0) return enriched;

    // Build batch price request
    const feedIds = Array.from(feedMap.values());
    const idsParam = feedIds.map((id) => `ids[]=${id}`).join('&');
    const url = `${PYTH_HERMES_BASE}/v2/updates/price/latest?${idsParam}`;

    try {
      const resp = await fetchWithRetry(url);
      if (!resp.ok) return enriched;
      const data: PythPriceUpdateResponse = await resp.json();

      // Build feedId → price map and update cache
      const priceFeedMap = new Map<string, number>();
      for (const entry of data.parsed || []) {
        const feedId = entry.id;
        const priceStr = entry.price?.price;
        const expo = entry.price?.expo;
        if (priceStr != null && expo != null) {
          const usdPrice = Number(priceStr) * Math.pow(10, expo);
          if (usdPrice > 0) {
            priceFeedMap.set(feedId, usdPrice);
          }
        }
      }

      // Assign prices to balances and update cache
      for (const balance of balances) {
        if (balance.usdValue > 0) continue; // Already priced from cache
        const sym = balance.symbol.toUpperCase();
        const feedId = feedMap.get(sym);
        if (feedId && priceFeedMap.has(feedId)) {
          const price = priceFeedMap.get(feedId)!;
          balance.usdValue = balance.amount * price;
          priceCache.set(sym, { price, ts: now });
          enriched++;
        }
      }
      return enriched;
    } catch {
      return enriched;
    }
  }

  /**
   * Enrich balances with Jupiter prices (fallback).
   */
  private async enrichWithJupiterPrices(balances: TokenBalance[]): Promise<void> {
    const WRAPPED_SOL = 'So11111111111111111111111111111111111111112';

    const mints = balances
      .filter((b) => b.amount > 0 && b.usdValue === 0)
      .map((b) => (b.mint.equals(PublicKey.default) ? WRAPPED_SOL : b.mint.toString()));

    if (mints.length === 0) return;

    try {
      const url = `https://api.jup.ag/price/v2?ids=${mints.join(',')}`;
      const response = await fetchWithRetry(url);
      if (!response.ok) return;
      const data: JupiterPriceResponse = await response.json();

      const now = Date.now();
      for (const balance of balances) {
        if (balance.usdValue > 0) continue; // Already priced by Pyth
        const mintKey = balance.mint.equals(PublicKey.default)
          ? WRAPPED_SOL
          : balance.mint.toString();
        const priceData = data.data?.[mintKey];
        if (priceData?.price) {
          const price = Number(priceData.price);
          balance.usdValue = balance.amount * price;
          // Cache Jupiter prices too
          priceCache.set(balance.symbol.toUpperCase(), { price, ts: now });
        }
      }
    } catch {
      // Price enrichment is non-critical
    }
  }

  /**
   * Main price enrichment: try Pyth first, then Jupiter as fallback for any missing.
   */
  private async enrichWithPrices(balances: TokenBalance[]): Promise<void> {
    // Try Pyth first
    try {
      await this.enrichWithPythPrices(balances);
    } catch {
      // Pyth failure is non-fatal
    }

    // Jupiter fallback for any balances that still have usdValue === 0
    try {
      await this.enrichWithJupiterPrices(balances);
    } catch {
      // Jupiter failure is non-fatal
    }
  }

  async detectDeFiPositions(wallet: PublicKey, preloadedBalances?: TokenBalance[]): Promise<DeFiPosition[]> {
    try {
      const tokenBalances = preloadedBalances ?? await this.getTokenBalances(wallet);
      const detector = new DeFiDetector(this.connection, this.heliusApiKey);
      return detector.detectAll(wallet, tokenBalances);
    } catch {
      return [];
    }
  }
}
