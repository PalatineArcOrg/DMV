/**
 * Static guard: the vendored coordination client uses no host-specific API.
 *
 * These seven modules are vendored from PalatineArcOrg/palatine-coordination
 * (see `release.manifest.json` → `coordinationClient`, and the drift check in
 * `release-tools/verify-manifest.mjs`). They ship inside the APK, so they must
 * run under React Native — not Node.
 *
 * ## Why this test exists rather than a code review
 *
 * Vendoring this client turned up two defects of exactly this class, and both
 * would have thrown at **import time** — not degraded a feature, but stopped the
 * whole module graph loading:
 *
 *   1. `node:crypto`, used to compute Anchor discriminators. Caught in review,
 *      because a `node:` specifier is what everyone looks for.
 *
 *   2. `new TextEncoder()` at module scope, building PDA seed constants. **Not**
 *      caught in review. It hides better precisely because it is a *web standard*
 *      rather than a Node builtin, so it sails past a "grep for node:" audit —
 *      and `app/src/polyfills.ts` installs `Buffer`, `structuredClone` and
 *      `crypto.getRandomValues`, but **not** `TextEncoder`. This repo already
 *      knew that: see the note and regression test in
 *      `src/services/NotificationRegistrationService.ts`.
 *
 * The upstream repo runs the same guard. This one exists because upstream's
 * passing is not evidence about *these* bytes — the vendored copy is what ships,
 * and a bad re-vendor should fail in DMV's CI, not on a device.
 *
 * Note the asymmetry that makes this worth automating: every other test in this
 * app runs under Node, where all of these APIs exist. A reintroduced builtin is
 * green in CI, green in Jest, green locally, and throws on first launch.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The vendored surface, frozen by contract (DECISIONS.md 26 upstream). Listed
 * literally rather than globbed so that a file appearing or vanishing fails here
 * as well as in `verify-manifest.mjs` — two independent gates on the same fact.
 */
const VENDORED = [
  'borsh.ts',
  'extraAccountMeta.ts',
  'instructions.ts',
  'job.ts',
  'layout.ts',
  'pdas.ts',
  'reward.ts',
] as const;

/**
 * Comments are stripped before matching. These modules explain at length *why*
 * `node:crypto` is gone and what `TextEncoder` broke; prose about a builtin is
 * not a use of one, and a guard that cannot tell the difference gets deleted the
 * first time it cries wolf.
 */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** Each pattern is a thing that does not exist, or is not polyfilled, in RN. */
const FORBIDDEN: ReadonlyArray<readonly [RegExp, string]> = [
  [/from\s+['"]node:/, "a 'node:' import — no Node builtins exist in the APK"],
  [/\brequire\s*\(/, 'a CommonJS require() — the bundle is ESM'],
  [/\bprocess\.\w/, 'process.* — not present in React Native'],
  [/\bcrypto\.subtle\b/, 'crypto.subtle — expo-crypto does not provide it'],
  [/\bnew TextEncoder\b/, 'TextEncoder — a web standard, but NOT in app/src/polyfills.ts'],
  [/\bnew TextDecoder\b/, 'TextDecoder — same as TextEncoder: standard, absent, unpolyfilled'],
];

test('the vendored directory holds exactly the frozen surface', () => {
  const found = readdirSync(HERE)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .sort();
  assert.deepEqual(
    found,
    [...VENDORED].sort(),
    'the vendored file set changed — re-vendor with scripts/vendor-client.mjs upstream ' +
      'and update release.manifest.json, or update the frozen surface in DECISIONS.md 26',
  );
});

test('no vendored module reaches for a host API the APK does not have', () => {
  for (const name of VENDORED) {
    const code = stripComments(readFileSync(join(HERE, name), 'utf8'));
    for (const [pattern, why] of FORBIDDEN) {
      assert.equal(
        pattern.test(code),
        false,
        `${name} contains ${why}.\n` +
          '  This throws at IMPORT time inside the APK, so it takes the whole module ' +
          'graph down rather than failing one call.\n' +
          '  It is also invisible to every other test here, which all run under Node.',
      );
    }
  }
});

test('Buffer is the one host global these modules may rely on', () => {
  // Buffer is legitimate: app/package.json depends on buffer@^6, and
  // app/src/polyfills.ts assigns global.Buffer before anything else loads.
  // Asserting it is *used* keeps this test honest — if the modules stopped
  // needing Buffer, the polyfill ordering constraint would be worth revisiting
  // rather than silently carried forever.
  const all = VENDORED.map((n) => stripComments(readFileSync(join(HERE, n), 'utf8'))).join('\n');
  assert.ok(/\bBuffer\b/.test(all), 'expected the vendored client to use Buffer');
});
