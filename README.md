# Dead Man's Vault

An autonomous crypto inheritance protocol for Solana Seeker.

Dead Man's Vault monitors an owner's liveness through configurable heartbeat checks. When heartbeats stop, it escalates through a 4-stage warning system and then autonomously distributes assets to pre-configured beneficiaries — no backend server, no intermediaries.

**Built for the Monolith — Solana Mobile Hackathon (Feb 2 – Mar 9, 2026)**

---

## How It Works

```
Owner configures vault → Sets beneficiaries + heartbeat interval
                           ↓
Heartbeat monitoring   → Owner confirms liveness periodically
                           ↓ (missed heartbeat)
Stage 1: Reminder      → Notifications sent to owner
                           ↓ (no response)
Stage 2: Alert         → Emergency contacts notified
                           ↓ (no response)
Stage 3: Warning       → Final countdown, execution preview
                           ↓ (no response)
Stage 4: Execution     → Assets distributed to beneficiaries autonomously
```

Any heartbeat confirmation at Stages 1–3 resets the vault to normal. Stage 4 is irreversible.

---

## Features

- **4-stage escalation system** — Graduated warnings (Reminder → Alert → Warning → Execution) with configurable durations
- **On-chain heartbeat recording** — Every heartbeat confirmation is recorded on Solana devnet via the agent key
- **Mutable or immutable vaults** — Choose whether your vault can be revoked/updated, or make it permanent
- **Live portfolio tracking** — Token balances, USD values (via Jupiter), and 24h price changes
- **DeFi position detection** — Scans 10 protocols (Marinade, Jito, Sanctum, Kamino, Jupiter, Raydium, Orca, Meteora, MarginFi, native stake)
- **Heart monitor animation** — ECG-style EKG line that changes speed with escalation stage
- **Explorer integration** — All on-chain transactions link directly to Solana Explorer
- **Beneficiary management** — Add, edit, remove beneficiaries with percentage-based allocation
- **On-chain vault updates** — Edit beneficiaries and push changes on-chain via `update_vault`
- **Demo mode** — Fast escalation timers (30s stages) for testing on production builds
- **App lock** — Biometric/PIN authentication for app access
- **Autonomous execution** — Agent key (TEE-stored) handles distribution without user interaction at Stage 4

---

## Architecture

- **No backend server** — all logic runs on-device or on-chain
- **TEE-first security** — agent signing key stored in hardware secure enclave
- **Idempotent execution** — every step checkpointed to SQLite before proceeding
- **Owner supremacy** — owner can always override or revoke agent authority (unless immutable)
- **On-chain constraints** — program enforces rules even if the device is compromised

### Components

| Layer | Technology | Purpose |
|-------|-----------|---------|
| On-chain program | Anchor (Rust) | Enforces who can transfer, where, and when |
| Mobile app | React Native (Expo) | Orchestrates scanning, escalation, and execution |
| State management | Zustand + SQLite | Local persistence and crash recovery |
| Wallet integration | Solana Mobile MWA | Owner authorization via Seed Vault |
| Key management | Seeker TEE | Agent key for autonomous operations |
| Portfolio data | Helius DAS + Jupiter | Token balances, prices, DeFi positions |

---

## On-Chain Program

**Program ID:** `GXCu5964mvgAJDWmcMriZpzU3vDVqPzjYCM1sxCnsoEb` (Devnet)

### Instructions

| Instruction | Signer | Description |
|-------------|--------|-------------|
| `initialize_vault` | Owner | Create vault with beneficiaries, intervals, agent key, and mutability flag |
| `update_vault` | Owner | Modify estate plan (beneficiaries, intervals). Blocked on immutable vaults |
| `record_heartbeat` | Agent | Record liveness confirmation on-chain |
| `execute_distribution` | Agent | Transfer assets to a beneficiary |
| `record_execution` | Agent | Create immutable execution log |
| `rotate_agent` | Owner | Rotate agent key (device migration) with 5 security guards |
| `revoke_vault` | Owner | Emergency deactivation. Blocked on immutable vaults |

### Account Structure

| Account | Seeds | Purpose |
|---------|-------|---------|
| `VaultConfig` | `["vault", owner]` | Core configuration, beneficiary whitelist, mutability flag |
| `HeartbeatRecord` | `["heartbeat", vault]` | Heartbeat timestamps and counters |
| `ExecutionLog` | `["execution", vault]` | Immutable distribution record |

### Error Codes

15 custom error codes covering: interval validation, share allocation, signer authorization, vault state guards, beneficiary whitelist enforcement, and immutability protection.

---

## Mobile App

### Screens (4 tabs)

| Tab | Screens | Purpose |
|-----|---------|---------|
| **Status** | Dashboard, Execution Log | Heartbeat button, portfolio overview, vault status, escalation banner |
| **Assets** | Assets Overview | Token list with prices, DeFi positions with protocol detection |
| **Setup** | Welcome, Beneficiaries, Heartbeat Config, DeFi Positions, Estate Review | 4-step vault creation wizard |
| **Settings** | Settings | Wallet, vault contract info, edit/update vault, revoke, demo mode, app lock |

### Services

| Service | Purpose |
|---------|---------|
| **HeartbeatService** | Records confirmations to SQLite, tracks overdue status, monitors on-chain wallet activity |
| **EscalationService** | Autonomous state machine evaluating every 60s, transitions through 4 stages, triggers execution |
| **ExecutionService** | 8-step idempotent execution engine with SQLite checkpointing and crash recovery |
| **VaultTransactionService** | Builds and sends all on-chain transactions (init, heartbeat, update, revoke, execute, rotate) |
| **KeyManager** | Agent keypair lifecycle via expo-secure-store (TEE on Seeker) |
| **NotificationService** | 3 Android channels (heartbeat/HIGH, escalation/MAX, execution/MAX) with frequency caps |
| **PortfolioScanner** | Token balances via Helius DAS API, USD prices via Jupiter, DeFi position detection |
| **MigrationService** | Detects device migration (on-chain vault exists but no local agent key) and triggers rotation |

---

## Tech Stack

| Component | Version |
|-----------|---------|
| Anchor | 0.32.1 |
| Solana CLI | 3.0.15 (Agave) |
| Rust | 1.93.1 |
| Expo SDK | 52 |
| React Native | 0.76.9 |
| @solana/web3.js | 1.78+ |
| @coral-xyz/anchor | 0.30.1 |
| TypeScript | 5.x |

---

## Project Structure

```
dead-mans-vault/
├── programs/dead-mans-vault/src/   # Anchor program (Rust)
│   ├── instructions/               # 7 instruction handlers
│   ├── state/                      # Account definitions (VaultConfig, HeartbeatRecord, ExecutionLog)
│   ├── errors.rs                   # 15 error codes
│   └── constants.rs                # On-chain constants
├── tests/                          # Anchor program tests (23/23 passing)
└── app/                            # React Native mobile app (Expo SDK 52)
    └── src/
        ├── services/               # HeartbeatService, EscalationService, ExecutionService, etc.
        ├── notifications/          # NotificationService (3 Android channels)
        ├── screens/                # Dashboard, Assets, Setup wizard (5 screens), Settings
        ├── components/             # HeartbeatButton, EcgLine, StatusIndicator, StepIndicator, etc.
        ├── hooks/                  # useWallet, useHeartbeat, usePortfolio, useVaultProgram
        ├── store/                  # Zustand stores (vault, heartbeat, escalation, demo, auth)
        ├── tee/                    # KeyManager (TEE agent key management)
        ├── db/                     # SQLite database layer (4 tables + repos)
        ├── defi/                   # DeFi protocol integrations
        ├── types/                  # TypeScript type definitions
        └── utils/                  # Constants, formatting, validation, IDL
```

---

## Development

### Prerequisites

- Solana CLI 3.0.x
- Anchor 0.32.x
- Rust 1.93+
- Node.js 18+
- Yarn
- Java 17 (for Android builds)

### Build Program

```bash
cd dead-mans-vault
anchor build
anchor deploy --provider.cluster devnet
```

### Run Tests

```bash
cd dead-mans-vault
anchor test
```

### Build App (APK)

```bash
cd dead-mans-vault/app
yarn install
npx tsc --noEmit          # Type check
npx expo prebuild --platform android --clean
cd android && ./gradlew assembleRelease
```

APK output: `android/app/build/outputs/apk/release/app-release.apk`

---

## Network

Currently deployed to **Solana Devnet** for hackathon scope.

---

## License

MIT
