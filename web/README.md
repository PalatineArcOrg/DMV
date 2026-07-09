# DMV Web — Heir Claim Portal (Phase 1)

A browser app that lets a beneficiary claim a matured **Dead Man's Vault** inheritance
from any wallet (Phantom / Solflare / Backpack) — no Android app required. Execution is
already permissionless on-chain; this is just a web crank driven by the heir's wallet.

## How it reuses the mobile app

The on-chain logic is **not forked**. Via a Vite alias (`@app` → `../dead-mans-vault/app/src`)
this app imports the exact same TypeScript the mobile app ships:

- `ClaimService.runClaim` — the resumable, idempotent claim loop
- `VaultTransactionService` — every transaction builder
- `utils/rpcConfig`, `utils/constants` (`PROGRAM_ID`, etc.)

Two tiny seams make that RN code run in a browser (see `vite.config.ts`):

1. **`react-native` → `src/shims/react-native.ts`** — a 3-line `Platform` stub (constants.ts
   uses it only for a font family).
2. **`process.env.EXPO_PUBLIC_*` → `define`** — the 4 Expo env vars replaced at build with
   `VITE_*` values (all have `|| default` fallbacks).

Plus `vite-plugin-node-polyfills` for `Buffer`/`process` (needed by web3.js/anchor).

The wallet seam that was MWA on mobile is `@solana/wallet-adapter-react` here — it returns the
same web3.js v1 `Transaction` + `signTransaction` callback `ClaimService` already expects.

## Discovery

- **Auto:** `GET {VITE_NOTIFY_URL}/inheritances?wallet=<pubkey>` (the notify-server endpoint the
  mobile Inheritances screen uses).
- **Manual:** paste an owner address → reads `VaultConfig` straight from chain (`resolveByOwner`).

## Develop

```bash
cp .env.example .env      # set a Helius devnet RPC to avoid 429s
npm install
npm run dev               # http://localhost:5173
npm run build             # production build → dist/
npm run typecheck         # type-check web src only (not the reused RN source)
```

> `build` runs `vite build` only (no `tsc` over the reused RN source, which needs RN types).
> `typecheck` is scoped to `src/` via `tsconfig.web.json`.

## Scope (Phase 1)

Heir claim only. Owner setup/management is Phase 2. Heartbeats/liveness stay on the phone
(the on-chain `record_heartbeat` requires the agent key, which the web app never holds).

## Not yet wired

- RPC key should be proxied through the notify-server before a public launch (don't ship a
  privileged Helius key in the bundle). Currently uses whatever `VITE_RPC_URL` you set.
- Deploy target (`app.dmv.palatinearc.com`) — add a Caddy block + a static `dist/` mirror.
