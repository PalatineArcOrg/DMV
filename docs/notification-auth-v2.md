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

# Route activation, auth modes + abuse controls (WP3)

Status: **server integration, not deployed.** WP3 wires the WP1 contract + WP2
primitives into the notify-server routes with a controlled legacy transition. It
does **not** activate the mobile app's signed flow, and **no devnet deployment has
occurred**. Mainnet remains unauthorized.

## Authentication modes (`REGISTRATION_AUTH_MODE`)

`legacy | dual | signed` — validated fail-closed at boot (`assertRegistrationAuthConfig`):

- A **missing** mode is fatal outside `NODE_ENV=development` (dev defaults to `legacy`); an **unknown** value is always fatal (no trim/lowercase/alias).
- `legacy` is permitted **only** in explicit development.
- `mainnet-beta` **requires** `signed`.
- `legacy`/`dual` require a non-empty `REGISTER_SECRET`; `signed` requires none.
- Every non-dev deploy requires a distinct `ADMIN_SECRET` (≠ `REGISTER_SECRET`).
- The trusted V2 context (cluster, program id, audience) must be complete; the audience is the fixed approved constant, never env-controlled.

## Signed-attempt classification + downgrade resistance

A request is a **signed attempt** if its body has ANY own V2-envelope field
(`version, cluster, programId, audience, action, revision, timestamp, nonce,
signature`). A present-but-empty `signature`, or a missing `signature` alongside
other V2 fields, is still a signed attempt. A signed attempt is always handled by
the V2 path and **never falls back to the legacy secret path** — possession of
`REGISTER_SECRET` cannot rescue a failed signed request, and a V1 signed payload
(no `version`/context) is a signed attempt that fails V2 (`invalid_request`) rather
than activating or downgrading. `ADMIN_SECRET` authenticates neither registration path.

## Route behaviour by mode

| | legacy (dev) | dual | signed |
|---|---|---|---|
| signed `/register` | `signed_not_enabled` (409) | V2 auth + signed txn | V2 auth + signed txn |
| pure legacy `/register` | secret + ownership proof → `{ok:true}` | secret + ownership proof → `{ok:true}` | `signed_required` (409) |
| signed `/deregister` | `signed_not_enabled` | V2 auth (incl. post-close stored-owner path) | V2 auth |
| pure legacy `/deregister` | specific-vault OR owner-wide | specific-vault only (owner-wide **disabled**) | `signed_required` |

Signed `/register` returns `{ok:true, result:'created'|'updated', revision}` (201/200);
signed `/deregister` returns `{ok:true, removed:0|1}` (200). The legacy path preserves
the old `{ok:true}` response for app compatibility.

## Signed-row stickiness

Once a row is signed (`auth_version >= 2` or `migration_status = 'signed'`), the
**legacy** path can neither update, delete, nor downgrade it — it returns
`signed_authorization_required` (409). Only an owner-signed request may change it.
The **internal poller** delete (`deleteRegistration`) still removes any row
(inactive/executed/missing) regardless of auth version.

## Admin-secret separation

`/poll-now`, `/execute-now`, `/debug/push` are gated by `ADMIN_SECRET` via the
dedicated `x-dmv-admin-secret` header (constant-time; generic 401). The legacy
`x-dmv-secret` is never accepted for admin routes, and signed registration routes
require neither secret. `/debug/push` is mounted only in development. A per-IP
admin-attempt limit bounds secret-guessing.

## Result → HTTP mapping

`invalid_request`→400; `invalid_signature`/`stale_timestamp`/`context_mismatch`/`nonce_reused`→401;
`ownership_failed`→403; `signed_not_enabled`/`signed_required`/`signed_authorization_required`/`stale_revision`/`owner_conflict`→409;
`rate_limited`→429; `dependency_unavailable`→502; `database_error`→503. Responses carry a
generic message + a machine-readable `code`; no signature reason, stored owner, DB
text, RPC URL, nonce, token, or hash is ever exposed.

## Write-endpoint rate limits

A dedicated bounded limiter (separate from the read/RPC limiters): **30 req/IP/60s**
(charged before signature/RPC/DB — a malformed body still costs IP), and facet
windows **10/owner/10min, 10/vault/10min, 6/register-token-hash/10min** (charged
before RPC/DB). Legacy and signed attempts share the owner/vault/token buckets; the
token bucket is keyed by SHA-256, never plaintext; deregister has no token facet.
Exceedance → 429 with `Retry-After` (remaining whole seconds); the exceeded facet is
not revealed. Admin routes get an independent **20/IP/60s** limit. `/health` gains
only `registrationAuthMode` — no secret is ever exposed.

### WP3 review resolutions

An independent security review of the WP3 diff found no CRITICAL/HIGH/MEDIUM issues.
Resolved / accepted:

- **Signed-row stickiness holds uniformly.** Even the DEV-only `legacy`-mode
  owner-wide deregistration now routes through `deleteLegacyRegistrationsByOwner`,
  which deletes only the owner's NON-signed rows — a signed registration can never
  be force-removed via any external legacy path (the internal poller still removes
  any row for lifecycle cleanup).
- **Accepted (no change):** a `REGISTER_SECRET` holder can distinguish signed vs
  legacy vaults via the `signed_authorization_required` (409) on legacy deregister —
  it leaks only auth status, not owner/token, and the shared secret is already
  acknowledged as weak auth. The write routes rely on the in-handler per-IP limiter
  (30/60s) plus Caddy/Cloudflare as the outer bound (malformed JSON is rejected by
  the body parser before the handler), matching the pre-WP3 posture.

# Dual-mode transition controls + observability (WP4)

Status: **server-only.** WP4 adds a time-bounded legacy-acceptance window for
production `dual` mode, privacy-safe migration observability, and an admin-only
status endpoint. No app change, no auth-mode auto-switch, no devnet deployment.
Mainnet remains NO-GO.

## `REGISTRATION_LEGACY_ACCEPT_UNTIL`

An absolute Unix timestamp (whole seconds) governing ONLY pure legacy
register/deregister in `dual` mode. It never affects signed requests, admin routes,
the internal poller, the executor, notification delivery, or public reads.

- Format: a **canonical positive integer** — no fraction, exponent, sign, leading
  zero, whitespace, or date string (rejected fail-closed at boot).
- `dual`: **required** (dev too). A future cutoff must be **≤ 30 days** ahead; an
  already-expired cutoff boots fine with legacy writes disabled (effective
  signed-only). `signed` / (dev) `legacy`: the variable must be **absent**.

## Effective mode + one-way latch

A clock-injected controller derives `{ configuredMode, effectiveMode,
legacyAccepting, legacyAcceptUntil, legacyWindowExpired, secondsUntilLegacyClose }`.
Legacy is accepted only while `serverNow < legacyAcceptUntil`; at
`serverNow === legacyAcceptUntil` the window is **expired**. A **one-way in-process
latch** means once expiry is observed, legacy stays closed for the life of the
process — a backward clock jump cannot reopen it. A restart re-evaluates the
absolute cutoff and remains expired if real time is beyond it. The latch is never
persisted to the registration DB.

## Legacy request at expiry

In `dual` after the window closes, a pure legacy register/deregister returns:

```json
{ "error": "legacy registration window expired", "code": "legacy_window_expired" }
```

with HTTP **410 Gone** — evaluated **before** `REGISTER_SECRET`, the ownership RPC,
and any DB read/mutation/nonce. So a valid secret cannot bypass expiry, a wrong
secret is no oracle, and no state changes. Signed requests bypass the window
entirely and keep working. Dev `legacy` mode is not governed by the window. The IP
write-rate limit still precedes the transition check.

## Aggregate migration counts

A single SQL aggregate (no row data, no mutation): `signed` = `auth_version>=2 AND
migration_status='signed'`; `legacy` = `auth_version<2 AND migration_status='legacy'`;
`anomalous` = any row in neither consistent state. `signedPercent` is computed in
the response layer only (`total===0 ? 100 : signed/total*100`), never stored.

## Metrics (process-local, fixed cardinality)

An in-memory collector tracks fixed register/deregister/security counters, a
**fixed** failure-code allowlist (+ `other` for anything unknown — a metric key is
never derived from an error string), and last-event timestamps. Methods are
synchronous + no-throw (a metrics failure never alters route behaviour). Counters
**reset on process restart** (not persisted).

## Admin status endpoint

`GET /admin/registration-auth/status` — behind the `ADMIN_SECRET` gate
(`x-dmv-admin-secret`) + the admin IP limiter; `x-dmv-secret` is never accepted. It
returns the transition state, aggregate counts + `signedPercent`, a fixed metrics
snapshot, and cutover readiness — and performs **no mutation** and exposes **no**
row/owner/vault/token/hash/nonce/signature/secret/RPC-URL. `readyForSignedMode` is
true only when `legacy === 0 && anomalous === 0`; the fixed blockers are
`legacy_registrations_remaining` / `anomalous_registration_metadata`. A still-open
dual window is not itself a blocker once all rows are signed.

## Public health

Public `/health` adds only `registrationAuthEffectiveMode`,
`legacyRegistrationAccepting`, and `legacyRegistrationAcceptUntil` — no counts,
metrics, blockers, or secrets. **Window expiry is an intended security transition,
not a health degradation:** readiness status and HTTP code are unaffected.
