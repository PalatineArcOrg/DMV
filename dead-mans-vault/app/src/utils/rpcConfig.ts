// Runtime RPC configuration.
//
// The active RPC URL is seeded from the build-time env (EXPO_PUBLIC_RPC_URL) and can be
// overridden by a user-set custom RPC URL, loaded ONCE at bootstrap (before any Connection
// is created). "Restart to apply" — we never live-reinitialize open connections.
//
// This module is the single source of truth for the RPC URL + Helius endpoints/key;
// all consumers (connections, DAS, tx-history, DeFi, explorer links) read these getters.

const ENV_RPC_URL = process.env.EXPO_PUBLIC_RPC_URL || 'https://api.devnet.solana.com';

export const DEFAULT_RPC_URL = ENV_RPC_URL;
export const RPC_OVERRIDE_KEY = 'custom_rpc_url';

let activeRpcUrl = ENV_RPC_URL;

export function getRpcUrl(): string {
  return activeRpcUrl;
}

export function isCustomRpc(): boolean {
  return activeRpcUrl !== DEFAULT_RPC_URL;
}

export function isDevnet(): boolean {
  return activeRpcUrl.includes('devnet') || activeRpcUrl.includes('api.devnet');
}

// Human-readable network name for UI labels — follows the active RPC.
export function networkLabel(): string {
  return isDevnet() ? 'Devnet' : 'Mainnet';
}

// Solana Explorer links that follow the active network (append ?cluster=devnet
// only on devnet). Use these everywhere instead of hardcoding the cluster.
function explorerSuffix(): string {
  return isDevnet() ? '?cluster=devnet' : '';
}
export function explorerTx(signature: string): string {
  return `https://explorer.solana.com/tx/${signature}${explorerSuffix()}`;
}
export function explorerAddress(address: string): string {
  return `https://explorer.solana.com/address/${address}${explorerSuffix()}`;
}

export function heliusNetPrefix(): string {
  return isDevnet() ? 'api-devnet' : 'api-mainnet';
}

export function heliusApiBase(): string {
  return `https://${heliusNetPrefix()}.helius.xyz/v0`;
}

export function heliusEnhancedApi(): string {
  return `https://${heliusNetPrefix()}.helius-rpc.com/v0`;
}

export function heliusParseTxApi(): string {
  return `https://${heliusNetPrefix()}.helius-rpc.com/v0/transactions`;
}

// The standalone EXPO_PUBLIC_HELIUS_API_KEY doesn't reliably inline into the release
// bundle, which silently disabled DAS (NFT names/images), Helius tx-history, and priority
// fees. Fall back to the api-key embedded in the active Helius RPC URL — so it keeps
// working from the single RPC URL that does embed, including a custom Helius URL.
export function getHeliusApiKey(): string {
  const envKey = process.env.EXPO_PUBLIC_HELIUS_API_KEY;
  if (envKey) return envKey;
  const m = activeRpcUrl.match(/[?&]api-key=([^&]+)/);
  return m ? m[1] : '';
}

// Strip any api-key before display or logging.
export function maskRpc(url: string): string {
  return url.replace(/([?&]api-key=)[^&]+/i, '$1***');
}

// Load the user override once at bootstrap, before any Connection is created. A non-empty
// trimmed value replaces the env default; any read failure keeps the default.
export async function loadRpcOverride(
  getSetting: (key: string) => Promise<string | null>,
): Promise<void> {
  try {
    const v = (await getSetting(RPC_OVERRIDE_KEY))?.trim();
    if (v) activeRpcUrl = v;
  } catch {
    // keep the env default
  }
}
