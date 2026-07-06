# Stress-Testing Plan — Dead Man's Vault

Master roadmap for adversarial testing of DMV ahead of mainnet. Part of the
community-review route (`SECURITY.md`, `AUDIT-SCOPE.md`): free, high-signal
substitutes for the "did the edge case get missed" part of a paid audit.

**What "stress testing" covers here — four axes, hardest last:**
1. Randomised *inputs* to a fixed crank (✅ done — Phases 1–2, `FUZZ-HARNESS-PLAN.md`).
2. Randomised inputs to the *remaining* invariants (Phase 3).
3. Randomised *instruction orderings* — the state machine itself (✅ done — Phase 4, P9, TS stateful fuzzer).
4. The off-chain autonomy layer + real-liquidity fidelity (Phases 5–6).

## Status
| Phase | Scope | State |
|-------|-------|-------|
| 1 | SOL conservation + idempotency (P1/P2) | ✅ green |
| 2 | Specific bequests + theft-must-revert battery (P3/P4) | ✅ green |
| 3a | Freeze-after-deadline (I7) — `freeze.fuzz.ts` P5 | ✅ green |
| 3b | Token-2022 transfer-fee residual close (I8) — `transfer_fee.fuzz.ts` P6 | ✅ green |
| 3c | NFT specifics + token-residual at scale — `nft.fuzz.ts` P7, `residual_scale.fuzz.ts` P8 | ✅ green |
| 4 | Instruction-SEQUENCE / state-machine fuzzing — `sequence.fuzz.ts` P9 (TS stateful fuzzer) | ✅ green |
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

### 3c. NFT specifics + token-residual at scale — ✅ DONE (`nft.fuzz.ts` P7, `residual_scale.fuzz.ts` P8)
- **P7:** whole-NFT bequest (decimals 0 / supply 1) → `execute_specific_asset`, residual snapshot
  0 → `close_token_dist` with no dust, owner-close succeeds; heir holds exactly 1. Negative: two
  NFT assignments for one mint → `DuplicateNftAssignment` (6031).
- **P8:** pure pro-rata token residual at **n up to 20** — `floor` shares, dust `< n` → largest
  share on close, `Σ == balance`. `*_shares` batched ≤8/tx; ran clean under the 2 GB heap, no cap.
- Pausable / default-frozen / transfer-hook mints deferred to Phase 6 (mainnet fork) — their
  interesting cases involve a mint paused/hooked *after* deposit. **Tier-1 property fuzzing complete.**

**Acceptance (each):** new per-property file, `yarn test:fuzz` green 3× within the 2 GB
heap; negative cases assert the *exact* error code.

---

## Phase 4 — instruction-SEQUENCE / state-machine fuzzing — ✅ done (`tests/fuzz/sequence.fuzz.ts`, P9)
Everything above fuzzes inputs to a *fixed* crank order. **P9 fuzzes the order**: random-length,
random-order sequences of the whole instruction set (heartbeat, deposit, withdraw, update, rotate,
revoke, set/update_asset_plan, begin_execution, every execute_*, finalize, close_token_dist,
close_executed_vault_by_owner) by random signers, interleaved with random clock warps that
sometimes cross the deadline. Every step may fail (an illegal ordering reverting is expected); after
EACH step the on-chain state is re-read and seven GLOBAL invariants are asserted against a JS shadow
model. Catches exactly the state-machine bugs the single-flow harness cannot: execute-before-begin,
double-finalize, finalize-before-all-shares, close-before-finalize, begin_token_dist twice, owner
mutation past the deadline, resume after a partial crank.

- **Built on the proven TS stack (litesvm + fast-check), NOT Trident** — a deliberate choice to
  avoid re-introducing the anchor-0.32 Rust-host toolchain risk this harness was picked to sidestep.
  The sequence is a **shuffled recipe** (guaranteed core multiset + noise), so ORDER stays random
  (every out-of-order gate is hit) yet a meaningful fraction of runs actually finalize/close.
- **Invariants asserted across any reachable state:** `executed` monotonic; every mask monotonic
  (bits only set); no post-deadline owner mutation; no over-distribution per asset; exact SOL +
  token conservation (no lamports/base-units created or destroyed); core PDA closed only when
  `executed && open_token_dists==0`; ordering gates hold (unmet-precondition crank op must revert).
- **Result:** green. **No program bug found** — no random ordering violated any global invariant.
  Depth per 14-run invocation: ~10–11/14 runs begin execution, ~4–7 finalize, ~2–4 owner-close the
  core PDAs, ~4–8 open a token_dist / ~1–4 close one — so both the success paths and the large
  population of out-of-order reverts are exercised. Verified **3/3 consecutive clean `yarn
  test:fuzz`** runs, `tsc` clean, no OOM. Full as-built + the seven invariants: `FUZZ-HARNESS-PLAN.md`.
- **Trident remains an OPTIONAL future pass** — a Rust-native sequence fuzzer would add raw
  throughput, but P9 already covers the state-machine invariants on the low-risk TS stack.

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
negatives) → commit → next. Phase 4 (P9) landed on the SAME TS harness (`sequence.fuzz.ts`,
its own file/process) rather than a separate Trident worktree — same litesvm + fast-check
stack, so no toolchain risk. Phases 5–6 are separate harnesses (off-chain / fork) and can follow.
