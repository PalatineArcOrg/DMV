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
