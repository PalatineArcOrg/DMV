// Centralized config from environment. Loaded via `node --env-file=.env`.
import { readFileSync } from 'node:fs';

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const config = {
  rpcUrl: process.env.RPC_URL || 'https://api.devnet.solana.com',
  programId: process.env.PROGRAM_ID || 'GXCu5964mvgAJDWmcMriZpzU3vDVqPzjYCM1sxCnsoEb',
  port: parseInt(process.env.PORT || '8787', 10),
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || '60000', 10),
  dbPath: process.env.DB_PATH || new URL('../data/registrations.db', import.meta.url).pathname,
  registerSecret: process.env.REGISTER_SECRET || '',
  fcmProjectId: process.env.FCM_PROJECT_ID || '',
  fcmServiceAccountPath: process.env.FCM_SERVICE_ACCOUNT || '',
  // Permissionless executor: keyless crank that distributes a vault's assets
  // once its grace period elapses. Pays its own fees from CRANKER_KEYPAIR.
  executorEnabled: process.env.EXECUTOR_ENABLED === '1',
  crankerKeypairPath: process.env.CRANKER_KEYPAIR || '',
};

// Lazily load the service account so the server can boot (and serve /health)
// even before the Firebase files are provided.
export function loadServiceAccount() {
  if (!config.fcmServiceAccountPath) return null;
  try {
    return JSON.parse(readFileSync(config.fcmServiceAccountPath, 'utf8'));
  } catch {
    return null;
  }
}
