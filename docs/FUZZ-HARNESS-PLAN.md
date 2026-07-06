# Fuzz / Property-Test Harness — Plan

Status: **Phases 1–4 done (green)** — started 2026-07-06. **9 properties** passing via
`yarn test:fuzz` (P1/P2 SOL conservation+idempotency; P3/P4 specific bequests + theft
resistance; P5 freeze-after-deadline; P6 Token-2022 transfer-fee close; P7 whole-NFT
bequest; P8 token-residual at scale; **P9 stateful instruction-SEQUENCE fuzzer**). Part
of the mainnet community-review route (`MAINNET-READINESS.md` §1.1): free tooling that
substitutes for the "did the money math miss an edge case" part of a paid audit. **No
program bug found across any phase.**

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
  freeze.fuzz.ts        # P5 — freeze-after-deadline (all owner mutations)
  transfer_fee.fuzz.ts  # P6 — Token-2022 transfer-fee sticky close + harvest
  nft.fuzz.ts           # P7 — whole-NFT specific bequest
  residual_scale.fuzz.ts# P8 — token-residual pro-rata dust at scale (n≤20)
  sequence.fuzz.ts      # P9 — stateful instruction-SEQUENCE fuzzer (the state machine)
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

## Phase 3c — NFT specifics + token-residual at scale — ✅ done (`nft.fuzz.ts` P7, `residual_scale.fuzz.ts` P8)
Completes Tier-1 property fuzzing. Two per-property files.
- **P7 — whole-NFT specific bequest.** An NFT = a mint with decimals 0 / supply 1. The whole
  supply is the specific, so `begin_token_dist` snapshots residual **0**: `execute_token_shares`
  pays nothing, `close_token_dist` succeeds with **no dust** (`largest_benef_ata = None`), and the
  owner-close then succeeds (its success IS the `open_token_dists==0` proof). Heir holds exactly 1
  before and after close. Negative (P7b): two NFT assignments for one mint → **DuplicateNftAssignment
  (6031)** at `set_asset_plan`, asserted by exact code.
- **P8 — token-residual dust at scale.** Pure pro-rata (no specific/plan), **n up to 20**. Each
  beneficiary gets `floor(snapshot×share/1e4)`; dust `= snapshot − Σfloor` is asserted `< n` and
  swept to the largest-share beneficiary (ties → lowest index) on close; `Σ balances == balance`.
  `*_shares` batched ≤8/tx; numRuns 8 keeps n=20 under the 2 GB heap (ran clean, no cap needed).
- No program bug found. Pausable / default-frozen / transfer-hook mints are deferred to the
  Phase 6 mainnet-fork (their interesting cases involve a mint paused/hooked *after* deposit,
  better exercised against real xStocks than synthesised in LiteSVM).

## Phase 4 — stateful / instruction-SEQUENCE fuzzing (P9) — ✅ done (`tests/fuzz/sequence.fuzz.ts`)
Everything in P1–P8 fuzzes INPUTS to a FIXED crank order. **P9 fuzzes the ORDER.** Deliberately
built on the SAME proven LiteSVM + fast-check TS stack (not Trident) to avoid re-introducing the
anchor-0.32 Rust-host toolchain risk this harness was chosen to sidestep. One property, its own
file/process (memory isolation, as with P3–P8).

**Shape.** fast-check generates a plain config: a random vault (`n∈[1,4]`, random `share_bps`,
random `keeper_bounty`, optional token deposit, optional specific-bequest plan) + a **shuffled
recipe** of step descriptors (`{op, signer, warp, big, amt}` — plain data, no live objects, so
native SVM memory stays off the generated values). The predicate builds ONE LiteSVM vault, then
applies the steps IN ORDER, each wrapped in try/catch (an illegal ordering reverting is EXPECTED
and correct). The recipe is a **guaranteed core multiset** (2× each of begin / solShares /
finalize / closeOwner, + token / specific steps when the vault holds them, + owner-mutation &
deposit noise) **shuffled** by a random priority — so ORDER is random (every out-of-order gate is
still hit) but the core is PRESENT, so a meaningful fraction of runs actually complete rather than
just bouncing off gates. A `clock-warp` op (0–2 guaranteed leading big warps + in-recipe warps)
lands mutations & executions in random temporal order relative to the deadline.

**After EVERY step**, re-read on-chain state (byte-offset readers — `readU8/U16LE/U32LE` added to
`harness.ts` for the executed byte / open_token_dists / the u32 masks; `readU64LE` for the u64
snapshots + the plan mask, whose offset is computed from the assignment count) and assert seven
GLOBAL invariants against a JS shadow model:
1. **executed monotonic** — once true, never observed false again.
2. **masks monotonic** — `sol_paid_mask` / each `token_dist.paid_mask` / `asset_plan.paid_mask`
   bits only ever get SET (a token_dist legitimately closed+reopened resets its shadow to 0 first).
3. **no post-deadline owner mutation** — a SUCCEEDING owner op (update/withdraw/revoke/rotate/
   heartbeat/updatePlan) ⇒ the clock was `< deadline` at that step (deadline re-read from chain).
4. **no over-distribution** — per-beneficiary SOL ≤ `floor(snapshot×share/1e4) + specific + n`;
   per-beneficiary token ≤ `specific + floor + n`, for ALL beneficiaries incl. the largest-share
   heir (the `+n` slack absorbs the <n-unit residual dust swept to the largest heir on close).
5. **conservation** — exact per-step SOL identity `vault == baseline + externalNet − paidToBenes −
   bountyPaid` (the vault PDA never signs → moves only by deposits/withdraws, beneficiary payouts,
   and the finalize bounty; no fees, no created/destroyed lamports) + exact token conservation
   `Σbenef + vaultAta + ownerAta == original balance`.
6. **core-PDA close safety** — `close_executed_vault_by_owner` only SUCCEEDS with `executed==true`
   AND `open_token_dists==0`.
7. **ordering gates** — a crank op whose HARD precondition is unmet (execute-before-begin,
   begin_token_dist twice, finalize-before-all-shares/plan, close-before-finalize, close-token
   before its residual mask is full, close-owner while tokens remain) MUST revert. The shadow model
   computes a `mustFail` flag conservatively (only guaranteed-revert cases) and asserts the tx did
   NOT succeed when it held.

**Depth reached (per 14-run invocation, typical):** ~10–11/14 runs begin execution; ~4–7 fully
finalize; ~2–4 owner-close the core PDAs; ~4–8 open a `token_dist` and ~1–4 close one; the rest
revoke pre-deadline or bounce off gates — so both the SUCCESS paths (mask/close monotonicity,
bounty, dust sweep) and the huge population of out-of-order REVERTS (gates #7) are exercised.

**As-built notes / gotchas:**
- **numRuns 14, `endOnFailure`, `gcAfter`, `withTransactionHistory(0)`** — same memory stack as
  P3–P8. Each run is a full 15–27-step sequence over one vault; peak RSS for the file is well under
  the theft-file high-water mark. Verified **3/3 consecutive clean `yarn test:fuzz`** runs.
- **executedAfter carries executedBefore through a close** — on close `executed` is unreadable but
  unchanged (owner-close requires it true, revoke requires it false), so the shadow doesn't misread
  a revoke as an execution.
- **Transpile quirk:** ts-node in this harness was observed to miscompile a `x % n` written
  *directly inside a `[ ]` index* to `NaN`; the signer index is therefore computed in a plain
  statement + clamped with a fallback. (Cosmetic — signer choice only; the bigint invariant math is
  unaffected.)
- **No program bug found.** No random ordering violated any global invariant. (Reviewer note: an
  earlier draft exempted the largest-share heir from the token over-distribution cap, on the theory
  that `close_token_dist` could sweep an *unpaid* specific to it. That ordering is UNREACHABLE —
  `close_token_dist` requires `executed`, and `finalize` sets `executed` only once the full
  `asset_plan.paid_mask` is set, so every specific is paid before any close and the sweep is bounded
  rounding dust (<n) only. The exemption was removed: the largest heir now gets the same
  `specific + floor + n` cap as everyone else and the suite stays green — proving the program never
  over-distributes to the largest-share heir either.)

## Later phases
- **Phase 5+:** crank-client / RPC-failure stress and mainnet-fork fidelity (see `STRESS-TESTING-PLAN.md`).
- **Trident (optional):** a Rust-native instruction-sequence pass remains a possible future addition
  for raw throughput, but P9 already covers the state-machine invariants on the proven TS stack.
