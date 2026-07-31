# Current Status

## Repository
- Branch: `phase4-transactional-heartbeat`
- HEAD: WP 4.5 implementation commit `phase4: derive escalation from verified chain deadline` (exact final SHA recorded in the handoff)
- Base: `origin/devnet` at `cd0264bb209c0bdc2cf4a576b48ce7d6372c69aa`
- Starting HEAD: `b4776ca3802b221373844f660daa4ded1bc41c70`
- Worktree: Clean after the WP 4.5 implementation commit and authorized branch push.

## Current Work Package
- Name: WP 4.5 — Authoritative deadline and escalation correctness
- State: PASS

## Completed
- Added a dependency-injected `OnChainDeadlineService` using the existing hardened `VaultConfig` and `HeartbeatRecord` parsers and canonical PDA helpers.
- Confirmed chain time is read with `getSlot('confirmed')` followed by `getBlockTime(slot)`. Both canonical account reads use `commitment: 'confirmed'` and that slot as `minContextSlot`, preventing an older heartbeat account from being paired with a newer time observation.
- Added checked timing arithmetic, safe BN conversion, explicit RPC/chain-time/account/configuration failure states and exact parity with the program's `now < finalDeadline` rule.
- Added a 30-second monotonic freshness window. Projection may update stages 0–3 for display, but stale, regressing or Stage-4-reaching projection cannot execute and requests a fresh RPC verification.
- Replaced `EscalationService → HeartbeatService.getStatus()` with explicit fresh authoritative snapshots. The service has no local history, wall-clock or notification sender dependency.
- Added a process-lifetime Stage 4 guard keyed by cluster/program/owner/vault/final deadline. The callback is marked attempted before invocation, so callback failure cannot create an immediate retry loop.
- Renamed the SQLite/device-clock status method to `getLocalHistoryStatus()` and isolated it as diagnostics/history only.
- Immediate confirmed heartbeats and WP 4.4 confirmed/unattributed reconciliations now request a fresh canonical deadline read instead of directly resetting escalation.
- Replaced Dashboard heartbeat/deadline labels with chain-observation-relative values and added verified, projected, checking, stale, RPC, invalid-state and stage-configuration UI states.
- Centralized stage duration selection for vault creation, deadline evaluation and deliberate notify-server registration. The 30-second subdivision now applies only to explicit demo mode, not every development build.
- Removed obsolete local `ExecutionService.waitForOnChainDeadline()`. The mobile crank is entered only through the fresh verified Stage 4 gate; the program, keeper and notify-server remain independent enforcement/execution paths.
- Corrected local fallback wording: the only local timeline action is cancellation of pre-v1.7.3 remnants; Stage 1–3 pushes remain notify-server-only.

## Files Changed
- `dead-mans-vault/app/src/components/StatusIndicator.tsx`
- `dead-mans-vault/app/src/db/heartbeatRepoCore.test.ts`
- `dead-mans-vault/app/src/hooks/useHeartbeat.ts`
- `dead-mans-vault/app/src/screens/DashboardScreen.tsx`
- `dead-mans-vault/app/src/screens/EstateReviewScreen.tsx`
- `dead-mans-vault/app/src/screens/SettingsScreen.tsx`
- `dead-mans-vault/app/src/services/DefaultHeartbeatOperationService.ts`
- `dead-mans-vault/app/src/services/DefaultOnChainDeadlineService.ts`
- `dead-mans-vault/app/src/services/EscalationService.ts`
- `dead-mans-vault/app/src/services/EscalationService.test.ts`
- `dead-mans-vault/app/src/services/ExecutionService.ts`
- `dead-mans-vault/app/src/services/HeartbeatCoordinator.ts`
- `dead-mans-vault/app/src/services/HeartbeatCoordinator.test.ts`
- `dead-mans-vault/app/src/services/HeartbeatOperationReconciler.ts`
- `dead-mans-vault/app/src/services/HeartbeatOperationReconciler.test.ts`
- `dead-mans-vault/app/src/services/HeartbeatService.ts`
- `dead-mans-vault/app/src/services/OnChainDeadlineService.ts`
- `dead-mans-vault/app/src/services/OnChainDeadlineService.test.ts`
- `dead-mans-vault/app/src/services/deadlineAuthorityGuards.test.ts`
- `dead-mans-vault/app/src/store/useEscalationStore.ts`
- `dead-mans-vault/app/src/utils/constants.ts`
- `dead-mans-vault/app/src/utils/deadlineStageConfig.ts`
- `docs/coordination/STATUS.md`
- `docs/coordination/DECISIONS.md`
- `docs/coordination/PHASE4.md`

## Tests
- `cd dead-mans-vault/app && npm test`: PASS (22/22 test files, 0 failures).
- `node --test --test-isolation=none 'src/**/*.test.ts'`: PASS (379/379 cases).
- Added deadline arithmetic, exact boundary parity, chain-time taxonomy, canonical account/slot pinning, unsafe conversion, time regression, monotonic projection, Stage 4 refresh, escalation one-shot, identity change, callback failure, lifecycle and static authority coverage.
- `cd dead-mans-vault/app && npx tsc --noEmit`: PASS.
- `git diff --check`: PASS.
- Changed-file secret scan: PASS.
- Forbidden-artifact scan: PASS.
- Tests use only injected account/RPC/time dependencies, generated public fixture data and existing isolated local test databases. No production RPC adapter or real wallet/device key is loaded.
- No existing security test was removed or weakened merely to pass. The WP 4.3 local persistence assertion was renamed to its explicit local-history role and strengthened with an authority-separation assertion.

## Findings
- Previous `lastHeartbeat` sources were Dashboard's decoded heartbeat account with a fallback to local Zustand/SQLite. `nextDue`, `secondsOverdue` and `secondsRemaining` came from `HeartbeatService.getStatus()`, `Date.now()` and a one-second decrement timer.
- Previous stage and Stage 4 authority flowed `useHeartbeat → EscalationService.evaluate → HeartbeatService.getStatus → heartbeat_history`; `transitionTo(4)` set `executionStarted` and invoked `ExecutionService.execute()`.
- Previous escalation resets occurred after deliberate verified heartbeat handling, WP 4.4 reconciliation, vault setup, executed-vault reload and execution completion. The first two now refresh canonical deadline state rather than asserting a local reset.
- Current authoritative refresh order is canonical PDA derivation → confirmed slot/block time → slot-pinned canonical vault read/validation → active/not-executed check → slot-pinned canonical heartbeat read/validation → checked deadline arithmetic → fresh snapshot publication → possible Stage 4 guard.
- Exact boundaries are: `now <= nextDue` stage 0; `nextDue < now < stage1End` stage 1; `stage1End <= now < stage2End` stage 2; `stage2End <= now < finalDeadline` stage 3; `now >= finalDeadline` stage 4.
- `nextDue = lastHeartbeat + heartbeatInterval` and `finalDeadline = nextDue + gracePeriod`. The three positive safe stage durations must sum exactly to the canonical on-chain grace period.
- Projection uses `performance.now()` only, never wall time. It expires after 30 seconds, does not continue indefinitely and cannot project into executable Stage 4.
- Local confirmed history, unattributed authoritative cache and owner-activity rows remain useful for history, Explorer links, diagnostics and repair. None is read by deadline/escalation authority.
- `startOnChainMonitoring()` remains disabled unless `on_chain_activity` is explicitly configured and records only non-authoritative activity history. It does not submit an agent heartbeat.
- Notification registration remains deliberate and independent. The shared stage-duration helper prevents new app/server configuration drift, but absence of registration does not change deadline calculation or permissionless execution.
- Notify-server stage polling still uses its server wall clock, and the keeper/notify executor paths remain independently protected by on-chain deadline enforcement. Changing their execution rules was explicitly outside WP 4.5.
- `ClaimService` and `InheritancesScreen` still use the legacy read-only `getOnChainDeadline()` helper for claim availability/display; they are outside the mobile escalation/Stage 4 authority path and remain a later hardening candidate.
- Remaining Phase 4 risks: agent balance/fee readiness is not implemented; existing rotation and Android signing migration remain continuity-unsafe; a stage configuration that cannot be reconstructed locally now pauses mobile inference until corrected; no live canary has run.
- The current MigrationService must not be used for Fox or signing-identity migration.
  It destroys the active agent key before replacement authority is proven.

## Decisions Needed
- None for the completed WP 4.5 boundary.
- A separate user gate is required before WP 4.6.

## Live Actions
- None.

## Fox
- Untouched.

## Exact Next Action
- Stop for user review. The next recommended work package is WP 4.6 — agent fee-state handling. Do not begin it automatically.
