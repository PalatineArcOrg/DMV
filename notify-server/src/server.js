import express from 'express';
import { PublicKey } from '@solana/web3.js';
import { config, isDev, assertSecureConfig, assertRegistrationAuthConfig, resolveAuthMode } from './config.js';
import {
  deleteLegacyRegistrationsByOwner,
  countRegistrations,
  allRegistrations,
  pruneNonces,
  getRegistration,
  applySignedRegistration,
  applySignedDeregistration,
  applyLegacyRegistration,
  deleteLegacyRegistration,
} from './db.js';
import { probeFcm, setFcmObserver, tokFingerprint } from './fcm.js';
import { startPoller, pollOnce } from './poller.js';
import { executorReady, crankerPubkey, runExecutor, executorStaticConfig, checkExecutorRuntime } from './executor.js';
import { readVaultState, verifyVaultForOwner, getConnection, classifyNetwork, checkProgram } from './solana.js';
import { SIG_WINDOW_SEC } from './registerAuth.js';
import { authorizeRegisterV2, authorizeDeregisterV2, makeOwnershipVerifier } from './registerAuthV2.js';
import { sha256Hex } from './authMessage.js';
import { makeRegistrationHandlers } from './registrationRoutes.js';
import { makeLegacySecretCheck, makeAdminGate } from './secretGate.js';
import { makeWriteRateLimiter } from './writeRateLimiter.js';
import { readiness, NET, HEALTH, nextBackoff, bootDecision } from './readiness.js';
import { makeExecuteNowHandler, makePollNowHandler } from './routes.js';
import { installFatalGuards, sanitize } from './fatalGuards.js';

const app = express();
app.disable('x-powered-by');
// Caddy runs on loopback and sets X-Forwarded-For; trust it so req.ip is the
// real client (used by the rate limiter) rather than 127.0.0.1.
app.set('trust proxy', 'loopback');
app.use(express.json({ limit: '16kb' }));

// Serve NFT metadata JSON (devnet test collectibles) at /nft/<id>.json.
app.use('/nft', express.static('/root/DMV/notify-server/nft-metadata'));

// ── Per-IP fixed-window rate limiter (no external deps) for public reads ──
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 60; // requests per IP per window
const rateBuckets = new Map(); // ip -> { count, resetAt }
function rateLimit(req, res, next) {
  const now = Date.now();
  const ip = req.ip || 'unknown';
  let b = rateBuckets.get(ip);
  if (!b || now >= b.resetAt) {
    b = { count: 0, resetAt: now + RATE_WINDOW_MS };
    rateBuckets.set(ip, b);
  }
  b.count += 1;
  if (b.count > RATE_MAX) {
    res.set('retry-after', String(Math.ceil((b.resetAt - now) / 1000)));
    return res.status(429).json({ error: 'rate limited' });
  }
  return next();
}

// ── Short-TTL cache for on-chain vault reads: collapses the /inheritances RPC
// fan-out so repeated calls reuse recent reads instead of amplifying to N RPCs.
const VAULT_CACHE_TTL_MS = 10_000;
const vaultCache = new Map(); // vault -> { at, state }
async function readVaultStateCached(vault) {
  const now = Date.now();
  const hit = vaultCache.get(vault);
  if (hit && now - hit.at < VAULT_CACHE_TTL_MS) return hit.state;
  const state = await readVaultState(vault);
  vaultCache.set(vault, { at: now, state });
  return state;
}

// Bound the work a single /inheritances request can do.
const MAX_INHERITANCE_SCAN = 2000;

// Opportunistic cleanup so neither map grows unbounded.
setInterval(() => {
  const now = Date.now();
  for (const [ip, b] of rateBuckets) if (now >= b.resetAt) rateBuckets.delete(ip);
  for (const [k, v] of vaultCache) if (now - v.at >= VAULT_CACHE_TTL_MS) vaultCache.delete(k);
  // Used nonces older than 2× the signature window can be dropped — a replay that
  // old is already rejected by the timestamp check.
  try {
    pruneNonces(Math.floor(now / 1000) - 2 * SIG_WINDOW_SEC);
  } catch {
    /* non-fatal */
  }
}, RATE_WINDOW_MS).unref();

function isPubkey(s) {
  try {
    // eslint-disable-next-line no-new
    new PublicKey(s);
    return true;
  } catch {
    return false;
  }
}

// Real client IP for the write/admin rate limiters. Behind Cloudflare
// CF-Connecting-IP is the true client; otherwise Caddy's X-Forwarded-For →
// req.ip (trust proxy = loopback). Same policy as the /rpc limiter.
function clientIp(req) {
  return req.headers['cf-connecting-ip'] || req.ip || 'unknown';
}

// ── Fail-closed STATIC config gates (before any route/handler is constructed) ──
// STATIC config faults are fatal (exit non-zero so systemd Restart=on-failure
// surfaces them). Order: base secure config → static executor config → the
// registration-auth matrix. A pre-existing static fault therefore surfaces first.
try {
  assertSecureConfig();
} catch (e) {
  console.error(`[boot] ${sanitize(e?.message || e)}`);
  process.exit(1);
}
const execStatic = executorStaticConfig();
if (execStatic.fatal) {
  console.error(`[boot] FATAL executor config: ${execStatic.reason}`);
  process.exit(1);
}
let authMode;
try {
  assertRegistrationAuthConfig();
  authMode = resolveAuthMode();
} catch (e) {
  console.error(`[boot] ${sanitize(e?.message || e)}`);
  process.exit(1);
}

// Write-endpoint rate limiter (register/deregister/admin). Separate from the
// public-read + RPC limiters. Clock-injected so it is unit-testable.
const writeLimiter = makeWriteRateLimiter({ now: () => Date.now() });

// Transient-aware ownership verifier for the SIGNED path — classifies an RPC
// transport failure as retryable (dependency_unavailable), never a definitive 403.
// (The V1 verifyVaultForOwner conflates the two; it is used ONLY by the legacy path.)
const ownershipVerifier = makeOwnershipVerifier(
  (vault) => getConnection().getAccountInfo(new PublicKey(vault)),
  { programId: config.programId },
);

const registrationHandlers = makeRegistrationHandlers({
  mode: authMode,
  expected: { cluster: config.expectedCluster, programId: config.programId, audience: config.expectedAudience },
  authorizeRegisterV2,
  authorizeDeregisterV2,
  verifyOwnership: ownershipVerifier,
  getRegistration,
  applySignedRegistration,
  applySignedDeregistration,
  applyLegacyRegistration,
  deleteLegacyRegistration,
  deleteLegacyRegistrationsByOwner,
  legacyOwnerVerify: verifyVaultForOwner,
  legacySecretOk: makeLegacySecretCheck(config.registerSecret),
  limiter: writeLimiter,
  clientIp,
  now: () => Math.floor(Date.now() / 1000),
  logger: console,
  tokFingerprint,
  sha256Hex,
  isPubkey,
});

// Admin gate for the operational routes — a DEDICATED admin secret + header,
// separate from legacy registration auth.
const adminGate = makeAdminGate({ adminSecret: config.adminSecret, isDev, limiter: writeLimiter, clientIp });

// Readiness/health: READY | DEGRADED | NOT_READY with per-domain booleans, machine-readable reason
// codes, verification timestamps and the cranker balance — but NO secrets, keypairs, or RPC URL.
// 503 only when NOT_READY (listener down or a confirmed cluster MISMATCH); DEGRADED still serves 200.
app.get('/health', (req, res) => {
  const snap = readiness.snapshot();
  res.status(snap.status === HEALTH.NOT_READY ? 503 : 200).json({
    ...snap,
    cranker: crankerPubkey(),
    registrations: countRegistrations(),
    programId: config.programId,
    cluster: config.expectedCluster,
    registrationAuthMode: authMode,
    // NB: the RPC URL / secrets are intentionally NOT exposed here — /health is public via Caddy.
  });
});

// Public discovery: vaults (among those registered here) where `wallet` is a
// beneficiary. Read-only, derived from on-chain state — grants no authority.
// Powers the app's "Inheritances" screen / claim button.
app.get('/inheritances', rateLimit, async (req, res) => {
  const wallet = req.query.wallet;
  if (!isPubkey(wallet)) return res.status(400).json({ error: 'valid wallet required' });
  const now = Math.floor(Date.now() / 1000);
  const out = [];
  const regs = allRegistrations();
  const truncated = regs.length > MAX_INHERITANCE_SCAN;
  const scan = truncated ? regs.slice(0, MAX_INHERITANCE_SCAN) : regs;
  for (const reg of scan) {
    let state;
    try {
      state = await readVaultStateCached(reg.vault); // short-TTL cache: no per-request RPC fan-out amplification
    } catch {
      continue; // skip unreadable vaults rather than fail the whole list
    }
    if (!state.exists || !state.config) continue;
    const benef = (state.config.beneficiaries || []).find((b) => b.wallet === wallet);
    if (!benef) continue;

    const { owner, interval, grace, executed } = state.config;
    let deadline = null;
    let status = 'active';
    if (executed) {
      status = 'executed';
    } else if (state.lastHeartbeat) {
      deadline = state.lastHeartbeat + interval + grace;
      const overdue = now - (state.lastHeartbeat + interval);
      if (now >= deadline) status = 'claimable';
      else if (overdue > 0) status = 'warning';
      else status = 'active';
    }
    out.push({
      vault: reg.vault,
      owner,
      shareBps: benef.shareBps,
      status, // active | warning | claimable | executed
      deadline, // unix ts grace elapses (null if no heartbeat yet)
      secondsToDeadline: deadline ? Math.max(0, deadline - now) : null,
    });
  }
  res.json({ wallet, inheritances: out, ...(truncated ? { truncated: true, scanned: scan.length } : {}) });
});

// Registration routes (WP3). The handler does classification + auth-mode routing +
// rate limiting internally: a signed request (any V2 envelope field) always takes
// the owner-signed V2 path and never falls back to legacy; a pure legacy request
// takes the unsigned x-dmv-secret + on-chain ownership-proof path (dual/legacy
// modes) or is rejected (signed mode). Signed rows are immutable via the legacy
// path (stickiness). See registrationRoutes.js / registerAuthV2.js.
app.post('/register', registrationHandlers.register);
app.post('/deregister', registrationHandlers.deregister);

// Manual trigger for testing. Refuses unless the network is positively VERIFIED.
app.post('/poll-now', adminGate, makePollNowHandler({ readiness, pollOnce }));

// Manually crank a single vault's execution (testing the autonomous path). The handler passes the
// executor a LIVE fail-closed guard (canSubmit = () => readiness.executorReady), re-checked before
// every submission — a low-balance / program-unreadable / degraded / MISMATCH executor is suppressed
// mid-crank, not just at the entry gate.
app.post(
  '/execute-now',
  adminGate,
  makeExecuteNowHandler({
    readiness,
    executorReady,
    runExecutor,
    isPubkey,
    logError: (vault, e) => console.error(`[execute-now] ${vault.slice(0, 8)} failed: ${sanitize(e?.message ?? e)}`),
  }),
);

// Debug push (DEV ONLY): send one test push to a token. Deliberately NOT mounted
// in production — an arbitrary title/body push to any FCM token is a phishing
// primitive that must not exist on a mainnet deployment.
if (isDev) {
  app.post('/debug/push', adminGate, async (req, res) => {
    const { token, title, body, channel } = req.body || {};
    if (typeof token !== 'string' || token.length < 20) {
      return res.status(400).json({ error: 'valid token required' });
    }
    try {
      const { sendPush } = await import('./fcm.js');
      const r = await sendPush(token, {
        title: title || 'DMV test',
        body: body || 'If you see this once, FCM delivery works.',
        channel: channel || 'escalation',
      });
      res.json(r);
    } catch {
      res.status(500).json({ ok: false, error: 'push failed' });
    }
  });
}

// ── RPC proxy (rate-limited) ─────────────────────────────────────────────────
// The web claim portal / owner console POST JSON-RPC here so the Helius key stays
// server-side (never shipped in the browser bundle). Dedicated per-IP window —
// RPC is far chattier than /inheritances, so it gets its own, higher limit. The
// WebSocket confirmation subscription web3.js opens on /rpc is proxied separately
// by Caddy → Helius (see Caddyfile) and never reaches this handler.
const RPC_WINDOW_MS = 10_000;
const RPC_MAX = 150; // requests per IP per 10s (~15 rps sustained — ample for one user, caps abuse)
const rpcBuckets = new Map(); // ip -> { count, resetAt }
function rpcRateLimit(req, res, next) {
  const now = Date.now();
  // Behind Cloudflare, req.ip (from X-Forwarded-For) is the CF edge IP shared by
  // many users — CF-Connecting-IP is the real client. Fall back to req.ip.
  const ip = req.headers['cf-connecting-ip'] || req.ip || 'unknown';
  if (rpcBuckets.size > 10_000) {
    for (const [k, v] of rpcBuckets) if (now >= v.resetAt) rpcBuckets.delete(k); // bound memory
  }
  let b = rpcBuckets.get(ip);
  if (!b || now >= b.resetAt) {
    b = { count: 0, resetAt: now + RPC_WINDOW_MS };
    rpcBuckets.set(ip, b);
  }
  b.count += 1;
  if (b.count > RPC_MAX) {
    res.set('retry-after', String(Math.ceil((b.resetAt - now) / 1000)));
    return res.status(429).json({ jsonrpc: '2.0', id: null, error: { code: 429, message: 'rate limited' } });
  }
  return next();
}

const RPC_ALLOWED_ORIGIN = process.env.RPC_ALLOWED_ORIGIN || 'https://dmvapp.palatinearc.com';
function rpcCors(req, res, next) {
  res.set('Access-Control-Allow-Origin', RPC_ALLOWED_ORIGIN);
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', '*'); // web3.js adds a `solana-client` header
  res.set('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') return res.status(204).end();
  return next();
}
app.options('/rpc', rpcCors);
app.post('/rpc', rpcCors, rpcRateLimit, async (req, res) => {
  try {
    const upstream = await fetch(config.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(req.body ?? {}),
    });
    const text = await upstream.text();
    res.status(upstream.status).type('application/json').send(text);
  } catch {
    res.status(502).json({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'rpc upstream error' } });
  }
});

// Expected RPC / executor / poller / route errors are caught at their LOCAL boundaries (the poller
// tick + per-vault try/catch, runExecutor's callers, and each route's try/catch) so they never reach
// here. Anything that DOES reach here is a genuine uncaught fault — process state may be inconsistent,
// so fail CLOSED: redacted fatal log + exit non-zero (systemd restarts with fresh state) rather than
// serving/transacting on from a corrupt state. Shared with the fatal-handler tests.
installFatalGuards({ label: 'notify' });

// ── Readiness orchestration (Phase 2) ────────────────────────────────────────
// Refresh the dependency-derived domains (FCM, program readability → pollerReady, executor). Called
// at boot when VERIFIED and on every monitor tick. Best-effort; never throws. An executor problem
// only flips executorReady — it never touches escalationReady (= fcm && network && poller).
async function refreshDependentReadiness() {
  // FCM: probe the ACTUAL push transport (token acquisition), not merely credential presence. probeFcm
  // updates fcm.js's authoritative state, which is mirrored into the readiness singleton by the
  // observer wired at boot — so no explicit readiness.setFcm here (single writer, no drift).
  await probeFcm();

  // The program check updates the `program` DIAGNOSTIC and the mandatory programReady health domain
  // (setProgram). It must NOT touch pollerReady — that is
  // driven SOLELY by actual poll-cycle read outcomes (recordPollResult), so a monitor refresh can
  // never restore pollerReady right after failed polls demoted it.
  const prog = await checkProgram();
  readiness.setProgram(prog);
  if (prog.ok === false) {
    console.error(`[net] CRITICAL program check failed (${prog.reason}) — executor disabled.`);
  }

  const exec = await checkExecutorRuntime();
  readiness.setExecutor(exec);
  if (!exec.ready && !exec.disabled && !exec.transient) {
    console.warn(`[exec] not ready: ${exec.reason}${exec.balanceSol != null ? ` (balance ${exec.balanceSol} SOL)` : ''}`);
  } else if (exec.ready && exec.low) {
    console.warn(`[exec] cranker balance low: ${exec.balanceSol} SOL (warn threshold)`);
  }
}

// Background monitor. UNKNOWN → bounded-backoff retry (poller/executor stay OFF); VERIFIED →
// refresh + normal cadence; a runtime MISMATCH disables transaction producers + raises a critical
// alert and NEVER switches endpoint/cluster.
let monitorTimer = null;
const MONITOR_MS = Math.min(config.pollIntervalMs, 30_000);
function scheduleMonitor(ms) {
  if (monitorTimer) clearTimeout(monitorTimer);
  monitorTimer = setTimeout(monitorTick, ms);
  monitorTimer.unref?.();
}
async function monitorTick() {
  let cadence = MONITOR_MS;
  try {
    const net = await classifyNetwork();
    const prev = readiness.net.state;
    readiness.applyNet(net, Date.now());
    if (net.state === NET.UNKNOWN) {
      readiness.backoffAttempt += 1;
      cadence = nextBackoff(readiness.backoffAttempt, { baseMs: 1000, maxMs: 60_000 });
      if (prev !== NET.UNKNOWN) {
        console.warn(`[net] UNKNOWN (${net.reason}) — DEGRADED; poller/executor disabled, backing off`);
      }
    } else if (net.state === NET.MISMATCH) {
      if (prev !== NET.MISMATCH) {
        console.error(
          `[net] CRITICAL runtime genesis MISMATCH (expected ${net.expectedGenesisHash}, RPC served ` +
            `${net.receivedGenesisHash}) — transaction producers DISABLED. NOT switching endpoint.`,
        );
      }
    } else {
      await refreshDependentReadiness();
    }
  } catch (e) {
    // The monitored helpers are all expected NOT to throw (they classify/degrade internally). An
    // exception here is therefore an UNEXPECTED fault — do not swallow it and keep scheduling monitor
    // ticks on stale readiness; rethrow so the installed fatal guards exit the process fail-closed
    // (systemd Restart=on-failure then brings it back on a clean slate).
    console.error('[net] monitor tick error:', sanitize(e?.message || e));
    throw e;
  }
  scheduleMonitor(cadence);
}

// ── Fail-closed boot (network) ───────────────────────────────────────────────
// The STATIC config gates (assertSecureConfig, static executor config, and the
// registration-auth matrix) already ran fail-closed at the top of this module,
// before any handler was constructed. A positive genesis MISMATCH at boot is
// fatal; a transient UNKNOWN network is NOT fatal → boot DEGRADED and let the
// monitor recover WITHOUT a restart. The boot classify runs inside a guard so a
// top-level-await throw can't be swallowed by the uncaughtException handler above.
readiness.fcmWaived = config.allowNoFcm;
readiness.executorWaived = !config.executorEnabled || config.allowNoExecutor;

// Single authoritative FCM state: mirror every fcm.js state change (probe OR real send outcome) into
// the /health readiness singleton synchronously, so a send failure between monitor ticks demotes
// /health immediately (no two-states-disagree window). Wired before the first probeFcm below.
setFcmObserver((ready, reason) => readiness.setFcm(ready, reason));

try {
  const net = await classifyNetwork();
  const decision = bootDecision(net.state);
  if (decision === 'exit') {
    console.error(
      `[boot] CRITICAL genesis MISMATCH: expected ${net.expectedGenesisHash}, RPC served ` +
        `${net.receivedGenesisHash} for cluster "${config.expectedCluster}". Refusing to start.`,
    );
    process.exit(1);
  }
  readiness.applyNet(net, Date.now());
  if (decision === 'proceed') {
    await refreshDependentReadiness();
  } else {
    console.warn(`[boot] network UNKNOWN (${net.reason}) — starting DEGRADED; poller/executor disabled until VERIFIED.`);
  }
} catch (e) {
  // Classification itself never throws; this guards an unexpected error so it can't exit 0.
  console.error(`[boot] ${sanitize(e?.message || e)}`);
  process.exit(1);
}

readiness.apiReady = true;
app.listen(config.port, '127.0.0.1', () => {
  // eslint-disable-next-line no-console
  console.log(
    `dmv-notify-server on 127.0.0.1:${config.port} — status ${readiness.health()} ` +
      `(net ${readiness.net.state}, fcm ${readiness.fcmReady ? 'ready' : 'down'}, ` +
      `exec ${readiness.executorReady ? 'ready' : readiness.executorWaived ? 'waived' : 'off'})`,
  );
  scheduleMonitor(MONITOR_MS);
  startPoller();
});
