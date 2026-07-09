// Browser-storage settings — the web equivalent of the app's SQLite settingsRepo.
// Backs the custom-RPC override (rpcConfig.loadRpcOverride reads via getSetting).
const PREFIX = 'dmv_';

export async function getSetting(key: string): Promise<string | null> {
  try {
    return localStorage.getItem(PREFIX + key);
  } catch {
    return null;
  }
}

export function setSetting(key: string, value: string): void {
  try {
    localStorage.setItem(PREFIX + key, value);
  } catch {
    /* storage unavailable — ignore */
  }
}

export function clearSetting(key: string): void {
  try {
    localStorage.removeItem(PREFIX + key);
  } catch {
    /* ignore */
  }
}
