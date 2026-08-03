# Current Status

## Repository
- Branch: `phase4-transactional-heartbeat`
- HEAD: `daf594e` — `Revert "phase4: add side-by-side signing migration architecture"`
- Base: `origin/devnet` at `cd0264bb209c0bdc2cf4a576b48ce7d6372c69aa`
- Tree: identical to the accepted WP 4.7 tree (`e219262`), verified — both resolve to
  tree `0ea37c6acb0b2917154aff7eab5ce0e76268d37c`. The WP 4.8 add/revert pair exists
  only in history and changes no file.
- Worktree: Clean.

## Current Work Package
- Name: Phase 4 complete at WP 4.7 — Crash-safe owner-authorised agent rotation
- State: PASS. WP 4.8 is cancelled (see PHASE4.md); Phase 4 ends here.

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
- Metro/Hermes bundle (`npx expo export --platform android`): PASS. Produced a 6.04 MB
  Hermes `.hbc` with zero resolution errors. This is a deliberate check, not a build:
  type-checking green has three times not implied Hermes green in this repository. It
  confirms the whole Phase 4 module graph bundles under Metro and compiles to Hermes
  bytecode, and that Metro resolves the explicit `./agentFundingPolicy.ts` specifier
  required by the Node test runner. No APK was built and nothing was installed.
- Module-graph uniqueness (`--source-maps`, module list): PASS. 1,528 modules, 116 of
  them app source, **zero duplicated module paths**. `agentFundingPolicy` resolves to
  the single path `/src/services/agentFundingPolicy.ts`, so its two import forms —
  `./agentFundingPolicy.ts` from the fee/funding services and the extensionless
  `../services/agentFundingPolicy` from EstateReviewScreen — dedupe to one instance.
  > Method note, recorded because the first attempt was wrong: this claim was
  > originally made by counting a marker string's occurrences in the `.hbc`. That
  > cannot evidence it. `grep -c` counts matching lines rather than matches, and more
  > fundamentally Hermes interns identical string literals into a shared string table,
  > so a duplicated module still contributes exactly one interned string. Module-instance
  > uniqueness is only observable in the source-map module list, which is what is
  > measured above.
- Disposable local-validator integration: PASS (2/2 scenarios). It proves candidate-funded dual signing, candidate transaction ID, one successful rotation, unchanged heartbeat count, timestamp reset, old-agent heartbeat rejection, candidate heartbeat acceptance, restart slot resolution/promotion, failure retention of the old agent and exact-deadline rejection.
- `git diff --check`: PASS.
- Changed-file secret scan: PASS.
- Forbidden-artifact scan: PASS.
- No existing test was removed or weakened merely to pass. The disposable ledger and wallet were removed after the run.

### Pre-merge T1.1 — legacy agent-key upgrade compatibility: PASS

Offline. `src/tee/legacyAgentKeyUpgrade.test.ts`, 20/20 cases. Full app suite 545/545
(was 525), `tsc --noEmit` clean.

Every existing installation holds an agent key written by the pre-Phase-4 KeyManager.
If the compatibility path were wrong, readiness would report `agent_missing` and those
owners would stop heartbeating silently while their on-chain deadline continued.

Fixtures were reconstructed from source, not from the test-plan prose: the pre-Phase-4
`KeyManager.ts` at `cd0264b` — byte-identical to the v1.13.20 release commit `c786064`
and the app's **only** SecureStore call site — writes exactly `dmv_agent_secret_key`
(bs58 of the 64-byte secret), `dmv_agent_public_key` and `dmv_agent_key_auth`, and
reads the secret back with `authed = (auth === '1')`. No `dmv_agent_key_complete`
exists in a legacy install.

All three historical authentication shapes pass — `auth='1'`, `auth='0'` and auth
absent. For each: the slot is complete, the public key matches, the key loads, exact
on-chain resolution returns `active_match`, and the recovered key produces a signature
that verifies by ed25519 over a real compiled message. Loading is read-only — storage
is byte-identical afterwards, no set or remove is issued, no key is generated, no
candidate or previous slot appears, and the completion marker stays absent. Each shape
is re-verified from a rebuilt manager so success cannot come from a warm cache. Legacy
promotion also passes for every shape: candidate becomes active, the legacy key is
retained in `previous` with its original authentication mode and still signs, the
candidate slot is fully removed, both surviving slots gain modern completion markers,
and repeating the completed promotion changes nothing.

The harness models the property that makes the result meaningful: a SecureStore secret
read with the wrong authentication mode fails to decrypt. A control proves this, so a
mismatched mode cannot pass vacuously. Eight negative controls confirm the
compatibility path stays narrow — absent/malformed/mismatched public key, invalid auth
value, malformed secret, and the missing-marker path being rejected for `candidate` and
`previous`, so only a genuine legacy `active` slot benefits.

The suite was mutation-tested before acceptance: disabling the `isLegacyActive` branch
fails all 12 shape cases while all 8 negative controls still pass, proving the tests
detect the regression they exist for. The mutation was local only, reverted, and the
production file verified by checksum; no production code was changed by this gate.

T1.3 was not started.

### Pre-merge T1.2 — populated legacy database migration: PASS

Offline, file-backed. `src/db/legacyDatabaseMigration.test.ts`, 9/9 cases. Full app
suite 554/554 (was 545), `tsc --noEmit` clean. Engine: `node:sqlite` (SQLite 3.51.2),
already available via Node 24 and typed by the installed `@types/node` — no dependency
was added.

Unit tests elsewhere use fresh in-memory databases; nothing had opened a *populated*
legacy file. Each case builds a real database on disk in a disposable temp directory
and closes/reopens between phases, so results reflect persistence rather than
connection state. Temp directories are removed in `finally`, including on failure.

The legacy fixture is the verbatim schema from the pre-Phase-4 `database.ts` at
`cd0264b` — SHA-256 `f4dc94ec…507d1d`, byte-identical to the v1.13.20 release commit
`c786064`. It was taken from source, not derived by subtracting Phase 4 tables from the
current schema. Six tables (`heartbeat_history`, `escalation_history`,
`execution_steps`, `settings`, `price_history`, `defi_positions`) and three indexes,
populated with 19 deterministic rows covering null/non-null signatures, null/non-null
reasons, pending/failed/completed steps, composite-key price rows and both nullable and
populated DeFi token fields.

The migration under test is the **actual production SQL**: `database.ts` is read at
runtime, its single `execAsync` template extracted, and the three real schema constants
substituted. A guard fails the test if any `${…}` remains, so production growing a new
interpolation cannot silently go unexercised.

First migration preserves every legacy row, column definition, index and
`sqlite_sequence` value byte-for-byte; `PRAGMA integrity_check` returns `ok` before and
after. All four Phase 4 objects are created and verified at column level — `NOT NULL`,
nullability, primary keys, and `u64` counts held as `TEXT`. All five indexes are
verified by definition, including the partial predicates. A new heartbeat row then
writes normally, `AUTOINCREMENT` continues at id 5, and the older rows are unchanged.
A second migration over the already-migrated, journal-populated file leaves the full
snapshot identical, creates no duplicate objects, and keeps `integrity_check` at `ok`.

Partial unique indexes were proven behaviourally, not by reading their SQL: for each of
the three journals a second unresolved operation for the same identity is rejected,
terminal records coexist, a new unresolved operation is permitted once the first
resolves, and duplicate signatures are rejected in every state. Journal rows survive
close/reopen with `18446744073709551615` returned as the identical string and null
resolution/error fields still null.

Mutation-tested before acceptance: removing `${AGENT_ROTATION_SCHEMA_SQL}` from
`database.ts` fails 5 of 9 cases with specific diagnostics
(`agent_rotation_operations must exist`, `no such table: agent_rotation_operations`),
while the legacy-preservation cases correctly still pass. The mutation was local only,
reverted, and the production file verified by checksum; no production code was changed
by this gate.

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
- The destroy-first `MigrationService.executeRotation` path has been removed. Deliberate agent rotation now goes through the WP 4.7 primitive from Settings. `MigrationService` retains only read-only startup reconciliation.
- WP 4.8 (side-by-side Android signing identity) is cancelled on product grounds: DMV is one app, `com.romulusol.deadmansvault`, and the live vault is devnet. No second package, EAS project or Firebase Android client is planned.

## Decisions Needed
- None blocking the PR.
- Open for review, not blocking: Phase 4 verifies confirmation against a single RPC
  connection. The mainnet remediation tracker defines this phase as confirmation
  failing closed "via independently verified RPC endpoints in distinct failure
  domains". Either add a second endpoint for the readiness/verify reads or rescope
  that wording deliberately.
- A separate user gate is still required for any program-upgrade decision
  (protocol-enforced candidate signing), the retained-previous-key cleanup flow, and
  the local Stage 1–3 notification-fallback question.

## Live Actions
- None. Testing used only a disposable localhost validator, disposable generated keys and isolated local state.

## Fox
- Untouched.

## Exact Next Action
- Phase 4 is code-complete at WP 4.7. The next action is review of the
  `phase4-transactional-heartbeat` → `devnet` pull request, which is open as a
  **draft** and must not be merged until on-device acceptance testing has been run
  and reviewed.
- Do not build, install, deploy, register notifications or touch Fox as part of that
  review. Each remains its own gate. Mainnet remains NO-GO.
