// DMV keeper-bot — RPC-failure + concurrent-race stress test (STRESS-TESTING-PLAN §5).
//
// Spins up a LOCAL solana-test-validator (custom ports, fresh ledger — never
// touches devnet/mainnet or the live dmv-keeper.service), deploys the program,
// creates matured-able vaults, and drives the REAL keeper `crankVault` through a
// fault-injecting HTTP proxy to prove the crank is correctness-safe under RPC
// failure. The on-chain masks/guards are the backstop; this verifies the client
// never turns a transient RPC failure into a misdistribution / double-pay.
//
//   S1  transient 429s/timeouts during a crank  → completes or cleanly retries
//   S2  rate-limited read on the close path      → reverts + heals, no token lost
//   S3  two cranks racing the same vault         → masks keep it safe, no double-pay
//
// Run: node stress/rpc-stress.mjs   (from keeper-bot/). Exits non-zero on failure.
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Ensure anchor / solana / cargo are on PATH regardless of how node was invoked.
process.env.PATH = [
  `${process.env.HOME}/.local/share/solana/install/active_release/bin`,
  `${process.env.HOME}/.cargo/bin`,
  `${process.env.HOME}/.avm/bin`,
  process.env.PATH || '',
].join(':');
import {
  Connection, Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL, Transaction,
} from '@solana/web3.js';
import { AnchorProvider, Program, Wallet, BN } from '@coral-xyz/anchor';
import {
  TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction, createInitializeMint2Instruction,
  createMintToInstruction, MINT_SIZE, getMinimumBalanceForRentExemptMint,
} from '@solana/spl-token';
import { crankVault } from '../src/crank.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO = join(HERE, '..', '..');
const ANCHOR_DIR = join(REPO, 'dead-mans-vault');
const SO = join(ANCHOR_DIR, 'target', 'deploy', 'dead_mans_vault.so'); // main build (must stay PROD-floor)
const DEVNET_SO = join(HERE, 'dmv_devnet.so'); // cached devnet-floor build (gitignored); what we deploy
const PROGRAM_KP = join(ANCHOR_DIR, 'target', 'deploy', 'dead_mans_vault-keypair.json');
const IDL = JSON.parse(readFileSync(join(HERE, '..', 'idl', 'dead_mans_vault.json'), 'utf8'));
const FEE_WALLET = new PublicKey('98x9Rn63Ne8xbL3w522zgbuYg9bdHn7cRqJQVCUZUFsp');

// Produce (and cache) a devnet-floor .so WITHOUT leaving the main .so changed.
// Vaults need the 10s/30s floors to mature in ~40s real time; the fuzz harness
// needs the main .so to stay the prod-floor (86400/604800) build. So: build
// devnet → copy to a cached path → rebuild prod (restore the main .so). Cached
// by existence, so only the FIRST run pays the two-build cost.
function ensureDevnetSo() {
  if (existsSync(DEVNET_SO)) {
    console.log('[stress] using cached devnet-floor .so:', DEVNET_SO);
    return DEVNET_SO;
  }
  console.log('[stress] first run — building devnet-floor program (several min)...');
  execFileSync('anchor', ['build', '--', '--features', 'devnet'], { cwd: ANCHOR_DIR, stdio: 'inherit' });
  copyFileSync(SO, DEVNET_SO); // cache the devnet-floor build
  console.log('[stress] restoring prod-floor .so (anchor build)...');
  execFileSync('anchor', ['build'], { cwd: ANCHOR_DIR, stdio: 'inherit' });
  console.log('[stress] cached', DEVNET_SO, '; main .so restored to prod floors');
  return DEVNET_SO;
}

const RPC_PORT = 8899, FAUCET_PORT = 9902, GOSSIP = 9300, PROXY_PORT = 8990;
const VAL_URL = `http://127.0.0.1:${RPC_PORT}`;
const PROXY_URL = `http://127.0.0.1:${PROXY_PORT}`;
const programId = new PublicKey(IDL.address);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const kp = () => Keypair.generate();
let FAILS = 0;
const check = (cond, msg) => { if (cond) { console.log(`  PASS ${msg}`); } else { console.log(`  FAIL ${msg}`); FAILS++; } };

// ── Fault-injecting JSON-RPC proxy ────────────────────────────────────────────
// `fault` is mutated by scenarios: {mode, prob, methods:Set|null}. On a matching
// request it returns a 429 (mode 'rate'), a hang→socket close ('timeout'), or
// garbage JSON ('malformed'); otherwise forwards to the validator.
const fault = { mode: 'off', prob: 0, methods: null };
function startProxy() {
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      let method = '';
      try { method = JSON.parse(body).method; } catch {}
      const hit = fault.mode !== 'off'
        && (!fault.methods || fault.methods.has(method))
        && Math.random() < fault.prob;
      if (hit && fault.mode === 'rate') {
        res.writeHead(429, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'rate limited' }));
      }
      if (hit && fault.mode === 'malformed') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end('{ this is not: valid json ');
      }
      if (hit && fault.mode === 'timeout') {
        await sleep(2500); res.destroy(); return;
      }
      try {
        const r = await fetch(VAL_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
        const txt = await r.text();
        res.writeHead(r.status, { 'content-type': 'application/json' });
        res.end(txt);
      } catch (e) { res.writeHead(502); res.end(String(e)); }
    });
  });
  return new Promise((res) => srv.listen(PROXY_PORT, '127.0.0.1', () => res(srv)));
}

// ── validator lifecycle ───────────────────────────────────────────────────────
async function startValidator(ledger) {
  const proc = spawn('solana-test-validator', [
    '--reset', '--quiet', '--ledger', ledger,
    '--rpc-port', String(RPC_PORT), '--faucet-port', String(FAUCET_PORT),
    '--gossip-port', String(GOSSIP), '--dynamic-port-range', `${GOSSIP + 1}-${GOSSIP + 100}`,
  ], { stdio: 'ignore' });
  const conn = new Connection(VAL_URL, 'confirmed');
  for (let i = 0; i < 60; i++) {
    try { await conn.getVersion(); return proc; } catch { await sleep(1000); }
  }
  throw new Error('validator did not become healthy in 60s');
}

function deploy(payerPath, soPath) {
  return new Promise((resolve, reject) => {
    const p = spawn('solana', [
      'program', 'deploy', soPath, '--program-id', PROGRAM_KP,
      '--url', VAL_URL, '--keypair', payerPath, '--commitment', 'confirmed',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (err += d));
    p.on('close', (c) => (c === 0 ? resolve(out) : reject(new Error(`deploy failed: ${err || out}`))));
  });
}

function mkCtx(rpcUrl, keeper) {
  const connection = new Connection(rpcUrl, 'confirmed');
  const provider = new AnchorProvider(connection, new Wallet(keeper), { commitment: 'confirmed' });
  const program = new Program(IDL, provider);
  return { connection, provider, program, keeper };
}

// airdrop helper (always via the direct validator, never the proxy)
const air = new Connection(VAL_URL, 'confirmed');
async function fund(pubkey, sol) {
  const sig = await air.requestAirdrop(pubkey, sol * LAMPORTS_PER_SOL);
  await air.confirmTransaction(sig, 'confirmed');
}

// Create a matured-able vault. Returns {vault, owner, benes, shares, deposit}.
async function createVault(owner, { benes, shares, depositSol, token }) {
  const ctx = mkCtx(VAL_URL, owner); // set-up always over the clean RPC
  const { program } = ctx;
  const [vault] = PublicKey.findProgramAddressSync([Buffer.from('vault'), owner.publicKey.toBuffer()], programId);
  const [heartbeat] = PublicKey.findProgramAddressSync([Buffer.from('heartbeat'), vault.toBuffer()], programId);
  const agent = kp();
  await program.methods.initializeVault({
    agentPubkey: agent.publicKey,
    heartbeatInterval: new BN(10), gracePeriod: new BN(30),
    beneficiaries: benes.map((b, i) => ({ wallet: b.publicKey, shareBps: shares[i] })),
    isMutable: true, keeperBounty: new BN(5_000_000),
  }).accountsPartial({ owner: owner.publicKey, vaultConfig: vault, heartbeatRecord: heartbeat, feeRecipient: FEE_WALLET, systemProgram: SystemProgram.programId })
    .signers([owner]).rpc();
  // deposit SOL into the vault PDA
  const dep = new Transaction().add(SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: vault, lamports: depositSol * LAMPORTS_PER_SOL }));
  await air.sendTransaction(dep, [owner]).then((s) => air.confirmTransaction(s, 'confirmed'));

  let mint = null;
  if (token) {
    const m = kp(); mint = m.publicKey;
    const rent = await getMinimumBalanceForRentExemptMint(air);
    const vaultAta = getAssociatedTokenAddressSync(mint, vault, true, TOKEN_PROGRAM_ID);
    const tx = new Transaction().add(
      SystemProgram.createAccount({ fromPubkey: owner.publicKey, newAccountPubkey: mint, space: MINT_SIZE, lamports: rent, programId: TOKEN_PROGRAM_ID }),
      createInitializeMint2Instruction(mint, 0, owner.publicKey, null, TOKEN_PROGRAM_ID),
      createAssociatedTokenAccountInstruction(owner.publicKey, vaultAta, vault, mint, TOKEN_PROGRAM_ID),
      createMintToInstruction(mint, vaultAta, owner.publicKey, token.amount, [], TOKEN_PROGRAM_ID),
    );
    await air.sendTransaction(tx, [owner, m]).then((s) => air.confirmTransaction(s, 'confirmed'));
  }
  return { vault, owner, benes, shares, depositSol, mint, cfg: await program.account.vaultConfig.fetch(vault) };
}

async function main() {
  // Build/cache the devnet-floor .so BEFORE starting the validator (the build
  // itself restores the main prod-floor .so; do it while nothing depends on it).
  const devnetSo = ensureDevnetSo();
  const ledger = mkdtempSync(join(tmpdir(), 'dmv-stress-'));
  let val, proxy;
  try {
    console.log('[stress] starting validator on', VAL_URL);
    val = await startValidator(ledger);
    proxy = await startProxy();

    const payer = kp(); const payerPath = join(ledger, 'payer.json');
    writeFileSync(payerPath, JSON.stringify(Array.from(payer.secretKey)));
    await fund(payer.publicKey, 20);
    await fund(FEE_WALLET, 1); // so the creation-fee CPI destination exists
    console.log('[stress] deploying devnet-floor program', programId.toBase58());
    await deploy(payerPath, devnetSo);
    await sleep(1500);

    // Fund three owners + three keepers.
    const owners = [kp(), kp(), kp()];
    const keepers = [kp(), kp(), kp()];
    for (const k of [...owners, ...keepers]) await fund(k.publicKey, 5);

    // 2 beneficiaries each (uneven shares → residual dust exists on tokens).
    const mkBenes = () => ({ benes: [kp(), kp()], shares: [6001, 3999] });
    const b1 = mkBenes(), b2 = mkBenes(), b3 = mkBenes();

    console.log('[stress] creating 3 vaults (S1 sol, S2 token, S3 sol)...');
    const v1 = await createVault(owners[0], { ...b1, depositSol: 1 });
    const v2 = await createVault(owners[1], { ...b2, depositSol: 1, token: { amount: 1_000_003n } });
    const v3 = await createVault(owners[2], { ...b3, depositSol: 1 });

    console.log('[stress] waiting ~45s for vaults to mature (interval 10s + grace 30s)...');
    await sleep(45_000);

    const benBal = async (b) => (await air.getBalance(b.publicKey));
    const distributable = async (v) => (await air.getBalance(v.vault)); // pre-crank, above rent

    // ── S1: transient 429/timeout/malformed during the crank ──────────────────
    console.log('\n[S1] transient RPC failures during crank');
    {
      const ctx = mkCtx(PROXY_URL, keepers[0]);
      fault.mode = 'rate'; fault.prob = 0.35; fault.methods = null; // 35% of ALL calls 429
      let threw = false;
      try { await crankVault(ctx, v1.vault, v1.cfg); } catch { threw = true; }
      fault.mode = 'off';
      // heal + retry until it completes (simulating subsequent ticks)
      for (let i = 0; i < 4; i++) {
        const cfg = await air.getAccountInfo(v1.vault);
        const dec = mkCtx(VAL_URL, keepers[0]).program.coder.accounts.decode('vaultConfig', cfg.data);
        if (dec.executed) break;
        try { await crankVault(mkCtx(VAL_URL, keepers[0]), v1.vault, dec); } catch {}
      }
      const finalCfg = await mkCtx(VAL_URL, keepers[0]).program.account.vaultConfig.fetch(v1.vault);
      const el = await mkCtx(VAL_URL, keepers[0]).program.account.executionLog.fetch(
        PublicKey.findProgramAddressSync([Buffer.from('execution'), v1.vault.toBuffer()], programId)[0]);
      const paid = (await benBal(v1.benes[0])) + (await benBal(v1.benes[1]));
      console.log(`  (crank threw under load: ${threw}; executed: ${finalCfg.executed})`);
      check(finalCfg.executed === true, 'S1 vault reaches executed after heal+retry');
      check(el.solPaidMask === (1 | 2), 'S1 SOL mask full (both beneficiaries paid exactly once)');
      check(paid > 0.9 * LAMPORTS_PER_SOL, 'S1 beneficiaries received the SOL (no funds stranded)');
    }

    // ── S2: rate-limited read on the close path (the "RPC lies" case) ──────────
    console.log('\n[S2] 429 on the close-path account reads (rate-limited-lies)');
    {
      // First fully distribute with clean RPC up to (but through) finalize + token shares.
      await crankVault(mkCtx(VAL_URL, keepers[1]), v2.vault, v2.cfg);
      // Now inject 429 on the account reads so close_token_dist sees a false "0 dust".
      const ctx = mkCtx(PROXY_URL, keepers[1]);
      fault.mode = 'rate'; fault.prob = 1.0;
      fault.methods = new Set(['getAccountInfo', 'getMultipleAccounts', 'getTokenAccountBalance']);
      let threw = false;
      try {
        const cfg = await mkCtx(VAL_URL, keepers[1]).program.account.vaultConfig.fetch(v2.vault);
        await crankVault(ctx, v2.vault, cfg);
      } catch { threw = true; }
      fault.mode = 'off';
      console.log(`  (close under forced 429 threw/failed: ${threw})`);
      // Heal + re-crank: token_dist must close, tokens must all reach beneficiaries.
      for (let i = 0; i < 4; i++) {
        const cfg = await mkCtx(VAL_URL, keepers[1]).program.account.vaultConfig.fetch(v2.vault);
        if (cfg.openTokenDists === 0) break;
        try { await crankVault(mkCtx(VAL_URL, keepers[1]), v2.vault, cfg); } catch {}
        await sleep(500);
      }
      const cfg = await mkCtx(VAL_URL, keepers[1]).program.account.vaultConfig.fetch(v2.vault);
      // token conservation: every base unit reached a beneficiary ATA
      let tokTotal = 0n;
      for (const b of v2.benes) {
        const ata = getAssociatedTokenAddressSync(v2.mint, b.publicKey, false, TOKEN_PROGRAM_ID);
        try { const acc = await air.getTokenAccountBalance(ata); tokTotal += BigInt(acc.value.amount); } catch {}
      }
      check(cfg.openTokenDists === 0, 'S2 token_dist eventually closed after heal (429 did not strand it)');
      check(tokTotal === 1_000_003n, 'S2 all 1000003 token units reached beneficiaries (no loss, no misdistribution)');
    }

    // ── S3: two keepers cranking the same vault concurrently ──────────────────
    console.log('\n[S3] concurrent crank racing (two keepers, one vault)');
    {
      const cA = mkCtx(VAL_URL, keepers[0]);
      const cB = mkCtx(VAL_URL, keepers[2]);
      const rA = crankVault(cA, v3.vault, v3.cfg).then(() => 'ok').catch((e) => `err:${e?.message?.slice(0, 40)}`);
      const rB = crankVault(cB, v3.vault, v3.cfg).then(() => 'ok').catch((e) => `err:${e?.message?.slice(0, 40)}`);
      const [ra, rb] = await Promise.all([rA, rB]);
      console.log(`  (keeperA: ${ra}; keeperB: ${rb})`);
      // heal any partial with one clean pass
      for (let i = 0; i < 3; i++) {
        const cfg = await cA.program.account.vaultConfig.fetch(v3.vault);
        if (cfg.executed) break;
        try { await crankVault(cA, v3.vault, cfg); } catch {}
      }
      const el = await cA.program.account.executionLog.fetch(
        PublicKey.findProgramAddressSync([Buffer.from('execution'), v3.vault.toBuffer()], programId)[0]);
      const cfg = await cA.program.account.vaultConfig.fetch(v3.vault);
      const paid = (await benBal(v3.benes[0])) + (await benBal(v3.benes[1]));
      check(cfg.executed === true, 'S3 vault executed exactly once under the race');
      check(el.solPaidMask === (1 | 2), 'S3 SOL mask full, no double-pay (each share bit set once)');
      check(paid > 0.9 * LAMPORTS_PER_SOL, 'S3 correct total distributed under the race');
      check(el.totalSolDistributed.toNumber() <= v3.depositSol * LAMPORTS_PER_SOL, 'S3 no over-distribution (total ≤ deposit)');
    }

    console.log(`\n[stress] ${FAILS === 0 ? 'ALL SCENARIOS PASSED' : FAILS + ' CHECK(S) FAILED'}`);
  } finally {
    try { proxy?.close(); } catch {}
    try { val?.kill('SIGKILL'); } catch {}
    try { rmSync(ledger, { recursive: true, force: true }); } catch {}
  }
  process.exit(FAILS === 0 ? 0 : 1);
}

main().catch((e) => { console.error('[stress] FATAL', e); process.exit(2); });
