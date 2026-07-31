# Decisions

## Heartbeat authority correction

The app already submits an agent-signed on-chain `record_heartbeat` transaction.

The problem is ordering and reconciliation, not absence of an on-chain heartbeat.

Local SQLite currently updates before the chain transaction is attempted, so Phase 4 must determine how to make local/UI success follow authoritative on-chain confirmation.

Status: Confirmed by source inspection.

## Missing-key behavior correction

The ordinary connected-wallet dashboard path does not silently skip when the agent
key is absent. `KeyManager.getKeypair` throws, and the dashboard sets a generic
onchain-heartbeat warning. The remaining defect is that this warning is not typed or
durable and is displayed only after local heartbeat and escalation success effects
have already occurred.

Status: Confirmed by source inspection.

## Phase 4 implementation base

The initial checkout was a clean detached HEAD at
`54101af2f8e9affa9af76399abd4e46a80fce0eb`, five commits beyond the common
ancestor while `origin/devnet` had seven different commits beyond it. The relevant
heartbeat, key, transaction, migration and program paths were unchanged, but Phase 4
coordination was moved to the normal branch `phase4-transactional-heartbeat` based
exactly on `origin/devnet` at
`cd0264bb209c0bdc2cf4a576b48ce7d6372c69aa`.

Status: Coordination baseline accepted. WP 4.1 was explicitly authorized and is
complete; later work packages remain separately gated.

## Program compatibility

No Solana program change is selected for Phase 4. Authoritative ordering, durable
signature reconciliation, explicit local/onchain agent comparison, fee-state
handling and staged owner-signed rotation can be designed against the existing
`record_heartbeat` and `rotate_agent` interfaces.

Requiring a new-agent signature, an overlap window, delayed acceptance or an
onchain idempotency field would be a separate program change. It must not be
implemented, deployed or assumed available without an explicit program-upgrade
gate.

Status: Provisional architecture decision for user review. The deployed devnet
program was not queried in this no-live-action gate.

## Signing-identity migration safety

A future Android signing-certificate migration must use side-by-side identities and
staged key material. The existing key and app remain intact until an owner-signed
rotation is confirmed, the new agent is funded and the new key proves it can submit
a heartbeat. The current destroy-first `MigrationService.executeRotation` sequence
is not an acceptable continuity mechanism.

No APK build, install, uninstall, app-data clear or signing-identity change is
authorized by this decision.

Status: Design constraint accepted for Phase 4 planning; implementation not started.

## WP 4.1 characterization boundary

WP 4.1 preserves the existing unsafe ordering only to create a test boundary.
It is not the desired Phase 4 behaviour.
The next work package will introduce explicit agent readiness before changing
authoritative heartbeat ordering.

The coordinator result distinguishes confirmed onchain, missing-agent,
onchain-failed and local-failed outcomes, but Dashboard behavior remains unchanged.
No `confirmation_unknown` state was added because the current transaction API does
not expose that distinction at the coordinator boundary.

Concurrent calls remain possible and are now characterized rather than locked.
The current resolved-`value.err` confirmation defect and destroy-first migration
sequence are likewise preserved only as explicitly named current-behavior tests.

Status: Accepted for WP 4.1 implementation; not a security invariant.

## WP 4.2 readiness boundary

WP 4.2 makes agent capability explicit and blocks clearly invalid heartbeat
attempts before local success mutation.

It does not yet make local state authoritative-safe after a valid readiness
check. A ready attempt can still update local liveness before the on-chain
transaction is conclusively confirmed.

WP 4.3 must correct confirmation integrity and authoritative success ordering.

The readiness decision uses fresh canonical vault and heartbeat account reads,
validated through the existing hardened parser boundary, followed by one
authenticated device-key load and an exact comparison with the onchain agent.
Neither cached Zustand vault data, local SQLite heartbeat state nor notification
registration is accepted as readiness evidence.

The exact checked in-memory keypair passes directly from readiness to the
coordinator transaction call. It is not serialized, logged, persisted or placed in
React, Zustand or SQLite state.

An unexpected device-key authentication failure is reported as
`agent_unavailable`, distinct from the exact missing-key state. RPC failures are
reported as `rpc_unavailable` and never interpreted as key loss.

The coordinator now has a per-instance single-flight guard. A concurrent tap
returns `heartbeat_in_flight`, performs no second readiness check and is not queued.
The guard is released in `finally`.

WP 4.2 preserves the existing unsafe local-first ordering after a `ready` result
only to keep authoritative-ordering and confirmation-integrity changes within the
separately reviewed WP 4.3 boundary. This is not the desired Phase 4 behavior.

Agent fee and balance readiness are explicitly deferred. Insufficient funds can
still appear as `on_chain_failed` until the fee-state work package.

Status: Implemented and covered by offline tests. No live RPC, program, IDL,
rotation, migration, Android signing or notification-registration action was
performed.

## WP 4.3 authoritative confirmation boundary

WP 4.3 makes a heartbeat locally successful only after the agent-signed
transaction is conclusively confirmed and the canonical HeartbeatRecord is
verified to have advanced.

Local history, escalation reset, countdown reset and success notifications now
follow confirmed on-chain truth.

A submitted signature whose confirmation or post-state cannot be established is
not treated as failure or success and is never automatically resubmitted.

Durable persistence and restart reconciliation of those ambiguous signatures is
deferred to WP 4.4.

Confirmation requires a structurally valid response with `value.err === null`.
A non-null `value.err` is a conclusive transaction failure. A thrown confirmation
or malformed response is `confirmation_unknown`, preserving the submitted
signature.

Confirmation alone is insufficient for local success. The canonical,
program-owned heartbeat account must parse safely, retain its canonical vault and
bump, match the submitted method, not regress in timestamp and have a strictly
higher heartbeat count than the verified readiness snapshot.

The verified Solana timestamp and confirmed signature are written into the
existing heartbeat-history schema. Notification due time derives from that
timestamp plus the verified vault heartbeat interval.

Verified chain success wins over local cache failure. A SQLite/Zustand sync
failure returns `confirmed_on_chain` with `localSync: failed`, resets in-memory
escalation from chain truth, publishes the confirmed transaction and presents a
non-fatal cache warning.

Status: Implemented and covered by offline tests. No live RPC, resend, durable
pending-attempt persistence, program, IDL, rotation, migration, Android signing or
notification-registration change was performed.

## WP 4.4 durable heartbeat operation boundary

WP 4.4 persists a signed heartbeat operation before RPC submission using the
locally derived transaction signature.

Once sendRawTransaction has been invoked, any inconclusive result is treated as
potentially submitted and is reconciled read-only. It is never automatically
resubmitted.

A new heartbeat is blocked while an unresolved operation exists for the same
cluster/program/owner/vault identity.

Restart reconciliation uses transaction status, blockhash expiry and canonical
HeartbeatRecord state to converge to confirmed, failed, expired-not-landed or
chain-advanced-unattributed without inventing transaction success.

The app's installed legacy web3 `Transaction` exposes the first payer signature
after signing. Production extraction locates the exact agent payer entry, requires
it to equal `Transaction.signature`, and encodes those 64 public signature bytes
with the repository's existing `bs58` dependency. Serialization is completed
before the durable callback, then PREPARED is committed before the sole
`sendRawTransaction` call. Neither serialized bytes nor key material is persisted.

`confirmed_local_sync_pending` remains durable and is retried on focus, but it is
not a submission-blocking state because the chain outcome is already known. Local
confirmed-history repair is idempotent by signature.

When an expired signature is absent from transaction history but canonical chain
state advanced, the app updates a separate authoritative cache without attributing
that advancement to the unresolved signature. It never stores or displays the
signature as a confirmed heartbeat.

Restart reconciliation sends no heartbeat-confirmed OS notification. This avoids
stale or duplicate notifications; immediate same-session verified success retains
the WP 4.3 notification.

Terminal journal retention is bounded to the ten newest records per identity.
Only terminal records are pruned; unresolved evidence is never pruned because RPC
is unavailable or merely because it is old.

Status: Implemented and covered by offline tests. No live RPC, automatic resend,
wallet prompt, agent signing during reconciliation, program/IDL, rotation,
migration, Android signing or notification-registration change was performed.

## WP 4.5 authoritative deadline boundary

WP 4.5 makes canonical on-chain vault and heartbeat accounts, evaluated against
a fresh Solana chain-time observation, authoritative for deadline and
escalation state.

Local history and authoritative cache remain useful for diagnostics and repair,
but cannot independently reset liveness, advance escalation or start execution.

Monotonic projection is allowed only for bounded UI display between verified
chain observations. Reaching the final deadline requires a fresh chain
verification before the mobile app may invoke its permissionless execution
crank.

Stage 1–3 pushes remain notify-server-only. No local warning fallback exists.

The production chain-time adapter reads a confirmed slot and its block time,
then pins both canonical account reads to at least that slot with
`minContextSlot`. This prevents an older heartbeat record from being combined
with a newer time observation for the mobile Stage 4 decision.

The UI freshness window is 30 seconds and uses only monotonic elapsed time.
Projection may display stages 0–3 while fresh. Crossing the final deadline,
monotonic regression, expiry of the freshness window or any unavailable/invalid
chain time causes a fresh read or a stale/unknown state; it never starts
execution.

Stage subdivisions are deterministic and shared between vault creation,
deadline evaluation and deliberate notify-server registration. Explicit demo
mode uses 30 seconds per stage. Build/development mode alone does not alter
timing. A positive safe stage sum must exactly equal the canonical vault grace
period or mobile escalation inference fails closed.

Status: Implemented and covered by offline tests. No live RPC, local warning
fallback, notification registration mutation, heartbeat submission, execution
submission, program/IDL, keeper/notify-server rule, rotation, migration, Android
signing or deployment action was performed.

## WP 4.6 agent fee-readiness boundary

WP 4.6 checks the authorised agent’s balance against the exact fee of the
heartbeat transaction being prepared.

Only verified evidence that balance is below the exact transaction fee blocks
submission. A low recommended reserve produces a warning but does not block a
currently affordable heartbeat.

Failure of the auxiliary fee or balance check does not prove insufficient
funds and therefore does not manufacture a false death condition. A deliberate
heartbeat may continue through the existing signed, journalled and
post-state-verified path.

Agent top-up is a separate explicit owner-signed transfer to the canonical
on-chain agent. It is never hidden inside a heartbeat and never counts as
liveness.

The exact heartbeat transaction is constructed once with the selected priority
price, 80,000-CU limit, agent payer and one confirmed blockhash. Its compiled
message is passed to `getFeeForMessage`; the context slot returned by that RPC
is the minimum accepted context for `getBalanceAndContext(agent)`. The same
transaction and blockhash then enter agent signing, durable PREPARED persistence
and the sole send.

The existing activation target is authoritative for product policy:
`5,000,000` lamports (`0.005 SOL`). It is a recommended reserve, not an on-chain
minimum. `balance < exactFee` is the only verified-insufficiency block.

Top-up reuses the full WP 4.2 readiness boundary immediately before constructing
the transfer. It can target only the verified `vault.agentPubkey`, transfers the
integer-lamport difference to the reserve, uses the owner as fee payer, asks for
one explicit wallet signature, sends once and inspects confirmation `value.err`.
It never updates heartbeat history, deadline/escalation state, notification
registration or the heartbeat-operation journal.

Status: Implemented and covered by offline tests. No live RPC, heartbeat,
automatic funding/retry, program/IDL, rotation, migration, Android signing or
deployment action was performed.
