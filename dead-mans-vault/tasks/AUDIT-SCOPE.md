# Security Audit — Scope & Brief (for quotes)

**Project:** Dead Man's Vault (DMV) — an autonomous, non-custodial **crypto inheritance** protocol on Solana. An owner deposits assets into a vault PDA and proves liveness via periodic heartbeats; when heartbeats stop and a grace period elapses, the program distributes the assets to pre-set beneficiaries. Execution is **permissionless** — the on-chain program computes every payout from frozen on-chain state, and any signer can submit the distribution (no privileged executor, no held keys).

**Why an audit:** the program moves a user's **entire estate**, and a bug means **irreversible loss**. We want an independent audit before mainnet-beta launch.

---

## What to audit (primary scope)

The **Anchor program** at `programs/dead-mans-vault/` — this is the trust boundary.

| Metric | Value |
|---|---|
| Framework | **Anchor 0.32.1**, Rust 1.93, Solana/Agave 3.0.15 |
| Program source | ~2,700 LOC Rust |
| Instructions | **20** (owner/setup + permissionless execution) |
| State accounts (PDAs) | 5 (VaultConfig, HeartbeatRecord, ExecutionLog, AssetPlan, TokenDist) |
| Error codes | 42 |
| Tests | 29 integration tests (~1,450 LOC, ts-mocha), all passing |
| Token support | SPL Token **and** Token-2022 (`InterfaceAccount` / `transfer_checked`) |
| Deployed | devnet `GXCu5964mvgAJDWmcMriZpzU3vDVqPzjYCM1sxCnsoEb` (will redeploy to mainnet) |

Repo: `https://github.com/Romulus-Sol/DMV` (branch `devnet`). Design spec: `tasks/BUILD-SPEC-permissionless-execution.md` (§18 authoritative). This doc + `CLAUDE.md` describe the model.

## Instruction surface
- **Owner/setup (all freeze once the deadline passes):** `initialize_vault` (collects a 0.01 SOL creation fee via CPI to a pinned fee wallet), `update_vault`, `set_asset_plan`/`update_asset_plan` (specific bequests: SOL + SPL + NFT), `record_heartbeat` (agent-signed), `rotate_agent`, `withdraw_sol_from_vault`/`withdraw_from_vault`, `revoke_vault`, `close_executed_vault_by_owner`, `close_revoked_vault`.
- **Permissionless execution (`payer` = any signer; gated on grace via on-chain state + bitmasks):** `begin_execution`, `begin_token_dist`, `execute_specific_asset`, `execute_specific_sol`, `execute_sol_shares`, `execute_token_shares`, `finalize_execution`, `close_token_dist`, `close_executed_vault` (permissionless rent-cleanup after a 24h owner-exclusive window).

## Threat model / areas of special concern
1. **Permissionless execution correctness** — a malicious `payer`/caller must never misdirect funds, over-distribute, or skip a beneficiary. Payouts are computed from **frozen snapshots × `share_bps`**, carved for specific bequests, tracked by per-asset **bitmasks** (idempotent, order-independent, resumable). Verify conservation (Σ payouts ≤ snapshot) and idempotency under concurrent/racing cranks.
2. **Account substitution / spoofing** — recipients checked by **index-equality** against the beneficiary list (never `.iter().any()`); vault ATAs pinned to the **canonical** associated-token address derived from the mint's true owner program. (A *Critical* ATA-spoof in `execute_specific_asset` was found + fixed in internal review — please re-verify all token-account pinning.)
3. **Timing / freeze invariants** — owner mutations + heartbeats freeze once `now >= deadline`; execution gates on grace; the permissionless close gates on a 24h owner-exclusive window. Minimums (1-day heartbeat / 7-day grace / 24h close) are **feature-gated** — the default build is production; a `devnet` Cargo feature lowers them for tests. Verify no path ships demo floors to mainnet (CI asserts this).
4. **Token-2022** — transfer-hook reentrancy (CEI ordering: paid bit set before the transfer CPI), transfer-fee mints, `InterfaceAccount` handling.
5. **Rent / PDA lifecycle** — snapshot write-once (`init`), `open_token_dists` counter preventing an owner-close that orphans token residuals, dust sweeping to the largest-share beneficiary, no permissionless core-PDA close before the window.
6. **Fee & bounty math** — the 0.01 SOL creation fee (pinned recipient), the owner-set `keeper_bounty` (capped at 0.1 SOL, carved out of the SOL snapshot so it can't reduce beneficiary payouts), u128 share math / rounding.
7. **Arithmetic** — overflow/underflow, mask-width (`1<<n` at n=32/64), share-bps summation (== 10000).

## Prior work (context, not a substitute)
Two internal rounds: a multi-agent adversarial review (caught the ATA-spoof *Critical*) and a pre-mainnet hardening pass (P0–P7: keeper-bounty cap, `NothingToDistribute` anti-grief, CEI ordering, biometric agent-key storage, fail-closed server auth). 29/29 tests. We're explicitly **not** treating this as sufficient for a funds-holding mainnet launch.

## Secondary / optional scope
- Client-side transaction building + the permissionless crank replication in the mobile app (`app/src/services/VaultTransactionService.ts`, `ExecutionService.ts`, `ClaimService.ts`).
- The keyless off-chain services (`notify-server/`, `keeper-bot/`) — they hold **no fund authority** (only pay fees), so lower priority, but they drive autonomy.

## Deliverables requested
- Findings report (severity-classified) with reproductions + recommended fixes.
- A fix-review / re-audit pass after remediation.
- Sign-off suitable to reference publicly for a mainnet launch.

## Logistics
- Read-only repo access (public). Happy to walk through the model.
- Timeline: seeking quotes now; want to launch mainnet after remediation.

---
*Prepared 2026-07-05. Contact: repo owner (Romulus-Sol).*
