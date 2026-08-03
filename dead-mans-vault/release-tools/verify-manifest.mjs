#!/usr/bin/env node
// Cross-check the release manifest (release.manifest.json) against the ACTUAL source constants
// across every component, so a drifted PROGRAM_ID / FEE_WALLET / IDL / version can never ship.
// The 3 IDL copies are hand-synced; this is the drift guard. Run in CI + before any build.
// Exits non-zero on any mismatch.
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const p = (rel) => resolve(ROOT, rel);
const read = (rel) => readFileSync(p(rel), 'utf8');

const manifest = JSON.parse(read('dead-mans-vault/release.manifest.json'));

const GENESIS_HASHES = {
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  'mainnet-beta': '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
};

const checks = [];
const check = (name, expected, found) =>
  checks.push({ name, expected: String(expected), found: String(found), ok: String(expected) === String(found) });

const match1 = (rel, re) => {
  const m = read(rel).match(re);
  return m ? m[1] : `(pattern not found in ${rel})`;
};
const sha256 = (rel) => createHash('sha256').update(readFileSync(p(rel))).digest('hex');
const idlAddress = (rel) => {
  try { return JSON.parse(read(rel)).address; } catch { return `(unparseable ${rel})`; }
};

// expectedGenesisHash must match the manifest's cluster
check('genesis-hash ↔ expectedCluster', GENESIS_HASHES[manifest.expectedCluster] ?? '(unknown cluster)', manifest.expectedGenesisHash);

// PROGRAM_ID across all 5 source-of-truth sites
check('programId: rust declare_id', manifest.programId, match1('dead-mans-vault/programs/dead-mans-vault/src/lib.rs', /declare_id!\("([^"]+)"\)/));
check('programId: app constants.ts', manifest.programId, match1('dead-mans-vault/app/src/utils/constants.ts', /export const PROGRAM_ID = '([^']+)'/));
check('programId: notify config.js', manifest.programId, match1('notify-server/src/config.js', /PROGRAM_ID\s*\|\|\s*'([^']+)'/));
check('programId: app IDL address', manifest.programId, idlAddress('dead-mans-vault/app/src/utils/idl.json'));
check('programId: notify IDL address', manifest.programId, idlAddress('notify-server/idl/dead_mans_vault.json'));
check('programId: keeper IDL address', manifest.programId, idlAddress('keeper-bot/idl/dead_mans_vault.json'));

// FEE_WALLET (baked into bytecode via the on-chain `address =` constraint — must match the client)
check('feeWallet: rust constants.rs', manifest.feeWallet, match1('dead-mans-vault/programs/dead-mans-vault/src/constants.rs', /pub const FEE_WALLET[\s\S]*?pubkey!\("([^"]+)"\)/));
check('feeWallet: app constants.ts', manifest.feeWallet, match1('dead-mans-vault/app/src/utils/constants.ts', /export const FEE_WALLET = '([^']+)'/));

// IDL hash-equality: all 3 copies == manifest (catches a hand-sync drift)
check('idlSha256: app idl.json', manifest.idlSha256, sha256('dead-mans-vault/app/src/utils/idl.json'));
check('idlSha256: notify idl', manifest.idlSha256, sha256('notify-server/idl/dead_mans_vault.json'));
check('idlSha256: keeper idl', manifest.idlSha256, sha256('keeper-bot/idl/dead_mans_vault.json'));

// Vendored coordination client (palatine-coordination). DMV vendors seven modules into
// app/src/coordination/ rather than taking a path dependency — Metro is hostile to symlinks
// and .js specifiers, and this repo has no precedent for file: deps.
//
// This checks INTEGRITY only: the vendored bytes are the ones recorded when they were
// vendored. It CANNOT check PROVENANCE — whether those hashes describe the commit the
// manifest names — because this repo has no copy of palatine-coordination. That question is
// answered there, by scripts/vendor-client.mjs --verify, and the failure text below names it.
const cc = manifest.coordinationClient;
if (!cc || typeof cc !== 'object') {
  check('coordinationClient: manifest block', 'present', '(missing)');
} else {
  check('coordinationClient: sourceRepo', 'PalatineArcOrg/palatine-coordination', cc.sourceRepo);
  check('coordinationClient: sourceCommit is a full sha', true, /^[0-9a-f]{40}$/.test(String(cc.sourceCommit ?? '')));

  const VENDOR_DIR = 'dead-mans-vault/app/src/coordination';
  const pinned = Object.keys(cc.files ?? {}).sort();

  // Drift direction 1: a file was added to or removed from the vendored directory.
  let onDisk = [];
  try {
    onDisk = readdirSync(p(VENDOR_DIR)).filter((f) => f.endsWith('.ts')).sort();
  } catch {
    onDisk = ['(directory unreadable)'];
  }
  check(`coordinationClient: file set in ${VENDOR_DIR}`, pinned.join(' '), onDisk.join(' '));

  // Drift direction 2: a vendored file was edited locally.
  for (const name of pinned) {
    let found;
    try { found = sha256(`${VENDOR_DIR}/${name}`); } catch { found = '(unreadable)'; }
    check(`coordinationClient: ${name}`, cc.files[name], found);
  }
}

// app version / versionCode
const appJson = JSON.parse(read('dead-mans-vault/app/app.json'));
check('appVersion: app.json', manifest.appVersion, appJson.expo?.version ?? appJson.version);
check('versionCode: app.json', manifest.versionCode, appJson.expo?.android?.versionCode ?? appJson.android?.versionCode);

let failed = 0;
for (const c of checks) {
  if (c.ok) {
    console.log(`  [ OK ] ${c.name}`);
  } else {
    failed++;
    console.log(`  [FAIL] ${c.name}\n         manifest: ${c.expected}\n         source:   ${c.found}`);
  }
}
console.log(`\n${checks.length - failed}/${checks.length} checks passed.`);
if (failed) {
  console.error(`\n✗ release manifest is OUT OF SYNC with source (${failed} mismatch${failed > 1 ? 'es' : ''}).`);

  // The vendored client has a specific remedy, and it lives in the other repo.
  if (checks.some((c) => !c.ok && c.name.startsWith('coordinationClient'))) {
    const commit = manifest.coordinationClient?.sourceCommit ?? '<sha>';
    console.error(
      [
        '',
        '  The vendored coordination client drifted. Two directions, one fix:',
        '',
        '    · a vendored file was edited here      → re-vendor to discard the local edit',
        '    · palatine-coordination moved upstream → re-vendor to adopt it, then retest',
        '',
        '  Re-vendor (from a palatine-coordination checkout):',
        '',
        '    node scripts/vendor-client.mjs --commit <sha> \\',
        '         --out <this-repo>/dead-mans-vault/app/src/coordination',
        '',
        '  ...then paste the emitted block into release.manifest.json as "coordinationClient".',
        '',
        `  This check proves INTEGRITY only — that these bytes are the ones recorded. It cannot`,
        `  prove PROVENANCE, that they are what ${commit.slice(0, 12)} actually contains, because`,
        '  this repo has no copy of palatine-coordination. Verify that there:',
        '',
        '    node scripts/vendor-client.mjs --verify <this-repo>/dead-mans-vault/release.manifest.json',
        '',
        '  The vendored surface is frozen by contract — see DECISIONS.md 26 in that repo.',
        '',
      ].join('\n'),
    );
  }
  process.exit(1);
}
console.log('✓ release manifest matches source.');
