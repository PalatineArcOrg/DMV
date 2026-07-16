// Child-process fatal-handler tests (Phase 2). Spawns a minimal fixture that installs the REAL
// installFatalGuards(), injects an unhandled rejection / uncaught exception, and asserts the process
// fails closed (exit 1, redacted log, dead before any later poll/crank callback or tx submission).
// A third case proves expected LOCAL errors are contained and do NOT exit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { sanitize } from '../src/fatalGuards.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = resolve(here, 'fixtures/fatal-fixture.mjs');

test('sanitize() strips URLs, credential assignments, bearer tokens and PEM', () => {
  const out = sanitize('err https://rpc.example.com/?api-key=SEKRET token=TTT password=PPP Bearer BBB\n-----BEGIN KEY-----\nKKK\n-----END KEY-----');
  for (const s of ['SEKRET', 'TTT', 'PPP', 'BBB', 'KKK', 'rpc.example.com']) {
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
  const two = sanitize('password=my secret phrase, user=bob');
  assert.ok(!two.includes('my secret phrase'), `leaked: ${two}`);
  assert.ok(two.includes('user=bob'), `over-redacted the neighbour: ${two}`);
});

test('sanitize() redacts QUOTED-JSON credential fields, spacing variants and nested objects', () => {
  // The gap the reviewer caught: quoted JSON keys were not redacted by the old regex.
  const cases = [
    ['{"api_key":"SEKRET1"}', 'SEKRET1'],
    ['{"token": "SEKRET2"}', 'SEKRET2'],           // space after colon
    ["{'secret' : 'SEKRET3'}", 'SEKRET3'],         // single quotes + spaces around colon
    ['{"private_key":"SEKRET4","client_email":"x"}', 'SEKRET4'], // nested-object field
    ['{"password":"SEKRET5"}', 'SEKRET5'],
    ['{"client_secret":"SEKRET6"}', 'SEKRET6'],
    ['config {"access_token":"SEKRET7"} loaded', 'SEKRET7'],
  ];
  for (const [input, secret] of cases) {
    const out = sanitize(input);
    assert.ok(!out.includes(secret), `sanitize leaked "${secret}" from ${input} → ${out}`);
    assert.ok(out.includes('[redacted]'), `no redaction marker in ${out}`);
  }
});

test('sanitize() redacts QUOTED values containing spaces, commas and escaped quotes; preserves neighbours', () => {
  // The reviewer's blocker: the old value matcher [^\s"',}]+ stopped at a space/comma, leaking
  // {"password":"my secret phrase"} and {"api_key":"some,key"}. The quoted-value rule now consumes
  // through the matching closing quote.
  const cases = [
    ['{"password":"my secret phrase"}', 'my secret phrase'],       // double-quoted value WITH SPACES
    ["{'secret':'single quoted spaces'}", 'single quoted spaces'], // single-quoted value with spaces
    ['{"api_key":"has,commas,inside"}', 'has,commas,inside'],      // quoted value containing COMMAS
    ['{"token":"esc\\"aped quote here"}', 'aped quote here'],      // escaped quote inside a quoted value
  ];
  for (const [input, secret] of cases) {
    const out = sanitize(input);
    assert.ok(!out.includes(secret), `sanitize leaked "${secret}" from ${input} → ${out}`);
    assert.ok(out.includes('[redacted]'), `no redaction marker in ${out}`);
  }
  // A non-secret neighbouring field must be preserved (the quoted-value rule must not over-eat).
  const nested = sanitize('{"api_key":"S with space","client_email":"keepme@example.test"}');
  assert.ok(!nested.includes('S with space'), `leaked secret: ${nested}`);
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

test('sanitize() redacts an api-key embedded in a URL query and a bearer token', () => {
  const out = sanitize('POST https://api.helius.xyz/v0/x?api-key=LIVEKEY failed; Authorization: Bearer ABC.DEF.GHI');
  assert.ok(!out.includes('LIVEKEY'));
  assert.ok(!out.includes('ABC.DEF.GHI'));
  assert.ok(!out.includes('api.helius.xyz'));
});

test('sanitize() redacts a raw multi-line PEM used as a credential value (no leaked key bytes)', () => {
  // Defense-in-depth: an UNQUOTED PEM value (real newlines) must be redacted whole — the PEM rule runs
  // before the key=value rule so the latter can't consume just the `-----BEGIN` token and leak the body.
  const pem = 'private_key=-----BEGIN PRIVATE KEY-----\nMIIBODYSECRET1234567890\nMOREKEYBYTES\n-----END PRIVATE KEY-----';
  const out = sanitize(pem);
  assert.ok(!out.includes('MIIBODYSECRET1234567890'), `leaked PEM body: ${out}`);
  assert.ok(!out.includes('MOREKEYBYTES'), `leaked PEM body: ${out}`);
  // Same for the quoted-JSON form.
  const json = '{"private_key":"-----BEGIN PRIVATE KEY-----\\nMIIQUOTEDSECRET\\n-----END PRIVATE KEY-----"}';
  assert.ok(!sanitize(json.replace(/\\n/g, '\n')).includes('MIIQUOTEDSECRET'));
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
// message — so a fatal crash is diagnosable. The message is prefixed by the error class ("Error: ") and
// followed by real "at …" frames; file:// app-frame paths are redacted to [redacted-url] but frame
// function names + node-internal file:line survive, so context remains without leaking a path/secret.
const HAS_STACK_FRAMES = /\n\s+at .+/;      // at least one "    at …" frame followed the message
const NO_URL_SCHEME = /[a-z][a-z0-9+.-]*:\/\//i; // http(s):// AND file:// must all be redacted away

test('unhandledRejection → fatal exit 1, stack preserved + redacted, no later callback/tx', async () => {
  const r = await run('reject');
  assert.equal(r.code, 1, 'must exit non-zero');
  assert.equal(r.timedOut, false);   // a genuine exit, not a hang killed by the timeout
  assert.equal(r.spawnError, null);  // ...and not a spawn failure masquerading as exit 1
  assert.match(r.stderr, /\[notify\] FATAL unhandledRejection: Error: injected_unhandled_rejection/);
  assert.match(r.stderr, HAS_STACK_FRAMES, 'stack frames must be logged, not just the message');
  assert.doesNotMatch(r.stderr, NO_URL_SCHEME, 'no url scheme survived in the stack frames');
  assert.doesNotMatch(r.stdout, /LATER_CALLBACK_RAN|TX_SUBMITTED/, 'no later poll/crank or tx after fatal');
  for (const bad of NO_SECRETS) assert.ok(!r.stderr.includes(bad), `fatal log leaked "${bad}"`);
});

test('uncaughtException → fatal exit 1, stack preserved + redacted, no later callback/tx', async () => {
  const r = await run('throw');
  assert.equal(r.code, 1);
  assert.equal(r.timedOut, false);
  assert.equal(r.spawnError, null);
  assert.match(r.stderr, /\[notify\] FATAL uncaughtException: Error: injected_uncaught_exception/);
  assert.match(r.stderr, HAS_STACK_FRAMES, 'stack frames must be logged, not just the message');
  assert.doesNotMatch(r.stderr, NO_URL_SCHEME, 'no url scheme survived in the stack frames');
  assert.doesNotMatch(r.stdout, /LATER_CALLBACK_RAN|TX_SUBMITTED/);
  for (const bad of NO_SECRETS) assert.ok(!r.stderr.includes(bad));
});

test('expected LOCAL errors are contained → NO fatal exit (exit 0, survives)', async () => {
  const r = await run('contained');
  assert.equal(r.code, 0, 'contained errors must not exit the process');
  assert.equal(r.spawnError, null);  // exit 0 is a real survival, not a swallowed spawn failure
  assert.match(r.stdout, /CONTAINED injected_local_executor_error/);
  assert.match(r.stdout, /CONTAINED_ASYNC/);
  assert.match(r.stdout, /SURVIVED/);
  assert.doesNotMatch(r.stderr, /FATAL/, 'no fatal guard fired for locally-caught errors');
});

test('secret-bearing fatal message is redacted (URL / api-key / token / password / bearer)', async () => {
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
