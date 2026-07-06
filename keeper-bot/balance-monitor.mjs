#!/usr/bin/env node
// Cranker liveness monitor — mainnet-readiness §1.9.
//
// Reads the notify-server cranker + keeper-bot wallet balances against a floor.
// Prints a one-line status per wallet, exits non-zero when any is low or
// unreachable, and (if ALERT_WEBHOOK is set) POSTs a message. Channel-agnostic:
// the exit code drives cron/systemd; the webhook body carries BOTH {text}
// (Slack) and {content} (Discord) so either sink works without a code change.
//
// A drained cranker or an RPC outage = vaults never execute = beneficiaries
// never inherit. This is the alarm for that. Lives in keeper-bot only because
// keeper-bot already has @solana/web3.js (ESM resolution needs a local dep).
//
// Config (env):
//   MONITOR_RPC_URL  RPC to query          (default: RPC_URL, else public devnet)
//   MONITOR_FLOOR_SOL  low-balance floor    (default: 0.05)
//   MONITOR_WALLETS  "name:pubkey,..." override (default: the two devnet crankers)
//   ALERT_WEBHOOK    optional Slack/Discord webhook URL
//
// Usage:  node balance-monitor.mjs           (from /root/DMV/keeper-bot)

import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';

const RPC_URL =
  process.env.MONITOR_RPC_URL || process.env.RPC_URL || 'https://api.devnet.solana.com';
const FLOOR_SOL = Number(process.env.MONITOR_FLOOR_SOL || '0.05');
const ALERT_WEBHOOK = process.env.ALERT_WEBHOOK || '';

// Default watch list = the live devnet crankers. Override with MONITOR_WALLETS
// for mainnet ("notify-cranker:<pubkey>,keeper-bot:<pubkey>").
const DEFAULT_WALLETS = [
  { name: 'notify-cranker', pubkey: '9x7nyDZGStugRbaKwH7pTYWhBFzskFhc8HfapuMLJpkC' },
  { name: 'keeper-bot', pubkey: '3gYfPHrGkXNWty1YWEApkn9k6cML5cJVA5k2ax4mGmRn' },
];

function parseWallets() {
  const raw = process.env.MONITOR_WALLETS;
  if (!raw) return DEFAULT_WALLETS;
  return raw
    .split(',')
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const idx = pair.lastIndexOf(':');
      return { name: pair.slice(0, idx), pubkey: pair.slice(idx + 1) };
    });
}

async function main() {
  const conn = new Connection(RPC_URL, 'confirmed');
  const wallets = parseWallets();
  const results = [];

  for (const w of wallets) {
    try {
      const lamports = await conn.getBalance(new PublicKey(w.pubkey));
      const sol = lamports / LAMPORTS_PER_SOL;
      results.push({ ...w, sol, low: sol < FLOOR_SOL, error: null });
    } catch (e) {
      // Treat an unreachable RPC / bad pubkey as an alert condition, not a pass.
      results.push({ ...w, sol: null, low: true, error: String(e?.message || e) });
    }
  }

  const stamp = new Date().toISOString();
  for (const r of results) {
    const status = r.error
      ? `ERROR ${r.error}`
      : `${r.sol.toFixed(4)} SOL${r.low ? '  ** LOW **' : ''}`;
    console.log(`[${stamp}] ${r.name.padEnd(16)} ${r.pubkey}  ${status}`);
  }

  const alerts = results.filter((r) => r.low);
  if (alerts.length && ALERT_WEBHOOK) {
    const text = alerts
      .map((r) =>
        r.error
          ? `:warning: DMV cranker ${r.name} (${r.pubkey}) unreachable: ${r.error}`
          : `:warning: DMV cranker ${r.name} (${r.pubkey}) LOW: ${r.sol.toFixed(4)} SOL < ${FLOOR_SOL} floor`
      )
      .join('\n');
    try {
      await fetch(ALERT_WEBHOOK, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, content: text }),
      });
    } catch (e) {
      console.log(`[${stamp}] alert webhook POST failed: ${String(e?.message || e)}`);
    }
  }

  process.exit(alerts.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
