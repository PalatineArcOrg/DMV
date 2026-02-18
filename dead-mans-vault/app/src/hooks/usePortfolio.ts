import { useState, useCallback, useMemo } from 'react';
import { PortfolioScanner } from '../services/PortfolioScanner';
import { TokenBalance, DeFiPosition } from '../types';
import { useWallet } from './useWallet';
import { useVaultStore } from '../store/useVaultStore';
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

  const totalUsdValue = useMemo(() => {
    const tokenTotal = balances.reduce((sum, b) => sum + b.usdValue, 0);
    // Add DeFi positions that don't have corresponding SPL tokens already in balances
    // (positions with tokens.length > 0 are LSTs like mSOL/jitoSOL already counted in token balances)
    const defiTotal = defiPositions
      .filter((p) => p.tokens.length === 0 && p.estimatedValueUsd > 0)
      .reduce((sum, p) => sum + p.estimatedValueUsd, 0);
    return tokenTotal + defiTotal;
  }, [balances, defiPositions]);

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

      // Enrich DeFi positions with USD values using SOL price
      const solToken = enrichedTokens.find((t) => t.symbol === 'SOL');
      const solPrice = solToken && solToken.amount > 0
        ? solToken.usdValue / solToken.amount
        : 0;
      const enrichedPositions = positions.map((pos) => {
        if (pos.estimatedValueUsd === 0 && pos.estimatedValueSol > 0 && solPrice > 0) {
          return { ...pos, estimatedValueUsd: pos.estimatedValueSol * solPrice };
        }
        return pos;
      });

      setDefiPositions(enrichedPositions);
      // Also persist to Zustand store so Dashboard can display them
      useVaultStore.getState().setDefiPositions(enrichedPositions);
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
