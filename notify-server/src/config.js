// Centralized config from environment. Loaded via `node --env-file=.env`.
import { readFileSync } from 'node:fs';

// Only an explicit NODE_ENV=development is treated as "dev mode". Anything else
// (including unset) is treated as production, so the fail-closed secret check
// below applies by default.
export const isDev = process.env.NODE_ENV === 'development';

// Canonical Solana genesis hashes per cluster — the ground truth for verifying an RPC is
// serving the cluster this deploy expects (never inferred from the URL string). See
// assertGenesisHash() in solana.js.
export const GENESIS_HASHES = {
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  'mainnet-beta': '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
};

export const config = {
  rpcUrl: process.env.RPC_URL || 'https://api.devnet.solana.com',
  expectedCluster: process.env.EXPECTED_CLUSTER || 'devnet',
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
  // Deliberate opt-out of the mainnet "executor must be on" guard, for a notify-only mainnet
  // deploy that delegates cranking to the independent keeper-bot (the documented two-cranker
  // model). Must be set explicitly so a crankerless mainnet can't ship by accident.
  allowNoExecutor: process.env.ALLOW_NO_EXECUTOR === '1',
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
  // Cluster must be a known value (guards the "mainnet" vs "mainnet-beta" typo — the latter
  // is Solana's actual cluster id). This is the sync half; the genesis-hash check that
  // confirms the RPC actually serves it is assertGenesisHash() in solana.js (async).
  if (!GENESIS_HASHES[config.expectedCluster]) {
    throw new Error(
      `Invalid EXPECTED_CLUSTER "${config.expectedCluster}" — must be "devnet" or "mainnet-beta".`,
    );
  }
  // On mainnet the autonomous executor must be enabled + funded, or the notify-server has no
  // server-side cranker for the dead-man's switch. Fail closed rather than silently ship a
  // mainnet deploy whose switch can't fire. A deliberate notify-only deploy that delegates
  // cranking to the independent keeper-bot can opt out with ALLOW_NO_EXECUTOR=1.
  if (
    config.expectedCluster === 'mainnet-beta' &&
    !config.executorEnabled &&
    !config.allowNoExecutor
  ) {
    throw new Error(
      'EXPECTED_CLUSTER=mainnet-beta requires EXECUTOR_ENABLED=1 (+ a funded CRANKER_KEYPAIR) ' +
        'so the autonomous switch can fire on mainnet. If cranking is delegated to a separate ' +
        'keeper-bot, set ALLOW_NO_EXECUTOR=1 to acknowledge this deploy is notify-only.',
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
