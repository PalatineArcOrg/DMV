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
tombstone write fails **after** server success, the result is still success with
`localCleanupPending=true` (server truth wins) and a **durable pending marker** is persisted
(best-effort, to a distinct key). This survives an app restart: the observer's next reconcile
repairs the local tombstone (a LOCAL write only, never a second server call) and shows
`disabled`; until that local write succeeds the UI shows `local_cleanup_pending` — never a
stale `enabled`.

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
- The disposable-vault **live route canary passed** on devnet, and a **private internal APK** (from
  the reviewed source) was **manually installed on one Fox-free test device** and exercised end-to-end.
  No **public/production** WP5/WP6 release exists. The WP6.1 correction here is **source-only** — no
  new APK has been built.
- The notify server is live on **devnet in `dual` mode**; **Fox remains a legacy registration**
  (unmigrated); **no signed-only cutover** has occurred.
- **Mainnet remains NO-GO.**

## WP6.1 — post-revoke notification-state reconciliation

**The Seeker LOW finding.** During the controlled device gate, after a successful vault revoke the
app could keep showing notifications as **enabled**; if the notify-server's poller had already
removed the closed-vault registration, a later explicit Disable/Clear received `ownership_failed`
("This vault could not be verified as yours"), leaving stale local UI. WP6.1 fixes this, source-only.

**After a CONFIRMED owner-authorized revoke** (`reconcileNotificationsAfterClose`, called from the
revoke handler once the tx is confirmed) the app writes a **durable closed-vault tombstone**
(`recordVaultClosure` → key `notif_vault_closed/<cluster>/<programId>/<owner>/<vault>`) — but ONLY
when an active notification record exists for that identity. It is LOCAL-ONLY: it never signs, never
calls the server, and never touches the revision high-watermark. The tombstone holds only
non-sensitive fields (`owner`, `vault`, `cluster`, `programId`, `revokedAt`, the public `revokeSig`,
`priorRevision`, `needsServerReconcile`) — no token/fingerprint/signature/nonce/message/secret. The
existing invariant is preserved: **revoke never automatically deregisters.**

**Local state / UI.** The observer's `checkNow` treats the closed-vault tombstone with PRECEDENCE:
while the confirmed record is still present it returns `vault_closed_cleanup_pending`
("Vault closed — notification cleanup pending") — it can never resurface `enabled`/`update_required`
for a closed vault, and a token event or focus/foreground reconcile cannot change that. Once the
record is tombstoned/gone (cleanup done) the marker is cleared and the state falls to `disabled` /
`not_enabled`. This survives an app restart (the tombstone is durable); no wallet prompt and no HTTP
request happen automatically.

**Poller-wins race — explicit cleanup.** From the `vault_closed_cleanup_pending` state the only
deliberate action is **"Clear server notification registration"**, which signs **once** and sends
**one** V2 deregister. If it reaches the server first → `HTTP 200 removed=1`; if the poller already
removed the row → the server returns `ownership_failed`. In THIS narrow context — and ONLY here —
that `ownership_failed` is interpreted as `already_absent_after_close`. The strict conditions
(all required): the action is the explicit post-close cleanup (`context: 'post_close_cleanup'`); the
connected wallet matches the stored owner; the vault is the canonical PDA for that owner; a durable
closed-vault tombstone proves THIS exact vault was revoked through the app (with a real confirmed
`revokeSig` and `revokedAt`); the request used the exact signed V2 deregistration (no legacy
fallback). Under proven closure the app renders **disabled**, clears the confirmed-registration
record, clears the closed-vault marker, and **preserves the revision high-watermark** — with no
automatic second request. In **every other** case `ownership_failed` stays a hard failure (a live
vault, an owner/vault mismatch, the wrong wallet, a normal registration/deregistration, a missing or
corrupt tombstone) — it must not mask a real ownership error. Both server `removed=1` and `removed=0`
also render disabled, clear the marker, and preserve the watermark.

**Status.** Source-only. No new APK has been built. Fox has not been migrated. Mainnet remains NO-GO.
