# DMV Keeper Bot

A standalone keeper for **Dead Man's Vault**. It scans the chain for vaults whose
grace period has elapsed, cranks the permissionless distribution, and collects the
on-chain rewards. Anyone can run one — no permission, no registration, no DMV
server. The more keepers exist, the stronger the guarantee that every vault fires.

## Why you get paid

| Reward | When | Amount |
|---|---|---|
| **Keeper bounty** | you land `finalize_execution` on a vault | vault-configured, default **0.005 SOL** |
| **Cleanup rents** | you close an executed vault after the 24 h owner-exclusive window (`close_executed_vault`) | the core-PDA rents, **~0.01–0.03 SOL** |
| TokenDist rents | you close fully-paid token distributions | ~0.002 SOL each |

Costs you front: transaction fees (~0.000005 each), the ExecutionLog rent
(~0.0015 SOL, recovered when you later close the vault), and beneficiary ATA rent
for token distributions when the recipient has no ATA yet.

## Why it's safe (for everyone)

Every instruction this bot sends is **permissionless and fund-safe by
construction**: the DMV program computes each payout from frozen on-chain state
(beneficiary whitelist, share basis points, bequest assignments, snapshots,
paid-bitmasks). A keeper cannot change recipients, amounts, or timing — it can
only *submit* the distribution and pay the fees. Racing another keeper (or the
owner's app, or the DMV server) is safe: on-chain bitmasks make every step
idempotent, first writer wins, the loser's transaction no-ops.

A living owner keeps priority on their own rent: `close_executed_vault` is
rejected (`CloseDelayNotElapsed`) until 24 h after execution began, and the bot's
early attempts fail preflight simulation without costing a fee.

## Run it

```bash
cd keeper-bot
npm install

# a funded keypair (devnet: solana-keygen new -o keeper.json && solana airdrop 2 <pubkey> -ud)
# keep ~0.1 SOL in it; rewards accumulate here
RPC_URL=https://api.devnet.solana.com \
KEYPAIR_PATH=./keeper.json \
node src/index.js            # poll loop (POLL_MS, default 30s)

# one pass and exit (cron-friendly)
RPC_URL=... KEYPAIR_PATH=... node src/index.js --once
```

Environment:

| Var | Required | Default | Notes |
|---|---|---|---|
| `RPC_URL` | yes | — | use a paid/reliable RPC (public devnet RPC rate-limits the scan) |
| `KEYPAIR_PATH` | yes | — | JSON keypair array; pays fees, receives rewards |
| `POLL_MS` | no | `30000` | scan interval |
| `CLOSE_EXECUTED` | no | `1` | `0` = **crank-only**: still distributes expired vaults, but never closes an executed vault to collect its rents (leaves them for the owner). Recommended on **devnet**, where the close window is only 60s and an always-on keeper would otherwise sweep an owner's own rent before they can reclaim it. Leave on (`1`) for mainnet, where the 24h window gives owners a fair shot and the rents are the keeper's incentive. |

Program ID (devnet): `GXCu5964mvgAJDWmcMriZpzU3vDVqPzjYCM1sxCnsoEb`
(baked into `idl/dead_mans_vault.json`; swap the IDL to target another deployment).

### systemd example

```ini
[Unit]
Description=DMV keeper bot
After=network-online.target

[Service]
WorkingDirectory=/opt/dmv-keeper-bot
Environment=RPC_URL=https://your-rpc
Environment=KEYPAIR_PATH=/opt/dmv-keeper-bot/keeper.json
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

## Balance monitor (optional)

A keeper only works while its wallet is funded — a drained keeper silently stops
cranking. `balance-monitor.mjs` is a tiny, dependency-light alarm: it reads one or
more wallet balances against a floor, prints a line each, **exits non-zero** when
any is low or unreachable, and (if a webhook is set) POSTs an alert. Run it on a
timer; ready-made `dmv-balance-monitor.{service,timer}` templates ship in this dir
(oneshot every 15 min).

```bash
MONITOR_WALLETS=keeper:<PUBKEY> \
MONITOR_FLOOR_SOL=0.05 \
MONITOR_RPC_URL=https://api.devnet.solana.com \
ALERT_WEBHOOK=https://discord.com/api/webhooks/... \
node balance-monitor.mjs
```

| Var | Default | Notes |
|---|---|---|
| `MONITOR_WALLETS` | the DMV devnet crankers | comma-separated `name:pubkey` pairs to watch |
| `MONITOR_FLOOR_SOL` | `0.05` | alert when a balance drops below this |
| `MONITOR_RPC_URL` | `RPC_URL`, else public devnet | one light `getBalance` per wallet |
| `ALERT_WEBHOOK` | — | Discord (`{content}`) or Slack (`{text}`) incoming webhook; unset = log only |

The webhook is a **secret** — set it via the environment (systemd `Environment=` in
a mode-600 unit, or an `EnvironmentFile`), never commit it to source.

## What one tick does

1. `program.account.vaultConfig.all()` — discriminator-filtered scan of every vault.
2. For each **active, un-executed** vault: read its heartbeat, compute
   `deadline = last_heartbeat + interval + grace`; if passed, run the full crank
   (begin → token snapshots → specific bequests → SOL shares → **finalize (bounty
   → you)** → token residuals → close token dists). For a **transfer-fee** Token-2022
   mint the close first harvests any withheld fees from the vault ATA to the mint
   (permissionless) — otherwise Token-2022 won't close the fee-holding account and the
   TokenDist sticks (`open_token_dists > 0`), blocking the vault close.
3. For each **executed** vault: attempt `close_executed_vault` — succeeds only
   after the 24 h window, paying the core-PDA rents to you.
