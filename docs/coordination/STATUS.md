# Current Status

## Repository

- Branch: `phase4-transactional-heartbeat`
- Starting HEAD: `e219262fe75389552ab937ba0abc67f5b36cfb2f`
- Base: `origin/devnet` at `cd0264bb209c0bdc2cf4a576b48ce7d6372c69aa`
- Upstream: `origin/phase4-transactional-heartbeat`, zero divergence at the start gate.
- Worktree: WP 4.8 source changes only; final clean state and exact commit are recorded in the handoff.

## Current Work Package

- Name: WP 4.8 — Side-by-side Android signing-identity migration architecture
- State: PASS. Source implementation and offline validation are complete; exact commit is recorded in the handoff.

## Completed

- Replaced implicit/static Android release identity with fail-closed typed dynamic Expo configuration selected only by `DMV_APP_VARIANT=legacy_bridge|successor`.
- Preserved legacy package `com.romulusol.deadmansvault` and legacy EAS project `b1221e75-1816-4ff6-80bf-8f15f31b27d9` for the private bridge.
- Required an externally chosen, permanently distinct successor package, EAS project, Firebase file, URI scheme and version. No public successor package was selected.
- Removed the active EAS mainnet/production profile. Both remaining profiles are internal, devnet-only and variant-bound. Dynamic configuration and the local Android wrapper reject mainnet.
- Added Firebase package validation. A selected file must exist, parse and contain an Android client matching the selected package; cross-package Firebase identity fails closed.
- Added safe runtime build provenance and unmistakable legacy/successor banners, Settings identity display, MWA metadata and notification-channel labels.
- Added successor-specific empty-storage classification: a fresh successor exposes `incoming_migration_available` rather than ordinary key corruption and starts no automatic action.
- Added a structured signing-migration progress journal with explicit state, identity, public-key/signature, heartbeat-count, deadline, notification-decision and safe-error fields. It stores no secrets, tokens, credentials or transaction bytes.
- Added a dependency-injected incoming migration coordinator. Candidate creation, funding, owner/candidate rotation, successor heartbeat and notification choice are distinct deliberate methods; restart resume is read-only.
- Extended key-slot promotion so a canonically verified candidate can become active in an intentionally empty successor SecureStore without overwriting or importing the legacy key.
- Required a separate verified successor heartbeat with `totalHeartbeats` strictly above the pre-rotation count before notification choice or migration completion.
- Added deliberate notification registration/decline gating. The successor does not request a device token until the successor heartbeat proof exists.
- Added a bridge rollback coordinator architecture using the retained bridge key as replacement payer plus the owner signer. It needs no successor secret and cannot run automatically.
- Added an all-conditions completion predicate; bridge removal remains impossible as an automatic action and is deferred to a separate explicit gate.
- Added a future artifact verifier interface that treats SHA-256 certificate fingerprint as authority and checks package, version, debug state, backup, variant, devnet and Firebase identity.
- Added a disposable local-validator side-by-side scenario covering A→B rotation, unchanged count on rotation, B heartbeat, A rejection, retained-A rollback and A heartbeat.

## Files Changed

- Identity/build configuration: `dead-mans-vault/app/.env.example`, `App.tsx`, `README.md`, `app.config.ts`, `app.json`, `eas.json`, `package.json`, `plugins/withDmvBuildIdentity.js`, `scripts/verify-android-artifact.mjs`, `scripts/verify-android-artifact.test.mjs`.
- Runtime identity and UI: `src/config/appConfig.test.ts`, `src/config/buildIdentityCore.ts`, `src/config/buildIdentityCore.test.ts`, `src/config/runtimeIdentityCore.ts`, `src/config/runtimeIdentity.ts`, `src/config/runtimeIdentity.test.ts`, `src/components/BuildIdentityBanner.tsx`, `src/components/BuildIdentityCard.tsx`, `src/navigation/RootNavigator.tsx`, `src/screens/SettingsScreen.tsx`, `src/notifications/NotificationService.ts`, `src/utils/useAuthorization.tsx`.
- Migration persistence/orchestration: `src/db/database.ts`, `src/db/signingMigrationRepo.ts`, `src/db/signingMigrationRepoCore.ts`, `src/db/signingMigrationRepoCore.test.ts`, `src/services/SideBySideMigrationCoordinator.ts`, `src/services/SideBySideMigrationCoordinator.test.ts`, `src/services/signingIdentityMigrationSecurityGuards.test.ts`.
- Key custody: `src/tee/AgentKeySlotManagerCore.ts`, `src/tee/AgentKeySlotManagerCore.test.ts`, `src/tee/KeyManager.ts`.
- Offline integration and release guard: `dead-mans-vault/tests/side-by-side-migration-local-validator.ts`, `dead-mans-vault/release-tools/build-android-release.sh`.
- Documentation: `docs/android-signing-identity-migration.md`, `docs/coordination/DECISIONS.md`, `docs/coordination/PHASE4.md`, `docs/coordination/STATUS.md`.

## Identity Inventory

- Source Expo SDK: `^52.0.43`; React Native: `0.76.9`; MWA: `2.2.2`.
- Current source app: name `Dead Man's Vault`, slug `dead-mans-vault`, version `1.13.21`, version code `107`.
- Current Android package: `com.romulusol.deadmansvault`.
- Current EAS project: `b1221e75-1816-4ff6-80bf-8f15f31b27d9`.
- Current generated Android directory is ignored derived state. Its generated release configuration used the local debug signing configuration; no native file is tracked.
- Safe current certificate evidence only: SHA-256 `FA:C6:17:45:DC:09:03:78:6F:B9:ED:E6:2A:96:2B:39:9F:73:48:F0:BB:6F:89:9B:83:32:66:75:91:03:3B:9C`.
- Existing ignored Firebase metadata matches the legacy package. No Firebase content, client ID, API key or token was recorded.
- Android backup is disabled. Variant schemes are `dmv-legacy-bridge` and a required distinct successor scheme.
- Expo Updates is disabled and runtime/channel identity is variant-specific.
- Cluster/package/EAS/Firebase/variant/version inputs are build-time environment values; environment contents were not printed or persisted.

## Tests

- `cd dead-mans-vault/app && npm test`: PASS (42/42 test files).
- `node --test --test-isolation=none` over app, Expo-config and artifact-verifier suites: PASS (567/567 cases).
- `cd dead-mans-vault/app && npx tsc --noEmit`: PASS.
- Dynamic Expo legacy-bridge configuration: PASS. Mainnet configuration: rejected as required.
- Disposable local-validator side-by-side integration: PASS (1/1); program binary was loaded into disposable validator genesis, with no deployment transaction.
- `git diff --check`, changed-file secret scan and forbidden-artifact scan: PASS.
- No live RPC, real wallet/device key, APK/AAB, keystore, Firebase configuration, EAS operation or temporary ledger/database was used or retained.
- Dynamic identity tests cover package/EAS separation, version policy, schemes/names, backup, devnet-only and fixture-package exclusion.
- Firebase tests use synthetic fixtures only.
- Migration tests cover deliberate gates, old-public-key/no-old-secret distinction, dual signature/journal ordering, read-only restart, heartbeat-count proof, notification separation and rollback.
- Completion tests independently remove every required condition and prove cleanup remains false.
- Static tests reject cross-app secret channels, mainnet EAS identity, automatic migration actions and secret-bearing build provenance.
- Artifact tests reject wrong package/fingerprint, debuggable, backup-enabled and mainnet evidence; certificate subject alone is insufficient.

## Findings

- The generated native Android project is ignored derived state and is not an identity source of truth.
- The old static MWA name/URI and notification channel names could obscure which side-by-side app was acting. They now derive from safe build identity.
- The successor could not previously promote a candidate when its package-specific active slot was intentionally empty. Empty-active promotion is now explicit, read-back validated and allowed only for the already verified candidate.
- The legacy notification observer would have requested a device token during ordinary Settings observation. Successor token access is now gated until separate heartbeat proof and remains user-controlled.
- The old Android wrapper and README still described a mainnet build path. That path now fails before prebuild and documentation states Phase 4 mainnet NO-GO.
- App/transaction-level candidate proof remains as in WP 4.7. The deployed program still permits an owner using another client to rotate to an unproven pubkey.
- No unresolved CRITICAL, HIGH or MEDIUM finding remains in the WP 4.8 source scope after the Android-identity and migration/rollback reviews.

## Decisions Needed

- Select the permanent successor Android package.
- Provision a distinct successor EAS project and Firebase Android application matching that package.
- Provision and record the successor signing certificate SHA-256 fingerprint.
- Determine the bridge version/version code above the installed build and verify the exact historical certificate at the later artifact gate.
- Choose final visual icon differentiation before dual-install testing.

## Live Actions

- None. No EAS, Firebase, signing, build, install, wallet, devnet or notification-registration action occurred.

## Fox

- Untouched.

## Exact Next Action

- Create the single WP 4.8 commit, push only `phase4-transactional-heartbeat`, and stop. The next gate is manual identity/signing/Firebase provisioning; it requires separate explicit authorisation.

# Prior Status — WP 4.7

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
