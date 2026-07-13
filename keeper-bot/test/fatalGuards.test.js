// Child-process fatal-handler tests for the keeper (Phase 2). Spawns a minimal fixture that installs
// the REAL installFatalGuards(), injects an unhandled rejection / uncaught exception, and asserts the
// keeper fails closed (exit 1, redacted, dead before any later crank tick / tx). A third case proves
// expected LOCAL errors are contained and do NOT exit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { sanitize } from '../src/fatalGuards.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = resolve(here, 'fixtures/fatal-fixture.mjs');

test('sanitize() strips URLs, credential assignments, bearer tokens and PEM', () => {
  const out = sanitize('err https://rpc.example.com/?api-key=SEKRET token=TTT password=PPP Bearer BBB');
  for (const s of ['SEKRET', 'TTT', 'PPP', 'BBB', 'rpc.example.com']) {
    assert.ok(!out.includes(s), `sanitize leaked "${s}"`);
  }
});

// Blocker (this round): an UNQUOTED credential value with INTERNAL SPACES must be redacted WHOLE — the
// old whitespace boundary leaked the suffix (`password=my secret phrase` → `password=[redacted] secret
// phrase`). Consume through comma / brace / end-of-line instead.
test('sanitize() redacts an unquoted credential value containing spaces (no suffix leak)', () => {
  for (const [input, secret] of [
    ['password=my secret phrase', 'secret phrase'],
    ['boot failed: token=abc def ghi', 'def ghi'],
  ]) {
    const out = sanitize(input);
    assert.ok(!out.includes(secret), `leaked suffix "${secret}" from ${input} → ${out}`);
    assert.ok(out.includes('[redacted]'), `no redaction marker in ${out}`);
  }
  // A value terminated by a comma/brace still preserves the following field.
  const two = sanitize('password=my secret phrase, user=bob');
  assert.ok(!two.includes('my secret phrase'), `leaked: ${two}`);
  assert.ok(two.includes('user=bob'), `over-redacted the neighbour: ${two}`);
});

test('sanitize() redacts QUOTED-JSON credential fields + URL-query api-keys (shared contract)', () => {
  for (const [input, secret] of [
    ['{"api_key":"SEKRET1"}', 'SEKRET1'],
    ['{"token": "SEKRET2"}', 'SEKRET2'],
    ['scan failed: fetch https://rpc.helius.xyz/?api-key=LIVE', 'LIVE'],
    ['{"private_key":"SEKRET4"}', 'SEKRET4'],
  ]) {
    assert.ok(!sanitize(input).includes(secret), `keeper sanitize leaked "${secret}"`);
  }
});

test('sanitize() redacts QUOTED values with spaces / commas / escaped quotes; preserves neighbours', () => {
  for (const [input, secret] of [
    ['{"password":"my secret phrase"}', 'my secret phrase'],
    ["{'secret':'single quoted spaces'}", 'single quoted spaces'],
    ['{"api_key":"has,commas,inside"}', 'has,commas,inside'],
    ['{"token":"esc\\"aped quote here"}', 'aped quote here'],
  ]) {
    assert.ok(!sanitize(input).includes(secret), `keeper sanitize leaked "${secret}"`);
  }
  const nested = sanitize('{"api_key":"S with space","client_email":"keepme@example.test"}');
  assert.ok(!nested.includes('S with space'));
  assert.ok(nested.includes('keepme@example.test'), `over-redacted a neighbour: ${nested}`);
});

test('sanitize() redacts an UNTERMINATED quoted credential (no closing quote); preserves completed neighbours', () => {
  // FAIL-CLOSED: sanitize() takes arbitrary free text (truncated / concatenated provider errors), not
  // only valid JSON. A sensitive key + an OPENING quote with NO closing quote is caught by neither the
  // valid-quoted rule (no close) nor the unquoted rule (excludes quotes) — the fallback redacts to EOL.
  const unterminated = [
    ['{"password":"my secret phrase', 'my secret phrase'],       // double-quoted, no closing quote
    ["{'api_key':'unterminated single", 'unterminated single'],  // single-quoted, no closing quote
    ['{"secret":"a, b, c and more', 'a, b, c and more'],         // spaces AND commas, no closing quote
  ];
  for (const [input, secret] of unterminated) {
    const out = sanitize(input);
    assert.ok(!out.includes(secret), `sanitize leaked "${secret}" from ${input} → ${out}`);
    assert.ok(out.includes('[redacted]'), `no redaction marker in ${out}`);
  }
  // A COMPLETED quoted value must still preserve its (non-secret) neighbour — the fallback runs LAST and
  // must only catch the unterminated remainder, never over-eat a terminated field's neighbour.
  const completed = sanitize('{"api_key":"S1","client_email":"keep@x"}');
  assert.ok(!completed.includes('S1'), `leaked completed secret: ${completed}`);
  assert.ok(completed.includes('keep@x'), `over-redacted a neighbour: ${completed}`);
});

function run(mode) {
  return new Promise((res) => {
    execFile('node', [fixture, mode], { timeout: 10000 }, (err, stdout, stderr) => {
      // Surface ONLY a genuine numeric exit code. A TIMEOUT/kill (surfaced via `timedOut`) and a SPAWN
      // error (ENOENT/EACCES → string `err.code`, surfaced via `spawnError`) must NOT be coerced to 1,
      // or they would falsely satisfy a "fatal guard exited 1" assertion instead of proving a real exit.
      const timedOut = !!(err && err.killed && err.signal);
      const code = err ? (typeof err.code === 'number' ? err.code : null) : 0;
      res({
        code,
        timedOut,
        killed: err?.killed === true,
        signal: err?.signal ?? null,
        spawnError: typeof err?.code === 'string' ? err.code : null,
        stdout,
        stderr,
      });
    });
  });
}

const NO_SECRETS = ['api-key', 'apikey', 'BEGIN', 'PRIVATE', 'secret', 'http://', 'https://'];
// Blocker 3: the fatal log now carries the sanitized STACK (v.stack || v.message), not just the bare
// message. The message is prefixed by the error class ("Error: ") and followed by real "at …" frames;
// file:// app-frame paths are redacted to [redacted-url] but frame function names + node-internal
// file:line survive — diagnosable context without leaking a path/secret.
const HAS_STACK_FRAMES = /\n\s+at .+/;
const NO_URL_SCHEME = /[a-z][a-z0-9+.-]*:\/\//i; // http(s):// AND file:// must all be redacted away

test('keeper unhandledRejection → fatal exit 1, stack preserved + redacted, no later tick/crank', async () => {
  const r = await run('reject');
  assert.equal(r.code, 1);
  assert.equal(r.timedOut, false);   // a genuine exit, not a hang killed by the timeout
  assert.equal(r.spawnError, null);  // ...and not a spawn failure masquerading as exit 1
  assert.match(r.stderr, /\[keeper\] FATAL unhandledRejection: Error: injected_unhandled_rejection/);
  assert.match(r.stderr, HAS_STACK_FRAMES, 'stack frames must be logged, not just the message');
  assert.doesNotMatch(r.stderr, NO_URL_SCHEME, 'no url scheme survived in the stack frames');
  assert.doesNotMatch(r.stdout, /LATER_TICK_RAN|CRANK_SUBMITTED/);
  for (const bad of NO_SECRETS) assert.ok(!r.stderr.includes(bad));
});

test('keeper uncaughtException → fatal exit 1, stack preserved + redacted, no later tick/crank', async () => {
  const r = await run('throw');
  assert.equal(r.code, 1);
  assert.equal(r.timedOut, false);
  assert.equal(r.spawnError, null);
  assert.match(r.stderr, /\[keeper\] FATAL uncaughtException: Error: injected_uncaught_exception/);
  assert.match(r.stderr, HAS_STACK_FRAMES, 'stack frames must be logged, not just the message');
  assert.doesNotMatch(r.stderr, NO_URL_SCHEME, 'no url scheme survived in the stack frames');
  assert.doesNotMatch(r.stdout, /LATER_TICK_RAN|CRANK_SUBMITTED/);
  for (const bad of NO_SECRETS) assert.ok(!r.stderr.includes(bad));
});

test('keeper expected LOCAL errors are contained → NO fatal exit (exit 0, survives)', async () => {
  const r = await run('contained');
  assert.equal(r.code, 0);
  assert.equal(r.spawnError, null);  // exit 0 is a real survival, not a swallowed spawn failure
  assert.match(r.stdout, /CONTAINED injected_local_crank_error/);
  assert.match(r.stdout, /CONTAINED_ASYNC/);
  assert.match(r.stdout, /SURVIVED/);
  assert.doesNotMatch(r.stderr, /FATAL/);
});

test('keeper secret-bearing fatal message is redacted', async () => {
  const r = await run('secret');
  assert.equal(r.code, 1);
  assert.equal(r.timedOut, false);
  assert.equal(r.spawnError, null);
  assert.match(r.stderr, /FATAL/);
  // The stack is logged (Blocker 3) yet the secret-bearing URL/token/password/bearer in BOTH the message
  // AND any file:// stack frame are redacted — stack context without a leak.
  assert.match(r.stderr, HAS_STACK_FRAMES, 'stack frames present even for a secret-bearing error');
  assert.doesNotMatch(r.stderr, NO_URL_SCHEME, 'the redacted stack leaks no url scheme');
  for (const s of ['supersecret', 'abc123', 'hunter2', 'zzztoken', 'rpc.example.com']) {
    assert.ok(!r.stderr.includes(s), `fatal log leaked "${s}"`);
  }
});
