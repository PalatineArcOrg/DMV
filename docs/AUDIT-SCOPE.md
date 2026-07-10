# Security Audit — Scope & Brief

**Project:** Dead Man's Vault (DMV) — a non-custodial **crypto inheritance** protocol on Solana. An owner deposits assets into a vault PDA and proves liveness via periodic heartbeats. When heartbeats stop and a grace period elapses, the program distributes the assets to pre-set beneficiaries. **Execution is permissionless** — the program computes every payout from frozen on-chain state, and *any* signer can submit the distribution transactions; no privileged executor, no protocol-held keys.

**Why we're auditing:** the program moves a user's **entire estate**, irreversibly, and its core promise is that *funds will reach beneficiaries when the owner dies*. Both **theft** (misdirected funds) **and permanent-block DoS** (funds that can never be inherited) are Critical for this design. We want an independent audit before a mainnet-beta launch with real funds.

> **On the code's maturity:** two internal review rounds have been done — a **multi-agent LLM adversarial review** (which surfaced a real *Critical*, the `execute_specific_asset` ATA-spoof) and an LLM-driven hardening pass. These are **not human audits** and we are not treating them as sufficient. Treat the code fresh.

---

## 1. Trust model & assumptions

| Trusted | Not trusted / must be constrained by the program |
|---|---|
| **Owner wallet** (MWA) — signs setup/config; frozen once the deadline passes | The **cranker/`payer`** on every execution ix — can be *anyone*; must control nothing about recipients/amounts/timing |
| **Program upgrade authority** — see §7 (**the key trust decision**) | Beneficiaries, keepers, and any third-party submitter |
| Solana **`Clock`** (validator time) — grace is measured against it | The **agent key** for anything but heartbeats (but note: a compromised agent key can forge heartbeats → see §5) |
| The **off-chain crank operators** for *liveness* (not for authority) | RPC providers / indexers |

Assumption to state explicitly and have the auditor weigh: **availability of the distribution depends on the off-chain crank driving the on-chain instructions to completion.** The program enforces *who/where/when/how-much*, but it cannot force the crank to run — see §3 and §5(b).

---

## 2. Codebase facts

| | |
|---|---|
| Framework | **Anchor 0.32.1** (`anchor-lang`/`anchor-spl` 0.32.1); compiles against **`solana-program` 2.3.0** |
| Toolchain | **Rust pinned to 1.89.0** (`rust-toolchain.toml`); built with the **Agave/Solana CLI 3.1.10**. CI installs the same 1.89.0. |
| Program source | **31 `.rs` files, ~2,700 LOC**, `programs/dead-mans-vault/src/` |
| Instructions | **21** (12 owner/setup + 9 permissionless execution) |
| State PDAs | **5**: `VaultConfig`, `HeartbeatRecord`, `ExecutionLog`, `AssetPlan`, `TokenDist` |
| Error codes | **45** (`errors.rs`) |
| Tests | **29** integration tests (~1,450 LOC, ts-mocha), pass **locally** via `yarn test:devnet`. **CI runs only** the host-only prod-floor guard (`cargo test --lib`, asserts the timing minimums per build profile) — the full suite is **not** CI-gated. |
| Fuzzing | **9-property litesvm + fast-check suite** (`dead-mans-vault/tests/fuzz/`, `yarn test:fuzz`) covering the §6 invariants — conservation, idempotency, specific-bequest carve-out, a theft-must-revert battery (exact error codes), post-deadline freeze, Token-2022 transfer-fee close, NFT bequests + residual dust-at-scale, and a **stateful instruction-sequence fuzzer** (random orderings vs 7 global invariants). Runs against the **real production floors** via clock-warp. Found no program bug. See `FUZZ-HARNESS-PLAN.md`. |
| Crank stress | Local-validator + fault-injecting-RPC-proxy harness (`keeper-bot/stress/`) exercising the crank under 429s/timeouts/concurrent races — RPC failure & racing are correctness-safe. See `STRESS-TESTING-PLAN.md`. |
| Token support | SPL Token **and** Token-2022 (`token_interface` / `InterfaceAccount` / `transfer_checked`) |
| Deployed | devnet `GXCu5964mvgAJDWmcMriZpzU3vDVqPzjYCM1sxCnsoEb`; mainnet reuses the same program keypair (same ID) |

Largest files (auditors size per-instruction): `execute_specific_asset.rs` 154, `lib.rs` 141, `initialize_vault.rs` / `close_token_dist.rs` / `close_executed_vault.rs` 135, `errors.rs` 132, `begin_token_dist.rs` 129, `execute_token_shares.rs` / `close_executed_vault_by_owner.rs` 120, `set_asset_plan.rs` 103, `execute_specific_sol.rs` 102, `begin_execution.rs` 98.

Repo: `https://github.com/Romulus-Sol/DMV`, license MIT (repo root `LICENSE`).

---

## 3. Scope

**Primary (the trust boundary):** the Anchor program — **all 31 `.rs` files** under `programs/dead-mans-vault/src/`.

**Elevated to primary — liveness/completability of the permissionless flow.** The §7 crank sequence is replicated in three callers (`app/`, `notify-server/src/executor.js`, `keeper-bot/`). These hold **no fund authority** (they only pay fees), so *theft* review is light — **but the correctness of the on-chain program depends on the crank driving it to completion** (orphaned-token invariant, tx-fittability, transfer-hook account passing). We ask the auditor to assess **whether the permissionless flow is always completable and cannot be permanently blocked**, treating the crank logic as in-scope for that question (the specific TypeScript implementation review can be lighter).

**Secondary (optional):** client-side transaction building in the mobile app (`VaultTransactionService.ts`, `ExecutionService.ts`, `ClaimService.ts`).

**Out of scope:** TEE/agent-key device custody (Android Keystore), mobile UX, RPC/notify-server infrastructure, economic-parameter assumptions, and all `tasks/*.md` (reference only — see §8).

---

## 4. Instruction surface (20)
- **Owner / setup (all freeze once `now >= deadline`):** `initialize_vault` (CPIs a 0.01 SOL creation fee to the hard-coded `FEE_WALLET`, pinned by an `address =` constraint), `update_vault`, `set_asset_plan` / `update_asset_plan` (specific bequests: SOL + SPL + NFT), `record_heartbeat` (agent-signed), `rotate_agent`, `withdraw_sol_from_vault` / `withdraw_from_vault`, `revoke_vault`, `close_executed_vault_by_owner`, `close_revoked_vault`.
- **Permissionless execution (`payer` = any signer; gated on grace via on-chain state + per-asset bitmasks):** `begin_execution`, `begin_token_dist`, `execute_specific_asset`, `execute_specific_sol`, `execute_sol_shares`, `execute_token_shares`, `finalize_execution`, `close_token_dist`, `close_executed_vault` (permissionless rent-cleanup after a 24h owner-exclusive window measured from `execution_log.started_at`).

---

## 5. Threat model & areas of special concern

**Availability is a security property here.** Anything that *permanently* prevents distribution is Critical even if nothing is stolen. Please severity-weight liveness accordingly.

**(a) Inheritance / dead-man's-switch**
- **Agent key as liveness oracle.** The agent key signs `record_heartbeat` only — but a *compromised* agent key can forge heartbeats indefinitely → **beneficiaries can never inherit** (permanent DoS on the exact users the product serves). Assess this trust boundary and the owner's ability to `rotate_agent`.
- **Deadline monotonicity.** Verify `record_heartbeat` is blocked once `now >= deadline` — enforced via `require!(now < deadline) → VaultFrozen` plus the `!executed` constraint, **not** via an ExecutionLog-existence check (time is monotonic, so the deadline gate suffices). The clock cannot be reset mid-execution to un-freeze owner mutations.
- **Boundary/TOCTOU at `now >= deadline`** between `begin_execution` reading the heartbeat and a concurrent `record_heartbeat`.
- **Clock/time-skew** assumption (immaterial at 7-day grace, but should be stated).

**(b) Permissionless execution**
- **Completability under max config.** The real per-vault assignment cap is **~18**, not the storage constant `MAX_ASSIGNMENTS = 64`: `set_asset_plan` takes the whole list as instruction data (42 B each) in one atomic tx, and 64×42 ≈ 2,700 B exceeds the 1,232-B tx limit (ALTs don't compress instruction data; there is no append ix). So `full_mask_u64(64)` / `TooManyAssignments` are effectively dead and the owner pays rent for unreachable `AssetPlan` capacity — flag both. For the *reachable* worst case (20 beneficiaries × ~18 assignments × N mints): is the full `begin → distribute → finalize → token-shares → close` sequence completable within **CU / tx-size / account-count** limits (ALTs)? If any step can't fit a transaction, funds become **un-inheritable**.
- **Orphaned held-mint close (flagged internally, please verify).** `close_executed_vault` guards on `open_token_dists == 0`, but that counter only tracks mints that were `begin_token_dist`'d. A mint the vault **holds but for which `begin_token_dist` was never called** leaves the counter at 0 → close succeeds → that balance is **orphaned forever** (the vault PDA can never sign again). The program can't enumerate ATAs, so this invariant can only be guaranteed off-chain — assess the residual risk.
- **`open_token_dists` re-inflation (post-finalize griefing).** `begin_token_dist` has **no `!executed`/lifecycle guard** and strict-`init`s a `TokenDist`; `close_token_dist` frees it (`close = payer`). So after finalize + close, ANYONE can re-`init` a `TokenDist` for a *bequeathed* mint at balance 0 (the `NothingToDistribute` guard passes on `mint_in_plan`), re-incrementing `open_token_dists` and **indefinitely blocking the final core-PDA close / rent-reclaim** (both closes require `== 0`). No inheritance impact (assets already delivered) and recoverable, but a rent-cleanup DoS — verify `open_token_dists` is a sound close-safety invariant in **both** directions (orphan *and* re-inflation).
- **Phantom-bequest completability.** A specific bequest for a mint the vault does **not** hold: `execute_specific_asset` requires a live vault ATA (nonexistent) → its bit never sets → `finalize` never completes → the whole vault stalls. Recoverable — a crank creates the empty vault + beneficiary ATAs (all three cranks already do idempotent ATA creation) then it pays 0 and finalizes — but an on-chain completability dependency on off-chain behavior. Consider rejecting unheld-mint specific assignments at plan-set, or tolerating an absent vault ATA (treat as 0).
- **CEI / transfer-hook reentrancy — token-CPI paths only.** For the two **token** paths (`execute_token_shares`, `execute_specific_asset`) verify the paid bit is set **before** the `transfer_checked` CPI, so a Token-2022 hook re-entering mid-crank can't double-pay or corrupt masks. The two **direct-lamport** paths (`execute_sol_shares`, `execute_specific_sol`) correctly set the bit **after** the debit — that is safe (a bare lamport move invokes no callee code, so no reentrancy); do **not** flag them as CEI violations. Confirm this split.
- **Rent-exemption during debit.** SOL lives in the `vault_config` data PDA which also signs token transfers; `execute_sol_shares` debits lamports directly. Verify the vault PDA never drops below rent-exemption mid-flow (`begin_execution` reserves `rent_min` + `keeper_bounty` in the snapshot — confirm it holds across all debit paths).
- **Keeper-bounty free-rider + viability.** `keeper_bounty` (default 0.005, cap 0.1 SOL) carved from the SOL snapshot, paid at finalize: verify paid **exactly once**, only to the finalize `payer`, saturates when SOL < bounty (beneficiaries → 0, no underflow). **The reward is NOT bound to work done:** `finalize_execution` gates only on the masks being full (filled by *whoever* ran the setup ixs), so a free-rider who lands only the final `finalize` tx collects the whole bounty having fronted no rent — a classic snipe structure (not theft; beneficiary amounts untouched). Also assess **viability**: the flat ≤0.1 SOL bounty vs. the per-assignment + per-mint + per-batch tx-fee + fronted-init-rent cost of cranking a complex (≤~18-assignment, multi-mint) vault — is permissionless liveness actually profitable for the most valuable estates, or does it silently reduce to "the operator stays up"?
- **Dust redirection.** Dust → largest-share beneficiary (ties → lowest index), recipient account is caller-supplied and only checked `== max_wallet`. Verify the caller can't redirect dust; bound total stranded dust.
- **Post-snapshot inflows go to one heir, not pro-rata.** The SOL pro-rata snapshot freezes at `begin_execution`; any SOL arriving *after* (staking rewards, airdrops, up to the 24h close window) is "above rent" and swept **in full to the single largest-share beneficiary** on close, not split by `share_bps` (same for tokens after `begin_token_dist`). This is beyond rounding dust (< n_benef units) — for an estate with post-mortem income it is a real misallocation. Bound it and decide whether largest-heir-takes-all is acceptable.
- **Order-independence** of the permissionless payouts (spec claims it via frozen snapshots) — ask for the formal argument, re-derived for `execute_specific_sol` (the conditional-accounts instruction).

**(c) SPL / NFT / Token-2022 (the bricking failure modes)**
- **Transfer-hook / non-transferable / permanent-delegate / default-frozen mints:** a `transfer_checked` needing hook accounts (not supplied) or a non-transferable token can **never** be distributed → `close_token_dist` never runs → `open_token_dists` never decrements → `close_executed_vault` blocked, owner rent + residual stranded. What is the behavior for each extension?
- **Frozen or missing beneficiary ATA:** a failed transfer leaves that mask bit unset **forever** → the same permanent-block cascade. Concrete griefing/liveness class.
- **Close-path dust sweep hard-requires the *largest heir's* ATA.** `close_token_dist` sweeps *any* dust (`> 0`, even a few base units of rounding) and **requires** `largest_benef_ata` to exist/be-transferable; if it's missing/frozen/non-createable (default-frozen or non-transferable mint), the close reverts → the same permanent-block cascade — triggered by trivial dust, even after every actual bequest succeeded. Easier to hit than the pro-rata case above.
- **Transfer-fee mints:** does the snapshot math tolerate fee-on-transfer (beneficiary receives less; ATA can't go negative; dust sweep still closes)?

**(d) PDA / rent lifecycle**
- **Re-init after close.** PDAs seed off the owner wallet, so after `close_executed_vault` the owner can `initialize_vault` again at the same address. `close_executed_vault` closes `AssetPlan` manually (`resize(0)` + `assign(system)`) — verify no revival-with-stale-state / leftover-lamports attack.
- **Rent-reclaim race at 24h.** `close_executed_vault` (rent → payer) vs `close_executed_vault_by_owner` (rent → owner): only one can win; a distribution legitimately taking >24h (congestion, many mints) must not let a keeper close the core PDAs before `execute_token_shares` / `close_token_dist` finish (guarded by `completed` + `open_token_dists == 0` — confirm under interleaving).

**(e) Arithmetic / general** — overflow/underflow, mask-width (`1<<n` at n=32/64), share-bps summation (== 10000), u128 share math / rounding, and the un-skippable/un-redirectable creation-fee CPI. **Degenerate configs** (not rejected on-chain): duplicate beneficiary *wallets*, duplicate non-NFT `(mint, beneficiary)` assignments — confirm conservation still holds under them.

---

## 6. Invariants to verify (quick list)

> **Fuzz coverage:** invariants 1–6 (conservation, no-misdirection, idempotency/racing, freeze, and the mask/close gates) are exercised by the property-fuzz suite (`tests/fuzz/`, see `FUZZ-HARNESS-PLAN.md`) and held under randomized inputs **and** random instruction orderings. Fuzzing shows the *presence* of a bug, not its absence — so please still verify these by reading, and direct fresh eyes especially at what fuzzing can't fully cover here: **completability under CU/tx/account limits (#4)**, the **non-local rent-exemption reasoning (#7)**, the **economic/incentive** questions (#5 forged-heartbeat DoS, #8 bounty free-riding), and the **upgrade model (§7)**.

1. **Conservation:** Σ payouts ≤ the frozen per-asset snapshot; no over-distribution.
2. **No misdirection:** every recipient == `beneficiaries[i].wallet` (index-equality, never `.iter().any()`); vault ATAs pinned to the canonical address from the mint's true owner program; **every raw-deserialized token account is address-pinned or CPI-validated** (raw `try_deserialize` does no owner-program check — generalize the ATA-spoof fix beyond the vault ATA to the `remaining_accounts` beneficiary ATAs); dust can't be redirected.
3. **Idempotency / resumability:** bitmasks make every payout occur once; re-runs no-op; order-independent; safe under racing cranks (first writer wins).
4. **Completability:** the *reachable* worst-case vault (≤~18 assignments — the tx-data limit, not the 64 storage cap) fully distributes → finalizes → closes within CU/tx/account limits.
5. **Deadline monotonicity + freeze:** once execution begins, heartbeats/owner-mutations are frozen; no non-owner can indefinitely postpone the deadline (note the agent key currently can via forged heartbeats).
6. **`open_token_dists` is a sound close gate in BOTH directions:** (a) close must be impossible while the vault PDA holds any positive token balance (orphan direction — today only enforceable off-chain); (b) a griefer must not be able to re-inflate `open_token_dists` post-finalize (re-`init` of a bequeathed mint's `TokenDist` at balance 0) to block the final close. Assess both.
7. **Rent-exemption preserved** across all lamport debits — but **non-local** in `execute_sol_shares` (it debits with `checked_sub` only, no local `rent_min` clamp, unlike `execute_specific_sol`/`finalize`); rent safety there is an *emergent* property of the `begin_execution` snapshot math, so a change to that formula could silently break it. Recommend an explicit clamp.
8. **Bounty:** paid exactly once, to the finalize `payer`, never reducing beneficiary payouts — but **not bound to work done** (a free-rider can snipe `finalize`); assess the incentive, not just the safety.
9. **Fee:** un-skippable, pinned to `FEE_WALLET`, un-redirectable.
10. **No revival-with-stale-state** after close + re-init; exactly one close wins the rent at the 24h boundary.

---

## 7. Program mutability / upgrade authority — **please advise + audit the model**
This is central to the "non-custodial, no held keys" claim: **an upgradeable program controlled by a single key is de facto custodial** (that key could swap the program and drain every vault). Our planned model at mainnet launch:

> **Planned:** upgrade authority held by a **Squads V4 multisig** (launch: 2-of-3 — founder + two independent signers), with program upgrades **timelocked and publicly announced** so users can exit before any change takes effect. **Not immutable at launch** — vaults are long-lived (potentially years), so a bug discovered post-launch must be patchable; an immutable program could not be fixed and a latent bug would be catastrophic for an inheritance vault. We therefore plan governed-upgradeable (multisig + timelock), **never a single hot/deployer key**, and ask the auditor to advise on this tradeoff (immutable vs. governed-upgradeable) for a long-lived inheritance protocol.

Per-vault, owners can also opt into **immutability** (`VaultConfig.is_mutable`), which blocks `update_vault`/`revoke_vault`. Please audit both the per-vault immutability enforcement and advise on the program-level authority model.

---

## 8. Docs vs. code — the code is the source of truth
`tasks/BUILD-SPEC-permissionless-execution.md` was reconciled to the as-built code on 2026-07-05 (included in the pinned tag) — its **§0.5 "As-built deltas"** authoritatively lists what shipped (specific-SOL via `execute_specific_sol`, the permissionless 24h-gated `close_executed_vault`, the keeper bounty, the 0.01 SOL creation fee, `open_token_dists`, the `devnet` feature, the 45 errors). Even so, **treat the on-chain code at the pinned commit as the source of truth** — the spec is prose context, not a substitute. `CLAUDE.md` is a current, accurate model overview and is in the repo.

---

## 9. Prior internal findings (shareable)
We can share the internal review notes + the ATA-spoof fix commit as an appendix so you can review *the fix*, not just trust it. **Treat the Critical as evidence the bug class is present, not as the only instance** — please review all token-account pinning and the availability classes above fresh.

---

## 10. Deliverables requested
- A findings report (severity-classified) with reproductions + recommended fixes.
- A fix-review / re-audit pass after remediation.
- A **publishable report** we may reference for the mainnet launch, with an **attestation of the audited commit + scope + coverage**. *(We understand firms attest scope/coverage rather than "guarantee" — noted so we align on terms up front.)*

---

## 11. Logistics (please quote against this)

| Item | Value |
|---|---|
| **Pinned commit** | Tag **`audit-2026-07-08`** (branch `devnet`; supersedes `-07-07`) — adds the **NEW-1** input-validation fix from the 2026-07-08 five-lens re-audit: `set_asset_plan`/`update_asset_plan` now reject a bequest whose mint is not a real token mint account (each distinct non-sentinel mint passed in `remaining_accounts`, validated via owner-check + Mint unpack), erroring **`InvalidPlanMint` (6044)** — closing a set-time footgun where a garbage mint could permanently block `finalize`. **45 errors now.** (`audit-2026-07-07` folded the Tier-2 hardening: **C1** MAX interval/grace bounds → 6042/6043, **C2a** `clear_asset_plan`, **G2** canonical `record_heartbeat` seeds.) Scope is frozen at this commit. Remaining planned program change: the **A1** execution-time escape-hatch (the *valid-then-closed / stuck-mint* availability class NEW-1's set-time guard cannot reach — see §5) plus the `FEE_WALLET` **constant value** (non-logic). |
| **In-scope files** | the 32 `.rs` under `programs/dead-mans-vault/src/` (primary) + the crank's completability question (§3). |
| **Out of scope** | `tasks/*.md`, TEE/agent-key device custody, mobile UX, RPC/notify infra, economics. |
| **Build/test** | `anchor build` (prod floors) — **mainnet must NOT set the `devnet` Cargo feature** (it lowers timing floors for tests only; CI asserts this). Tests: `yarn`/`ts-mocha` via `yarn test:devnet`. Caveat: local validator gossip port collides with another service — spec §11 has the standalone-validator recipe. |
| **Deployment** | devnet live; mainnet reuses the same program keypair (same ID); upgrade-authority per §7. |
| **Upgrade authority** | Squads V4 multisig (2-of-3) + timelocked/announced upgrades; not immutable at launch (see §7). |
| **Risk posture** | Early mainnet launch: aggregate TVL modest initially (early-adopter cohort, small test vaults), but **each vault may hold an individual's entire estate** — please weight severity by **per-vault worst-case (total, irreversible loss of one estate)**, not aggregate TVL. Vault count low at launch, growing with adoption; soft launch to a small cohort → public. |
| **Timeline** | Start: earliest available slot (flexible on scheduling). Effort: your estimate for ~2,700 LOC / 21 instructions. Remediation turnaround: days. Re-audit requested after remediation. **Mainnet launch is gated on a passing re-audit — no fixed external deadline; we'd rather it be thorough than fast.** |
| **Prior report** | shareable on request (§9). |
| **Contact / terms** | Romulus-Sol (repo owner) — GitHub `github.com/Romulus-Sol`; email + timezone: _add before sending_; mid-audit question SLA: same-day. NDA fine if required; license MIT; publication rights granted for the final report. |

---
*Prepared 2026-07-05. This brief was itself reviewed for accuracy (claims verified against code) and completeness (skeptical-auditor pass) before sending.*
