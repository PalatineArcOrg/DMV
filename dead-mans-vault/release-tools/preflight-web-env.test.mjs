// Web env-precedence tests: prove buildWebEnv() (backed by Vite's own loadEnv) matches Vite's
// resolution order. Needs `vite` installed in web/node_modules, so this runs in the CI **web** job
// (which does `npm ci` in web/), NOT the pure-node manifest job.
//   run (from repo root, web deps installed): node --test dead-mans-vault/release-tools/preflight-web-env.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveViteLoadEnv, buildWebEnv } from './preflight-prod-build.mjs';

// The real web project (has vite in node_modules) — resolve Vite's loadEnv from here.
const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');

function tmpEnvDir(files) {
  const dir = mkdtempSync(join(tmpdir(), 'dmv-webenv-'));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

test('.env.production overrides .env.local', async () => {
  const loadEnv = await resolveViteLoadEnv(WEB_DIR);
  const dir = tmpEnvDir({
    '.env': 'VITE_X=base\n',
    '.env.local': 'VITE_X=local\n',
    '.env.production': 'VITE_X=prod\n',
  });
  try {
    assert.equal(buildWebEnv(loadEnv, dir, {}).VITE_X, 'prod');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('.env.production.local overrides both .env.production and .env.local', async () => {
  const loadEnv = await resolveViteLoadEnv(WEB_DIR);
  const dir = tmpEnvDir({
    '.env': 'VITE_X=base\n',
    '.env.local': 'VITE_X=local\n',
    '.env.production': 'VITE_X=prod\n',
    '.env.production.local': 'VITE_X=prodlocal\n',
  });
  try {
    assert.equal(buildWebEnv(loadEnv, dir, {}).VITE_X, 'prodlocal');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('existing process.env VITE_* overrides every env file', async () => {
  const loadEnv = await resolveViteLoadEnv(WEB_DIR);
  const dir = tmpEnvDir({
    '.env.production': 'VITE_X=prod\n',
    '.env.production.local': 'VITE_X=prodlocal\n',
  });
  try {
    assert.equal(buildWebEnv(loadEnv, dir, { VITE_X: 'fromprocess' }).VITE_X, 'fromprocess');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('quoted and expanded values match Vite (dotenv + dotenv-expand)', async () => {
  const loadEnv = await resolveViteLoadEnv(WEB_DIR);
  const dir = tmpEnvDir({
    '.env': 'VITE_BASE=abc\nVITE_QUOTED="hello world"\nVITE_DERIVED=${VITE_BASE}-z\n',
  });
  try {
    const env = buildWebEnv(loadEnv, dir, {});
    assert.equal(env.VITE_QUOTED, 'hello world'); // quotes stripped
    assert.equal(env.VITE_DERIVED, 'abc-z'); // dotenv-expand applied
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
