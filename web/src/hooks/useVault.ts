import { useCallback, useEffect, useMemo, useState } from 'react';
import { PublicKey } from '@solana/web3.js';
import { useWallet } from '@solana/wallet-adapter-react';
import { VaultTransactionService } from '../lib/core';
import { fetchOwnerAssetMeta } from '../lib/assetMeta';

export interface Beneficiary {
  wallet: string;
  shareBps: number;
}
export interface VaultToken {
  mint: string;
  amount: bigint;
  decimals: number;
  uiAmount: number;
  isNft: boolean;
  name?: string;
  symbol?: string;
  image?: string;
}
export interface VaultView {
  vaultPda: string;
  owner: string;
  active: boolean;
  executed: boolean;
  isMutable: boolean;
  hasAssetPlan: boolean;
  openTokenDists: number;
  beneficiaries: Beneficiary[];
  heartbeatInterval: number;
  gracePeriod: number;
  deadline: number | null;
  solLamports: number;
  tokens: VaultToken[];
  planAssignments: number;
}

function num(bnOrNum: { toNumber?: () => number } | number | undefined): number {
  if (bnOrNum == null) return 0;
  if (typeof bnOrNum === 'number') return bnOrNum;
  return typeof bnOrNum.toNumber === 'function' ? bnOrNum.toNumber() : Number(bnOrNum);
}

/** Read-model for the connected wallet's OWN vault (null if they don't own one). */
export function useVault() {
  const { publicKey } = useWallet();
  const svc = useMemo(() => new VaultTransactionService(), []);
  const [vault, setVault] = useState<VaultView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exists, setExists] = useState<boolean | null>(null); // null = unknown yet

  const refresh = useCallback(async () => {
    if (!publicKey) {
      setVault(null);
      setExists(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const owner = publicKey;
      // LOAD (source of truth for "does a vault exist"). Only this decides exists.
      const config = await svc.fetchVaultConfig(owner);
      if (!config) {
        setVault(null);
        setExists(false);
        return;
      }
      const [vaultPda] = svc.getVaultPDA(owner);
      // ENRICHMENT (decorative). Each isolated — a failure here must NEVER hide the
      // vault the LOAD already proved exists. Defaults keep the console usable.
      const [deadline, solLamports, tokens, planAssignments, meta] = await Promise.all([
        svc.getOnChainDeadline(owner).catch(() => null),
        svc.getConnection().getBalance(vaultPda).catch(() => 0),
        svc.getVaultTokenBalances(vaultPda).catch(() => []),
        config.hasAssetPlan
          ? svc.fetchAssetPlan(owner).then((p) => p?.assignments.length ?? 0).catch(() => 0)
          : Promise.resolve(0),
        // names/logos for the vault's holdings — parallel + isolated (best-effort).
        fetchOwnerAssetMeta(vaultPda.toBase58()).catch(() => new Map()),
      ]);
      setVault({
        vaultPda: vaultPda.toBase58(),
        owner: owner.toBase58(),
        active: !!config.active,
        executed: !!config.executed,
        isMutable: !!config.isMutable,
        hasAssetPlan: !!config.hasAssetPlan,
        openTokenDists: num(config.openTokenDists),
        beneficiaries: (config.beneficiaries ?? []).map((b: { wallet: PublicKey; shareBps: number }) => ({
          wallet: b.wallet.toString(),
          shareBps: Number(b.shareBps),
        })),
        heartbeatInterval: num(config.heartbeatInterval),
        gracePeriod: num(config.gracePeriod),
        deadline,
        solLamports,
        tokens: tokens.map((t) => ({
          mint: t.mint.toBase58(),
          amount: t.amount,
          decimals: t.decimals,
          uiAmount: t.uiAmount,
          isNft: t.decimals === 0 && t.amount === 1n,
          ...meta.get(t.mint.toBase58()),
        })),
        planAssignments,
      });
      setExists(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load your vault.');
    } finally {
      setLoading(false);
    }
  }, [publicKey, svc]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { vault, exists, loading, error, refresh, svc };
}
