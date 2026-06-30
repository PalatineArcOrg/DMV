import express from 'express';
import { PublicKey } from '@solana/web3.js';
import { config } from './config.js';
import {
  upsertRegistration,
  deleteRegistration,
  deleteRegistrationsByOwner,
  countRegistrations,
} from './db.js';
import { fcmReady } from './fcm.js';
import { startPoller, pollOnce } from './poller.js';
import { executorReady, crankerPubkey, runExecutor } from './executor.js';

const app = express();
app.use(express.json({ limit: '16kb' }));

function isPubkey(s) {
  try {
    // eslint-disable-next-line no-new
    new PublicKey(s);
    return true;
  } catch {
    return false;
  }
}

// Shared-secret gate for write endpoints (the app sends the same secret).
function requireSecret(req, res, next) {
  if (!config.registerSecret) return next(); // unset = open (dev only)
  if (req.get('x-dmv-secret') === config.registerSecret) return next();
  return res.status(401).json({ error: 'unauthorized' });
}

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    fcmConfigured: fcmReady(),
    executorReady: executorReady(),
    cranker: crankerPubkey(),
    registrations: countRegistrations(),
    rpc: config.rpcUrl,
    programId: config.programId,
  });
});

app.post('/register', requireSecret, (req, res) => {
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
  const r = await pollOnce();
  res.json({ ok: true, ...r });
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
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.listen(config.port, '127.0.0.1', () => {
  // eslint-disable-next-line no-console
  console.log(`dmv-notify-server listening on 127.0.0.1:${config.port} (fcm ${fcmReady() ? 'ready' : 'NOT configured'})`);
  startPoller();
});
