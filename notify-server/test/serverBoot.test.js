// Black-box boot test (Phase 2). Spawns the REAL src/server.js and asserts it FAILS CLOSED (exit 1)
// on each class of static configuration fault — BEFORE it opens a listener or touches the network. A
// static-fatal boot must exit non-zero so systemd `Restart=on-failure` surfaces it (a silent exit 0
// would leave the daemon dead). Complements config.test.js (which unit-tests assertSecureConfig): this
// proves the actual process wires those checks into a fail-closed exit.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const server = resolve(here, '../src/server.js');
// A throwaway DB + a NON-production port so a hypothetical happy-boot could never touch the real
// registrations.db or bind 8787 (the live service). Every case here exits before app.listen anyway.
const DB = join(tmpdir(), `dmv-boot-test-${process.pid}.db`);

// Clean up the throwaway DB (and any SQLite sidecars) once this file's tests finish, pass or
// fail. Without this every run left dmv-boot-test-*.db{,-wal,-shm} behind in the OS temp dir.
// Scoped strictly to the exact paths this file creates — never a broad temp-dir sweep.
after(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(
    [DB, `${DB}-wal`, `${DB}-shm`, `${DB}-journal`].map((f) =>
      rm(f, { force: true }).catch(() => {}),
    ),
  );
});

// Strip DMV-specific env so a developer's shell / .env can't leak into the child (e.g. a real
// REGISTER_SECRET would make the "missing secret" case falsely pass). Keep PATH/HOME etc. for node.
const DMV_ENV_KEYS = [
  'REGISTER_SECRET', 'FCM_SERVICE_ACCOUNT', 'FCM_PROJECT_ID', 'EXECUTOR_ENABLED', 'CRANKER_KEYPAIR',
  'ALLOW_NO_FCM', 'ALLOW_NO_EXECUTOR', 'MIN_CRANKER_BALANCE_SOL', 'WARN_CRANKER_BALANCE_SOL',
  'REQUIRE_PROGRAM_EXECUTABLE', 'POLL_MAX_FAILURE_RATIO', 'POLL_MAX_FAILURE_ABS', 'RPC_URL', 'PROGRAM_ID',
  'EXPECTED_CLUSTER', 'EXPECTED_CRANKER_PUBKEY', 'POLL_INTERVAL_MS', 'PORT', 'DB_PATH',
  'REGISTRATION_AUTH_MODE', 'ADMIN_SECRET', 'REGISTRATION_LEGACY_ACCEPT_UNTIL',
];
function boot(env) {
  const clean = { ...process.env };
  for (const k of DMV_ENV_KEYS) delete clean[k];
  return new Promise((res) => {
    execFile(
      'node',
      [server],
      { timeout: 10000, env: { ...clean, NODE_ENV: 'production', PORT: '8799', DB_PATH: DB, ...env } },
      (err, stdout, stderr) => {
        // Distinguish a real non-zero EXIT from a TIMEOUT/kill (a hung happy-boot) or a SPAWN error —
        // neither may be coerced to code 1 and falsely satisfy an exit-1 assertion.
        const timedOut = !!(err && err.killed && err.signal);
        const code = timedOut ? 'TIMEOUT' : err ? (typeof err.code === 'number' ? err.code : null) : 0;
        res({ code, stdout, stderr, timedOut, spawnError: typeof err?.code === 'string' ? err.code : null });
      },
    );
  });
}

// A config that boots past the STATIC gate (so individual cases can flip ONE field to fault it).
const OK = {
  REGISTER_SECRET: 'test-secret',
  EXPECTED_CLUSTER: 'devnet',
  RPC_URL: 'https://api.devnet.solana.com',
};

test('missing REGISTER_SECRET in production → exit 1 (fail-closed, no open write endpoints)', async () => {
  const { REGISTER_SECRET, ...noSecret } = OK;
  const r = await boot(noSecret);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /REGISTER_SECRET/);
});

test('invalid EXPECTED_CLUSTER ("mainnet" typo) → exit 1', async () => {
  const r = await boot({ ...OK, EXPECTED_CLUSTER: 'mainnet' });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /EXPECTED_CLUSTER/);
});

test('WARN < MIN cranker balance → exit 1', async () => {
  const r = await boot({ ...OK, MIN_CRANKER_BALANCE_SOL: '0.2', WARN_CRANKER_BALANCE_SOL: '0.1' });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /WARN_CRANKER_BALANCE_SOL/);
});

test('mainnet with REQUIRE_PROGRAM_EXECUTABLE=0 → exit 1 (cannot waive on mainnet)', async () => {
  // mainnet-beta also requires the executor (or ALLOW_NO_EXECUTOR); set the latter so we isolate the
  // REQUIRE_PROGRAM_EXECUTABLE check as the failing one.
  const r = await boot({ ...OK, EXPECTED_CLUSTER: 'mainnet-beta', REQUIRE_PROGRAM_EXECUTABLE: '0', ALLOW_NO_EXECUTOR: '1' });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /REQUIRE_PROGRAM_EXECUTABLE/);
});

test('executor enabled but keypair unreadable → exit 1 (static executor config is fatal before listen)', async () => {
  const r = await boot({ ...OK, EXECUTOR_ENABLED: '1', CRANKER_KEYPAIR: '/nonexistent/cranker.json' });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /executor/i);
});

test('mainnet without FCM and without ALLOW_NO_FCM → exit 1 (static FCM readiness enforced before listen)', async () => {
  // ALLOW_NO_EXECUTOR=1 isolates the FCM check as the failing one; no FCM_SERVICE_ACCOUNT is provided.
  const r = await boot({ ...OK, EXPECTED_CLUSTER: 'mainnet-beta', ALLOW_NO_EXECUTOR: '1', FCM_SERVICE_ACCOUNT: '' });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /FCM service account/);
});

// WP3 registration-auth boot fatals — reached AFTER assertSecureConfig/executor
// static config, BEFORE the network classify + listen (so no network is touched).
// OK provides ADMIN_SECRET + a mode; each case removes/faults exactly one.
const OK3 = {
  ...OK,
  ADMIN_SECRET: 'boot-admin-secret',
  REGISTRATION_AUTH_MODE: 'dual',
  // WP4: dual requires a legacy cutoff. Real boot clock → a 1h-future value.
  REGISTRATION_LEGACY_ACCEPT_UNTIL: String(Math.floor(Date.now() / 1000) + 3600),
};

test('production missing REGISTRATION_AUTH_MODE → exit 1', async () => {
  const { REGISTRATION_AUTH_MODE, ...noMode } = OK3;
  const r = await boot(noMode);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /REGISTRATION_AUTH_MODE/);
});

test('production missing ADMIN_SECRET → exit 1', async () => {
  const { ADMIN_SECRET, ...noAdmin } = OK3;
  const r = await boot(noAdmin);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /ADMIN_SECRET/);
});

test('ADMIN_SECRET equal to REGISTER_SECRET → exit 1', async () => {
  const r = await boot({ ...OK3, ADMIN_SECRET: OK3.REGISTER_SECRET });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /ADMIN_SECRET must not equal REGISTER_SECRET/);
});

// WP4 registration-auth transition boot fatals.
test('dual without REGISTRATION_LEGACY_ACCEPT_UNTIL → exit 1', async () => {
  const { REGISTRATION_LEGACY_ACCEPT_UNTIL, ...noCut } = OK3;
  const r = await boot(noCut);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /REGISTRATION_LEGACY_ACCEPT_UNTIL/);
});

test('signed mode with REGISTRATION_LEGACY_ACCEPT_UNTIL set → exit 1', async () => {
  const r = await boot({
    ...OK, EXPECTED_CLUSTER: 'devnet', ADMIN_SECRET: 'boot-admin-secret',
    REGISTRATION_AUTH_MODE: 'signed', REGISTRATION_LEGACY_ACCEPT_UNTIL: String(Math.floor(Date.now() / 1000) + 3600),
  });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /REGISTRATION_LEGACY_ACCEPT_UNTIL/);
});

test('dual with a cutoff more than 30 days in the future → exit 1', async () => {
  const r = await boot({ ...OK3, REGISTRATION_LEGACY_ACCEPT_UNTIL: String(Math.floor(Date.now() / 1000) + 40 * 86400) });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /at most 30 days/);
});
