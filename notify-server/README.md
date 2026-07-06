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
- Drops the registration once the vault is executed, revoked, or gone (self-cleaning; stale rows never accumulate). If the vault **executed** after reaching stage 4, the drop tick first sends one final **"Estate plan complete"** push — in autonomous mode the app never runs, so the server is the only thing that can say the distribution finished.

### The executor crank (`src/executor.js`)

A mask-driven "do the next undone thing" loop, idempotent and safe to re-run every tick and to race against the app or a beneficiary (first writer wins, others no-op):

```
begin_execution                     # snapshot the SOL residual (existence proves grace)
ensureAta(vault, mint)  per mint    # idempotently create the vault's token ATA FIRST
begin_token_dist(mint)  per mint    # snapshot each token residual (canonical, anti-spoof ATA)
execute_specific_asset(j)           # pay specific SPL/NFT bequests, in order
execute_sol_shares([...])           # SOL pro-rata, batched <=8
finalize_execution                  # once SOL + bequest masks are full (masks re-fetched FRESH); pays the keeper bounty to the cranker
execute_token_shares(mint, [...])   # token residual pro-rata, batched <=8
close_token_dist(mint)  per mint    # harvest withheld fees (fee mints) -> mint, sweep dust -> largest benef, close ATA + dist
```

It never closes the core PDAs — that cleanup is the owner's (`close_executed_vault_by_owner`, anytime) or, after the 24-hour owner-exclusive window, any keeper's (`close_executed_vault`, e.g. the standalone `keeper-bot/`). Both the SOL and bequest masks are **re-fetched fresh right before the finalize gate** — a pass that just paid the last bequest would otherwise compare a stale in-memory mask, skip finalize, and abort on `close_token_dist` (`VaultNotExecuted`); the close loop is also guarded on a fresh `executed` check. Beneficiary ATAs are created idempotently by the cranker as needed. The executor also creates the **vault's** token ATA idempotently *before* `begin_token_dist` (`ensureAta`) — without it, a bequest for a mint the vault doesn't actually hold throws `AccountNotInitialized` at snapshot time and freezes the owner out post-grace; with it, an unheld-mint bequest snapshots/pays 0 and finalizes cleanly. For **transfer-fee** Token-2022 mints, the executor harvests any withheld fees from the vault ATA to the mint (`createHarvestWithheldTokensToMintInstruction`, permissionless, atomically via `preInstructions`) *before* `close_token_dist` — Token-2022 refuses to close an account that still holds withheld fees, which would otherwise stick the TokenDist and keep `open_token_dists > 0`, blocking the whole close. If the vault set a `keeper_bounty`, whoever lands `finalize_execution` collects it (a reward carved out of the SOL snapshot at begin, so it never reduces beneficiary payouts).

**Mint selection (dust-drain protection).** `collectMints` distributes owner-defined plan mints plus held mints with a non-zero balance. Zero-balance vault token accounts are skipped (on-chain `begin_token_dist` rejects a mint the vault neither holds nor bequeaths), and non-plan held mints beyond a per-vault cap (highest balance first) are deferred to the uncapped app/heir crank — so an attacker can't drain the cranker's SOL by dusting a vault with many junk mints.

---

## Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `GET`  | `/health` | — | Status: `fcmConfigured`, `executorReady`, `cranker` (pubkey), `registrations`, `rpc` (api-key masked), `programId` |
| `GET`  | `/inheritances?wallet=<pubkey>` | rate-limited | Read-only. Returns the vaults where `wallet` is a beneficiary, each with `{ vault, owner, shareBps, status, deadline, secondsToDeadline }` (status = active \| warning \| claimable \| executed). Per-IP rate limit + short-TTL cache of on-chain reads; scan capped. Powers the app's Inheritances screen |
| `GET`  | `/nft/<id>.json` | — | Static NFT metadata for devnet test collectibles (served from the `nft-metadata/` directory) |
| `GET`  | `/nft/<id>.png` | — | Static NFT test image, self-hosted alongside the metadata JSON (same `nft-metadata/` static route) |
| `POST` | `/register` | `x-dmv-secret` + on-chain proof | Register/update a vault: `{ owner, vault, deviceToken, stage1, stage2, stage3 }`. The vault must be the canonical PDA for `owner` and a real on-chain `VaultConfig` whose stored owner matches |
| `POST` | `/deregister` | `x-dmv-secret` | Remove by `{ vault }` or `{ owner }` |
| `POST` | `/poll-now` | `x-dmv-secret` | Run one poll tick immediately (testing) |
| `POST` | `/execute-now` | `x-dmv-secret` | Manually crank one vault's execution: `{ vault }` (testing). Returns a generic error on failure (raw errors can embed the RPC api-key) |
| `POST` | `/debug/push` | `x-dmv-secret`, **dev only** | Send one test FCM push: `{ token, title?, body?, channel? }`. Only mounted when `NODE_ENV=development` — an arbitrary push to any token is a phishing primitive and is not exposed in production |

`x-dmv-secret` must match `REGISTER_SECRET` (compared in constant time). `/health` masks the RPC api-key so the (public) endpoint never leaks it.

Every FCM send logs `[fcm] ACCEPTED`/`[fcm] REJECTED` (with the token truncated) so delivery can be traced in the journal.

---

## Security

Hardened for mainnet (see the repo CHANGELOG "Security hardening" entry):

- **Fail-closed auth.** The server refuses to boot without `REGISTER_SECRET` unless
  `NODE_ENV=development` (`assertSecureConfig`), so a misconfiguration can never silently
  leave the write endpoints open. The secret is compared in constant time. Note the secret
  ships inside the app bundle and is therefore extractable — it provides weak authenticity
  only, which is why registration is **additionally ownership-proofed on-chain**.
- **Registration ownership proof.** `/register` derives the canonical vault PDA from `owner`
  and requires it equals the submitted `vault`, then checks the account is program-owned,
  carries the `VaultConfig` discriminator, and its stored owner matches. This blocks
  garbage/mismatched registrations and fake-vault injection into `/inheritances`. *Residual
  gap:* it does not prove the caller controls the owner wallet, so a holder of the shared
  secret could still re-point an existing owner's real vault to a different device token
  (hijacking/silencing its pushes). Closing that fully needs an owner-wallet signature over
  `{vault, deviceToken}` — a tracked follow-up. Owner-SIGNED register/deregister validators
  exist in-code (`registerAuth.js` + the nonce table) but are **dormant**: they must ship
  together with the signature-producing app (a coordinated mainnet release with a transition
  window), so the active path is unsigned + ownership-proofed.
- **Robust on-chain parsing.** `readVaultState`/`parseVaultConfig` verify program-owner +
  discriminator and bounds-check `benCount` before parsing (no OOB read / CPU DoS on crafted
  account bytes).
- **DoS resistance.** `/inheritances` is rate-limited per IP, caches vault reads briefly (so
  it can't be used to amplify RPC load), and caps its scan. The poller runs registrations
  with bounded concurrency and a per-vault timeout, plus a tick watchdog, so one slow/hung
  vault can't wedge all alerts + executions. The executor takes a per-vault in-process lock
  so `/execute-now` can't race a poll tick and waste fees.
- **Crash resistance.** Process-level `unhandledRejection`/`uncaughtException` handlers and
  try/catch around every async handler keep a stray error from taking down the daemon (which
  would silently halt both alerts and the switch).
- **Cranker fund protection.** The executor skips zero-balance token accounts and caps the
  number of non-plan mints it auto-distributes per vault, bounding the rent an attacker can
  make the cranker front by dusting a vault with many junk mints. Owner-defined plan mints are
  always distributed; surplus held mints beyond the cap are left for the (uncapped) app/heir crank.
- **Secrets on disk.** `.env` must be mode `600` (it holds `REGISTER_SECRET` + the Helius
  api-key in `RPC_URL`); `cranker.json` and the FCM JSON are gitignored and `600`.

---

## Configuration

Copy `.env.example` → `.env` (mode `600`) and fill it in. Key vars:

- `NODE_ENV` — set to `production` in deployment. Anything other than `development` is treated
  as production and **fail-closes**: the server refuses to boot without `REGISTER_SECRET`.
- `RPC_URL` — use a **Helius devnet URL** (`https://devnet.helius-rpc.com/?api-key=...`) to avoid public-RPC 429s during cranks.
- `EXECUTOR_ENABLED` — `1` to enable autonomous execution.
- `CRANKER_KEYPAIR` — absolute path to a `solana-keygen` JSON keypair, funded with a little devnet SOL. **Gitignored.** Only pays fees/rent. Monitor its balance (the executor caps per-vault spend, but running the crank still costs fees/rent).
- `REGISTER_SECRET` — **required in production** (the server won't start without it). Long random string; the app sends it as `x-dmv-secret`. Extractable from the app bundle, so treated as weak auth — registration is additionally ownership-proofed on-chain.
- `FCM_PROJECT_ID`, `FCM_SERVICE_ACCOUNT` — as documented in `.env.example`.

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

> Liveness redundancy: this server is one of **two independent crankers** — the standalone
> `keeper-bot/` discovers vaults directly on-chain and cranks them too. Either alone fires
> every vault; losing this server never endangers an inheritance.
