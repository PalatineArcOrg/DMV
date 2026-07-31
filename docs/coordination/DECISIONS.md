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

Status: Coordination baseline established; user approval is still required before
implementation.

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
