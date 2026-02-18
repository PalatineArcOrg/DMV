import { useCallback, useEffect, useRef, useMemo } from 'react';
import { PortfolioScanner } from '../services/PortfolioScanner';
import { TokenBalance } from '../types';
import { useWallet } from './useWallet';
import { useVaultStore } from '../store/useVaultStore';
import { usePortfolioStore } from '../store/usePortfolioStore';
import { HELIUS_API_KEY, RPC_URL } from '../utils/constants';
import { saveDailyPrice, getPreviousPrice } from '../db/priceHistoryRepo';

const REFRESH_INTERVAL_MS = 30_000;

export function usePortfolio() {
  const { publicKey } = useWallet();
  const { balances, defiPositions, totalUsdValue, solBalance, isLoading, error } =
    usePortfolioStore();
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isRefreshing = useRef(false);

  const scanner = useMemo(
    () => new PortfolioScanner(RPC_URL, HELIUS_API_KEY),
    [],
  );

  const refresh = useCallback(async () => {
    if (!publicKey || isRefreshing.current) return;
    isRefreshing.current = true;
    const store = usePortfolioStore.getState();
    store.setLoading(true);
    store.setError(null);
    try {
      const [tokens, positions] = await Promise.all([
        scanner.getTokenBalances(publicKey),
        scanner.detectDeFiPositions(publicKey),
      ]);

      const enrichedTokens: TokenBalance[] = await Promise.all(
        tokens.map(async (token) => {
          const mintStr = token.mint.toString();
          let change24h: number | null = null;

          if (token.usdValue > 0 && token.amount > 0) {
            const pricePerToken = token.usdValue / token.amount;
            await saveDailyPrice(mintStr, pricePerToken).catch(() => {});
            const prevPrice = await getPreviousPrice(mintStr).catch(() => null);
            if (prevPrice && prevPrice > 0) {
              change24h = ((pricePerToken - prevPrice) / prevPrice) * 100;
            }
          }

          return { ...token, change24h };
        }),
      );

      usePortfolioStore.getState().setBalances(enrichedTokens);

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

      usePortfolioStore.getState().setDefiPositions(enrichedPositions);
      useVaultStore.getState().setDefiPositions(enrichedPositions);
    } catch (err: any) {
      usePortfolioStore.getState().setError(err.message || 'Failed to scan portfolio');
    } finally {
      usePortfolioStore.getState().setLoading(false);
      isRefreshing.current = false;
    }
  }, [publicKey, scanner]);

  useEffect(() => {
    if (!publicKey) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }

    if (usePortfolioStore.getState().balances.length === 0) {
      refresh();
    }

    intervalRef.current = setInterval(refresh, REFRESH_INTERVAL_MS);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [publicKey, refresh]);

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
