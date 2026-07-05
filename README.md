# Dead Man's Vault

An autonomous crypto inheritance protocol on Solana — built for the Seeker, runs on any modern Android.

Dead Man's Vault monitors an owner's liveness through configurable heartbeat checks. When heartbeats stop, it escalates through a 4-stage warning system and then distributes assets to pre-configured beneficiaries.

**Execution is permissionless and trustless.** Once the grace period elapses, the on-chain program computes every payout from on-chain state, and *anyone* — the app, a beneficiary, or a keyless watcher — can submit the distribution. The caller controls nothing: funds can only go to the pre-set beneficiaries, in the pre-set proportions, after the deadline. A bundled keyless watcher service distributes automatically even if the owner's app is never reopened — so the dead-man's switch actually fires.

Owners can also leave **specific bequests** — exact SOL or SPL token amounts, or whole NFTs, assigned to particular beneficiaries — carved out before the remainder splits pro-rata by share.

Vault creation charges a one-time **0.01 SOL fee**, collected on-chain by `initialize_vault` (a `fee_recipient` account pinned by address + a CPI transfer, so it cannot be bypassed). Total activation cost is **≈ 0.028 SOL** (rent + 0.005 agent funding + fee + 0.005 keeper reward).

**Built for the Monolith — Solana Mobile Hackathon (Feb 2 -- Mar 9, 2026)**

### Demo Videos

- **Short Demo** (2 min): https://www.youtube.com/shorts/LetYFctqcvM
- **Full Vault Cycle** (4 min): https://www.youtube.com/watch?v=p2dqby2mJcc

### Links

- **Website**: [dmv.palatinearc.com](https://dmv.palatinearc.com)
- **Download APK**: [GitHub Releases](https://github.com/Romulus-Sol/DMV/releases/latest) (latest: v1.13.8)
- **Program on Explorer**: [GXCu5964...soEb (Devnet)](https://explorer.solana.com/address/GXCu5964mvgAJDWmcMriZpzU3vDVqPzjYCM1sxCnsoEb?cluster=devnet)

### Device Compatibility

Runs on **any modern Android phone** — owner signing uses standard [Mobile Wallet Adapter](https://docs.solanamobile.com/) (Phantom, Solflare, or any MWA wallet), and the agent's heartbeat key uses the Android Keystore via `expo-secure-store`. There is no Seed-Vault-specific code. The Solana **Seeker** is the recommended device (its Seed Vault gives the strongest owner-key custody), but it is **not required** — and because execution is permissionless and off-device, the inheritance fires even if the owner's phone is lost, dead, or was never a Seeker. Android-only for now (the app uses MWA, which is Android-only); iOS is not yet supported. The release APK is `arm64-v8a`, covering effectively all current Android phones.

---

## How It Works

```
Owner configures vault --> Sets beneficiaries + heartbeat interval
                           |
Heartbeat monitoring   --> Owner confirms liveness periodically
                           | (missed heartbeat)
Stage 1: Reminder      --> Push notification to owner (heartbeat due)
                           | (no response)
Stage 2: Alert         --> Push notification to owner (heartbeat overdue)
                           | (no response)
Stage 3: Warning       --> Final countdown, execution preview
                           | (no response — grace period elapses)
Stage 4: Execution     --> Permissionless distribution: anyone (app / beneficiary /
                           keyless watcher) cranks payouts computed on-chain
```

Any heartbeat confirmation at Stages 1--3 resets the vault to normal. Once grace elapses the vault is frozen to owner mutations and Stage 4 is irreversible.

---

## Features

### Core
- **Permissionless autonomous execution** -- After grace, the program computes every payout from on-chain state; the app, a beneficiary, or a keyless watcher can submit it. No trusted trigger, no server holding keys, no app required for the switch to fire.
- **Specific bequests + pro-rata** -- Assign exact SOL or SPL token amounts, or whole NFTs, to specific beneficiaries (carved out first); the remainder splits pro-rata by share. A beneficiary can receive both.
- **Beneficiary claim** -- Heirs can trigger a matured vault's distribution from their own wallet. The in-app **Inheritances** screen auto-discovers every vault where the connected wallet is a beneficiary (plus manual import by owner address) and runs the same permissionless crank, MWA-signed, with the heir paying fees. No owner or server action required.
- **On-chain keeper bounty** -- Each vault can reserve a small reward (default 0.005 SOL) paid by the program to whoever cranks `finalize_execution`, making permissionless cranking profitable. It is carved out of the SOL snapshot at execution start, so it never reduces beneficiary payouts.
- **Permissionless cleanup (no stranded rent)** -- After execution, a 24-hour owner-exclusive window lets a living owner close the vault and reclaim its rents; after that, `close_executed_vault` lets *anyone* close the accounts and claim the rents (~0.01–0.03 SOL) as a cleanup reward — nothing strands with a dead owner. SOL dust still goes to the largest-share beneficiary.
- **Standalone keeper bot** (`keeper-bot/`) -- A self-contained bot anyone can run: it discovers expired vaults straight from the chain, runs the permissionless crank, and earns the bounty + cleanup rents. Every keeper running strengthens the guarantee that every vault fires — no DMV server required.
- **NFT support end-to-end** -- NFTs are scanned into the portfolio, deposited into the vault as whole units, and bequeathed to specific heirs via `execute_specific_asset`. Names and images resolve **with or without Helius DAS** — an RPC-only fallback reads each NFT's on-chain Metaplex Metadata account directly (compressed NFTs remain DAS-only) and caches the result. The Assets tab has a dedicated Tokens · NFTs · DeFi split, the Dashboard shows inline NFT and DeFi sections, and the vault's own asset view and Bequests picker show each NFT's name + thumbnail (not just a mint address).
- **4-stage escalation system** -- Graduated warnings (Reminder -> Alert -> Warning -> Execution) with configurable durations
- **On-chain heartbeat recording** -- Every heartbeat confirmation is recorded on Solana via the agent key (the agent signs heartbeats only)
- **Mutable or immutable vaults** -- Choose whether your vault can be revoked/updated, or make it permanent
- **Frozen snapshots + idempotent masks** -- Residuals are snapshotted write-once at execution start; per-asset bitmasks make every payout idempotent and safely resumable by anyone after a crash
- **Vault PDA asset storage** -- Owner deposits SOL / SPL tokens / NFTs into the vault PDA; distribution computes shares on-chain at Stage 4
- **Owner supremacy (pre-grace)** -- Revoking closes on-chain PDAs and reclaims rent; re-initialization on the same wallet works atomically. All owner mutations freeze once the deadline is reached.
- **Token-2022 support** -- Distribution handles both the legacy Token program and Token-2022 via `InterfaceAccount`

### Portfolio & DeFi
- **Live portfolio tracking** -- Token balances via Helius DAS API, USD prices via dual oracle (Pyth Hermes + Jupiter fallback), 24h price changes
- **Custom RPC endpoint** -- The app ships with a default RPC but lets you set your own (Settings → Network, with Test / Save / Reset). Useful for avoiding public-RPC rate limits during portfolio scans and cranks; a "network busy" banner surfaces on rate-limit and links straight to the setting.
- **DeFi position detection** -- Scans 10 protocols across 3 detection layers (token mint matching, program account scanning, Helius Enhanced TX history)
- **Supported protocols** -- Marinade, Jito, Sanctum (9 LST variants), Kamino, Jupiter, Raydium, Orca, Meteora, MarginFi, native stake

### Security
- **Biometric app lock** -- Optional biometric/PIN authentication for app access
- **Wallet isolation** -- Automatic state reset on wallet change to prevent cross-wallet vault access
- **Device migration** -- Detects missing agent key and triggers on-chain `rotate_agent` with 5 security guards

### Notifications
- **Stage-aware push notifications** -- Each escalation stage triggers a specific notification with contextual details (time overdue, beneficiary count, time remaining)
- **Server-driven delivery (single source)** -- The keyless watcher service is the sole source of escalation alerts: it watches each registered vault's heartbeat on-chain and pushes stage alerts via FCM, so they arrive even when the app is killed and there are no duplicates. (Earlier builds also pre-scheduled a local OS timeline; that was removed in v1.7.3 because it double-fired alongside the server.)
- **Execution progress** -- "Estate plan executing" at Stage 4 and an "Estate plan complete" push once autonomous distribution finalizes on-chain (sent by the watcher — the app may never run), plus failure notifications from app-driven cranks
- **Heartbeat confirmation** -- Notification confirms heartbeat with next due date
- **Foreground display** -- Notifications render in-app via foreground notification handler

### UX
- **Heart monitor animation** -- ECG-style line that changes speed with escalation stage
- **Explorer integration** -- All on-chain transactions link directly to Solana Explorer
- **Beneficiary management** -- Add, edit, remove beneficiaries with percentage-based allocation
- **Demo mode** -- Fast escalation timers (30s stages) for testing on production builds

---

## Architecture

- **Permissionless execution** -- after grace, payouts are computed entirely on-chain; any signer can submit them and controls nothing
- **Optional keyless watcher** -- a bundled keyless service distributes automatically when the app is closed; the app remains fully self-sufficient. Neither holds authority over funds.
- **Hardware-backed key storage** -- agent signing key stored in the Android Keystore (`expo-secure-store`) behind a biometric/device-credential gate; signs heartbeats only, never fund movement
- **Idempotent, resumable execution** -- on-chain bitmasks are the authoritative idempotency layer; a partial crank is safely resumed by anyone
- **Owner supremacy (pre-grace)** -- owner can override or revoke authority until the deadline, after which the vault freezes
- **On-chain constraints** -- program enforces who/where/when/how-much even if a device is compromised

### Components

| Layer | Technology | Purpose |
|-------|-----------|---------|
| On-chain program | Anchor 0.32.1 (Rust) | Computes payouts; enforces who/where/when/how-much |
| Mobile app | React Native (Expo SDK 52) | Orchestrates scanning, escalation, and the execution crank |
| Keyless watcher | Node.js (Express + SQLite) | Pushes escalation alerts and autonomously cranks distribution after grace |
| Keeper bot | Node.js (standalone, `keeper-bot/`) | Independently scans for expired vaults, cranks them, and collects bounty + cleanup rents |
| State management | Zustand + SQLite | Local persistence and crash recovery |
| Wallet integration | Solana Mobile MWA | Owner authorization via Seed Vault |
| Key management | Android Keystore (`expo-secure-store`), biometric-gated | Agent heartbeat-signing key (Seeker Seed Vault optional) |
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

All Helius endpoints auto-derive their devnet/mainnet prefix from the active RPC URL (resolved through `rpcConfig`, which also derives the Helius API key from the RPC URL when no standalone key is set) — zero-config network switching, and the RPC URL is user-overridable at runtime via Settings → Network.

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

**Owner / setup** (all freeze once the grace deadline is reached):

| Instruction | Signer | Description |
|-------------|--------|-------------|
| `initialize_vault` | Owner | Create vault with beneficiaries (`{wallet, share_bps}`), intervals, agent key, mutability flag, and optional `keeper_bounty`. Collects a 0.01 SOL creation fee to `FEE_WALLET` via CPI (`fee_recipient` pinned by `address` constraint) |
| `update_vault` | Owner | Modify plan (beneficiaries, intervals). Blocked on immutable vaults / once a plan exists |
| `set_asset_plan` / `update_asset_plan` | Owner | Define specific bequests (SOL + SPL + NFT) assigned to beneficiaries |
| `record_heartbeat` | Agent | Record liveness confirmation on-chain (heartbeats only) |
| `rotate_agent` | Owner | Rotate agent key (device migration) with 6 security guards |
| `withdraw_sol_from_vault` / `withdraw_from_vault` | Owner | Withdraw SOL / SPL from the vault PDA back to owner |
| `revoke_vault` | Owner | Close vault PDAs (+ asset plan), reclaim rent. Blocked on immutable vaults |
| `close_executed_vault_by_owner` | Owner | Final core-PDA close after execution; sweeps SOL dust to largest-share beneficiary, rent to owner |
| `close_revoked_vault` | Owner | Clean up zombie vaults from older program versions |

**Permissionless execution** (`payer` = any signer; gated on grace + on-chain masks):

| Instruction | Description |
|-------------|-------------|
| `begin_execution` | Snapshot the SOL residual (carving out any specific-SOL bequests **and the keeper bounty**); takes an optional `asset_plan` account (pass the PDA when a plan exists, else `null`). Its existence proves grace for all downstream ix |
| `begin_token_dist` | Snapshot a mint's residual (balance − specific bequests) from the canonical, anti-spoof vault ATA |
| `execute_specific_asset` | Pay one specific bequest (SPL/NFT) to its assigned beneficiary, in order |
| `execute_specific_sol` | Pay one specific-SOL bequest (zero-pubkey sentinel mint) to its assigned beneficiary by direct lamport debit |
| `execute_sol_shares` | Batched SOL pro-rata payout by `share_bps` |
| `execute_token_shares` | Batched token residual pro-rata payout (`transfer_checked`) |
| `finalize_execution` | Mark executed once all SOL + bequest masks are full |
| `close_token_dist` | Sweep dust to the largest-share beneficiary, close the vault ATA + dist record |
| `close_executed_vault` | After execution + a 24-hour owner-exclusive window (`CloseDelayNotElapsed` before it), close the core PDAs — rents pay the closer, dust goes to the largest-share beneficiary. Un-strands a dead owner's rent and pays keepers for cleanup |

All transactions include per-instruction compute unit limits and dynamic priority fees for reliable landing.

### Account Structure

| Account | Seeds | Purpose |
|---------|-------|---------|
| `VaultConfig` | `["vault", owner]` | Core config, beneficiary whitelist (`{wallet, share_bps}`), mutability flag, `keeper_bounty` (from padding — non-breaking) |
| `HeartbeatRecord` | `["heartbeat", vault]` | Heartbeat timestamps and counters |
| `ExecutionLog` | `["execution", vault]` | SOL snapshot + paid-mask; existence marks execution begun |
| `AssetPlan` | `["asset_plan", vault]` | Owner-defined specific bequests (≤64 assignments, u64 paid-mask) |
| `TokenDist` | `["token_dist", vault, mint]` | Per-mint residual snapshot + paid-mask |

### Error Codes

41 custom error codes covering interval/share validation, signer authorization, the creation-fee recipient (`InvalidFeeRecipient`), specific-bequest shape including SOL bequests (`InvalidSolBequest`), the permissionless guards (index-equality recipients, mint/ATA pinning, anti-spoof canonical ATA, in-order bequests, mask state), the post-grace freeze, the owner-exclusive close window (`CloseDelayNotElapsed`), and vault lifecycle.

### Security

The permissionless design was hardened by a multi-agent security review — including a **CRITICAL** fund-misdirection bug (a caller-supplied token-program could spoof a mint's residual snapshot to zero) found and fixed before deploy.

A second **pre-mainnet** review across the program, the keyless watcher, and the app's key storage produced further fixes (see the CHANGELOG "Security hardening" entry): the canonical-ATA anti-spoof was extended to `execute_specific_asset` (a specific bequest could otherwise be misdirected), the production heartbeat/grace minimums (1 day / 7 days) are the default build (demo floors gated behind a `devnet` feature), the keeper bounty is capped on-chain, and checks-effects-interactions ordering blocks transfer-hook reentrancy. The watcher is fail-closed on auth, ownership-proofs registrations on-chain, rate-limits public reads, and bounds cranker spend; the app's agent key is biometric-gated and backup-excluded. A program **redeploy + IDL upgrade** and a **new APK build** apply the program/app fixes; the watcher fixes are deployed.

### Tests

29/29 tests passing -- a *random keypair* drives the full permissionless flow end-to-end (SOL pro-rata, specific SOL + SPL + NFT bequests, Token-2022, dust→largest beneficiary, keeper bounty carved out + paid to the finalize cranker), plus theft-attempt rejections (wrong beneficiary, substituted ATA, out-of-order bequest, ATA spoof, wrong fee recipient), owner Token-2022 withdrawal, idempotency/resume, the post-grace freeze, the permissionless close (blocked inside the owner window; rents → cranker + dust → largest beneficiary after it), and all setup/owner paths.

#### Building & testing (the `devnet` feature)

The heartbeat/grace **minimums are feature-gated**. A plain build enforces the production floors (1 day / 7 days); the short demo floors (10s / 30s) that the tests rely on are behind the opt-in `devnet` Cargo feature. From `dead-mans-vault/`:

```bash
yarn test:devnet     # anchor build -- --features devnet, then the ts-mocha suite
yarn build:devnet    # devnet build (demo minimums) — devnet only
yarn build:prod      # PRODUCTION build (1-day / 7-day minimums) — mainnet
```

**Mainnet/production builds MUST NOT enable `devnet`.** `cargo test` guards this: it asserts the safe minimums on a default build and the demo floors under `--features devnet`, and CI runs both.

---

## Mobile App

### Screens (4 tabs)

| Tab | Screens | Purpose |
|-----|---------|---------|
| **Status** | Dashboard, Execution Log, Inheritances | Heartbeat button, portfolio overview (tokens + inline NFTs), vault status, escalation banner. **Inheritances** lists vaults the connected wallet can claim as a beneficiary and cranks the distribution (heir-paid) |
| **Assets** | Assets Overview | Tokens · NFTs · DeFi tabs — token list with live prices, NFT gallery, DeFi positions grouped by protocol with closure strategies |
| **Vault** | SetupWizard, Welcome, Beneficiaries, Heartbeat Config, DeFi Positions, Estate Review | 4-step vault creation wizard with step indicator |
| **Settings** | Settings | Wallet info, vault contract details, edit/update vault, revoke, demo mode, app lock |

Authentication screen guards app access with biometric/PIN when enabled.

### Services

| Service | Purpose |
|---------|---------|
| **BackgroundAgent** | Singleton orchestrator for heartbeat monitoring and escalation evaluation |
| **HeartbeatService** | Records confirmations to SQLite, tracks overdue status, monitors on-chain wallet activity |
| **EscalationService** | Autonomous state machine evaluating every 60s (10s in demo), transitions through 4 stages |
| **ExecutionService** | The permissionless crank — a mask-driven "do the next undone thing" loop (begin → bequests → pro-rata SOL → finalize → token residual → close), idempotent and resumable from on-chain state |
| **ClaimService** | Heir-facing wrapper over the same crank: `runClaim` is an MWA-signed, resumable loop (heir pays fees) that discovers claimable vaults and distributes them |
| **VaultTransactionService** | Builds and sends all on-chain transactions (setup, owner ops, and the permissionless crank) with priority fees and raw byte parsing fallback |
| **KeyManager** | Agent keypair lifecycle via expo-secure-store (TEE on Seeker); signs heartbeats only |
| **NotificationService** | 3 Android channels (heartbeat/HIGH, escalation/MAX, execution/MAX); local heartbeat-confirmed / foreground display. Escalation alerts come from the keyless watcher via FCM (the local timeline was removed in v1.7.3) |
| **PortfolioScanner** | Token + NFT balances via Helius DAS, with an RPC-only fallback that reads NFT names/images from on-chain Metaplex Metadata (`metaplexMetadata` + `nftMetaRepo` cache); dual-oracle pricing (Pyth + Jupiter), DeFi detection |
| **MigrationService** | Detects device migration and triggers on-chain agent rotation |
| **rpcConfig** (util) | Single source of truth for the RPC URL + Helius endpoints/key; supports a runtime user override (Settings → Network) loaded once at bootstrap |

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
| Rust | 1.89.0 |
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
|   +-- instructions/                # 20 instruction handlers
|   +-- state/                       # Account definitions (VaultConfig, HeartbeatRecord, ExecutionLog, AssetPlan, TokenDist)
|   +-- errors.rs                    # 41 error codes
|   +-- constants.rs                 # On-chain constants (FEE_WALLET, VAULT_CREATION_FEE_LAMPORTS) + mask helpers
+-- tests/                           # Anchor program tests (29/29 passing)
+-- app/                             # React Native mobile app (Expo SDK 52)
    +-- src/
        +-- services/                # HeartbeatService, EscalationService, ExecutionService, etc.
        +-- notifications/           # NotificationService (push notifications, 3 Android channels, background scheduling)
        +-- screens/                 # Dashboard, Assets, Setup wizard (5 screens), Settings, Auth
        +-- components/              # HeartbeatButton, EcgLine, StatusIndicator, StepIndicator, etc.
        +-- hooks/                   # useWallet, useHeartbeat, usePortfolio, useVaultProgram
        +-- store/                   # Zustand stores (vault, heartbeat, escalation, demo, auth, portfolio)
        +-- tee/                     # KeyManager (TEE agent key management)
        +-- db/                      # SQLite database layer (6 tables + repos)
        +-- defi/                    # DeFi protocol detectors + registry
        +-- types/                   # TypeScript type definitions + API interfaces
        +-- utils/                   # Constants, rpcConfig (RPC/Helius source of truth), formatting, validation, IDL, fetchWithRetry
```

A sibling **keyless watcher service** (`notify-server/`) — Node.js + Express + SQLite — polls each registered vault's heartbeat, pushes FCM escalation alerts, and runs the same permissionless crank to autonomously distribute after grace. It holds no authority over funds; it pays only transaction fees from its own keypair.

A standalone **keeper bot** (`keeper-bot/`) — runnable by anyone — discovers vaults directly on-chain (no registry or API), cranks expired ones, and collects the keeper bounty plus post-window cleanup rents. Two independent crankers (watcher + any keeper) mean no single service is ever a liveness dependency for the switch.

---

## Development

### Prerequisites

- Solana CLI 3.0.x
- Anchor 0.32.x
- Rust 1.89.0 (pinned via rust-toolchain.toml)
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

Currently deployed to **Solana Devnet**. All endpoints auto-derive their network prefix from the active RPC URL (via `rpcConfig`) for future mainnet migration, and the RPC URL can be overridden at runtime in Settings → Network.

---

## License

MIT
