// Unit tests for the surface-aware prod-build preflight (WP1 Phase 1, §1.6).
// Uses fixture manifests injected into the pure runPreflight() — never touches the real manifest.
//   run: node --test dead-mans-vault/release-tools/preflight-prod-build.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPreflight, redact, GENESIS_HASHES } from './preflight-prod-build.mjs';

const PID = 'GXCu5964mvgAJDWmcMriZpzU3vDVqPzjYCM1sxCnsoEb';
const devnetManifest = { expectedCluster: 'devnet', expectedGenesisHash: GENESIS_HASHES.devnet, programId: PID };
const mainnetManifest = { expectedCluster: 'mainnet-beta', expectedGenesisHash: GENESIS_HASHES['mainnet-beta'], programId: PID };

// 1
test('valid devnet app build passes', () => {
  const r = runPreflight({
    surface: 'app',
    env: { EXPO_PUBLIC_EXPECTED_CLUSTER: 'devnet', EXPO_PUBLIC_RPC_URL: 'https://api.devnet.solana.com' },
    manifest: devnetManifest,
  });
  assert.equal(r.ok, true, r.errors.join('; '));
});

// 2
test('valid devnet web build passes', () => {
  const r = runPreflight({
    surface: 'web',
    env: { VITE_EXPECTED_CLUSTER: 'devnet', VITE_RPC_URL: 'https://api.devnet.solana.com' },
    manifest: devnetManifest,
  });
  assert.equal(r.ok, true, r.errors.join('; '));
});

// 3
test('valid mainnet app build passes', () => {
  const r = runPreflight({
    surface: 'app',
    env: {
      EXPO_PUBLIC_EXPECTED_CLUSTER: 'mainnet-beta',
      EXPO_PUBLIC_RPC_URL: 'https://rpc.example.com/?api-key=secret123',
      EXPO_PUBLIC_NOTIFY_URL: 'https://notify.example.com',
      EXPO_PUBLIC_PROGRAM_ID: PID,
    },
    manifest: mainnetManifest,
  });
  assert.equal(r.ok, true, r.errors.join('; '));
});

// 4
test('valid mainnet web build passes', () => {
  const r = runPreflight({
    surface: 'web',
    env: {
      VITE_EXPECTED_CLUSTER: 'mainnet-beta',
      VITE_RPC_URL: 'https://rpc.example.com',
      VITE_NOTIFY_URL: 'https://notify.example.com',
    },
    manifest: mainnetManifest,
  });
  assert.equal(r.ok, true, r.errors.join('; '));
});

// 5
test('mainnet manifest + missing RPC fails', () => {
  const r = runPreflight({
    surface: 'app',
    env: { EXPO_PUBLIC_EXPECTED_CLUSTER: 'mainnet-beta', EXPO_PUBLIC_NOTIFY_URL: 'https://notify.example.com' },
    manifest: mainnetManifest,
  });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /RPC_URL is not set/);
});

// 6
test('mainnet manifest + devnet RPC fails', () => {
  const r = runPreflight({
    surface: 'app',
    env: {
      EXPO_PUBLIC_EXPECTED_CLUSTER: 'mainnet-beta',
      EXPO_PUBLIC_RPC_URL: 'https://api.devnet.solana.com',
      EXPO_PUBLIC_NOTIFY_URL: 'https://notify.example.com',
    },
    manifest: mainnetManifest,
  });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /non-mainnet/);
});

// 7
test('mainnet manifest + localhost notify URL fails', () => {
  const r = runPreflight({
    surface: 'app',
    env: {
      EXPO_PUBLIC_EXPECTED_CLUSTER: 'mainnet-beta',
      EXPO_PUBLIC_RPC_URL: 'https://rpc.example.com',
      EXPO_PUBLIC_NOTIFY_URL: 'http://localhost:8787',
    },
    manifest: mainnetManifest,
  });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /NOTIFY_URL/);
});

// 8
test('cluster "mainnet" typo fails', () => {
  const r = runPreflight({
    surface: 'app',
    env: {
      EXPO_PUBLIC_EXPECTED_CLUSTER: 'mainnet',
      EXPO_PUBLIC_RPC_URL: 'https://rpc.example.com',
      EXPO_PUBLIC_NOTIFY_URL: 'https://notify.example.com',
    },
    manifest: mainnetManifest,
  });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /must be exactly/);
});

// 9
test('app cluster/manifest mismatch fails', () => {
  const r = runPreflight({
    surface: 'app',
    env: {
      EXPO_PUBLIC_EXPECTED_CLUSTER: 'mainnet-beta',
      EXPO_PUBLIC_RPC_URL: 'https://rpc.example.com',
      EXPO_PUBLIC_NOTIFY_URL: 'https://notify.example.com',
      EXPO_PUBLIC_PROGRAM_ID: PID,
    },
    manifest: devnetManifest,
  });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /expectedCluster/);
});

// 10
test('web cluster/manifest mismatch fails', () => {
  const r = runPreflight({
    surface: 'web',
    env: {
      VITE_EXPECTED_CLUSTER: 'mainnet-beta',
      VITE_RPC_URL: 'https://rpc.example.com',
      VITE_NOTIFY_URL: 'https://notify.example.com',
    },
    manifest: devnetManifest,
  });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /expectedCluster/);
});

// 11
test('malformed URL fails (mainnet)', () => {
  const r = runPreflight({
    surface: 'app',
    env: {
      EXPO_PUBLIC_EXPECTED_CLUSTER: 'mainnet-beta',
      EXPO_PUBLIC_RPC_URL: 'not a valid url',
      EXPO_PUBLIC_NOTIFY_URL: 'https://notify.example.com',
    },
    manifest: mainnetManifest,
  });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /not a valid URL|must be HTTPS/);
});

// 12
test('API key is redacted in output and by redact()', () => {
  const r = runPreflight({
    surface: 'app',
    env: {
      EXPO_PUBLIC_EXPECTED_CLUSTER: 'mainnet-beta',
      EXPO_PUBLIC_RPC_URL: 'https://rpc.example.com/?api-key=supersecret',
      EXPO_PUBLIC_NOTIFY_URL: 'https://notify.example.com',
      EXPO_PUBLIC_PROGRAM_ID: PID,
    },
    manifest: mainnetManifest,
  });
  assert.equal(r.ok, true, r.errors.join('; '));
  assert.doesNotMatch(r.summary, /supersecret/);
  assert.match(r.summary, /api-key=\*\*\*/);
  assert.equal(redact('https://x/?api-key=abc&token=def'), 'https://x/?api-key=***&token=***');
});

// 13
test('wrong program ID fails (mainnet)', () => {
  const r = runPreflight({
    surface: 'app',
    env: {
      EXPO_PUBLIC_EXPECTED_CLUSTER: 'mainnet-beta',
      EXPO_PUBLIC_RPC_URL: 'https://rpc.example.com',
      EXPO_PUBLIC_NOTIFY_URL: 'https://notify.example.com',
      EXPO_PUBLIC_PROGRAM_ID: 'Wr0ngPr0gramId1111111111111111111111111111',
    },
    manifest: mainnetManifest,
  });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /PROGRAM_ID/);
});

// 14
test('web surface reads VITE_* and ignores EXPO_PUBLIC_* (and app does the reverse)', () => {
  const env = {
    VITE_EXPECTED_CLUSTER: 'mainnet-beta',
    VITE_RPC_URL: 'https://rpc.example.com',
    VITE_NOTIFY_URL: 'https://notify.example.com',
    // would be INVALID against the mainnet manifest if the WEB surface (wrongly) read them:
    EXPO_PUBLIC_EXPECTED_CLUSTER: 'devnet',
    EXPO_PUBLIC_RPC_URL: 'https://api.devnet.solana.com',
  };
  const web = runPreflight({ surface: 'web', env, manifest: mainnetManifest });
  assert.equal(web.ok, true, web.errors.join('; '));
  // Same env on the APP surface reads the EXPO_PUBLIC_* devnet cluster → mismatch vs mainnet manifest.
  const app = runPreflight({ surface: 'app', env, manifest: mainnetManifest });
  assert.equal(app.ok, false);
});

// 15 — URL userinfo (embedded credentials) rejected AND never printed
test('mainnet URL with userinfo is rejected and the password never appears in output', () => {
  const r = runPreflight({
    surface: 'app',
    env: {
      EXPO_PUBLIC_EXPECTED_CLUSTER: 'mainnet-beta',
      EXPO_PUBLIC_RPC_URL: 'https://user:supersecret@rpc.example.com',
      EXPO_PUBLIC_NOTIFY_URL: 'https://notify.example.com',
      EXPO_PUBLIC_PROGRAM_ID: PID,
    },
    manifest: mainnetManifest,
  });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /userinfo|credentials/);
  assert.doesNotMatch(r.summary, /supersecret/);
  assert.doesNotMatch(r.errors.join('\n'), /supersecret/);
});

// 16 — IPv6 unique-local (fc00::/7) rejected
test('mainnet IPv6 ULA [fc00::1] is rejected', () => {
  const r = runPreflight({
    surface: 'app',
    env: {
      EXPO_PUBLIC_EXPECTED_CLUSTER: 'mainnet-beta',
      EXPO_PUBLIC_RPC_URL: 'https://[fc00::1]',
      EXPO_PUBLIC_NOTIFY_URL: 'https://notify.example.com',
      EXPO_PUBLIC_PROGRAM_ID: PID,
    },
    manifest: mainnetManifest,
  });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /non-mainnet/);
});

// 17 — IPv6 link-local (fe80::/10) rejected
test('mainnet IPv6 link-local [fe80::1] is rejected', () => {
  const r = runPreflight({
    surface: 'app',
    env: {
      EXPO_PUBLIC_EXPECTED_CLUSTER: 'mainnet-beta',
      EXPO_PUBLIC_RPC_URL: 'https://[fe80::1]',
      EXPO_PUBLIC_NOTIFY_URL: 'https://notify.example.com',
      EXPO_PUBLIC_PROGRAM_ID: PID,
    },
    manifest: mainnetManifest,
  });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /non-mainnet/);
});

// 18 — IPv4-mapped loopback ([::ffff:127.0.0.1]) rejected
test('mainnet IPv4-mapped loopback [::ffff:127.0.0.1] is rejected', () => {
  const r = runPreflight({
    surface: 'app',
    env: {
      EXPO_PUBLIC_EXPECTED_CLUSTER: 'mainnet-beta',
      EXPO_PUBLIC_RPC_URL: 'https://[::ffff:127.0.0.1]',
      EXPO_PUBLIC_NOTIFY_URL: 'https://notify.example.com',
      EXPO_PUBLIC_PROGRAM_ID: PID,
    },
    manifest: mainnetManifest,
  });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /non-mainnet/);
});

// ---------------------------------------------------------------------------
// RPC is mandatory on every cluster.
//
// The gate's gap was that ABSENCE passed silently: the RPC URL was validated only
// for mainnet, so a devnet release built with EXPO_PUBLIC_RPC_URL unset printed
// "rpc=(unset)" and passed. That shipped an APK with an empty DEFAULT_RPC_URL,
// unable to reach Solana, reporting only an opaque validation failure in the app.
// The regression test is therefore the absence itself.
// ---------------------------------------------------------------------------

test('devnet app build with RPC UNSET fails (the regression this gate missed)', () => {
  const r = runPreflight({
    surface: 'app',
    env: { EXPO_PUBLIC_EXPECTED_CLUSTER: 'devnet' },
    manifest: devnetManifest,
  });
  assert.equal(r.ok, false);
  assert.ok(
    r.errors.some((e) => e.includes('EXPO_PUBLIC_RPC_URL') && e.includes('not set')),
    `expected a "not set" error for the RPC url, got: ${r.errors.join('; ')}`,
  );
});

test('devnet app build with RPC set to empty/whitespace fails', () => {
  for (const value of ['', '   ']) {
    const r = runPreflight({
      surface: 'app',
      env: { EXPO_PUBLIC_EXPECTED_CLUSTER: 'devnet', EXPO_PUBLIC_RPC_URL: value },
      manifest: devnetManifest,
    });
    assert.equal(r.ok, false, `value ${JSON.stringify(value)} should fail`);
  }
});

test('devnet web build with RPC UNSET fails', () => {
  const r = runPreflight({
    surface: 'web',
    env: { VITE_EXPECTED_CLUSTER: 'devnet' },
    manifest: devnetManifest,
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('VITE_RPC_URL')));
});

test('devnet build with a malformed RPC url fails', () => {
  for (const value of ['not-a-url', 'http//missing-colon', 'ftp:/x']) {
    const r = runPreflight({
      surface: 'app',
      env: { EXPO_PUBLIC_EXPECTED_CLUSTER: 'devnet', EXPO_PUBLIC_RPC_URL: value },
      manifest: devnetManifest,
    });
    assert.equal(r.ok, false, `value ${JSON.stringify(value)} should fail`);
  }
});

test('devnet build with a non-HTTPS RPC url fails', () => {
  const r = runPreflight({
    surface: 'app',
    env: { EXPO_PUBLIC_EXPECTED_CLUSTER: 'devnet', EXPO_PUBLIC_RPC_URL: 'http://api.devnet.solana.com' },
    manifest: devnetManifest,
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('HTTPS')));
});

test('devnet build pointed at a MAINNET host fails', () => {
  const r = runPreflight({
    surface: 'app',
    env: {
      EXPO_PUBLIC_EXPECTED_CLUSTER: 'devnet',
      EXPO_PUBLIC_RPC_URL: 'https://api.mainnet-beta.solana.com',
    },
    manifest: devnetManifest,
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('mainnet host')));
});

test('RPC url embedding credentials fails, and the value is never echoed', () => {
  const secret = 'sup3rs3cr3t';
  const r = runPreflight({
    surface: 'app',
    env: {
      EXPO_PUBLIC_EXPECTED_CLUSTER: 'devnet',
      EXPO_PUBLIC_RPC_URL: `https://user:${secret}@rpc.devnet.example.com`,
    },
    manifest: devnetManifest,
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('credentials')));
  assert.ok(!r.errors.join(' ').includes(secret), 'secret must not appear in errors');
  assert.ok(!r.summary.includes(secret), 'secret must not appear in the summary');
});

test('a neutral proxy hostname is accepted on devnet (must not require the literal "devnet")', () => {
  // A first-party RPC proxy is a legitimate devnet endpoint; requiring the host to
  // contain "devnet" would reject it and push builders back to raw provider URLs.
  const r = runPreflight({
    surface: 'app',
    env: {
      EXPO_PUBLIC_EXPECTED_CLUSTER: 'devnet',
      EXPO_PUBLIC_RPC_URL: 'https://notify.palatinearc.com/rpc',
    },
    manifest: devnetManifest,
  });
  assert.equal(r.ok, true, r.errors.join('; '));
});

test('a genuine devnet provider url still passes', () => {
  const r = runPreflight({
    surface: 'app',
    env: {
      EXPO_PUBLIC_EXPECTED_CLUSTER: 'devnet',
      EXPO_PUBLIC_RPC_URL: 'https://devnet.helius-rpc.com/?api-key=redacted',
    },
    manifest: devnetManifest,
  });
  assert.equal(r.ok, true, r.errors.join('; '));
});
