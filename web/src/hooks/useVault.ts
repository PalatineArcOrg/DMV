import { useCallback, useEffect, useMemo, useState } from 'react';
import { PublicKey } from '@solana/web3.js';
import { useWallet } from '@solana/wallet-adapter-react';
import { VaultTransactionService } from '../lib/core';

export interface Beneficiary {
  wallet: string;
  shareBps: number;
}
export interface VaultToken {
  mint: string;
  amount: bigint;
  decimals: number;
  uiAmount: number;
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
      const config = await svc.fetchVaultConfig(owner);
      if (!config) {
        setVault(null);
        setExists(false);
        return;
      }
      const [vaultPda] = svc.getVaultPDA(owner);
      const [deadline, solLamports, tokens] = await Promise.all([
        svc.getOnChainDeadline(owner),
        svc.getConnection().getBalance(vaultPda),
        svc.getVaultTokenBalances(vaultPda),
      ]);
      let planAssignments = 0;
      if (config.hasAssetPlan) {
        const plan = await svc.fetchAssetPlan(owner).catch(() => null);
        planAssignments = plan?.assignments.length ?? 0;
      }
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
