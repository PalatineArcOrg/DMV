# Permissionless Autonomous Execution — Design Doc

**Status:** proposed (for review before implementation)
**Goal:** the vault distributes assets after the grace period **without anyone
opening the app and without any trusted/privileged trigger.** The on-chain
program enforces all correctness; *anyone* (a beneficiary, a public keeper, the
notify server) can submit the execution transaction and the program does the
rest. This is the only model that makes "autonomous" honest on a chain that
cannot self-trigger.

---

## 1. Principles
- **No privileged trigger.** Execution requires no specific signer — not the
  agent, not a server. The grace deadline is the only gate.
- **Caller cannot influence outcomes.** The program computes every payout amount
  from on-chain state (snapshot × share). A malicious cranker can only make the
  program run the owner's plan, correctly, after grace.
- **Idempotent & crash-safe.** Every payout happens exactly once; any party can
  resume a partially-executed vault.
- **Belt-and-suspenders triggers.** Beneficiaries are economically incentivized
  to crank (it's their inheritance); the notify server cranks as a keyless
  backup; the app can still crank when open. Whoever's first wins.

---

## 2. Current vs new model

| | Current | New |
|---|---|---|
| Who signs execution | the agent key (device only) | **anyone** (permissionless) |
| Who computes amounts | the app (off-chain) | **the program** (on-chain) |
| When it can run | grace elapsed | grace elapsed (unchanged) |
| Trust | device must run | **none** |

---

## 3. Account / state changes

### `ExecutionLog` (extend)
Add fields (created lazily on first execution call):
- `sol_snapshot: u64` — vault SOL distributable, captured on first SOL payout
  (`vault_lamports − rent_exempt_min`). Zero until set.
- `sol_paid_mask: u32` — bit *i* set once beneficiary *i* has received SOL.
- `started_at: i64`, `completed: bool` (already have `completed`).
Keep: `vault`, `executed_at`, `transfer_count`, `total_sol_distributed`, `bump`.

### New PDA: `TokenDist` — one per (vault, mint)
Seeds: `["token_dist", vault, mint]`. Created on first token payout for a mint.
- `vault: Pubkey`, `mint: Pubkey`
- `snapshot: u64` — vault ATA balance for this mint, captured on first payout
- `paid_mask: u32` — bit *i* set once beneficiary *i* received this token
- `bump: u8`

### `VaultConfig` — **no layout change**
Beneficiaries (wallet + share_bps) already on-chain. `active`/`executed` reused.

---

## 4. Instructions (all permissionless — `payer: Signer` pays fees only)

### `execute_sol_share(beneficiary_index: u8)`
Guards: `vault.active`, `!vault.executed`, grace elapsed
(`now ≥ last_heartbeat + interval + grace`), `index < beneficiaries.len`,
`sol_paid_mask bit index == 0`.
Logic:
1. If `ExecutionLog` uninitialized → init, set `started_at`, snapshot
   `sol_snapshot = vault_lamports − rent_exempt_min`.
2. `amount = sol_snapshot × beneficiaries[index].share_bps / 10000`.
3. Transfer `amount` lamports vault PDA → `beneficiaries[index].wallet`
   (the wallet pubkey is checked against the stored beneficiary — caller passes
   it, program asserts equality).
4. Set `sol_paid_mask` bit `index`; `transfer_count += 1`;
   `total_sol_distributed += amount`.

One beneficiary per tx → tiny account set, no tx-size issues, fully idempotent.

### `execute_token_share(beneficiary_index: u8)` + accounts `{mint, vault_ata, beneficiary_ata}`
Guards: same grace/active/executed + per-mint `paid_mask` bit unset +
`beneficiary_ata` owner == `beneficiaries[index].wallet` and mint matches.
Logic:
1. If `TokenDist[vault,mint]` uninitialized → init, snapshot
   `snapshot = vault_ata.amount`.
2. `amount = snapshot × share_bps / 10000`.
3. `token::transfer` vault_ata → beneficiary_ata (vault PDA authority via seeds).
4. Set `paid_mask` bit `index`.
Beneficiary ATA creation: caller may prepend `create_associated_token_account`
(idempotent variant) — payer = caller. Not the program's concern.

### `finalize_execution()`
Guards: grace elapsed, `!vault.executed`, **all active beneficiaries paid SOL**
(`sol_paid_mask == full_mask(beneficiaries.len)`).
Logic: `vault.executed = true; vault.active = false; ExecutionLog.completed =
true; executed_at = now`. (Token sweeps may continue after this — see §6.)

### `close_executed_vault` (existing, keep) — permissionless-ify
After `executed`, return remaining vault lamports (rent + SOL dust) and any token
dust to the **largest-share beneficiary** (DECISION 1 — not the presumed-inactive
owner), and close `VaultConfig` + `HeartbeatRecord` + `TokenDist` PDAs.
Permissionless so the crank can fully clean up. The "largest-share beneficiary"
is computed on-chain (max `share_bps`; ties → lowest index).

### Keep heartbeats agent-signed
`record_heartbeat` stays `agent`-only — liveness must be owner-controlled.

---

## 5. Execution flow (a crank runs this after grace)
```
for i in 0..beneficiaries.len:   execute_sol_share(i)          # n txs
finalize_execution()                                            # 1 tx (SOL done)
for each mint held by vault:
  for i in 0..beneficiaries.len:  execute_token_share(i, mint)  # m×n txs
close_executed_vault()           # sweep rent + dust → owner, close PDAs
```
A crank discovers mints by reading the vault PDA's token accounts
(`getTokenAccountsByOwner`). Every step is idempotent — re-running skips
already-paid (mask bit set) shares, so a crashed/partial crank is safely resumed
by the same or a different caller.

---

## 6. Idempotency, ordering, partial state
- **SOL before finalize**, but **tokens can run after finalize** (guarded by
  grace + per-mint mask, not by `active`) — so a vault marked executed can still
  have its tokens swept. This avoids needing the program to know the full mint
  list at finalize time (it can't).
- Masks make every payout exactly-once regardless of call order or retries.
- `close_executed_vault` should refuse while any vault ATA still holds tokens
  (so dust/tokens aren't orphaned) — or close them too.

---

## 7. Edge cases
- **Rounding dust:** `Σ floor(snapshot·share/10000) ≤ snapshot`; remainder stays
  in vault → returned to owner on close. (Tokens: dust stays in vault ATA →
  swept on close.)
- **Rent reserve:** SOL snapshot excludes the rent-exempt minimum so the vault
  account survives until `close`.
- **Shares must sum to 10000** (already enforced at init) — guarantees full
  distribution minus dust.
- **Beneficiary ATA missing:** caller creates it (idempotent ATA ix) and pays
  its rent. Beneficiaries cranking their own share naturally do this.
- **Fee payment:** the caller pays. Beneficiaries cranking pay ~0.000005 SOL +
  any ATA rent — negligible vs. inheritance.
- **Agent leftover SOL:** DECISION 4 — **reduce agent funding at setup** to just
  what heartbeats need over the interval (e.g. ~0.01 SOL instead of 0.05), so
  little is stranded if the vault executes autonomously with no app to refund the
  agent. Owner can always top up. Client change in `EstateReviewScreen`
  (`AGENT_FUNDING_LAMPORTS`) + the app's own revoke still refunds whatever's left.

---

## 8. The crank (no trust, multiple independent runners)
- **Notify server:** after grace, runs §5 (keyless — just submits + pays). Already
  watching the chain; add an executor module. If it's down, execution waits or
  another party cranks.
- **Beneficiaries:** an app/web button "Claim inheritance" that runs §5 — fully
  permissionless, incentive-aligned.
- **App (owner side):** existing Stage-4 path switches to these instructions too.

---

## 9. Client changes
- `ExecutionService` → call the new permissionless instructions (owner/agent as
  fee payer when app-driven). Drop app-side amount math (program owns it now).
- Notify server: add `executor.js` (enumerate beneficiaries + mints, submit §5).
- IDL re-sync + bundled types.

---

## 10. Backward compatibility
Devnet only, all vaults are ours → replace the old agent-signed execute
instructions with the permissionless ones (keep names where possible to limit
client churn). Old vaults can be revoked/recreated. No mainnet yet.

---

## 11. Security analysis
- **Theft:** impossible — funds only move to stored beneficiary wallets, amounts
  fixed by snapshot×share. Caller controls nothing.
- **Premature execution:** blocked by grace check (same as today).
- **Griefing:** a spammer can only pay the fees to run the owner's plan. No harm.
- **Snapshot manipulation:** snapshot read by the program from chain at first
  payout; caller can't set it. (Someone could inflate a token snapshot by
  *donating* tokens to the vault ATA before execution — that only increases what
  beneficiaries receive. Harmless.)
- **DoS via partial:** masks make it resumable; no stuck state.

---

## 12. Test plan (Anchor)
- happy path SOL: n beneficiaries, correct amounts, dust to owner on close
- happy path SPL: per-mint snapshot, correct amounts, ATA creation
- permissionless: a *random* keypair (not agent/owner) cranks successfully
- idempotency: double-call same share → second fails (mask set), no double-pay
- grace gate: crank before grace → fails
- finalize gate: finalize before all SOL paid → fails
- resume: pay subset, finalize blocked; pay rest; finalize ok; tokens after
- close: refuses with tokens present; succeeds after sweep; rent+dust → owner
- regression: all existing 36 tests adapted

## 13. Rollout
Build → full test suite green → redeploy devnet → re-sync IDL → client +
server executor → end-to-end test (fresh vault, let grace elapse in demo,
server cranks with app fully closed → assets land in beneficiary wallets).

---

## 14. Decisions (RESOLVED)
1. **Dust & leftover rent** → **largest-share beneficiary** on close (not owner).
2. **Crank coverage v1** → **both** the keyless notify-server executor **and** a
   beneficiary "Claim inheritance" path.
3. **Fee model** → **cranker pays** (no vault reimbursement; beneficiaries/server
   are already motivated).
4. **Agent leftover SOL** → **reduce agent funding at setup** (~0.01 SOL) so
   little is stranded on autonomous execution.

## 15.5 Review revisions (3-agent panel — security / correctness / best-practices)

**Must-fix before implementation. The existing instructions use patterns that are
unsafe under permissionless calling — do NOT copy them verbatim.**

### CRITICAL (security — fund loss)
- **R1 — Index-equality, NOT membership.** The current `execute_sol_distribution`
  / `execute_distribution` validate the destination with `beneficiaries.iter()
  .any(|b| b.wallet == key)`. Under permissionless calling this lets a malicious
  beneficiary call `execute_sol_share(index = 0)` (highest share) while passing
  *their own* (registered) wallet → they collect beneficiary 0's share and mask
  bit 0 is set → beneficiary 0 is robbed. **Require
  `beneficiary.key() == vault.beneficiaries[index].wallet`.**
- **R2 — Hard-pin every token account.** `vault_ata.owner == vault_config.key()
  && vault_ata.mint == mint`; `beneficiary_ata.owner ==
  vault.beneficiaries[index].wallet && beneficiary_ata.mint == mint`; `mint`
  typed; `TokenDist` seeds `["token_dist", vault, mint]` derived from that same
  mint. Without these, a caller substitutes their own ATA (theft) or a dummy
  vault_ata (snapshot/lock grief).
- **R3 — Close destination pinned on-chain.** Anchor `close = X` drains to a
  caller-supplied account → a cranker passes their own wallet and steals all rent
  (~0.004+ SOL) + dust. Compute `max_idx` (max `share_bps`, ties → lowest index)
  in the handler and `require!(dest.key() == beneficiaries[max_idx].wallet)`
  (and the dest ATA owner == that wallet for token dust).

### HIGH
- **R4 — Zero-amount shares set the mask bit and skip the transfer** (drop
  `require!(amount > 0)`). Otherwise a 0/tiny share (or empty vault) never sets
  its bit → `finalize` (needs full mask) is unreachable → vault + assets freeze
  forever. *(All three reviewers, highest practical priority.)*
- **R5 — Snapshot is write-once via an explicit strict-`init` `begin_execution()`
  and `begin_token_dist(mint)`** — NOT `init_if_needed`. Avoids the
  reinitialization-attack class and the "recompute lower snapshot on 2nd call →
  underpay everyone" bug. `execute_*_share` then takes the log/dist as a plain
  `Account` that must already exist. *(All three reviewers.)*
- **R6 — `u128` intermediate:** `amount = ((snapshot as u128) * (share_bps as
  u128) / 10_000) as u64`. `snapshot * 10000` overflows u64 for SPL token base
  units (e.g. 9-decimal, billion-supply ≈ 1e18). Final cast is safe (≤ snapshot).
- **R7 — Don't close a `TokenDist` while its vault ATA still holds tokens.**
  Anchor `close` zeroes it; a re-created `TokenDist` resets `paid_mask`/snapshot →
  re-distribution / double-pay. Close per-mint only when that ATA balance is 0
  (or close the ATA in the same ix).

### MEDIUM
- **R8 — Freeze owner mutations once execution has started / grace elapsed:**
  block `update_vault`, `withdraw_sol_from_vault`, `withdraw_from_vault`,
  `revoke_vault`, `rotate_agent`. Mid-distribution beneficiary edits corrupt the
  mask/snapshot/index→wallet mapping; a withdrawal drops balance below snapshot
  and wedges finalize. Gate on `now < deadline` or `!execution_started`.
- **R9 — Token orphaning / junk-mint DoS on close.** The program canNOT enumerate
  the vault's ATAs, so "refuse close while tokens remain" only checks the ATAs the
  caller passes — auto-closing `VaultConfig` can permanently orphan tokens (PDA
  can no longer sign). Resolution: do **not** auto-close `VaultConfig` in the
  crank; require an explicit close that takes all vault ATAs as `remaining_accounts`,
  asserts each empty, and sweeps any residual to the largest beneficiary (R3).
  Stop claiming the soft guard is sufficient.
- **R10 — Bounds before shift:** `require!((index as usize) < beneficiaries.len())`
  before `1u32 << index`; static-assert `MAX_BENEFICIARIES (20) <= 32`.

### LOW
- **R11 — Token-2022:** use `token_interface`/`InterfaceAccount` so 2022 assets
  (discovered via Helius DAS) are sweepable; or explicitly document classic-SPL-only.
- **R12 — Defensive:** `require!(beneficiary.key() != vault_config.key())`.
- **R13 — Integrity:** increment `transfer_count`/`total_sol_distributed` only on a
  mask bit 0→1 transition (permissionless retries must not inflate the log).

### Confirmed CORRECT (no change)
- Bitmask over a stored ≤20 beneficiary set is the right pattern (merkle is
  overkill). Push-with-pull-capability hybrid is optimal — **no separate "Claim"
  instruction; beneficiary-claim and server-crank call the same ix, only fee payer
  differs.** Per-beneficiary tx granularity is within limits. Grace deadline
  `checked_add` chain on i64 is safe. Direct-lamport SOL transfer (not
  system_program::transfer) is correct for the program-owned PDA. Snapshot-once +
  donation-harmless holds (given R5). Rent-reserve exclusion from snapshot is right.

### Open decisions raised by the panel (need your call — see §17)
- **`has_specific_assets`** is ignored by pure-pro-rata distribution — intended, or
  a dropped feature?
- **Close rent destination:** largest-share beneficiary (Decision 1, but R3 adds
  on-chain max-share logic + validated dest) vs. simpler **rent → owner** (owner
  paid it; dust → largest beneficiary). Reviewers note rent→owner is simpler & safe.

## 16. PART 2 — Specific-asset bequests (integrated with permissionless execution)

**Current reality:** specific assets are 100% unimplemented scaffolding — on-chain
is only a `has_specific_assets` bool (no assignment data), the UI hardcodes
`hasSpecificAssets: false`, and `distribute_specific_asset` is a no-op. This Part
makes it real. DECISION: build together with Part 1.

### 16.1 Semantics — "specific bequests are exact; shares govern the residual"
- A **specific assignment** gives beneficiary *B* an exact asset: a whole NFT, or
  an exact amount of a fungible mint. NFTs are always specific (can't be split).
- After specifics are carved out, **everything left** (SOL + each mint's residual)
  is split **pro-rata by `share_bps`** among all beneficiaries.
- A beneficiary can have **both**: a specific bequest **plus** their `share_bps`
  of every residual pool. (`has_specific_assets` just flags they appear in the
  assignment list; `share_bps` still counts for residual.)
- Shares still sum to 10000 and govern only residuals.

### 16.2 On-chain storage — new `AssetPlan` PDA
Seeds `["asset_plan", vault]`. Created/updated by the **owner** via
`set_asset_plan` during setup (separate from `initialize_vault` to keep init small;
blocked once execution starts per R8). Bounded list (e.g. `MAX_ASSIGNMENTS = 25`):
```
AssetAssignment { mint: Pubkey(32), amount: u64(8), beneficiary_index: u8(1), is_nft: bool(1) }
```
`amount` = exact base units for fungible; `1` and `is_nft=true` for an NFT.
A growable `Vec<AssetAssignment>` + `paid_mask: u32` (bit per assignment) + bump.
Validation at `set_asset_plan`: every `beneficiary_index < beneficiaries.len`; no
two `is_nft` assignments for the same mint; ≤ 32 assignments (mask width, R10).
(Cannot validate amount ≤ holdings — deposits can come later; handled at execution.)

### 16.3 Residual snapshot math (carve-out)
- **SOL residual** (at `begin_execution`): `sol_lamports − rent − Σ(specific SOL
  assignments)`. (Specific SOL is rare but allowed via a native-mint sentinel; if
  none, residual = SOL − rent as before.)
- **Token mint M residual** (at `begin_token_dist(M)`): `ata_balance −
  Σ(assignment.amount for mint==M)`. For an NFT-only mint, residual = 0.
  `saturating_sub` so an under-funded mint yields residual 0 (no underflow).
- Pro-rata share then = `((residual as u128) × share_bps / 10000) as u64` (R6).

### 16.4 Execution flow (permissionless, idempotent)
```
begin_execution()                       # snapshot SOL residual (excl. specific SOL)
for each mint M held by vault:
  begin_token_dist(M)                   # snapshot mint residual = balance − Σspecific(M)
for each assignment a (index j):
  execute_specific_asset(j)             # transfer a.amount of a.mint → beneficiaries[a.bi]
for i in 0..beneficiaries.len:
  execute_sol_share(i)                  # residual pro-rata (Part 1)
finalize_execution()                    # requires all SOL shares + all specifics paid
for each mint M, for i in 0..len:
  execute_token_share(i, M)             # residual pro-rata (Part 1)
close(...)                              # sweep dust/rent → largest beneficiary; close AssetPlan too
```
**Ordering rule (critical):** `begin_token_dist(M)` MUST precede
`execute_specific_asset` for mint M — so the residual is computed from the FULL
balance and correctly subtracts specifics. Enforce: `execute_specific_asset(j)`
requires `TokenDist[vault, a.mint]` to already exist (NFT mints get a TokenDist
with residual 0 too). This makes the snapshot order-independent of when specifics
actually transfer.

### 16.5 New/changed instructions (all permissionless except set_asset_plan)
- `set_asset_plan(assignments)` — **owner-signed**, pre-execution only. Strict
  `init` (or realloc) of `AssetPlan`. Validates §16.2.
- `begin_token_dist(mint)` — snapshot residual = balance − Σspecific(mint) (reads
  AssetPlan). Strict `init` of `TokenDist` (R5).
- `execute_specific_asset(assignment_index)` — permissionless. **Security (mirror
  R1–R3):** `require!(beneficiary.key() == beneficiaries[assignment.bi].wallet)`
  (index-equality, R1/C3); pin `mint`, `vault_ata.owner/mint`,
  `beneficiary_ata.owner==beneficiaries[bi].wallet && .mint==mint` (R2/C2);
  `u128` not needed (exact amount, no multiply); set AssetPlan `paid_mask` bit;
  transfer `min(amount, vault_ata.amount)` (under-funded → best-effort, documented).
  Zero/empty → still set bit (R4 analog) so finalize isn't blocked.
- `finalize_execution()` — now requires `sol_paid_mask == full(len)` **and**
  `asset_plan.paid_mask == full(n_assignments)`.

### 16.6 UI (app)
- `BeneficiaryScreen` / a new **Specific Bequests** step: pick an asset from the
  vault's scanned holdings (PortfolioScanner), assign whole-NFT or an amount to a
  beneficiary; set `hasSpecificAssets` true for those beneficiaries. Persist to
  `AssetPlan` via `set_asset_plan` at setup (in the EstateReview MWA tx batch, or a
  follow-up owner tx).
- Validation client-side mirrors §16.2 (+ live "amount ≤ current vault holding"
  warning, non-blocking since holdings can change).
- `ExecutionService` / crank: implement the real `distribute_specific_asset` →
  `execute_specific_asset`; remove the no-op stub.

### 16.7 Security & correctness additions (beyond R1–R13)
- **R14 — specific-asset assignee pinned by index-equality + ATA owner/mint** (same
  theft class as R1/R2 — a cranker must not redirect a bequest).
- **R15 — AssetPlan immutable once execution starts** (extends R8): no
  `set_asset_plan` after begin; else mask/index drift.
- **R16 — Σspecific underfunding is deterministic:** specifics paid in assignment
  order via `min(amount, available)`; residual `saturating_sub`. Document that an
  under-funded vault degrades gracefully (earlier assignments fully paid, later
  capped) rather than reverting/locking.
- **R17 — NFT one-owner invariant** enforced at `set_asset_plan` (no two is_nft
  assignments share a mint) and naturally at execution (amount 1, ATA emptied).
- **R18 — residual could be 0 for a fully-assigned mint:** `begin_token_dist`
  residual 0 → all `execute_token_share` amounts 0 → mask bits set, no transfer
  (R4). Coherent.

### 16.8 Decisions (RESOLVED)
1. **Specific SOL IS allowed.** A native-SOL sentinel mint (e.g. `So111...111`)
   in an assignment means an exact lamport bequest. SOL residual (§16.3) =
   `sol_lamports − rent − Σ(specific SOL assignments)`; `execute_specific_asset`
   for the SOL sentinel does a direct-lamport transfer (no ATA).
2. **MAX_ASSIGNMENTS = 64**, tracked with a **`paid_mask: u64`** on `AssetPlan`
   (NOTE: the beneficiary mask stays `u32` — ≤20 beneficiaries; only the
   *assignment* mask is u64). Static-assert 64 ≤ 64.
3. **Graceful degrade** (R16): specifics paid in assignment-index order via
   `min(amount, available)`; mint residual uses `saturating_sub`; never reverts or
   locks. Documented behavior. Client shows a non-blocking "amount > current
   holding" warning at setup.

## 17. Combined-design review synthesis (Part-2 panel: security / correctness / integration)

Folds in all Part-2 findings. **These are blocking unless marked fast-follow.**

### CRITICAL — must fix or vaults wedge / bequests are stolen
- **P1 — `AssetPlan` is mandatory & seeds-pinned** in `begin_execution`,
  `begin_token_dist`, `execute_specific_asset`, `finalize`. Typed
  `Account<AssetPlan>` (program-owned + discriminator), seeds `["asset_plan",
  vault]`. Add `vault_config.has_asset_plan: bool` (set at `set_asset_plan`): when
  true the canonical plan is REQUIRED everywhere (can't be omitted to zero the
  carve-out → else every bequest collapses into residual and is redirected). When
  false the account is forbidden / treated vacuous. Sum specifics with
  `saturating_add`.
- **P2 — SOL sentinel = `Pubkey::default()` (NOT wSOL `So111…`).** wSOL is a real
  holdable mint → collision/type-confusion/deadlock. Sentinel-SOL
  `execute_specific_asset` branches on `mint == default` → direct-lamport, gated on
  **`ExecutionLog` existing** (not `TokenDist`); cap transfer at
  `min(amount, lamports − rent − sol_specific_paid)` so the rent reserve can't be
  drained; SOL residual = `lamports.saturating_sub(rent).saturating_sub(ΣspecificSOL)`.
- **P3 — in-order specific execution enforced on-chain.** Permissionless callers
  choose call order, so "assignment-index order" is NOT guaranteed by storage
  order. `execute_specific_asset(j)` must require all lower-index assignments
  **for the same mint** already paid — else a cranker starves an earlier bequest
  when under-funded / picks the NFT recipient.
- **P4 — `begin_token_dist` / `execute_token_share` / token `execute_specific_asset`
  gate on GRACE-ELAPSED ONLY**, never `active`/`!executed`. Tokens run AFTER
  `finalize` (which sets `executed=true`), and residual-only mints may be
  discovered post-finalize — copying the old `active && !executed` guard would
  freeze every residual token and wedge `close`.
- **P5 — `1u64 << 64` UB** (MAX_ASSIGNMENTS=64 makes it reachable): compute
  `full_mask(n) = ((1u128 << n) - 1) as u64`. Same widened pattern for the u32
  beneficiary mask preemptively.
- **P6 — Token-2022 via `InterfaceAccount`/`Interface<TokenInterface>`** on EVERY
  token instruction (begin_token_dist, execute_token_share, execute_specific_asset,
  close sweep). A single T-2022 holding (discoverable via Helius DAS) is
  un-transferable with classic `Program<Token>` → ATA never empties → `close`
  never succeeds → vault + rent stranded forever. **Promoted from R11/LOW to
  blocking.**

### HIGH
- **P7 — pin `mint == assignment.mint`** in `execute_specific_asset` (caller can't
  substitute a worthless mint to mark a bequest "paid"). Derive `TokenDist`/ATAs
  from `assignment.mint`, never a free caller account.
- **P8 — full constraint list for `execute_specific_asset`** (token): bounds on
  `assignment_index` and `beneficiary_index` BEFORE any shift; index-equality
  `beneficiary.key() == beneficiaries[bi].wallet`; `mint == assignment.mint`;
  `vault_ata.owner==vault && .mint==assignment.mint`;
  `beneficiary_ata.owner==beneficiaries[bi].wallet && .mint==assignment.mint`;
  `TokenDist` pre-exists; mask unset→set (set even on 0/empty transfer);
  `transfer min(amount, vault_ata.amount)`; in-order (P3); `beneficiary != vault`.
- **P9 — NFT one-owner: at most ONE assignment per NFT mint** (not just per
  `is_nft` flag); validate `decimals==0 && supply==1` when `is_nft` (pass `Mint`).
- **P10 — freeze `set_asset_plan` + beneficiary edits at `now >= deadline`** (not
  at `begin_*`): a late append for an already-snapshotted mint over-distributes.
  Same R8 grace gate. `update_vault` must also reject beneficiary-set changes
  while `AssetPlan` exists (index→wallet drift) — store `wallet` in the assignment
  and check both at execution, or reject the edit.
- **P11 — unheld-mint liveness:** `begin_token_dist` tolerates a missing vault ATA
  (balance 0, residual 0) so an assignment to a never-held mint can still be
  cleared; `finalize` treats an **absent `AssetPlan`** (pure Part-1, 0 assignments)
  as vacuously satisfied.

### STRUCTURAL SIMPLIFICATIONS (adopt)
- **S1 — batch the share instructions (highest leverage).** Replace per-beneficiary
  txs with `execute_sol_shares(indices: Vec<u8>)` and
  `execute_token_shares(mint, indices)`, wallets/ATAs in `remaining_accounts`.
  Keep per-beneficiary *masking* (skip set bits → idempotent) and index-equality.
  Cuts a 3-benef/3-mint vault from ~20 txs to ~8 and collapses crank sequencing.
  Keep single-index as a fallback for >~20-account tx-size cases.
- **S3 — decompose close:** `close_token_dist(mint)` (permissionless; asserts that
  ATA empty, closes ATA+TokenDist, sweeps dust) ×mints, then `close_vault()`
  (asserts masks full + no ATA/TokenDist remain, closes the 3 core PDAs +
  AssetPlan). Delete agent `close_executed_vault`; fold `close_vault_ata`. Make
  each close tx tiny + idempotent like the rest.
- **S4 — drop dead fields:** remove `Beneficiary.has_specific_assets` from the
  on-chain struct (AssetPlan is authoritative; keep as derived UI flag), and
  `ExecutionLog.attestation_hash` / `token_types_distributed` (meaningless in a
  permissionless model). Update SPACE.
- **S5 — `AssetPlan` fixed-size `init` at MAX (64×~42B ≈ 2.7KB)** + an owner-only
  `update_asset_plan` (overwrite, pre-exec) — no realloc/growable Vec.
- **ExecutionLog existence == the R8 "execution started" marker** (keep).
- **`transfer_count`/`total_sol_distributed` increment only on 0→1 mask transition.**

### Recommended final instruction surface (~10 new/changed)
`set_asset_plan` + `update_asset_plan` (owner) · `begin_execution` ·
`begin_token_dist(mint)` · `execute_sol_shares(indices)` ·
`execute_token_shares(mint, indices)` · `execute_specific_asset(j)` ·
`finalize_execution` · `close_token_dist(mint)` · `close_vault`. **Delete**
`execute_sol_distribution`, `execute_distribution`, `record_execution`, agent
`close_executed_vault`, `close_vault_ata`. Existing owner ix gain the R8/P10 grace
freeze.

### TWO findings that revisit earlier decisions (need user re-confirm — §18)
- **Specific-SOL (Decision 16.8.1 = allow):** the panel recommends **cutting it
  from v1** (token/NFT-only). It's the most fragile interaction (Anchor can't
  runtime-conditionally require ATA vs lamport accounts → forces a 2nd instruction
  or optional accounts) for a rarely-used feature; clean fast-follow.
- **Rent destination (Decision 1 = everything → largest beneficiary):** the panel
  recommends **rent → owner** (owner paid it; it's part of the estate) to avoid the
  on-chain max-share computation + the R3 validated-destination attack surface, and
  keep only **token/SOL dust → largest beneficiary**.

### Client/server blast radius (from integration review)
Client SHRINKS: `ExecutionService` deletes off-chain amount math + the
`distributable_snapshot` SQLite cache + agent signing (on-chain masks are now the
authoritative idempotency layer; SQLite becomes a progress mirror).
`VaultTransactionService` builders change only the fee payer. The crank is the
net-new work — a mask-driven "do the next undone thing" state machine replicated in
3 places (notify-server executor, app owner-path, beneficiary Claim). Reduce
`AGENT_FUNDING_LAMPORTS` 0.05 → ~0.01 (Decision 4).

## 18. Final decisions (RESOLVED — both panel recs accepted)
1. **Specific-SOL CUT from v1** (fast-follow). Specifics are **SPL tokens + NFTs
   only**. Consequences (simplifications): no SOL sentinel (P2 SOL parts dropped);
   `begin_execution` does NOT read `AssetPlan` → SOL residual = `lamports − rent`
   (identical to Part 1); `execute_specific_asset` is a single clean token/NFT path
   (no ATA-vs-lamport branch, no conditional accounts). `AssetPlan` is still
   mandatory & seeds-pinned for the token instructions (P1 stands).
2. **Rent → owner; token/SOL dust → largest-share beneficiary.** `close_vault`
   returns the 3 core PDAs' rent to `owner` (he paid it; part of the estate) — no
   on-chain max-share computation needed for rent. Only residual **dust** (token
   ATA leftovers, SOL rounding) sweeps to the largest-share beneficiary in
   `close_token_dist`/the dust path. Reduces R3 attack surface.

**STATUS: design fully vetted (6-agent panel, 2 rounds) and decisions locked.
Ready to implement per §15.7 build order, applying §15.5 (R1–R13) + §16.7 (R14–R18)
+ §17 (P1–P11, S1/S3/S4/S5) with §18 simplifications.**

## 15.7 Build order
1. Program: state changes (`ExecutionLog`, `TokenDist`), `execute_sol_share`,
   `execute_token_share`, `finalize_execution`, permissionless+largest-beneficiary
   `close`. Remove agent-signer from execute path.
2. Anchor tests (§12) — green on localnet/devnet.
3. Redeploy devnet + re-sync IDL/types.
4. Client: `ExecutionService` → new instructions; reduce `AGENT_FUNDING_LAMPORTS`.
5. Server: `executor.js` crank (enumerate beneficiaries + mints, run §5 after grace).
6. App: beneficiary "Claim inheritance" path.
7. End-to-end: fresh vault → grace elapses in demo → server cranks with app fully
   closed → assets land in beneficiary wallets. Then build APK + release.
