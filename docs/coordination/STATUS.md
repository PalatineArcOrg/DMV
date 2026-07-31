# Current Status

## Repository
- Branch: `phase4-transactional-heartbeat`
- HEAD: WP 4.4 implementation commit `phase4: add durable heartbeat reconciliation` (exact final SHA recorded in the handoff)
- Base: `origin/devnet` at `cd0264bb209c0bdc2cf4a576b48ce7d6372c69aa`
- Starting HEAD: `f9ff1d2983a2fe0d161b1db8b9eff1746f0cde9e`
- Worktree: Clean after the WP 4.4 implementation commit and authorized branch push.

## Current Work Package
- Name: WP 4.4 — Durable heartbeat-operation journal and restart reconciliation
- State: PASS

## Completed
- Added a structured SQLite `heartbeat_operations` journal with explicit schema version, identity, method, expected signature, blockhash lifetime, verified pre-state, lifecycle state, resolution state and bounded safe error code columns.
- The legacy web3 transaction payer signature is selected from the agent signer entry after `Transaction.sign`, checked against `Transaction.signature`, encoded using the repository's existing `bs58` dependency and durably stored before the single `sendRawTransaction` call.
- Serialization occurs before PREPARED persistence, so construction/signing/signature-extraction/serialization failures remain definite `preparation_failed` results.
- PREPARED persistence is fail-closed. A journal failure prevents RPC submission.
- A send exception, empty RPC signature or RPC signature mismatch is `submission_unknown`; the locally derived expected signature remains durable and is never automatically resubmitted.
- Added read-only reconciliation using history-aware signature status, confirmed commitment, blockhash expiry and the hardened canonical heartbeat parser/verifier.
- Added idempotent confirmed-history insertion by transaction signature.
- Added a separate `authoritative_heartbeat_cache` for expired operations where chain liveness advanced but transaction attribution is unavailable.
- Added bounded Dashboard focus reconciliation. It signs nothing, sends nothing, requests no wallet action, mutates no notification registration and has one in-flight reconciliation per identity.
- Separated outcome-blocking operations from `confirmed_local_sync_pending`. Cache repair remains durable but cannot lock out a later deliberate heartbeat after chain success is already known.
- Retains the ten most recent terminal operation records per identity and never prunes unresolved records.

## Files Changed
- `dead-mans-vault/app/src/db/database.ts`
- `dead-mans-vault/app/src/db/heartbeatOperationRepo.ts`
- `dead-mans-vault/app/src/db/heartbeatOperationRepoCore.ts`
- `dead-mans-vault/app/src/db/heartbeatOperationRepoCore.test.ts`
- `dead-mans-vault/app/src/db/heartbeatRepo.ts`
- `dead-mans-vault/app/src/db/heartbeatRepoCore.ts`
- `dead-mans-vault/app/src/db/heartbeatRepoCore.test.ts`
- `dead-mans-vault/app/src/hooks/useHeartbeat.ts`
- `dead-mans-vault/app/src/screens/DashboardScreen.tsx`
- `dead-mans-vault/app/src/services/DefaultHeartbeatOperationService.ts`
- `dead-mans-vault/app/src/services/HeartbeatConfirmationVerifier.ts`
- `dead-mans-vault/app/src/services/HeartbeatConfirmationVerifier.test.ts`
- `dead-mans-vault/app/src/services/HeartbeatCoordinator.ts`
- `dead-mans-vault/app/src/services/HeartbeatCoordinator.test.ts`
- `dead-mans-vault/app/src/services/HeartbeatOperationLifecycle.test.ts`
- `dead-mans-vault/app/src/services/HeartbeatOperationReconciler.ts`
- `dead-mans-vault/app/src/services/HeartbeatOperationReconciler.test.ts`
- `dead-mans-vault/app/src/services/HeartbeatService.ts`
- `dead-mans-vault/app/src/services/VaultTransactionService.ts`
- `dead-mans-vault/app/src/services/heartbeatAttemptUi.ts`
- `dead-mans-vault/app/src/services/heartbeatAttemptUi.test.ts`
- `dead-mans-vault/app/src/services/sendAndConfirmTransaction.ts`
- `dead-mans-vault/app/src/services/sendAndConfirmTransaction.test.ts`
- `docs/coordination/STATUS.md`
- `docs/coordination/DECISIONS.md`
- `docs/coordination/PHASE4.md`

## Tests
- `cd dead-mans-vault/app && npm test`: PASS (19/19 test files, 0 failures).
- `node --test --test-isolation=none 'src/**/*.test.ts'`: PASS (324/324 cases).
- Added real temporary SQLite close/reopen coverage. Each test uses a unique system temporary directory and removes it in `finally`.
- Added signature extraction, pre-send persistence, journal failure, signature mismatch, repository validation/uniqueness/retention, crash-boundary, reconciliation, idempotency, coordinator blocking, focus lifecycle and static security coverage.
- `cd dead-mans-vault/app && ./node_modules/.bin/tsc --noEmit`: PASS.
- `git diff --check`: PASS.
- Changed-file secret scan: PASS.
- Forbidden-artifact scan: PASS.
- Tests use injected RPC/status/account dependencies, generated fixture keypairs and isolated SQLite databases. No production RPC adapter is invoked by a test.
- No existing security test was weakened or deleted merely to pass.

## Findings
- Final deliberate send order: durable single-flight acquisition → blocking-journal lookup/read-only reconciliation → readiness and verified pre-state → transaction construction/blockhash/signing → payer-signature derivation → serialization → durable PREPARED insert → one RPC send → durable submitted/submission-unknown transition → one confirmation attempt → canonical post-state verification → idempotent local sync → terminal journal transition → escalation/countdown reset → best-effort notification → Explorer publication → reload → lock release.
- The payer/agent signature is the first legacy transaction signature and therefore the Solana transaction ID. Production extraction also locates the signature entry by the exact payer public key and requires it to equal `Transaction.signature`.
- Outcome-blocking states are `prepared`, `submitted`, `submission_unknown`, `confirmation_unknown` and `post_state_unverified`.
- `confirmed_local_sync_pending` is reconciliable but non-blocking because on-chain success is already established.
- Terminal states are `resolved_confirmed`, `resolved_failed`, `resolved_expired_not_landed`, `resolved_chain_advanced_unattributed` and `invalid_local_record`.
- A history status with a non-null error resolves failed. A confirmed/finalized successful status must still pass the WP 4.3 canonical post-state verifier.
- An absent status at or before `last_valid_block_height` remains pending. It is never resent.
- An absent status after expiry resolves `resolved_expired_not_landed` only when canonical heartbeat state did not advance.
- If canonical heartbeat state advanced after expiry but transaction history cannot attribute it, liveness is cached from chain truth under source `chain_advanced_unattributed`; the unresolved signature is not inserted in heartbeat history or shown as successful.
- Confirmed history insertion uses one atomic `INSERT ... SELECT ... WHERE NOT EXISTS` statement keyed by `on_chain_tx`, so a crash after insertion but before journal resolution self-heals without duplicate history.
- Restart reconciliation sends no OS heartbeat-success notification. Immediate same-session success retains WP 4.3 notification behavior.
- Corrupt current-identity records are marked `invalid_local_record` before RPC use and fail closed. Records for other identities are excluded by the scoped query.
- No raw or signed transaction bytes, private key material, error object, stack trace, RPC URL, notification token or environment value is stored in the journal.
- Remaining Phase 4 risks: agent balance/fee readiness is not implemented; deadline/escalation boundary coverage remains WP 4.5; rotation and Android signing migration remain unchanged; no live canary has run.
- The current MigrationService must not be used for Fox or signing-identity migration.
  It destroys the active agent key before replacement authority is proven.

## Decisions Needed
- None for the completed WP 4.4 boundary.
- A separate user gate is required before WP 4.5.

## Live Actions
- None.

## Fox
- Untouched.

## Exact Next Action
- Stop for user review. The next recommended work package is WP 4.5 — deadline and escalation correctness. Do not begin it automatically.
