# Dead Man's Vault

**Your crypto outlives you — autonomously, on Solana.**

Dead Man's Vault is an autonomous crypto inheritance protocol built for Solana Seeker. It monitors your liveness through configurable heartbeat checks. When heartbeats stop, it escalates through a 4-stage warning system and then autonomously distributes your assets to pre-configured beneficiaries — no backend, no custodian, no intermediary.

Built for the **Monolith Solana Mobile Hackathon** (Feb–Mar 2026).

---

## The Problem

An estimated **$100B+ in crypto is permanently lost** when holders die unexpectedly or become incapacitated. Seed phrases vanish with their owners. Custodial solutions require trusting a third party. Legal processes take years and weren't designed for digital assets.

**There is no decentralized, trustless, autonomous inheritance solution — until now.**

---

## The Solution

Dead Man's Vault turns your Solana Seeker into an autonomous estate executor:

- **Heartbeat liveness checks** — Confirm you're alive with a single tap (weekly, bi-weekly, or monthly)
- **4-stage escalation** — Overdue → Emergency Alert → Final Warning → Execution
- **Automatic asset distribution** — Tokens sent to whitelisted beneficiaries at configured share percentages
- **Fully on-chain** — Anchor program enforces all rules. No server. No API. Just code
- **Reversible until execution** — Any heartbeat during stages 1–3 resets everything back to normal

---

## How It Works

```
┌─────────────┐     ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  Connect     │────>│  Configure   │────>│  Set          │────>│  Activate    │
│  Seeker      │     │  Beneficia-  │     │  Heartbeat   │     │  Vault       │
│  Wallet      │     │  ries + %    │     │  Interval    │     │  On-Chain    │
└─────────────┘     └──────────────┘     └──────────────┘     └──────┬───────┘
                                                                      │
                    ┌─────────────────────────────────────────────────┘
                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         VAULT ACTIVE — MONITORING                          │
│                                                                             │
│  Heartbeat confirmed ←──── Tap button periodically ────→ Timers reset      │
│                                                                             │
│  Heartbeat missed ──→ Stage 1 ──→ Stage 2 ──→ Stage 3 ──→ Stage 4         │
│                       Overdue     Emergency    FINAL        EXECUTE         │
│                       (amber)     Alert        WARNING      Assets sent     │
│                                   (amber)      (red)        to beneficia-   │
│                                                             ries            │
│  ↑                                                                          │
│  └── Any heartbeat during stages 1-3 resets to Stage 0 (healthy)           │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                    SOLANA SEEKER DEVICE                   │
│                                                          │
│  ┌─────────────────────┐  ┌───────────────────────────┐  │
│  │   React Native App  │  │   Seed Vault / MWA        │  │
│  │                     │  │   (Owner Wallet)           │  │
│  │  • 11 Screens       │  └───────────┬───────────────┘  │
│  │  • 6 Services       │              │ signs config txs  │
│  │  • Zustand Stores   │              │                   │
│  │  • SQLite DB        │  ┌───────────┴───────────────┐  │
│  │                     │  │   TEE Agent Key            │  │
│  │  Portfolio Scanner──│──│   (expo-secure-store)      │  │
│  │  Heartbeat Service──│──│   signs heartbeats +       │  │
│  │  Escalation Engine──│──│   execution txs            │  │
│  │  Execution Engine───│──│                            │  │
│  └─────────────────────┘  └───────────────────────────┘  │
│                                                          │
└──────────────────────────┬───────────────────────────────┘
                           │
                    RPC    │   On-chain transactions
                           ▼
┌──────────────────────────────────────────────────────────┐
│                    SOLANA DEVNET                          │
│                                                          │
│  ┌─────────────────────────────────────────────────────┐ │
│  │  Anchor Program: dead_mans_vault                    │ │
│  │  GXCu5964mvgAJDWmcMriZpzU3vDVqPzjYCM1sxCnsoEb     │ │
│  │                                                     │ │
│  │  PDAs:                                              │ │
│  │  • VaultConfig    ["vault", owner]                  │ │
│  │  • HeartbeatRecord ["heartbeat", vault]             │ │
│  │  • ExecutionLog    ["execution", vault]             │ │
│  │                                                     │ │
│  │  13 Instructions:                                   │ │
│  │  initialize_vault · update_vault · record_heartbeat │ │
│  │  execute_sol_distribution · execute_distribution    │ │
│  │  record_execution · rotate_agent · revoke_vault     │ │
│  │  withdraw_sol · withdraw_token · close_executed     │ │
│  │  close_executed_by_owner · close_revoked_vault      │ │
│  └─────────────────────────────────────────────────────┘ │
│                                                          │
│  External APIs: Helius DAS (tokens) · Jupiter (prices)   │
└──────────────────────────────────────────────────────────┘
```

### Design Principles

- **No backend server** — All logic runs on-device or on-chain
- **TEE-first security** — Agent signing key stored in hardware secure enclave
- **Idempotent execution** — Every distribution step checkpointed to SQLite; safe to retry after crash
- **Owner supremacy** — Owner can always override, revoke, or rotate agent authority
- **On-chain constraints** — Program enforces WHO can transfer, WHERE transfers go, WHEN they're allowed

### Two-Key Security Model

| Key | Storage | Signs | Purpose |
|-----|---------|-------|---------|
| **Owner** | Seed Vault (MWA) | `initialize_vault`, `update_vault`, `revoke_vault`, `rotate_agent`, `withdraw_sol`, `withdraw_token`, `close_executed_by_owner` | Full control over estate configuration |
| **Agent** | expo-secure-store (TEE) | `record_heartbeat`, `execute_sol_distribution`, `execute_distribution`, `record_execution`, `close_executed_vault` | Autonomous operations without owner approval |

The agent key can execute distributions **only** to addresses whitelisted in VaultConfig, and **only** after the on-chain grace period has elapsed. Even if the TEE is compromised, the program prevents unauthorized transfers.

---

## Tech Stack

| Technology | Version | Purpose |
|-----------|---------|---------|
| **Anchor** | 0.32.1 | On-chain program framework (Rust) |
| **Rust** | 1.93.1 | Program language |
| **React Native** | 0.76.9 | Mobile framework |
| **Expo** | SDK 52 | Build toolchain + native modules |
| **TypeScript** | 5.1.3 | App language |
| **@solana/web3.js** | 1.78.4 | Solana RPC + transactions |
| **@coral-xyz/anchor** | 0.32.1 | Anchor client SDK |
| **Mobile Wallet Adapter** | 2.2.2 | Seed Vault / wallet connection |
| **Zustand** | 5.0.11 | Reactive state management |
| **expo-sqlite** | 16.0.10 | Local persistence (heartbeats, execution log, settings) |
| **expo-secure-store** | 14.0.1 | TEE key storage |
| **expo-notifications** | 0.29.14 | Push notifications (3 Android channels) |
| **React Navigation** | 6.x | Tab + stack navigation |
| **TanStack Query** | 5.24.1 | Async data management |
| **Helius DAS API** | — | Token portfolio scanning |
| **Jupiter Price API** | — | Real-time USD pricing |

---

## Key Innovation

**First autonomous inheritance protocol on Solana Mobile.** No existing solution combines:

1. **On-device autonomy** — The app monitors, escalates, and executes entirely from the phone. No server to maintain, no API to depend on, no custodian to trust.

2. **Two-key security model** — Owner wallet (Seed Vault) for configuration. TEE agent key for autonomous execution. Separation of concerns prevents single-point compromise.

3. **Reversible escalation state machine** — Stages 1–3 are fully reversible with a single tap. Stage 4 (execution) is irreversible and on-chain enforced. This gives a ~3 month grace window on monthly heartbeats.

4. **Idempotent execution engine** — Every distribution step is checkpointed to SQLite before proceeding. App crash during execution? Restart and pick up exactly where you left off.

5. **Daily engagement loop** — The heartbeat creates a natural daily/weekly habit of checking your portfolio and confirming liveness. This is the "stickiness" — your vault is only as alive as your last heartbeat.

6. **Demo mode for judges** — Toggle in Settings (or tap version text 5 times). Compresses all timers to 30 seconds per stage so you can see the full escalation → execution flow in under 3 minutes.

---

## Demo

The app runs the complete flow on a physical Solana Seeker device:
1. Portfolio dashboard with live token balances and 24h price changes
2. Setup wizard: beneficiaries → heartbeat config → estate review → on-chain activation
3. Heartbeat confirmation with visual feedback
4. Full 4-stage escalation (using demo mode's 30s timers)
5. Autonomous execution with step-by-step transaction log

---

## Build Instructions

### Prerequisites

- **Node.js** 18+ and **Yarn**
- **Android Studio** with SDK 34+ (for local builds)
- **Rust** 1.93.1 and **Anchor CLI** 0.32.1 (for program development)
- **Solana CLI** 3.0.15 (Agave) configured for devnet
- An MWA-compatible wallet (e.g., Phantom, Solflare) on your device
- [Expo account](https://expo.dev/) (for EAS builds)

### Clone & Install

```bash
git clone https://github.com/PalatineArcOrg/DMV.git
cd DMV/dead-mans-vault

# Install program dependencies
yarn install

# Install app dependencies
cd app
yarn install
```

### Build the App

```bash
# Option A: EAS Cloud Build (recommended)
cd app
npx eas build --platform android --profile preview

# Option B: Local Build
cd app
npx expo prebuild --platform android
cd android && ./gradlew assembleRelease
```

### Program Development (optional)

```bash
# Build the Anchor program
anchor build

# Run program tests (34/34 passing)
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
| **Tests** | 34/34 passing |

---

## Project Stats

| Metric | Value |
|--------|-------|
| Anchor program (Rust) | 1,164 lines |
| Mobile app (TypeScript) | 15,883 lines |
| **Total code** | **17,047 lines** |
| Program instructions | 13 |
| Program error codes | 19 |
| App screens | 11 |
| App services | 6 |
| Zustand stores | 6 |
| SQLite tables | 6 |
| Program tests | 34/34 passing |

---

## Team

**Romulus** — Solo builder ([PalatineArcOrg](https://github.com/PalatineArcOrg))

---

## License

MIT
