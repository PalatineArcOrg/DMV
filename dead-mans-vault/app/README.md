# Dead Man's Vault

**Your crypto outlives you — autonomously, on Solana.**

Dead Man's Vault is a permissionless crypto inheritance protocol on Solana. It monitors your liveness through configurable heartbeat checks. When your heartbeats stop, it escalates through a 4-stage warning system and then distributes your assets to pre-configured beneficiaries — **trustlessly, and even if your phone is lost, dead, or never opened again**.

Once your grace period elapses, the on-chain program computes every payout from on-chain state, and *anyone* — the app, a beneficiary, or a keyless watcher service — can submit the distribution. The caller controls nothing: funds can only go to the beneficiaries you set, in the proportions you set, after the deadline you set. No custodian, no server holding keys, no intermediary.

Built for the **Monolith Solana Mobile Hackathon** (Feb–Mar 2026).

---

## The Problem

An estimated **$100B+ in crypto is permanently lost** when holders die unexpectedly or become incapacitated. Seed phrases vanish with their owners. Custodial solutions require trusting a third party. Legal processes take years and weren't designed for digital assets.

And the naive "dead-man's switch" has a fatal flaw: if execution depends on *your* device being alive and *your* app being open, then the exact event it's built for — you being gone — is the event that stops it from firing.

**There is no decentralized, trustless, autonomous inheritance solution that actually fires when you're gone — until now.**

---

## The Solution

Dead Man's Vault makes execution **permissionless**: your device configures the vault and proves you're alive, but it is not required for the payout.

- **Heartbeat liveness checks** — Confirm you're alive with a single tap (daily, weekly, or monthly)
- **4-stage escalation** — Overdue → Emergency Alert → Final Warning → Execution
- **Permissionless distribution** — After grace, payouts are computed on-chain and submittable by anyone; the caller cannot change who gets what
- **Fires even if your phone never comes back** — a bundled keyless watcher distributes autonomously when the app is closed
- **Pro-rata *and* specific bequests** — split the estate by percentage, and/or assign exact SOL amounts, exact tokens, and whole NFTs to specific heirs
- **NFT support end-to-end** — NFTs show up in the portfolio, deposit into the vault as whole units, and can be left to specific heirs; the Assets tab has a dedicated NFTs category. Names and images resolve **with or without Helius DAS**: an RPC-only fallback reads each NFT's on-chain Metaplex Metadata account directly (and its image URI), caching the result (compressed NFTs stay DAS-only)
- **Custom RPC endpoint** — Set your own RPC URL in Settings → Network (Test / Save / Reset), e.g. to dodge public-RPC rate limits during scans and cranks. The default endpoint stays private; a "network busy" banner appears on rate-limit and links to the setting
- **Beneficiary claim** — Heirs can trigger a matured vault from their own wallet via the in-app **Inheritances** screen (auto-discovery + manual import by owner address); the heir pays fees and the crank is MWA-signed
- **On-chain keeper bounty** — A vault can reserve a small reward (default 0.005 SOL) paid by the program to whoever cranks `finalize_execution`, making permissionless cranking profitable; it's carved out of the SOL snapshot so it never reduces beneficiary payouts
- **Reversible until execution** — Any heartbeat during stages 1–3 resets everything back to normal; once grace elapses the vault freezes and Stage 4 is irreversible
- **One-time 0.01 SOL creation fee** — collected on-chain by `initialize_vault` (a `fee_recipient` account pinned by address + a CPI transfer), so it can't be bypassed

---

## How It Works

```
┌─────────────┐     ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  Connect     │────>│  Configure   │────>│  Set          │────>│  Activate    │
│  Wallet      │     │  Beneficia-  │     │  Heartbeat   │     │  Vault       │
│  (MWA)       │     │  ries + %    │     │  + Grace     │     │  On-Chain    │
└─────────────┘     │  + Bequests  │     └──────────────┘     └──────┬───────┘
                    └──────────────┘                                 │
                    ┌─────────────────────────────────────────────────┘
                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         VAULT ACTIVE — MONITORING                          │
│                                                                             │
│  Heartbeat confirmed ←──── Tap button periodically ────→ Timers reset      │
│                                                                             │
│  Heartbeat missed ──→ Stage 1 ──→ Stage 2 ──→ Stage 3 ──→ Stage 4         │
│                       Overdue     Emergency    FINAL        EXECUTE         │
│                       (amber)     Alert        WARNING      Permissionless  │
│                                   (amber)      (red)        distribution    │
│                                                            (app / heir /   │
│  ↑                                                          watcher cranks) │
│  └── Any heartbeat during stages 1-3 resets to Stage 0 (healthy)           │
│      After grace elapses, the vault freezes to owner changes and executes  │
└─────────────────────────────────────────────────────────────────────────────┘
```

At Stage 4 there is **no privileged signer**. The program has frozen a snapshot of the vault's balances and knows every beneficiary's share; anyone can submit the payout transactions and the program enforces that funds land only where you configured. Per-asset bitmasks make it idempotent, so a partial distribution is safely resumed by anyone.

---

## Works on any Android phone — Seeker recommended

Dead Man's Vault has **no Seed-Vault-specific code**. Owner signing uses standard **Mobile Wallet Adapter**, so any MWA-compatible wallet works (Phantom, Solflare, or the Seeker's Seed Vault). The heartbeat agent key lives in `expo-secure-store` (hardware-backed Android Keystore).

- **Any modern Android phone** with an MWA wallet can run it.
- **Solana Seeker is the best device** — its Seed Vault gives hardware-grade custody of the owner key — but it is **not required**.
- **Android only** for now (MWA is Android-only; no iOS build yet).

And because execution is permissionless and off-device, the inheritance fires regardless of which phone you used, or whether it's ever powered on again.

---

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│              ANDROID PHONE  (Seeker or any MWA device)   │
│                                                          │
│  ┌─────────────────────┐  ┌───────────────────────────┐  │
│  │   React Native App  │  │   MWA Wallet               │  │
│  │                     │  │   (Seed Vault / Phantom /  │  │
│  │  • Screens          │  │    Solflare = owner key)   │  │
│  │  • Services         │  └───────────┬───────────────┘  │
│  │  • Zustand Stores   │              │ signs config txs  │
│  │  • SQLite DB        │  ┌───────────┴───────────────┐  │
│  │                     │  │   Agent Key                │  │
│  │  Portfolio Scanner──│──│   (expo-secure-store)      │  │
│  │  Heartbeat Service──│──│   signs HEARTBEATS ONLY    │  │
│  │  Escalation Engine──│──│                            │  │
│  │  Execution Crank────│──┘                            │  │
│  └──────────┬──────────┘  (crank pays fees; controls    │  │
│             │              nothing about payouts)        │  │
└─────────────┼────────────────────────────────────────────┘
              │                         ▲
        RPC   │  on-chain txs           │ same permissionless
              ▼                         │ instructions
┌──────────────────────────────────────┴───────────────────┐
│                    SOLANA DEVNET                          │
│  ┌─────────────────────────────────────────────────────┐ │
│  │  Anchor Program: dead_mans_vault                    │ │
│  │  GXCu5964mvgAJDWmcMriZpzU3vDVqPzjYCM1sxCnsoEb     │ │
│  │                                                     │ │
│  │  PDAs:                                              │ │
│  │  • VaultConfig     ["vault", owner]                 │ │
│  │  • HeartbeatRecord ["heartbeat", vault]             │ │
│  │  • ExecutionLog    ["execution", vault]             │ │
│  │  • AssetPlan       ["asset_plan", vault]  (bequests)│ │
│  │  • TokenDist       ["token_dist", vault, mint]      │ │
│  │                                                     │ │
│  │  19 instructions — owner setup + permissionless     │ │
│  │  execution (begin_execution, begin_token_dist,      │ │
│  │  execute_specific_asset, execute_specific_sol,      │ │
│  │  execute_sol_shares, execute_token_shares,          │ │
│  │  finalize_execution, close_token_dist,              │ │
│  │  set_asset_plan, …)                                 │ │
│  └─────────────────────────────────────────────────────┘ │
│  External APIs: Helius DAS (tokens) · Jupiter (prices)   │
└─────────────────────────────┬────────────────────────────┘
                              ▲
        watches heartbeats,   │  runs the SAME permissionless
        cranks after grace    │  instructions, pays only fees
┌─────────────────────────────┴────────────────────────────┐
│         Keyless Watcher Service (notify-server)          │
│         Node + Express + SQLite · holds no fund authority │
└──────────────────────────────────────────────────────────┘
```

### Design Principles

- **Permissionless execution** — After grace, payouts are computed entirely on-chain; any signer can submit them and controls nothing
- **Optional keyless watcher** — The app is self-sufficient, *and* a keyless service provides autonomy when the app is closed. Neither holds authority over funds.
- **Idempotent, resumable** — On-chain per-asset bitmasks are the source of truth; a partial distribution is safely resumed by anyone
- **Owner supremacy (pre-grace)** — Owner can override, revoke, update, withdraw, or rotate the agent — until the deadline, after which the vault freezes
- **On-chain constraints** — Program enforces WHO receives, WHERE funds go, WHEN they're allowed, and HOW MUCH (computed from frozen snapshots × share)

### Three Roles

| Role | Storage | Signs | Purpose |
|------|---------|-------|---------|
| **Owner** | MWA wallet (Seed Vault / Phantom / Solflare) | `initialize_vault`, `update_vault`, `set_asset_plan`, `withdraw_*`, `revoke_vault`, `rotate_agent`, `close_executed_vault_by_owner` | Full control over the estate configuration (frozen once grace elapses) |
| **Agent** | expo-secure-store (Android Keystore / Seeker TEE) | `record_heartbeat` **only** | Autonomous liveness proof — never touches funds |
| **Cranker** | anyone (app, beneficiary, keyless watcher) | the permissionless execution instructions | Pays fees to submit payouts; controls nothing about where funds go |

Because the cranker controls nothing, execution is **trustless**: funds can only reach whitelisted beneficiaries, in the configured proportions, after the deadline. The design was hardened by a multi-agent security review that caught and fixed a **critical** fund-misdirection bug before deploy.

---

## Distribution Model

Two modes, combined:

- **Pro-rata** — SOL and each token's residual are split among beneficiaries by their `share_bps` (basis points that sum to 100%).
- **Specific bequests** — An owner-defined plan assigns exact SOL or SPL token amounts, or whole NFTs, to specific beneficiaries. These are carved out **first**; whatever remains splits pro-rata. A beneficiary can receive both a specific bequest and a share of the residual.

Distribution supports both the legacy Token program and **Token-2022**. Rounding dust is swept to the largest-share beneficiary on close; rent returns to the owner.

---

## Tech Stack

| Technology | Version | Purpose |
|-----------|---------|---------|
| **Anchor** | 0.32.1 | On-chain program framework (Rust) |
| **Rust** | 1.89.0 | Program language (pinned, rust-toolchain.toml) |
| **React Native** | 0.76.9 | Mobile framework |
| **Expo** | SDK 52 | Build toolchain + native modules |
| **TypeScript** | 5.x | App language |
| **@solana/web3.js** | 1.78.4 | Solana RPC + transactions |
| **@coral-xyz/anchor** | 0.32.1 | Anchor client SDK |
| **Mobile Wallet Adapter** | 2.2.2 | Owner wallet connection (any MWA wallet) |
| **@solana/spl-token** | 0.4.x | Token + Token-2022 distribution |
| **Zustand** | 5.x | Reactive state management |
| **expo-sqlite** | 15.x | Local persistence (heartbeats, execution progress mirror, settings) |
| **expo-secure-store** | 14.0.1 | Agent heartbeat key storage |
| **expo-notifications** | 0.29.14 | Local push (heartbeat-confirmed + foreground display); escalation alerts are pushed by the keyless watcher via FCM |
| **Helius DAS API** | — | Token portfolio scanning |
| **Jupiter Price API** | — | Real-time USD pricing |
| **Keyless watcher** | Node + Express + SQLite | Autonomous off-device execution after grace |

---

## Key Innovation

**First permissionless, off-device inheritance protocol on Solana Mobile.** No existing solution combines:

1. **Execution that survives the owner** — Because payouts are computed on-chain and crankable by anyone, the switch fires even if the owner's phone is lost, dead, or never reopened. The device is a configuration + heartbeat client, not a dependency for the payout.

2. **Trustless by construction** — The cranker (app, beneficiary, or keyless watcher) pays fees but controls nothing. Funds can only reach whitelisted beneficiaries, in the configured proportions, after the deadline.

3. **Pro-rata + specific bequests** — Split by percentage and/or leave exact tokens and whole NFTs to named heirs, including Token-2022 assets.

4. **Reversible escalation, then a frozen finale** — Stages 1–3 reset with a single tap. Once grace elapses the vault freezes to all owner changes and Stage 4 executes irreversibly, on-chain enforced.

5. **Idempotent, resumable distribution** — On-chain bitmasks are the safety layer. A crashed or partial crank — from any caller — resumes without double-paying.

6. **Runs on any Android phone** — Standard Mobile Wallet Adapter, no Seeker-specific code. Seeker's Seed Vault is the most secure option, not a requirement.

7. **Demo mode for judges** — Toggle in Settings (or tap version text 5 times). Compresses all timers to ~30 seconds per stage so you can watch the full escalation → autonomous execution flow in under 3 minutes.

---

## Demo

The complete flow, on a physical device:
1. Portfolio dashboard with live token balances and 24h price changes
2. Setup wizard: beneficiaries → specific bequests → heartbeat/grace config → estate review → on-chain activation
3. Heartbeat confirmation with visual feedback
4. Full 4-stage escalation (using demo mode's ~30s timers)
5. **Close the app** — the keyless watcher cranks the distribution autonomously after grace, and assets land in the beneficiary wallets

---

## Build Instructions

### Prerequisites

- **Node.js** 18+ and **Yarn**
- **Android Studio** with SDK 34+ (for local builds)
- **Rust** 1.89.0 and **Anchor CLI** 0.32.1 (for program development)
- **Solana CLI** 3.0.15 (Agave) configured for devnet
- An MWA-compatible wallet (e.g., Phantom, Solflare, or Seed Vault) on your Android device
- [Expo account](https://expo.dev/) (for EAS builds)

### Clone & Install

```bash
git clone https://github.com/Romulus-Sol/DMV.git
cd DMV/dead-mans-vault

# Install program dependencies
yarn install

# Install app dependencies
cd app
yarn install
```

### Build the App

```bash
# Option A: EAS Cloud Build
cd app
npx eas build --platform android --profile preview

# Option B: Local Build (arm64-v8a, for Seeker / arm64 Android)
cd app
npx expo prebuild --platform android --clean
cd android && ./gradlew assembleRelease
# → android/app/build/outputs/apk/release/app-release.apk
```

### Program Development (optional)

```bash
# Build the Anchor program
anchor build

# Run program tests (29/29 passing; execution tests use real ~40s grace waits)
anchor test

# Deploy to devnet
anchor deploy --provider.cluster devnet
```

---

## Devnet Program

| | |
|---|---|
| **Program ID** | `GXCu5964mvgAJDWmcMriZpzU3vDVqPzjYCM1sxCnsoEb` |
| **Network** | Solana Devnet |
| **Explorer** | [View on Solana Explorer](https://explorer.solana.com/address/GXCu5964mvgAJDWmcMriZpzU3vDVqPzjYCM1sxCnsoEb?cluster=devnet) |
| **Framework** | Anchor 0.32.1 |
| **App version** | 1.13.8 (versionCode 94) |
| **Tests** | 29/29 passing |

---

## Project Stats

| Metric | Value |
|--------|-------|
| Program instructions | 19 |
| Program accounts (PDAs) | 5 (VaultConfig, HeartbeatRecord, ExecutionLog, AssetPlan, TokenDist) |
| Program error codes | 39 |
| Program tests | 29/29 passing |
| App screens | 14 |
| App services | 10 |
| Zustand stores | 6 |
| SQLite tables | 6 |
| Keyless watcher | Node + Express + SQLite |

---

## Team

**Romulus** — Solo builder ([Romulus-Sol](https://github.com/Romulus-Sol))

---

## License

MIT
