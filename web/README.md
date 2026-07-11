# DMV Web

Browser companion to the **Dead Man's Vault** mobile app, live at
**https://dmvapp.palatinearc.com**. React + Vite + `@solana/wallet-adapter`; users sign
with a standard browser wallet (Phantom / Solflare / Backpack). The web app never holds a
private key — both the owner and the heir sign every transaction in their own wallet
extension.

It is a **two-tab app**:

- **Inheritances** — heir claim portal. Connect a wallet, auto-discover every vault where
  you're a beneficiary (via the notify-server `GET /inheritances?wallet=` endpoint) or
  import one by the owner's address, and claim a matured vault. Execution is already
  permissionless on-chain, so this is just a web crank driven by the heir's wallet — **the
  heir pays fees**.
- **My Vault** — owner console. View status (Active / Frozen / Distributed, countdown to
  the switch, beneficiaries + shares, SOL + token/NFT balances with names & logos),
  deposit/withdraw SOL, deposit tokens + NFTs from your wallet (behind a `checkDepositable`
  guard) and withdraw them, edit beneficiaries, set/edit specific bequests (SOL / SPL /
  NFT), and revoke or close the vault. All owner mutations are gated to **pre-grace +
  mutable**, exactly as on-chain.

**What stays on the phone:** heartbeats and vault *creation*. On-chain `record_heartbeat` is
signed by the device-held agent key, which the web app never has — so liveness proof and
initial setup remain in the mobile app.

## How it reuses the mobile app

The on-chain logic is **not forked**. Via a Vite alias (`@app` → `../dead-mans-vault/app/src`)
this app imports the exact same TypeScript the mobile app ships — a single source of truth,
no duplicated transaction builders:

- `ClaimService.runClaim` — the resumable, idempotent heir claim loop
- `VaultTransactionService` — every permissionless-crank + owner-mutation transaction builder
- `utils/rpcConfig`, `utils/constants` (`PROGRAM_ID`, etc.)

The wallet seam that was Mobile Wallet Adapter on the phone is `@solana/wallet-adapter-react`
here — it returns the same web3.js v1 `Transaction` + `signTransaction` callback the reused
services already expect.

### Vite wiring (see `vite.config.ts`)

Making RN source run in a browser needs a few seams:

1. **`react-native` → `src/shims/react-native.ts`** — a 3-line `Platform` stub (`constants.ts`
   uses it only for a font family).
2. **`process.env.EXPO_PUBLIC_*` → `define`** — the Expo build-time env vars replaced at
   compile time with `VITE_*` values (all have `|| default` fallbacks).
3. **`resolve.dedupe`** — the reused files live in the sibling `app/`, so bare imports would
   otherwise pull a *second* copy of every shared dep from `app/node_modules`. Dedupe forces
   one copy of `@solana/web3.js`, `@coral-xyz/anchor`, `@solana/spl-token`, `bs58`, `buffer`,
   `bn.js`, `react`, `react-dom` from this project.
4. **Manual `Buffer`/`global` polyfill** (`src/polyfills.ts`, imported first in `main.tsx`) —
   **not** `vite-plugin-node-polyfills`, whose dev-mode Buffer injection hits a TDZ
   "cannot access before initialization" circular-init bug with web3.js's pre-bundled deps.
5. **`@types/react` pinned to `18.3.12`** (with an `overrides` block) to keep one React type
   version across the shared graph.

## RPC & metadata

- **Default RPC is the notify-server proxy**: `https://notify.palatinearc.com/rpc?cluster=devnet`.
  The Helius key is injected server-side (never shipped in the bundle). HTTP is rate-limited
  to 150 requests / 10s per client; WebSocket confirmations are proxied by Caddy → Helius.
  The `?cluster=devnet` hint keeps network labels / explorer links correct (the proxy URL
  itself carries no cluster).
- **Bring-your-own RPC**: users can set their own endpoint in **Settings → Network** (persists
  in `localStorage`, "restart to apply").
- **Fail-closed network gate** (`src/BootGate.tsx`): before the app mounts, `verifyNetwork()`
  (reused from `@app`) checks the RPC's on-chain **genesis hash** against `VITE_EXPECTED_CLUSTER`
  (default `devnet`). **VERIFIED** → app mounts; **MISMATCH** → hard block (wrong-cluster RPC can't
  connect); **UNKNOWN** (RPC unreachable) → read-only with retry/continue (owner + heir writes are
  gated off). A **mainnet** web deploy MUST set `VITE_EXPECTED_CLUSTER=mainnet-beta`, and the RPC/proxy
  must answer `getGenesisHash` with the mainnet hash. The genesis check is the authority — the
  `?cluster=devnet` URL hint is now only for labels/explorer links.
- **Token / NFT names + logos** come from Helius DAS `getAssetsByOwner` through the same proxy.
  ⚠ DAS through this proxy needs **named-object** params (`params: { ownerAddress }`), not the
  array-wrapped form.

## Develop

```bash
cp .env.example .env      # defaults to the notify-server RPC proxy
npm install
npm run dev               # http://localhost:5173
npm run build             # production build → dist/
npm run typecheck         # type-check web src only (not the reused RN source)
```

> `build` runs `vite build` only (no `tsc` over the reused RN source, which needs RN types).
> `typecheck` is scoped to `src/` via `tsconfig.web.json`.

## Deploy

Static build served by Caddy from `/var/www/dmvapp`:

```bash
bash deploy.sh            # runs `vite build`, then mirrors dist/ → /var/www/dmvapp
```

## Scope

- **Phase 1 (heir claim)** — done.
- **Phase 2 (owner console)** — done.

Remaining:

- A **pure-web liveness model** (prove liveness without the phone) — today heartbeats still
  require the device-held agent key.
- **`rotate_agent` stays phone-only** by design (device migration is a mobile flow).
