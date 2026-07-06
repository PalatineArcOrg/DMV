# Fuzz / Property-Test Harness — Plan

Status: **scoping + Phase 1 in progress** (started 2026-07-06). Part of the mainnet
community-review route (`MAINNET-READINESS.md` §1.1): free tooling that substitutes
for the "did the money math miss an edge case" part of a paid audit.

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
  harness.ts            # litesvm setup: load .so, fund, build ixs via anchor client, warp clock, send/decode
  conservation.fuzz.ts  # P1 + P2 (fast-check)
  tsconfig.json         # extends ../../tsconfig.json, target es2020 (BigInt literals)
```
- New dev-deps: **`litesvm` + `fast-check`** (only). `anchor-litesvm` was tried but its
  latest (0.2.1) pins `litesvm@^0.3.3` + anchor 0.31 — a duplicate/older litesvm whose
  `instanceof` failure-detection silently breaks. Dropped it; see Integration below.
- Build the program first with **prod floors**: `yarn build:prod` (plain `anchor build`).
- Run: **`yarn test:fuzz`** (= `ts-mocha -p ./tests/fuzz/tsconfig.json -t 120000
  "tests/fuzz/**/*.fuzz.ts"`). No validator needed — litesvm is in-process.
- FEE_WALLET (`98x9Rn63…`) must be airdropped in litesvm so the creation-fee CPI lands.

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

## Later phases (not this session)
- **Phase 2:** specifics (SOL/SPL/NFT) conservation + ordering (I3/I5/I6); adversarial
  negative properties (wrong wallet, substituted ATA, out-of-order, spoofed vault ATA).
- **Phase 3:** freeze-after-deadline interleavings (I7), token residual (I8), and —
  if warranted — Trident sequence-fuzzing over the full instruction set.
