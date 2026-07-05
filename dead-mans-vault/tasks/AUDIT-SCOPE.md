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
| Toolchain | **Rust pinned to 1.89.0** (`rust-toolchain.toml`); built with the **Agave/Solana CLI 3.0.15**. CI installs the same 1.89.0. |
| Program source | **31 `.rs` files, ~2,700 LOC**, `programs/dead-mans-vault/src/` |
| Instructions | **20** (11 owner/setup + 9 permissionless execution) |
| State PDAs | **5**: `VaultConfig`, `HeartbeatRecord`, `ExecutionLog`, `AssetPlan`, `TokenDist` |
| Error codes | **42** (`errors.rs`) |
| Tests | **29** integration tests (~1,450 LOC, ts-mocha), pass **locally** via `yarn test:devnet`. **CI runs only** the host-only prod-floor guard (`cargo test --lib`, asserts the timing minimums per build profile) — the full suite is **not** CI-gated. |
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
- **Deadline monotonicity.** Verify `record_heartbeat` is blocked once `ExecutionLog` exists / `executed` — the clock cannot be reset mid-execution to un-freeze owner mutations.
- **Boundary/TOCTOU at `now >= deadline`** between `begin_execution` reading the heartbeat and a concurrent `record_heartbeat`.
- **Clock/time-skew** assumption (immaterial at 7-day grace, but should be stated).

**(b) Permissionless execution**
- **Completability under max config.** Worst case (20 beneficiaries × 64 assignments × N mints): is the full `begin → distribute → finalize → token-shares → close` sequence completable within **CU / tx-size / account-count** limits (ALTs)? If any step can't fit a transaction, funds become **un-inheritable**.
- **Orphaned held-mint close (flagged internally, please verify).** `close_executed_vault` guards on `open_token_dists == 0`, but that counter only tracks mints that were `begin_token_dist`'d. A mint the vault **holds but for which `begin_token_dist` was never called** leaves the counter at 0 → close succeeds → that balance is **orphaned forever** (the vault PDA can never sign again). The program can't enumerate ATAs, so this invariant can only be guaranteed off-chain — assess the residual risk.
- **CEI / transfer-hook reentrancy — per instruction.** Verify the paid bit is set before the transfer CPI in *every* `execute_*` (SOL direct-lamport, token `transfer_checked`, specific-asset, specific-SOL), and that a Token-2022 hook re-entering mid-crank can't double-pay or corrupt masks.
- **Rent-exemption during debit.** SOL lives in the `vault_config` data PDA which also signs token transfers; `execute_sol_shares` debits lamports directly. Verify the vault PDA never drops below rent-exemption mid-flow (`begin_execution` reserves `rent_min` + `keeper_bounty` in the snapshot — confirm it holds across all debit paths).
- **Keeper-bounty griefing.** `keeper_bounty` (default 0.005, cap 0.1 SOL) carved from the SOL snapshot, paid at finalize: verify paid **exactly once**, only to the finalizer, saturates when SOL < bounty (beneficiaries → 0, no underflow), and can't be claimed without completing the work.
- **Dust redirection.** Dust → largest-share beneficiary (ties → lowest index), recipient account is caller-supplied and only checked `== max_wallet`. Verify the caller can't redirect dust; bound total stranded dust.
- **Order-independence** of the permissionless payouts (spec claims it via frozen snapshots) — ask for the formal argument, re-derived for `execute_specific_sol` (the conditional-accounts instruction).

**(c) SPL / NFT / Token-2022 (the bricking failure modes)**
- **Transfer-hook / non-transferable / permanent-delegate / default-frozen mints:** a `transfer_checked` needing hook accounts (not supplied) or a non-transferable token can **never** be distributed → `close_token_dist` never runs → `open_token_dists` never decrements → `close_executed_vault` blocked, owner rent + residual stranded. What is the behavior for each extension?
- **Frozen or missing beneficiary ATA:** a failed transfer leaves that mask bit unset **forever** → the same permanent-block cascade. Concrete griefing/liveness class.
- **Transfer-fee mints:** does the snapshot math tolerate fee-on-transfer (beneficiary receives less; ATA can't go negative; dust sweep still closes)?

**(d) PDA / rent lifecycle**
- **Re-init after close.** PDAs seed off the owner wallet, so after `close_executed_vault` the owner can `initialize_vault` again at the same address. `close_executed_vault` closes `AssetPlan` manually (`resize(0)` + `assign(system)`) — verify no revival-with-stale-state / leftover-lamports attack.
- **Rent-reclaim race at 24h.** `close_executed_vault` (rent → payer) vs `close_executed_vault_by_owner` (rent → owner): only one can win; a distribution legitimately taking >24h (congestion, many mints) must not let a keeper close the core PDAs before `execute_token_shares` / `close_token_dist` finish (guarded by `completed` + `open_token_dists == 0` — confirm under interleaving).

**(e) Arithmetic / general** — overflow/underflow, mask-width (`1<<n` at n=32/64), share-bps summation (== 10000), u128 share math / rounding, and the un-skippable/un-redirectable creation-fee CPI.

---

## 6. Invariants to verify (quick list)
1. **Conservation:** Σ payouts ≤ the frozen per-asset snapshot; no over-distribution.
2. **No misdirection:** every recipient == `beneficiaries[i].wallet` (index-equality, never `.iter().any()`); vault ATAs pinned to the canonical address from the mint's true owner program; dust can't be redirected.
3. **Idempotency / resumability:** bitmasks make every payout occur once; re-runs no-op; order-independent; safe under racing cranks (first writer wins).
4. **Completability:** the worst-case vault fully distributes → finalizes → closes within CU/tx/account limits.
5. **Deadline monotonicity + freeze:** once execution begins, heartbeats/owner-mutations are frozen; no non-owner can indefinitely postpone the deadline (note the agent key currently can via forged heartbeats).
6. **No orphaned funds:** `close_executed_vault` must be impossible while the vault PDA holds any positive token balance (today only enforceable off-chain — assess).
7. **Rent-exemption preserved** across all lamport debits.
8. **Bounty:** paid exactly once, to the finalizer, never reducing beneficiary payouts.
9. **Fee:** un-skippable, pinned to `FEE_WALLET`, un-redirectable.
10. **No revival-with-stale-state** after close + re-init; exactly one close wins the rent at the 24h boundary.

---

## 7. Program mutability / upgrade authority — **please advise + audit the model**
This is central to the "non-custodial, no held keys" claim: **an upgradeable program controlled by a single key is de facto custodial** (that key could swap the program and drain every vault). Our planned model at mainnet launch:

> **Planned:** upgrade authority held by a **Squads V4 multisig** (launch: 2-of-3 — founder + two independent signers), with program upgrades **timelocked and publicly announced** so users can exit before any change takes effect. **Not immutable at launch** — vaults are long-lived (potentially years), so a bug discovered post-launch must be patchable; an immutable program could not be fixed and a latent bug would be catastrophic for an inheritance vault. We therefore plan governed-upgradeable (multisig + timelock), **never a single hot/deployer key**, and ask the auditor to advise on this tradeoff (immutable vs. governed-upgradeable) for a long-lived inheritance protocol.

Per-vault, owners can also opt into **immutability** (`VaultConfig.is_mutable`), which blocks `update_vault`/`revoke_vault`. Please audit both the per-vault immutability enforcement and advise on the program-level authority model.

---

## 8. Docs vs. code — the code is the source of truth
`tasks/BUILD-SPEC-permissionless-execution.md` was reconciled to the as-built code on 2026-07-05 (included in the pinned tag) — its **§0.5 "As-built deltas"** authoritatively lists what shipped (specific-SOL via `execute_specific_sol`, the permissionless 24h-gated `close_executed_vault`, the keeper bounty, the 0.01 SOL creation fee, `open_token_dists`, the `devnet` feature, the 42 errors). Even so, **treat the on-chain code at the pinned commit as the source of truth** — the spec is prose context, not a substitute. `CLAUDE.md` is a current, accurate model overview and is in the repo.

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
| **Pinned commit** | Tag **`audit-2026-07-05b`** (branch `devnet`; supersedes `audit-2026-07-05` — adds the spec reconciliation, identical program code) — scope is frozen at that commit. The only pre-mainnet program change will be the `FEE_WALLET` **constant value** (non-logic, not security-relevant). |
| **In-scope files** | the 31 `.rs` under `programs/dead-mans-vault/src/` (primary) + the crank's completability question (§3). |
| **Out of scope** | `tasks/*.md`, TEE/agent-key device custody, mobile UX, RPC/notify infra, economics. |
| **Build/test** | `anchor build` (prod floors) — **mainnet must NOT set the `devnet` Cargo feature** (it lowers timing floors for tests only; CI asserts this). Tests: `yarn`/`ts-mocha` via `yarn test:devnet`. Caveat: local validator gossip port collides with another service — spec §11 has the standalone-validator recipe. |
| **Deployment** | devnet live; mainnet reuses the same program keypair (same ID); upgrade-authority per §7. |
| **Upgrade authority** | Squads V4 multisig (2-of-3) + timelocked/announced upgrades; not immutable at launch (see §7). |
| **Risk posture** | Early mainnet launch: aggregate TVL modest initially (early-adopter cohort, small test vaults), but **each vault may hold an individual's entire estate** — please weight severity by **per-vault worst-case (total, irreversible loss of one estate)**, not aggregate TVL. Vault count low at launch, growing with adoption; soft launch to a small cohort → public. |
| **Timeline** | Start: earliest available slot (flexible on scheduling). Effort: your estimate for ~2,700 LOC / 20 instructions. Remediation turnaround: days. Re-audit requested after remediation. **Mainnet launch is gated on a passing re-audit — no fixed external deadline; we'd rather it be thorough than fast.** |
| **Prior report** | shareable on request (§9). |
| **Contact / terms** | Romulus-Sol (repo owner) — GitHub `github.com/Romulus-Sol`; email + timezone: _add before sending_; mid-audit question SLA: same-day. NDA fine if required; license MIT; publication rights granted for the final report. |

---
*Prepared 2026-07-05. This brief was itself reviewed for accuracy (claims verified against code) and completeness (skeptical-auditor pass) before sending.*
