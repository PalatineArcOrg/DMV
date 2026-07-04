import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { config, isDev, assertSecureConfig } from './config.js';
import {
  upsertRegistration,
  deleteRegistration,
  deleteRegistrationsByOwner,
  countRegistrations,
  allRegistrations,
  claimNonce,
  pruneNonces,
} from './db.js';
import { fcmReady } from './fcm.js';
import { startPoller, pollOnce } from './poller.js';
import { executorReady, crankerPubkey, runExecutor } from './executor.js';
import { readVaultState, verifyVaultForOwner } from './solana.js';
import { validateRegister, validateDeregister, SIG_WINDOW_SEC } from './registerAuth.js';

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

// Strip any api-key from an RPC URL before exposing it (/health is public via Caddy).
function maskRpc(url) {
  try {
    const u = new URL(url);
    if (u.searchParams.has('api-key')) u.searchParams.set('api-key', '***');
    return u.origin + u.pathname + (u.search ? u.search : '');
  } catch {
    return String(url).replace(/api-key=[^&]+/i, 'api-key=***');
  }
}

function isPubkey(s) {
  try {
    // eslint-disable-next-line no-new
    new PublicKey(s);
    return true;
  } catch {
    return false;
  }
}

// Dependencies passed to the owner-signed register/deregister validators.
const authDeps = {
  verifyVaultForOwner,
  claimNonce,
  now: () => Math.floor(Date.now() / 1000),
};

// Constant-time comparison of the shared secret to avoid a timing side-channel.
function secretMatches(provided) {
  if (typeof provided !== 'string' || provided.length !== config.registerSecret.length) {
    return false;
  }
  try {
    return timingSafeEqual(Buffer.from(provided), Buffer.from(config.registerSecret));
  } catch {
    return false;
  }
}

// Shared-secret gate for write endpoints (the app sends the same secret).
// Fail-closed: with no secret configured, only an explicit dev build is allowed
// through — production refuses to boot without one (see assertSecureConfig), so
// the 503 branch is defense-in-depth that should never be reached in prod.
// NOTE: the shared secret is shipped inside the app bundle (EXPO_PUBLIC_*), so it
// is extractable and provides weak authenticity only. Sensitive state changes
// (registration) are additionally ownership-proofed on-chain in /register, and
// deregister/token-rebinding should move to an owner-wallet signature (follow-up).
function requireSecret(req, res, next) {
  if (!config.registerSecret) {
    if (isDev) return next();
    return res.status(503).json({ error: 'server misconfigured' });
  }
  if (secretMatches(req.get('x-dmv-secret'))) return next();
  return res.status(401).json({ error: 'unauthorized' });
}

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    fcmConfigured: fcmReady(),
    executorReady: executorReady(),
    cranker: crankerPubkey(),
    registrations: countRegistrations(),
    rpc: maskRpc(config.rpcUrl),
    programId: config.programId,
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

// NOTE: unsigned registration is the ACTIVE path — integrity comes from the
// on-chain OWNERSHIP PROOF below (verifyVaultForOwner). It must stay matched with
// the app, which sends unsigned. The owner-SIGNED validators (validateRegister/
// validateDeregister in registerAuth.js) are kept DORMANT for mainnet: switching
// to them requires the app to sign on register too — deploy the two together,
// with a transition window that accepts both. See PushRegistrationService in the
// app for the activation checklist.
app.post('/register', requireSecret, async (req, res) => {
  const { owner, vault, deviceToken, stage1, stage2, stage3 } = req.body || {};
  if (!isPubkey(owner) || !isPubkey(vault)) {
    return res.status(400).json({ error: 'invalid owner/vault pubkey' });
  }
  if (typeof deviceToken !== 'string' || deviceToken.length < 10) {
    return res.status(400).json({ error: 'invalid deviceToken' });
  }
  const s1 = Number(stage1), s2 = Number(stage2), s3 = Number(stage3);
  if (![s1, s2, s3].every((n) => Number.isFinite(n) && n > 0)) {
    return res.status(400).json({ error: 'invalid stage durations' });
  }

  // Ownership proof: `vault` must be the canonical PDA for `owner` and a real
  // on-chain DMV VaultConfig whose stored owner matches. Blocks garbage/mismatched
  // registrations and fake-vault injection into /inheritances. (Residual gap: does
  // not prove the CALLER holds the owner key — that's what the dormant signed path
  // adds for mainnet.)
  let verdict;
  try {
    verdict = await verifyVaultForOwner(owner, vault);
  } catch {
    return res.status(502).json({ error: 'vault verification unavailable' });
  }
  if (!verdict.ok) {
    return res.status(403).json({ error: `vault verification failed: ${verdict.reason}` });
  }

  upsertRegistration({ owner, vault, deviceToken, stage1: s1, stage2: s2, stage3: s3 });
  console.log(`[register] vault ${vault.slice(0, 8)} owner ${owner.slice(0, 8)} token ${deviceToken.slice(0, 12)}… stages ${s1}/${s2}/${s3}`);
  res.json({ ok: true });
});

app.post('/deregister', requireSecret, (req, res) => {
  const { vault, owner } = req.body || {};
  let removed = 0;
  if (vault && isPubkey(vault)) removed += deleteRegistration(vault);
  else if (owner && isPubkey(owner)) removed += deleteRegistrationsByOwner(owner);
  else return res.status(400).json({ error: 'vault or owner required' });
  res.json({ ok: true, removed });
});

// Manual trigger for testing.
app.post('/poll-now', requireSecret, async (req, res) => {
  try {
    const r = await pollOnce();
    res.json({ ok: true, ...r });
  } catch {
    res.status(500).json({ ok: false, error: 'poll failed' });
  }
});

// Manually crank a single vault's execution (testing the autonomous path).
app.post('/execute-now', requireSecret, async (req, res) => {
  const { vault } = req.body || {};
  if (!isPubkey(vault)) return res.status(400).json({ error: 'invalid vault pubkey' });
  if (!executorReady()) return res.status(503).json({ error: 'executor not configured' });
  try {
    const r = await runExecutor(vault);
    res.json({ ok: true, ...r });
  } catch (e) {
    // Do NOT echo the raw error: web3/Anchor messages can embed the RPC URL
    // (which carries the Helius api-key). Log it server-side, return generic.
    console.error(`[execute-now] ${vault.slice(0, 8)} failed: ${e.message}`);
    res.status(500).json({ ok: false, error: 'execution failed' });
  }
});

// Debug push (DEV ONLY): send one test push to a token. Deliberately NOT mounted
// in production — an arbitrary title/body push to any FCM token is a phishing
// primitive that must not exist on a mainnet deployment.
if (isDev) {
  app.post('/debug/push', requireSecret, async (req, res) => {
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

// Last-resort guards: a stray rejection/exception must not take down the daemon
// — that would silently halt BOTH escalation alerts and the autonomous switch.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason instanceof Error ? reason.message : reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err?.message || err);
});

assertSecureConfig(); // fail-closed: refuse to boot with open write endpoints in prod

app.listen(config.port, '127.0.0.1', () => {
  // eslint-disable-next-line no-console
  console.log(`dmv-notify-server listening on 127.0.0.1:${config.port} (fcm ${fcmReady() ? 'ready' : 'NOT configured'})`);
  startPoller();
});
