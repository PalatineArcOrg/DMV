# Changelog

All notable changes to Dead Man's Vault are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and releases (with APKs) are on the
[Releases page](https://github.com/Romulus-Sol/DMV/releases); this log is also rendered
at [dmv.palatinearc.com/changelog](https://dmv.palatinearc.com/changelog.html). Network: Solana Devnet.
Program ID `GXCu5964mvgAJDWmcMriZpzU3vDVqPzjYCM1sxCnsoEb`.

## [Unreleased] — Tooling & CI

No app or on-chain program change (no new release/APK); app remains **v1.13.15**.

- **CI**: fixed the notify-server job — it now runs on **node 24** (matching the runtime).
  A node-20 ESM/CJS interop failure surfaced once the new executor regression test
  imported `@coral-xyz/anchor` (a CommonJS module); the unused `BN` import was also dropped.
- **Website**: the changelog is now published at
  [dmv.palatinearc.com/changelog](https://dmv.palatinearc.com/changelog.html), rendered
  from this file, and the marketing site has a **repo → live deploy pipeline** — repo
  `website/` is the source of truth, with git hooks that keep the tracked `changelog.html`
  snapshot fresh and auto-deploy `/var/www/dmv` on commit.

## [1.13.14–1.13.15] — 2026-07-07 — Security audit remediation + Clear bequests

An internal, skill-driven security audit (OWASP-Solana, Token-2022, Anchor, client, and
testing checklists) found the **fund-safety path clean** — every theft, over-distribution,
misroute, and auth-bypass class mitigated with evidence — with all findings in the
availability / operational category. Remediation shipped across the app (v1.13.14 →
v1.13.15), the on-chain program (redeployed to devnet), and the two crankers, alongside a
new **Clear bequests** feature. Every fix got a blast-radius impact analysis first; the one
finding that would have turned an availability bug into fund *misdirection* was routed to
external audit rather than built.

### App
- **Clear all bequests (1.13.15).** When a plan exists, the Bequests screen now shows a
  **Clear all bequests** action: one owner-signed transaction removes every specific
  bequest, which unlocks editing your beneficiaries (blocked while a plan exists). Assets
  stay in the vault and split pro-rata by share until you set new bequests.
- **Deposit & bequest warnings (1.13.14).** The app now warns — never blocks — when a
  Token-2022 mint's issuer could freeze / pause / seize (permanent delegate) / hook it,
  both when depositing and when naming it in a specific bequest, so you see the risk before
  committing an asset the issuer could later make un-distributable.
- **Withdraw precision (1.13.14).** The owner withdraw-all path now uses an exact bigint
  balance (a large token balance could lose precision as a JS number).
- **Removed dead code (1.13.14).** Deleted an un-wired DeFi autonomous-swap path that was
  never reachable from execution.

### On-chain program (Anchor 0.32.1; redeployed to devnet)
- **`clear_asset_plan` instruction.** Owner-only, pre-grace: closes the AssetPlan (rent →
  owner) and clears `has_asset_plan` — the escape hatch behind the Clear bequests feature.
  Freeze-gated like every other plan mutation; verified end-to-end on the deployed program.
- **Interval / grace upper bounds.** Caps of 1 year / 2 years reject a value that would
  overflow the deadline computation and brick a vault (new errors 6042 / 6043).
- **`record_heartbeat` canonical PDA seeds** — defense-in-depth pinning, matching the other
  instructions.

### Crankers (keeper-bot + notify-server)
- **Priority fee + compute-unit limits.** Both crankers now set a best-effort priority fee
  and explicit per-instruction CU limits so autonomous distribution lands under mainnet
  congestion. The fee lookup can never throw, so third-party keepers on any RPC are
  unaffected.
- **Skip stuck mints.** A mint the issuer paused / froze / hooked / made non-transferable
  is skipped for the tick instead of aborting the whole crank — every other asset still
  reaches the heirs; only that mint's residual + rent strand.
- **Mint-lookup retry** (a transient RPC error no longer drops a bequeathed mint) and an
  **executor finalize-gate re-fetch guard** (re-reads the on-chain masks before finalizing,
  so a stale in-memory mask can't skip finalize one step from done).

### Testing & CI
- **Property-fuzz suite** (`dead-mans-vault/tests/fuzz/`, `yarn test:fuzz`) — litesvm +
  fast-check, 9 properties over conservation, idempotency, specific bequests, a
  theft-must-revert battery (exact error codes), the post-deadline freeze, Token-2022
  transfer-fee close, NFT bequests, residual dust-at-scale (n≤20), and a **stateful
  instruction-sequence fuzzer** (random orderings vs 7 global invariants). Runs against
  the real production floors via clock-warp. **Found no program bug**, and now runs in
  **CI on every push**.
- **New coverage:** `close_revoked_vault` (guard + a crafted-zombie close), a compute-unit
  budget measurement at 20 beneficiaries (batch-of-8 stays well under limits), client
  crank index/batch math units, and an executor finalize-gate regression.
- **Crank RPC-failure / race stress** (`keeper-bot/stress/`) — a local validator +
  fault-injecting RPC proxy drives the real keeper crank under 429s / timeouts /
  concurrent races; confirms RPC failure and racing are correctness-safe (delayed retry
  at worst, never loss / double-pay / misdirection).

### Docs & ops
- Public reviewer docs reorganized into repo-root `docs/` — added `SECURITY.md` (vuln
  reporting + bug bounty), `STRESS-TESTING-PLAN.md`, `FUZZ-HARNESS-PLAN.md`, plus
  `AUDIT-SCOPE.md` (pinned to tag `audit-2026-07-07`) and the design spec. The old
  hackathon `pitch-deck/` and `docs/`(pptx) folders were removed.
- Cranker balance monitor (`keeper-bot/balance-monitor.mjs`) with a systemd timer and
  Discord low-balance alerting.

## [1.13.9–1.13.13] — 2026-07-05 — Tokenized stocks (RWA) + transfer-fee close + setup fixes

Adds a first-class **Stocks** section for Token-2022 tokenized equities (xStocks /
Backpack Securities-style RWAs), makes fee/pausable stocks deposit and distribute
correctly, and fixes two vault-close/setup bugs surfaced by on-device testing with a
transfer-fee stock. Devnet build; single-release convention unchanged.

### App
- **Stocks tab (1.13.9).** New `Assets → Stocks` section and an inline Dashboard Stocks
  list, mirroring the NFTs / DeFi split. Token-2022 fungibles are classified as stocks by a
  known-mint registry (real mainnet xStocks + the devnet test mints) plus an `[A-Z]{2,6}x`
  symbol heuristic; the Tokens tab excludes them.
- **Stocks-invisible fix (1.13.10).** A separate-module import of the stock classifier
  resolved to `undefined` under Hermes and threw inside the portfolio parse loop, silently
  hiding **every Token-2022 token** (legacy tokens still showed). The classifier is now
  inlined into `PortfolioScanner`, and the RPC-fallback scan enumerates both the legacy Token
  and Token-2022 programs — so stocks show with or without a Helius key.
- **Deposit correctness + guards (1.13.11).** Token deposits now use `transfer_checked` (the
  unchecked transfer is rejected by transfer-fee **and pausable** mints, so real xStocks could
  never deposit before). A pre-sign check reads the mint's Token-2022 extensions and **blocks**
  non-transferable / frozen-by-default / transfer-hook / paused mints with a clear reason, and
  **warns** on transfer-fee mints (a percentage is lost on every hop). The Bequests picker now
  shows stock names instead of raw mint addresses.
- **Executed-vault close actually closes on-chain (1.13.12).** Closing an executed vault now
  closes any remaining TokenDists **and** the core PDAs on-chain and reclaims rent, surfacing a
  real error if something blocks it — previously the executed path silently "cleared local
  data," leaving the vault on-chain so it reappeared on restart.
- **Transfer-fee close fix (1.13.12).** A transfer-fee mint leaves *withheld* fees in the
  vault's token account (e.g. from the deposit), and Token-2022 refuses to close an account
  that still holds withheld fees — which stuck `close_token_dist` and kept `open_token_dists >
  0`, blocking the whole close. The close now **harvests the withheld fees to the mint first**
  (permissionless), so fee / pausable stocks close cleanly.
- **Setup wizard re-sync (1.13.12).** A vault that executes while the app is idle now surfaces
  the "Vault Executed" summary instead of a stale editable wizard showing old beneficiaries —
  the wizard re-fetches on-chain vault state on focus, not only before setup.
- **Stale "Configure Heartbeat ✓" fix (1.13.13).** The heartbeat config is persisted to the
  device (so a mid-setup draft survives a restart) and re-hydrated on launch, but Start Over
  and revoke only reset it in memory — so it re-appeared on restart and marked the heartbeat
  step done on a brand-new setup. Both reset paths now delete the persisted copy too.

### Keeper bot + notify-server
- Both autonomous cranks got the same **harvest-before-close** fix, so a transfer-fee /
  pausable Token-2022 stock closes cleanly whether the owner's app, the standalone keeper bot,
  or the notify-server runs the crank. This matters most for the fully-autonomous path (owner
  gone, only the server or a keeper cranks).

## [1.13.6–1.13.8] — 2026-07-04 — Rebrand + keeper crank-only + cleanup

### App
- **Rebrand (1.13.6–1.13.7).** New ECG-pulse brand mark everywhere: app icon, Android
  adaptive icon, splash, and a proper tintable-silhouette notification icon (accent fixed to
  the real brand mint `#00FFA3`); in-app, a react-native-svg `BrandMark` replaces the generic
  icon-font shields at every logo position (auth gate, Dashboard header + connect hero, Welcome
  hero), the all-clear status icon is now a pulse, and remaining shields became semantic icons
  (check-decagram / alert-octagon / open-padlock / etc.). No shield glyphs remain in the UI.
- **1.13.8.** Removed the non-functional Close / Transfer / Ignore buttons from DeFi positions
  in the Assets screen — they were dead no-ops (only toggled unused local state).

### Keeper bot (server-side)
- Added a **`CLOSE_EXECUTED`** flag (default on). Set to `0` for a **crank-only** keeper: it
  still distributes expired vaults but never closes an executed vault to collect its rents,
  leaving those for the owner. Recommended on devnet, where the close window is only 60s and an
  always-on keeper would otherwise sweep an owner's own rent before they can reclaim it; mainnet
  keeps it on (the 24h window is a fair owner window).

### Website
- New pulse favicon/logo + phone-mockup mark, and a mobile-responsive layout pass.

## [1.13.5] — 2026-07-04 — Keeper economics + permissionless cleanup

Removes the last stranded value from a fired vault and makes third-party keepers
economically self-sustaining. Program redeployed to devnet + IDL upgraded.

### On-chain program — new `close_executed_vault` (permissionless)
- After execution has finalized, all TokenDists are closed, and a **24-hour
  owner-exclusive window** has elapsed (`EXECUTED_CLOSE_DELAY`, 60 s under the `devnet`
  feature; error `CloseDelayNotElapsed`), **anyone** may close the core PDAs
  (VaultConfig + HeartbeatRecord + ExecutionLog + AssetPlan) and claim their rents
  (~0.01–0.03 SOL) as a cleanup reward. Previously that rent stranded forever when the
  owner was dead — the owner-signed close could never run. SOL dust above rent still goes
  to the largest-share beneficiary; a living owner can still close (and keep the rents)
  any time via `close_executed_vault_by_owner`. Additive instruction — no layout change,
  existing vaults unaffected. 29/29 tests (blocked-in-window, rents-to-cranker,
  owner-priority).

### Keeper bot — `keeper-bot/` (new, standalone)
- A self-contained keeper anyone can run: discriminator-scans the program for expired
  vaults (skipping undecodable legacy accounts), runs the full permissionless crank, and
  collects the keeper bounty + cleanup rents. `RPC_URL` + `KEYPAIR_PATH` and go; `--once`
  for cron. Devnet-verified: one tick cranked 5 expired vaults and closed 4 executed
  ones — the keeper more than doubled its stake from bounties + rents.

### App
- **Agent funding halved: 0.01 → 0.005 SOL** (~1,000 heartbeats of fees — still years of
  margin). Halves what is unrecoverable with a lost phone after a real death (the agent
  key exists only on that device) and drops activation cost to ≈ 0.028 SOL. The
  close/revoke flows already sweep the agent's leftover SOL back to a living owner.

## [1.13.0–1.13.4] — 2026-07-04 — Security hardening (pre-mainnet) + fixes

A pre-mainnet security review across the on-chain program, the notify-server, and the
app's agent-key storage (shipped as v1.13.0), followed by same-day fixes: v1.13.1
reverted a parser-module regression that broke vault reads on-device ("created but can't
see it"); v1.13.2 re-added the account-parse hardening inline (bundle-verified);
v1.13.3 reverted notification registration to the silent unsigned flow (the auto
background wallet-signing popup was unreliable and its verifying server was never
deployed — the signed variants remain dormant for a coordinated mainnet release) and
fixed a crank bug where paying the last bequest and finalizing in the same pass compared
a stale in-memory mask (vault stuck one step from done); v1.13.4 added NFT names +
thumbnails to the vault views and Bequests picker, and an "Estate plan complete" push
after autonomous execution. Devnet Program ID unchanged.

### On-chain program (Anchor) — redeploy + IDL upgrade required
- **CRITICAL — specific bequests could be misdirected.** `execute_specific_asset` didn't
  pin `vault_ata` to the canonical associated-token address (the anti-spoof guard the
  other token instructions already used). A permissionless caller could pass an empty
  vault-owned token account, mark a specific SPL/NFT bequest paid at 0, and leak the real
  asset to the largest-share beneficiary as dust. Now pinned → `InvalidVaultAta`; added a
  regression test.
- **CRITICAL — devnet timing minimums restored for mainnet.** The production
  heartbeat/grace minimums (1 day / 7 days) are the DEFAULT build again; the 10s/30s demo
  floors are behind an opt-in `devnet` Cargo feature (`anchor build -- --features devnet`
  for tests). A plain build/deploy is now fail-safe.
- **Keeper-bounty cap.** `initialize_vault` bounds `keeper_bounty` to 0.1 SOL
  (`MAX_KEEPER_BOUNTY_LAMPORTS`, error `KeeperBountyTooLarge`) so it can't zero out
  beneficiary SOL; mirrored client-side.
- **Anti-grief on `begin_token_dist`** (`NothingToDistribute`): rejects a mint the vault
  neither holds nor bequeaths, so junk mints can't inflate `open_token_dists` and block
  the owner's rent reclaim.
- **Checks-effects-interactions**: `execute_specific_asset` / `execute_token_shares` set
  the paid bit before the transfer CPI (blocks Token-2022 transfer-hook reentrancy).
- 23/23 tests pass. Two error codes appended: `KeeperBountyTooLarge`, `NothingToDistribute`.

### Notify-server — deployed
- **Fail-closed auth.** Refuses to boot without `REGISTER_SECRET` unless
  `NODE_ENV=development`; constant-time secret compare; `/debug/push` is dev-only.
- **Ownership-proofed registration.** `/register` verifies the vault is the canonical PDA
  for the owner and a real on-chain `VaultConfig` (program-owner + discriminator + stored
  owner) before writing; `readVaultState` verifies owner/discriminator and bounds-checks parsing.
- **DoS / robustness.** `/inheritances`: per-IP rate limit + short-TTL RPC cache + scan cap.
  Per-vault timeouts + bounded concurrency + a poll-tick watchdog so one hung vault can't
  wedge the daemon; process-level crash guards; per-vault crank lock; `/execute-now` returns
  a generic error (raw errors could leak the RPC api-key); `.env` set to mode 600.
- **Cranker dust-drain bound.** The executor skips zero-balance token accounts and caps
  non-plan mints per vault, bounding the rent an attacker can make the cranker spend.

### App — new APK build required
- **Agent key behind biometrics.** The heartbeat-signing key is stored with
  `requireAuthentication` (device credential / biometric) plus a safe fallback, and its
  secret is zeroized on destroy; `android.allowBackup=false`. Blocks extracted key material
  from forging heartbeats and stalling the switch. (Key RNG verified CSPRNG-backed.)
- Client-side keeper-bounty cap mirrors the on-chain limit.

## [1.12.2] — 2026-07-03

### Changed
- **Default RPC shown as "Default DMV RPC API"** in Settings → Network (built-in endpoint no
  longer exposed; a user's own custom URL is still shown).

### Added
- **Rate-limit banner.** `useRpcStatusStore` is written from the fetch layer on any HTTP 429
  / JSON-RPC 429; a banner on Dashboard + Assets surfaces "Network busy — data may be delayed"
  and links to Settings. Auto-hides ~12s after traffic settles.

### Fixed
- **Dashboard "View All" tab targeting.** NFTs/DeFi "View All" navigated to Assets without a
  tab param (wrong/last tab); they now pass the target tab via the nested AssetsOverview route
  and AssetsScreen honors `route.params.tab`.

## [1.12.1] — 2026-07-03

### Fixed
- **NFT metadata decoded as byte codes on-device.** The Metaplex parser used
  `subarray().toString('utf8')`; in RN's buffer polyfill `subarray()` returns a plain
  Uint8Array whose `toString` ignores the encoding, so names rendered as "68,77,86…"
  (byte codes) and the uri/image broke too. Fixed to `Buffer.toString('utf8', start, end)`.

## [1.12.0] — 2026-07-03

### Added
- **Custom RPC endpoint (Settings → Network).** Set your own RPC/DAS URL (Helius, Triton,
  QuickNode, Aura…) so NFT/portfolio data uses your own rate limits. Test / Save / Reset,
  masked display, DAS-support probe; loaded at bootstrap, "restart to apply". Default
  behavior unchanged if unset. New `src/utils/rpcConfig.ts` is the single source of truth
  for the RPC URL + Helius endpoints/key; all consumers migrated off `constants.ts`.
- **On-chain Metaplex-metadata fallback.** NFT names + images resolve directly from the
  on-chain Metadata account (batched read + manual borsh parse, no dependency) with the
  image from the metadata uri, cached in SQLite — so NFTs show name + artwork even when the
  DAS index is rate-limited, over any RPC. Standard NFTs only (cNFTs remain DAS-only).

## [1.11.3] — 2026-07-03

### Fixed
- **NFT names/images load; Helius features re-enabled.** `EXPO_PUBLIC_HELIUS_API_KEY` was
  empty in the release bundle (verified: the key appeared only once, inside `RPC_URL`), so
  `PortfolioScanner` skipped the DAS metadata path entirely — NFTs showed mint addresses,
  no images, and Helius tx-history + priority fees were silently off. The key is now derived
  from the api-key in the Helius `RPC_URL` when the standalone var is empty. DAS runs → NFT
  names + artwork, tx history, and priority fees all work.

## [1.11.2] — 2026-07-03

### Fixed
- **NFTs categorized even when the portfolio scan falls back from DAS.** The Helius DAS
  path tags NFTs, but the `getParsedTokenAccountsByOwner` fallback (used on DAS error/
  rate-limit) did not, so NFTs landed in the Tokens list with the NFTs tab empty. The
  fallback now tags NFTs by signature (0 decimals, 1 unit) — the same heuristic the
  bequest picker uses. Names/images still come from DAS when available.

## [1.11.1] — 2026-07-03

### Added
- **NFTs as a portfolio category.** The Assets tab has a dedicated **NFTs** tab
  (Tokens · NFTs · DeFi), and the Dashboard portfolio card shows an inline NFTs section.

### Fixed
- **Removed inaccurate messaging.** Corrected escalation copy that falsely claimed
  "emergency contacts notified" / "beneficiaries have been notified" (DMV notifies the
  *owner*, not third parties — there are no emergency contacts), a misleading "< 24 hours"
  timing label, and a stale "Execution: Agent Key (TEE)" detail → "Permissionless" (v2
  execution is permissionless; the agent signs heartbeats only).

## [1.11.0] — 2026-07-03

### Added
- **NFT support, end to end.** NFTs (Metaplex `V1_NFT`/`ProgrammableNFT`) now appear in the
  Assets tab with an NFT tag, can be **deposited** into a vault (quantity fixed at 1), and
  assigned to a beneficiary as a **specific bequest** — then carved out and distributed on
  execution via `execute_specific_asset`. Previously the wallet scanner skipped NFTs, so they
  couldn't be funded into a vault at all. Portfolio scanner includes NFTs from DAS
  (`amount: 1, decimals: 0, isNft: true`); DepositModal deposits exactly 1.

## [1.10.6] — 2026-07-03

### Added
- **MAX button on bequests.** Next to the Amount field, a MAX button fills the vault's full
  held amount of the selected asset — bequeath an entire (fractional) token balance in one
  tap. Disabled when the vault holds none.

## [1.10.5] — 2026-07-03

### Fixed
- **Bequests use the vault's assets, not the wallet.** The Bequests screen listed the
  owner's wallet portfolio, so a bequest could name an asset the vault doesn't hold — which
  distributes nothing and could stall execution. It now lists only the vault's holdings
  (distributable SOL + `getVaultTokenBalances`); wallet balances are used only for symbols.
- **A stalled distribution can't brick the vault.** All three cranks (app, notify-server,
  heir claim) now create the vault's token ATA idempotently before `begin_token_dist`, so a
  bequest for an unheld mint snapshots/pays 0 and finalizes instead of throwing
  `AccountNotInitialized` and freezing the owner out post-grace.

## [1.10.4] — 2026-07-02

### Fixed
- **Accurate vault-activation cost estimate (~0.033 SOL).** The review screen padded rent to
  ~0.015 and showed ~0.04 total; actual rent is ~0.008, so the real cost is ~0.033 (rent +
  0.01 fee + 0.01 agent + 0.005 keeper) — which is what the wallet correctly charges.
  Corrected the breakdown, total, and preflight. No transaction change.

## [1.10.3] — 2026-07-03

### Fixed
- **Bequests stay visible after setup.** The Bequests screen went blank after saving and
  on return, though the bequests were saved on-chain. The previous load ran once on mount,
  but React Navigation keeps the screen mounted, so it never re-loaded; `onSave` also
  cleared the list. It now reloads the on-chain plan on every focus (without clobbering
  unsaved edits) and after saving. The Vault overview's bequests row shows "Configured"
  when a plan exists.

## [1.10.2] — 2026-07-02

### Fixed
- **Transaction links restored in execution history.** The execution detail again shows
  each distribution transaction as a clickable Solana Explorer link. The history parser
  still looked for v1 instruction names and grouped sessions on the removed
  `record_execution` instruction, so it found nothing for v2 executions; it now identifies
  instructions on-chain by Anchor discriminator and groups one session per
  `begin_execution`. Verified against a real devnet execution.

## [1.10.1] — 2026-07-02

### Fixed
- **Bequests screen shows saved bequests.** It opened with an empty list and never
  loaded the on-chain `AssetPlan`, so already-configured bequests looked absent (they
  were saved and distributed correctly). It now loads the plan on open and displays your
  existing bequests, editable.

## [1.10.0] — 2026-07-02

### Added
- **On-chain keeper reward.** Each vault reserves a small bounty (0.005 SOL) that the
  program pays to whoever submits the final distribution transaction, making
  permissionless cranking profitable — so the estate can be distributed by anyone (a
  beneficiary, a keeper bot, or the watcher) who's rewarded for it, without depending on
  any single server. Stored in `VaultConfig` (reused padding — non-breaking), set at
  creation (opt out with 0), carved out of the SOL snapshot at `begin_execution` so it
  **never reduces beneficiary payouts**, and paid to the `finalize_execution` cranker.
  Program now 39 error codes; 23/23 tests; verified e2e on devnet.

## [1.9.0] — 2026-07-02

### Added
- **Beneficiary claim.** A new **Inheritances** screen lists vaults where the connected
  wallet is a beneficiary (auto-discovered via the notify-server, or imported by owner
  address), with each vault's status and your share. Once grace has elapsed,
  **"Distribute Estate"** lets the heir trigger the whole distribution from their own
  wallet — the same permissionless on-chain crank the app/watcher run, MWA-signed with
  the heir paying only network fees (they control nothing about destinations). Pure-SOL
  estates distribute in a single transaction; mixed estates run across passes,
  idempotent and resumable. First step toward a switch that needs no watcher server.
  (Server: read-only `GET /inheritances` discovery endpoint; no program change.)

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
