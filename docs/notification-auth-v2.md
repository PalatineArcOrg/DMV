# Notification Auth V2 — canonical owner-signed message contract

Status: **contract definition only.** This document specifies the V2 owner-signed
message format used by DMV push-notification registration/deregistration. V2 is
**not activated** in any server route or app flow yet (that is later Phase-3
work). V1 (`DMV_NOTIFY_REGISTER_V1` / `DMV_NOTIFY_DEREGISTER_V1`) remains the
dormant/legacy format and is unchanged. **No mainnet authorization is implied by
this document. Mainnet remains NO-GO.**

Canonical implementations (kept byte-for-byte in sync):

- Server: `notify-server/src/authMessage.js` — `registerMessageV2`, `deregisterMessageV2`
- App: `dead-mans-vault/app/src/utils/notifyAuth.ts` — `registerMessageV2`, `deregisterMessageV2`
- Shared committed test vector: `test-vectors/notify-auth-v2.json` (synthetic public data)

## Why V2

V1 binds nothing about the environment: the same signed bytes are valid on any
cluster, against any server, forever. V2 closes those gaps by binding the message
to the target **cluster**, **program ID**, and a fixed **audience**, and by
carrying a signed monotonic **revision** for anti-rollback ordering.

## Message format

The message is a UTF-8 string of `key=value` lines joined by exactly one ASCII
newline (`\n`). There is **no leading and no trailing newline**. Field order is
fixed and significant (the bytes are what gets signed). `version` and `action`
are fixed by the builder and cannot be supplied by a caller.

### Register

```
DMV_NOTIFY_REGISTER_V2
version=2
cluster=<devnet|mainnet-beta>
programId=<canonical Base58 program ID>
audience=https://notify.palatinearc.com
action=register
owner=<canonical Base58 owner public key>
vault=<canonical Base58 vault public key>
deviceTokenHash=<lowercase 64-char SHA-256 hex of the device token>
stage1=<base-10 integer seconds>
stage2=<base-10 integer seconds>
stage3=<base-10 integer seconds>
revision=<base-10 positive integer>
timestamp=<base-10 Unix-seconds integer>
nonce=<canonical Base58 nonce>
```

### Deregister

```
DMV_NOTIFY_DEREGISTER_V2
version=2
cluster=<devnet|mainnet-beta>
programId=<canonical Base58 program ID>
audience=https://notify.palatinearc.com
action=deregister
owner=<canonical Base58 owner public key>
vault=<canonical Base58 vault public key>
timestamp=<base-10 Unix-seconds integer>
nonce=<canonical Base58 nonce>
```

Deregistration carries **no** device token, token hash, stages, or revision.

## Field meanings and canonicalisation

The builders **reject** malformed or noncanonical input by throwing, rather than
silently normalising.

| Field | Meaning | Canonical rule |
|---|---|---|
| `cluster` | Target Solana cluster the signature is valid for | Exactly `devnet` or `mainnet-beta`. No aliases, trimming, or case variation. |
| `programId` | DMV program the vault belongs to | Valid 32-byte Solana pubkey; Base58 round-trips to the exact input. |
| `audience` | The one notify server this registration targets | Fixed configuration constant `https://notify.palatinearc.com` — lowercase scheme+host, no path, no trailing slash. **Never a request-supplied value** (decision O-1). |
| `owner` | Vault owner wallet (the signer) | Canonical Base58 32-byte pubkey. |
| `vault` | Canonical vault PDA for `owner` | Canonical Base58 32-byte pubkey. |
| `deviceTokenHash` | `sha256(deviceToken)` | Lowercase 64-char hex. The plaintext device token is never placed in the signed message. |
| `stage1..3` | Escalation stage durations (seconds) | JS safe integer `> 0`, canonical base-10. No fractions, exponents, signs, leading zeros, `NaN`, or `Infinity`. |
| `revision` | Monotonic registration ordinal | JS safe integer `> 0`, canonical base-10. **Authoritative anti-rollback ordering** (decision O-3). |
| `timestamp` | Unix seconds at signing | JS safe integer `> 0`, canonical base-10. **Freshness/diagnostics only — never used for ordering.** |
| `nonce` | Single-use replay guard | Base58 (`[1-9A-HJ-NP-Za-km-z]`), encoded length 22–64. Generated from ≥128 bits of CSPRNG entropy. No whitespace/control/punctuation. |

## Replay and rollback protection

- **Cross-cluster / cross-server replay** is prevented by binding `cluster`,
  `programId`, and `audience` into the signed bytes. A devnet-cluster signature
  is not a valid `mainnet-beta` message, and a signature for this audience is not
  valid for a different server origin. (Enforcing that the server's configured
  cluster/programId/audience equal the request values is validator work in a
  later work package; here the values are simply part of the canonical bytes.)
- **Rollback** (replaying an older-but-valid registration to rebind a stale token
  or stages) is ordered by the signed monotonic `revision`, not by clocks.
  `timestamp` is retained for freshness windows and diagnostics only.
- **Nonce** provides single-use replay protection for an individual signed
  request.

## Signature expectation

The signature is a **detached Ed25519 signature over the exact UTF-8 bytes** of
the canonical message (no trailing newline, no re-encoding), produced by the
owner wallet via MWA `signMessage` (a plain message signature, never a
transaction payload), and transmitted Base58-encoded. Verification uses the raw
32-byte owner public key. The server helper `verifyEd25519` already implements
this check for V1 and is reused for V2.

## Nonce generation

`generateNonceV2()` (both platforms) draws 16 CSPRNG bytes (`node:crypto`
`randomBytes` on the server; the Web Crypto RNG / expo-crypto polyfill in the
app) and Base58-encodes them, re-drawing the occasional 21-char encoding so the
output always lands in the validated 22–64 range. Do not use UUIDs, counters,
timestamps, or `Math.random()` as nonces.

## Compatibility

- V1 builders and their outputs are unchanged. V1 and V2 are distinguishable by
  the first line (domain tag) and the presence of the `version=2` line.
- WP1 adds the V2 contract, the shared vector, tests, and this document only. No
  route, database, auth-mode, secret, rate-limit, app-flow, deployment, or Fox
  registration is changed.

# Server authorization + storage layer (WP2)

Status: **primitives only.** WP2 adds `notify-server/src/registerAuthV2.js`
(authorization) and `notify-server/src/registrationStore.js` (schema + atomic
transactions), each pure and dependency-injected. **No HTTP route calls them, no
auth mode exists yet, and the live schema is not migrated by WP2** — WP3 wires
these into `db.js`, the routes, and the auth modes at deploy time. V1 and the
active unsigned path are unchanged. Mainnet remains unauthorized.

## Authorization pipeline

`authorizeRegisterV2(body, deps)` / `authorizeDeregisterV2(body, deps)` run, in
order, and stop at the first failure:

1. **version + action** must be `2` / the operation's literal (else `invalid_request`).
2. **Trusted-context comparison** — `cluster`, `programId`, `audience` in the
   request must equal the injected trusted server values **exactly** (no trim /
   lowercase / coerce), and the trusted audience must equal the approved constant.
   Rejected as `context_mismatch` **before any RPC or crypto**. Context is never
   inferred from the request.
3. **Device token** (register only): a string of length 32–4096 with no whitespace
   or control characters. The plaintext token is hashed **locally**; a
   client-supplied token hash is never trusted.
4. **Freshness** — `timestamp` must be an integer (no `Number()` coercion) within
   ±600 s of server time (`stale_timestamp`). Timestamp is *not* the ordering field.
5. **Canonical field validation** — the WP1 builder is invoked as the canonical
   validator; any noncanonical pubkey/stage/revision/nonce throws → `invalid_request`.
6. **Signature** — Base58 decoding to exactly 64 bytes with a canonical round-trip,
   then detached Ed25519 verification against the exact builder bytes. An invalid
   signature stops here (`invalid_signature`) — **no nonce is claimed and no RPC
   is made**.
7. **Ownership** — the injected verifier is called **after** signature success.

The authorizer returns a normalized immutable command (no signature or message
bytes) and **never claims a nonce or mutates storage** — that is the transaction's
job. So a transient RPC failure or an invalid signature can never consume a nonce.

## Remote verification before nonce use; transient vs definitive

Registration always calls the live ownership verifier (canonical PDA + program-owned
`VaultConfig` + stored owner == signer). The verifier distinguishes a **definitive**
failure (`ownership_failed`) from a **transient** transport failure
(`dependency_unavailable`, retryable) — a transport throw is classified transient,
never a definitive 403. Because ownership is checked in the async authorizer and
the nonce is claimed only inside the later transaction, a transient failure leaves
the nonce unused.

## Deregistration after owner-close

`authorizeDeregisterV2` requires a valid owner signature, exact context binding, and
a **pure canonical-PDA check** (`vault == PDA(owner)`, no RPC). Then:

- **A stored row whose owner matches the signer** authorizes deletion **without any
  RPC** — legitimate cleanup after execution/revocation/owner-close, when the vault
  may no longer exist on-chain.
- A stored row owned by someone else fails closed (`owner_conflict`) — never delete
  another owner's row on a syntactically valid request.
- **No stored row** falls back to live ownership verification; a live match
  authorizes an idempotent removal (the transaction returns `removed=0`), a
  definitive failure is rejected, and an RPC failure is retryable — no nonce is used.

## Transaction boundary + nonce-consumption rules

`applySignedRegistration` / `applySignedDeregistration` run one synchronous SQLite
transaction that contains **both** the nonce claim and the mutation:

1. `INSERT OR IGNORE` the `(owner, nonce, usedAt)` — a reused nonce returns
   `nonce_reused` and performs **no mutation**.
2. Read the row for `vault`. A different stored owner → `owner_conflict`
   (register: never overwrite; the just-consumed nonce is **retained**).
3. Register only: `revision <= stored revision` → `stale_revision` (nonce retained).
4. Otherwise insert (`created`) or update (`updated`); deregister deletes only by
   `(vault, owner)` and returns `removed` (0/1).

Nonce consumption summary: **consumed** by a committed create/update/remove and by a
definitive signed failure (`owner_conflict`, `stale_revision`); **not consumed** by
`nonce_reused`, and **rolled back** with the mutation on any thrown DB error
(`database_error`) so the same valid nonce can be retried once the DB is healthy.
The `(owner, nonce)` primary key makes a nonce single-use even across concurrent
connections; nonces are scoped per owner.

## Revision ordering vs timestamp

`registration_revision` (signed, strictly increasing) is the sole anti-rollback
ordering authority — the highest committed revision wins regardless of arrival
order, and an equal/lower revision is rejected as stale, so a replayed older signed
request cannot restore an old token or old stages. `signed_at` is stored for
diagnostics only and is never used for ordering.

## Migration defaults + notification-state preservation

The additive migration inspects the live columns and adds only the missing ones,
never dropping/recreating a table or deleting a row:

| Column | Default (legacy rows) |
|---|---|
| `auth_version` | `1` |
| `registration_revision` | `0` |
| `migration_status` | `'legacy'` |
| `device_token_hash` | `NULL` |
| `signed_at` | `NULL` |
| `last_auth_op` | `NULL` |

Existing rows keep their plaintext `device_token` (FCM delivery needs it); no
signature or canonical message is ever stored. A signed create/update sets
`auth_version=2`, `migration_status='signed'`, and the signed fields; on an
**update** it preserves `created_at`, `last_stage`, and `last_notified_at`, so a
re-registration never resets escalation state. The unsigned upsert path is
unchanged and leaves a row `legacy`. A `used_nonces(used_at)` index backs pruning.

## Caveats + invariants WP3 must honour

These are from the WP2 adversarial review (all LOW/INFO — none touch fund safety;
notifications are a convenience layer and the on-chain switch fires regardless).

- **Nonce prune horizon ≫ freshness window.** Replay protection is the single-use
  nonce; freshness is ±600 s. `pruneNonces` must only delete rows older than the
  freshness window (in practice, hours), or a still-fresh signed request could be
  replayed after its nonce row is deleted. (Enforced by comment on `pruneNonces`;
  WP3 owns the prune schedule.)
- **Deregistration carries no `revision`.** Its replay protection is the ±600 s
  window + single-use nonce only, and a delete resets the vault's revision
  high-water mark. A captured owner-signed deregister replayed within 600 s could
  re-delete a registration the owner re-created in that window — a bounded
  self-DoS against the owner's own row, considered acceptable.
- **Trusted `expected` completeness.** The authorizer hard-checks `audience`
  against the approved constant and compares `cluster`/`programId` by strict
  request↔`expected` equality (a missing `expected` field fails closed, since the
  request value cannot equal `undefined`). WP3 should still validate `expected`
  completeness at boot as defence in depth.
- **Legacy-row owner integrity.** The `owner_conflict` guard never overwrites a
  stored row owned by a different key. A legacy row whose stored `owner` does not
  match its vault's true PDA owner would block the real owner's signed
  (re)registration (availability only). The unsigned path is ownership-proofed, so
  live rows are consistent; WP3's Fox/legacy migration must not introduce mismatched
  rows.
- **Client-side monotonic `revision`.** Strict-increase means a client that ever
  emits a too-high or duplicated revision permanently stalls its own updates. WP3's
  client must derive `revision` monotonically (revision generation is not in this
  layer).

## About the shared vector

`test-vectors/notify-auth-v2.json` is a **message-serialization** vector: it pins
the exact canonical bytes + lengths + SHA-256 of the register/deregister messages.
Its `owner` and `vault` are **independent synthetic pubkeys** — `vault` is NOT
`PDA(owner)`, because the message format does not require that (the PDA relationship
is an authorization-layer check, not a serialization property). Do **not** feed this
vector to `authorizeRegisterV2`/`authorizeDeregisterV2` as a full-path happy-path
input; it would fail the canonical-PDA / ownership checks by construction.
