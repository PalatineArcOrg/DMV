# Mainnet Readiness — Dead Man's Vault

Status: **PRE-MAINNET.** Currently live on Solana **devnet** (program `GXCu5964mvgAJDWmcMriZpzU3vDVqPzjYCM1sxCnsoEb`, app v1.13.8). This is the ordered checklist to ship to **mainnet-beta** with real inheritance funds. Last reviewed 2026-07-05.

Legend: 🔴 hard blocker · 🟡 decision needed (owner) · 🟢 verified/done · ⚪ prep (safe to do pre-cutover) · 🔵 verify-on-mainnet

---

## 0. The shape of it

The good news from the devnet→mainnet audit: the app's **data plane is URL-driven** — RPC, Helius (DAS / enhanced-tx / priority-fee), and both servers' RPC all follow the active RPC URL, so pointing at a mainnet Helius URL flips them automatically. What does **not** flip on its own is a finite, known list: the wallet **cluster identifier**, the **program ID** (declare_id + 4 app IDL copies + constants + server envs), the **fee wallet** (must be owner-controlled), the hardcoded **explorer links**, and a handful of **"Devnet" UI labels**.

The single most important safety gate is already **verified green**: a plain `anchor build` (no `devnet` feature) enforces the production floors (1-day heartbeat / 7-day grace / 24-h close window), the demo floors are feature-gated, and **CI asserts both**. No path can ship demo timing to mainnet.

**The long pole is a security audit**, not the code cutover — see §1.1.

---

## 1. Hard blockers (must be done before real funds)

### 1.1 🔴 External security audit
A self-custody **inheritance** protocol moves a user's entire estate, irreversibly, from on-chain state. A multi-agent adversarial review has been done (and caught a *Critical* — the `execute_specific_asset` ATA-spoof — plus the P0–P7 hardening), but that is **not a substitute** for an independent professional audit before real funds. Strongly recommend a firm (e.g. OtterSec, Neodyme, Zellic, Sec3) audit of the Anchor program + the permissionless execution model. **This gates the timeline** (weeks + cost) → decide first (§2.1).

### 1.2 🔴 Mainnet program deploy — plain build, feature OFF
- Build with **`yarn build:prod`** (= plain `anchor build`) — **never** `build:devnet`. Verified: default floors are the safe 1d/7d/24h. CI guards it.
- Fund the deploy with **~13 SOL** — the `.so` is ~602 KB; program-data rent is ~8.6 SOL (loader reserves 2× size) and the deploy buffer (~4.3 SOL) coexists before refund. **Deploy through the Helius `<MAINNET_RPC>`, not the `mainnet` moniker** (public RPC 429s on a large-program deploy) — with `--with-compute-unit-price` + buffer-resume on failure (runbook Step 5).
- Decide: **reuse the existing program keypair** (`target/deploy/dead_mans_vault-keypair.json` → same program ID everywhere, less churn) or generate a fresh mainnet keypair (then §1.3 applies). Recommend reuse unless there's a reason not to.
- Set the upgrade authority deliberately. **Keep it on the deployer through the §1.7 smoke test, then hand off to the Squads multisig** (runbook Step 12.5) with `--skip-new-upgrade-authority-signer-check` (the vault PDA can't sign). Produce a **verifiable build** (`solana-verify`) + publish the bytecode hash so users can confirm on-chain == audited source.

### 1.3 🔴 Program ID propagation (only if the mainnet ID differs from devnet)
If a **new** program keypair is used, update every hardcoded literal (the app `constants.ts` + the 4 app IDL copies are the ones that silently break signing):
- `programs/.../src/lib.rs:12` `declare_id!`
- `Anchor.toml` `[programs.*]` (add a `[programs.mainnet]`)
- `app/src/utils/constants.ts:3` `PROGRAM_ID` (**load-bearing** — the app reads this literal, not the env)
- `app/src/utils/{idl.json, dead_mans_vault.json, dead_mans_vault.ts, dead_mans_vault_types.ts}` (address field)
- `notify-server/idl/dead_mans_vault.json` + `PROGRAM_ID` env
- `keeper-bot/idl/dead_mans_vault.json` (keeper reads ID from the IDL)
- docs/README/pitch-deck (cosmetic)
> If the ID is **reused**, only the network target changes — no ID edits.

### 1.4 🔴 FEE_WALLET verification
`initialize_vault` pins the 0.01 SOL creation fee to `FEE_WALLET = 98x9Rn63Ne8xbL3w522zgbuYg9bdHn7cRqJQVCUZUFsp` via an on-chain `address =` constraint. On mainnet this **must be a wallet the owner controls**, and the app constant must match the program constant or every `initialize_vault` fails `InvalidFeeRecipient`. Change together: `programs/.../constants.rs:8` **and** `app/src/utils/constants.ts:8` (+ the test). **DECIDED (2026-07-05): use a different mainnet treasury** (recommend a multisig) — owner to provide the address; applied at the mainnet rebuild.

### 1.5 🔴 Mainnet RPC in the build env
`eas.json` has **no `env:` block**, and `rpcConfig.ts` + `.env.example` default to devnet. The released APK will **silently talk to devnet** unless the mainnet build sets `EXPO_PUBLIC_RPC_URL` to a mainnet (Helius) URL. Either add an `env` block to the `production` EAS profile, or ensure `app/.env` holds the mainnet URL at build time. (A paid Helius mainnet endpoint is needed — public mainnet RPC will rate-limit portfolio scans + cranks.)

### 1.6 🔴 Wallet cluster identifier
`app/src/utils/useAuthorization.tsx:18` hardcodes `CLUSTER = "devnet"` → `chain: "solana:devnet"` on every MWA `authorize()`. On mainnet this must be `"mainnet-beta"` or wallets authorize on the wrong cluster. Best fix: derive from `isDevnet()` so it follows the RPC URL (⚪ can be done pre-cutover, see §3.3).

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

### 1.9 🔴 Cranker liveness monitoring + RPC redundancy
A drained cranker or an RPC outage = vaults never execute = beneficiaries never inherit (availability-Critical):
- **Automated** cranker-balance alerting (notify + keeper) with a top-up threshold; **automated** crank-failure + `solana logs` alerting. Manual `journalctl` watching is not a control.
- A **fallback RPC** alongside the Helius `<MAINNET_RPC>` (a single endpoint is a shared SPOF for the app + both crankers).

---

## 2. Decisions needed from the owner

| # | Decision | Options / recommendation |
|---|----------|--------------------------|
| 2.1 🟢→🟡 | **Security audit** | **DECIDED: get quotes first.** Scope/brief prepared → `tasks/AUDIT-SCOPE.md` (send to firms: OtterSec / Neodyme / Zellic / Sec3). Then decide + book. |
| 2.2 🟢→🟡 | **FEE_WALLET treasury** | **DECIDED: use a different wallet** (not `98x9Rn63…`). ⏳ Owner to provide the mainnet treasury address; then change `constants.rs:8` + `app constants.ts:8` (+ test) together at the mainnet rebuild. |
| 2.3 🟡 | **Fee + bounty economics** | Creation fee 0.01 SOL (~$1–2.50) and keeper bounty 0.005 SOL default — confirm both for mainnet. Keeper is net-positive on mainnet (bounty + rents via `close_executed_vault`), so 0.005 is workable; revisit if you want a bigger cushion. |
| 2.4 🟡 | **Signed notify-registration** | The owner-signed register/deregister path is built but **dormant** (reverted on devnet). Activating it on mainnet is a coordinated app+server release (sign inside the activation MWA session, transition window). Recommend: ship mainnet v1 unsigned (on-chain ownership proof already gates it), enable signed as a fast-follow. |
| 2.5 🟡 | **Biometric-per-heartbeat** | Still parked. Recommend **drop** the per-heartbeat prompt (the agent key can only sign heartbeats — worst case of compromise is *stalling* the switch, not theft; and it's redundant right after the app-unlock biometric). Keep the key behind the device lock at rest. |
| 2.6 🟡 | **Distribution** | Sideloaded APK vs Google Play. Real funds via a sideloaded APK is a trust/updateability concern; Play Store (or at least a signed, verifiable APK + a stable download) is stronger for mainnet. |

---

## 3. Network-agnostic code changes (⚪ safe to do now — correct on devnet today, automatically correct on mainnet)

These read the URL-driven `isDevnet()`, so they behave identically on devnet now and flip on a mainnet build. Doing them pre-cutover shrinks the mainnet diff to just the program ID + fee wallet + build env.

- **3.1 Explorer links** — 🟢 DONE (commit 77f2c17). `explorerTx()`/`explorerAddress()` helpers in `rpcConfig.ts`; all 12 sites now follow `isDevnet()`.
- **3.2 UI network labels** — 🟢 DONE (commit 77f2c17). `networkLabel()` helper; all 4 sites now follow `isDevnet()`.
- **3.3 Wallet cluster (§1.6)** — `useAuthorization.tsx` CLUSTER from `isDevnet()`. Critical path — change deliberately + verify wallet connect still works on devnet before/after.

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
