// Centralized config from environment. Loaded via `node --env-file=.env`.
import { readFileSync } from 'node:fs';

// Only an explicit NODE_ENV=development is treated as "dev mode". Anything else
// (including unset) is treated as production, so the fail-closed secret check
// below applies by default.
export const isDev = process.env.NODE_ENV === 'development';

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

/**
 * Fail-closed guard, called at startup. The write endpoints (register,
 * deregister, poll-now, execute-now, debug/push) are gated by REGISTER_SECRET;
 * an empty secret opens them. Refuse to boot without a secret unless the
 * operator explicitly opted into dev mode (NODE_ENV=development) — so a
 * production misconfiguration cannot silently expose those endpoints.
 */
export function assertSecureConfig() {
  if (!config.registerSecret && !isDev) {
    throw new Error(
      'REGISTER_SECRET is not set. Refusing to start with unauthenticated write ' +
        'endpoints. Set REGISTER_SECRET in .env, or set NODE_ENV=development to ' +
        'allow open endpoints for local development only.',
    );
  }
}

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
