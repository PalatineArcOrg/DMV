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

## What one tick does

1. `program.account.vaultConfig.all()` — discriminator-filtered scan of every vault.
2. For each **active, un-executed** vault: read its heartbeat, compute
   `deadline = last_heartbeat + interval + grace`; if passed, run the full crank
   (begin → token snapshots → specific bequests → SOL shares → **finalize (bounty
   → you)** → token residuals → close token dists).
3. For each **executed** vault: attempt `close_executed_vault` — succeeds only
   after the 24 h window, paying the core-PDA rents to you.
