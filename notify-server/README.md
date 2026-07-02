# DMV Notify Server

A small, **keyless** Node service that watches Dead Man's Vault vaults on-chain and does two things:

1. **Push escalation alerts** — sends FCM notifications as a vault escalates through its stages, so a killed/uninstalled app can't silence the warnings. As of app v1.7.3 this is the **single source** of escalation notifications: the app no longer schedules a local OS timeline (it double-fired with the server), so every stage produces exactly one push.
2. **Autonomously execute distribution** — once a vault's grace period elapses, it runs the permissionless execution crank to distribute the vault's assets **with no app and no owner action required**. This is what makes the dead-man's switch actually fire.

It holds **no authority over funds**. Execution is permissionless: payouts are computed entirely on-chain and can only go to the pre-set beneficiaries in the pre-set proportions after the deadline. The server's keypair (`CRANKER_KEYPAIR`) pays transaction fees and new-PDA rent only — it is not a vault authority and cannot redirect anything.

Live at **`notify.palatinearc.com`** (Caddy → `127.0.0.1:8787`), running under systemd as `dmv-notify.service`.

---

## How it works

The app registers each vault with `POST /register` (owner, vault PDA, FCM device token, stage durations) on setup and heartbeat. A poller then runs every `POLL_INTERVAL_MS` (set to **15s** — coarser intervals could skip short demo-mode stages, e.g. 30s each, and miss a notification):

- Reads each registered vault's `VaultConfig` + `HeartbeatRecord` on-chain.
- Computes the escalation stage; on a stage transition (or throttled recurring), sends the matching FCM push.
- **When a vault reaches stage 4 (grace elapsed)** and the executor is enabled, runs `runExecutor(vault)` — the §7 crank.
- Drops the registration once the vault is executed, revoked, or gone (self-cleaning; stale rows never accumulate).

### The executor crank (`src/executor.js`)

A mask-driven "do the next undone thing" loop, idempotent and safe to re-run every tick and to race against the app or a beneficiary (first writer wins, others no-op):

```
begin_execution                     # snapshot the SOL residual (existence proves grace)
begin_token_dist(mint)  per mint    # snapshot each token residual (canonical, anti-spoof ATA)
execute_specific_asset(j)           # pay specific SPL/NFT bequests, in order
execute_sol_shares([...])           # SOL pro-rata, batched <=8
finalize_execution                  # once SOL + bequest masks are full
execute_token_shares(mint, [...])   # token residual pro-rata, batched <=8
close_token_dist(mint)  per mint    # sweep dust -> largest-share beneficiary, close ATA + dist
```

It never closes the core PDAs — that final cleanup is owner-signed by design (so a buggy crank can't orphan a never-distributed mint's tokens). Beneficiary ATAs are created idempotently by the cranker as needed.

---

## Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `GET`  | `/health` | — | Status: `fcmConfigured`, `executorReady`, `cranker` (pubkey), `registrations`, `rpc` (api-key masked), `programId` |
| `POST` | `/register` | `x-dmv-secret` | Register/update a vault: `{ owner, vault, deviceToken, stage1, stage2, stage3 }` |
| `POST` | `/deregister` | `x-dmv-secret` | Remove by `{ vault }` or `{ owner }` |
| `POST` | `/poll-now` | `x-dmv-secret` | Run one poll tick immediately (testing) |
| `POST` | `/execute-now` | `x-dmv-secret` | Manually crank one vault's execution: `{ vault }` (testing) |
| `POST` | `/debug/push` | `x-dmv-secret` | Send one test FCM push to a token: `{ token, title?, body?, channel? }` — isolates FCM delivery from the stage logic |

`x-dmv-secret` must match `REGISTER_SECRET`. `/health` masks the RPC api-key so the (public) endpoint never leaks it.

Every FCM send logs `[fcm] ACCEPTED`/`[fcm] REJECTED` (with the token truncated) so delivery can be traced in the journal.

---

## Configuration

Copy `.env.example` → `.env` and fill it in. Key vars:

- `RPC_URL` — use a **Helius devnet URL** (`https://devnet.helius-rpc.com/?api-key=...`) to avoid public-RPC 429s during cranks.
- `EXECUTOR_ENABLED` — `1` to enable autonomous execution.
- `CRANKER_KEYPAIR` — absolute path to a `solana-keygen` JSON keypair, funded with a little devnet SOL. **Gitignored.** Only pays fees/rent.
- `REGISTER_SECRET`, `FCM_PROJECT_ID`, `FCM_SERVICE_ACCOUNT` — as documented in `.env.example`.

`idl/dead_mans_vault.json` is the Anchor IDL the executor loads; keep it in sync with deploys (`cp ../dead-mans-vault/target/idl/dead_mans_vault.json idl/`).

Secrets kept out of git: `.env`, `cranker.json`, the FCM service-account JSON.

---

## Run

```bash
npm install
cp .env.example .env      # then edit
# generate + fund a cranker (only if enabling the executor)
solana-keygen new -o cranker.json
solana transfer $(solana-keygen pubkey cranker.json) 0.5 --url devnet --allow-unfunded-recipient

npm run dev               # node --watch src/server.js
# or in production: systemctl restart dmv-notify
```

Stack: Express · better-sqlite3 · `@coral-xyz/anchor` + `@solana/spl-token` (executor) · google-auth-library (FCM v1). ESM, Node 24.
