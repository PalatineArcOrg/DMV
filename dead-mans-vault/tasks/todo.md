# FCM Push Notifications (killed-app delivery)

Goal: deliver escalation notifications even when the app is fully closed/killed,
which local scheduled notifications cannot do reliably on Android. Use FCM +
a lightweight chain-watching server.

## Architecture
- **Firebase** (user-created): `google-services.json` (app) + service-account key (server).
- **App**: fetch native FCM device token, register `{owner, vault, deviceToken, stage1/2/3}`
  with the notify server on setup/heartbeat; deregister on revoke.
- **Notify server** (VPS, systemd + Caddy, SQLite): polls devnet for each vault's
  `HeartbeatRecord.last_heartbeat` + `VaultConfig` (interval/grace/active/executed),
  computes escalation stage, sends FCM push on stage transitions (+ throttled recurring).

## Build checklist
- [ ] notify-server scaffold (package.json, .env.example)
- [ ] db.js — SQLite registrations store
- [ ] solana.js — read + parse VaultConfig & HeartbeatRecord (layouts mirrored from app)
- [ ] escalation.js — stage computation (mirror EscalationService.calculateStage)
- [ ] fcm.js — FCM v1 sender (service-account OAuth)
- [ ] poller.js — periodic check + send + dedup per stage
- [ ] server.js — Express /register /deregister /health
- [ ] App: getDevicePushTokenAsync + register/deregister calls
- [ ] app.json: google-services.json + expo-notifications FCM config
- [ ] systemd unit + Caddy route (deploy)
- [ ] Integration test once Firebase files arrive

## On-chain layouts (for server deserialization)
HeartbeatRecord: [8 disc][32 vault][8 last_heartbeat i64 le][1 last_method][8 total u64][1 bump]
VaultConfig: [8 disc][32 owner][32 agent][8 interval i64][8 grace i64][4 benCount]
  [benCount * (32 wallet + 2 shareBps + 1 hasAssets)][1 executed][1 active]
  [8 createdAt][8 updatedAt][1 bump][1 isMutable]
