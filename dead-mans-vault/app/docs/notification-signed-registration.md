# Signed notification registration (WP5)

Owner-signed (V2) push-notification registration is a **deliberate user action**, not a
background process.

## Flow
1. In **Settings → Notifications**, the owner taps **Enable notifications (signed)**
   (or **Update notification registration** once enabled).
2. `NotificationRegistrationService.attemptSignedRegistration` validates locally
   (cluster = `devnet`, program ID = the configured DMV program, canonical owner/vault,
   safe stage integers, device token available, secure RNG), then:
   - allocates + **persists a monotonic revision** high-watermark,
   - builds the exact WP1 V2 message and requests **one owner wallet signature** (MWA `signMessage`),
   - sends **one** signed HTTPS `POST /register` (no shared secret),
   - persists a local success record **only** after HTTP 201/200.
3. The UI shows: not enabled → registering → enabled / failed.

## No background registration
Heartbeat no longer registers. `useHeartbeat` only **reads** the local persisted
registration record to reflect whether server-driven escalation is active — it acquires no
device token, requests no signature, and makes no `/register` call. Nothing signs on app
start, component mount, a timer, a token listener, or a background heartbeat.

## Revision high-watermark
A persistent value keyed by `cluster + programId + owner + vault`. Next revision is
`max(Date.now()ms, storedHighWatermark + 1)` — strictly increasing even within the same
millisecond, backward-clock-safe, and persisted **before** the request. A corrupt stored
value fails closed. On `stale_revision` the watermark is preserved and a fresh **deliberate**
retry (new revision/timestamp/nonce/signature) is required — there is no automatic retry loop.
**Residual limitation:** a device with a badly wrong far-future clock could set a very high
revision and need recovery handling later.

## Wallet signature purpose
The signature authorizes escalation-notification delivery to this device. **It does not move
funds.** Wallet cancellation/rejection leaves registration unchanged and **never** falls back
to the legacy shared-secret path.

## No fallback / privacy
A failed or malformed signed attempt (wallet cancel, bad signature, server rejection, timeout,
network error) never downgrades to the unsigned legacy path. The stored success record holds
only non-sensitive metadata (owner, vault, revision, token **fingerprint**, stages, cluster,
program, timestamp) — never the plaintext token, signature, nonce, or message. Nothing logs a
token/signature/nonce/message/secret.

## Current limitations
- **Device-token rotation** and **signed deregistration** are implemented in **WP6** (see
  `notification-token-lifecycle.md`) — source-only, not built or released.
- The notify server is live on **devnet in `dual` mode**; **Fox has not been migrated** to
  signed auth; a **live end-to-end route canary is pending** an approved disposable-vault harness.
- **No app build has been released** for this flow.
- **Mainnet remains NO-GO.**
