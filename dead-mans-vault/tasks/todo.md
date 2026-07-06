# BUILD — Permissionless Autonomous Execution + Specific Bequests

Spec: `BUILD-SPEC-permissionless-execution.md` (§18 overrides §3–§13). Implement in order.

## Phase 1 — On-chain program ✅ (compiles clean, IDL: 18 ix / 5 accounts)
- [x] constants.rs: MAX_ASSIGNMENTS, static asserts, mask helpers
- [x] state: VaultConfig / ExecutionLog / token_dist / asset_plan
- [x] errors.rs: new codes
- [x] util.rs: deadline / grace_elapsed / lower_index_same_mint_mask / largest_share_index
- [x] ix: set_asset_plan / update_asset_plan (NFT shape client-side per B4)
- [x] ix: begin_execution (grace+heartbeat here ONLY, B1)
- [x] ix: begin_token_dist (un-spoofable ATA, B3)
- [x] ix: execute_specific_asset / execute_sol_shares / execute_token_shares
- [x] ix: finalize_execution / close_token_dist
- [x] B2: core close = close_executed_vault_by_owner (owner-signed; also closes AssetPlan + SOL dust). NO permissionless close_vault.
- [x] ix: R8/B1 freeze on update_vault/withdraw_*/revoke/rotate/record_heartbeat
- [x] revoke_vault closes AssetPlan too (re-init unblock)
- [x] deleted execute_sol_distribution/execute_distribution/record_execution/close_executed_vault(agent)/close_vault_ata
- [x] lib.rs + mod.rs wiring, Cargo.toml features
- [x] adversarial code review of new fund-moving code
  - [x] CRITICAL: begin_token_dist derived canonical ATA from caller-supplied token_program → spoof to zero-snapshot. FIXED (derive from mint.owner, dropped token_program account).
  - [x] MEDIUM: orphan token residuals on premature owner-close. FIXED (open_token_dists counter, ==0 guard in owner close).
  - [x] LOW: pin canonical ATA in execute_token_shares/close_token_dist. FIXED.
  - [ ] LOW (fast-follow, documented): Token-2022 transfer-fee mints can leave non-zero ATA → close_token_dist stuck. Not fund loss. Out of v1.
- [x] rebuild clean after fixes

## Phase 2 — Tests (§10) ✅ 20/20 passing (~96s on local validator)
- [x] full matrix: permissionless e2e by random keypair, 6 theft cases, idempotency, edge, freeze gates
- [x] regression test for the CRITICAL begin_token_dist spoof
- NOTE: local validator gossip port 8000 collides with Agora FastAPI → ran standalone
  `solana-test-validator --gossip-port 9300 --dynamic-port-range 9301-9400 --rpc-port 8899`
  and drove ts-mocha via ANCHOR_PROVIDER_URL/ANCHOR_WALLET. (document in CLAUDE.md?)
- NOTE: set_asset_plan single-tx caps at ~18 assignments (1232-byte tx limit; 64 is storage cap).
  Client UI must warn / chunk for >18. → Phase 4 / fast-follow.

## Phase 3 — Deploy ✅ devnet
- [x] extended ProgramData +200KB (new .so 580KB > old 415KB alloc)
- [x] anchor deploy devnet — binary live (slot 472990054, data 615KB)
- [x] IDL account close+reinit (new IDL 4989B > old 4696B alloc)
- [x] IDL + types re-sync → app/src/utils/ (idl.json, dead_mans_vault.ts, +dupes)

## Phase 4 — Client (§8) ✅ tsc clean, reviewed
- [x] ExecutionService → §7 mask-driven crank (batched ≤8, agent payer, idempotent/resumable)
- [x] VaultTransactionService → all permissionless crank builders + setAssetPlan/updateAssetPlan + readers; heartbeat added to owner builders; close/revoke pass optional assetPlan/largestBenef
- [x] Beneficiary shape {wallet,shareBps} across types/screens (hasSpecificAssets kept as UI-only flag)
- [x] AGENT_FUNDING 0.05 → 0.01 (+ pre-flight 0.07→0.03)
- [x] BequestsScreen (pick asset, assign to benef by index, ≤1/NFT, hard-cap 18, over-alloc warning) wired into SetupStack
- [x] code review: no fund-misdirection bugs; FIXED idempotent ATA creation (race-safety) + largestBenefAta only-when-dust
- KNOWN (fast-follow): owner withdraw builders hardcode legacy Token (Token-2022 owner withdrawal unsupported, §14); pre-execution withdraw-all no longer closes emptied vault ATAs (~0.002 SOL/ATA, reusable on re-deposit, recovered at execution close_token_dist)

## Phase 5 — Notify-server (§9) ✅ LIVE + e2e validated on devnet
- [x] FIXED parseVaultConfig (34B beneficiary layout — old code misread active/executed on new program)
- [x] executor.js — §7 crank via Anchor + IDL + cranker keypair (begin→specifics→sol→finalize→token→close_token_dist; batched ≤8; ensures benef ATAs; NO core close per B2)
- [x] wired into poller (crank at stage 4) + /execute-now endpoint + /health executorReady
- [x] cranker keypair generated + funded 0.5 SOL (gitignored); EXECUTOR_ENABLED=1 in live .env
- [x] dmv-notify.service restarted — executorReady:true, cranker 9x7nyDZG…
- [x] E2E: fresh vault, 0.2 SOL deposit, 44s grace, server cranked → ben1 70%/ben2 30% EXACT, executed+completed ✅

## Phase 6 — Ship
- [x] version 1.7.0 / versionCode 65 (NOTE: v1.6.4/64 was already released — 65 is the next free code)
- [x] APK built: dead-mans-vault-v1.7.0.apk (70MB, embedded versionCode 65 verified via aapt2)
- [x] emulator smoke test attempted — APK is arm64-v8a only (Seeker target), can't run on x86_64 VPS emulator (missing x86_64 NDK libs: libexpo-modules-core/libexpo-sqlite/librnscreens). arm64 slice complete; JS boot NOT verifiable on this emulator without an x86_64-inclusive throwaway build.
- [x] GitHub release v1.7.0 CUT (2026-07-01) — deleted v1.6.4, created v1.7.0 as Latest with APK attached; /releases/latest → v1.7.0 (dmv.palatinearc.com serves it). Repo: Romulus-Sol/DMV.
- [x] USER: sideloaded on Seeker, confirmed boot, full on-device cycle validated through v1.7.4 (server crank + close & reclaim rent both confirmed on device)
- NOTE: live server has 0 registrations; old-program vaults (pre-redeploy) won't decode — runExecutor returns no_vault/errors caught. Clear any stale DB rows if they appear.

## Phase 7 — Post-launch fixes (v1.7.1 → v1.7.4) ✅ shipped, on-device confirmed
- [x] v1.7.1: fixed duplicate escalation notifications (local timeline + FCM overlap); new VPS-served website (`dmv.palatinearc.com`, off GitHub Pages via Caddy), logo + favicon, dropped CF-injected debug error overlay
- [x] v1.7.2: **0.01 SOL vault-creation fee, on-chain enforced** (`initialize_vault` `fee_recipient` pinned to `FEE_WALLET` 98x9Rn63Ne8xbL3w522zgbuYg9bdHn7cRqJQVCUZUFsp + CPI transfer, `VAULT_CREATION_FEE_LAMPORTS`, `InvalidFeeRecipient`); executed-vault "Close & Reclaim Rent" in Settings; notification copy rewrite
- [x] v1.7.3: **notifications now server-only** — removed the on-device local OS timeline (double-fired); notify-server is the single source; poll 60s→15s (was skipping short demo stages); added `[fcm] ACCEPTED/REJECTED` logging + secret-gated `/debug/push`; FCM delivery verified incl. killed-app; Total Est. Cost corrected to 0.035 SOL; Settings shows "Executed"
- [x] v1.7.4: fixed stale "Configure Heartbeat" tick after autonomous execution — app now recognizes on-chain `vaultConfig.executed` and shows the "Vault Executed" summary instead of the partial wizard
- [x] docs updated for the fee, server-only notifications, executed-vault close, VPS website (README ×2, notify-server README + .env.example, CLAUDE.md, IMPLEMENTATION.md, CHANGELOG through v1.7.4)

## Fast-follows (backlog)
- [x] Specific-**SOL** bequests — DONE (shipped v1.8.0: `execute_specific_sol` + `begin_execution` carve-out via zero-pubkey sentinel mint; 22/22 tests; devnet e2e verified)
- [x] **Serverless triggers — Phase 1 (Beneficiary Claim)** — DONE (shipped v1.9.0; spec `BUILD-SPEC-serverless-triggers.md`): `GET /inheritances?wallet=` + `InheritancesScreen` (auto-discovery + manual import) + `ClaimService.runClaim` (heir-paid MWA crank, resumable) + `buildClaimTransactions`/`buildCloseTokenDistTransactions`. No program change (execution already permissionless)
- [x] **Serverless triggers — Phase 2 (On-chain keeper bounty)** — DONE (shipped v1.10.0): `VaultConfig.keeper_bounty` (from padding, non-breaking) + `initialize_vault` param (`KEEPER_BOUNTY_LAMPORTS`=0.005 SOL) + `begin_execution` carve-out + `finalize_execution` pays the finalize cranker; 23/23 tests + devnet e2e. Known: keeper fronts the ExecutionLog rent (~0.00185 SOL) → net ≈0.003 SOL
- [x] **NFT support end-to-end** — DONE (v1.11.0–v1.11.1): `PortfolioScanner` includes DAS NFTs (`isNft`/`image` on `TokenBalance`), `DepositModal` deposits 1, Bequests picker + `execute_specific_asset` distribute NFTs, `AssetsScreen` Tokens·NFTs·DeFi tabs + Dashboard inline NFTs section, notify-server `/nft/<id>.json` metadata
- [x] Cranker **fee reimbursement** — addressed by the Phase 2 keeper bounty (finalize cranker earns the reward; proportional multi-cranker split is a further fast-follow)
- [ ] **Serverless triggers — Phase 3 (Mutual keeping)** — living owners' heartbeats crank expired vaults for the bounty; opt-in, rides on Phase 2 (no program change). Spec `BUILD-SPEC-serverless-triggers.md` §4
- [ ] Token-2022 **owner-withdraw** (`withdraw_from_vault` is legacy-Token only)
- [ ] `set_asset_plan`/`append_asset_plan` **>18 assignments** chunking/append ix (single tx caps ~18; storage cap 64)
- [x] Token-2022 transfer-fee mints stuck `close_token_dist` (withheld fees block CloseAccount) — **FIXED v1.13.12**: app, keeper-bot, and notify-server all harvest withheld fees to the mint before `close_token_dist` (permissionless, atomic via preInstructions)
- [ ] Harmless dev-console error from Cloudflare's injected bot-detection script on `dmv.palatinearc.com` (overlay suppressed; benign)

## Docs
- [x] CLAUDE.md (/root/DMV/CLAUDE.md) refreshed for v2 (accounts, instructions, error codes, escalation, execution crank, permissionless model section, notify-server, test coverage, gotchas)
- [x] README.md refreshed for v2 + committed + pushed to pre-prod (default branch, live on GitHub)
- [x] whole feature committed (281a2c6 on-chain / f035f98 client / 9823cda server) + pushed to pre-prod
- [x] git remote URL fixed → origin = Romulus-Sol/DMV with working PAT (plain git push/pull work)

## Phase 8 — Tokenized stocks (RWA) + transfer-fee close + setup fixes (v1.13.9–v1.13.13) ✅ shipped, on-device confirmed
- [x] **Stocks tab (v1.13.9)** — `Assets → Stocks` + Dashboard section for Token-2022 tokenized equities; known-mint registry + `[A-Z]{2,6}x` heuristic; Tokens tab excludes them
- [x] **Stocks-invisible fix (v1.13.10)** — separate-module classifier import resolved `undefined` under Hermes → threw in the parse loop → hid ALL Token-2022 tokens; inlined into PortfolioScanner + RPC fallback now enumerates both token programs
- [x] **Deposit correctness + guards (v1.13.11)** — `transfer_checked` deposit (unchecked is rejected by fee/pausable mints, so real xStocks couldn't deposit); pre-sign `checkDepositable` blocks non-transferable/frozen/hook/paused + warns on transfer-fee; Bequests picker shows stock names
- [x] **Executed-vault close runs on-chain (v1.13.12)** — revokeVault executed branch now closes remaining TokenDists + core PDAs on-chain (rent reclaimed) and surfaces real errors, instead of silently “cleared local data” (which let the vault reappear on restart)
- [x] **Transfer-fee close fix (v1.13.12)** — harvest withheld fees before `close_token_dist` in ALL THREE cranks (app, keeper-bot, notify-server); withheld fees in the vault ATA otherwise block CloseAccount → `open_token_dists` stuck → whole close blocked
- [x] **Setup wizard re-sync (v1.13.12)** — re-fetch on-chain vault state on focus even when set-up, so an executed vault shows the “Vault Executed” summary, not a stale editable wizard with old beneficiaries
- [x] **Stale “Configure Heartbeat ✓” fix (v1.13.13)** — the persisted `heartbeat_config` draft (SQLite, re-hydrated by App.tsx) is now deleted by Start Over + revoke; an in-memory reset alone re-appeared on restart
- [x] Docs updated (this round): CHANGELOG [1.13.9–1.13.13], README (version + stocks/RWA feature + Assets split), notify-server + keeper-bot READMEs (harvest note), website (v1.13.13 + stocks feature card), TOKEN2022-RWA-SUPPORT (fee-close fixed)
