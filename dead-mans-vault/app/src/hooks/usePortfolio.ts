import { useState, useCallback, useMemo } from 'react';
import { PortfolioScanner } from '../services/PortfolioScanner';
import { TokenBalance, DeFiPosition } from '../types';
import { useWallet } from './useWallet';
import { HELIUS_API_KEY, RPC_URL } from '../utils/constants';
import { saveDailyPrice, getPreviousPrice } from '../db/priceHistoryRepo';

export function usePortfolio() {
  const { publicKey } = useWallet();
  const [balances, setBalances] = useState<TokenBalance[]>([]);
  const [defiPositions, setDefiPositions] = useState<DeFiPosition[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scanner = useMemo(
    () => new PortfolioScanner(RPC_URL, HELIUS_API_KEY),
    [],
  );

  const totalUsdValue = useMemo(
    () => balances.reduce((sum, b) => sum + b.usdValue, 0),
    [balances],
  );

  const solBalance = useMemo(
    () => balances.find((b) => b.symbol === 'SOL')?.amount ?? 0,
    [balances],
  );

  const refresh = useCallback(async () => {
    if (!publicKey) return;
    setIsLoading(true);
    setError(null);
    try {
      const [tokens, positions] = await Promise.all([
        scanner.getTokenBalances(publicKey),
        scanner.detectDeFiPositions(publicKey),
      ]);

      // Save daily prices and compute 24h changes
      const enrichedTokens: TokenBalance[] = await Promise.all(
        tokens.map(async (token) => {
          const mintStr = token.mint.toString();
          let change24h: number | null = null;

          if (token.usdValue > 0 && token.amount > 0) {
            const pricePerToken = token.usdValue / token.amount;
            // Save first fetch of the day
            await saveDailyPrice(mintStr, pricePerToken).catch(() => {});
            // Get yesterday's price
            const prevPrice = await getPreviousPrice(mintStr).catch(() => null);
            if (prevPrice && prevPrice > 0) {
              change24h = ((pricePerToken - prevPrice) / prevPrice) * 100;
            }
          }

          return { ...token, change24h };
        }),
      );

      setBalances(enrichedTokens);
      setDefiPositions(positions);
    } catch (err: any) {
      setError(err.message || 'Failed to scan portfolio');
    } finally {
      setIsLoading(false);
    }
  }, [publicKey, scanner]);

  return {
    balances,
    defiPositions,
    totalUsdValue,
    solBalance,
    isLoading,
    error,
    refresh,
  };
}
