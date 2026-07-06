# Mainnet Readiness — Dead Man's Vault

Status: **PRE-MAINNET.** Currently live on Solana **devnet** (program `GXCu5964mvgAJDWmcMriZpzU3vDVqPzjYCM1sxCnsoEb`, app v1.13.8). This is the ordered checklist to ship to **mainnet-beta** with real inheritance funds. Last reviewed 2026-07-05.

Last reviewed **2026-07-06** (owner decisions locked in — see §2; §1.6/§3.3 done; program-ID reuse verified; balance monitor built). Contact for the audit brief: **romulus@palatinearc.com**.

Legend: 🔴 hard blocker · 🟡 decision needed (owner) · 🟢 verified/done · ⚪ prep (safe to do pre-cutover) · 🔵 verify-on-mainnet

---

## 0. The shape of it

The good news from the devnet→mainnet audit: the app's **data plane is URL-driven** — RPC, Helius (DAS / enhanced-tx / priority-fee), and both servers' RPC all follow the active RPC URL, so pointing at a mainnet Helius URL flips them automatically. What does **not** flip on its own is a finite, known list: the wallet **cluster identifier**, the **program ID** (declare_id + 4 app IDL copies + constants + server envs), the **fee wallet** (must be owner-controlled), the hardcoded **explorer links**, and a handful of **"Devnet" UI labels**.

The single most important safety gate is already **verified green**: a plain `anchor build` (no `devnet` feature) enforces the production floors (1-day heartbeat / 7-day grace / 24-h close window), the demo floors are feature-gated, and **CI asserts both**. No path can ship demo timing to mainnet.

**The long pole is a security audit**, not the code cutover — see §1.1.

---

## 1. Hard blockers (must be done before real funds)

### 1.1 🔴 External security audit
A self-custody **inheritance** protocol moves a user's entire estate, irreversibly, from on-chain state. A multi-agent adversarial review has been done (and caught a *Critical* — the `execute_specific_asset` ATA-spoof — plus the P0–P7 hardening), but that is **not a substitute** for an independent professional audit before real funds.

**DECIDED (2026-07-06): no budget for a paid firm → community-review route.** Ship **MIT / open-source** and solicit review from Solana CT / independent devs, backed by free tooling. This is a weaker control than OtterSec/Neodyme/Zellic/Sec3 and must be launched with an explicit "community-reviewed, not professionally audited — use at your own risk" disclosure + a soft launch (encourage small vaults first) to bound blast radius. To maximise the community route:
- **Self-screen with free tooling first.** `cargo audit` — ✅ run 2026-07-06: **0 vulnerabilities**, 5 informational advisories only (unmaintained/unsound transitive deps: bincode, libsecp256k1, anyhow, rand — none exploitable here). Re-run before launch. **Next: a fuzzer** (Ackee Trident, or LiteSVM property tests) over the execution invariants — bigger lift, scoped follow-up.
- **Publish `tasks/AUDIT-SCOPE.md`** (frozen at tag `audit-2026-07-05c`) with the repo — reviewers need the trust model + invariant list to be efficient.
- **Post a bug bounty** (even symbolic, funded from creation fees) — draws far more eyes than "please look".
- **Apply for an audit *subsidy*.** The Solana Foundation has co-funded audits for open-source public-goods infra — you may be less priced-out than assumed. Worth an application in parallel.

### 1.2 🔴 Mainnet program deploy — plain build, feature OFF
- Build with **`yarn build:prod`** (= plain `anchor build`) — **never** `build:devnet`. Verified: default floors are the safe 1d/7d/24h. CI guards it.
- Fund the deploy with **~13 SOL** — the `.so` is ~602 KB; program-data rent is ~8.6 SOL (loader reserves 2× size) and the deploy buffer (~4.3 SOL) coexists before refund. **Deploy through the Helius `<MAINNET_RPC>`, not the `mainnet` moniker** (public RPC 429s on a large-program deploy) — with `--with-compute-unit-price` + buffer-resume on failure (runbook Step 5).
- **DECIDED (2026-07-06): reuse the existing program keypair** → same program ID everywhere, **§1.3 is skipped entirely.** ✅ Verified present + controllable on the VPS: `target/deploy/dead_mans_vault-keypair.json` resolves to `GXCu5964…sxCnsoEb` (the live program ID). No lost keys.
- The current deployer / upgrade authority is `6ZRc3mLjKrffUz4MVx1rTvYPMCFJKGRvyJZG5S3k4VES` at `/root/.config/solana/id.json` (verified = the on-chain devnet upgrade authority). It lives **only on the VPS filesystem** → a VPS compromise = upgrade-authority compromise = every vault drainable. That is the whole reason to hand upgrade authority to a Squads whose keys are *not* on the VPS.
- Set the upgrade authority deliberately. **Keep it on the deployer through the §1.7 smoke test, then hand off to the Squads multisig** (runbook Step 12.5) with `--skip-new-upgrade-authority-signer-check` (the vault PDA can't sign). Produce a **verifiable build** (`solana-verify`) + publish the bytecode hash so users can confirm on-chain == audited source.
- **Upgrade authority = solo Squads V4 (2026-07-06).** Owner holds all signer keys (no third parties available). Value comes from **key diversity across devices** — recommend ≥1 hardware wallet (Ledger, ~$80) as a signer, threshold 2-of-3, + a timelock (the timelock is what actually protects users: a malicious upgrade sits pending long enough to exit). A hot-wallet upgrade authority is the single most dangerous key in the system — avoid it even at launch.

### 1.3 🟢 Program ID propagation — SKIPPED (reusing the devnet program ID, §1.2)
**Not needed** — the devnet program keypair is reused, so the program ID is unchanged and every literal below already matches. Kept for reference only. If a **new** program keypair were ever used, update every hardcoded literal (the app `constants.ts` + the 4 app IDL copies are the ones that silently break signing):
- `programs/.../src/lib.rs:12` `declare_id!`
- `Anchor.toml` `[programs.*]` (add a `[programs.mainnet]`)
- `app/src/utils/constants.ts:3` `PROGRAM_ID` (**load-bearing** — the app reads this literal, not the env)
- `app/src/utils/{idl.json, dead_mans_vault.json, dead_mans_vault.ts, dead_mans_vault_types.ts}` (address field)
- `notify-server/idl/dead_mans_vault.json` + `PROGRAM_ID` env
- `keeper-bot/idl/dead_mans_vault.json` (keeper reads ID from the IDL)
- docs/README/pitch-deck (cosmetic)
> If the ID is **reused**, only the network target changes — no ID edits.

### 1.4 🔴 FEE_WALLET verification
`initialize_vault` pins the 0.01 SOL creation fee to `FEE_WALLET = 98x9Rn63Ne8xbL3w522zgbuYg9bdHn7cRqJQVCUZUFsp` via an on-chain `address =` constraint. On mainnet this **must be a wallet the owner controls**, and the app constant must match the program constant or every `initialize_vault` fails `InvalidFeeRecipient`. Change together: `programs/.../constants.rs:8` **and** `app/src/utils/constants.ts:8` (+ the test). **DECIDED (2026-07-05/06): the mainnet treasury is the Squads multisig.**

> **Sequencing (important — 2026-07-06):** FEE_WALLET is baked into the bytecode via the on-chain `address =` constraint, so **changing it later costs a full program redeploy + app rebuild + IDL resync.** The upgrade authority, by contrast, migrates with **one cheap CLI command** (`set-upgrade-authority`, no redeploy). Therefore: **stand up the Squads *before* the mainnet build and use it as BOTH the fee wallet and the upgrade authority from day one** — one setup, no forced future redeploy, no risky hot-wallet window. (Fee wallet is low-stakes — it only *receives* 0.01 SOL creation fees, zero authority over vaults — so a hot fee wallet at launch is *acceptable* if the Squads truly isn't ready; you'd just pay the redeploy tax on migration.)

### 1.5 🔴 Mainnet RPC in the build env
`eas.json` has **no `env:` block**, and `rpcConfig.ts` + `.env.example` default to devnet. The released APK will **silently talk to devnet** unless the mainnet build sets `EXPO_PUBLIC_RPC_URL` to a mainnet (Helius) URL. Either add an `env` block to the `production` EAS profile, or ensure `app/.env` holds the mainnet URL at build time. (A paid Helius mainnet endpoint is needed — public mainnet RPC will rate-limit portfolio scans + cranks.)

### 1.6 🟢 Wallet cluster identifier — DONE (2026-07-06)
`app/src/utils/useAuthorization.tsx` no longer hardcodes the cluster: a `getChainIdentifier()` helper derives it from `isDevnet()` at call time (`solana:devnet` today, `solana:mainnet` on a mainnet build). Computed at call time (not module load) because `isDevnet()` reads the runtime RPC override that `App.tsx` hydrates during bootstrap. **Gotcha handled:** the wallet-standard chain id is `solana:mainnet`, **not** `solana:mainnet-beta` — the MWA proxy maps `solana:mainnet` → the `mainnet-beta` cluster; any other string falls through to the devnet default. Typed as MWA `Chain`; `tsc` clean. Flips automatically on the mainnet build — no further action.

### 1.7 🔴 Real-device end-to-end test on mainnet (or a final devnet pass mirroring prod)
- **Biometric heartbeat round-trip** — still never device-verified (flagged since v1.13.0).
- Full autonomous cycle: create → escalate → autonomous execute → notifications ("executing" + "complete") → owner close & reclaim rent.
- Beneficiary **claim** flow via a real MWA wallet.
- Device migration / `rotate_agent`.

### 1.8 🔴 Governance provisioned + rehearsed (upgrade-authority path)
Because the program is governed-upgradeable (§2 / AUDIT-SCOPE §7), the multisig path is itself a launch dependency:
- **Squads V4 multisig created**, all signers hold working keys, **timelock configured**.
- A full **propose→approve→execute upgrade rehearsed on devnet** — an untested governance path means you may be unable to ship a post-launch security fix (availability-Critical).
- Handoff sequenced **after** the §1.7 smoke test (runbook Step 12.5), never before.
- **Status (2026-07-06): deferred by owner ("wait a bit").** OK — mainnet isn't imminent. But per the §1.4 sequencing note, the Squads should exist **before the mainnet program build** so it can be the fee wallet from day one (avoids a forced redeploy). Solo Squads with owner-held keys across devices + ≥1 hardware wallet + timelock (see §1.2).

### 1.9 🟡 Cranker liveness monitoring + RPC redundancy (partially done)
A drained cranker or an RPC outage = vaults never execute = beneficiaries never inherit (availability-Critical):
- **Balance alerting — built (2026-07-06).** `keeper-bot/balance-monitor.mjs` checks the notify-cranker (`9x7nyDZG…`) + keeper (`3gYfPHrG…`) wallets against `MONITOR_FLOOR_SOL` (default 0.05), prints one line each, **exits non-zero** when any is low/unreachable, and POSTs to `ALERT_WEBHOOK` if set (body carries both `{text}` Slack + `{content}` Discord). ✅ tested on devnet (both healthy, exit 0). Systemd units ready in `keeper-bot/`: `dmv-balance-monitor.{service,timer}` (15-min oneshot). **Remaining owner action: pick an alert channel** (set `ALERT_WEBHOOK` to a Slack/Discord webhook), then `cp` the units to `/etc/systemd/system/` + `systemctl enable --now dmv-balance-monitor.timer`. Without a channel it only logs (= manual watching, not a control).
- **RPC:** owner will start with a **paid Helius dev endpoint** (covers the app + both crankers' primary RPC — enough for a v1 soft launch). ⏳ still open: a **fallback RPC** (a single endpoint is a shared SPOF) and **automated crank-failure / `solana logs` alerting** (the monitor covers *balance*, not *execution errors* — a separate alert).

---

## 2. Decisions needed from the owner

| # | Decision | Options / recommendation |
|---|----------|--------------------------|
| 2.1 🟢 | **Security audit** | **DECIDED (07-06): community-review route** — no budget for a firm. MIT/open-source, solicit Solana-CT/independent reviewers, self-screen with free tooling (`cargo audit` ✅ 0 vulns; fuzzer next), publish `AUDIT-SCOPE.md`, post a bug bounty, apply for a Foundation audit subsidy. Launch with an explicit "not professionally audited" disclosure + soft launch. See §1.1. |
| 2.2 🟢 | **FEE_WALLET treasury** | **DECIDED (07-06): the Squads multisig.** ⏳ blocked on the Squads existing (§1.8). Per §1.4 sequencing, create the Squads **before** the mainnet build and use it as fee wallet + upgrade authority together. |
| 2.3 🟢 | **Fee + bounty economics** | **CONFIRMED (07-06): creation fee 0.01 SOL, keeper bounty 0.005 SOL** for mainnet. Keeper is net-positive (bounty + rents via `close_executed_vault`). |
| 2.4 🟢 | **Signed notify-registration** | **DECIDED (07-06): ship mainnet v1 UNSIGNED**, enable signed as a fast-follow. Registration controls *notifications + who cranks*, **not** where funds go (execution is permissionless + computed on-chain), and the on-chain ownership proof already gates it — so the fund-safety blast radius is nil. The owner-signed path is built but dormant; activating it is a coordinated app+server release. |
| 2.5 🟢 | **Biometric-per-heartbeat** | **DECIDED (07-06): DROP** it in the next build. The agent key signs heartbeats only — worst case of compromise is *stalling* the switch, not theft; and it's redundant right after app-unlock. Key stays behind the device lock at rest. |
| 2.6 🟡 | **Distribution** | **STILL OPEN.** Sideloaded APK vs Google Play. Real funds via a sideloaded APK is a trust/updateability concern; Play Store (or at least a signed, verifiable APK + a stable download) is stronger for mainnet. |

---

## 3. Network-agnostic code changes (⚪ safe to do now — correct on devnet today, automatically correct on mainnet)

These read the URL-driven `isDevnet()`, so they behave identically on devnet now and flip on a mainnet build. Doing them pre-cutover shrinks the mainnet diff to just the program ID + fee wallet + build env.

- **3.1 Explorer links** — 🟢 DONE (commit 77f2c17). `explorerTx()`/`explorerAddress()` helpers in `rpcConfig.ts`; all 12 sites now follow `isDevnet()`.
- **3.2 UI network labels** — 🟢 DONE (commit 77f2c17). `networkLabel()` helper; all 4 sites now follow `isDevnet()`.
- **3.3 Wallet cluster (§1.6)** — 🟢 DONE (2026-07-06). `useAuthorization.tsx` `getChainIdentifier()` derives the cluster from `isDevnet()` at call time (`solana:mainnet`, not `mainnet-beta` — see §1.6). `tsc` clean. Verify wallet connect on devnet after the next build; flips automatically on mainnet.

---

## 4. 🔵 DeFi real-path verification (verify on mainnet)
`app/src/defi/closer.ts` **mocks** DeFi position closures on devnet (`if (isDevnet()) return simulateClosure(...)`). On mainnet the real path runs: `closeViaJupiter` (3% slippage, autonomous / no per-swap approval) and native-stake closure. **This has never executed against live liquidity** — test carefully on mainnet with a small position before relying on it. Native-stake closure is still simulated regardless of network (a known feature gap, not devnet-specific). Devnet-only entries in `defi/registry.ts` (devnet Orca program + devnet USDC/EURC/MNDE mints) are harmless on mainnet but dead weight — optional cleanup.

---

## 5. Servers — mainnet cutover is env-only (no code changes)
- **notify-server**: set `RPC_URL` (mainnet Helius), `PROGRAM_ID` (if changed), fund `CRANKER_KEYPAIR` with real SOL, `NODE_ENV=production` (already fail-closes without `REGISTER_SECRET`). Bump `POLL_INTERVAL_MS` from 15s → ~5–15 min (mainnet stages are days, not 30s). Re-sync `idl/` with the mainnet deploy.
- **keeper-bot**: set `RPC_URL` (mainnet), fund the keypair, **`CLOSE_EXECUTED=1`** (mainnet default — the 24h window is a fair owner window and rents are the incentive), re-sync `idl/`.

---

## 6. 🟢 Verified green (already done)
- Prod build floors (1d/7d/24h) enforced by default; demo floors feature-gated; **CI asserts both** (`.github/workflows/ci.yml`).
- Program: 29/29 tests. Security hardening P0–P7 + the ATA-spoof Critical fix. Keeper-bounty cap. CEI ordering. Token-2022 distribution + owner withdrawal.
- Agent key biometric-gated + `allowBackup=false` + zeroize-on-destroy; funds ~0.005 SOL, heartbeat-only.
- Data plane URL-driven (RPC/Helius/DAS) — flips with a mainnet URL.
- Permissionless execution + two independent crankers (notify-server + keeper bot); permissionless rent-cleanup after the owner window.
- Toolchain build-compat pins working (program builds clean).

---

## 7. Suggested sequence
1. **Decide §2.1 (audit)** — it gates everything. Book it; it runs in parallel with the rest.
2. Do the ⚪ network-agnostic changes (§3) + confirm §2.2/§2.3 (fee wallet + economics) → fold into an app build.
3. When audit findings are in: fix, re-test (29/29 + regressions), then **mainnet program deploy** (§1.2, plain build), set upgrade authority to a multisig.
4. Propagate program ID if new (§1.3); flip build env to mainnet RPC (§1.5).
5. Cut the mainnet APK; cut over the two servers (§5).
6. Real-device E2E on mainnet with a small vault (§1.7) + DeFi real-path check (§4).
7. Launch; monitor cranker balances + notify/keeper logs.
</content>
