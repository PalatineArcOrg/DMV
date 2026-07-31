# Current Status

## Repository
- Branch: `phase4-transactional-heartbeat`
- HEAD: `cd0264bb209c0bdc2cf4a576b48ce7d6372c69aa`
- Base: `origin/devnet` at `cd0264bb209c0bdc2cf4a576b48ce7d6372c69aa`
- Worktree: Coordination files modified or added; no product code changed.

## Current Work Package
- Name: Phase 4 source-grounded baseline and coordination
- State: PASS

## Completed
- Captured the initial repository state: clean detached HEAD at `54101af2f8e9affa9af76399abd4e46a80fce0eb`.
- Verified `origin/devnet` at `cd0264bb209c0bdc2cf4a576b48ce7d6372c69aa`.
- Verified the initial detached history and `origin/devnet` had diverged by five and seven commits respectively.
- Created a normal Phase 4 coordination branch directly from `origin/devnet`.
- Inspected the dashboard heartbeat path, local service/repository/store, agent signing, transaction submission/confirmation, onchain heartbeat and rotation instructions, migration flow and relevant tests.
- Corrected the missing-key assumption: the normal path throws and shows a generic warning; it does not silently skip, but it remains non-specific and follows premature local success.
- Produced the Phase 4 work-package design without selecting a program change.

## Tests
- Source comparison confirmed the heartbeat, key, migration, transaction, program and relevant test paths inspected on the initial checkout match `origin/devnet`; only notification-registration integration in `useHeartbeat` differed.
- `cd dead-mans-vault/app && npm test`: PASS (9/9 files, 0 failures).
- `git diff --check`: PASS.
- Program/local-validator tests: not run for this documentation-only gate.

## Findings
- Local SQLite, Zustand escalation state, countdown, notification and button success update before the authoritative transaction.
- The agent builds, signs and pays for `record_heartbeat`; the transaction is submitted and confirmation is awaited.
- The submitted signature is not durable until after confirmation, and the confirmation response's `value.err` is not checked.
- Ambiguous outcomes have no restart-time reconciliation.
- Missing and mismatched agent states collapse into a transient generic warning on the dashboard.
- Current migration destroys the old key before rotation is confirmed and does not fund the new agent.
- Existing `rotate_agent` is owner-authorized and deadline-frozen but does not require proof of possession from the new agent.
- App-only Phase 4 work appears compatible with the existing instruction interface; stronger program-enforced rotation semantics would require a separate upgrade gate.

## Decisions Needed
- Approve this `origin/devnet`-based branch as the Phase 4 implementation base.
- Approve Work Package 1 only; no later work package starts automatically.
- Later, decide whether owner authorization plus app-side staged-key proof is sufficient or program-enforced new-agent proof is required.

## Live Actions
- None.

## Fox
- Untouched.

## Exact Next Action
- Stop for user review of the baseline and request authorization before starting Work Package 1.
