# Phase 4: Transactionally Honest Heartbeats and Agent Continuity

## Objective

Make the existing onchain heartbeat flow transactionally honest from the app's
perspective, make ambiguous outcomes recoverable, make missing or mismatched agent
states explicit, and design safe agent continuity for a future Android
signing-certificate migration.

Phase 4 is not an implementation of onchain heartbeat from scratch. The app already
submits `record_heartbeat` with the device agent as signer and fee payer.

## Source-grounded current path

The current dashboard path is:

1. `HeartbeatButton` calls `DashboardScreen.handleHeartbeat`.
2. `handleHeartbeat` awaits `useHeartbeat.confirmHeartbeat('active_tap')`.
3. `useHeartbeat.confirmHeartbeat` calls
   `HeartbeatService.confirmHeartbeat`.
4. `HeartbeatService.confirmHeartbeat` inserts a timestamped row in
   `heartbeat_history` and refreshes heartbeat Zustand state from SQLite.
5. `useHeartbeat.confirmHeartbeat` resets the local escalation Zustand state,
   clears the countdown and sends the local success notification.
6. Control returns to `DashboardScreen.handleHeartbeat`.
7. `KeyManager.getKeypair` loads and, when configured, authenticates access to the
   device agent key.
8. `VaultTransactionService.recordHeartbeatOnChain` derives the vault and heartbeat
   PDAs and builds the `record_heartbeat` instruction.
9. `sendWithPayer` adds compute-budget instructions, makes the agent the fee payer,
   signs with the agent, serializes and submits with `sendRawTransaction`, then
   awaits `confirmTransaction(..., 'confirmed')`.
10. The signature is placed in component state, an Explorer link becomes
    available, and `loadVaultState` reloads the vault and heartbeat accounts.

The loading state belongs only to step 2 through step 5. Consequently,
`HeartbeatButton` transitions to its green `Vault Secured` state after the local
SQLite write and before agent loading, transaction construction, submission or
confirmation.

## Verified current mutations and failure boundaries

### Local state

- `heartbeat_history` is appended before any onchain attempt.
- Its existing `on_chain_tx` column is left `NULL` by this path.
- Heartbeat Zustand status is recalculated from SQLite immediately.
- Escalation Zustand state and `executionStarted` are reset immediately.
- The local heartbeat-success notification is sent immediately.
- `secondsRemaining` is set to zero immediately.
- The UI's next-due calculation uses the local SQLite-derived heartbeat status.

These effects can represent success even when the authoritative heartbeat account
was not updated.

### Transaction construction and result handling

- The Anchor instruction requires the registered agent signer, an active and
  unexecuted vault, the matching heartbeat PDA, and a timestamp before the program
  deadline.
- The agent signs and pays for the transaction.
- `sendRawTransaction` performs preflight and returns a signature.
- The signature is not persisted before confirmation.
- `confirmTransaction` is awaited, but its returned `value.err` is not inspected.
  The installed web3.js implementation can resolve a signature notification that
  contains an execution error, so resolution alone is not a sufficient success
  invariant.
- If submission succeeds but confirmation times out, expires or becomes
  unreachable, the dashboard catches a generic failure and loses the signature.
- There is no durable pending state and no restart-time reconciliation.
- Build, key, balance, preflight, program rejection, timeout and ambiguous-outcome
  errors collapse into the same transient warning.

### Missing and mismatched keys

Source inspection corrects one candidate assumption: a missing key does not
silently skip the ordinary connected-wallet path. `KeyManager.getKeypair` throws,
and the nested dashboard catch displays the generic onchain failure warning.
However, it is not identified as a missing-key condition, it follows local success,
and no durable remediation state is recorded.

A mismatched key similarly reaches the program, fails `UnauthorizedAgent`, and is
reduced to the same generic warning. Startup migration detection can prompt for a
missing or mismatched key after a two-minute new-vault exemption, but the check is
once per navigator lifecycle, errors are swallowed, and choosing `Later` leaves the
dashboard path unclassified. The `if (keypair && publicKey)` guard could skip the
submission if the wallet key became null, although `getKeypair` itself never returns
null.

### Agent rotation and fee state

The current migration flow:

1. destroys the locally stored key;
2. generates and stores a replacement key;
3. builds an owner-signed `rotate_agent`;
4. submits it through Mobile Wallet Adapter;
5. awaits confirmation and returns.

This is not continuity-safe. Cancellation, failure or an ambiguous outcome can
leave the app without the old authoritative key and with a new local key whose
onchain status is uncertain. The replacement agent is not funded by the migration
transaction, even though the agent must pay heartbeat fees.

The current program's `rotate_agent`:

- requires the owner signer;
- requires an active, unexecuted vault and matching heartbeat record;
- rejects rotation at or after the execution deadline;
- rejects the zero key, the owner key and the current agent key;
- installs the new agent and resets `last_heartbeat` to the current cluster time.

It does not require the old agent or new agent to sign, prove possession of the new
key, or maintain an overlap window. Existing program and fuzz tests cover the happy
path, zero/owner/same-key guards, agent authorization and the exact deadline freeze
boundary. There are no app tests for `handleHeartbeat`, `useHeartbeat`,
`HeartbeatService`, `MigrationService`, `KeyManager` or transaction reconciliation.

## Phase 4 invariants

1. The app must not display, notify or persist authoritative heartbeat success
   until a successful transaction is established at the required commitment.
2. Local escalation state must not reset before authoritative success.
3. A submitted signature must be durable before the app can lose control through a
   timeout, crash or process restart.
4. Confirmation must inspect the transaction result, not only wait for a response.
5. Ambiguous is a distinct recoverable state, not success and not terminal failure.
6. Retrying or reconciling must not conceal a program rejection.
7. The connected owner, local agent and registered onchain agent must be compared
   explicitly before submission.
8. Agent fee insufficiency must be classified before signing and must not be
   mistaken for key mismatch or network failure.
9. Rotation must never destroy the last usable agent key before the replacement is
   confirmed, funded and proven usable.
10. Deadline calculations and escalation UI must follow the authoritative heartbeat
    timestamp and vault configuration.
11. App-only work must remain compatible with the deployed program. Any instruction
    change is a separately designed and approved program-upgrade gate.

## Work-package sequence

### Gate 0: Repository base

- Work only on a normal branch based on the user-approved `origin/devnet` tip.
- Confirm a clean worktree and record the exact base in `STATUS.md`.
- Do not carry detached review commits into Phase 4 implicitly.

Exit: user accepts the branch/base and authorizes Work Package 1.

### Work Package 1: Current-path inventory and executable invariants

- Convert this inventory into focused app-facing tests around orchestration
  ordering and result classification.
- Add characterization tests proving the current unsafe order before changing it,
  or encode the desired invariant directly if the test harness makes a red/green
  characterization impractical.
- Preserve the existing program tests for authorized heartbeat, unauthorized agent,
  rotation guards and deadline freeze.

Exit: inventory and test seam reviewed; no live action.

### Work Package 2: Explicit agent readiness

- Introduce a typed readiness result for missing key, unreadable/authentication
  failure, local/onchain mismatch, inactive/executed/frozen vault and ready state.
- Compare the loaded public key with `vault.agentPubkey` before constructing a
  heartbeat.
- Make the dashboard present a specific, actionable state without requesting an
  owner signature automatically.
- Remove nullable branches that can skip submission without a classified outcome.

Exit: missing/mismatch tests pass; no rotation performed.

### Work Package 3: Authoritative heartbeat success ordering

- Make a single orchestration boundary own key validation, submission,
  confirmation, local persistence, escalation reset, success notification and UI
  completion.
- Keep the button pending through authoritative completion.
- Commit the local success record, signature and authoritative timestamp only after
  successful confirmation.
- Reload the heartbeat account and derive UI state from it before displaying
  `Vault Secured`.

Exit: ordering tests prove no local success effect occurs on build, signing,
submission, program or confirmation failure.

### Work Package 4: Durable pending-transaction reconciliation

- Add an explicit SQLite migration and repository for heartbeat attempts.
- Persist owner/vault/agent/method, signature, blockhash expiry information,
  timestamps and a state such as `SUBMITTED`, `CONFIRMED`, `FAILED`, `EXPIRED` or
  `UNKNOWN`.
- Capture the transaction signature before or atomically with submission so a
  post-submit timeout cannot erase it.
- Reconcile pending attempts at startup and before a new tap using signature status
  and the heartbeat account.
- Distinguish definitive program failure, expiry and still-ambiguous RPC state.

Exit: restart, timeout, expiry, confirmed-error and eventual-success tests pass.

### Work Package 5: Deadline and escalation correctness

- Make local countdown and escalation reset follow the confirmed onchain heartbeat
  timestamp and onchain interval/grace configuration.
- Test just-before, exact and just-after deadline behavior against the program's
  `now < deadline` rule.
- Ensure a pending or failed heartbeat never cancels warnings or marks the vault
  healthy.
- Keep server notification registration behavior out of this work package except
  where a confirmed heartbeat must drive an already-registered vault's state.

Exit: app boundary tests and existing local-validator freeze tests pass.

### Work Package 6: Agent fee-state handling

- Preflight the agent balance against an estimated heartbeat fee and return a typed
  insufficient-fee state.
- Design an owner-approved funding action; never request or submit it implicitly.
- For rotation, prefer one owner-signed transaction that rotates and funds the staged
  new agent atomically when compatible with the existing program.
- Test low balance, exact threshold, RPC estimation failure and successful recovery.

Exit: no heartbeat is attempted with a knowingly unusable fee state.

### Work Package 7: Existing `rotate_agent` security analysis

- Threat-model owner-only rotation, arbitrary new pubkeys, heartbeat reset,
  pre-deadline freeze and the absence of old/new-agent signatures.
- Extend local-validator tests to prove old-agent rejection and new-agent acceptance
  after rotation, atomic funding behavior and failure rollback.
- Decide whether owner authorization plus app-side staged-key proof is sufficient
  for Phase 4.
- If new-agent proof, overlap, delay or acceptance must be enforced by the program,
  stop and open a separate program-upgrade decision; do not mix it into app work.

Exit: explicit app-only versus program-change decision recorded.

### Work Package 8: Side-by-side Android signing-identity migration architecture

- Treat differently signed apps as separate Android identities with isolated secure
  storage; do not assume the existing key can be read or copied.
- Add staged-key storage rather than overwriting the active key.
- Let the future side-by-side app generate and prove access to a candidate key,
  then construct an owner-reviewed rotate-and-fund transaction.
- Retain the old app and old key until the rotation is confirmed, reconciled and a
  heartbeat signed by the new key succeeds.
- Define rollback for cancellation, expiry, mismatch and a new key that cannot sign.
- Do not change signing identity, build an APK, uninstall the current app or clear
  app data in this work package.

Exit: architecture and tests reviewed; Android signing remains a separate gate.

### Work Package 9: Tests and local-validator validation

- Run app unit/integration tests for ordering, persistence, reconciliation, key
  readiness, rotation staging and fee state.
- Run Anchor/local-validator tests for heartbeat and rotation invariants.
- Run the existing fuzz freeze test and relevant full suites.
- Record exact commands and outcomes in `STATUS.md`.

Exit: all relevant local tests pass with no live action.

### Work Package 10: Disposable devnet canary

- Requires a separate explicit live-action gate.
- Use a newly generated disposable devnet owner, vault and agents; never use Fox.
- Do not deploy or upgrade the program.
- Exercise only behavior compatible with the currently deployed instruction
  interface: heartbeat success, a controlled reconciliation case where practical,
  owner-signed rotate-and-fund, old-agent rejection and new-agent heartbeat.
- Record sanitized signatures and results without secrets or environment values.

Exit: canary evidence reviewed and disposable cleanup separately authorized.

### Work Package 11: Draft PR only

- Update coordination status and decisions.
- Review the complete diff and test evidence.
- Create a draft PR only when explicitly authorized.
- Do not merge it and do not begin another phase.

## Program-change assessment at this gate

No program change currently appears necessary for authoritative app ordering,
durable reconciliation, explicit key-state detection, fee-state handling or a
staged owner-signed rotation using the existing instruction. The existing
`rotate_agent` can accept a generated replacement pubkey, and a System Program
funding transfer can be composed in the same owner-signed transaction.

A program change may be desirable if the security decision requires the new agent
to co-sign, an old/new-agent overlap, a delayed acceptance protocol or an onchain
idempotency identifier. None is selected in this gate. Any such change requires a
separate program-upgrade design, deployed-program compatibility review, tests and
explicit deployment authorization.

The deployed devnet program was not queried during this no-live-action gate.
Compatibility conclusions here are based on the repository program, checked-in
IDL/client and existing tests; Work Package 10 must verify the deployed interface
only after explicit authorization.
