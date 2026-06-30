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
- [ ] GitHub release: HELD per user — they sideload + verify on Seeker first, then I cut it (delete v1.6.4, create v1.7.0 w/ APK; repo redirects PalatineArcOrg/DMV → Romulus-Sol/DMV)
- [ ] USER: sideload dead-mans-vault-v1.7.0.apk → Seeker, confirm boot, then full app-closed e2e (server path already proven via standalone devnet e2e)
- NOTE: live server has 0 registrations; old-program vaults (pre-redeploy) won't decode — runExecutor returns no_vault/errors caught. Clear any stale DB rows if they appear.

## Docs
- [x] CLAUDE.md (/root/DMV/CLAUDE.md) refreshed for v2 (accounts, instructions, error codes, escalation, execution crank, permissionless model section, notify-server, test coverage, gotchas)
- [x] README.md refreshed for v2 + committed + pushed to pre-prod (default branch, live on GitHub)
- [ ] (optional) git remote URL has stale PAT + old org; push works via /root/.github_token + redirect
