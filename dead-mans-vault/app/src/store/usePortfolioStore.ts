import { create } from 'zustand';
import { TokenBalance, DeFiPosition } from '../types';

interface PortfolioStore {
  balances: TokenBalance[];
  defiPositions: DeFiPosition[];
  totalUsdValue: number;
  solBalance: number;
  isLoading: boolean;
  error: string | null;
  lastRefresh: number;

  setBalances: (balances: TokenBalance[]) => void;
  setDefiPositions: (positions: DeFiPosition[]) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  reset: () => void;
}

export const usePortfolioStore = create<PortfolioStore>((set) => ({
  balances: [],
  defiPositions: [],
  totalUsdValue: 0,
  solBalance: 0,
  isLoading: false,
  error: null,
  lastRefresh: 0,

  setBalances: (balances) => {
    const tokenTotal = balances.reduce((sum, b) => sum + b.usdValue, 0);
    const solBal = balances.find((b) => b.symbol === 'SOL')?.amount ?? 0;
    set((state) => {
      const defiTotal = state.defiPositions
        .filter((p) => p.tokens.length === 0 && p.estimatedValueUsd > 0)
        .reduce((sum, p) => sum + p.estimatedValueUsd, 0);
      return {
        balances,
        totalUsdValue: tokenTotal + defiTotal,
        solBalance: solBal,
        lastRefresh: Date.now(),
      };
    });
  },
  setDefiPositions: (positions) =>
    set((state) => {
      const defiTotal = positions
        .filter((p) => p.tokens.length === 0 && p.estimatedValueUsd > 0)
        .reduce((sum, p) => sum + p.estimatedValueUsd, 0);
      const tokenTotal = state.balances.reduce((sum, b) => sum + b.usdValue, 0);
      return {
        defiPositions: positions,
        totalUsdValue: tokenTotal + defiTotal,
      };
    }),
  setLoading: (loading) => set({ isLoading: loading }),
  setError: (error) => set({ error }),
  reset: () =>
    set({
      balances: [],
      defiPositions: [],
      totalUsdValue: 0,
      solBalance: 0,
      isLoading: false,
      error: null,
      lastRefresh: 0,
    }),
}));
