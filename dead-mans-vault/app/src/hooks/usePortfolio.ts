import { useCallback, useEffect, useRef, useMemo } from 'react';
import { PortfolioScanner } from '../services/PortfolioScanner';
import { TokenBalance } from '../types';
import { useWallet } from './useWallet';
import { useVaultStore } from '../store/useVaultStore';
import { usePortfolioStore } from '../store/usePortfolioStore';
import { getRpcUrl, getHeliusApiKey } from '../utils/rpcConfig';
import { saveDailyPrice, getPreviousPrice } from '../db/priceHistoryRepo';

const BALANCE_REFRESH_MS = 30_000;    // Token balances: every 30s
const DEFI_REFRESH_MS = 300_000;      // DeFi detection: every 5 min (saves 100 credits/call)

export function usePortfolio() {
  const { publicKey } = useWallet();
  const { balances, defiPositions, totalUsdValue, solBalance, isLoading, error } =
    usePortfolioStore();
  const balanceIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const defiIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isRefreshingBalances = useRef(false);
  const isRefreshingDefi = useRef(false);

  const scanner = useMemo(
    () => new PortfolioScanner(getRpcUrl(), getHeliusApiKey()),
    [],
  );

  const refreshBalances = useCallback(async () => {
    if (!publicKey || isRefreshingBalances.current) return;
    isRefreshingBalances.current = true;
    const store = usePortfolioStore.getState();
    store.setLoading(true);
    store.setError(null);
    try {
      const tokens = await scanner.getTokenBalances(publicKey);

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
    } catch (err: any) {
      usePortfolioStore.getState().setError(err.message || 'Failed to scan portfolio');
    } finally {
      usePortfolioStore.getState().setLoading(false);
      isRefreshingBalances.current = false;
    }
  }, [publicKey, scanner]);

  const refreshDefi = useCallback(async () => {
    if (!publicKey || isRefreshingDefi.current) return;
    isRefreshingDefi.current = true;
    try {
      // Pass cached balances to avoid duplicate DAS + pricing pipeline
      const cachedBalances = usePortfolioStore.getState().balances;
      const positions = await scanner.detectDeFiPositions(
        publicKey,
        cachedBalances.length > 0 ? cachedBalances : undefined,
      );

      const solToken = usePortfolioStore.getState().balances.find((t) => t.symbol === 'SOL');
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
    } catch {
      // DeFi detection is non-critical
    } finally {
      isRefreshingDefi.current = false;
    }
  }, [publicKey, scanner]);

  // Combined refresh for initial load
  const refresh = useCallback(async () => {
    await refreshBalances();
    await refreshDefi();
  }, [refreshBalances, refreshDefi]);

  const prevPublicKeyRef = useRef(publicKey?.toBase58() ?? '');

  useEffect(() => {
    if (!publicKey) {
      if (balanceIntervalRef.current) {
        clearInterval(balanceIntervalRef.current);
        balanceIntervalRef.current = null;
      }
      if (defiIntervalRef.current) {
        clearInterval(defiIntervalRef.current);
        defiIntervalRef.current = null;
      }
      return;
    }

    // Detect wallet switch — reset stale portfolio data
    const currentKey = publicKey.toBase58();
    const isSwitch = prevPublicKeyRef.current !== '' && prevPublicKeyRef.current !== currentKey;
    prevPublicKeyRef.current = currentKey;

    if (isSwitch) {
      usePortfolioStore.getState().reset();
    }

    // Initial refresh on mount or wallet switch
    refreshBalances();
    refreshDefi();

    // Separate intervals: balances fast, DeFi slow
    balanceIntervalRef.current = setInterval(refreshBalances, BALANCE_REFRESH_MS);
    defiIntervalRef.current = setInterval(refreshDefi, DEFI_REFRESH_MS);

    return () => {
      if (balanceIntervalRef.current) {
        clearInterval(balanceIntervalRef.current);
        balanceIntervalRef.current = null;
      }
      if (defiIntervalRef.current) {
        clearInterval(defiIntervalRef.current);
        defiIntervalRef.current = null;
      }
    };
  }, [publicKey, refreshBalances, refreshDefi]);

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
