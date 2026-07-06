# Fuzz / Property-Test Harness — Plan

Status: **Phase 1 + Phase 2 done (green)** — started 2026-07-06. 4 properties passing via
`yarn test:fuzz` (P1/P2 SOL conservation+idempotency; P3/P4 specific bequests + theft
resistance). Part of the mainnet community-review route (`MAINNET-READINESS.md` §1.1):
free tooling that substitutes for the "did the money math miss an edge case" part of a
paid audit. No program bug found across either phase.

## Why (vs the existing 29 tests)

The 29-test suite proves *hand-picked* scenarios pass. A fuzzer explores *randomised*
inputs + orderings and, after every run, asserts the **invariants** still hold — then
shrinks any failure to a minimal reproducer. This is exactly the shape of DMV's risk:
Stage-4 execution is permissionless, concurrent, resumable, and order-independent, so
the security model rests on frozen snapshots + bitmasks surviving *adversarial ordering*
— the class of bug humans under-enumerate and fuzzers find.

## Tool decision — TypeScript `litesvm` + `fast-check`

**Chosen for Phase 1** over Rust `litesvm`+`proptest` / Ackee Trident because:
- **Lowest setup risk.** Reuses the existing anchor TS client, generated IDL
  (`target/types/dead_mans_vault`), and PDA helpers — no new Rust host-side
  solana/anchor version-resolution (the rabbit hole flagged when scoping this).
- **In-process, no validator.** `litesvm` loads the same compiled `.so`; runs are
  milliseconds, so thousands of random cases are cheap.
- **Instant clock-warp.** `svm.setClock(...)` jumps past the deadline, so we test the
  **real production config** (1-day interval / 7-day grace, plain `anchor build`) — the
  ts-mocha suite can't (it uses ~40s demo-floor waits).
- **Property generation + shrinking** via `fast-check` (`fc.assert(fc.property(...))`).

**Escalation path (later phases / if needed):** Rust `litesvm`+`proptest` for raw
throughput, or **Ackee Trident** for true instruction-*sequence* fuzzing (random
interleavings of the whole ix set). Documented here so the choice is deliberate.

## Invariants → properties (mapped to code)

| # | Invariant | Where enforced | Phase |
|---|-----------|----------------|-------|
| I1 | **Conservation**: Σ SOL payouts ≤ `sol_snapshot`; per-beneficiary = `floor(snapshot × share_bps / 10000)`; dust (< n_benef) stays in vault | `execute_sol_shares.rs:62`, `begin_execution.rs:82` | **1** |
| I2 | **Idempotency**: replaying `execute_sol_shares` (any index subset, any order/overlap) never double-pays; final balances == single-run | `sol_paid_mask` @ `execute_sol_shares.rs:54,80` | **1** |
| I3 | **Snapshot carve-outs**: `sol_snapshot = (lamports − rent) − Σ specific-SOL − keeper_bounty`; specifics + bounty never reduce below their carve-out | `begin_execution.rs:82-85` | **1** (bounty), 2 (specifics) |
| I4 | **Finalize gate + bounty**: finalize only when `sol_paid_mask` full (+ plan mask); bounty paid exactly once to the finalizer, clamped to available | `finalize_execution.rs:43,69` | **1** |
| I5 | **Whitelist integrity**: funds only ever reach `beneficiaries[i].wallet` (index-equality), under any account permutation; substituted/wrong wallet → `BeneficiaryMismatch` | `execute_sol_shares.rs:59` | 2 |
| I6 | **Specifics accounting** (SOL/SPL/NFT): carved first, in ascending order per mint, `min(amount, available)`; residual splits pro-rata; totals reconcile | `execute_specific_*`, `execute_token_shares` | 2 |
| I7 | **Freeze-after-deadline**: no owner mutation (update/withdraw/revoke/rotate/set_asset_plan) succeeds once `now >= deadline`, in any interleaving with the crank | `VaultFrozen` guards | 3 |
| I8 | **Token residual conservation**: `snapshot = ATA_bal − Σ specific(mint)`; pro-rata + dust-to-largest-heir reconciles; no over-distribution | `execute_token_shares`, `close_token_dist` | 3 |

## Phase 1 scope (this session — SOL-only vaults)

Prove the harness works end-to-end and lands **I1, I2, I4** green:
- **P1 — Conservation / exact pro-rata.** Generate a random vault: `n ∈ [1,20]`
  beneficiaries, random `share_bps` summing to exactly 10000, random deposit, random
  `keeper_bounty ∈ [0, 0.1 SOL]`, no asset plan. `initialize_vault` (prod floors) →
  deposit → `setClock` past `created_at + interval + grace` → `begin_execution(None)` →
  `execute_sol_shares([0..n])`. Assert: each beneficiary Δ == `floor(snapshot×share/10000)`;
  Σ Δ ≤ snapshot; `snapshot − ΣΔ == dust < n`; vault retains `rent + bounty + dust`.
- **P2 — Idempotency.** Re-run `execute_sol_shares` (full set, and a shuffled/overlapping
  subset) → balances unchanged; `finalize_execution` before the mask is full →
  `NotAllSharesPaid`; after → `executed=true`, bounty delta to the finalizer == `min(bounty, available)`.

Generators must respect on-chain validation (shares sum to 10000, 1–20 benef, agent ≠
owner/zero, bounty ≤ MAX) so we exercise the *execution* math, not the *init* rejects
(those are covered separately in a negative-path property later).

## Layout & run

```
tests/fuzz/
  harness.ts            # litesvm setup: load .so, fund, build ixs, warp clock, send/decode, byte readers, gcAfter
  setup.ts              # shared vault/token builders (makeVault, fundVaultToken, makeBeneAtas, sharesArb)
  conservation.fuzz.ts  # P1 + P2 — SOL conservation & idempotency (n≤20)
  specifics.fuzz.ts     # P3 — specific bequests carve-out + conservation (n≤5)
  theft.fuzz.ts         # P4 — theft-must-revert battery
  tsconfig.json         # extends ../../tsconfig.json, target es2020 (BigInt literals)
```
- New dev-deps: **`litesvm` + `fast-check`** (only). `anchor-litesvm` was tried but its
  latest (0.2.1) pins `litesvm@^0.3.3` + anchor 0.31 — a duplicate/older litesvm whose
  `instanceof` failure-detection silently breaks. Dropped it; see Integration below.
- Build the program first with **prod floors**: `yarn build:prod` (plain `anchor build`).
- Run: **`yarn test:fuzz`** — runs **each fuzz file in its own process** (a `for f in
  tests/fuzz/*.fuzz.ts` loop) under `NODE_OPTIONS='--max-old-space-size=2048 --expose-gc'`.
  No validator needed — litesvm is in-process. numRuns: P1=15, P2=15, P3=12, P4=12.
- FEE_WALLET (`98x9Rn63…`) must be airdropped in litesvm so the creation-fee CPI lands.

### Memory management (why the above shape) — hard-won, keep it
LiteSVM holds large native memory that **JS GC reclaims only lazily and never returns to
the OS within a process** (no dispose API), so a tight many-SVM loop accumulates native
pressure that (a) OOMs the V8 heap and (b) intermittently **corrupts account reads**. The
layers that make `yarn test:fuzz` reliable within a **2 GB heap** on the shared VPS:
1. **`withTransactionHistory(0)`** on every SVM — killed a JS-heap OOM from retained tx logs.
2. **Byte-offset readers** (`readU64LE`/`readI64LE` at fixed offsets) for hot u64/i64 fields —
   the anchor coder's decoded BN `.toString()` intermittently returned "…NaN" under pressure
   (bytes were correct); native reads bypass it. Conservation + specifics both use these.
3. **Per-file process isolation** — each property (P1/P2 share a file; P3, P4 separate) runs
   in its own Node process so native memory resets between them. P3+P4 in one process OOM'd 2 GB.
4. **`gcAfter()`** wraps every predicate — `global.gc()` in a `finally`, so even a throwing
   run releases its JS working set.
5. **`endOnFailure: true`** on every property — disables shrinking. A flaky failure otherwise
   sends fast-check into a shrink storm that re-runs the heavy predicate ~80× and OOMs; the raw
   counterexample seed is still reported, so reproducibility is preserved.
6. **P3 caps n at 5** to keep per-SVM footprint (and thus native pressure) low.

Peak RSS per file: conservation ~387 MB, specifics ~351 MB, theft ~1.05 GB (its ~72 short-lived
SVMs) — all transient (freed on process exit) and far under the 2 GB **heap** cap (heap peaks
~50 MB; RSS is native). Verified **6/6 consecutive clean `yarn test:fuzz` runs** at 2 GB.

**Integration (as-built).** litesvm 1.2.1's TS API uses `@solana/kit` types and its
send path wants kit transactions, but this project is anchor 0.32 + web3.js v1. So the
harness: builds ixs with the normal anchor client (`.transaction()`), signs a web3.js
legacy tx, and hands its **serialized bytes** to litesvm's native
`inner.sendLegacyTransaction()` (bypassing kit); accounts are decoded from raw bytes via
`program.coder.accounts.decode("vaultConfig"|…)` (camelCase names) — no live connection.
The owner is the fee payer on every tx (incl. the permissionless cranks) so the cranker's
balance moves only by program transfers, keeping the bounty assertion exact.

## Risks / watch-items (Phase-1 outcomes)
- ✅ **litesvm 1.2.1 executes the Agave-3.0.15-built `.so`** (verified via smoke probe;
  the creation-fee CPI runs). This was the main unknown — cleared.
- ✅ `anchor-litesvm` incompat → dropped in favour of the native serialized-tx send
  (see Integration above).
- ⚠️ **Blockhash gotcha:** litesvm does NOT auto-advance the blockhash, so two identical
  txs (an idempotent replay, or a retried finalize) get the same signature and the second
  is rejected at the tx layer. `send()` calls `svm.expireBlockhash()` before each submit
  to force distinct signatures. (This bit P2 first; fixed.)
- Clock warp sets `Clock.unix_timestamp` past the deadline (slot/epoch left intact — the
  program reads only `unix_timestamp`).

## Phase 2 — specific bequests + theft resistance (DONE, green)

P3 (`specifics.fuzz.ts`) + P4 (`theft.fuzz.ts`) — separate files/processes (see Memory management):
- **P3 — specifics carve-out + conservation (I3/I6/I8).** Random vault (n∈[1,5]) holding
  a random SPL balance B + SOL, plan-assigning a specific token amount to a beneficiary
  (and, half the time, a specific-SOL sentinel bequest). Full crank
  (begin→token_dist→specific→sol_shares→finalize→token_shares→close). Asserts: each
  specific paid exactly `min(amount, available)` (isolated before/after); on-chain
  `token_dist.snapshot == B−Σspecific` and `sol_snapshot == (lamports−rent)−Σspecific-SOL
  −bounty`; residual splits `floor(snap×share/1e4)`; dust→largest-share on close; and the
  **hard conservation invariant** `Σ beneficiary token balances == B` (nothing lost/minted).
- **P4 — theft attempts MUST revert with the EXACT error (I5).** Each asserts a specific
  Anchor code, so a tx failing for the wrong reason is not a false pass: wrong beneficiary
  wallet on `execute_specific_sol`/`execute_sol_shares` and wrong beneficiary ATA on
  `execute_specific_asset` → **BeneficiaryMismatch (6023)**; **substituted non-canonical
  vault ATA → InvalidVaultAta (6034)** (the CRITICAL anti-spoof guard — confirmed it
  fires); out-of-order specific → **SpecificOutOfOrder (6026)**; double-pay → **MaskAlreadySet
  (6027)**; junk-mint token_dist → **NothingToDistribute (6040)**. No program bug found —
  every guard held.

### Phase-2 as-built gotchas
- **SPL setup in LiteSVM** uses the low-level builders (`createInitializeMint2Instruction`
  / `createInitializeAccount3Instruction` / `createMintToInstruction` / ATA ix) sent as
  serialized legacy txs — the high-level `createMint`/`mintTo` wrappers need a Connection.
- **BN toString() flakiness.** Under the loop, the anchor coder's decoded `snapshot` BN
  occasionally stringified to "…NaN" (bytes were correct — verified in isolation). Hot u64/i64
  reads (sol_snapshot, token snapshot, last_heartbeat) now read the field straight from the
  copied account bytes via `readU64LE`/`readI64LE` at fixed offsets, bypassing the BN.
- **LiteSVM native-memory pressure** — the full mitigation stack is documented under
  "Memory management" above (per-file processes, `gcAfter`, `endOnFailure`, byte readers,
  `withTransactionHistory(0)`, n≤5). Verified 6/6 clean `yarn test:fuzz` runs at a 2 GB heap.
- **Two "flakiness" root causes were harness/test bugs, NOT the program:** (1) the BN-NaN
  read above; (2) a generator bug — `withSol` with `solFrac=0` produced a **0-amount SOL
  bequest**, which the program *correctly* rejects (`InvalidSolBequest`), so `setAssetPlan`
  threw ~15%/cycle and (pre-`endOnFailure`) triggered shrink-storm OOMs. Fixed by `solFrac ≥ 1`.
  Lesson: an invalid generated input that trips a program guard looks exactly like a flaky
  failure once shrinking hides the error — `endOnFailure` surfaces the raw counterexample.

## Phase 3a — freeze-after-deadline (I7) — ✅ done (`tests/fuzz/freeze.fuzz.ts`, P5)
Once `now >= deadline` every owner mutation must revert — the core safety property of the
trustless switch (a post-deadline heartbeat/withdraw/revoke would cancel an already-firing
distribution). P5 covers all 8 owner instructions with the EXACT error code:
- **VaultFrozen (6035):** `update_vault`, `withdraw_sol_from_vault`, `withdraw_from_vault`,
  `revoke_vault`, `rotate_agent`, `record_heartbeat`.
- **AssetPlanImmutable (6022):** `set_asset_plan` (no-plan vault), `update_asset_plan` (plan vault).
- **Exact `>=` boundary proved:** `withdraw_sol` succeeds at `deadline − 1` and reverts
  `VaultFrozen` at *exactly* `deadline`; `record_heartbeat` + `rotate_agent` are also shown to
  succeed pre-deadline (so the battery's freeze is the deadline, not an always-fail state).

As-built notes:
- **One shared clock, one deadline.** LiteSVM has a single clock, so all four vaults in a run
  pin `last_heartbeat` to a fixed `BASE` (warp before each `initialize_vault`) → a common
  deadline `D0`. Four vaults in ONE SVM (bounds native memory to ~1 SVM/run).
- `record_heartbeat`/`rotate_agent` RESET `last_heartbeat` (moving that vault's deadline), so
  the "succeeds pre-deadline" checks run on a dedicated vault and the boundary flip uses
  `withdraw_sol` (which leaves the deadline fixed). No program bug found.

## Phase 3b — Token-2022 transfer-fee residual close (I8) — ✅ done (`tests/fuzz/transfer_fee.fuzz.ts`, P6)
The documented "sticky close" regression. A transfer-fee mint withholds a fee in the
*destination* on every transfer, so a fee-bearing DEPOSIT leaves withheld fees in the vault
ATA, and Token-2022 refuses to `CloseAccount` an account holding withheld fees → the on-chain
`close_token_dist` (a bare `CloseAccount`) reverts. The shipped fix is a CLIENT-side
`HarvestWithheldTokensToMint(vault_ata→mint)` pre-instruction. P6 proves both sides.
- **LiteSVM runs Token-2022 transfer-fee cleanly** (verified via a throwaway probe first).
- **Snapshot excludes withheld:** `begin_token_dist` reads the token account's net `amount`
  (= D − depositFee), so `execute_token_shares` distributes only spendable tokens — no
  over-distribution despite the withheld fee sitting in the vault ATA.
- **Sticky reproduced:** `close_token_dist` without harvest reverts with Token-2022
  `custom program error: 0x23` (the one non-Anchor-code failure in the suite — asserted on the
  token program, not a DMV code). **With harvest** it succeeds (ATA + `token_dist` closed,
  `open_token_dists`→0) and the owner-close then succeeds (no `TokensRemain`).
- **Exact conservation net of fees:** `Σ(bene amount + withheld) + depositFee == D`.
- **Gotcha:** Token-2022 `calculate_fee` rounds UP (ceil). `transfer_checked_with_fee` asserts
  the passed fee, so the harness deposit must use `ceil(amount*bps/10000)` or it reverts.
- No program bug found; the sticky case is real and the shipped harvest-before-close is correct.

## Later phases
- **Phase 3c:** NFT specifics (whole-NFT bequest, 0-residual close), token-residual dust at large n.
- **Phase 4:** Trident sequence-fuzzing over the full instruction set (see `STRESS-TESTING-PLAN.md`).
