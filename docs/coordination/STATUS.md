# Current Status

## Repository
- Branch: `phase4-transactional-heartbeat`
- HEAD: WP 4.1 implementation commit `test: characterise heartbeat and migration orchestration` (exact SHA recorded in the handoff)
- Base: `origin/devnet` at `cd0264bb209c0bdc2cf4a576b48ce7d6372c69aa`
- Worktree: Clean after the WP 4.1 implementation commit.

## Current Work Package
- Name: WP 4.1 — Heartbeat testability and behavioural characterisation
- State: PASS

## Completed
- Committed the reviewed Phase 4 coordination baseline as `c512e9c`.
- Extracted dashboard heartbeat orchestration into a dependency-injected coordinator while preserving its current order and UI behavior.
- Extracted the existing sign/send/confirm sequence without changing its confirmation semantics.
- Extracted the destroy-first migration sequence and startup mismatch predicates for offline tests without changing migration behavior.
- Added seven heartbeat coordinator, three transaction confirmation and six migration/startup characterization cases.
- Confirmed that `KeyManager.getKeypair()` returns `Promise<Keypair>` and throws when secure-store key material is absent; it does not return null.
- Confirmed that concurrent coordinator calls are possible: two simultaneous calls independently record two local heartbeats and submit two onchain transactions. No locking or coalescing was added.

## Files Changed
- `dead-mans-vault/app/src/services/HeartbeatCoordinator.ts`
- `dead-mans-vault/app/src/services/HeartbeatCoordinator.test.ts`
- `dead-mans-vault/app/src/services/sendAndConfirmTransaction.ts`
- `dead-mans-vault/app/src/services/sendAndConfirmTransaction.test.ts`
- `dead-mans-vault/app/src/services/AgentMigrationFlow.ts`
- `dead-mans-vault/app/src/services/AgentMigrationFlow.test.ts`
- `dead-mans-vault/app/src/hooks/useHeartbeat.ts`
- `dead-mans-vault/app/src/screens/DashboardScreen.tsx`
- `dead-mans-vault/app/src/services/VaultTransactionService.ts`
- `dead-mans-vault/app/src/services/MigrationService.ts`
- `dead-mans-vault/app/src/navigation/RootNavigator.tsx`
- `docs/coordination/STATUS.md`
- `docs/coordination/DECISIONS.md`

## Tests
- `cd dead-mans-vault/app && npm test`: PASS (12/12 test files, 0 failures).
- `node --test --test-isolation=none 'src/**/*.test.ts'`: PASS (214/214 cases).
- Focused WP 4.1 characterization tests: PASS (16/16 cases).
- `cd dead-mans-vault/app && ./node_modules/.bin/tsc --noEmit`: PASS.
- `git diff --cached --check`: PASS.
- Staged changed-file secret scan: PASS (1,034 added lines, 0 suspicious values, 0 forbidden artifacts).
- Tests use injected mocks, local fixtures and in-memory state; the new test modules do not instantiate `Connection`, `KeyManager`, wallet adapters or notification services and perform no network calls.
- No existing test was deleted or weakened.

## Findings
- Current order remains: local heartbeat → local escalation reset → local success notification → agent-key load → onchain submission/confirmation → signature or warning publication → vault reload.
- Local success state survives an onchain failure, as intentionally characterized for later correction.
- Explorer state is published only after `recordHeartbeatOnChain` resolves.
- A thrown confirmation error rejects, but a resolved confirmation object with `value.err` is currently treated as success.
- The current migration removes the active key before replacement generation, owner signing or confirmation; owner cancellation and confirmation failure leave the old key removed.
- Candidate-agent funding is absent from the current migration transaction.
- The current MigrationService must not be used for Fox or signing-identity migration.
  It destroys the active agent key before replacement authority is proven.

## Decisions Needed
- None for the completed WP 4.1 characterization boundary.
- A separate user gate is required before WP 4.2.

## Live Actions
- None.

## Fox
- Untouched.

## Exact Next Action
- Stop for user review. The next recommended work package is WP 4.2 — explicit agent readiness. Do not begin authoritative-ordering changes automatically.
