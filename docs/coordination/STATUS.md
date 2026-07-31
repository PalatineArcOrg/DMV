# Current Status

## Repository
- Branch: `phase4-transactional-heartbeat`
- HEAD: WP 4.2 implementation commit `phase4: add explicit heartbeat agent readiness` (exact SHA recorded in the handoff)
- Base: `origin/devnet` at `cd0264bb209c0bdc2cf4a576b48ce7d6372c69aa`
- Starting HEAD: `b2d8e5a97cb4e8c79848eaf28736371e4b9c8883`
- Worktree: Clean after the WP 4.2 implementation commit and branch push.

## Current Work Package
- Name: WP 4.2 — Explicit agent readiness and heartbeat preflight
- State: PASS

## Completed
- Added a dependency-injected `AgentReadinessService` and a production adapter that reuse `VaultTransactionService` PDA helpers and the existing hardened raw-account parsers.
- Added a full hardened `HeartbeatRecord` parser alongside the existing `VaultConfig` parser; both account types are checked for program owner, discriminator, bounds and canonical PDA bump.
- Made the connected owner, current raw onchain accounts and device-held key explicit readiness inputs. Cached Zustand vault state, local SQLite heartbeat state and notification registration are not readiness evidence.
- Added explicit readiness states: `ready`, `owner_missing`, `agent_missing`, `agent_unavailable`, `agent_mismatch`, `vault_missing`, `vault_inactive`, `vault_executed`, `rpc_unavailable` and `invalid_on_chain_state`.
- Added `heartbeat_in_flight` at the coordinator boundary and a per-dashboard coordinator lock. The lock is released in `finally` after success and every failure class.
- Made the dashboard button pending for the full coordinator attempt and made its `Vault Secured` animation depend only on an explicit `confirmed_on_chain` result.
- Added typed, non-address-bearing dashboard messages for every readiness failure. No automatic key generation, rotation or owner-wallet prompt was added.
- Preserved the current transaction confirmation behavior and the local-first success mutations after a valid readiness result for correction in WP 4.3.

## Files Changed
- `dead-mans-vault/app/src/components/HeartbeatButton.tsx`
- `dead-mans-vault/app/src/screens/DashboardScreen.tsx`
- `dead-mans-vault/app/src/services/AgentReadinessService.ts`
- `dead-mans-vault/app/src/services/AgentReadinessService.test.ts`
- `dead-mans-vault/app/src/services/DefaultAgentReadinessService.ts`
- `dead-mans-vault/app/src/services/HeartbeatCoordinator.ts`
- `dead-mans-vault/app/src/services/HeartbeatCoordinator.test.ts`
- `dead-mans-vault/app/src/services/heartbeatAttemptUi.ts`
- `dead-mans-vault/app/src/services/heartbeatAttemptUi.test.ts`
- `dead-mans-vault/app/src/utils/rawAccountParsers.ts`
- `dead-mans-vault/app/src/utils/rawAccountParsers.test.ts`
- `docs/coordination/STATUS.md`
- `docs/coordination/DECISIONS.md`
- `docs/coordination/PHASE4.md`

## Tests
- `cd dead-mans-vault/app && npm test`: PASS (14/14 test files, 0 failures).
- `node --test --test-isolation=none 'src/**/*.test.ts'`: PASS (248/248 cases).
- Focused readiness, coordinator, UI and raw-account parser boundary: PASS (51/51 cases).
- WP 4.2 added 34 net app cases over the accepted 214-case baseline: 18 readiness cases, 12 net coordinator cases, three UI cases and one parser case.
- `cd dead-mans-vault/app && ./node_modules/.bin/tsc --noEmit`: PASS.
- `git diff --cached --check`: PASS.
- Staged changed-file secret scan: PASS; no private key, seed phrase, credential, notification token, RPC secret or environment value was found.
- Forbidden-artifact scan: PASS; no APK, keystore, `.env`, credential or wallet-secret artifact entered Git.
- Tests use injected account fetches, deterministic in-memory keypair fixtures and static source checks. They do not instantiate the production readiness adapter or make an RPC request.
- No existing security test was weakened or deleted.

## Findings
- Connected owner source: `useWallet().publicKey` in `DashboardScreen`.
- Canonical address source: `VaultTransactionService.getVaultPDA(owner)` and `getHeartbeatPDA(vault)`.
- Authoritative state source: fresh `Connection.getAccountInfo` reads for the canonical vault and heartbeat accounts, decoded by `parseVaultConfig` and `parseHeartbeatRecord`.
- Readiness preflight order: require owner → derive canonical vault/heartbeat PDAs and bumps → fetch and validate vault owner/discriminator/PDA/embedded owner/bump → require active → require not executed → fetch and validate heartbeat owner/discriminator/PDA/embedded vault/bump → load device key once → derive local public key → compare with `vault.agentPubkey` → return the exact checked keypair as `ready`.
- `KeyManager.getKeypair()` returns `Promise<Keypair>`, uses its in-memory cache when populated, otherwise reads the device-only authentication flag and secure-store secret with the matching device-authentication options. A missing secret throws; an authentication/unlock failure is kept distinct as `agent_unavailable`.
- Existing startup detection remains in `RootNavigator`: after its existing new-vault delay it compares the local public key with the cached vault agent and can offer a deliberate rotation prompt. WP 4.2 does not rely on that check, trigger it or change it.
- Temporary ready-attempt order: single-flight acquisition → readiness → local SQLite heartbeat → local escalation reset → local success notification → onchain submission/confirmation with the checked keypair → signature or warning publication → vault reload → lock release.
- The remaining defect is explicit: after readiness succeeds, local liveness, countdown reset and success notification still occur before conclusive onchain confirmation. A chain failure therefore still leaves local success effects.
- The existing resolved-`confirmTransaction().value.err` defect is intentionally unchanged.
- Agent balance and fee estimation are not part of readiness in WP 4.2. Insufficient agent funds still surface as `on_chain_failed`.
- The current MigrationService and startup migration flow were not changed.
- The current MigrationService must not be used for Fox or signing-identity migration.
  It destroys the active agent key before replacement authority is proven.

## Decisions Needed
- None for the completed WP 4.2 boundary.
- A separate user gate is required before WP 4.3.

## Live Actions
- None.

## Fox
- Untouched.

## Exact Next Action
- Stop for user review. The next recommended work package is WP 4.3 — confirmation integrity and authoritative heartbeat success ordering. Do not begin it automatically.
