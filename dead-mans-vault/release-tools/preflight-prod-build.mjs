#!/usr/bin/env node
// Surface-aware, fail-closed pre-build guard (WP1 Phase 1). Validates the BUILD-TIME client env for
// a given surface (app | web) against the release manifest, so a mainnet artifact can't be built
// with a devnet/dev/malformed RPC or notify endpoint, a wrong program id, or an unrecognized cluster.
//
//   node release-tools/preflight-prod-build.mjs --surface app   # reads EXPO_PUBLIC_*
//   node release-tools/preflight-prod-build.mjs --surface web   # reads VITE_* (+ web/.env* files)
//
// This is a fail-closed sanity gate, NOT proof of cluster: looksNonMainnetHost() can REJECT an
// obviously-devnet/local endpoint but can't PROVE an endpoint is mainnet (a cluster-agnostic RPC
// slips through). The authoritative wrong-cluster block is the RUNTIME genesis-hash gate
// (WP1-T1/T3), which verifies the real chain at boot. Keep both. Complementary to verify-manifest.mjs
// (source-constant drift). The Cargo `devnet` feature (program build) is enforced separately.
//
// Core logic is the pure function runPreflight({surface, env, manifest}) so it can be unit-tested
// with fixtures without touching the real manifest or process.env (see preflight-prod-build.test.mjs).

import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

export const GENESIS_HASHES = {
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  'mainnet-beta': '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
};

const ALLOWED_CLUSTERS = ['devnet', 'mainnet-beta'];

// Build-time env var namespace per surface. `programId` is optional ("when supported").
export const SURFACE_ENV = {
  app: {
    cluster: 'EXPO_PUBLIC_EXPECTED_CLUSTER',
    rpc: 'EXPO_PUBLIC_RPC_URL',
    notify: 'EXPO_PUBLIC_NOTIFY_URL',
    programId: 'EXPO_PUBLIC_PROGRAM_ID',
  },
  web: {
    cluster: 'VITE_EXPECTED_CLUSTER',
    rpc: 'VITE_RPC_URL',
    notify: 'VITE_NOTIFY_URL',
    programId: 'VITE_PROGRAM_ID',
  },
};

// Redact credentials so they never reach logs: strip URL userinfo (user:pass@) AND mask
// credential-bearing query params.
export function redact(url) {
  if (!url) return url;
  return String(url)
    .replace(/(:\/\/)[^/?#@]*@/, '$1***@')
    .replace(/([?&](?:api[-_]?key|apikey|key|token|secret|access[-_]?token)=)[^&#]+/gi, '$1***');
}

function parseUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isPrivateV4(a, b) {
  if (a === 127) return true; // loopback 127.0.0.0/8
  if (a === 0) return true; // 0.0.0.0/8 (incl. unspecified)
  if (a === 10) return true; // private 10.0.0.0/8
  if (a === 192 && b === 168) return true; // private 192.168.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return true; // private 172.16.0.0/12
  if (a === 169 && b === 254) return true; // link-local 169.254.0.0/16
  return false;
}

function isPrivateOrLoopbackHost(hostname) {
  let h = hostname.toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1); // strip IPv6 brackets
  if (h === 'localhost' || h.endsWith('.localhost')) return true;

  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) return isPrivateV4(Number(v4[1]), Number(v4[2]));

  if (h.includes(':')) {
    if (h === '::' || h === '::1' || h === '0:0:0:0:0:0:0:0' || h === '0:0:0:0:0:0:0:1') {
      return true; // unspecified (::) / loopback (::1)
    }
    // IPv4-mapped/-embedded: `::ffff:a.b.c.d` or the hex-serialized `::ffff:7f00:1`
    const mapped = h.match(/^::ffff:(.+)$/i) || h.match(/^::((?:\d{1,3}\.){3}\d{1,3})$/);
    if (mapped) {
      const tail = mapped[1];
      const dotted = tail.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
      if (dotted) return isPrivateV4(Number(dotted[1]), Number(dotted[2]));
      const hx = tail.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
      if (hx) {
        const hi = parseInt(hx[1], 16);
        return isPrivateV4((hi >> 8) & 0xff, hi & 0xff);
      }
    }
    const g0 = h.split(':')[0]; // first hextet
    if (/^f[cd]/.test(g0)) return true; // fc00::/7 unique-local (ULA)
    if (/^fe[89ab]/.test(g0)) return true; // fe80::/10 link-local
  }
  return false;
}

function looksNonMainnetHost(hostname) {
  return /devnet|testnet/i.test(hostname) || isPrivateOrLoopbackHost(hostname);
}

// Mainnet builds: URL must be present, valid, HTTPS, and not an obviously non-mainnet/local host.
function validateMainnetUrl(label, value, errors) {
  const v = (value ?? '').trim();
  if (!v) {
    errors.push(`${label} is not set for a mainnet build.`);
    return;
  }
  const u = parseUrl(v);
  if (!u) {
    errors.push(`${label} is not a valid URL: ${redact(v)}`);
    return;
  }
  // Reject embedded credentials (userinfo). Always print via redact() so they never leak.
  if (u.username || u.password) {
    errors.push(`${label} must not embed credentials (userinfo) in the URL: ${redact(v)}`);
  }
  if (u.protocol !== 'https:') {
    errors.push(`${label} must be HTTPS for a mainnet build: ${redact(v)}`);
    return;
  }
  if (looksNonMainnetHost(u.hostname)) {
    errors.push(`${label} looks non-mainnet/local: ${redact(v)}`);
  }
}

/**
 * Pure preflight. Returns { ok, errors, summary }. No process.exit, no file reads.
 * @param {{surface:'app'|'web', env:Record<string,string|undefined>, manifest:object}} args
 */
export function runPreflight({ surface, env = {}, manifest }) {
  const keys = SURFACE_ENV[surface];
  if (!keys) {
    return {
      ok: false,
      errors: [`unknown --surface "${surface}" (expected: app | web)`],
      summary: `preflight: surface=${surface} (invalid)`,
    };
  }
  if (!manifest || typeof manifest !== 'object') {
    return { ok: false, errors: ['release manifest missing/unreadable'], summary: `preflight[${surface}]: no manifest` };
  }

  const errors = [];
  const rawCluster = env[keys.cluster];
  // Absent cluster → a devnet build (may use devnet defaults). Present-but-invalid → error.
  const cluster = rawCluster === undefined || rawCluster === null ? 'devnet' : String(rawCluster).trim();
  const rpc = env[keys.rpc];
  const notify = env[keys.notify];
  const programId = env[keys.programId];

  const summary =
    `preflight[${surface}]: cluster=${cluster || '(empty)'}  ` +
    `rpc=${rpc ? redact(rpc) : '(unset)'}  notify=${notify ? redact(notify) : '(unset)'}`;

  // 1. cluster must be EXACTLY devnet | mainnet-beta (rejects "mainnet", "testnet", empty, whitespace).
  if (!ALLOWED_CLUSTERS.includes(cluster)) {
    errors.push(
      `${keys.cluster} "${rawCluster}" is invalid — must be exactly "devnet" or "mainnet-beta" ` +
        `(NOT "mainnet"/"testnet"/empty).`,
    );
  }

  // 2. the build's manifest must target the same cluster.
  if (manifest.expectedCluster !== cluster) {
    errors.push(
      `manifest.expectedCluster (${manifest.expectedCluster}) != ${keys.cluster} (${cluster}). ` +
        `Update release.manifest.json for the target cluster before building.`,
    );
  }

  // 3. the manifest's genesis hash must be the canonical hash for its cluster.
  const canonical = GENESIS_HASHES[manifest.expectedCluster];
  if (!canonical) {
    errors.push(`manifest.expectedCluster "${manifest.expectedCluster}" has no known genesis hash.`);
  } else if (manifest.expectedGenesisHash !== canonical) {
    errors.push(
      `manifest.expectedGenesisHash (${manifest.expectedGenesisHash}) != canonical ` +
        `${manifest.expectedCluster} genesis (${canonical}).`,
    );
  }

  // 4. cluster-specific value checks.
  if (cluster === 'mainnet-beta') {
    validateMainnetUrl(keys.rpc, rpc, errors);
    validateMainnetUrl(keys.notify, notify, errors);
    const pid = programId == null ? '' : String(programId).trim();
    if (pid && pid !== manifest.programId) {
      errors.push(`${keys.programId} (${pid}) != manifest.programId (${manifest.programId}).`);
    }
  } else if (cluster === 'devnet') {
    // A devnet build may use the existing devnet defaults; only a malformed provided URL fails.
    for (const [label, val] of [
      [keys.rpc, rpc],
      [keys.notify, notify],
    ]) {
      const v = (val ?? '').trim();
      if (v && !parseUrl(v)) errors.push(`${label} is not a valid URL: ${redact(v)}`);
    }
  }

  return { ok: errors.length === 0, errors, summary };
}

// ---- CLI -------------------------------------------------------------------
function parseSurfaceArg(argv) {
  const i = argv.indexOf('--surface');
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith('--surface='));
  return eq ? eq.split('=')[1] : undefined;
}

// Resolve Vite's OWN loadEnv from the web project so the preflight sees EXACTLY what `vite build`
// compiles — correct mode precedence (.env.[mode].local > .env.[mode] > .env.local > .env), dotenv,
// and dotenv-expand — instead of a hand-rolled parser that could disagree with the real build.
// (This file lives in release-tools/ and can't statically `import 'vite'`, so we resolve it from the
// web package's node_modules and dynamic-import its ESM entry.)
export async function resolveViteLoadEnv(fromDir) {
  const requireFromWeb = createRequire(resolve(fromDir, 'package.json'));
  const pkgPath = requireFromWeb.resolve('vite/package.json');
  const viteDir = dirname(pkgPath);
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const dot = pkg.exports?.['.'];
  // exports["."] may be a string, or a conditions object whose `import` is itself a
  // { types, default } object (Vite's shape). Fall back to module/main.
  let entry;
  if (typeof dot === 'string') entry = dot;
  else if (dot?.import) entry = typeof dot.import === 'string' ? dot.import : dot.import.default;
  entry = entry || pkg.module || pkg.main;
  const mod = await import(pathToFileURL(resolve(viteDir, entry)).href);
  return mod.loadEnv;
}

// Vite's file env (production mode, all vars) with existing process.env VITE_* overlaid at HIGHEST
// priority — matching Vite's rule that shell/CI env vars win over every .env file.
export function buildWebEnv(loadEnv, envDir, processEnv) {
  const merged = { ...loadEnv('production', envDir, '') };
  for (const k of Object.keys(processEnv)) {
    if (k.startsWith('VITE_')) merged[k] = processEnv[k];
  }
  return merged;
}

const isMain = (() => {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isMain) {
  const surface = parseSurfaceArg(process.argv.slice(2));
  if (!surface || !SURFACE_ENV[surface]) {
    console.error('usage: preflight-prod-build.mjs --surface <app|web>');
    process.exit(2);
  }
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(resolve(ROOT, 'dead-mans-vault/release.manifest.json'), 'utf8'));
  } catch (e) {
    console.error(`✗ cannot read release.manifest.json: ${e.message}`);
    process.exit(1);
  }
  let env;
  if (surface === 'web') {
    const webDir = resolve(ROOT, 'web');
    const loadEnv = await resolveViteLoadEnv(webDir);
    env = buildWebEnv(loadEnv, webDir, process.env);
  } else {
    env = process.env;
  }
  const { ok, errors, summary } = runPreflight({ surface, env, manifest });
  console.log(summary);
  if (!ok) {
    console.error(`\n✗ prod-build preflight FAILED (${errors.length}):`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log('✓ prod-build preflight passed.');
}
