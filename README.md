# Dead Man's Vault

An autonomous crypto inheritance protocol for Solana Seeker.

Dead Man's Vault monitors an owner's liveness through configurable heartbeat checks. When heartbeats stop, it escalates through a 4-stage warning system and then autonomously distributes assets to pre-configured beneficiaries — no backend server, no intermediaries.

**Built for the Monolith — Solana Mobile Hackathon (Feb 2 -- Mar 9, 2026)**

---

## How It Works

```
Owner configures vault --> Sets beneficiaries + heartbeat interval
                           |
Heartbeat monitoring   --> Owner confirms liveness periodically
                           | (missed heartbeat)
Stage 1: Reminder      --> Notifications sent to owner
                           | (no response)
Stage 2: Alert         --> Emergency contacts notified
                           | (no response)
Stage 3: Warning       --> Final countdown, execution preview
                           | (no response)
Stage 4: Execution     --> Assets distributed to beneficiaries autonomously
```

Any heartbeat confirmation at Stages 1--3 resets the vault to normal. Stage 4 is irreversible.

---

## Features

### Core
- **4-stage escalation system** -- Graduated warnings (Reminder -> Alert -> Warning -> Execution) with configurable durations
- **On-chain heartbeat recording** -- Every heartbeat confirmation is recorded on Solana via the agent key
- **Mutable or immutable vaults** -- Choose whether your vault can be revoked/updated, or make it permanent
- **Autonomous execution** -- Agent key (TEE-stored) handles distribution without user interaction at Stage 4
- **Durable nonce pre-signed distribution** -- Owner pre-signs distribution TX during vault setup; agent submits atomically at Stage 4 with no wallet interaction
- **Idempotent crash recovery** -- Every execution step checkpointed to SQLite before proceeding
- **Clean vault lifecycle** -- Revoking closes on-chain PDAs and reclaims rent; re-initialization on the same wallet works atomically

### Portfolio & DeFi
- **Live portfolio tracking** -- Token balances via Helius DAS API, USD prices via dual oracle (Pyth Hermes + Jupiter fallback), 24h price changes
- **DeFi position detection** -- Scans 10 protocols across 3 detection layers (token mint matching, program account scanning, Helius Enhanced TX history)
- **Supported protocols** -- Marinade, Jito, Sanctum (9 LST variants), Kamino, Jupiter, Raydium, Orca, Meteora, MarginFi, native stake

### Security
- **Biometric app lock** -- Optional biometric/PIN authentication for app access
- **Wallet isolation** -- Automatic state reset on wallet change to prevent cross-wallet vault access
- **Device migration** -- Detects missing agent key and triggers on-chain `rotate_agent` with 5 security guards

### UX
- **Heart monitor animation** -- ECG-style line that changes speed with escalation stage
- **Explorer integration** -- All on-chain transactions link directly to Solana Explorer
- **Beneficiary management** -- Add, edit, remove beneficiaries with percentage-based allocation
- **Demo mode** -- Fast escalation timers (30s stages) for testing on production builds

---

## Architecture

- **No backend server** -- all logic runs on-device or on-chain
- **TEE-first security** -- agent signing key stored in hardware secure enclave
- **Idempotent execution** -- every step checkpointed to SQLite before proceeding
- **Owner supremacy** -- owner can always override or revoke agent authority (unless immutable)
- **On-chain constraints** -- program enforces rules even if the device is compromised

### Components

| Layer | Technology | Purpose |
|-------|-----------|---------|
| On-chain program | Anchor 0.32.1 (Rust) | Enforces who can transfer, where, and when |
| Mobile app | React Native (Expo SDK 52) | Orchestrates scanning, escalation, and execution |
| State management | Zustand + SQLite | Local persistence and crash recovery |
| Wallet integration | Solana Mobile MWA | Owner authorization via Seed Vault |
| Key management | Seeker TEE | Agent key for autonomous operations |
| Portfolio data | Helius DAS API | Token balances and metadata |
| Price oracles | Pyth Hermes + Jupiter | Dual-source USD pricing with 60s cache |
| DeFi detection | Helius Enhanced TX + on-chain scanning | Protocol position discovery |
| Transaction landing | Helius Priority Fee API | Dynamic fee estimation per instruction |

---

## External API Integrations

### Helius

| API | Usage |
|-----|-------|
| DAS `getAssetsByOwner` | Fetches all fungible token balances in a single paginated JSON-RPC call |
| Enhanced Transactions | Discovers DeFi protocol interactions via transaction history (cursor-based pagination, up to 150 txs) |
| `getPriorityFeeEstimate` | Dynamic priority fee estimation for reliable transaction landing |

All Helius endpoints auto-derive devnet/mainnet prefix from the configured RPC URL — zero-config network switching.

### Pyth Hermes

| API | Usage |
|-----|-------|
| `/v2/price_feeds` | Resolves token symbols to Pyth feed IDs (cached in-memory per session) |
| `/v2/updates/price/latest` | Batch price fetches with expo-based price parsing |

60-second TTL price cache prevents redundant network calls. Symbols with no Pyth feed are tracked to avoid repeated lookups.

### Jupiter

| API | Usage |
|-----|-------|
| Price API v2 | Fallback USD pricing for tokens not covered by Pyth |

### Retry & Rate Limiting

All external API calls use exponential backoff with jitter on HTTP 429 (rate limit). `fetchWithRetry` for REST, `rpcWithRetry` for JSON-RPC 2.0.

---

## On-Chain Program

**Program ID:** `GXCu5964mvgAJDWmcMriZpzU3vDVqPzjYCM1sxCnsoEb` (Devnet)

### Instructions

| Instruction | Signer | Description |
|-------------|--------|-------------|
| `initialize_vault` | Owner | Create vault with beneficiaries, intervals, agent key, and mutability flag |
| `update_vault` | Owner | Modify estate plan (beneficiaries, intervals). Blocked on immutable vaults |
| `record_heartbeat` | Agent | Record liveness confirmation on-chain |
| `execute_distribution` | Agent | Transfer SOL to a beneficiary (BN precision arithmetic) |
| `record_execution` | Agent | Create immutable execution log, deactivate vault |
| `rotate_agent` | Owner | Rotate agent key (device migration) with 5 security guards |
| `revoke_vault` | Owner | Close vault + heartbeat PDAs, reclaim rent. Blocked on immutable vaults |
| `close_revoked_vault` | Owner | Clean up zombie vaults revoked under older program versions |

All transactions include per-instruction compute unit limits and dynamic priority fees for reliable landing.

### Account Structure

| Account | Seeds | Purpose |
|---------|-------|---------|
| `VaultConfig` | `["vault", owner]` | Core configuration, beneficiary whitelist, mutability flag |
| `HeartbeatRecord` | `["heartbeat", vault]` | Heartbeat timestamps and counters |
| `ExecutionLog` | `["execution", vault]` | Immutable distribution record |

### Error Codes

16 custom error codes covering: interval validation, share allocation, signer authorization, vault state guards, beneficiary whitelist enforcement, immutability protection, and vault lifecycle management.

### Tests

30/30 tests passing -- covers happy paths, all error cases, rotate_agent security guards, execution flow, double-execution prevention, vault revoke/close lifecycle, and re-initialization after revoke.

---

## Mobile App

### Screens (4 tabs)

| Tab | Screens | Purpose |
|-----|---------|---------|
| **Status** | Dashboard, Execution Log | Heartbeat button, portfolio overview, vault status, escalation banner |
| **Assets** | Assets Overview | Token list with live prices, DeFi positions grouped by protocol with closure strategies |
| **Setup** | Welcome, Beneficiaries, Heartbeat Config, DeFi Positions, Estate Review | 4-step vault creation wizard with step indicator |
| **Settings** | Settings | Wallet info, vault contract details, edit/update vault, revoke, demo mode, app lock |

Authentication screen guards app access with biometric/PIN when enabled.

### Services

| Service | Purpose |
|---------|---------|
| **BackgroundAgent** | Singleton orchestrator for heartbeat monitoring and escalation evaluation |
| **HeartbeatService** | Records confirmations to SQLite, tracks overdue status, monitors on-chain wallet activity |
| **EscalationService** | Autonomous state machine evaluating every 60s (10s in demo), transitions through 4 stages |
| **ExecutionService** | 8-step idempotent execution engine with pre-signed durable nonce distribution and SQLite checkpointing |
| **VaultTransactionService** | Builds and sends all on-chain transactions with priority fees and raw byte parsing fallback |
| **KeyManager** | Agent keypair + pre-signed TX + nonce account lifecycle via expo-secure-store (TEE on Seeker) |
| **NotificationService** | 3 Android channels (heartbeat/HIGH, escalation/MAX, execution/MAX) with frequency caps |
| **PortfolioScanner** | Token balances via Helius DAS, dual-oracle pricing (Pyth + Jupiter), DeFi detection |
| **MigrationService** | Detects device migration and triggers on-chain agent rotation |

### DeFi Detection (3 layers)

| Layer | Method | Protocols |
|-------|--------|-----------|
| **Token mint matching** | Zero RPC calls, instant | Marinade, Jito, Sanctum (9 variants), Jupiter JLP, Kamino kSOL |
| **Program account scanning** | RPC getProgramAccounts | Orca Whirlpools, Meteora DLMM, MarginFi V2, Kamino Lending, Raydium CLMM, Native Stake |
| **Transaction history** | Helius Enhanced TX API | Any protocol with recent wallet activity |

Positions are deduplicated by protocol+account. Real positions take priority over activity-detected hints.

---

## Hermes Engine Compatibility

React Native's Hermes runtime requires several workarounds:

- **Polyfills** -- `Buffer`, `crypto` (via expo-crypto), `structuredClone` (JSON-based)
- **No BigInt** -- Anchor deserialization may silently fail; raw `getAccountInfo` fallback used
- **Raw byte parsing** -- `VaultTransactionService.parseVaultConfigRaw()` decodes vault state directly from account bytes when Anchor's coder fails on Hermes

---

## Tech Stack

| Component | Version |
|-----------|---------|
| Anchor | 0.32.1 |
| Solana CLI | 3.0.15 (Agave) |
| Rust | 1.93.1 |
| Expo SDK | 52 |
| React Native | 0.76.9 |
| @solana/web3.js | 1.x |
| @coral-xyz/anchor | 0.32.1 |
| TypeScript | 5.x |

---

## Project Structure

```
dead-mans-vault/
+-- programs/dead-mans-vault/src/    # Anchor program (Rust)
|   +-- instructions/                # 8 instruction handlers
|   +-- state/                       # Account definitions
|   +-- errors.rs                    # 16 error codes
|   +-- constants.rs                 # On-chain constants
+-- tests/                           # Anchor program tests (30/30 passing)
+-- app/                             # React Native mobile app (Expo SDK 52)
    +-- src/
        +-- services/                # HeartbeatService, EscalationService, ExecutionService, etc.
        +-- notifications/           # NotificationService (3 Android channels)
        +-- screens/                 # Dashboard, Assets, Setup wizard (5 screens), Settings, Auth
        +-- components/              # HeartbeatButton, EcgLine, StatusIndicator, StepIndicator, etc.
        +-- hooks/                   # useWallet, useHeartbeat, usePortfolio, useVaultProgram
        +-- store/                   # Zustand stores (vault, heartbeat, escalation, demo, auth)
        +-- tee/                     # KeyManager (TEE agent key management)
        +-- db/                      # SQLite database layer (6 tables + repos)
        +-- defi/                    # DeFi protocol detectors + registry
        +-- types/                   # TypeScript type definitions + API interfaces
        +-- utils/                   # Constants, formatting, validation, IDL, fetchWithRetry
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
npx tsc --noEmit          # Type check (0 errors expected)
npx expo prebuild --platform android --clean
cd android && ./gradlew assembleRelease
```

APK output: `android/app/build/outputs/apk/release/app-release.apk`

---

## Network

Currently deployed to **Solana Devnet**. All endpoints auto-derive network prefix from the configured RPC URL for future mainnet migration.

---

## License

MIT
