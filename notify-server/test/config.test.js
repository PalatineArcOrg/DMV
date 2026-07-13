// Config validation tests (Phase 2). config.js reads process.env at import, so each case sets env
// then imports a FRESH module (cache-busted query) and exercises assertSecureConfig().
import { test } from 'node:test';
import assert from 'node:assert/strict';

// The FULL config surface config.js reads at import. We DELETE all of these before applying a test's
// overrides, so an unrelated DMV config var present in the developer/CI shell can't leak into a fresh
// import and make a test pass/fail for the wrong reason. The ORIGINAL process.env is restored in finally.
const DMV_CONFIG_KEYS = [
  'RPC_URL', 'EXPECTED_CLUSTER', 'PROGRAM_ID', 'PORT', 'POLL_INTERVAL_MS', 'DB_PATH',
  'REGISTER_SECRET', 'FCM_PROJECT_ID', 'FCM_SERVICE_ACCOUNT', 'EXECUTOR_ENABLED',
  'CRANKER_KEYPAIR', 'ALLOW_NO_EXECUTOR', 'EXPECTED_CRANKER_PUBKEY', 'MIN_CRANKER_BALANCE_SOL',
  'WARN_CRANKER_BALANCE_SOL', 'ALLOW_NO_FCM', 'REQUIRE_PROGRAM_EXECUTABLE',
  'POLL_MAX_FAILURE_RATIO', 'POLL_MAX_FAILURE_ABS', 'NODE_ENV',
];

let seq = 0;
async function loadConfig(env) {
  // Snapshot the whole config surface (plus any extra keys the test set), delete the config surface
  // for a clean slate, apply the test's overrides, then restore the ORIGINAL env in finally.
  const keys = [...new Set([...DMV_CONFIG_KEYS, ...Object.keys(env)])];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of DMV_CONFIG_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await import(`../src/config.js?case=${++seq}`);
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

const VALID_PID = 'GXCu5964mvgAJDWmcMriZpzU3vDVqPzjYCM1sxCnsoEb';
const base = { EXPECTED_CLUSTER: 'devnet', REGISTER_SECRET: 'testsecret', NODE_ENV: 'production' };

// A real RSA private key — Google service accounts sign the OAuth JWT with RS256 (RSA), so the mainnet
// FCM check now requires RSA; the positive test must use a USABLE (RSA) key. Generated at runtime (no
// credential committed). An Ed25519 key parses but is NOT usable → used in the rejection test below.
const { generateKeyPairSync } = await import('node:crypto');
const pem = (type, opts) => generateKeyPairSync(type, {
  ...opts,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
}).privateKey;
const VALID_PRIVATE_KEY = pem('rsa', { modulusLength: 2048 });
const ED25519_KEY = pem('ed25519', {});

// Write a temp service-account JSON and return its path.
async function writeSA(fields) {
  const { writeFileSync, mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const p = join(mkdtempSync(join(tmpdir(), 'dmv-fcm-')), 'sa.json');
  writeFileSync(p, JSON.stringify(fields));
  return p;
}

test('valid devnet config passes assertSecureConfig', async () => {
  const { assertSecureConfig } = await loadConfig({ ...base });
  assert.doesNotThrow(() => assertSecureConfig());
});

test('unknown cluster ("mainnet" typo) is rejected', async () => {
  const { assertSecureConfig } = await loadConfig({ ...base, EXPECTED_CLUSTER: 'mainnet' });
  assert.throws(() => assertSecureConfig(), /EXPECTED_CLUSTER/);
});

test('invalid PORT is rejected', async () => {
  const { assertSecureConfig } = await loadConfig({ ...base, PORT: 'abc' });
  assert.throws(() => assertSecureConfig(), /PORT/);
});

test('invalid (negative) POLL_INTERVAL_MS is rejected', async () => {
  const { assertSecureConfig } = await loadConfig({ ...base, POLL_INTERVAL_MS: '-5' });
  assert.throws(() => assertSecureConfig(), /POLL_INTERVAL_MS/);
});

// Blocker (this round): a POLL_INTERVAL_MS above Node's signed-32-bit setTimeout limit (2^31-1) overflows
// and is reduced to ~1ms → a tight RPC loop. Enforce 1000 <= interval <= 2147483647.
test('POLL_INTERVAL_MS at the timer limit (2147483647) is accepted', async () => {
  const { assertSecureConfig } = await loadConfig({ ...base, POLL_INTERVAL_MS: '2147483647' });
  assert.doesNotThrow(() => assertSecureConfig());
});
test('POLL_INTERVAL_MS above the timer limit (2147483648) is rejected', async () => {
  const { assertSecureConfig } = await loadConfig({ ...base, POLL_INTERVAL_MS: '2147483648' });
  assert.throws(() => assertSecureConfig(), /POLL_INTERVAL_MS/);
});
test('POLL_INTERVAL_MS = Number.MAX_SAFE_INTEGER is rejected (would overflow the timer)', async () => {
  const { assertSecureConfig } = await loadConfig({ ...base, POLL_INTERVAL_MS: String(Number.MAX_SAFE_INTEGER) });
  assert.throws(() => assertSecureConfig(), /POLL_INTERVAL_MS/);
});

// Round-N: a SOL balance threshold must survive the `* 1e9` lamport conversion — a finite-but-huge value
// overflows to an unsafe integer, and a tiny positive value (< half a lamport) rounds to 0 and silently
// disables the floor. Both must be rejected at config time.
test('MIN_CRANKER_BALANCE_SOL that overflows lamports (1e308) is rejected', async () => {
  const { assertSecureConfig } = await loadConfig({ ...base, MIN_CRANKER_BALANCE_SOL: '1e308' });
  assert.throws(() => assertSecureConfig(), /MIN_CRANKER_BALANCE_SOL/);
});
test('MIN_CRANKER_BALANCE_SOL that collapses to 0 lamports (1e-10) is rejected', async () => {
  const { assertSecureConfig } = await loadConfig({ ...base, MIN_CRANKER_BALANCE_SOL: '1e-10' });
  assert.throws(() => assertSecureConfig(), /MIN_CRANKER_BALANCE_SOL/);
});

test('malformed MIN_CRANKER_BALANCE_SOL is rejected', async () => {
  const { assertSecureConfig } = await loadConfig({ ...base, MIN_CRANKER_BALANCE_SOL: 'notanumber' });
  assert.throws(() => assertSecureConfig(), /MIN_CRANKER_BALANCE_SOL/);
});

test('negative WARN_CRANKER_BALANCE_SOL is rejected', async () => {
  const { assertSecureConfig } = await loadConfig({ ...base, WARN_CRANKER_BALANCE_SOL: '-1' });
  assert.throws(() => assertSecureConfig(), /WARN_CRANKER_BALANCE_SOL/);
});

test('invalid PROGRAM_ID is rejected', async () => {
  const { assertSecureConfig } = await loadConfig({ ...base, PROGRAM_ID: 'not-a-valid-pubkey!' });
  assert.throws(() => assertSecureConfig(), /PROGRAM_ID/);
});

test('missing REGISTER_SECRET in production is rejected', async () => {
  const { assertSecureConfig } = await loadConfig({ EXPECTED_CLUSTER: 'devnet', REGISTER_SECRET: '', NODE_ENV: 'production' });
  assert.throws(() => assertSecureConfig(), /REGISTER_SECRET/);
});

test('mainnet without an executor and without ALLOW_NO_EXECUTOR is rejected', async () => {
  const { assertSecureConfig } = await loadConfig({ ...base, EXPECTED_CLUSTER: 'mainnet-beta', EXECUTOR_ENABLED: '0', ALLOW_NO_EXECUTOR: '0' });
  assert.throws(() => assertSecureConfig(), /EXECUTOR_ENABLED/);
});

test('mainnet with ALLOW_NO_EXECUTOR=1 (and FCM waived) passes', async () => {
  // On mainnet FCM is also a mandatory static dependency now — waive it too to isolate the executor waiver.
  const { assertSecureConfig } = await loadConfig({ ...base, EXPECTED_CLUSTER: 'mainnet-beta', EXECUTOR_ENABLED: '0', ALLOW_NO_EXECUTOR: '1', ALLOW_NO_FCM: '1' });
  assert.doesNotThrow(() => assertSecureConfig());
});

test('mainnet without FCM and without ALLOW_NO_FCM is rejected (static FCM readiness enforced)', async () => {
  const { assertSecureConfig } = await loadConfig({ ...base, EXPECTED_CLUSTER: 'mainnet-beta', ALLOW_NO_EXECUTOR: '1', FCM_SERVICE_ACCOUNT: '' });
  assert.throws(() => assertSecureConfig(), /FCM service account/);
});

test('mainnet with a malformed FCM service account is rejected', async () => {
  // Point at a file that does not parse as JSON → loadServiceAccount returns null → fatal on mainnet.
  const { assertSecureConfig } = await loadConfig({ ...base, EXPECTED_CLUSTER: 'mainnet-beta', ALLOW_NO_EXECUTOR: '1', FCM_SERVICE_ACCOUNT: '/dev/null' });
  assert.throws(() => assertSecureConfig(), /FCM service account/);
});

test('mainnet with a complete, cryptographically-valid FCM service account passes', async () => {
  const sa = await writeSA({ project_id: 'p', client_email: 'c@x.iam', private_key: VALID_PRIVATE_KEY });
  const { assertSecureConfig } = await loadConfig({ ...base, EXPECTED_CLUSTER: 'mainnet-beta', ALLOW_NO_EXECUTOR: '1', FCM_SERVICE_ACCOUNT: sa });
  assert.doesNotThrow(() => assertSecureConfig());
});

test('mainnet FCM_PROJECT_ID conflicting with the service-account project is rejected', async () => {
  const sa = await writeSA({ project_id: 'real-project', client_email: 'c@x.iam', private_key: VALID_PRIVATE_KEY });
  const { assertSecureConfig } = await loadConfig({ ...base, EXPECTED_CLUSTER: 'mainnet-beta', ALLOW_NO_EXECUTOR: '1', FCM_SERVICE_ACCOUNT: sa, FCM_PROJECT_ID: 'other-project' });
  assert.throws(() => assertSecureConfig(), /conflicts with the service-account project/);
});

test('mainnet FCM with a NON-RSA (Ed25519) private_key is rejected (RS256 requires RSA)', async () => {
  // An Ed25519 key parses via createPrivateKey but cannot produce the RS256 JWT assertion Google needs.
  const sa = await writeSA({ project_id: 'p', client_email: 'c@x.iam', private_key: ED25519_KEY });
  const { assertSecureConfig } = await loadConfig({ ...base, EXPECTED_CLUSTER: 'mainnet-beta', ALLOW_NO_EXECUTOR: '1', FCM_SERVICE_ACCOUNT: sa });
  assert.throws(() => assertSecureConfig(), /must be an RSA private key/);
});

test('mainnet FCM with a MALFORMED private_key PEM is rejected (crypto-validated before listen)', async () => {
  const sa = await writeSA({ project_id: 'p', client_email: 'c@x.iam', private_key: '-----BEGIN PRIVATE KEY-----\nk\n-----END PRIVATE KEY-----\n' });
  const { assertSecureConfig } = await loadConfig({ ...base, EXPECTED_CLUSTER: 'mainnet-beta', ALLOW_NO_EXECUTOR: '1', FCM_SERVICE_ACCOUNT: sa });
  assert.throws(() => assertSecureConfig(), /private_key.*not a valid PEM/);
});

test('mainnet FCM with a WHITESPACE-ONLY field is rejected', async () => {
  const sa = await writeSA({ project_id: '   ', client_email: 'c@x.iam', private_key: VALID_PRIVATE_KEY });
  const { assertSecureConfig } = await loadConfig({ ...base, EXPECTED_CLUSTER: 'mainnet-beta', ALLOW_NO_EXECUTOR: '1', FCM_SERVICE_ACCOUNT: sa });
  assert.throws(() => assertSecureConfig(), /project_id.*non-empty string/);
});

test('mainnet FCM with a NON-STRING field is rejected', async () => {
  const sa = await writeSA({ project_id: 'p', client_email: 12345, private_key: VALID_PRIVATE_KEY });
  const { assertSecureConfig } = await loadConfig({ ...base, EXPECTED_CLUSTER: 'mainnet-beta', ALLOW_NO_EXECUTOR: '1', FCM_SERVICE_ACCOUNT: sa });
  assert.throws(() => assertSecureConfig(), /client_email.*non-empty string/);
});

test('ALLOW_NO_FCM=1 is parsed; REQUIRE_PROGRAM_EXECUTABLE defaults on', async () => {
  const { config } = await loadConfig({ ...base, ALLOW_NO_FCM: '1' });
  assert.equal(config.allowNoFcm, true);
  assert.equal(config.requireProgramExecutable, true);
});

test('per-cluster minimum balance defaults (mainnet 0.10 vs devnet 0.02)', async () => {
  const m = await loadConfig({ ...base, EXPECTED_CLUSTER: 'mainnet-beta', ALLOW_NO_EXECUTOR: '1', PROGRAM_ID: VALID_PID });
  assert.equal(m.config.minCrankerBalanceSol, 0.1);
  const d = await loadConfig({ ...base, EXPECTED_CLUSTER: 'devnet' });
  assert.equal(d.config.minCrankerBalanceSol, 0.02);
});

test('mainnet-beta + REQUIRE_PROGRAM_EXECUTABLE=0 → startup failure', async () => {
  const { assertSecureConfig } = await loadConfig({ ...base, EXPECTED_CLUSTER: 'mainnet-beta', ALLOW_NO_EXECUTOR: '1', REQUIRE_PROGRAM_EXECUTABLE: '0' });
  assert.throws(() => assertSecureConfig(), /REQUIRE_PROGRAM_EXECUTABLE/);
});

test('devnet + REQUIRE_PROGRAM_EXECUTABLE=0 → permitted (controlled diagnostics)', async () => {
  const { assertSecureConfig } = await loadConfig({ ...base, REQUIRE_PROGRAM_EXECUTABLE: '0' });
  assert.doesNotThrow(() => assertSecureConfig());
});

test('WARN cranker balance below MIN → rejected', async () => {
  const { assertSecureConfig } = await loadConfig({ ...base, MIN_CRANKER_BALANCE_SOL: '0.5', WARN_CRANKER_BALANCE_SOL: '0.1' });
  assert.throws(() => assertSecureConfig(), /WARN_CRANKER_BALANCE_SOL/);
});

test('FIX 1: a whitespace-only MIN_CRANKER_BALANCE_SOL falls back to the default (NOT 0 → floor disabled)', async () => {
  // Number('   ') === 0 would silently DISABLE the funding floor while still passing the non-neg check.
  // After the trim-first fix, whitespace-only is treated as empty → the devnet default (0.02) is kept.
  const { config, assertSecureConfig } = await loadConfig({ ...base, MIN_CRANKER_BALANCE_SOL: '   ' });
  assert.equal(config.minCrankerBalanceSol, 0.02, 'whitespace-only → default floor, not 0');
  assert.doesNotThrow(() => assertSecureConfig());
});
