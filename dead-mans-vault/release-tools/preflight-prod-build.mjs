#!/usr/bin/env node
// Pre-build fail-closed guard: validate the BUILD-TIME env against the release manifest so a
// mainnet APK/web artifact can't be built with a devnet RPC, a dev notify endpoint, a wrong
// program id, or an unrecognized cluster. Reads process.env (the build env) — run it right
// before a mainnet build, e.g.  `node scripts/preflight-prod-build.mjs`.
// Also run scripts/verify-manifest.mjs (source-constant drift) — they are complementary.
// NB: the Cargo `devnet` feature (program build) is enforced separately by `build:prod` /
// the cutover runbook, not here — this guards the CLIENT build env.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const manifest = JSON.parse(readFileSync(resolve(ROOT, 'dead-mans-vault/release.manifest.json'), 'utf8'));

const cluster = process.env.EXPO_PUBLIC_EXPECTED_CLUSTER || 'devnet';
const rpc = process.env.EXPO_PUBLIC_RPC_URL || '';
const notify = process.env.EXPO_PUBLIC_NOTIFY_URL || '';
const programId = process.env.EXPO_PUBLIC_PROGRAM_ID || '';
const maskRpc = (u) => u.replace(/api-key=[^&]+/i, 'api-key=***');
const looksNonMainnet = (u) => /devnet|testnet|localhost|127\.0\.0\.1/i.test(u);

const errors = [];

// The manifest is the build's source of truth — it must be updated for the target cluster.
if (manifest.expectedCluster !== cluster) {
  errors.push(
    `manifest.expectedCluster (${manifest.expectedCluster}) != build EXPO_PUBLIC_EXPECTED_CLUSTER (${cluster}). ` +
      `Update release.manifest.json for the target cluster before building.`,
  );
}

if (cluster === 'mainnet-beta') {
  if (!rpc) errors.push('EXPO_PUBLIC_RPC_URL is not set for a mainnet build.');
  else if (looksNonMainnet(rpc)) errors.push(`EXPO_PUBLIC_RPC_URL looks non-mainnet: ${maskRpc(rpc)}`);
  if (notify && looksNonMainnet(notify)) errors.push(`EXPO_PUBLIC_NOTIFY_URL looks non-mainnet/local: ${notify}`);
  if (programId && programId !== manifest.programId) {
    errors.push(`EXPO_PUBLIC_PROGRAM_ID (${programId}) != manifest.programId (${manifest.programId}).`);
  }
} else if (cluster !== 'devnet') {
  errors.push(`Unknown EXPO_PUBLIC_EXPECTED_CLUSTER "${cluster}" — must be devnet or mainnet-beta (NOT "mainnet").`);
}

console.log(`preflight: cluster=${cluster}  rpc=${rpc ? maskRpc(rpc) : '(unset)'}  notify=${notify || '(unset)'}`);
if (errors.length) {
  console.error(`\n✗ prod-build preflight FAILED (${errors.length}):`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log('✓ prod-build preflight passed.');
