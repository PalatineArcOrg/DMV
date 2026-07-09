import { useCallback, useEffect, useMemo, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { VaultTransactionService } from '../lib/core';
import { fetchOwnerAssetMeta } from '../lib/assetMeta';

export interface WalletAsset {
  mint: string;
  amount: bigint; // raw base units
  decimals: number;
  uiAmount: number;
  isNft: boolean;
  name?: string;
  symbol?: string;
  image?: string;
}

/** The connected wallet's own SPL + NFT holdings (what it can deposit into the vault). */
export function useWalletAssets() {
  const { publicKey } = useWallet();
  const svc = useMemo(() => new VaultTransactionService(), []);
  const [assets, setAssets] = useState<WalletAsset[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!publicKey) {
      setAssets([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      // LOAD (source of truth for what exists + exact amounts).
      const raw = await svc.getVaultTokenBalances(publicKey);
      const base: WalletAsset[] = raw.map((t) => ({
        mint: t.mint.toBase58(),
        amount: t.amount,
        decimals: t.decimals,
        uiAmount: t.uiAmount,
        isNft: t.decimals === 0 && t.amount === 1n,
      }));
      setAssets(base); // show immediately, unenriched
      // ENRICHMENT (names/logos) — best-effort, must never drop an asset.
      const meta = await fetchOwnerAssetMeta(publicKey.toBase58());
      if (meta.size) setAssets(base.map((a) => ({ ...a, ...meta.get(a.mint) })));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load your wallet assets.');
    } finally {
      setLoading(false);
    }
  }, [publicKey, svc]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { assets, loading, error, refresh, svc };
}
