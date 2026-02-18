import { Connection, PublicKey } from '@solana/web3.js';
import { TokenBalance, DeFiPosition } from '../types';
import { HELIUS_API_BASE } from '../utils/constants';
import { DeFiDetector } from '../defi/detector';
import { KNOWN_TOKEN_SYMBOLS } from '../defi/registry';

// In-memory cache: symbol → Pyth feed ID (persists for app session)
const pythFeedCache = new Map<string, string>();
// Symbols we already know have no Pyth feed
const pythNoFeedSet = new Set<string>();

const PYTH_HERMES_BASE = 'https://hermes.pyth.network';

export class PortfolioScanner {
  private connection: Connection;
  private heliusApiKey: string;

  constructor(rpcUrl: string, heliusApiKey: string) {
    this.connection = new Connection(rpcUrl);
    this.heliusApiKey = heliusApiKey;
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

    // Fetch SPL tokens — try Helius first, fall back to RPC
    let gotTokens = false;
    if (this.heliusApiKey) {
      try {
        const url = `${HELIUS_API_BASE}/addresses/${wallet.toString()}/balances?api-key=${this.heliusApiKey}`;
        const response = await fetch(url);
        if (response.ok) {
          const data = await response.json();
          for (const token of data.tokens || []) {
            if (token.amount > 0) {
              const mintStr = token.mint as string;
              const known = KNOWN_TOKEN_SYMBOLS[mintStr];
              balances.push({
                mint: new PublicKey(mintStr),
                symbol: token.symbol || known?.symbol || mintStr.slice(0, 6),
                amount: token.amount / Math.pow(10, token.decimals),
                decimals: token.decimals,
                usdValue: 0,
              });
            }
          }
          gotTokens = true;
        }
      } catch {
        // Fall through to RPC fallback
      }
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
    return balances;
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
        const resp = await fetch(url);
        if (!resp.ok) return;
        const feeds: any[] = await resp.json();

        // Find exact match: base === symbol AND quote_currency === "USD"
        const match = feeds.find((f: any) => {
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
   * Returns the number of balances that received prices.
   */
  private async enrichWithPythPrices(balances: TokenBalance[]): Promise<number> {
    const symbols = balances
      .filter((b) => b.amount > 0)
      .map((b) => b.symbol.toUpperCase());

    if (symbols.length === 0) return 0;

    const feedMap = await this.resolvePythFeedIds(symbols);
    if (feedMap.size === 0) return 0;

    // Build batch price request
    const feedIds = Array.from(feedMap.values());
    const idsParam = feedIds.map((id) => `ids[]=${id}`).join('&');
    const url = `${PYTH_HERMES_BASE}/v2/updates/price/latest?${idsParam}`;

    try {
      const resp = await fetch(url);
      if (!resp.ok) return 0;
      const data = await resp.json();

      // Build feedId → price map
      const priceMap = new Map<string, number>();
      for (const entry of data.parsed || []) {
        const feedId = entry.id;
        const priceStr = entry.price?.price;
        const expo = entry.price?.expo;
        if (priceStr != null && expo != null) {
          const usdPrice = Number(priceStr) * Math.pow(10, expo);
          if (usdPrice > 0) {
            priceMap.set(feedId, usdPrice);
          }
        }
      }

      // Assign prices to balances
      let enriched = 0;
      for (const balance of balances) {
        const sym = balance.symbol.toUpperCase();
        const feedId = feedMap.get(sym);
        if (feedId && priceMap.has(feedId)) {
          balance.usdValue = balance.amount * priceMap.get(feedId)!;
          enriched++;
        }
      }
      return enriched;
    } catch {
      return 0;
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
      const response = await fetch(url);
      if (!response.ok) return;
      const data = await response.json();

      for (const balance of balances) {
        if (balance.usdValue > 0) continue; // Already priced by Pyth
        const mintKey = balance.mint.equals(PublicKey.default)
          ? WRAPPED_SOL
          : balance.mint.toString();
        const priceData = data.data?.[mintKey];
        if (priceData?.price) {
          balance.usdValue = balance.amount * Number(priceData.price);
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

  async detectDeFiPositions(wallet: PublicKey): Promise<DeFiPosition[]> {
    try {
      const tokenBalances = await this.getTokenBalances(wallet);
      const detector = new DeFiDetector(this.connection, this.heliusApiKey);
      return detector.detectAll(wallet, tokenBalances);
    } catch {
      return [];
    }
  }
}
