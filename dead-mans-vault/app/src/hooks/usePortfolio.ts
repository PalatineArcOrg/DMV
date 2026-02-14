import { useState, useCallback, useMemo } from 'react';
import { PortfolioScanner } from '../services/PortfolioScanner';
import { TokenBalance, DeFiPosition } from '../types';
import { useWallet } from './useWallet';
import { HELIUS_API_KEY, RPC_URL } from '../utils/constants';

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
      setBalances(tokens);
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
