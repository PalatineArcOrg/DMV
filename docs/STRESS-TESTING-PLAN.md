# Stress-Testing Plan — Dead Man's Vault

Master roadmap for adversarial testing of DMV ahead of mainnet. Part of the
community-review route (`SECURITY.md`, `AUDIT-SCOPE.md`): free, high-signal
substitutes for the "did the edge case get missed" part of a paid audit.

**What "stress testing" covers here — four axes, hardest last:**
1. Randomised *inputs* to a fixed crank (✅ done — Phases 1–2, `FUZZ-HARNESS-PLAN.md`).
2. Randomised inputs to the *remaining* invariants (Phase 3).
3. Randomised *instruction orderings* — the state machine itself (Phase 4, Trident).
4. The off-chain autonomy layer + real-liquidity fidelity (Phases 5–6).

## Status
| Phase | Scope | State |
|-------|-------|-------|
| 1 | SOL conservation + idempotency (P1/P2) | ✅ green |
| 2 | Specific bequests + theft-must-revert battery (P3/P4) | ✅ green |
| 3a | Freeze-after-deadline (I7) — `freeze.fuzz.ts` P5 | ✅ green |
| 3b | Token-2022 transfer-fee residual close (I8) — `transfer_fee.fuzz.ts` P6 | ✅ green |
| 3c | NFT specifics + token-residual at scale | ⏳ next |
| 4 | Trident instruction-sequence fuzzing | ⏳ |
| 5 | Crank-client + RPC-failure stress (notify-server / keeper-bot) | ⏳ |
| 6 | Mainnet-fork fidelity (surfpool) | ⏳ |

Harness conventions (Phases 1–4) are fixed by Phase 2 — see `FUZZ-HARNESS-PLAN.md`:
litesvm + fast-check, one property per file (native-memory reset), `gcAfter` +
`endOnFailure`, byte-offset decoders, prod floors via clock-warp, 2 GB heap cap.

---

## Phase 3 — remaining on-chain invariants (extends `tests/fuzz/`)

### 3a. Freeze-after-deadline (I7) — ✅ DONE (`tests/fuzz/freeze.fuzz.ts` P5)
The switch cannot be cancelled once it fires.
Once `now >= deadline` (= `last_heartbeat + heartbeat_interval + grace_period`), every
owner mutation must revert. This is the core safety property of the trustless switch.
- **VaultFrozen (6035):** `update_vault`, `withdraw_sol_from_vault`, `withdraw_from_vault`,
  `revoke_vault`, `rotate_agent`, `record_heartbeat`.
- **AssetPlanImmutable (6022):** `set_asset_plan`, `update_asset_plan`.
- **Property (P5):** random vault; warp to `deadline − 1` → each mutation is *allowed*
  (or fails only for an unrelated, asserted reason, e.g. `VaultImmutable` when
  `is_mutable=false`); warp to `deadline` and `deadline + Δ` → each reverts with the
  exact freeze code. Assert the boundary flips at exactly `>=`.

### 3b. Token-2022 transfer-fee residual close — ✅ DONE (`tests/fuzz/transfer_fee.fuzz.ts` P6)
RWA reality (tokenized stocks are pausable/fee-bearing). LiteSVM runs Token-2022
transfer-fee mints cleanly. P6 funds the vault ATA via a fee-bearing deposit (so it
accrues withheld fees), cranks the residual, and asserts: snapshot == D − depositFee
(begin_token_dist reads the net `amount`, withheld excluded → no over-distribution);
`close_token_dist` WITHOUT harvest **reverts in the token program** (`0x23`,
close-with-withheld-fees); WITH `HarvestWithheldTokensToMint(vault_ata→mint)` prepended
it **succeeds** (ATA + token_dist closed, `open_token_dists`→0), and the owner-close then
succeeds; exact conservation `Σ(bene amount+withheld) + depositFee == D`. **No program
bug** — the documented sticky case is real and the shipped harvest-before-close fixes it.
Gotcha found: Token-2022 `calculate_fee` rounds UP (ceil), so `transfer_checked_with_fee`
needs `ceil(amount*bps/10000)` or the deposit reverts.
- **Transfer-fee residual close** — the documented sticky case: withheld fees in the
  vault ATA block `close_token_dist` unless harvested first. Property: fund a
  transfer-fee mint, run the full crank, assert `close_token_dist` succeeds (harvest
  path) and residual conservation holds net of fees.
- **Pausable / default-frozen / non-transferable** — deposit-time `checkDepositable`
  blocks these; assert the program-side behaviour matches (a paused mint mid-crank
  shouldn't strand the whole distribution — documents the current limit).

### 3c. NFT specifics + token-residual at scale
- Whole-NFT bequest (decimals 0 / supply 1) → `execute_specific_asset` + 0-residual
  `close_token_dist`. Conservation with multiple mints, large `n`, dust-to-largest-heir.

**Acceptance (each):** new per-property file, `yarn test:fuzz` green 3× within the 2 GB
heap; negative cases assert the *exact* error code.

---

## Phase 4 — Trident instruction-sequence fuzzing (the state machine)
Everything above fuzzes inputs to a *fixed* crank order. Trident fuzzes the **order**:
random interleavings of the whole instruction set (init, heartbeat, deposit, withdraw,
begin_execution, every execute_*, finalize, all closes) by arbitrary signers. Catches
state-machine bugs the single-flow harness cannot: execute-before-begin, double-finalize,
close-before-finalize, mutate in the begin→deadline window, resume after partial crank.
- **Invariants to assert across any reachable state:** no over-distribution per asset;
  no payout to a non-beneficiary; `executed` monotonic; masks monotonic; owner mutations
  impossible post-deadline; core PDA never closed while a token residual is open.
- **Effort:** real — Rust + Trident vs anchor 0.32 (toolchain friction expected). Runs in
  an isolated worktree. Highest-confidence addition before mainnet given irreversibility.
- **Acceptance:** Trident campaign runs clean for a bounded iteration budget; any
  crash/invariant-violation reproduced + triaged (program bug vs harness bug).

---

## Phase 5 — Crank-client + RPC-failure stress (off-chain autonomy)
The program is half the system; `notify-server` + `keeper-bot` are the autonomy layer.
A confused/drained cranker = no inheritance.
- **Concurrent crank racing** — app + notify + keeper on the same vault. On-chain masks
  make it *provably* race-safe (P2); test the clients' resume/retry logic under races
  (no crash, no wasted double-submits beyond harmless no-ops).
- **RPC failure injection** — 429 / timeout / partial-confirmation. Memory flags
  "rate-limited RPC lies" (429→null→0 reads as false "paid 0"): assert the cranker
  resumes from on-chain masks, never mis-reads a rate-limited 0 as done.
- **Load** — many vaults; poller throughput + bounded concurrency + watchdog hold.
- **Approach:** integration harness driving the executors against litesvm / a local
  validator with a fault-injecting RPC shim.

---

## Phase 6 — Mainnet-fork fidelity (surfpool)
Fork mainnet state and exercise the paths litesvm/devnet can't:
- **Real Token-2022 mints** (real xStocks — pausable + fee-bearing) end-to-end.
- **`closer.ts` against real Jupiter liquidity** — the DeFi path `MAINNET-READINESS §4`
  flags as never-run on live liquidity (3% slippage, autonomous). Small position first.
- **Acceptance:** a full create→fund→execute→close cycle on a mainnet fork with a real
  tokenized-stock + a real DeFi position, no fund loss, conservation holds.

---

## Execution order
Top-down. Phases 3a→3b→3c are sequential (shared harness files). Each phase: fork
implements → I verify independently (green 3×, guardrail + tsc clean, exact-error
negatives) → commit → next. Phase 4 (Trident) runs in an isolated worktree and may
overlap Phase 3. Phases 5–6 are separate harnesses (off-chain / fork) and can follow.
