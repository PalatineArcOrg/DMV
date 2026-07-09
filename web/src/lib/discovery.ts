// Heir discovery. Reuses the notify-server's read-only /inheritances endpoint
// (same one the mobile app's InheritancesScreen uses) to find vaults where the
// connected wallet is a beneficiary. Plus a manual "import by owner address"
// path for heirs whose vault isn't registered with the notify-server.
import { PublicKey } from '@solana/web3.js';
import { VaultTransactionService } from './core';

const NOTIFY_URL = (import.meta.env.VITE_NOTIFY_URL as string) || 'https://notify.palatinearc.com';

export type InheritanceStatus = 'active' | 'warning' | 'claimable' | 'executed';

export interface Inheritance {
  vault: string;
  owner: string;
  shareBps: number;
  status: InheritanceStatus;
  deadline: number | null;
  secondsToDeadline: number | null;
}

/** Auto-discover inheritances for a wallet via the notify-server. */
export async function fetchInheritances(wallet: string): Promise<Inheritance[]> {
  const res = await fetch(`${NOTIFY_URL}/inheritances?wallet=${encodeURIComponent(wallet)}`);
  if (!res.ok) throw new Error(`Discovery failed (${res.status})`);
  const json = await res.json();
  return (json.inheritances ?? []) as Inheritance[];
}

/**
 * Manually resolve a single vault by its OWNER address, reading state directly
 * from chain (no notify-server needed). Returns an Inheritance the connected
 * heir is entitled to, or null if they aren't a beneficiary / vault is missing.
 */
export async function resolveByOwner(ownerAddress: string, heir: string): Promise<Inheritance | null> {
  const owner = new PublicKey(ownerAddress); // throws on invalid — caller catches
  const svc = new VaultTransactionService();
  const config = await svc.fetchVaultConfig(owner);
  if (!config) return null;

  const benef = (config.beneficiaries ?? []).find(
    (b: { wallet: PublicKey | string }) => b.wallet.toString() === heir,
  );
  if (!benef) return null;

  const deadline = await svc.getOnChainDeadline(owner);
  const now = Math.floor(Date.now() / 1000);
  let status: InheritanceStatus = 'active';
  if (config.executed) status = 'executed';
  else if (deadline !== null && now >= deadline) status = 'claimable';

  return {
    vault: owner.toString(), // display key; claim only needs the owner pubkey
    owner: owner.toString(),
    shareBps: Number(benef.shareBps ?? 0),
    status,
    deadline,
    secondsToDeadline: deadline ? Math.max(0, deadline - now) : null,
  };
}
