# Android Signing-Identity Migration

## Scope and non-goals

This document defines the source architecture for a devnet-only,
side-by-side Android migration. It does not authorise an APK/AAB, EAS or
Firebase provisioning, certificate creation, Seeker installation, live
rotation, live heartbeat, notification mutation, bridge removal or mainnet.

No agent secret crosses application boundaries. The applications coordinate
only through canonical Solana state, public keys, transaction signatures,
explicit owner authorisation and deliberate user actions.

## Identities

### Current legacy installation

- Android package: `com.romulusol.deadmansvault`
- Source version: `1.13.21`
- Source version code: `107`
- Expo slug: `dead-mans-vault`
- Legacy EAS project: `b1221e75-1816-4ff6-80bf-8f15f31b27d9`
- Current ignored generated Android project: derived build state, not tracked
- Current ignored local certificate SHA-256 fingerprint:
  `FA:C6:17:45:DC:09:03:78:6F:B9:ED:E6:2A:96:2B:39:9F:73:48:F0:BB:6F:89:9B:83:32:66:75:91:03:3B:9C`

The fingerprint is public certificate evidence only. No signing key,
keystore contents or password was inspected or recorded.

### Identity A: private legacy bridge

The bridge keeps package `com.romulusol.deadmansvault` so an update signed by
the historical certificate retains access to the existing package-specific
SecureStore and agent key. It:

- requires a version code greater than `107`;
- remains devnet and internal distribution only;
- uses the legacy EAS project and a Firebase client matching the legacy
  package;
- is named `DMV Legacy Bridge`;
- uses scheme `dmv-legacy-bridge`;
- has Android backup disabled;
- displays a permanent private-bridge/rollback banner;
- retains heartbeat and WP 4.4/WP 4.7 reconciliation capability;
- is blocked by agent mismatch after successor authority is installed;
- keeps its old key for deliberate rollback.

The bridge is not the permanent public application and must never be publicly
distributed.

### Identity B: successor

The successor requires externally provisioned values:

- `DMV_SUCCESSOR_ANDROID_PACKAGE`;
- `DMV_SUCCESSOR_EAS_PROJECT_ID`;
- `DMV_SUCCESSOR_GOOGLE_SERVICES_FILE`;
- `DMV_SUCCESSOR_URI_SCHEME`;
- successor version and version code;
- a newly controlled certificate fingerprint at the artifact gate.

There is no package default. The package must be a valid Android application
ID and differ from the legacy package. Controlled releases reject obvious
temporary suffixes. The test-only fixture
`com.example.dmv.successor.test` is accepted only with
`DMV_BUILD_MODE=test`.

The permanent package, EAS project, Firebase Android app and signing
certificate are manual provisioning decisions. None was created in WP 4.8.

The successor has a distinct package, EAS project, Firebase Android client,
update channel/runtime identity, URI scheme, display name, notification
channel labels and package-specific SecureStore. It starts with empty key
storage and identifies that expected state as
`incoming_migration_available`, not key corruption.

## Certificate, package and update boundaries

The historical certificate may sign only the legacy package. The successor
certificate may sign only the successor package. Certificate fingerprint,
not subject name, is authoritative.

The identities may not reuse:

- an Android package;
- an EAS project;
- a Firebase Android client;
- an update channel/runtime identity;
- a URI scheme;
- Android signing credentials.

Both Phase 4 EAS profiles are internal devnet APK profiles reserved for a
later controlled rehearsal. Dynamic configuration rejects unknown variants
and every non-devnet cluster. There is no active production/mainnet EAS
profile.

## Firebase and notification isolation

`app.config.ts` reads the selected `google-services.json` during configuration
and validates only its Android package metadata. A missing, malformed or
cross-package file fails closed. Firebase files remain ignored and
uncommitted.

Notification registration is independent of heartbeat authority. The
successor does not request a device token until a separate successor heartbeat
has been proven. It then presents a deliberate choice to register or defer.
Registration remains owner-signed; there is no shared secret, legacy-token
copy, automatic registration or assumption that rotation moved a server
record. The legacy registration may remain until the successor decision.
Permissionless execution does not depend on notifications.

## SecureStore and cross-app isolation

Android package sandboxing supplies independent SecureStore namespaces. No
shared UID, shared filesystem, content provider, exported service/receiver,
backup restore, clipboard, QR code, file, deep link or network endpoint
transfers a secret.

Deep links carry navigation only and use variant-specific schemes. Public keys
and transaction signatures are not secret key material.

## Migration state machine

The structured SQLite progress record uses:

```text
not_started
→ legacy_authority_verified
→ candidate_secured
→ candidate_funding_required
→ candidate_funding_pending | candidate_funded
→ rotation_pending | rotation_confirmation_unknown
→ successor_authorised
→ successor_heartbeat_required
→ successor_heartbeat_pending | successor_heartbeat_confirmed
→ notification_decision_required
→ notification_registered | notification_declined
→ bridge_retention
→ migration_ready_for_cleanup
```

`recovery_required` and `invalid_local_record` are fail-closed integrity
states. The journal stores devnet identity, public keys, signatures, heartbeat
counts as decimal strings, verified deadline, notification decision, safe
error codes and timestamps. It never stores a key, signed/raw transaction,
wallet token, Firebase/notification token, keystore or credential.

## Exact authority-transfer sequence

1. User deliberately connects the owner wallet in the successor.
2. Canonical active/unexecuted vault, heartbeat and fresh deadline are
   verified.
3. The on-chain legacy agent public key is recorded; its secret is neither
   required nor available.
4. Empty successor active storage and the absence of unresolved heartbeat,
   funding and rotation operations are verified.
5. User deliberately creates a candidate; it is securely stored and read
   back.
6. User deliberately funds that exact candidate using the WP 4.6 reserve
   primitive. Funding is not liveness and does not rotate.
7. The exact WP 4.7 rotation uses the candidate as payer/transaction-ID
   signer and the owner as instruction signer.
8. Both signatures and exact transaction are validated; PREPARED is durable
   before the single send.
9. Ambiguity is reconciled read-only without resend.
10. Canonical post-state must authorise the candidate before it is promoted
    from candidate to active in the successor SecureStore.
11. A fresh authoritative deadline is fetched.
12. User deliberately submits a separate successor-agent heartbeat.
13. Confirmation and canonical post-state must prove
    `post.totalHeartbeats > preRotation.totalHeartbeats`.
14. Fee reserve is rechecked and a fresh healthy deadline is fetched.
15. The user deliberately registers successor notifications or explicitly
    declines with a warning.
16. The bridge-retention period begins.

The successor proves possession of the replacement agent and obtains explicit
owner authority to replace the previous on-chain agent. It does not prove
possession of the previous agent. Ordinary same-installation WP 4.7 rotation
continues to require the active local key match.

Rotation resets the heartbeat timestamp but does not increment the heartbeat
count, so rotation alone never completes migration.

## Rollback

The retained bridge key enables a deliberate emergency
`reauthorise_this_installation` action:

```text
verify successor is current on-chain agent
→ load retained bridge key
→ deliberately fund bridge key if necessary
→ bridge key signs as replacement payer
→ owner signs rotate_agent
→ journal before one send
→ reconcile without resend
→ verify canonical agent is the bridge key
```

Rollback needs no successor private key and never runs automatically. Ordinary
bridge heartbeat remains blocked while the successor is authorised.

## Completion and removal gate

The UI may not claim the bridge is safe to remove until evidence proves every
condition:

1. packages are distinct;
2. successor certificate fingerprint is recorded;
3. successor candidate is on-chain;
4. successor key resolves after restart;
5. separate successor heartbeat is confirmed;
6. heartbeat count advanced after rotation;
7. fresh deadline is healthy;
8. fee reserve is ready or explicitly acknowledged;
9. no unresolved heartbeat exists;
10. no unresolved rotation exists;
11. no unresolved candidate funding exists;
12. notifications are registered or explicitly declined;
13. bridge remains installed;
14. disposable rollback was validated;
15. migration evidence was captured.

Even when all conditions pass, uninstall is a separate explicit gate.

## Artifact verification gate

The future command interface is:

```text
node scripts/verify-android-artifact.mjs \
  --apk <path> \
  --package <expected-package> \
  --version-code <expected-code> \
  --fingerprint <expected-sha256> \
  --variant legacy_bridge|successor
```

It verifies package, version code, SHA-256 certificate fingerprint,
non-debuggable release state, `allowBackup=false`, embedded devnet variant,
Firebase package consistency and absence of identity mixing. Tests use
synthetic analyzer evidence; WP 4.8 created no artifact.

## Explicitly rejected designs

- signing `com.romulusol.deadmansvault` with a new certificate;
- uninstalling or clearing the old app first;
- exporting/importing or copying the agent key;
- shared Android UID/storage or cloud/Android backup;
- SecureStore file copying;
- secret clipboard, QR, deep-link, file or network handoff;
- owner-only rotation to an unproven key;
- treating rotation as heartbeat proof;
- automatic candidate generation, funding, wallet prompt, rotation, heartbeat
  or notification registration;
- removing the bridge immediately after rotation.

## Deferred cleanup

A later explicit gate must choose the rollback-window duration and audit:
successor restart/history, notification migration, exact old-agent SOL refund
fee, refund confirmation/reconciliation, key deletion and final bridge
uninstall. The current hardcoded refund reserve is not accepted without that
separate audit.
