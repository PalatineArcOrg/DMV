# Notification token lifecycle & signed deregistration (WP6)

WP6 completes the mobile lifecycle around the deliberate WP5 signed registration:
device-token rotation detection, explicit signed **update** (rotation), and explicit signed
**deregistration** (including after vault close). Every server mutation stays a **deliberate
user action with exactly one fresh signature**; only *detection* is automatic.

## Local-only automatic observation
`notificationLifecycle.ts` (`makeTokenObserver`) observes the device push token on Settings
focus, on app foreground, and via the Expo push-token change listener. It **only computes and
persists local state** — it never calls `signMessage`, `attemptSignedRegistration`,
`attemptSignedDeregistration`, `/register`, or `/deregister`. A generation counter ensures a
stale async check can neither emit nor overwrite a newer check's result.

On each check it reads the confirmed record + current token, derives the fingerprint, and
`reconcile()`s to one of: `not_enabled`, `enabled`, `update_required`, `token_unavailable`,
`owner_mismatch`, `disabled`, or `error` (fail-closed on a corrupt record). On a mismatch it
persists a **local-only pending marker** (`{ fingerprint, detectedAt, sequence, rotationRequired }`)
— idempotent (a repeated same-token event does not grow storage), newest-fingerprint-wins, and
it survives app restart.

## 128-bit token fingerprint
The stored fingerprint is the **first 32 lowercase hex chars of SHA-256(token)** (128-bit).
The plaintext token is never stored. An older **16-char** (WP5) fingerprint is treated as
needing a signed refresh: it yields `update_required` — never silently "confirmed" from the
shorter compare, and never silently "disabled".

## Explicit signed update (rotation)
Tapping **Update notification registration** reuses the reviewed WP5 coordinator
(`attemptSignedRegistration`) with a strictly-higher revision: validate owner/vault → newest
token → persist revision (before the request) → one signature over the exact WP1 V2 message →
one `POST /register` → persist the accepted revision + fingerprint on success. No secret header,
no client token-hash field, no auto-retry, no nonce/revision reuse.

### Token-change race
If the platform reports a **new** token during a signed update, server success is still
acknowledged (accepted revision preserved), but the UI becomes `update_required` again if the
accepted token no longer matches the latest observed token — a second deliberate Update is
required. The app never auto-signs or auto-submits the second token.

## Explicit signed deregistration
Tapping **Disable notifications** (after a confirmation) calls `attemptSignedDeregistration`,
which builds the exact WP1 `deregisterMessageV2` envelope (owner, vault, version 2, cluster,
programId, audience, `action=deregister`, timestamp, nonce, signature) — **no** device token,
token hash, stages, revision, or secret header — requests one signature, and sends one
`POST /deregister`. Both `removed=1` and `removed=0` are idempotent success.

### After vault close
Deregistration does **not** require a live vault account or an RPC read: the vault PDA is
derived locally from the owner, and the deployed server authorizes via its stored-owner /
canonical-PDA path. An advanced **Clear server notification registration** action can submit an
idempotent signed deregistration even with no local record (it may safely be a no-op and does
not claim a registration existed).

## Deregistration local-state semantics
On HTTP 200 (`removed` 0 or 1) the UI immediately shows **disabled**, the confirmed record is
tombstoned, and the rotation marker is cleared — but the **revision high-watermark is preserved**
(never deleted or lowered) so a later re-enable cannot reuse a lower revision. If the local
cleanup write fails **after** server success, the result is still success with
`localCleanupPending=true` (server truth wins): the UI stays disabled for the session, the app
does **not** call the server again, and only local cleanup may be retried on a later reconcile.

## No automatic mutation (safety invariants)
Nothing signs or deregisters on: app start, mount, background/foreground, wallet disconnect,
wallet account change, token acquisition failure, the token listener firing, a vault close, a
heartbeat, or a missing local record. `useHeartbeat` never signs/registers/deregisters. An
identity-scoped operation lock (`runExclusive`) makes register/update/deregister mutually
exclusive per `cluster+programId+owner+vault`, treats a repeated identical action as a no-op,
and prevents a stale completion from overwriting a newer action; unrelated identities are not
blocked. There is **no** legacy shared-secret fallback anywhere.

## Status
- Old released app builds still use the unsigned **legacy** registration (accepted during the
  bounded `dual` legacy window).
- **WP5 + WP6 source is not built, installed, or released** (no APK).
- The notify server is live on **devnet in `dual` mode**; a **live route canary is pending** an
  approved disposable-vault harness; **Fox remains a legacy registration**; **no signed-only
  cutover** has occurred.
- **Mainnet remains NO-GO.**
