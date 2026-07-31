# Current Status

## Repository
- Branch: `phase4-transactional-heartbeat`
- HEAD: WP 4.6 implementation commit `phase4: add agent fee readiness and deliberate top-up` (exact final SHA recorded in the handoff)
- Base: `origin/devnet` at `cd0264bb209c0bdc2cf4a576b48ce7d6372c69aa`
- Starting HEAD: `1d5b8fd7fea2a856e2e7e3fdf609f3da8c85b2b6`
- Worktree: Clean after the WP 4.6 implementation commit and authorized branch push.

## Current Work Package
- Name: WP 4.6 — Agent fee readiness, reserve visibility and deliberate top-up
- State: PASS

## Completed
- Centralized the existing vault-activation agent target at `AGENT_RECOMMENDED_RESERVE_LAMPORTS = 5_000_000`. The economic amount remains `0.005 SOL`.
- Added a dependency-injected `AgentFeeReadinessService` with `ready`, `low_reserve`, `insufficient`, `check_unavailable` and `invalid_response` states using safe integer lamports only.
- Split the heartbeat transaction boundary into exact unsigned preparation and submission. Preparation builds `record_heartbeat` once, selects one priority price, adds the actual 80,000-CU limit, assigns the agent payer, obtains one confirmed blockhash and compiles one exact message.
- The exact message is passed to `getFeeForMessage(message, 'confirmed')`. The agent balance is read with `getBalanceAndContext(agent, { commitment: 'confirmed', minContextSlot: feeContext.slot })`.
- Verified `balance < exact fee` stops before agent signing, PREPARED journal persistence, RPC submission or local liveness effects. Low reserve remains non-blocking.
- Unavailable or malformed auxiliary fee/balance reads are visibly degraded but fail open for a deliberate heartbeat; Solana and the WP 4.3/WP 4.4 result boundaries remain authoritative.
- The same prepared transaction, priority fee and blockhash are passed into agent signing, durable PREPARED persistence and the one send. No instruction rebuild or second fee/blockhash request occurs.
- Added Dashboard and Settings fee cards with the canonical locally matched agent, balance, exact estimate, reserve, approximate remaining heartbeats and explicit stale state.
- Fee visibility refreshes read-only on focus, foreground, owner identity change, successful/reconciled heartbeat and successful top-up. It has one in-flight read per owner identity and no poll loop.
- Added a separate explicit owner-signed top-up. It revalidates the canonical active/unexecuted vault, heartbeat account and local/onchain agent match, transfers only the integer-lamport difference to the existing reserve, shows transfer and owner fee before signing, sends once and inspects `value.err`.
- A top-up can target only `vault.agentPubkey`, uses the owner as fee payer and contains one System Program transfer. It never enters the heartbeat coordinator, heartbeat history, escalation, journal or notification paths.

## Files Changed
- `dead-mans-vault/app/src/components/AgentFeeCard.tsx`
- `dead-mans-vault/app/src/screens/DashboardScreen.tsx`
- `dead-mans-vault/app/src/screens/EstateReviewScreen.tsx`
- `dead-mans-vault/app/src/screens/SettingsScreen.tsx`
- `dead-mans-vault/app/src/services/AgentFeeReadinessService.ts`
- `dead-mans-vault/app/src/services/AgentFeeReadinessService.test.ts`
- `dead-mans-vault/app/src/services/AgentTopUpService.ts`
- `dead-mans-vault/app/src/services/AgentTopUpService.test.ts`
- `dead-mans-vault/app/src/services/HeartbeatCoordinator.ts`
- `dead-mans-vault/app/src/services/HeartbeatCoordinator.test.ts`
- `dead-mans-vault/app/src/services/VaultTransactionService.ts`
- `dead-mans-vault/app/src/services/agentFeeSecurity-static.test.ts`
- `dead-mans-vault/app/src/services/agentFundingPolicy.ts`
- `dead-mans-vault/app/src/services/heartbeatAttemptUi.ts`
- `dead-mans-vault/app/src/services/heartbeatAttemptUi.test.ts`
- `dead-mans-vault/app/src/services/sendAndConfirmTransaction.ts`
- `dead-mans-vault/app/src/services/sendAndConfirmTransaction.test.ts`
- `dead-mans-vault/app/tsconfig.json`
- `docs/coordination/STATUS.md`
- `docs/coordination/DECISIONS.md`
- `docs/coordination/PHASE4.md`

## Tests
- `cd dead-mans-vault/app && npm test`: PASS (25/25 test files, 0 failures).
- `node --test --test-isolation=none 'src/**/*.test.ts'`: PASS (433/433 cases).
- Added exact-fee classification, reserve threshold, context freshness, unsafe response, exact transaction reuse, verified-insufficient, fail-open degraded check, owner top-up, cancellation, owner insufficiency, ambiguous result, lifecycle and static separation coverage.
- `cd dead-mans-vault/app && npx tsc --noEmit`: PASS.
- `git diff --check`: PASS.
- Changed-file secret scan: PASS.
- Forbidden-artifact scan: PASS.
- Tests use injected RPC/wallet dependencies and generated fixture keypairs only. No production RPC adapter, real wallet or device key is loaded.
- No existing test was removed or weakened merely to pass.

## Findings
- Agent generation occurs only during vault setup in `EstateReviewScreen`; its public key enters `initialize_vault.agentPubkey`.
- Vault setup reads the current agent balance and adds one owner-funded transfer for exactly the shortfall to `5,000,000` lamports. Setup confirms the combined transaction but does not separately re-fetch the post-activation agent balance.
- The README's `0.005 SOL` agent funding and approximate `0.028 SOL` activation-cost statements agree with product code. The former floating-point screen constant is now centralized without changing its value.
- `record_heartbeat` remains agent-signed and agent-paid. Its exact transaction includes an 80,000 compute-unit limit and the one selected priority price; the optional priority estimator retains its existing 1,000 micro-lamport fallback.
- Existing owner/agent balance reads also occur in activation, Dashboard portfolio display, revocation/refund and portfolio scanning. No owner, vault, keeper, beneficiary or server balance substitutes for fee readiness.
- Existing System Program transfers to the agent are vault activation and revocation refund in the opposite direction. WP 4.6 adds only the explicit canonical-agent top-up.
- `MigrationService` still destroys the active key before replacement generation/rotation and provides no replacement funding.
- Auxiliary fee-check failure is intentionally not proof of insufficient funds. The deliberate transaction continues through agent signing, WP 4.4 journaling, one send, confirmation classification and post-state verification.
- Ambiguous owner top-up results preserve their expected signature in the current UI but are not added to the heartbeat journal. They are never retried automatically.
- Remaining Phase 4 risks: owner top-up ambiguity has no restart journal; existing rotation and Android signing migration remain continuity-unsafe; no live canary has run.
- The current MigrationService must not be used for Fox or signing-identity migration.
  It destroys the active agent key before replacement authority is proven.

## Decisions Needed
- None for the completed WP 4.6 boundary.
- A separate user gate is required before WP 4.7.

## Live Actions
- None.

## Fox
- Untouched.

## Exact Next Action
- Stop for user review. The next recommended work package is WP 4.7 — existing `rotate_agent` security analysis. Do not begin it automatically.
