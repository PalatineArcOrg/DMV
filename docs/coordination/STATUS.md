# Current Status

## Repository
- Branch: `phase4-transactional-heartbeat`
- HEAD: WP 4.7 implementation commit `phase4: add crash-safe agent rotation` (exact final SHA recorded in the handoff)
- Base: `origin/devnet` at `cd0264bb209c0bdc2cf4a576b48ce7d6372c69aa`
- Starting HEAD: `776a6f2052e218fccbf55d61e5291369df163685`
- Worktree: Clean after the WP 4.7 implementation commit and authorized branch push.

## Current Work Package
- Name: WP 4.7 — Crash-safe owner-authorised agent rotation
- State: PASS

## Completed
- Selected Design B for the official app: the securely stored and deliberately funded candidate is transaction fee payer and transaction-ID signer; the owner remains the Anchor-required `rotate_agent` signer.
- Verified the installed Mobile Wallet Adapter legacy-transaction path serializes partial signatures with `requireAllSignatures: false`, returns a decoded `Transaction`, and preserves the candidate signature while the owner signature is added.
- Added independent authenticated SecureStore slots for `active`, `candidate` and `previous`. Candidate generation never overwrites active; promotion is copy-before-remove, read-back validated and restart-idempotent.
- Added exact on-chain-agent slot resolution with `active_match`, `candidate_match`, `previous_match`, `no_match`, `corrupt_slot` and `multiple_matches`. No key is generated or selected by first-match fallback.
- Added deliberate candidate creation and a separate owner-signed candidate-funding flow. Funding targets only the stored candidate, reaches `AGENT_RECOMMENDED_RESERVE_LAMPORTS`, is journalled before send, never counts as liveness and never starts rotation automatically.
- Added exact rotation preparation: one instruction build, one priority-fee selection, candidate fee payer, one blockhash, exact fee/balance check, candidate partial signature, one owner-wallet signature, then byte-for-byte message and signature validation.
- Added a structured SQLite rotation journal and a separate candidate-funding journal. Both persist the expected transaction signature before their one send and retain only safe identity, lifecycle and blockhash evidence.
- Added read-only, history-aware restart reconciliation. It never signs, builds or sends and converges by transaction status, blockhash expiry and canonical vault/heartbeat state.
- Added canonical post-state verification. Promotion requires the candidate on-chain, unchanged owner/configuration, active and unexecuted vault, non-regressing timestamps and an unchanged heartbeat count.
- Candidate promotion moves the old active key to `previous`, activates the candidate, retains the previous key, resolves the on-chain key again and proves candidate signing offline. No real heartbeat is submitted.
- Removed the destroy-first migration implementation and every production call site. Startup performs only bounded read-only reconciliation and Settings exposes the three deliberate actions.
- Added a fresh chain-time deadline preflight. Rotation stops at `chainUnixTime >= finalDeadline`; a near-deadline warning does not invent an extension.

## Files Changed
- `dead-mans-vault/app/src/components/AgentRotationCard.tsx`
- `dead-mans-vault/app/src/db/agentCandidateFundingRepo.ts`
- `dead-mans-vault/app/src/db/agentCandidateFundingRepoCore.ts`
- `dead-mans-vault/app/src/db/agentCandidateFundingRepoCore.test.ts`
- `dead-mans-vault/app/src/db/agentRotationRepo.ts`
- `dead-mans-vault/app/src/db/agentRotationRepoCore.ts`
- `dead-mans-vault/app/src/db/agentRotationRepoCore.test.ts`
- `dead-mans-vault/app/src/db/database.ts`
- `dead-mans-vault/app/src/navigation/RootNavigator.tsx`
- `dead-mans-vault/app/src/screens/SettingsScreen.tsx`
- `dead-mans-vault/app/src/services/AgentCandidateFundingService.ts`
- `dead-mans-vault/app/src/services/AgentCandidateFundingService.test.ts`
- `dead-mans-vault/app/src/services/AgentMigrationFlow.ts`
- `dead-mans-vault/app/src/services/AgentMigrationFlow.test.ts`
- `dead-mans-vault/app/src/services/AgentReadinessService.test.ts`
- `dead-mans-vault/app/src/services/AgentRotationCoordinator.ts`
- `dead-mans-vault/app/src/services/AgentRotationCoordinator.test.ts`
- `dead-mans-vault/app/src/services/AgentRotationProtocol.test.ts`
- `dead-mans-vault/app/src/services/AgentRotationReconciler.ts`
- `dead-mans-vault/app/src/services/AgentRotationReconciler.test.ts`
- `dead-mans-vault/app/src/services/AgentRotationTransaction.ts`
- `dead-mans-vault/app/src/services/AgentRotationTransaction.test.ts`
- `dead-mans-vault/app/src/services/AgentRotationVerifier.ts`
- `dead-mans-vault/app/src/services/AgentRotationVerifier.test.ts`
- `dead-mans-vault/app/src/services/DefaultAgentRotationService.ts`
- `dead-mans-vault/app/src/services/MigrationService.ts`
- `dead-mans-vault/app/src/services/agentRotationSecurityGuards.test.ts`
- `dead-mans-vault/app/src/tee/AgentKeySlotManagerCore.ts`
- `dead-mans-vault/app/src/tee/AgentKeySlotManagerCore.test.ts`
- `dead-mans-vault/app/src/tee/KeyManager.ts`
- `dead-mans-vault/tests/agent-rotation-local-validator.ts`
- `docs/coordination/STATUS.md`
- `docs/coordination/DECISIONS.md`
- `docs/coordination/PHASE4.md`

## Tests
- `cd dead-mans-vault/app && npm test`: PASS (35/35 test files, 0 failures).
- `node --test --test-isolation=none 'src/**/*.test.ts'`: PASS (525/525 cases).
- `cd dead-mans-vault/app && npx tsc --noEmit`: PASS.
- Disposable local-validator integration: PASS (2/2 scenarios). It proves candidate-funded dual signing, candidate transaction ID, one successful rotation, unchanged heartbeat count, timestamp reset, old-agent heartbeat rejection, candidate heartbeat acceptance, restart slot resolution/promotion, failure retention of the old agent and exact-deadline rejection.
- `git diff --check`: PASS.
- Changed-file secret scan: PASS.
- Forbidden-artifact scan: PASS.
- No existing test was removed or weakened merely to pass. The disposable ledger and wallet were removed after the run.

## Findings
- Design A (owner-only) is protocol-compatible but does not prove candidate possession and is not used by the official flow.
- Design B is compatible with the current instruction and installed MWA stack. Candidate fee-payer status makes it the first required signer and transaction-ID signature; the owner remains independently required by the instruction.
- Design C can make an extra candidate account a transaction-required signer, but the program does not inspect it and the design is unnecessary once the candidate is fee payer.
- Design D would add protocol-enforced candidate possession, but requires a program and IDL upgrade. It is stronger than the selected app/transaction guarantee and is not required for this official app flow.
- The deployed-style program still permits an owner using another client to rotate to an unproven pubkey. This is an accepted owner-authority property for this app release, not a claim of protocol-enforced proof.
- Candidate funding may be drained after its check and the deadline may advance during wallet approval. The exact transaction fee and on-chain deadline still fail safely, leave the old agent authorised, and create no local promotion.
- Candidate-funding ambiguity is now journalled separately and reconciled before rotation. It is never retried automatically.
- A retained `previous` key is never overwritten by a later rotation. A new rotation is blocked until a separately authorised cleanup gate removes the prior retained key.
- Security review found two material gaps during implementation: candidate funding originally lacked pre-send durability, and a later rotation could have overwritten an older retained `previous` slot. They were resolved with the separate funding journal and an explicit previous-key cleanup gate. No unresolved CRITICAL, HIGH or MEDIUM findings remain in the WP 4.7 scope.
- The current `MigrationService` must not be used for Fox or Android signing-identity migration. Its destroy-first rotation path has been removed; WP 4.8 must use the new side-by-side primitive.

## Decisions Needed
- None for the completed WP 4.7 boundary.
- A separate user gate is required before WP 4.8 or any program-upgrade decision.

## Live Actions
- None. Testing used only a disposable localhost validator, disposable generated keys and isolated local state.

## Fox
- Untouched.

## Exact Next Action
- Stop for user review. The next gate is WP 4.8 — side-by-side Android signing-identity migration architecture. Do not begin it automatically.
