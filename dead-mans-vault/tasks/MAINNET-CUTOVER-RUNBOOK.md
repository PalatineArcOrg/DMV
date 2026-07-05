# Mainnet Cutover Runbook — Dead Man's Vault

Deploy-day playbook to move DMV from devnet → **mainnet-beta**. Follow in order. Each step has a verify; each ⛔ is an abort point. Assumes the **existing program keypair is reused** (so the mainnet program ID stays `GXCu5964mvgAJDWmcMriZpzU3vDVqPzjYCM1sxCnsoEb` — **no program-ID propagation needed**). If you generate a *new* mainnet keypair instead, insert the §1.3 program-ID propagation from `MAINNET-READINESS.md` after Step 5.

Companion: `MAINNET-READINESS.md` (the why). Last updated 2026-07-05.

---

## Fill these in first

| Placeholder | What | Notes |
|---|---|---|
| `<TREASURY>` | Mainnet fee wallet | **DECIDED: new wallet, not `98x9…`.** Use a multisig (Squads). |
| `<MAINNET_RPC>` | Helius mainnet URL | `https://mainnet.helius-rpc.com/?api-key=…` (paid; public RPC will 429). |
| `<DEPLOYER>` | Deploy wallet keypair path | Funded with **~5 real SOL** (program account rent + fees). |
| `<UPGRADE_AUTH>` | Program upgrade authority | A **multisig / hardware** wallet — never a hot key. |
| `<CRANKER_MAINNET>` | notify-server + keeper cranker keypairs | Funded with a little real SOL for fees. |

`export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$HOME/.avm/bin:$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"`

---

## Pre-flight gates — ALL must be true before Step 1

- [ ] ⛔ **Security audit complete**, findings remediated, and `anchor test` re-run green (29/29 + any regression tests from the audit).
- [ ] `<TREASURY>` confirmed and control verified (send/receive test on mainnet).
- [ ] `<DEPLOYER>` funded with ~5 mainnet SOL (`solana balance <DEPLOYER> --url mainnet-beta`).
- [ ] `<MAINNET_RPC>` provisioned + smoke-tested (`getVersion`).
- [ ] Working tree clean; on a fresh cutover branch (Step 0).
- [ ] `CLOSE_EXECUTED`/economics/biometric/distribution decisions locked (§2.3–2.6 of readiness).

---

## Step 0 — Branch + tag the devnet baseline
```bash
cd /root/DMV
git checkout devnet && git pull
git tag devnet-final-$(date +%Y%m%d) && git push --tags       # rollback anchor
git checkout -b mainnet
```
**Verify:** `git branch --show-current` → `mainnet`.

---

## Step 1 — FEE_WALLET → `<TREASURY>` (program + app + test, together)
Edit all three so the on-chain constraint, the client's explicit `feeRecipient`, and the test agree — a mismatch fails every `initialize_vault` with `InvalidFeeRecipient`.
- `programs/dead-mans-vault/src/constants.rs:8` — `FEE_WALLET = pubkey!("<TREASURY>")`
- `dead-mans-vault/app/src/utils/constants.ts:8` — `FEE_WALLET = '<TREASURY>'`
- `dead-mans-vault/tests/dead-mans-vault.ts:27` — `const FEE_WALLET = new PublicKey('<TREASURY>')`

**Verify:** `grep -rn "<TREASURY>" programs/.../constants.rs app/src/utils/constants.ts tests/` → 3 hits; `grep -rn 98x9Rn63 programs app/src/utils/constants.ts` → **0**.

---

## Step 2 — Wallet cluster → mainnet (the deferred §3.3)
`dead-mans-vault/app/src/utils/useAuthorization.tsx:18` — make it follow the RPC instead of hardcoding devnet:
```ts
import { isDevnet } from './rpcConfig';
const CLUSTER = isDevnet() ? "devnet" : "mainnet-beta";
```
(`CHAIN_IDENTIFIER` is computed at module load from the build's default RPC — which is mainnet after Step 7 — so wallets authorize on `solana:mainnet-beta`.)
**Verify:** after the app build (Step 8), a wallet-connect prompt shows **mainnet**, not devnet.

---

## Step 3 — Anchor.toml: add mainnet
Add under the existing program blocks:
```toml
[programs.mainnet]
dead_mans_vault = "GXCu5964mvgAJDWmcMriZpzU3vDVqPzjYCM1sxCnsoEb"
```
(Leave `[provider] cluster` as-is; we pass `--provider.cluster mainnet` explicitly.)

---

## Step 4 — Build the program PLAIN (feature OFF) + verify prod floors ⛔
```bash
cd /root/DMV/dead-mans-vault
yarn build:prod                 # == `anchor build`  — NEVER build:devnet
cargo test -p dead-mans-vault --lib   # asserts 1-day / 7-day / 24-h floors
```
**Verify (do NOT proceed if any fails):**
- `cargo test` passes the `min_durations_match_build_profile` assertion → prod floors baked in.
- `grep -c '"address": "<TREASURY>"' target/idl/dead_mans_vault.json` on the `fee_recipient` account → confirms the new fee wallet is in the IDL.
- `solana address -k target/deploy/dead_mans_vault-keypair.json` → `GXCu5964…` (program ID unchanged).

---

## Step 5 — Deploy to mainnet-beta + set upgrade authority + IDL init ⛔
```bash
solana balance <DEPLOYER> --url mainnet-beta        # ~5 SOL present?
anchor deploy --provider.cluster mainnet --provider.wallet <DEPLOYER>
# First mainnet deploy → the IDL account doesn't exist yet → INIT (not upgrade):
anchor idl init  --provider.cluster mainnet --filepath target/idl/dead_mans_vault.json \
  GXCu5964mvgAJDWmcMriZpzU3vDVqPzjYCM1sxCnsoEb
# Move upgrade authority off the hot deployer to the multisig:
solana program set-upgrade-authority GXCu5964mvgAJDWmcMriZpzU3vDVqPzjYCM1sxCnsoEb \
  --new-upgrade-authority <UPGRADE_AUTH> --url mainnet-beta
```
**Verify:** `solana program show GXCu5964… --url mainnet-beta` → shows the program, `Authority == <UPGRADE_AUTH>`. `anchor idl fetch … --provider.cluster mainnet | grep close_executed_vault` → present.
⛔ **Point of no return for funds** is not here (no vaults exist yet) — but the upgrade-authority hand-off is; double-check `<UPGRADE_AUTH>` before running it.

---

## Step 6 — Sync the IDL everywhere (fee-wallet address changed)
```bash
cd /root/DMV/dead-mans-vault
cp target/idl/dead_mans_vault.json  app/src/utils/idl.json
cp target/idl/dead_mans_vault.json  app/src/utils/dead_mans_vault.json
cp target/types/dead_mans_vault.ts  app/src/utils/dead_mans_vault.ts
cp target/types/dead_mans_vault.ts  app/src/utils/dead_mans_vault_types.ts
cp target/idl/dead_mans_vault.json  ../notify-server/idl/dead_mans_vault.json
cp target/idl/dead_mans_vault.json  ../keeper-bot/idl/dead_mans_vault.json
cd app && npx tsc --noEmit          # must be clean
```
**Verify:** `grep -rc '<TREASURY>' app/src/utils/*.json` → new fee wallet present in the app IDLs.

---

## Step 7 — App build env → mainnet RPC ⛔ (or the APK silently talks to devnet)
Set the mainnet URL for the build. Either edit `app/.env`:
```
EXPO_PUBLIC_RPC_URL=<MAINNET_RPC>
EXPO_PUBLIC_PROGRAM_ID=GXCu5964mvgAJDWmcMriZpzU3vDVqPzjYCM1sxCnsoEb
```
or add an `env` block to the `production` profile in `app/eas.json`. **The `.env` must be in place BEFORE prebuild.**
**Verify:** `grep RPC_URL app/.env` → mainnet host, no `devnet`.

---

## Step 8 — Build + verify + release the mainnet APK
Bump `app.json` version + versionCode (e.g. 1.14.0 / 100 — a clean mainnet number) AND `android/app/build.gradle` to match.
```bash
cd /root/DMV/dead-mans-vault/app
npx expo prebuild --platform android --clean
# prebuild resets gradle.properties — restore:
sed -i 's/^reactNativeArchitectures=.*/reactNativeArchitectures=arm64-v8a/' android/gradle.properties
cd android && ./gradlew assembleRelease --no-daemon --max-workers=2
cp app/build/outputs/apk/release/app-release.apk ../dead-mans-vault-v1.14.0.apk
```
**Verify the bundle (critical — devnet must be gone):**
```bash
unzip -p ../dead-mans-vault-v1.14.0.apk assets/index.android.bundle > /tmp/b.bundle
grep -oac '<TREASURY>' /tmp/b.bundle          # fee wallet present (>=1)
grep -oac 'mainnet-beta' /tmp/b.bundle        # cluster present (>=1)
K=$(grep -E '^EXPO_PUBLIC_RPC_URL=' .env | grep -oE 'api-key=[^&]+' | cut -d= -f2)
grep -oaF "$K" /tmp/b.bundle | wc -l           # mainnet Helius key embedded (>=1)
grep -oac 'api.devnet.solana.com' /tmp/b.bundle  # SHOULD be 0
```
Release: `gh release create v1.14.0 <apk> --title "… v1.14.0 (mainnet)" --notes "…"`.
⛔ **Do not distribute** if the devnet grep is non-zero.

---

## Step 9 — notify-server cutover (env only, no code)
On the VPS, edit `/root/DMV/notify-server/.env` (mode 600):
```
NODE_ENV=production
RPC_URL=<MAINNET_RPC>
PROGRAM_ID=GXCu5964mvgAJDWmcMriZpzU3vDVqPzjYCM1sxCnsoEb
CRANKER_KEYPAIR=<CRANKER_MAINNET>        # funded with real SOL
POLL_INTERVAL_MS=300000                   # 5 min (mainnet stages are days, not 30s)
REGISTER_SECRET=<already set>
```
`sudo systemctl restart dmv-notify` → **Verify** `/health` shows `executorReady:true`, `rpc` masked mainnet, and journald has no boot error.

---

## Step 10 — keeper-bot cutover (env only)
Edit `/etc/systemd/system/dmv-keeper.service`:
```
Environment=RPC_URL=<MAINNET_RPC>
Environment=KEYPAIR_PATH=<CRANKER_MAINNET keeper keypair>   # funded with real SOL
Environment=CLOSE_EXECUTED=1     # mainnet default — 24h window is a fair owner window
Environment=POLL_MS=300000
```
`sudo systemctl daemon-reload && sudo systemctl restart dmv-keeper` → **Verify** log shows `crank + rent-close` (not CRANK-ONLY) and a clean first tick.

---

## Step 11 — Website flip
`/var/www/dmv/index.html` is a self-unpacking bundle — edit via JSON.parse of the `__bundler/template` payload + re-encode with `/` slash escaping (see the `dmv-website-bundle` note). Replace the 3 "Devnet" strings + the `?cluster=devnet` explorer link + the "Latest release" text → v1.14.0. Smoke-test render with puppeteer. (`icon.png` favicon/logo already brand-correct.)

---

## Step 12 — Mainnet smoke test with a SMALL real vault ⛔ first-funds gate
Before announcing: on a real device, with a **small** amount:
1. Create a vault (pays the 0.01 SOL fee → confirm it lands in `<TREASURY>`).
2. Deposit a tiny amount + a test SPL/NFT.
3. Heartbeat (**verify the biometric round-trip** — still never device-tested).
4. Let it lapse → confirm autonomous execution (notify-server/keeper), notifications ("executing" + "complete"), correct distribution, then owner **close & reclaim rent**.
5. Beneficiary **claim** from a second wallet.
6. If DeFi is in play, test the **real Jupiter close path** (mocked on devnet — never run on live liquidity) with a small position.
⛔ Do not open to real users until this passes end-to-end.

---

## Step 13 — Merge, monitor, announce
```bash
git checkout main && git merge mainnet && git push        # or make mainnet the release branch
```
- Monitor cranker balances (notify + keeper) — top up before they drain.
- Watch `journalctl -u dmv-notify -u dmv-keeper` for FCM rejects / crank failures.
- Update README/CHANGELOG "Network: Mainnet" + program links (drop `?cluster=devnet`).

---

## Abort / rollback
- **Before Step 5 (deploy):** nothing is on mainnet — just `git checkout devnet`, discard the branch.
- **After deploy, before users:** the program is deployed but holds no funds; you can `anchor upgrade` a fix (upgrade authority = `<UPGRADE_AUTH>`), or simply not distribute the APK. No user funds at risk.
- **After real vaults exist:** execution is permissionless + immutable-by-design once past deadline — treat any fix as a careful, audited program upgrade; never touch the upgrade authority casually. The devnet build + tag from Step 0 is the reference baseline.
- **Servers** can revert to devnet by restoring their prior `.env` + `systemctl restart` at any time (they hold no authority).
