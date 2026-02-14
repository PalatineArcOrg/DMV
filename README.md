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
Stage 2: Alert         → Emergency contacts notified on-chain
                           ↓ (no response)
Stage 3: Warning       → Final countdown, execution preview
                           ↓ (no response)
Stage 4: Execution     → Assets distributed to beneficiaries autonomously
```

Any heartbeat confirmation at Stages 1–3 resets the vault to normal. Stage 4 is irreversible.

---

## Architecture

- **No backend server** — all logic runs on-device or on-chain
- **TEE-first security** — agent signing key stored in hardware secure enclave
- **Idempotent execution** — every step checkpointed to SQLite before proceeding
- **Owner supremacy** — owner can always override or revoke agent authority
- **On-chain constraints** — program enforces rules even if the device is compromised

### Components

| Layer | Technology | Purpose |
|-------|-----------|---------|
| On-chain program | Anchor (Rust) | Enforces who can transfer, where, and when |
| Mobile app | React Native (Expo) | Orchestrates scanning, escalation, and execution |
| State management | Zustand + SQLite | Local persistence and crash recovery |
| Wallet integration | Solana Mobile MWA | Owner authorization via Seed Vault |
| Key management | Seeker TEE | Agent key for autonomous operations |

---

## On-Chain Program

**Program ID:** `GXCu5964mvgAJDWmcMriZpzU3vDVqPzjYCM1sxCnsoEb` (Devnet)

### Instructions

| Instruction | Signer | Description |
|-------------|--------|-------------|
| `initialize_vault` | Owner | Create vault with beneficiaries, intervals, and agent key |
| `update_vault` | Owner | Modify estate plan configuration |
| `record_heartbeat` | Agent | Record liveness confirmation on-chain |
| `execute_distribution` | Agent | Transfer assets to a beneficiary |
| `record_execution` | Agent | Create immutable execution log |
| `rotate_agent` | Owner | Rotate agent key (device migration) |
| `revoke_vault` | Owner | Emergency deactivation |

### Account Structure

| Account | Seeds | Purpose |
|---------|-------|---------|
| `VaultConfig` | `["vault", owner]` | Core configuration and beneficiary whitelist |
| `HeartbeatRecord` | `["heartbeat", vault]` | Heartbeat timestamps and counters |
| `ExecutionLog` | `["execution", vault]` | Immutable distribution record |

---

## Mobile App

### Screens

- **Dashboard** — Status orb, heartbeat button, portfolio overview, escalation banner
- **Setup** — Heartbeat configuration, beneficiary management (WIP)
- **Settings** — Wallet info, program ID, RPC endpoint

### Services

- **HeartbeatService** — Records confirmations, tracks overdue status, monitors on-chain activity
- **EscalationService** — Autonomous state machine evaluating every 60s, transitions through 4 stages
- **NotificationService** — Android notification channels with stage-appropriate urgency
- **PortfolioScanner** — Token balances via Helius DAS API, USD prices via Jupiter

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
| TypeScript | 5.x |

---

## Project Structure

```
dead-mans-vault/
├── programs/dead-mans-vault/src/   # Anchor program (Rust)
│   ├── instructions/               # 7 instruction handlers
│   ├── state/                      # Account definitions
│   ├── errors.rs                   # 15 error codes
│   └── constants.rs                # On-chain constants
├── tests/                          # Anchor program tests (23/23 passing)
└── app/                            # React Native mobile app
    └── src/
        ├── services/               # HeartbeatService, EscalationService, etc.
        ├── notifications/          # NotificationService
        ├── screens/                # Dashboard, Setup, Settings
        ├── components/             # StatusIndicator, HeartbeatButton, etc.
        ├── hooks/                  # useWallet, useVaultProgram, useHeartbeat, etc.
        ├── store/                  # Zustand stores
        ├── db/                     # SQLite database layer
        ├── types/                  # TypeScript type definitions
        └── utils/                  # Constants, formatting, IDL
```

---

## Development

### Prerequisites

- Solana CLI 3.0.x
- Anchor 0.32.x
- Rust 1.93+
- Node.js 18+
- Yarn

### Build Program

```bash
cd dead-mans-vault
anchor build
```

### Run Tests

```bash
anchor test
```

### Build App

```bash
cd dead-mans-vault/app
yarn install
npx tsc --noEmit  # Type check
```

---

## Network

Currently deployed to **Solana Devnet** for hackathon scope.

---

## License

MIT
