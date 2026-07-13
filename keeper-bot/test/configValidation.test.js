// Keeper static-config validation (Phase 2 cleanup). Spawns index.js with bad env and asserts it
// fails closed (exit 1) at the static gate — before any keypair load or RPC call.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Keypair } from '@solana/web3.js';

const here = dirname(fileURLToPath(import.meta.url));
const index = resolve(here, '../src/index.js');
const OK_RPC = 'https://api.devnet.solana.com';
// An RPC that is a VALID http(s) URL (passes the static gate) but immediately refuses — so index.js
// reaches the startup log (which prints the resolved floor) and then degrades on the unreachable
// network instead of hitting live devnet. Lets FIX 1 assert the DEFAULT floor was applied, offline.
const UNREACHABLE_RPC = 'http://127.0.0.1:1';

// A valid keypair file so index.js gets PAST the fatal keypair gate and logs its config
// ("... min <floor> SOL") before the readiness gate degrades on UNREACHABLE_RPC.
let KP_PATH;
before(() => {
  KP_PATH = join(tmpdir(), `keeper-cfg-test-${process.pid}-${Date.now()}.json`);
  writeFileSync(KP_PATH, JSON.stringify([...Keypair.generate().secretKey]));
});
after(() => { try { unlinkSync(KP_PATH); } catch { /* best-effort cleanup */ } });

// Strip keeper-specific env so a developer's shell can't leak into the child. Keep PATH/HOME for node.
const KEEPER_ENV_KEYS = ['RPC_URL', 'KEYPAIR_PATH', 'POLL_MS', 'EXPECTED_CLUSTER', 'CLOSE_EXECUTED', 'MIN_KEEPER_BALANCE_SOL', 'WARN_KEEPER_BALANCE_SOL'];
function run(env) {
  const clean = { ...process.env };
  for (const k of KEEPER_ENV_KEYS) delete clean[k];
  return new Promise((res) => {
    execFile('node', [index, '--once'], { timeout: 10000, env: { ...clean, ...env } }, (err, stdout, stderr) => {
      // Distinguish a real non-zero EXIT from a TIMEOUT/kill or a SPAWN error — neither may be coerced
      // to code 1 and masquerade as a config-fatal exit.
      const timedOut = !!(err && err.killed && err.signal);
      res({ code: timedOut ? 'TIMEOUT' : err ? (typeof err.code === 'number' ? err.code : null) : 0, stdout, stderr, timedOut, spawnError: typeof err?.code === 'string' ? err.code : null });
    });
  });
}

test('invalid RPC_URL → exit 1', async () => {
  const r = await run({ RPC_URL: 'not a url', KEYPAIR_PATH: '/nonexistent.json', EXPECTED_CLUSTER: 'devnet' });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /invalid RPC_URL/);
});

// Blocker (this round): a POLL_MS above Node's signed-32-bit setTimeout limit (2^31-1) overflows and is
// reduced to ~1ms → a tight RPC loop. Enforce 1000 <= POLL_MS <= 2147483647.
test('POLL_MS at the timer limit (2147483647) is accepted (config valid; degrades on the unreachable RPC)', async () => {
  const r = await run({ RPC_URL: UNREACHABLE_RPC, KEYPAIR_PATH: KP_PATH, POLL_MS: '2147483647', EXPECTED_CLUSTER: 'devnet' });
  // Require a GENUINE degraded --once exit (not a TIMEOUT masquerading as a pass): the config is valid so
  // POLL_MS is accepted, then the unreachable RPC degrades the gate → runOnce false → exit 1.
  assert.equal(r.code, 1, 'child genuinely exited 1 (degraded --once pass), not TIMEOUT');
  assert.doesNotMatch(r.stderr, /invalid POLL_MS/, 'the max timer-safe interval passes config validation');
});
test('POLL_MS above the timer limit (2147483648) → exit 1 (rejected)', async () => {
  const r = await run({ RPC_URL: OK_RPC, KEYPAIR_PATH: '/nonexistent.json', POLL_MS: '2147483648', EXPECTED_CLUSTER: 'devnet' });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /invalid POLL_MS/);
});
test('POLL_MS = Number.MAX_SAFE_INTEGER → exit 1 (rejected, would overflow the timer)', async () => {
  const r = await run({ RPC_URL: OK_RPC, KEYPAIR_PATH: '/nonexistent.json', POLL_MS: String(Number.MAX_SAFE_INTEGER), EXPECTED_CLUSTER: 'devnet' });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /invalid POLL_MS/);
});

test('non-integer POLL_MS → exit 1 (error text promised an integer)', async () => {
  const r = await run({ RPC_URL: OK_RPC, KEYPAIR_PATH: '/nonexistent.json', POLL_MS: '30.5', EXPECTED_CLUSTER: 'devnet' });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /invalid POLL_MS/);
});

test('WARN < MIN keeper balance → exit 1', async () => {
  const r = await run({ RPC_URL: OK_RPC, KEYPAIR_PATH: '/nonexistent.json', MIN_KEEPER_BALANCE_SOL: '0.5', WARN_KEEPER_BALANCE_SOL: '0.1', EXPECTED_CLUSTER: 'devnet' });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /WARN_KEEPER_BALANCE_SOL/);
});

// FIX 1: an EMPTY balance-threshold env (e.g. `MIN_KEEPER_BALANCE_SOL=` copied from .env.example) must
// NOT silently become Number('') === 0 and disable the floor. It uses the safe code default (devnet
// 0.02), which the startup line prints as "min 0.02 SOL" — never "min 0 SOL".
test('empty MIN_KEEPER_BALANCE_SOL uses the default floor, not 0', async () => {
  const r = await run({ RPC_URL: UNREACHABLE_RPC, KEYPAIR_PATH: KP_PATH, MIN_KEEPER_BALANCE_SOL: '', EXPECTED_CLUSTER: 'devnet' });
  // Assert a GENUINE exit — not a TIMEOUT masquerading as a pass. With --once + the unreachable RPC the
  // config is valid (default floor applied → banner printed) but the readiness gate degrades, so runOnce
  // returns false → process.exit(1). Without this, the stdout checks below could pass while the child
  // merely printed the banner and then hung.
  assert.equal(r.code, 1, 'child genuinely exited 1 (degraded --once pass), not TIMEOUT');
  assert.match(r.stdout, /min 0\.02 SOL/, 'empty threshold falls back to the default 0.02 floor');
  assert.doesNotMatch(r.stdout, /min 0 SOL/, 'must not silently run with a disabled (0) floor');
});

// Whitespace-only is likewise "use the default" (Number('   ') === 0 without the trim guard).
test('whitespace-only MIN_KEEPER_BALANCE_SOL uses the default floor, not 0', async () => {
  const r = await run({ RPC_URL: UNREACHABLE_RPC, KEYPAIR_PATH: KP_PATH, MIN_KEEPER_BALANCE_SOL: '   ', EXPECTED_CLUSTER: 'devnet' });
  assert.equal(r.code, 1, 'child genuinely exited 1 (degraded --once pass), not TIMEOUT');
  assert.match(r.stdout, /min 0\.02 SOL/);
  assert.doesNotMatch(r.stdout, /min 0 SOL/);
});

// A genuinely invalid (non-blank) value still fails closed at the static gate.
// Round-N: a finite-but-huge SOL threshold overflows to Infinity lamports (`* 1e9`), leaving the keeper
// permanently degraded. It must be rejected at config time instead.
test('MIN_KEEPER_BALANCE_SOL that overflows lamports (1e308) → exit 1', async () => {
  const r = await run({ RPC_URL: OK_RPC, KEYPAIR_PATH: '/nonexistent.json', MIN_KEEPER_BALANCE_SOL: '1e308', EXPECTED_CLUSTER: 'devnet' });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /invalid MIN_KEEPER_BALANCE_SOL/);
});

// A positive-but-sub-lamport threshold rounds to 0 lamports (Math.round(1e-10 * 1e9) === 0), which would
// silently disable the balance floor. Must be rejected at config time (parity with notify-server).
test('MIN_KEEPER_BALANCE_SOL that collapses to 0 lamports (1e-10) → exit 1', async () => {
  const r = await run({ RPC_URL: OK_RPC, KEYPAIR_PATH: '/nonexistent.json', MIN_KEEPER_BALANCE_SOL: '1e-10', EXPECTED_CLUSTER: 'devnet' });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /invalid MIN_KEEPER_BALANCE_SOL/);
});

test('invalid MIN_KEEPER_BALANCE_SOL (abc) → exit 1', async () => {
  const r = await run({ RPC_URL: OK_RPC, KEYPAIR_PATH: '/nonexistent.json', MIN_KEEPER_BALANCE_SOL: 'abc', EXPECTED_CLUSTER: 'devnet' });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /invalid MIN_KEEPER_BALANCE_SOL/);
});
