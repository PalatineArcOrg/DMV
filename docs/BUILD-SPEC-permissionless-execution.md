# BUILD SPEC — Permissionless Autonomous Execution + Specific Bequests

**Status:** SHIPPED — reconciled to the as-built code on 2026-07-05 (this was the
pre-build design; the implementation evolved past it). The sections below now describe
what actually shipped; subsystems added during the build (specific-SOL, the keeper bounty,
the 0.01 SOL creation fee, the permissionless `close_executed_vault` + its 24h window, the
`devnet` Cargo feature, `open_token_dists`) are summarized authoritatively in **§0.5**. The
pre-build design narrative lives in `permissionless-execution-design.md`.

**Program:** Anchor 0.32.1 · Rust 1.89.0 · Agave/Solana CLI 3.1.10 · Program ID
`GXCu5964mvgAJDWmcMriZpzU3vDVqPzjYCM1sxCnsoEb` (devnet; mainnet reuses the same keypair).

---

## 0. TL;DR — what we are building

Today the vault only distributes assets when the owner opens the app (the app's
escalation loop reaches Stage 4 and the on-device agent key signs the payouts). If
the owner is incapacitated, **nothing executes** — which defeats a dead-man's-switch.

We are making execution **permissionless and trustless**: after the grace period,
the on-chain program computes every payout from on-chain state, and **anyone** (a
beneficiary — from the mobile app OR the web app at `dmvapp.palatinearc.com` — the
keyless notify-server, any keeper) can submit the transactions.
The caller controls nothing — funds can only go to the pre-set beneficiaries, in the
pre-set proportions, after the deadline. No trusted trigger, no server holding keys,
no app required.

Two distribution modes, combined:
- **Pro-rata:** SOL + each token's residual split by `share_bps`.
- **Specific bequests (SPL tokens, NFTs, and SOL):** an owner-defined `AssetPlan`
  assigns exact token amounts / whole NFTs / exact SOL to specific beneficiaries; those
  are carved out first, the remainder splits pro-rata. SOL bequests use a zero-pubkey
  sentinel mint paid by `execute_specific_sol`. A beneficiary can receive a specific
  bequest **and** their share of the residual.

---

## 0.5 As-built deltas (authoritative — what shipped beyond/differently from the design)

The build added several subsystems and reversed two "cut/forbidden" decisions. This
section overrides the older numbered sections wherever they still read stale.

- **Specific-SOL bequests SHIPPED** (not cut — cf. D2/§14). `execute_specific_sol(j)` pays an
  `AssetPlan` assignment whose `mint == Pubkey::default()` (sentinel) by direct-lamport debit
  — a *separate* instruction from `execute_specific_asset` (which rejects the sentinel),
  sidestepping Anchor's conditional-accounts limit. Validated in `set_asset_plan`
  (`!is_nft && amount > 0` → `InvalidSolBequest`); carved out of the SOL snapshot at
  `begin_execution`.
- **Permissionless final close SHIPPED as `close_executed_vault`** (reverses §18 B2). Not
  forbidden — *guarded*: allowed only when `executed`, `completed`, `open_token_dists == 0`
  (`TokensRemain`), and the **24h owner-exclusive window** (`EXECUTED_CLOSE_DELAY` from
  `execution_log.started_at`; `CloseDelayNotElapsed`) has elapsed. Rents → the payer/keeper
  (cleanup reward — a dead owner's rent would otherwise strand); SOL dust → largest-share
  beneficiary. `close_executed_vault_by_owner` is the owner's no-wait path (rents → owner).
- **`open_token_dists: u16` on `VaultConfig`** — incremented by `begin_token_dist`, decremented
  by `close_token_dist`; both closes require it `== 0`. This counter (not forbidding the close)
  is what prevents orphaning a mint with a live distribution.
- **Keeper bounty.** `VaultConfig.keeper_bounty: u64` (client default 0.005 SOL, on-chain cap
  `MAX_KEEPER_BOUNTY_LAMPORTS = 0.1 SOL` → `KeeperBountyTooLarge`), set in `initialize_vault`
  params, carved out of the SOL snapshot at `begin_execution`, paid **once** to the
  `finalize_execution` payer. Makes permissionless cranking profitable.
- **0.01 SOL vault-creation fee.** `initialize_vault` CPIs `VAULT_CREATION_FEE_LAMPORTS`
  owner → `FEE_WALLET`, recipient pinned by `address = FEE_WALLET` (`InvalidFeeRecipient`).
- **Anti-grief `begin_token_dist`:** rejects a mint the vault neither holds nor bequeaths
  (`NothingToDistribute`).
- **Timing minimums are feature-gated.** Default (mainnet) build enforces 1 day / 7 days / 24h
  (`MIN_HEARTBEAT_INTERVAL` / `MIN_GRACE_PERIOD` / `EXECUTED_CLOSE_DELAY`); the `devnet` Cargo
  feature lowers them to 10s / 30s / 60s for tests. A CI test asserts the floors per profile.
  **Mainnet builds must NOT set `--features devnet`.**
- **21 instructions** (12 owner + 9 permissionless) and **45 error codes** — see §4/§12/§13.
- **Owner-mutation freeze** is deadline-based (`require!(now < deadline)` → `VaultFrozen`) plus
  the `!executed` constraint (no ExecutionLog account added, cf. B1's optional). `update_vault`
  beneficiary edits are blocked while `has_asset_plan` (`BeneficiariesLockedByPlan`).

---

## 1. Locked decisions

| # | Decision |
|---|---|
| D1 | Distribution = **specific bequests carved out first, residual split pro-rata**. A beneficiary may get both. |
| D2 | Specific bequests are **SPL tokens, NFTs, and SOL**. Specific-SOL ships as its own instruction (`execute_specific_sol`, zero-pubkey sentinel mint, direct-lamport transfer — sidesteps Anchor's conditional-accounts limit). SOL residual (after specific-SOL + keeper bounty) splits pro-rata. |
| D3 | `MAX_ASSIGNMENTS = 64`, tracked with a `u64` paid-mask. `MAX_BENEFICIARIES = 20`, `u32` paid-mask. |
| D4 | **Under-funding degrades gracefully**: specifics paid in enforced index order via `min(amount, available)`; residual `saturating_sub` → 0; finalize stays reachable. |
| D5 | On close: **rent → owner** (owner close) or **→ payer/keeper** (permissionless `close_executed_vault`, the cleanup reward); **token/SOL dust → largest-share beneficiary**. |
| D6 | Triggers: **notify-server executor crank** + **beneficiary "Claim" path** — the *same* permissionless instructions, only the fee payer differs. Cranker pays fees. |
| D7 | Reduce client `AGENT_FUNDING_LAMPORTS` 0.05 → **0.005 SOL** (heartbeat fees only; later halved from 0.01 to 0.005). Separate from the on-chain 0.01 SOL creation fee (§0.5). |
| D8 | Token instructions use **`InterfaceAccount`/`Interface<TokenInterface>`** (Token-2022 support — blocking). |

---

## 2. Architecture (final)

```
Setup (owner, MWA):   initialize_vault  ->  [set_asset_plan]  ->  deposit assets
                                              (optional, owner)
Grace elapses (no heartbeats).
Anyone cranks (server / beneficiary / keeper), reading on-chain masks to resume:
   begin_execution()                      # snapshot SOL residual = lamports - rent - Σspecific-SOL - keeper_bounty
   for each mint M held by vault:
     begin_token_dist(M)                  # snapshot residual = bal(M) - Σspecific(M)
   for each specific assignment j (in-order per mint):
     execute_specific_sol(j)   if a.mint == Pubkey::default()  # exact SOL -> assignee (sentinel)
     execute_specific_asset(j) otherwise                       # exact token/NFT -> assignee
   execute_sol_shares([indices])          # SOL residual pro-rata (batched)
   finalize_execution()                   # sol mask full AND asset_plan mask full
   for each mint M:
     execute_token_shares(M, [indices])   # token residual pro-rata (batched)
   for each mint M:
     close_token_dist(M)                  # ATA empty -> close ATA + TokenDist, dust->largest benef
   close_executed_vault()                 # after 24h window: close core PDAs, rent->keeper (owner path: close_executed_vault_by_owner, rent->owner)
```

**Idempotency:** every payout sets a bit in a per-asset bitmask; re-running skips set
bits. A crashed/partial crank is safely resumed by anyone. The on-chain masks are the
authoritative idempotency layer (the app's SQLite checkpoint becomes a progress mirror).

**Order-independence:** the snapshot for each asset is frozen at its `begin_*` (strict
`init`), so the *actual* transfer order (specifics vs pro-rata, interleaved, multi-
cranker) never changes amounts — only physical availability matters, and conservation
guarantees every transfer is coverable.

---

## 3. On-chain state

`constants.rs` (as-built):
```rust
pub const MAX_BENEFICIARIES: usize = 20;   // u32 beneficiary mask
pub const MAX_ASSIGNMENTS:   usize = 64;   // u64 assignment mask
pub const VAULT_CREATION_FEE_LAMPORTS: u64 = 10_000_000;   // 0.01 SOL -> FEE_WALLET
pub const FEE_WALLET: Pubkey = pubkey!("98x9Rn63…UFsp");   // creation-fee recipient (pinned)
pub const KEEPER_BOUNTY_LAMPORTS:     u64 = 5_000_000;     // 0.005 SOL client default
pub const MAX_KEEPER_BOUNTY_LAMPORTS: u64 = 100_000_000;   // 0.1 SOL on-chain cap
// timing minimums — DEFAULT (mainnet); the `devnet` feature lowers them (see §11)
pub const MIN_HEARTBEAT_INTERVAL: i64 = 86_400;   // 1 day  (devnet: 10)
pub const MIN_GRACE_PERIOD:       i64 = 604_800;  // 7 days (devnet: 30)
pub const EXECUTED_CLOSE_DELAY:   i64 = 86_400;   // 24 h   (devnet: 60) — owner-exclusive close window
const _: () = assert!(MAX_BENEFICIARIES <= 32);
const _: () = assert!(MAX_ASSIGNMENTS   <= 64);
```

### 3.1 `VaultConfig` (modify)
- **Remove** `Beneficiary.has_specific_assets` (S4 — `AssetPlan` is authoritative;
  keep it only as a derived UI flag client-side).
- **Add** `pub has_asset_plan: bool` (P1 — set true by `set_asset_plan`; gates whether
  the canonical `AssetPlan` is required by the execution instructions).
- **Add** `pub open_token_dists: u16` — count of open `TokenDist` PDAs; ++ by `begin_token_dist`,
  −− by `close_token_dist`; both closes require `== 0` (orphan-prevention). *(as-built)*
- **Add** `pub keeper_bounty: u64` — lamports reserved for the finalize cranker (§0.5). *(as-built)*
- Beneficiary becomes `{ wallet: Pubkey, share_bps: u16 }`. Shares still sum to 10000
  (validated at `initialize_vault`). Both new fields came from former padding; `SPACE` unchanged.

### 3.2 `ExecutionLog` (modify) — also the "execution started" marker (R8)
```rust
#[account]
pub struct ExecutionLog {
    pub vault: Pubkey,                 // 32
    pub sol_snapshot: u64,             // 8   residual = (lamports − rent) − Σspecific-SOL − keeper_bounty, frozen at begin
    pub sol_paid_mask: u32,            // 4   bit i set when beneficiary i paid SOL
    pub started_at: i64,               // 8
    pub completed: bool,               // 1   set by finalize
    pub transfer_count: u32,           // 4   increment only on 0->1 mask transition (R13)
    pub total_sol_distributed: u64,    // 8
    pub bump: u8,                      // 1
}   // SPACE = 8 disc + 66 + 64 padding
```
**Remove** `attestation_hash` and `token_types_distributed` (S4 — meaningless now).
Seeds: `["execution", vault]`. The mere existence of this account == "execution begun".

### 3.3 `TokenDist` (new) — one per (vault, mint)
```rust
#[account]
pub struct TokenDist {
    pub vault: Pubkey,     // 32
    pub mint: Pubkey,      // 32
    pub snapshot: u64,     // 8   residual = ata_balance - Σspecific(mint), frozen at begin_token_dist
    pub paid_mask: u32,    // 4   bit i set when beneficiary i paid this token's residual
    pub bump: u8,          // 1
}   // SPACE = 8 disc + 77 + 32 padding
```
Seeds: `["token_dist", vault, mint]`.

### 3.4 `AssetPlan` (new) — one per vault, fixed-size (S5)
```rust
#[account]
pub struct AssetPlan {
    pub vault: Pubkey,                          // 32
    pub assignments: Vec<AssetAssignment>,      // 4 + 64*42 = 2692 (fixed cap MAX_ASSIGNMENTS)
    pub paid_mask: u64,                         // 8   bit j set when assignment j executed
    pub bump: u8,                               // 1
}   // SPACE = 8 disc + 2733  (~0.02 SOL rent, owner-paid, returned on close)

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct AssetAssignment {
    pub mint: Pubkey,             // 32  zero-pubkey sentinel = SOL bequest; else SPL/NFT mint
    pub amount: u64,              // 8   exact base units; 1 for an NFT
    pub beneficiary_index: u8,    // 1
    pub is_nft: bool,             // 1
}   // 42 bytes
```
Seeds: `["asset_plan", vault]`. Created via `set_asset_plan` (strict `init` at full
size); edited via `update_asset_plan` (owner overwrite). Both owner-only, pre-grace.

### 3.5 Mask helper (P5 — `1<<64` is UB)
```rust
#[inline] fn full_mask_u64(n: usize) -> u64 { ((1u128 << n) - 1) as u64 }   // n<=64 ok
#[inline] fn full_mask_u32(n: usize) -> u32 { ((1u64  << n) - 1) as u32 }   // n<=32 ok
```

---

## 4. Instructions

Common helpers:
- `deadline(vault, hb) = hb.last_heartbeat + vault.heartbeat_interval + vault.grace_period`
  via `checked_add` chain on i64 (reuse existing pattern). `grace_elapsed = now >= deadline`.
- `rent_min = Rent::get()?.minimum_balance(VaultConfig::SPACE)`.
- All token accounts are `InterfaceAccount<'info, TokenAccount>` / `InterfaceAccount<Mint>`
  with `Interface<'info, TokenInterface>` (D8).
- Permissionless instructions take `payer: Signer<'info>` (fees + new-PDA rent only).

### 4.1 `set_asset_plan(assignments: Vec<AssetAssignment>)` — owner, pre-grace
Accounts: `owner: Signer` (mut) · `vault_config` (`has_one = owner`, seeds) ·
`asset_plan` (`init`, payer = owner, space = AssetPlan::SPACE, seeds=["asset_plan",vault]) ·
`system_program`.
Guards: `require!(now < deadline)` (P10); `!vault.executed`.
Validate (P9/R17, R10): `assignments.len() <= MAX_ASSIGNMENTS`; every
`beneficiary_index < beneficiaries.len()`; **at most one assignment per NFT mint**;
**SOL sentinel shape** (`mint == Pubkey::default()` ⟹ `!is_nft && amount > 0`, else
`InvalidSolBequest`); NFT decimals0/supply1 validated CLIENT-side (B4). Set `paid_mask=0`,
`has_asset_plan=true` on vault.
`update_asset_plan(assignments)` — same guards, overwrites the buffer (owner). (Use a
separate ix rather than `init_if_needed`.)

### 4.2 `begin_execution()` — permissionless, strict-init (R5)
Accounts: `payer: Signer`(mut) · `vault_config`(seeds) · `heartbeat_record`(seeds,
`has_one`-style vault check) · `execution_log`(`init`, payer, seeds=["execution",vault]) ·
`system_program`.
Guards: `require!(grace_elapsed)`; `require!(!vault.executed)`.
Accounts also include `asset_plan` (seeds; **required iff** `has_asset_plan`) so specific-SOL
can be summed. Logic: `sol_snapshot = (vault_lamports − rent_min) − Σspecific-SOL − keeper_bounty`
(saturating); `started_at = now`; `sol_paid_mask = 0`. (Second call fails:
account already exists — clean idempotency.)

### 4.3 `begin_token_dist(mint)` — permissionless, strict-init (R5, P4, P11)
Accounts: `payer`(mut) · `vault_config`(seeds) · `execution_log`(seeds, must exist) ·
`mint: InterfaceAccount<Mint>` · `vault_ata: Option<InterfaceAccount<TokenAccount>>`
(the vault's ATA for `mint`; **optional** — may not exist if never held, P11) ·
`asset_plan`(seeds; **required iff** `vault.has_asset_plan`, P1) ·
`token_dist`(`init`, payer, seeds=["token_dist",vault,mint]) · `system_program`.
Guards: `require!(grace_elapsed)` **only** (NOT active/executed — P4).
Logic:
```
let bal = vault_ata.map(|a| a.amount).unwrap_or(0);                 // P11 tolerate missing ATA
let spec_sum = if vault.has_asset_plan {
    asset_plan.assignments.iter()
        .filter(|a| a.mint == mint.key())
        .fold(0u64, |acc, a| acc.saturating_add(a.amount))          // P1 saturating_add
} else { 0 };
token_dist.snapshot = bal.saturating_sub(spec_sum);                 // R16 saturating
token_dist.mint = mint.key(); token_dist.vault = vault.key(); token_dist.paid_mask = 0;
```
**As-built:** also `require!(bal > 0 || mint ∈ plan)` else `NothingToDistribute` (anti-grief —
junk mints can't inflate `open_token_dists`); and `vault.open_token_dists += 1`.

### 4.4 `execute_specific_asset(assignment_index: u8)` — permissionless (token/NFT only)
Accounts: `payer`(mut) · `vault_config`(seeds) · `execution_log`(seeds, exists) ·
`asset_plan`(seeds, **required**, P1) · `mint: InterfaceAccount<Mint>` ·
`token_dist`(seeds=["token_dist",vault,mint], **must exist** — ordering gate §2) ·
`vault_ata: InterfaceAccount<TokenAccount>` · `beneficiary: UncheckedAccount` ·
`beneficiary_ata: InterfaceAccount<TokenAccount>` · `token_program: Interface<TokenInterface>`.
Guards (P8 — the full list, in order):
1. `require!(grace_elapsed)` (P4).
2. `let j = assignment_index as usize; require!(j < asset_plan.assignments.len())` (R10).
3. `let a = asset_plan.assignments[j];`
4. `let bi = a.beneficiary_index as usize; require!(bi < beneficiaries.len())`.
5. `require!(beneficiary.key() == beneficiaries[bi].wallet)` (R1/R14 index-equality).
6. `require!(mint.key() == a.mint)` (P7).
7. `require!(vault_ata.owner == vault.key() && vault_ata.mint == a.mint)` (R2).
8. `require!(beneficiary_ata.owner == beneficiaries[bi].wallet && beneficiary_ata.mint == a.mint)` (R2).
9. **in-order (P3):** `let lower = lower_index_same_mint_mask(asset_plan, a.mint, j);
   require!(asset_plan.paid_mask & lower == lower)` — all lower-index assignments for
   THIS mint already paid.
10. `require!(asset_plan.paid_mask & (1u64<<j) == 0)` (not already paid).
11. `require!(beneficiary.key() != vault.key())` (R12).
Logic: `let amt = a.amount.min(vault_ata.amount);` if `amt>0` → `token::transfer_checked`
CPI with vault-PDA signer seeds `["vault", owner, &[vault.bump]]`. **Always** set
`paid_mask |= 1<<j` (even if `amt==0` — R4, keeps finalize reachable). No counter inflation
on a re-call (it errors at guard 10).

### 4.4b `execute_specific_sol(assignment_index: u8)` — permissionless (SOL sentinel only) *(as-built)*
The SOL twin of §4.4 — a *separate* ix because a bare lamport account and token accounts can't
be conditionally required in one Anchor ix.
Accounts: `payer`(mut) · `vault_config`(seeds) · `execution_log`(seeds, exists) ·
`asset_plan`(seeds, **required**) · `beneficiary: UncheckedAccount`(mut).
Guards: grace (via ExecutionLog existence); `j < len`; `a.mint == Pubkey::default()` (else this
is the token path → `execute_specific_asset`); `bi < len`;
`beneficiary.key() == beneficiaries[bi].wallet` (index-equality); in-order via
`lower_index_same_mint_mask(plan, Pubkey::default(), j)`; not-already-paid.
Logic: `amt = a.amount.min(vault_lamports − rent_min)`; direct-lamport debit vault →
beneficiary; **always** set `paid_mask |= 1<<j` (even at 0). The amount was carved out of the
SOL snapshot at `begin_execution`, so it never touches the pro-rata residual.

### 4.5 `execute_sol_shares(indices: Vec<u8>)` — permissionless, batched (S1)
Accounts: `payer`(mut) · `vault_config`(seeds) · `execution_log`(seeds, exists) ·
`system_program` · **`remaining_accounts`** = the beneficiary wallets for `indices`,
same order.
Guards: `require!(grace_elapsed)`, `!vault.executed`.
For each `(k, idx)` in `indices`:
```
let i = idx as usize; require!(i < beneficiaries.len());                       // R10
require!(execution_log.sol_paid_mask & (1<<i) == 0);                            // skip if already
let w = remaining_accounts[k]; require!(w.key() == beneficiaries[i].wallet);    // R1 index-eq
let amt = ((execution_log.sol_snapshot as u128) * (beneficiaries[i].share_bps as u128) / 10_000) as u64;  // R6 u128
if amt > 0 {
    require!(w.key() != vault.key());                                           // R12
    **vault.lamports -= amt (checked_sub); **w.lamports += amt;                 // direct-lamport
    execution_log.total_sol_distributed += amt; execution_log.transfer_count += 1;  // R13 (0->1 only)
}
execution_log.sol_paid_mask |= 1<<i;                                            // R4 set even if 0
```
(Single-index fallback for >~20-account tx-size edge.)

### 4.6 `execute_token_shares(mint, indices: Vec<u8>)` — permissionless, batched (S1, P4)
Accounts: `payer`(mut) · `vault_config`(seeds) · `token_dist`(seeds, exists) ·
`mint: InterfaceAccount<Mint>` · `vault_ata: InterfaceAccount<TokenAccount>`
(owner==vault, mint==mint) · `token_program: Interface<TokenInterface>` ·
**`remaining_accounts`** = beneficiary ATAs for `indices` (each `owner==beneficiaries[idx].wallet
&& mint==mint`).
Guards: `require!(grace_elapsed)` **only** (P4 — runs after finalize).
For each `(k, idx)`: bounds; skip if `token_dist.paid_mask & (1<<i)`; verify
`remaining_accounts[k].owner == beneficiaries[i].wallet && .mint == mint`;
`amt = ((token_dist.snapshot as u128) * share_bps / 10_000) as u64` (R6); if `amt>0`
`transfer_checked` (vault-PDA signer); set `paid_mask |= 1<<i` always (R4).

### 4.7 `finalize_execution()` — permissionless (P11)
Accounts: `payer` · `vault_config`(mut, seeds) · `execution_log`(mut, seeds, exists) ·
`asset_plan`(seeds; **required iff** `vault.has_asset_plan`, else omitted → vacuous, P11).
Guards: `require!(grace_elapsed)`; `!vault.executed`;
`require!(execution_log.sol_paid_mask == full_mask_u32(beneficiaries.len()))`;
`require!(!vault.has_asset_plan || asset_plan.paid_mask == full_mask_u64(asset_plan.assignments.len()))`.
Logic: `vault.executed = true; vault.active = false; execution_log.completed = true`.
**As-built:** also pay `min(keeper_bounty, vault_lamports − rent)` to the finalize `payer` by
direct-lamport debit (runs once, guarded by `!executed`) — the keeper reward.
(Token `execute_token_shares` may still run after this — they gate on grace only.)

### 4.8 `close_token_dist(mint)` — permissionless (R7, S3, D5)
Accounts: `payer` · `vault_config`(seeds) · `mint` · `vault_ata`(mut,
owner==vault,mint==mint) · `token_dist`(mut, seeds, `close = payer`*) ·
`largest_benef_ata: InterfaceAccount<TokenAccount>` (owner==`beneficiaries[max_share_idx].wallet`,
mint==mint) · `token_program` · `vault_authority`(vault PDA).
Guards: `require!(grace_elapsed && vault.executed)`;
`require!(token_dist.paid_mask == full_mask_u32(beneficiaries.len()))` (all residual paid).
Logic: sweep any `vault_ata.amount` **dust → largest-share beneficiary ATA** (D5;
compute `max_share_idx` on-chain, ties→lowest index; the passed `largest_benef_ata`
must match); then **close the vault_ata** (CloseAccount CPI, vault PDA authority, rent
→ owner) and close `token_dist` (**TokenDist rent → payer/cranker**); **decrement
`vault.open_token_dists`**. *(as-built: rent split resolved — ATA → owner, TokenDist → payer.)*

### 4.9 `close_executed_vault()` — permissionless keeper close *(as-built; supersedes §18 B2)*
The final core-PDA close — permissionless but **guarded**; orphaning is handled by the
`open_token_dists` counter, not by forbidding the close.
Accounts: `payer`(mut, `close = payer`) · `vault_config`(mut, seeds, `close = payer`) ·
`heartbeat_record`(mut, `close = payer`) · `execution_log`(mut, `close = payer`) ·
`asset_plan`(mut, seeds; manual close if `has_asset_plan`) · `largest_benef`(SOL dust).
Guards: `vault.executed`; `execution_log.completed`; `vault.open_token_dists == 0`
(`TokensRemain` — every started TokenDist closed first); `now >= execution_log.started_at +
EXECUTED_CLOSE_DELAY` (`CloseDelayNotElapsed` — the **24h owner-exclusive window**, 60s under
the `devnet` feature).
Logic: sweep SOL dust (above rent) → largest-share beneficiary; **rents → `payer`/keeper** (the
cleanup reward; a dead owner's rent would otherwise strand). The owner's no-wait path is
`close_executed_vault_by_owner` (identical, but rents → owner, no delay).

### 4.10 Existing owner instructions — add the R8/P10 grace freeze
`update_vault`, `withdraw_sol_from_vault`, `withdraw_from_vault`, `revoke_vault`,
`rotate_agent`: add `require!(now < deadline)` (block once grace elapsed / execution
possible). `update_vault` additionally must reject beneficiary-set changes while
`has_asset_plan` (index→wallet drift, P10/M-2) — simplest: `require!(!vault.has_asset_plan)`
for beneficiary edits, force plan re-set. `record_heartbeat` stays agent-only,
unchanged (heartbeats before deadline reset the clock and naturally unfreeze).

### 4.11 Delete
`execute_sol_distribution`, `execute_distribution`, `record_execution`, the **old agent-signed**
`close_executed_vault`, `close_vault_ata` (folded into `close_token_dist`). Kept:
`close_revoked_vault` + `close_executed_vault_by_owner` (owner escape hatches). *(as-built: the
name `close_executed_vault` is REUSED for the new permissionless keeper close, §4.9.)*

---

## 5. Security & correctness checklist (map every item to code before merge)

| ID | Requirement | Where |
|---|---|---|
| R1/R14 | index-equality (`==beneficiaries[i].wallet`), NEVER `.iter().any()` | 4.4#5, 4.5, 4.6 |
| R2/P7 | pin `mint==assignment.mint`, `vault_ata.owner==vault & mint`, `benef_ata.owner==benef & mint` | 4.4#6-8, 4.6 |
| R3/D5 | close destinations pinned: rent→owner, dust→max-share benef (computed on-chain) | 4.8, 4.9 |
| R4 | zero-amount → set mask bit, skip transfer (finalize stays reachable) | 4.4,4.5,4.6 |
| R5 | snapshots write-once via strict `init` `begin_*` (no `init_if_needed`) | 4.2,4.3 |
| R6 | `u128` intermediate for `snapshot*share_bps` | 4.5,4.6 |
| R7 | don't close TokenDist while ATA non-empty (sweep+close ATA same ix) | 4.8 |
| R8/P10 | freeze owner mutations once `now>=deadline` | 4.10 |
| R9 | close can't orphan tokens; require all ATAs closed first | 4.8,4.9 |
| R10/P5 | bounds before shift; `full_mask` via u128 widen (n=64 safe) | §3.5, all |
| P6/R11/D8 | Token-2022 `InterfaceAccount` everywhere | 4.3,4.4,4.6,4.8 |
| R12 | `beneficiary != vault` defensive | 4.4,4.5 |
| R13 | counters only on 0→1 mask transition | 4.5,4.6 |
| P1 | `AssetPlan` mandatory+seeds-pinned when `has_asset_plan`; `saturating_add` | 4.3,4.4,4.7 |
| P3/R16 | in-order specifics (lower-index same-mint paid first); graceful under-funding | 4.4#9 |
| P4 | token ix gate on grace ONLY (run post-finalize) | 4.3,4.6 |
| P9/R17 | ≤1 assignment per NFT mint; validate decimals0/supply1 | 4.1 |
| P11 | begin_token_dist tolerates missing ATA; finalize tolerates absent AssetPlan | 4.3,4.7 |

---

## 6. Math reference (conservation)
For mint M: `B=snapshot balance`, `S=Σ amount(assignments,M)`, `residual=sat_sub(B,S)`.
- specifics ≤ S, pro-rata = `Σ floor(residual·share_i/10000) ≤ residual`.
- total ≤ S + residual = B (funded) or ≤ B (underfunded). **No over-distribution.**
- dust = `residual − Σfloor` < `n_benef` (≤19 units), stays in ATA → swept to
  largest-share benef on close. Underfunded ⟹ residual 0 ⟹ pro-rata all 0 (clean).
- u128 keeps `snapshot*10000` from overflowing u64 (token base units reach ~1e18).
- **SOL (as-built):** `sol_residual = sat_sub((lamports − rent), Σspecific-SOL + keeper_bounty)`,
  split pro-rata; specific-SOL paid `min(amount, available)` in-order; keeper bounty paid once at
  finalize.

---

## 7. The crank (the only net-new client logic; replicated in 3 callers)
A pure **"do the next undone thing" loop**, driven entirely by on-chain masks (safe to
run concurrently from server + beneficiaries; first wins, others no-op):
```
state = read VaultConfig, HeartbeatRecord, ExecutionLog?, AssetPlan?
if now < deadline: stop (not due)
ensure begin_execution (init if ExecutionLog missing)
mints = getTokenAccountsByOwner(vaultPda) ∪ {a.mint for a in AssetPlan}   // include assigned-but-unheld
for M in mints: ensure begin_token_dist(M)            // tolerate missing ATA
for j in assignment order: if !paid(j) → execute_specific_sol(j) if a.mint==default else execute_specific_asset(j)
batch execute_sol_shares(unpaid sol indices)
if sol_mask full && asset_mask full: finalize_execution()
for M: batch execute_token_shares(M, unpaid indices)
for M: if ata empty & token_mask full: close_token_dist(M)
if all closed & 24h window elapsed: close_executed_vault()   # or close_executed_vault_by_owner (owner, no wait)
```
Callers: (a) **notify-server `executor.js`** (after grace, pays fees); (b) **app owner
path** (replaces Stage-4 ExecutionService); (c) **beneficiary "Claim" button**.

---

## 8. Client changes (`app/`)
- **`ExecutionService.ts`** — delete off-chain amount math + the
  `distributable_snapshot_{owner}` SQLite cache + agent-key signing + `record_execution`/
  refund/self-terminate semantics. Reimplement as the §7 crank using the new ix (fee
  payer = owner/agent when app-driven). Keep SQLite step-checkpoint as a *progress
  mirror* (masks are now the safety layer).
- **`VaultTransactionService.ts`** — replace the 4 agent-signed builders with
  permissionless builders (same accounts, fee payer differs). Add builders for every
  new ix. Keep `.accountsPartial({})` (0.32 ResolvedAccounts workaround); pass
  `vault_ata`/`beneficiary_ata`/`token_dist` explicitly.
- **`EstateReviewScreen.tsx:28`** — `AGENT_FUNDING_LAMPORTS` 0.05 → 0.01 (D7).
- **Specific-bequest UI** — new step (off `BeneficiaryScreen` / a Bequests screen):
  pick an asset from `PortfolioScanner` holdings, assign whole-NFT or amount to a
  beneficiary; build `set_asset_plan`/`update_asset_plan` (owner tx). Client validation
  mirrors §4.1 + non-blocking "amount > current holding" warning.
- **Beneficiary "Claim inheritance"** path (can be a fast-follow; server crank already
  delivers autonomy).
- IDL + bundled types re-sync after redeploy.

## 9. Notify-server (`notify-server/`) — add `executor.js`
The server already polls each vault's heartbeat. Add: after `grace_elapsed`, run the §7
crank for that vault (keyless — submit + pay fees; the agent/owner need not be involved).
Reuse `solana.js` readers; add tx builders mirroring the client. Track per-vault crank
progress (or just re-derive from masks each tick — idempotent). Drop the registration
once the vault is closed/gone (existing auto-deregister handles it). *(As-built: the
executor cranks through `finalize_execution`; the final `close_executed_vault` runs after
the 24h owner-exclusive window, or the owner closes immediately via
`close_executed_vault_by_owner`.)*

## 10. Tests (Anchor — `tests/`)
Adapt the existing suite + add:
- pro-rata SOL: n benef, exact amounts, dust→largest benef, rent→owner on close.
- specific token + NFT: snapshot residual, exact bequest, ATA creation by caller.
- **permissionless:** a *random* keypair (not agent/owner) completes the whole flow.
- **theft attempts (must FAIL):** wrong beneficiary wallet at index (R1); substituted
  beneficiary_ata (R2); wrong mint (P7); caller-chosen close destination (R3); omitted
  AssetPlan (P1); out-of-order specific (P3).
- idempotency/resume: pay subset → re-run → no double-pay; finalize blocked until masks
  full; tokens after finalize.
- edge: zero/tiny share (R4), empty vault, under-funded mint (D4 graceful), **64
  assignments (n=64 full_mask, P5)**, assignment to unheld mint (P11), Token-2022 asset
  (P6).
- grace gate: any execute before deadline fails; owner mutation after deadline fails (R8).

## 11. Rollout
1. Build → full suite green on localnet (or self-funded devnet — note: emulator/local
   validator port 8000 collides with Agora; use a self-funded devnet script if needed).
   **Tests/devnet build with `anchor build -- --features devnet`** (floors → 10s/30s/60s); the
   DEFAULT (mainnet) build enforces 1 day / 7 days / 24 h, and a CI test asserts the floors per
   profile — **never `--features devnet` for mainnet.**
2. `anchor deploy --provider.cluster devnet` (additive+breaking — we replace the execute
   path; devnet only, all vaults are ours).
3. Re-sync IDL: copy `target/idl` + `target/types` → `app/src/utils/`.
4. Ship client + server executor.
5. End-to-end: demo vault, deposit + a specific bequest, let grace elapse (demo 90s),
   **server cranks with the app fully closed → assets land in beneficiary wallets**.
6. Bump version, build APK, replace GitHub release.

## 12. Build checklist (ordered)
- [ ] `constants.rs`: MAX_*, static asserts, mask helpers
- [ ] `state`: VaultConfig (drop has_specific_assets, add has_asset_plan), ExecutionLog
      (trim), `token_dist.rs`, `asset_plan.rs`; update all SPACE
- [ ] ix: set_asset_plan, update_asset_plan, begin_execution, begin_token_dist,
      execute_specific_asset, execute_specific_sol, execute_sol_shares, execute_token_shares,
      finalize_execution, close_token_dist, close_executed_vault (20 total incl. owner ix)
- [ ] keeper_bounty (init param + 0.1 SOL cap), 0.01 SOL creation fee (FEE_WALLET),
      open_token_dists counter, EXECUTED_CLOSE_DELAY + the `devnet` Cargo feature
- [ ] ix: R8 freeze on update_vault/withdraw_*/revoke/rotate
- [ ] delete execute_sol_distribution/execute_distribution/record_execution/agent close
- [ ] errors.rs: new codes (see §13)
- [ ] tests (§10) green
- [ ] deploy devnet + IDL re-sync
- [ ] client ExecutionService/VaultTransactionService/EstateReview/Bequests UI
- [ ] notify-server executor.js
- [ ] end-to-end demo (app closed) → APK → release

## 13. Error codes (`errors.rs` — 42 total as-built)
v2 execution codes: `GraceNotElapsed`, `ExecutionFinalized`, `AssetPlanRequired`,
`AssetPlanImmutable`, `BeneficiaryMismatch` (index-equality), `MintMismatch`,
`TokenAccountMismatch`, `SpecificOutOfOrder`, `MaskAlreadySet`, `NotAllSharesPaid`,
`TokensRemain` (close guard), `TooManyAssignments`, `DuplicateNftAssignment`,
`InvalidBeneficiaryIndex`, `AccountCountMismatch`, `InvalidVaultAta` (anti-spoof).
**As-built additions:** `VaultFrozen`, `BeneficiariesLockedByPlan`, `InvalidFeeRecipient`,
`InvalidSolBequest`, `KeeperBountyTooLarge`, `NothingToDistribute`, `CloseDelayNotElapsed`.
(`ExecutionAlreadyStarted` and `InvalidNftMint` were NOT shipped — Anchor `init` covers the
double-begin; NFT shape-check moved client-side, B4.) Canonical list: `errors.rs`.

## 18. BUILD-SPEC REVIEW CORRECTIONS (apply these — they override §3–§13 where they conflict)

Two audit passes over this build spec (fidelity + implementer-correctness). Byte math
(§3 SPACE) and mask helpers (§3.5) verified **correct**. Apply the following before coding.

### B1 (BLOCKER) — grace check plumbing: `ExecutionLog` existence IS the grace proof
`grace_elapsed` needs `heartbeat_record`, but only `begin_execution` listed it.
**Resolution (chosen): only `begin_execution` checks `grace_elapsed`** (and loads
`heartbeat_record`). Every downstream permissionless ix (`begin_token_dist`,
`execute_specific_asset`, `execute_sol_shares`, `execute_token_shares`,
`finalize_execution`, `close_token_dist`) **drops the live grace re-check and instead
requires `execution_log` to already exist** (its existence proves grace was elapsed at
`begin_execution`). No `heartbeat_record` on those structs.
- **Block `record_heartbeat` once the deadline passes / `vault.executed`** so the deadline
  can't be reset mid-execution. *(As-built: enforced via `require!(now < deadline)` → `VaultFrozen`
  + the `!executed` constraint; the ExecutionLog account is NOT referenced — time is monotonic so
  the deadline check suffices.)*
- **Owner ix freeze (§4.10):** `update_vault`/`withdraw_*`/`revoke_vault`/`rotate_agent`
  run pre-execution, so they DO compute the deadline — add `heartbeat_record`
  (seeds-pinned) to each `#[derive(Accounts)]` and `require!(now < deadline && execution_log not started)`. (Cleanest: also reject if `ExecutionLog` exists.)

### B2 (SUPERSEDED — a guarded permissionless close DID ship)
*Original concern:* a premature/buggy permissionless `close_vault` could close `VaultConfig`
while a never-`begin_token_dist`'d mint still held a balance → tokens orphaned forever.
*As-built resolution:* v1 SHIPS `close_executed_vault` (§4.9) — permissionless but **guarded**:
allowed only when `executed` + `completed` + **`open_token_dists == 0`** (`TokensRemain`) + the
**24h owner-exclusive window** (`EXECUTED_CLOSE_DELAY` from `started_at`; `CloseDelayNotElapsed`)
has elapsed. Orphaning is prevented by the `open_token_dists` counter (a live TokenDist blocks the
close), not by forbidding it; rents → payer/keeper. `close_executed_vault_by_owner` is the owner's
no-wait path (rents → owner). **Residual risk for the auditor:** a mint the vault *holds but never
`begin_token_dist`'d* leaves the counter at 0 → close succeeds → that balance strands. The
`NothingToDistribute` guard stops junk-mint spam but does not *force* every held mint to be
distributed — that is a crank responsibility, unenforceable on-chain (see AUDIT-SCOPE §5b).

### B3 (HIGH) — `begin_token_dist` ATA must be un-spoofable (not `Option`)
A caller passing `None`/empty for a held mint would freeze `snapshot=0` (write-once) →
mis-distribution. **Replace `vault_ata: Option<…>` with the canonical ATA as an
`UncheckedAccount` pinned to the derived address** (`associated_token::mint = mint,
associated_token::authority = vault_config`, or derive+assert the key), then read
`bal = if ai.data_is_empty() { 0 } else { TokenAccount::try_deserialize(..).amount }`.
This makes "missing ATA" (P11) real and un-spoofable.

### B4 (HIGH) — `set_asset_plan` NFT shape-check moves client-side
On-chain validation of `decimals==0 && supply==1` would need up to 64 mint accounts.
**Resolution: validate NFT-shape CLIENT-side.** On-chain `set_asset_plan` keeps only:
`len ≤ MAX_ASSIGNMENTS`, `beneficiary_index < len`, and **≤1 assignment per NFT mint**
(dedup over `is_nft` assignments — needs only the assignment list, no mint accounts). A
mis-flagged NFT only harms the owner's own vault. No mint accounts on `set_asset_plan`.

### Mechanical fixes (apply inline)
- **`lower_index_same_mint_mask` (was undefined):**
  ```rust
  fn lower_index_same_mint_mask(plan: &AssetPlan, mint: Pubkey, j: usize) -> u64 {
      let mut m = 0u64;
      for k in 0..j { if plan.assignments[k].mint == mint { m |= 1u64 << k; } }
      m   // first-of-mint → 0 → guard always passes; only same-mint lower bits block
  }
  ```
- **`AssetAssignment` derives `Copy`** (so `let a = plan.assignments[j];` compiles; all
  fields are Copy). Or bind by reference.
- **Mark `vault_ata`/`beneficiary_ata` `mut`** in token ix; use `transfer_checked` from
  **`anchor_spl::token_interface`** (not `token::transfer`).
- **Batched ix:** `require!(indices.len() == remaining_accounts.len())`; manually
  `try_deserialize` each `remaining_accounts[k]`, assert writable + `owner`/`mint`;
  **cap a batch at ~8–10** payouts (20× `transfer_checked` risks the 200k CU limit) —
  the crank chunks; keep single-index fallback. (Account-count ~26 fits a legacy tx but
  is tight; an Address Lookup Table is advisable for big batches.)
- **Use explicit-width shifts** `1u32 << i` / `1u64 << j` (never bare `1 << i`).
- **`finalize` AssetPlan:** `Option<Account<AssetPlan>>`; on a `has_asset_plan` vault use
  `.ok_or(AssetPlanRequired)?` (never `unwrap`) so a spoofed `None` fails cleanly.
- **`close_token_dist`:** make the dust-sweep + `largest_benef_ata` requirement
  **conditional on `vault_ata.amount > 0`** (else an empty mint with no dust ATA blocks
  close). Validate `largest_benef.key() == beneficiaries[max_idx].wallet` explicitly for
  BOTH the token-dust and (former SOL-dust) paths.
- **Rent recipients (as-built — split by close variant):** `close_token_dist` → TokenDist rent
  to **payer/cranker**, ATA rent to **owner**. Core PDAs: the **owner** close
  (`close_executed_vault_by_owner`) → **owner**; the **permissionless** close
  (`close_executed_vault`) → **payer/keeper** (cleanup reward). Asset/SOL dust →
  **largest-share beneficiary** in both.
- **`grace_elapsed` uses `>=`** (deadline reached); align tests (existing code used `>`).
- **`VaultConfig::SPACE` recompute:** new `Beneficiary{wallet:32, share_bps:2}` = 34 B →
  vec `4 + 20*34 = 684`; `+1` for `has_asset_plan`. *(As-built: `open_token_dists` (+2) and
  `keeper_bounty` (+8) were later carved from the padding → +53 left; net SPACE unchanged.)*
  **This is a breaking byte-layout change** — old devnet vaults won't deserialize; handle
  at deploy (revoke/recreate; devnet only).
- **Drop redundant accounts:** `execute_specific_asset`'s separate `beneficiary`
  UncheckedAccount (guard #8 already pins via `beneficiary_ata.owner`); the extra
  `vault_authority` in `close_token_dist` (use `vault_config.to_account_info()` as PDA
  authority). Drop unused `system_program` from `execute_sol_shares` (no CPI).
- **§5 matrix:** add rows for **R15** (covered by the 4.1 P10 grace gate) and **R18**
  (covered by §6 math / §15 edge table) so the checklist is complete.
- **D6 wording:** the beneficiary-**claim CAPABILITY is v1** (same permissionless ix,
  different fee payer); only the dedicated **"Claim" UI button** is fast-follow. Fix §8/§14.
- **Error codes:** add `InvalidNftMint` only if any on-chain NFT check remains (B4 removes
  it); remove unused `ExecutionAlreadyStarted` (Anchor `init` "already in use" covers the
  second `begin_execution`); clarify whether duplicate `(mint, beneficiary)` pairs are
  rejected and add a code if so.

### Verified correct (no change needed)
SPACE math; `full_mask_*` u128/u64 widen (n=0/20/32/64 all safe); the order-independence
gate (strict-`init` `begin_*` + downstream "TokenDist must pre-exist"); conservation math
(§6); index-equality guards (R1/R14); `transfer_checked` signer seeds `["vault",owner,&[bump]]`;
direct-lamport SOL debit on the program-owned PDA; AssetPlan on the heap (not the 4KB stack).

## 14. Fast-follow status (as-built)
- ~~Specific-SOL bequests~~ — **SHIPPED** (`execute_specific_sol`, §0.5/§4.4b).
- Beneficiary "Claim inheritance" UI button — **SHIPPED** (Inheritances screen + ClaimService, v1.9.0).
- ~~Cranker fee-reimbursement~~ — effectively SHIPPED as the **keeper bounty** (reward carved from
  the estate, paid at finalize) + the rent-cleanup reward on `close_executed_vault`.
- Token-2022 *deposit* on withdraw/close — distribution via InterfaceAccount is in v1; owner
  *withdrawal* is now also Token-2022 (P2 hardening); app *deposits* still legacy-token.
- Still open: on-chain "mutual keeping" queue (serverless-triggers Phase 3).

## 15. Key edge-case behaviors (reference)
| Case | Behavior |
|---|---|
| tiny/zero share → amount 0 | mask bit set, no transfer (finalize reachable) |
| empty vault | all amounts 0, masks fill, finalize+close succeed |
| mint fully assigned | residual 0, pro-rata 0, specifics take all |
| under-funded mint | specifics paid in-order via min(amount,avail), residual 0 |
| assignment to unheld mint | begin_token_dist snapshot 0, specific pays 0, bit set |
| 0 assignments (pure pro-rata) | no AssetPlan; finalize treats absent plan as satisfied |
| 64 assignments | u128-widened full_mask; no UB |
| Token-2022 asset | handled via InterfaceAccount; sweepable on close |
| owner heartbeats before deadline | resets clock; freeze lifts; execution can't run |
| under-funded specific-SOL | `min(amount, lamports−rent)`, bit set (finalize reachable) |
| under-funded keeper bounty | `min(bounty, lamports−rent)` at finalize; beneficiaries unaffected |
| permissionless close before 24h | `CloseDelayNotElapsed`; owner close works immediately |
| held mint never begin_token_dist'd | close can orphan it — crank must distribute all held mints |
