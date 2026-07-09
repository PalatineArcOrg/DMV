import { useCallback, useEffect, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { fetchInheritances, resolveByOwner, Inheritance } from '../lib/discovery';

export function useInheritances() {
  const { publicKey } = useWallet();
  const wallet = publicKey?.toBase58() ?? null;

  const [items, setItems] = useState<Inheritance[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!wallet) {
      setItems([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setItems(await fetchInheritances(wallet));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not load inheritances.');
    } finally {
      setLoading(false);
    }
  }, [wallet]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  /** Manual import by owner address — merges into the list (de-duped by owner). */
  const importByOwner = useCallback(
    async (ownerAddress: string) => {
      if (!wallet) throw new Error('Connect a wallet first.');
      const found = await resolveByOwner(ownerAddress.trim(), wallet);
      if (!found) throw new Error('No inheritance found for your wallet at that owner address.');
      setItems((prev) => {
        const rest = prev.filter((p) => p.owner !== found.owner);
        return [found, ...rest];
      });
      return found;
    },
    [wallet],
  );

  return { items, loading, error, refresh, importByOwner };
}
