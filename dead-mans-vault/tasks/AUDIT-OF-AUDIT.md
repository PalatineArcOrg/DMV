# Audit-of-the-Audit — DMV mainnet documentation

**What this is:** a multi-lens review of the audit documentation itself (`AUDIT-SCOPE.md`, the reconciled spec, `MAINNET-CUTOVER-RUNBOOK.md`, `MAINNET-READINESS.md`), run 2026-07-05. Four independent read-only agents each applied a different installed Solana skill; the orchestrator then **re-derived every load-bearing claim against the program code** (file:line) before accepting it. No files were modified by the agents.

**Lenses:** `solana-code-review` (program security/correctness) · `solana-dev` (Anchor-idiom security) · `deploy-to-mainnet` (deploy mechanics) · `build-defi-protocol` (fund-flow/economics).

## Headline verdict
The audit brief is **high-quality and factually accurate** — all four lenses independently concluded its §5 threat model and §6 invariants already name the hardest real risks (ATA-spoof, orphaned-mint, CEI/transfer-hook, conservation, freeze monotonicity, bounty griefing, dust redirection, rent races, re-init/revival). **No fund-theft or conservation bug was found by any lens.** The actionable output is: **4 doc-accuracy fixes** to the brief, **a handful of coverage gaps** to add, **several deploy-mechanics fixes** to the runbook (the weakest area), and **Token-2022 test coverage**. These are refinements, not a rewrite.

Severity note: the program findings are **Low/Info code-severity** (safe-but-should-be-scoped). The two "Critical" items are **deploy-day operational** (a command that will fail), not program vulnerabilities.

Verdict tags below: **[VERIFIED]** = orchestrator re-derived it against code; **[SOUND]** = well-established tool behavior; **[PLAUSIBLE]** = reasonable, not independently re-run.

---

## A. Brief doc-accuracy fixes (`AUDIT-SCOPE.md`) — these would mislead an auditor

**A1 — §5(b) CEI claim is over-broad.** [VERIFIED — 2 lenses]
The brief says "verify the paid bit is set **before** the transfer CPI in *every* `execute_*` (SOL direct-lamport, token, specific-asset, specific-SOL)." The two **direct-lamport** paths correctly set the bit **after** the debit — `execute_sol_shares.rs:80` (debit :66–72), `execute_specific_sol.rs` (debit before bit) — which is safe because a bare lamport move runs no callee code (no reentrancy). Only the **token-CPI** paths need CEI (`execute_token_shares.rs:100` before transfer :115; `execute_specific_asset.rs:132` before :150). As written, an auditor applying §5(b) literally would false-positive-flag the two SOL paths. **Fix:** scope CEI-before-CPI to token-program (hook-surface) paths; for direct-lamport paths the correct invariant is "bit set atomically within the instruction."

**A2 — §5(b) says the bounty "can't be claimed without completing the work" — not enforced.** [VERIFIED — 2 lenses]
`finalize_execution.rs` gates only on `sol_paid_mask` full (:42) and the plan mask full (:54), then pays `keeper_bounty` to the `payer` Signer (:80–82). The masks are filled by *whoever* ran the setup ixs; a free-rider who lands only the final `finalize` tx collects the whole bounty having fronted no rent and done no setup. It's not theft (beneficiary amounts untouched), but the incentive claim is false. **Fix:** reword to "the bounty rewards the finalize-lander, not necessarily the party that did the setup work (a known free-rider structure); confirm this is acceptable or bind the reward to work done."

**A3 — §5(a) mis-describes the heartbeat freeze mechanism.** [VERIFIED — 2 lenses]
The brief says "verify `record_heartbeat` is blocked once `ExecutionLog` exists / `executed`." The code does **not** reference `ExecutionLog`; it blocks via `require!(now < deadline) → VaultFrozen` (`record_heartbeat.rs:40`) plus the `!executed` constraint (:14). Outcome is equivalent (time is monotonic), and the spec §0.5/B1 states it correctly — but the brief sends the auditor chasing a mechanism that isn't there. **Fix:** align §5(a) to the deadline-based freeze.

**A4 — the "64 assignments" completability worst-case is not constructible; real cap ≈18.** [VERIFIED — matches CLAUDE.md gotcha #16]
`set_asset_plan`/`update_asset_plan` take the whole assignment list as **instruction data** (42 B each) in one atomic tx; 64×42 ≈ 2,700 B exceeds the 1,232-B tx limit and ALTs don't compress instruction data. There is no append path; the test suite caps at 18. So `MAX_ASSIGNMENTS = 64` is unreachable, `full_mask_u64(64)`/`TooManyAssignments` are effectively dead, and the owner pays rent for ~2,700 B of `AssetPlan` capacity that can't be filled. **Fix:** correct §5(b)/§6-Inv-4 to the real ~18 cap (or note a chunked/append ix is required if 64 is a product goal).

---

## B. Coverage gaps to add to the brief (§5/§6)

**B1 — `open_token_dists` is not a sound close-safety invariant in BOTH directions.** [VERIFIED — new, code-review lens]
The brief flags the orphan direction (counter stays 0 → premature close orphans a held-but-undistributed mint). It misses the **opposite**: `begin_token_dist` has **no `!executed`/lifecycle guard** (`begin_token_dist.rs:8–9, 33`) and uses strict `init`, while `close_token_dist` frees the `TokenDist` PDA (`close = payer`). So **after finalize + close**, anyone can re-`init` a `TokenDist` for a *bequeathed* mint at `bal == 0` (the `NothingToDistribute` guard passes on `mint_in_plan`, `:115`), re-incrementing `open_token_dists` (:126) and **indefinitely blocking the final core-PDA close/rent-reclaim** (both closes require `== 0`). *No inheritance impact* (assets already delivered) and recoverable (defender bundles create→distribute→close→close_executed_vault; griefer burns rent each cycle) → **Low code-severity**, but a real griefing vector on rent cleanup. **Fix:** scope "`open_token_dists` integrity / final-close liveness under adversarial `begin_token_dist` re-open and post-finalize deposits" as an explicit §6 invariant.

**B2 — post-snapshot inflows are redistributed to the single largest-share heir, not pro-rata.** [VERIFIED — defi lens]
The SOL pro-rata snapshot freezes at `begin_execution`; any SOL arriving after (staking rewards, airdrops, up to the 24h close window) is "above rent" and swept **in full to the largest-share beneficiary** on close (`close_executed_vault.rs:15–16, 86–87`), not split by `share_bps`. Same for tokens after `begin_token_dist`. The brief's §5(b) "bound total stranded dust" implicitly assumes dust = rounding remainder (`< n_benef` units); it doesn't consider arbitrarily large late inflows. **Fix:** add "post-snapshot inflow allocation" to the conservation/fairness scope; decide if largest-heir-takes-all is acceptable for an estate with post-mortem income.

**B3 — `execute_sol_shares` rent-exemption is emergent, not locally enforced.** [VERIFIED — 2 lenses]
`execute_sol_shares.rs:66–72` debits with only `checked_sub` — no local `rent_min` reservation (unlike `execute_specific_sol.rs:83–84` and `finalize_execution.rs:73`, which both clamp to `lamports − rent_min`). Rent safety holds today purely as an emergent property of the `begin_execution` snapshot math (`snapshot = distributable − Σspecific-SOL − keeper_bounty`, all saturating). **Fix:** record invariant #7 as *non-local* for this path (a future change to the snapshot formula could silently let pro-rata drain below rent); recommend an explicit clamp as defense-in-depth.

**B4 — keeper-bounty *viability* (not just safety) is unscoped.** [PLAUSIBLE — defi lens]
The bounty is flat 0.005 SOL default / 0.1 SOL cap, paid once. Crank *cost* scales with the vault (per-assignment + per-mint + per-batch txs + fronted init rent). Even at the real ~18-assignment cap (A4), a multi-mint vault can be tens of txs — plausibly loss-making vs. a ≤0.1 SOL reward, so the most valuable estates are the least profitable to crank permissionlessly. Since permissionless liveness is the product's backstop, **add a "model crank-cost vs. bounty across the worst realistic vault" item to §5(b).**

**B5 — phantom-bequest completability.** [VERIFIED — Anchor lens; mitigated by CLAUDE.md gotcha #21]
A specific bequest for a mint the vault does **not** hold: `execute_specific_asset` requires a live `vault_ata`, which doesn't exist, so its bit never sets → `finalize` can never complete → the whole vault stalls. Recoverable (a crank creates the empty vault+beneficiary ATAs, then it pays 0 and finalizes) — the three cranks already do idempotent ATA creation (gotcha #21) — but it's an on-chain completability dependency on off-chain behavior. **Fix:** name it in §5(b); consider rejecting unheld-mint specific assignments at plan-set, or making `execute_specific_asset` tolerate an absent vault ATA (treat as 0).

**B6 — the close-path dust sweep hard-requires the *largest heir's* ATA.** [SOUND — defi lens]
`close_token_dist` sweeps *any* dust (`> 0`, even a few base units) and **requires** `largest_benef_ata` to exist/be-transferable. If that ATA is missing/frozen/non-createable (default-frozen or non-transferable mint), the close reverts → the permanent-block cascade — triggered by trivial rounding dust, even after every actual bequest succeeded. Distinct from (and easier to hit than) the pro-rata "failed beneficiary ATA" case already in §5(c). **Fix:** add to §5(c).

**B7 — generalize the ATA-spoof (B3) invariant to *all* raw-deserialized token accounts.** [SOUND — Anchor lens]
`TokenAccount::try_deserialize` on raw bytes performs no owner-program check. The vault ATA is address-pinned everywhere (good), but beneficiary ATAs in `execute_token_shares` `remaining_accounts` are raw-deserialized and validated only by the downstream `transfer_checked` CPI. Safe today; a future refactor paying from a live-read balance would reopen the exact Critical class. **Fix:** state the general invariant "every raw-deserialized token account is address-pinned or CPI-validated."

**B8 — degenerate-config classes unscoped (Info).** Duplicate beneficiary **wallets** aren't rejected (`initialize_vault` checks only owner-exclusion + share-sum); duplicate non-NFT `(mint, beneficiary)` assignments aren't deduped. Neither breaks conservation, but §6 Inv 1–3 should confirm conservation under degenerate plans.

---

## C. Runbook + readiness fixes (`deploy-to-mainnet` lens — the weakest area)

**C1 — deploy routes to the PUBLIC RPC, not Helius.** [SOUND — Critical for deploy day]
Runbook Step 5 `anchor deploy --provider.cluster mainnet` resolves the `mainnet` moniker to `api.mainnet-beta.solana.com` — **not** `<MAINNET_RPC>` — despite the runbook's own pre-flight provisioning Helius and warning that public RPC 429s. A ~602 KB program is dozens of buffer-writes; on the public endpoint it routinely rate-limits and strands a partially-funded buffer. **Fix:** deploy through `<MAINNET_RPC>` (`solana config set --url <MAINNET_RPC>` + `solana program deploy --use-rpc`, or pass the URL as the provider cluster). Same for the `--url mainnet-beta` reads in Steps 5/9/10.

**C2 — the Squads multisig upgrade-authority handoff command will fail.** [SOUND — Critical]
`solana program set-upgrade-authority … --new-upgrade-authority <UPGRADE_AUTH>` aborts with "new authority is not a signer" when the target is a Squads vault PDA, unless `--skip-new-upgrade-authority-signer-check` is passed. Risk: an operator "fixes" it by pointing at a hot key, silently defeating the multisig on the program that governs every vault. **Fix:** add the flag, specify the Squads **vault PDA** (not the multisig account), and rehearse a full propose→approve→execute upgrade on devnet before mainnet handoff.

**C3 — deployer budget "~5 SOL" is under-budgeted ~2–2.5×.** [VERIFIED against the real `.so`]
The artifact is **616,736 bytes**. `solana rent 616736` = **4.29 SOL** for a 1× account; the upgradeable loader reserves **2× program size** for the program-data account → **~8.6 SOL** rent-exempt, and the deploy **buffer** (1×, ~4.3 SOL) coexists with it before refund → **peak ~10–13 SOL on hand**, settling to ~8.6 SOL. "~5 SOL" (readiness §1.2 + runbook) risks an out-of-funds abort mid-deploy that strands the buffer. **Fix:** fund ~12–13 SOL; compute from the real binary.

**C4 — no priority fee / compute-unit price / buffer-resume / stranded-buffer recovery.** [SOUND]
No `--with-compute-unit-price`, `--max-sign-attempts`, or documented `solana program show --buffers` → `solana program close --buffers` recovery. A large-program deploy without priority fees frequently fails during congestion, and a stranded buffer is ~4+ SOL of real, silently-locked rent. **Fix:** add priority-fee flags + a buffer-recovery step.

**C5 — no verifiable/reproducible build + no post-deploy bytecode check.** [SOUND]
Plain host `anchor build` isn't reproducible, and Step 5's "verify" only checks authority/size, never bytecode. For an audited, funds-custody program: produce a `solana-verify` build from the pinned tag (`audit-2026-07-05b`, Agave 3.0.15 / Rust 1.89.0), publish the hash + the one-constant (FEE_WALLET) diff from the audited commit, and after deploy `solana program dump` + sha256-compare to confirm on-chain == artifact. Entirely absent.

**C6 — readiness lacks a "Squads provisioned + timelock configured + upgrade rehearsed" blocker; and the handoff is sequenced before the smoke test.** [SOUND]
AUDIT-SCOPE §7 commits to a 2-of-3 Squads with timelocked upgrades, but nothing gates: create the multisig, confirm all 3 signers hold working keys, configure+verify the timelock, and rehearse an upgrade. Also, Step 5 hands authority to the multisig **before** the Step 12 first-funds smoke test — so a bug found in Step 12 needs the full ceremony, and the Abort section's "just `anchor upgrade`" is then wrong (see C8). **Fix:** add the readiness blocker; keep authority on the deployer through Step 12, transfer after.

**C7 — cranker liveness is manually watched; no alerting, no fallback RPC.** [SOUND]
Readiness §5 / runbook Step 13 say "top up before they drain" and "watch journalctl." A drained notify/keeper cranker = vaults never execute = beneficiaries never inherit (an availability-Critical by the brief's own §5). And a single Helius endpoint is a shared SPOF for deploy + app + both crankers. **Fix:** automated balance-threshold + crank-failure alerting; a fallback RPC; first-hour `solana logs <PID>` after deploy.

**C8 — inaccurate rollback line.** [VERIFIED] Runbook Abort section: "you can `anchor upgrade` a fix (upgrade authority = `<UPGRADE_AUTH>`)." After Step 5 that's the multisig, so a plain deployer `anchor upgrade` won't work. **Fix:** reword to the multisig ceremony (or re-sequence per C6).

**C9 — cheap gates missing (Info):** no secrets/keypair-in-git check before placing real-SOL cranker keypairs + `.env` on the VPS; IDL authority left on the hot deployer while program authority moves to the multisig; no `cargo audit`/`yarn audit`. Add all three.

*Affirmed correct by the deploy lens:* program-keypair reuse → no program-ID propagation (verified against `lib.rs:12`, `Anchor.toml`, `constants.ts:3`); the FEE_WALLET three-place sync; the bundle-level devnet scrub in Step 8; the first-funds smoke gate (Step 12); IDL init-vs-upgrade for a first deploy; the prod-floor CI gate; the wallet-cluster and eas-env fixes.

---

## D. Test-coverage gaps (the brief prioritizes failure modes the tests don't exercise)

- **Token-2022 extension mints — none tested** (High). Every token test uses a plain mint. The brief's §5(c) names transfer-hook / non-transferable / default-frozen / permanent-delegate / transfer-fee as *the* bricking modes — unverified. This is where an inheritance vault most plausibly bricks.
- **Max-config completability — untested** (High). Largest exercised: 18 assignments, batches of 2–3. No end-to-end near-max `begin→finalize→close` proving tx-size/CU/ALT fittability.
- **Orphaned-held-mint + `open_token_dists` re-open — untested** (High/Med). The brief's headline residual risk (B1) has no scenario test.
- **Frozen/missing beneficiary ATA + duplicate-account/duplicate-index in one batch — untested** (Med/Low). Safe via mask idempotency, but unproven.

---

## E. Code observations (all SAFE — affirmations + defense-in-depth)

**No fund-theft or conservation bug found across four lenses.** Affirmed strengths (verified): strict `init` everywhere (no `init_if_needed`); secure manual close (drain → `assign(system)` → `resize(0)`, no revival); checked arithmetic with u128 widening; canonical stored bumps; **ATA-spoof Critical genuinely closed** — canonical ATA pinned from `*mint.owner` on all four token paths, regression-tested (`tests:1187-1221`); index-equality on every payout; monotonic deadline freeze with no un-freeze TOCTOU; fee un-skippable + pinned.

Defense-in-depth (safe today, worth hardening): local rent clamp in `execute_sol_shares` (B3); explicit `token_program == *mint.owner` pin on the execute/close token paths (currently indirect via CPI failure); a standing "no live-balance re-read after a transfer CPI" invariant; a `!executed`/lifecycle guard on `begin_token_dist` (B1).

---

## Cross-lens convergence (confidence signal)

| Finding | Lenses agreeing | Verdict |
|---|---|---|
| §5(b) CEI over-broad (A1) | code-review + Anchor | VERIFIED |
| Bounty free-rider (A2) | defi + Anchor | VERIFIED |
| `execute_sol_shares` rent emergent (B3) | defi + Anchor | VERIFIED |
| §5(a) freeze mechanism (A3) | code-review + Anchor(+spec) | VERIFIED |
| Token-2022 close-path / extension coverage (B6, D) | defi + code-review | SOUND |
| No theft/conservation bug | all four | VERIFIED |

Single-lens but verified: `open_token_dists` re-open (B1), post-snapshot inflow (B2), 64→18 cap (A4), deploy budget (C3), deploy-transport/multisig-flag (C1/C2).

---

## Bottom line & recommended actions
The brief and program are sound; this pass produced **refinements, not a rewrite**, and **no new vulnerability**. Priority order:
1. **Brief doc fixes** (A1–A4) — quick, prevent auditor false-positives / wrong worst-case.
2. **Runbook deploy-mechanics** (C1–C3 first) — two will fail on deploy day; the budget is ~2× short.
3. **Add invariants** (B1–B3) and the **Token-2022 test coverage** (D) — the highest-value new scope for the external auditor.
4. Fold the rest (B4–B8, C4–C9) into the brief/runbook as scoped items.

*Prepared 2026-07-05 by a 4-skill read-only audit + orchestrator code-verification. Source lenses: solana-code-review, solana-dev, deploy-to-mainnet, build-defi-protocol.*
