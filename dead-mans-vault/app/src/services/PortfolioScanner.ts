import { Connection, PublicKey } from '@solana/web3.js';
import { TokenBalance, DeFiPosition } from '../types';
import { HELIUS_API_BASE } from '../utils/constants';
import { DeFiDetector } from '../defi/detector';
import { KNOWN_TOKEN_SYMBOLS } from '../defi/registry';

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

  private async enrichWithPrices(balances: TokenBalance[]): Promise<void> {
    const WRAPPED_SOL = 'So11111111111111111111111111111111111111112';

    const mints = balances
      .filter((b) => b.amount > 0)
      .map((b) => (b.mint.equals(PublicKey.default) ? WRAPPED_SOL : b.mint.toString()));

    if (mints.length === 0) return;

    try {
      const url = `https://api.jup.ag/price/v2?ids=${mints.join(',')}`;
      const response = await fetch(url);
      if (!response.ok) return;
      const data = await response.json();

      for (const balance of balances) {
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

  async detectDeFiPositions(wallet: PublicKey): Promise<DeFiPosition[]> {
    try {
      const tokenBalances = await this.getTokenBalances(wallet);
      const detector = new DeFiDetector(this.connection, this.heliusApiKey);
      return detector.detectAll(wallet, tokenBalances);
    } catch (err) {
      console.error('DeFi detection failed:', err);
      return [];
    }
  }
}
