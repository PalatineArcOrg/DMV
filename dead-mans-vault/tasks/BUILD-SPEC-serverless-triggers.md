# BUILD SPEC — Serverless Triggers (Claim + Bounty + Mutual Keeping)

Status: **Phases 1-2 SHIPPED (v1.9.0, v1.10.0)** · Phase 3 pending · Owner-approved decisions locked below.
Phase 1 (claim) shipped 2026-07-02: `GET /inheritances` + InheritancesScreen + ClaimService (heir-paid MWA crank, resumable).
Phase 2 (bounty) shipped 2026-07-02: `keeper_bounty` (from padding, non-breaking) carved out at begin_execution + paid to
the finalize cranker; 23/23 tests + devnet e2e. Known: keeper fronts the ExecutionLog rent (~0.00185 SOL) → net ≈0.003 SOL.
Neither device-tested yet. Phase 3 (mutual keeping) is next.

## 0. Goal

Make the dead-man's switch fire **without depending on our notify-server**. Execution is
already permissionless and fully on-chain (the program enforces who/where/when/how-much);
the only thing tied to *our* box is *who submits the crank transaction*. This spec turns that
trigger into a layered, self-sustaining system:

| Layer | Who cranks | This spec |
|-------|-----------|-----------|
| App crank | owner's phone (if open) | already live |
| Notify-server crank | our server at Stage 4 (+ the push) | already live — becomes the **backstop**, later a **dispatcher** |
| **Beneficiary claim** | the heir, one tap | **Phase 1** |
| **On-chain bounty** | *anyone*, for a tip | **Phase 2** |
| **Mutual keeping** | living owners' heartbeats crank the dead | **Phase 3** |

Guiding invariant (unchanged): the crank is permissionless and cannot misdirect funds. Nothing
here grants any signer authority over destinations — every new path just *submits* the same
program-enforced distribution.

## 1. Decisions (locked)

| # | Decision | Choice |
|---|----------|--------|
| D1 | Claim discovery | **(a) Server API** ("vaults where X is a beneficiary") now, with **(c) manual import** (owner-shared link/code) as a no-infra fallback. On-chain scan deferred. |
| D2 | Bounty funding & amount | **Fixed protocol constant, owner-funded reserve** (`KEEPER_BOUNTY_LAMPORTS`, start 0.005 SOL). Carved out of the SOL snapshot — never reduces beneficiary payouts. |
| D3 | Bounty recipient | **Whole bounty → the `finalize_execution` payer** for v1. Proportional split across crankers = fast-follow. |
| D4 | Mutual-keeping coordination | **v1 = server-dispatched jobs** (server hands crank work to heartbeating clients). **v2 = on-chain registry/queue** (fully serverless) — later milestone. |

Layout note (verified): `VaultConfig` has **61 bytes of padding**, so adding `keeper_bounty: u64`
(8 bytes) is **NON-breaking** — existing devnet vaults deserialize with `keeper_bounty = 0`. No
revoke/recreate required. `VaultConfig::SPACE` stays the same; padding drops 61 → 53.

---

## 2. Phase 1 — Beneficiary "Claim" button

**No on-chain change.** Execution is already permissionless; the heir just runs the existing
crank with their wallet as `payer`.

### 2.1 Discovery (D1)
- **Server API (primary):** notify-server already indexes registered vaults + their beneficiary
  lists. Add `GET /inheritances?wallet=<pubkey>` → list of `{ vault, owner, shareBps, stage,
  deadline, executed }` for vaults naming that wallet. The server derives this from data it
  already has; no new authority.
- **Manual import (fallback):** the owner shares a vault link/code (owner pubkey) during setup;
  the heir pastes it. Needed when the vault was never registered with our server, or the heir
  distrusts the API. The app then reads the vault on-chain directly.

### 2.2 App — new "Inheritances" screen (Status tab or its own)
- Lists vaults where the connected wallet is a beneficiary (from the API + any imported).
- Per vault: owner (truncated), **your share**, **status** — `Active` (heartbeats current),
  `Claimable` (grace elapsed, not yet executed), `Executed`.
- When `Claimable`: a **"Distribute Estate"** button. Copy must make clear this triggers the
  **whole** distribution to **all** beneficiaries atomically (it is not "withdraw my share").
- Pressing it runs the existing §7 crank (`ExecutionService`) with the heir's wallet as fee
  payer, MWA-signed. Idempotent + resumable (on-chain masks), so a partial run is safe.
- Show progress (reuse the execution progress mirror) + a completion/failure toast.

### 2.3 Cost note
Without Phase 2, the heir pays all crank fees (begin + N txs — can be non-trivial for many
assets). This is why Phase 2 pairs with it. Surface an estimated cost before they sign.

### 2.4 Deliverables
- notify-server: `GET /inheritances` (+ a beneficiary index built from registered vaults).
- app: `InheritancesScreen`, a claim service call into `ExecutionService`, import flow, nav entry.
- No program change, no redeploy.

---

## 3. Phase 2 — On-chain crank bounty

A small program-paid reward makes cranking profitable → permissionless keeper market.

### 3.1 State
- `VaultConfig.keeper_bounty: u64` (lamports) — **repurpose padding** (non-breaking). Old vaults = 0.

### 3.2 `initialize_vault`
- Accept an optional `keeper_bounty` param (default `KEEPER_BOUNTY_LAMPORTS` = 5_000_000 = 0.005 SOL,
  or 0 to opt out). The owner funds it by depositing it into the vault PDA at setup (part of the
  same deposit flow — it just sits in the vault above rent, earmarked by the field).
- Add `KEEPER_BOUNTY_LAMPORTS` to `constants.rs`.

### 3.3 `begin_execution` — carve the bounty out of the residual
- Extend the existing carve-out (which already subtracts Σ specific-SOL):
  `sol_snapshot = (lamports − rent) − Σ(specific-SOL) − keeper_bounty` (saturating).
- So the bounty is **not** distributed pro-rata and **not** part of any share — conservation holds.

### 3.4 `finalize_execution` — pay the bounty (D3)
- On finalize (all masks full), transfer `keeper_bounty` from the vault PDA → the `payer`
  (the cranker who completed it) by direct lamport debit. Guard: pay `min(keeper_bounty,
  vault_lamports − rent)`; set a `bounty_paid` bit (or zero the field) so it can't double-pay on
  a re-run. Record it in `ExecutionLog` (e.g. reuse padding, or a `bounty_paid: bool`).
- If never finalized, the bounty stays in the vault and returns to the owner/largest-benef on the
  owner-close sweep — no loss.

### 3.5 Known v1 limitation
Whole bounty to the finalize-payer lets a latecomer grab it after others did the work. The estate
still distributes correctly; only the *tip* is contestable. Proportional split (per-crank credit)
is a **fast-follow**. Document it.

### 3.6 Security
- Bounty is carved at begin from a frozen snapshot → cannot inflate. Paid once (masked). Payer is
  a `Signer` but controls nothing else. Underfunded vault → `min()` clamp, no failure.
- Non-breaking layout keeps existing vaults valid (bounty 0 → no-op path).

### 3.7 Deliverables
- program: `keeper_bounty` field, `initialize_vault` param + constant, `begin_execution` carve,
  `finalize_execution` payout + idempotency, tests (bounty paid once; carved out; underfunded
  clamp; 0-bounty legacy path). Redeploy devnet + `anchor idl upgrade`.
- client/server: `initialize_vault` builder passes bounty; EstateReview cost line "+0.005 keeper
  bounty"; crankers already are the `payer` so they auto-collect — surface "you earned X" in the
  claim/crank result. Re-sync IDL. Version bump (minor).

---

## 4. Phase 3 — Mutual keeping

Living owners' heartbeat transactions crank the dead.

### 4.1 v1 — server-dispatched jobs (D4)
- **No new on-chain structure.** The heartbeat client bundles `[record_heartbeat, <one existing
  crank ix for an expired vault>]` in a single transaction.
- The notify-server shifts from *doing* the crank to *dispatching* it: new
  `GET /crank-job?worker=<pubkey>` → the next expired-vault crank step + the exact accounts to
  pass (vault, execution_log, beneficiary metas, etc.), or empty if none. It leases a job briefly
  so two workers don't collide (on-chain masks make a collision safe anyway — first writer wins).
- On heartbeat, the app (owner online) optionally pulls a job and appends its ix. The **bounty**
  (Phase 2) pays the worker on the vault they finalize; fee overhead is small and net-positive.
- Opt-in setting ("Help distribute expired vaults & earn keeper rewards"), default on.
- Safety: bundled crank is permissionless + fund-safe; worst case the worker wastes their own fee.
  If the heartbeat's own ix would fail, don't bundle (keep heartbeat reliability sacrosanct — the
  crank ix must never be able to fail the heartbeat; use a separate tx if simulation is risky).

### 4.2 v2 — on-chain registry/queue (later)
- Replace the server dispatcher with an on-chain structure so heartbeats self-discover the next
  expired vault (fully serverless). Solana has no native priority queue → design a **deadline-
  bucketed ring** + a global cursor account; `record_heartbeat` (or a paired ix) reads the cursor,
  advances one expired vault a step, moves the cursor. Registration adds a vault to its deadline
  bucket. This is the hard part (account-size limits, bucket rebalancing, cursor contention) and is
  a separate milestone once v1 proves the incentive works.

### 4.3 Deliverables (v1)
- notify-server: beneficiary/expired index (shared with Phase 1), `GET /crank-job` with light
  leasing, telemetry on jobs dispatched/completed.
- app: opt-in setting; heartbeat flow optionally appends a crank ix (guarded so it can't break the
  heartbeat); "keeper rewards earned" surfacing.
- No program change beyond Phase 2's bounty.

---

## 5. Rollout & sequencing

1. **Phase 1 (claim)** — client + server, no redeploy. Ship first: guaranteed heir-triggered
   fallback, immediate value.
2. **Phase 2 (bounty)** — program change (non-breaking), redeploy + IDL upgrade. The economic engine.
3. **Phase 3 v1 (mutual keeping)** — client + server, rides on Phase 2's bounty. Decentralized labor.
4. **Phase 3 v2 (on-chain queue)** — separate milestone; fully serverless.

Each phase is independently shippable and testable. After all three, the notify-server drops to
what it should be: a best-effort **notifications** relay (the one part that must stay off-chain).

## 6. Open sub-decisions (defer to implementation)
- Exact `KEEPER_BOUNTY_LAMPORTS` (0.005 SOL placeholder) and whether owner-configurable later.
- `ExecutionLog` bounty-paid flag placement (padding vs new bool).
- Claim screen home (new tab vs under Status).
- Job-lease TTL + whether v1 dispatch also serves non-app keepers (bots).
