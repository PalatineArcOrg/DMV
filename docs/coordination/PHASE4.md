# Phase 4: Transactionally Honest Heartbeats and Agent Continuity

## Objective

Make the existing onchain heartbeat flow transactionally honest from the app's
perspective, make ambiguous outcomes recoverable, make missing or mismatched agent
states explicit, and make agent rotation crash-safe so the last usable key is never
destroyed.

Scope note: an earlier revision of this objective also covered designing agent
continuity across a future Android signing-certificate migration. That direction
became Work Package 8 and was cancelled (see below). Phase 4 delivers WP 4.1–4.7
and ends there. DMV remains one app; mainnet remains NO-GO.

Phase 4 is not an implementation of onchain heartbeat from scratch. The app already
submits `record_heartbeat` with the device agent as signer and fee payer.

## Source-grounded pre-WP 4.2 path

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

## WP 4.2 readiness boundary

WP 4.2 inserts a fresh, typed readiness preflight ahead of the preserved
local-first flow:

1. acquire the per-dashboard single-flight lock;
2. require the connected owner public key;
3. derive the canonical vault and heartbeat PDAs and bumps using
   `VaultTransactionService`;
4. fetch the raw canonical vault account and validate program owner,
   discriminator, bounds, embedded owner and PDA bump;
5. require the vault to be active and not executed;
6. fetch the raw canonical heartbeat account and validate program owner,
   discriminator, bounds, embedded vault, method and PDA bump;
7. load the device key once using the existing authenticated `KeyManager`
   contract;
8. compare its public key exactly with `vault.agentPubkey`;
9. only a `ready` result may enter the existing local-first heartbeat path.

The ready result carries the exact checked keypair only within the readiness and
coordinator call stack. It is not persisted, logged, serialized or exposed to
React state.

The implemented readiness states are `ready`, `owner_missing`, `agent_missing`,
`agent_unavailable`, `agent_mismatch`, `vault_missing`, `vault_inactive`,
`vault_executed`, `rpc_unavailable` and `invalid_on_chain_state`. The coordinator
adds `heartbeat_in_flight`.

A concurrent tap returns `heartbeat_in_flight` without a second readiness fetch,
local write, notification or transaction. The attempt lock always releases in
`finally`; no retry or queue was added.

After a valid readiness result, the temporary WP 4.2 order remains:

```text
local SQLite heartbeat
→ local escalation reset
→ local success notification
→ onchain submission and existing confirmation call
→ signature or warning publication
→ vault reload
```

This remains unsafe and is not a Phase 4 invariant. WP 4.3 must inspect
confirmation results correctly and move authoritative success effects behind
conclusive onchain confirmation. Durable ambiguous-outcome reconciliation remains
a later package.

Agent balance and estimated-fee readiness are deferred. WP 4.2 does not introduce
an `insufficient_agent_funds` state.

## WP 4.3 authoritative confirmation boundary

WP 4.3 replaces the temporary local-first tail with:

```text
readiness and verified pre-state
→ agent build/sign/send
→ structural confirmation classification
→ canonical heartbeat post-state fetch
→ advancement verification
→ confirmed local history write
→ escalation/countdown reset
→ best-effort success notification
→ confirmed Explorer publication
→ onchain UI reload
```

Transaction lifecycle results are:

- `submission_failed`: no signature was returned;
- `confirmed_failed`: a signature was returned and confirmation resolved with a
  non-null `value.err`;
- `confirmation_unknown`: a signature was returned but confirmation threw or had
  a malformed response;
- `confirmed`: a signature was returned and confirmation explicitly resolved with
  `value.err === null`.

Only `confirmed` proceeds to post-state verification. The canonical heartbeat
account must remain program-owned and structurally valid, reference the canonical
vault, retain the canonical bump, match the submitted method, have a timestamp at
least as high as the readiness snapshot and have a strictly higher total count.

Local history stores `HeartbeatRecord.lastHeartbeat` and the confirmed signature.
The success notification uses `lastHeartbeat + heartbeatInterval`; it does not use
button time. A verified chain success remains successful when local cache,
notification or reload work fails.

Confirmation-unknown and post-state-unverified signatures are exposed as distinct
linkable UI states but are not durably persisted. They are never retried
automatically. Durable restart reconciliation remains WP 4.4.

## Baseline mutations and failure boundaries before WP 4.3

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

- Implemented a typed readiness result for missing key, unreadable/authentication
  failure, local/onchain mismatch, missing/inactive/executed vault, RPC failure,
  invalid account state and ready state.
- Fetches and validates the canonical onchain vault and heartbeat accounts before
  loading the device key once and comparing it with `vault.agentPubkey`.
- Presents specific dashboard states without automatic key generation, rotation
  or owner signing.
- Adds a per-dashboard single-flight guard and explicit confirmation trigger.

Exit: PASS. Offline readiness, coordinator, UI and parser tests pass; no live RPC
or rotation was performed. WP 4.3 remains separately gated.

### Work Package 3: Authoritative heartbeat success ordering

- Implemented structural confirmation classification, including non-null
  `value.err` rejection and signature-preserving unknown outcomes.
- Implemented canonical post-state verification against the readiness snapshot.
- Moved local persistence, escalation reset, countdown reset, notification and
  success UI behind verified chain advancement.
- Stored the verified chain timestamp and confirmed signature in local history.
- Preserved verified chain success across local-cache, notification and reload
  failures.

Exit: PASS. Ordering tests prove no local success effect occurs before conclusive
confirmation and verified post-state advancement. No live action occurred.

### Work Package 4: Durable pending-transaction reconciliation

- Implemented a structured SQLite operation journal with explicit identity,
  method, pre-state, blockhash lifetime, lifecycle, resolution and safe-error
  columns. Full `u64` counts are decimal strings.
- Derives the agent payer's transaction ID after signing and durably commits
  PREPARED before the one `sendRawTransaction` call.
- Treats every inconclusive post-invocation send result as
  `submission_unknown`; no journaled transaction is automatically resent.
- Reconciles using history-aware signature status, confirmed commitment,
  blockhash expiry and the WP 4.3 canonical heartbeat verifier.
- Resolves absent expired signatures as not-landed only when chain state did not
  advance. Advanced state without signature attribution updates a separate
  authoritative cache and never labels the unresolved transaction successful.
- Makes confirmed-history repair idempotent by signature and keeps
  `confirmed_local_sync_pending` durable without blocking later heartbeats.
- Runs one bounded read-only reconciliation per identity on Dashboard focus and
  before a deliberate tap. Reconciliation has no signing, transaction send,
  wallet prompt, notification registration mutation or polling loop.
- Retains ten terminal operations per identity while preserving every unresolved
  operation.

Exit: PASS. Temporary SQLite reopen, crash-boundary, timeout, mismatch, expiry,
confirmed-error, eventual-success, idempotency and lifecycle tests pass. No live
action occurred. WP 4.5 remains separately gated.

### Work Package 5: Deadline and escalation correctness

- Implemented canonical, hardened vault/heartbeat reads pinned at or after a
  confirmed Solana chain-time slot.
- Implemented safe deadline arithmetic and exact program parity:
  `now < finalDeadline` remains heartbeat-permitted by time and
  `now >= finalDeadline` is executable by time.
- Implemented positive safe stage-duration validation whose exact sum must equal
  the canonical on-chain grace period.
- Replaced SQLite/device-wall-clock escalation authority with explicit verified
  snapshots.
- Added a 30-second monotonic-only display projection. It may display stages 0–3
  but cannot enter executable Stage 4; the boundary forces a fresh read.
- Added a one-attempt-per-vault/deadline mobile execution guard and removed the
  old execution wait/poll loop.
- Made immediate and reconciled heartbeat outcomes refresh the canonical
  deadline rather than reset it from local cache.
- Demoted confirmed history, unattributed cache and owner-activity rows to
  diagnostics/history/repair roles.
- Centralized explicit demo versus production stage durations across vault
  creation, mobile evaluation and deliberate notify-server registration.
- Corrected cancel-only notification timeline comments. Stage 1–3 pushes remain
  notify-server-only and notification registration remains independent.

Exit: PASS. App boundary tests cover exact program boundaries, stale/regressing
time, canonical account validation, projection, Stage 4 guards, reconciliation
refresh and local-history separation. No live RPC or execution action occurred.
WP 4.6 remains separately gated.

### Work Package 6: Agent fee-state handling

- Implemented exact-message fee estimation for the one heartbeat transaction
  later signed and submitted. Transaction construction, priority-fee selection
  and blockhash acquisition occur once.
- Reads the authorised agent balance at confirmed commitment with a minimum
  context slot from the exact fee response.
- Implements `ready`, `low_reserve`, `insufficient`, `check_unavailable` and
  `invalid_response` states using safe integer lamports.
- Blocks verified insufficiency before signing, journal persistence, send or
  local liveness effects. Low reserve and unavailable auxiliary reads do not
  block a currently deliberate heartbeat.
- Centralizes the existing `5,000,000`-lamport activation funding target without
  changing product economics.
- Adds read-only, identity-scoped Dashboard and Settings reserve visibility with
  bounded focus/foreground/outcome refresh and explicit stale display.
- Adds a separate owner-signed System Program top-up to only the currently
  validated canonical agent. The amount is the exact shortfall to the existing
  reserve and is disclosed with the owner transaction fee before signing.
- Keeps top-up entirely separate from heartbeat history, escalation, notification
  registration and the heartbeat journal. It has no automatic retry.
- Leaves candidate funding and rotation wiring for the separately gated rotation
  and migration packages.

Exit: PASS. No heartbeat reaches signing with verified fee insufficiency; low
reserve and unavailable auxiliary checks preserve deliberate liveness. Offline
tests pass and no live action occurred. WP 4.7 remains separately gated.

### Work Package 7: Existing `rotate_agent` security analysis

- Selected candidate-as-fee-payer rotation against the existing instruction. The
  candidate provides the transaction-ID signature and the owner remains the
  instruction-required signer.
- Verified through installed-adapter source, wire round-trip tests and
  local-validator execution that MWA-compatible legacy serialization preserves
  the candidate partial signature while the owner signature is added.
- Added exact wallet-result validation and rejects changes to payer, blockhash,
  instructions, account metas, candidate argument, compute budget or signatures.
- Replaced single-slot custody with independent active/candidate/previous
  SecureStore roles, exact on-chain pubkey resolution and copy-before-remove,
  restart-idempotent promotion.
- Added a separate deliberate candidate-funding transaction and durable funding
  journal. Funding reaches the existing reserve, never counts as liveness and
  never starts rotation.
- Added a structured rotation journal persisted after both signatures and before
  the one send. Ambiguous sends/confirmations reconcile read-only and are never
  automatically resubmitted.
- Added canonical post-state verification and promotes only when chain authority,
  timestamps, heartbeat count and stable vault configuration prove the intended
  rotation.
- Retains the previous key after promotion and proves the promoted key can sign an
  offline deterministic transaction. A later rotation cannot overwrite it and is
  blocked until cleanup is separately authorised.
- Removed the destroy-first migration implementation and startup wallet prompt.
- Added disposable local-validator coverage for candidate funding, dual signing,
  candidate transaction ID, rotation state, old/new agent authorization, restart
  slot resolution, failure retention and exact-deadline rejection.

Exit: PASS. The official app now has application/transaction-level candidate
possession proof and crash-safe key continuity. The program still permits an
owner-only rotation from another client; protocol-enforced new-agent proof would
require a separately gated program/IDL upgrade. No live action occurred.

### Work Package 8: CANCELLED — side-by-side Android signing-identity migration

Implemented as `55a4a43` and reverted by the owner as `daf594e`. The resulting tree
is byte-identical to the accepted WP 4.7 tree.

It was cancelled on product grounds, not on implementation quality. The package had
begun introducing a second Android identity — a distinct package name, a second EAS
project, a second Firebase Android client, a new signing identity and a legacy
bridge app installed alongside the current one. DMV is one app
(`com.romulusol.deadmansvault`), the live vault is devnet, and a second installable
product is not a cost the current problem justifies.

None of the following is to be pursued: `com.palatinearc.dmv`; a second DMV app; a
second EAS project; a second Firebase Android client; side-by-side installation; a
legacy bridge; a signing-migration ceremony. A prospective WP 4.9 built on the same
direction produced nothing and is cancelled with it.

The underlying constraint remains real and is recorded in `DECISIONS.md`: a
differently signed APK cannot read the current app's Keystore-backed SecureStore.
WP 4.7 already delivers the primitive any future answer would build on (candidate
slot → deliberate funding → owner-signed rotation → chain-verified promotion → old
key retained). Should signing identity ever need to change, that is a new,
separately gated piece of work starting from the WP 4.7 primitive — not a
resumption of this package.

Exit: cancelled. Phase 4 ends at WP 4.7; the sequence continues at Work Package 9.

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

No program change is necessary for authoritative app ordering, durable
reconciliation, explicit key-state detection, fee-state handling or the selected
official-app rotation flow. The existing `rotate_agent` accepts a generated
replacement pubkey; a separately funded candidate can be the rotation transaction
fee payer and transaction-ID signer while the owner remains the instruction signer.
Candidate funding and rotation are intentionally separate deliberate
transactions.

A program change remains desirable only if candidate possession must be enforced
against every possible client rather than by the official app transaction. Adding
`new_agent: Signer`, an old/new overlap, delayed acceptance or an on-chain
idempotency identifier requires a separate program-upgrade design, IDL update,
compatibility review, tests and explicit deployment authorization.

WP 4.7 compatibility was proven against the repository program binary on a
disposable localhost validator. The deployed devnet program was not queried or
mutated. Work Package 10 remains the separately authorized disposable-devnet
canary gate.
