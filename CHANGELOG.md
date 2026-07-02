# Changelog

All notable changes to Dead Man's Vault are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and releases (with APKs) are on the
[Releases page](https://github.com/Romulus-Sol/DMV/releases). Network: Solana Devnet.
Program ID `GXCu5964mvgAJDWmcMriZpzU3vDVqPzjYCM1sxCnsoEb`.

## [1.8.0] — 2026-07-02

### Added
- **Specific-SOL bequests.** Assign an exact amount of SOL to a specific beneficiary
  (alongside specific SPL-token and NFT bequests). The amount is carved out of the
  estate first; the remaining SOL still splits pro-rata by share. A SOL assignment
  reuses the existing bequest structure via a zero-pubkey sentinel mint (no on-chain
  layout change), and is paid by a dedicated `execute_specific_sol` instruction —
  enforced on-chain and distributed autonomously by the permissionless crank.
  On-chain program: 19 instructions / 39 error codes; 22/22 tests; verified e2e on devnet.

## [1.7.4] — 2026-07-02

### Fixed
- **Stale "Configure Heartbeat" tick on the Vault screen** after a vault executed. When
  the notify-server distributed a vault autonomously, the app had no local execution
  record and fell back to the partial setup wizard, where the heartbeat config (synced
  from the on-chain vault) showed a tick that reappeared on every reopen. An on-chain
  executed vault is now recognized as a past execution and shows the "Vault Executed"
  summary instead.

## [1.7.3] — 2026-07-02

### Fixed
- **Duplicate escalation notifications — root cause resolved.** The on-device local
  notification timeline double-fired alongside the notify-server. FCM delivery is
  confirmed reliable (including killed-app), so the local timeline was removed and the
  server is now the single source — exactly one notification per stage.
- **Skipped stages** — the server poll interval (60s) was coarser than short demo
  stages (30s) and could skip one; tightened to 15s so every stage is delivered.
- **Executed-vault status** — Settings now shows "Executed" (not "Active") after execution.
- **Setup cost** — "Total Est. Cost" corrected to 0.035 SOL (0.015 rent + 0.01 agent +
  0.01 creation fee).

## [1.7.2] — 2026-07-02

### Added
- **0.01 SOL vault-creation fee, enforced on-chain.** `initialize_vault` collects a
  0.01 SOL fee to the project wallet as part of creation — required and not bypassable
  (a `fee_recipient` account pinned by address + a CPI transfer).

### Fixed
- **Executed vaults no longer appear active.** Settings now shows a "Close Vault &
  Reclaim Rent" action for executed vaults (which closes the account on-chain and
  returns rent) instead of a Revoke that didn't persist across reopen.
- **Duplicate escalation notifications** eliminated — the Stage-4 app/server overlap is
  closed (the app defers to the server's push when FCM is active).
- **Notification copy** rewritten and corrected across app + server (Stage 4 now
  reflects that distribution happens automatically).

> Because the fee is enforced on-chain, builds older than 1.7.2 can no longer create
> vaults; 1.7.2 is required for vault creation.

## [1.7.1] — 2026-07-01

### Fixed
- **Duplicate escalation notifications.** The local pre-scheduled OS timeline and the
  FCM notify-server were both delivering stage 1–3 alerts, so a registered vault
  received two notifications per stage event. They are now mutually exclusive
  (FCM primary, local fallback): when the app confirms the server is watching a vault,
  the server is the sole source and the local timeline is cancelled; otherwise the
  local timeline remains as the offline fallback — no duplicates, no loss of
  killed-app coverage.

### Website
- New `dmv.palatinearc.com` homepage (permissionless design), now served from the VPS
  via Caddy and moved off GitHub Pages (source at `website/`).
- Fact-checked all copy against the shipped v2 build; corrected the download callout to
  the latest release and refined the Stage 2 escalation copy.
- Added the DMV logo to the header nav and a favicon.
- Dropped the bundle's debug error overlay so visitors never see a red error box
  (a benign error surfaced by Cloudflare's injected bot-detection script).

## [1.7.0] — 2026-07-01

Permissionless autonomous execution + specific bequests. The dead-man's switch now
fires even if the owner's phone is lost, dead, or never reopened.

### Added
- **Permissionless execution.** After grace, the on-chain program computes every payout
  from on-chain state and *any* signer (the app, a beneficiary, or a keyless watcher)
  can submit it. The caller controls nothing — funds can only reach the pre-set
  beneficiaries, in the pre-set proportions, after the deadline.
- **Keyless watcher service** (`notify-server`) that autonomously distributes after grace
  with no app or owner action required.
- **Specific bequests** — assign exact SPL token amounts or whole NFTs to specific
  beneficiaries (carved out first); the remainder splits pro-rata by share.
- **Token-2022** support for distribution (via `InterfaceAccount`).
- New on-chain accounts `AssetPlan` and `TokenDist`; frozen residual snapshots +
  per-asset idempotency bitmasks so a partial distribution is safely resumed by anyone.

### Changed
- The agent key now signs **heartbeats only** (was: execution); agent funding reduced
  0.05 → 0.01 SOL.
- Owner mutations and heartbeats **freeze once the grace deadline is reached**, guaranteeing
  the trustless switch.
- Runs on **any modern Android phone** via Mobile Wallet Adapter — Seeker recommended
  (Seed Vault) but no longer required.
- On-chain program is now 18 instructions / 5 accounts / 37 error codes; 20/20 tests.

### Security
- Fixed a **critical** fund-misdirection bug found in review before deploy: a
  caller-supplied token program could spoof a mint's residual snapshot to zero and
  redirect the whole token residual. The canonical vault ATA is now derived from the
  mint's true owner program. Added an orphan-guard (`open_token_dists`) on the owner
  close and canonical-ATA pinning throughout the token paths.

> **Breaking (devnet):** the v2 on-chain byte layout changed; vaults created under the
> old program won't deserialize — revoke/recreate. Devnet only.

## [1.6.x] — 2026-06-29

Pre-v2 line (Solana Mobile Hackathon build). Notable changes across 1.6.3 / 1.6.4:

### Added
- **FCM push notifications** for killed-app escalation alerts (chain-watching notify server).
- **Pre-scheduled OS notification timeline** so escalation notifications fire on time even
  when the app is killed.

### Fixed
- Agent-SOL refund accounting on execution and a full transaction/total breakdown on revoke
  (incl. an "Agent SOL already returned earlier" line so the refund is never silently omitted).
- SPL vault-ATA close on revoke so token-account rent isn't stranded.

---

_Versions before 1.6.3 predate this changelog._
