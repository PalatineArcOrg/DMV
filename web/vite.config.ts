import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// The RN app's src — we import the *real* transaction/claim logic from here so
// there is a single source of truth for on-chain behaviour (no forked builders).
const APP_SRC = path.resolve(__dirname, '../dead-mans-vault/app/src');
// The release manifest is the source of truth for the target cluster (see release.manifest.json /
// verify-manifest.mjs). The expected cluster DEFAULTS from it — not an unconditional 'devnet' — so a
// mainnet manifest can't silently produce a devnet-defaulted web build.
const manifest = JSON.parse(
  readFileSync(path.resolve(__dirname, '../dead-mans-vault/release.manifest.json'), 'utf8'),
);

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, __dirname, '');
  const HELIUS_API_KEY = env.VITE_HELIUS_API_KEY || '';
  const NOTIFY_URL = env.VITE_NOTIFY_URL || 'https://notify.palatinearc.com';
  // The cluster this build expects; the fail-closed network gate (verifyNetwork) checks the RPC's
  // genesis hash against it. Defaults from the release manifest, not an unconditional devnet.
  const EXPECTED_CLUSTER = env.VITE_EXPECTED_CLUSTER || manifest.expectedCluster;
  if (EXPECTED_CLUSTER !== 'devnet' && EXPECTED_CLUSTER !== 'mainnet-beta') {
    throw new Error(`[vite] VITE_EXPECTED_CLUSTER "${EXPECTED_CLUSTER}" invalid — must be devnet or mainnet-beta.`);
  }
  // A devnet build may use the public default RPC; a mainnet build MUST supply an explicit RPC
  // (refuse to silently default a mainnet build to devnet).
  let RPC_URL = env.VITE_RPC_URL;
  if (!RPC_URL) {
    if (EXPECTED_CLUSTER === 'devnet') RPC_URL = 'https://api.devnet.solana.com';
    else throw new Error('[vite] VITE_RPC_URL is required for a mainnet-beta build (refusing to default to devnet).');
  }

  return {
    plugins: [react()],
    // Buffer/global are polyfilled manually in src/polyfills.ts (imported first
    // in main.tsx). We deliberately do NOT use vite-plugin-node-polyfills — its
    // dev-mode Buffer injection hits a TDZ "cannot access before initialization"
    // circular-init bug with web3.js's pre-bundled deps.
    define: {
      global: 'globalThis',
      // The reused RN modules read build-time Expo env vars; replace those exact
      // expressions at compile time (all have `|| default` fallbacks).
      'process.env.EXPO_PUBLIC_RPC_URL': JSON.stringify(RPC_URL),
      'process.env.EXPO_PUBLIC_HELIUS_API_KEY': JSON.stringify(HELIUS_API_KEY),
      'process.env.EXPO_PUBLIC_NOTIFY_URL': JSON.stringify(NOTIFY_URL),
      'process.env.EXPO_PUBLIC_NOTIFY_SECRET': JSON.stringify(''),
      'process.env.EXPO_PUBLIC_EXPECTED_CLUSTER': JSON.stringify(EXPECTED_CLUSTER),
    },
    resolve: {
      // The reused files live in the sibling `app/`, so bare imports would
      // otherwise resolve against `app/node_modules` (a second copy). Force a
      // single copy of every shared dep from THIS project's node_modules.
      dedupe: [
        '@solana/web3.js',
        '@coral-xyz/anchor',
        '@solana/spl-token',
        'bs58',
        'buffer',
        'bn.js',
        'react',
        'react-dom',
      ],
      alias: {
        // constants.ts pulls `Platform` from react-native (font family only) —
        // give it a 3-line web stub instead of the whole RN runtime.
        'react-native': path.resolve(__dirname, 'src/shims/react-native.ts'),
        '@app': APP_SRC,
      },
    },
    optimizeDeps: {
      esbuildOptions: { define: { global: 'globalThis' } },
    },
    server: {
      // allow importing .ts source from the sibling RN app during dev
      fs: { allow: [path.resolve(__dirname, '..')] },
    },
  };
});
