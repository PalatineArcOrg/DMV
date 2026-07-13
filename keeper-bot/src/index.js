// DMV keeper bot — scan the program for expired vaults and crank them.
//
// Fully standalone: point it at an RPC + a funded keypair and it discovers work
// on-chain (no registry, no API, no DMV server). Profitable by design:
//   - finalize_execution pays the vault's keeper bounty (default 0.005 SOL),
//   - close_executed_vault (24h after execution) pays the core-PDA rents
//     (~0.01–0.03 SOL) that would otherwise strand with a dead owner.
//
// Safety: every instruction is permissionless AND fund-safe — the program
// computes payouts from frozen on-chain state; a keeper can never redirect
// funds. Worst case racing another keeper: your tx no-ops and you lose a fee.
import { readFileSync } from 'node:fs';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { AnchorProvider, Program, Wallet } from '@coral-xyz/anchor';
import { crankVault, cleanupExecutedVault, heartbeatPda, classifyVaultError, isTransientScanError } from './crank.js';
import { GENESIS_HASHES, keeperReadiness, nextBackoff, validateKeeperKeypair, makeReadinessRevalidator, withTimeout } from './readiness.js';
import { installFatalGuards, sanitize } from './fatalGuards.js';
import { runLoop } from './loop.js';
import { runKeeperOnce } from './orchestrate.js';

// Treat an unset / empty / whitespace-only env value as "use the default": a copied .env.example with
// a bare `MIN_KEEPER_BALANCE_SOL=` must NOT silently become Number('') === 0 and disable the balance
// floor. `??` only catches undefined/null, so '' and '   ' would otherwise slip through to Number → 0.
// A present, non-blank value is parsed; the post-parse validation below still rejects non-finite /
// negative / out-of-range values (exit 1).
const numEnv = (name, def) => {
  const raw = process.env[name];
  return raw == null || String(raw).trim() === '' ? def : Number(String(raw).trim());
};

const RPC_URL = process.env.RPC_URL;
const KEYPAIR_PATH = process.env.KEYPAIR_PATH;
// Node's setTimeout delay is a signed 32-bit int: a value above 2^31-1 ms overflows and is silently
// reduced to ~1ms, turning a "poll rarely" config into a tight RPC loop. Cap every timer-driven interval
// at this bound (and floor at 1000ms).
const MAX_TIMER_MS = 2_147_483_647;
const POLL_MS = numEnv('POLL_MS', 30_000);
const ONCE = process.argv.includes('--once');
// Bound the two direct RPC reads in a tick (the vault scan, and the end-of-tick diagnostic balance) so a
// never-settling call can't wedge the scheduler: a hung scan degrades this tick + retries, and a hung
// balance lookup is best-effort (logged as '?'). Both < POLL_MS so a stuck tick still frees the loop.
const SCAN_TIMEOUT_MS = 20_000;
const BAL_TIMEOUT_MS = 8_000;
const HB_TIMEOUT_MS = 8_000; // per-vault heartbeat fetch bound: a hung fetch must not stall the tick loop
// Rent-claim close of executed vaults. On by default (the mainnet economic
// incentive). Set CLOSE_EXECUTED=0 for a CRANK-ONLY keeper: it still fires the
// switch (distributes expired vaults) but never closes an executed vault to
// collect the core-PDA rents — leaving those for the owner. Recommended on
// devnet, where the close window is only 60s and an always-on keeper would
// otherwise sweep an owner's own rent before they can reclaim it.
const CLOSE_EXECUTED = process.env.CLOSE_EXECUTED !== '0';
// The cluster this keeper expects; the readiness gate below verifies the RPC serves it (genesis).
const EXPECTED_CLUSTER = process.env.EXPECTED_CLUSTER || 'devnet';
// Operational balance thresholds (SOL). Below MIN → don't crank (degraded); below WARN → warn. The
// mainnet floor must not block the live devnet keeper (floats ~0.05–0.16 SOL), so devnet is lower.
const MIN_KEEPER_BALANCE_SOL = numEnv('MIN_KEEPER_BALANCE_SOL', EXPECTED_CLUSTER === 'mainnet-beta' ? 0.05 : 0.02);
const WARN_KEEPER_BALANCE_SOL = numEnv('WARN_KEEPER_BALANCE_SOL', EXPECTED_CLUSTER === 'mainnet-beta' ? 0.1 : 0.05);

if (!RPC_URL || !KEYPAIR_PATH) {
  console.error('Usage: RPC_URL=<url> KEYPAIR_PATH=<keypair.json> node src/index.js [--once]');
  process.exit(1);
}
// Fail-closed static-config validation (global misconfiguration → exit non-zero).
if (!GENESIS_HASHES[EXPECTED_CLUSTER]) {
  console.error(`[keeper] invalid EXPECTED_CLUSTER "${EXPECTED_CLUSTER}" — must be devnet or mainnet-beta`);
  process.exit(1);
}
try {
  const u = new URL(RPC_URL);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('not http(s)');
} catch {
  console.error(`[keeper] invalid RPC_URL — must be a valid http(s) URL`);
  process.exit(1);
}
if (!Number.isInteger(POLL_MS) || POLL_MS < 1000 || POLL_MS > MAX_TIMER_MS) {
  console.error(`[keeper] invalid POLL_MS "${process.env.POLL_MS}" — must be an integer in [1000, ${MAX_TIMER_MS}]ms`);
  process.exit(1);
}
for (const [name, v] of [['MIN_KEEPER_BALANCE_SOL', MIN_KEEPER_BALANCE_SOL], ['WARN_KEEPER_BALANCE_SOL', WARN_KEEPER_BALANCE_SOL]]) {
  // Validate the CONVERTED lamports (same as notify-server): a finite-but-huge SOL (e.g. 1e308) overflows
  // to an unsafe integer at `* 1e9`, and a tiny positive value (e.g. 1e-10) rounds to 0 lamports —
  // silently disabling the balance floor. Reject both here; an explicit 0 SOL (intentional opt-out) is ok.
  const lamports = Math.round(v * 1e9);
  if (!Number.isFinite(v) || v < 0 || !Number.isSafeInteger(lamports) || (v > 0 && lamports === 0)) {
    console.error(`[keeper] invalid ${name} (${v}) — must be 0 or a SOL value that converts to safe non-zero lamports`);
    process.exit(1);
  }
}
if (WARN_KEEPER_BALANCE_SOL < MIN_KEEPER_BALANCE_SOL) {
  console.error(`[keeper] WARN_KEEPER_BALANCE_SOL (${WARN_KEEPER_BALANCE_SOL}) must be >= MIN_KEEPER_BALANCE_SOL (${MIN_KEEPER_BALANCE_SOL})`);
  process.exit(1);
}

const idl = JSON.parse(readFileSync(new URL('../idl/dead_mans_vault.json', import.meta.url), 'utf8'));
// Missing/malformed keypair is a fatal static misconfig for the keeper (its ONLY job is cranking —
// no notification role to keep alive). Validate via the pure, unit-tested contract, then keep the
// loaded Keypair for signing.
let _loadedKeeper = null;
const _kpCheck = validateKeeperKeypair((p) => {
  const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, 'utf8'))));
  _loadedKeeper = kp;
  return { publicKey: kp.publicKey.toBase58() };
}, KEYPAIR_PATH);
if (_kpCheck.fatal) {
  console.error(`[keeper] FATAL keypair: ${_kpCheck.reason} (KEYPAIR_PATH="${KEYPAIR_PATH}"). Refusing to start.`);
  process.exit(1);
}
const keeper = _loadedKeeper;
const connection = new Connection(RPC_URL, 'confirmed');
const provider = new AnchorProvider(connection, new Wallet(keeper), { commitment: 'confirmed' });
const program = new Program(idl, provider);
const ctx = { connection, provider, program, keeper, rpcUrl: RPC_URL };
const MIN_LAMPORTS = Math.round(MIN_KEEPER_BALANCE_SOL * 1e9);
const WARN_LAMPORTS = Math.round(WARN_KEEPER_BALANCE_SOL * 1e9);
const expectedGenesis = GENESIS_HASHES[EXPECTED_CLUSTER];

// Fail-closed process guards. Expected RPC / balance / program / crank errors are caught at their
// LOCAL boundaries (the readiness gate + runOnce/tick/per-vault try-catch), so anything reaching here
// is a genuine uncaught fault → state may be inconsistent. STOP the scheduler and prevent any further
// transaction by exiting non-zero (systemd restarts with fresh state). Never crank on after an
// unknown fault. Shared with the fatal-handler tests.
installFatalGuards({ label: 'keeper' });

const short = (pk) => pk.toBase58().slice(0, 8);

// Live readiness for an in-flight crank (Phase 2). `revalidate()` is the ASYNC pre-submit guard the
// crank calls before EVERY transaction. Its `check` re-runs the FULL readiness gate — genesis +
// executable program + a funded balance at/above the minimum, all under bounded timeouts — so a long
// multi-tx crank (> TTL) that outlives a domain (cluster switched, program vanished, balance dropped
// below the floor) is suppressed before the next submission, not just between vaults. A fresh all-ok
// result is reused for REVALIDATE_TTL_MS so consecutive txs don't each pay three RPCs. Never throws
// (keeperReadiness classifies every RPC failure as degraded, so gate().ok is simply false).
const REVALIDATE_TTL_MS = 1500;
const revalidate = makeReadinessRevalidator({
  check: async () => (await gate()).ok === true, // gate() = keeperReadiness (genesis+program+balance, bounded)
  now: () => Date.now(),
  ttlMs: REVALIDATE_TTL_MS,
});

/**
 * Discriminator-filtered scan of every VaultConfig, decoding each account
 * individually. Anchor's `.all()` throws on the FIRST undecodable account —
 * and devnet still carries legacy-layout vaults from older program versions —
 * which would kill the whole tick. Undecodable accounts are skipped instead.
 */
async function scanVaults() {
  const filter = program.coder.accounts.memcmp('vaultConfig');
  const raw = await connection.getProgramAccounts(program.programId, {
    filters: [{ memcmp: { offset: filter.offset ?? 0, bytes: filter.bytes } }],
  });
  const vaults = [];
  for (const { pubkey, account } of raw) {
    try {
      vaults.push({
        publicKey: pubkey,
        account: program.coder.accounts.decode('vaultConfig', account.data),
      });
    } catch {
      // legacy/foreign layout — not a crankable vault
    }
  }
  return vaults;
}

/**
 * One scan+crank pass. Returns a STRUCTURED result so runOnce can classify it (a scan failure is NOT
 * a completed pass — it must degrade, not report success):
 *   { ok:false, scanFailed:true } — the scan RPC failed; nothing was read this tick.
 *   { ok:false, halted:true }     — readiness was revoked mid-tick; remaining vaults were skipped.
 *   { ok:true,  ... }             — a completed pass (0+ vaults cranked).
 */
async function tick() {
  const started = Date.now();
  // scanVaults is an RPC read — an outage OR a HANG here is an EXPECTED operational failure (skip this
  // tick, retry next), NOT a fatal bug. The withTimeout bound guarantees the tick RETURNS even if the
  // scan RPC never settles (otherwise the catch never runs and the degraded-backoff loop can't proceed).
  // Per-vault crank errors are caught in the loop below.
  let vaults;
  try {
    vaults = await withTimeout(scanVaults(), SCAN_TIMEOUT_MS, 'scan');
  } catch (e) {
    // A bounded scan timeout (TimeoutError) or a recognized OPERATIONAL RPC failure degrades this tick.
    // A programming/coder fault (TypeError/ReferenceError/etc.) is NOT transient — it must escape to the
    // process fatal guard (via runOnce → runLoop), not be masked as a skippable scan blip.
    if (!isTransientScanError(e)) throw e;
    console.log(`[keeper] scan failed (transient): ${sanitize(e?.message ?? e)}`);
    return { ok: false, scanFailed: true, reason: e?.name === 'TimeoutError' ? 'scan_timeout' : 'scan_failed' };
  }
  let due = 0, cleaned = 0, halted = false, deadlineHit = false;

  for (const { publicKey: vault, account: cfg } of vaults) {
    try {
      if (cfg.executed) {
        // Executed → optionally do the post-window rent-collecting close. When
        // CLOSE_EXECUTED is off (crank-only), leave the executed vault (and its
        // rents) for the owner. Its distribution already completed. An early
        // close attempt fails preflight (CloseDelayNotElapsed) at no cost.
        if (!CLOSE_EXECUTED) continue;
        if (!(await revalidate())) { halted = true; break; }
        const r = await cleanupExecutedVault(ctx, vault, cfg, { canSubmit: revalidate });
        if (r === 'closed') {
          cleaned++;
          console.log(`[keeper] closed ${short(vault)} — rents collected`);
        }
        continue;
      }
      if (!cfg.active) continue;

      // BOUND the per-vault heartbeat read: an unbounded fetch that never settles would leave the tick
      // pending forever (never reaching degraded backoff or the fatal guard). A TimeoutError here is
      // classified 'skip' by classifyVaultError (operational vault failure → retry next tick).
      const hb = await withTimeout(program.account.heartbeatRecord.fetch(heartbeatPda(program.programId, vault)), HB_TIMEOUT_MS, 'heartbeat');
      const deadline =
        hb.lastHeartbeat.toNumber() + cfg.heartbeatInterval.toNumber() + cfg.gracePeriod.toNumber();
      if (Math.floor(Date.now() / 1000) < deadline) continue;

      due++;
      // Live readiness re-check immediately before cranking this vault; the crank's async guard
      // (revalidate) re-checks the network before every individual submission too.
      if (!(await revalidate())) { halted = true; break; }
      console.log(`[keeper] cranking ${short(vault)} (deadline passed ${Math.floor(Date.now() / 1000) - deadline}s ago)`);
      const r = await crankVault(ctx, vault, cfg, { canSubmit: revalidate });
      console.log(`[keeper] ${short(vault)} -> ${r}`);
    } catch (e) {
      // A bounded-read TimeoutError — the per-vault heartbeat read OR a crankVault/cleanupExecutedVault
      // PASS deadline (its internal reads are all budget-bounded). A hung/slow dependency: DEGRADE the
      // whole tick + back off instead of grinding every remaining vault into the same wall (which would
      // cost ~one deadline each). The pass is cooperative — no in-flight submission was abandoned.
      if (e?.name === 'TimeoutError') {
        deadlineHit = true;
        console.log(`[keeper] ${short(vault)} pass deadline / RPC timeout — degrading tick`);
        break;
      }
      const decision = classifyVaultError(e);
      // Readiness revoked mid-crank → stop the tick (don't misreport success).
      if (decision === 'halt') { halted = true; break; }
      // UNKNOWN fault (programming error, invariant violation) → do NOT swallow as a stuck vault; let
      // it escape to the process fatal guard (fail closed → scheduler stops, systemd restarts clean).
      if (decision === 'fatal') throw e;
      // Expected operational failure (tx revert / RPC blip) → skip this vault, continue. Redacted.
      console.log(`[keeper] ${short(vault)} error: ${sanitize(e?.message ?? e)}`);
    }
  }
  // A pass deadline / RPC timeout mid-loop → report a degraded tick (scanFailed contract) so orchestrate
  // backs off, rather than a partial "ok" that hides a hung dependency.
  if (deadlineHit) return { ok: false, scanFailed: true, reason: 'pass_deadline', vaults: vaults.length, due, cleaned };

  let balStr = '?';
  try {
    // Best-effort diagnostic only — BOUND it so a hung balance RPC (never-settling promise) can't
    // prevent the tick from completing and freeing the scheduler loop.
    balStr = ((await withTimeout(connection.getBalance(keeper.publicKey), BAL_TIMEOUT_MS, 'balance')) / 1e9).toFixed(4);
  } catch {
    /* balance log is best-effort: a failed OR timed-out lookup just leaves '?' */
  }
  console.log(
    `[keeper] tick: ${vaults.length} vaults, ${due} due, ${cleaned} closed, ` +
      `balance ${balStr} SOL (${Date.now() - started}ms)${halted ? ' [HALTED: readiness revoked mid-tick]' : ''}`,
  );
  return { ok: !halted, scanFailed: false, vaults: vaults.length, due, cleaned, halted };
}

// Readiness gate, re-evaluated every tick: classify genesis + program + balance. A positive genesis
// MISMATCH or a definite program failure is FATAL (exit non-zero — the keeper IS the executor, so
// there is nothing to keep alive). A transient RPC blip (UNKNOWN) or a low balance is DEGRADED:
// DON'T crank, back off, retry — a transient outage must never cause a tight crash/restart loop.
// The keeper never cranks until the network is VERIFIED and the balance is at/above the minimum.
async function gate() {
  return keeperReadiness({
    getGenesisHash: () => connection.getGenesisHash(),
    expectedGenesis,
    getAccountInfo: (pk) => connection.getAccountInfo(new PublicKey(pk)),
    programId: program.programId.toBase58(),
    getBalance: () => connection.getBalance(keeper.publicKey),
    minLamports: MIN_LAMPORTS,
    warnLamports: WARN_LAMPORTS,
    requireExecutable: true,
    timeoutMs: 8000,
  });
}

console.log(
  `[keeper] ${keeper.publicKey.toBase58()} watching program ${program.programId.toBase58()} ` +
    `(${CLOSE_EXECUTED ? 'crank + rent-close' : 'CRANK-ONLY, no rent-close'}; cluster ${EXPECTED_CLUSTER}, min ${MIN_KEEPER_BALANCE_SOL} SOL)`,
);

let lastState = null;
// Thin wrapper over the pure orchestration (orchestrate.js): the scan-failure/halt → degraded → back
// off / exit-non-zero decision lives there and is unit-tested; here we only supply the real gate/tick
// and the logging + process.exit side effects.
function runOnce() {
  return runKeeperOnce({
    gate,
    tick,
    exit: (g) => {
      const detail = g.net ? ` (expected ${g.net.expectedGenesisHash}, RPC served ${g.net.receivedGenesisHash})` : '';
      console.error(`[keeper] CRITICAL ${g.reason}${detail} — refusing to crank. Exiting.`);
      process.exit(1);
    },
    // NB: no setLive here — the revalidator cache is seeded in onReady with the GENESIS-verify time
    // (g.genesisVerifiedAt), NOT gate-return time. A setLive(true) → markVerified() would re-stamp with
    // now() and reintroduce the stale-TTL bug, so it is intentionally omitted.
    onReady: (g) => {
      if (lastState !== 'ready') console.log(`[keeper] READY (balance ${g.balanceSol.toFixed(4)} SOL${g.low ? ', LOW' : ''}) — cranking`);
      lastState = 'ready';
      if (g.low) console.warn(`[keeper] balance low: ${g.balanceSol.toFixed(4)} SOL (warn threshold)`);
      // Seed the revalidator cache with the GENESIS-verify time (not gate-return time), so a slow
      // program/balance check can't make a stale genesis look fresh.
      revalidate.markVerified(g.genesisVerifiedAt);
    },
    onDegraded: (reason) => {
      if (lastState !== 'degraded') console.warn(`[keeper] DEGRADED (${reason}) — not cranking; retrying with bounded backoff`);
      lastState = 'degraded';
    },
  });
}

if (ONCE) {
  // Exit non-zero when the single pass did NOT complete a scan (degraded gate, scan failure, or a
  // mid-tick readiness revocation) so cron / CI treats "no work done" as a failure, not success.
  const ok = await runOnce();
  process.exit(ok ? 0 : 1);
} else {
  // NO blanket catch: runOnce converts EXPECTED operational failures into a boolean at its local
  // boundaries; any escaping exception is a genuine UNEXPECTED fault → the fail-closed process guard
  // (installFatalGuards) logs it redacted and exits 1. See src/loop.js.
  await runLoop({
    runOnce,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    pollMs: POLL_MS,
    nextBackoff,
  });
}
