# BUILD-SPEC — Custom RPC + Metaplex-metadata fallback

Two complementary moves to remove the hard dependency on the bundled shared Helius
key, which currently rate-limits under app load and makes the wallet scan fall back
to a metadata-less RPC path (NFTs lose names/images; before v1.11.2 they weren't even
categorized).

- **Move 1 — Custom RPC setting.** Let a user point the app at their own RPC/DAS
  endpoint (Helius, Triton, QuickNode, Aura, …). Their own rate limits → no fallback →
  reliable NFT metadata + faster scans, plus provider choice / resilience.
- **Move 2 — Metaplex-metadata fallback.** When DAS is unavailable *at all*, read NFT
  names/images directly from on-chain Metaplex Metadata accounts over any standard RPC.
  Makes the app degrade gracefully to *any* provider for standard (non-compressed) NFTs.

Do **Move 1 first** (biggest bang, self-contained). Move 2 is independent and can ship
separately.

---

## Current architecture (as-is)

- `src/utils/constants.ts` exposes **module constants** read from `EXPO_PUBLIC_*` env at
  import time:
  - `RPC_URL` (default `https://api.devnet.solana.com`)
  - `HELIUS_API_KEY`
  - `IS_DEVNET = RPC_URL.includes('devnet')` → `HELIUS_API_BASE`, `HELIUS_ENHANCED_API`,
    `HELIUS_PARSE_TX_API` (all derived from the net prefix)
- **RPC consumers** (only a handful — good):
  - `src/utils/ConnectionProvider.tsx` → `new Connection(RPC_URL, config)`
  - `src/services/VaultTransactionService.ts` → `new Connection(RPC_URL, 'confirmed')`,
    plus `getConnection()` used by ExecutionService, ClaimService, MigrationService,
    revokeVault, Dashboard, SetupWizard, ExecutionDetail
  - `src/services/PortfolioScanner.ts` → `new Connection(rpcUrl)` (rpcUrl passed in) +
    the DAS call on `this.rpcUrl`
  - `src/services/ExecutionHistoryService.ts` → `HELIUS_ENHANCED_API` + `HELIUS_API_KEY`
  - `src/screens/ExecutionDetailScreen.tsx` → `IS_DEVNET` for explorer links
- `src/db/settingsRepo.ts` → async `getSetting(key)` / `setSetting(key, value)` /
  `deleteSetting(key)` (SQLite key/value).
- `src/screens/SettingsScreen.tsx` → sections rendered as `sectionBlock` + `sectionLabel`
  (VAULT STATUS, INHERITANCES, SECURITY, DEVELOPER, WALLET).

**Constraint:** module constants are evaluated once at import — they can't be reassigned
after the JS loads. So a runtime override needs either (a) a getter indirection, or
(b) load-at-bootstrap + "reload to apply".

---

## MOVE 1 — Custom RPC setting

### Decision: what the field is
Single **Custom RPC URL** field (recommended). The app already derives every Helius
endpoint from `RPC_URL`, so one URL is the least surprising and the smallest change.
Helper text makes the DAS caveat explicit: *"For NFT & full portfolio data, use a
Helius-compatible (DAS) RPC URL."* (If we later want a non-DAS RPC + separate Helius key,
that's an additive follow-up — not this spec.)

### Architecture: runtime RPC config
Introduce a tiny runtime holder so constants become **snapshot-at-bootstrap** values,
overridable from settings, with the env as default. "Reload to apply" keeps it simple
(no live re-init of open `Connection`s).

New file `src/utils/rpcConfig.ts`:
```ts
// In-memory active config, seeded from env, overridden at bootstrap from settings.
let activeRpcUrl = process.env.EXPO_PUBLIC_RPC_URL || 'https://api.devnet.solana.com';

export const DEFAULT_RPC_URL = process.env.EXPO_PUBLIC_RPC_URL || 'https://api.devnet.solana.com';
export const RPC_OVERRIDE_KEY = 'custom_rpc_url';

export function getRpcUrl(): string { return activeRpcUrl; }
export function isDevnet(): boolean { return activeRpcUrl.includes('devnet'); }
export function heliusNetPrefix(): string { return isDevnet() ? 'api-devnet' : 'api-mainnet'; }
export function heliusEnhancedApi(): string { return `https://${heliusNetPrefix()}.helius-rpc.com/v0`; }
export function heliusApiBase(): string { return `https://${heliusNetPrefix()}.helius.xyz/v0`; }

// Called ONCE at app bootstrap, before services/connections are created.
export async function loadRpcOverride(getSetting: (k: string) => Promise<string | null>) {
  const v = (await getSetting(RPC_OVERRIDE_KEY))?.trim();
  if (v) activeRpcUrl = v;
}

// Extract the Helius api-key from the active URL if present (for enhanced REST calls
// that take ?api-key=). Empty string if the URL isn't a Helius ?api-key= URL.
export function heliusApiKeyFromUrl(): string {
  try { return new URL(activeRpcUrl).searchParams.get('api-key') || ''; } catch { return ''; }
}
```

### Changes to `constants.ts`
- Keep the env constants as the **defaults** but re-export the dynamic ones from
  `rpcConfig`, or (cleaner) leave `constants.ts` for static values and migrate RPC/Helius
  consumers to import from `rpcConfig`. Minimal-churn path: change `RPC_URL`, the
  `HELIUS_*` endpoints, `IS_DEVNET`, and `HELIUS_API_KEY` from `const` to thin getters that
  proxy `rpcConfig` (so callers can stay `import { RPC_URL }`… no — a `const` can't be a
  getter). **Recommendation:** migrate the ~6 consumers to call the `rpcConfig` getters
  (`getRpcUrl()`, `heliusEnhancedApi()`, `isDevnet()`, `heliusApiKeyFromUrl()`). It's a
  small, explicit set.

### Bootstrap wiring
- In the app entry (`App.tsx` / root provider, before `ConnectionProvider` mounts and
  before any service is constructed), `await loadRpcOverride(getSetting)`. Gate initial
  render on a `ready` flag (there's already SQLite init at startup — hook in there).
- `ConnectionProvider`, `VaultTransactionService`, and `PortfolioScanner` construction all
  read `getRpcUrl()` at construction time (already lazy enough given they're built after
  bootstrap).

### Settings UI — new "NETWORK" section (`SettingsScreen.tsx`)
A `sectionBlock` titled **NETWORK**, above DEVELOPER:
- Read-only current endpoint line: masked (`maskRpc` — strip `api-key`), plus a
  Default/Custom badge.
- `TextInput` (URL keyboard, autocapitalize none, autocorrect off) prefilled with the
  saved override (or empty → placeholder shows the default, masked).
- Buttons: **Test** · **Save** · **Reset to default**.
- Helper text: DAS/Helius caveat (above) + "Restart the app to apply."

Behaviour:
- **Test**: build a throwaway `new Connection(input)`, call `getVersion()` (cheap,
  universal) with a 5s timeout; also fire one `getAssetsByOwner` probe and surface a
  distinct "DAS supported ✓ / not supported (NFTs limited)" note. Never blocks Save.
- **Save**: validate `new URL(input)` parses and is `https:`; `setSetting(RPC_OVERRIDE_KEY,
  input)`; toast "Saved — restart to apply." Offer an **Apply now** that calls
  `DevSettings.reload()` (dev) / `expo-updates` `reloadAsync()` (prod) if available, else
  instruct manual restart.
- **Reset**: `deleteSetting(RPC_OVERRIDE_KEY)`; restart to apply.

### Security / storage
- The URL may embed an `api-key`. `settingsRepo` is app-local SQLite (not synced). That's
  acceptable, matching how the bundled key already ships in the JS. **Never** `console.log`
  the URL; always `maskRpc` before display or any surfaced error. (Reuse the server's
  `maskRpc` idea client-side.)
- Do **not** send the custom URL to the notify-server (registration only sends
  owner/vault/token/stages). The server keeps its own RPC. No change there.

### Edge cases
- **Devnet vs mainnet**: `isDevnet()` keys off the active URL, so a mainnet Helius URL
  auto-flips explorer links + Helius REST prefixes. Good. Warn if the override's network
  looks different from `PROGRAM_ID`'s network? (v1: just a soft note.)
- **Bad override bricking the app**: if a saved override fails at runtime, the app would be
  broken until reset. Mitigation: keep a **"Reset to default" reachable even offline**, and
  consider a boot-time health ping with auto-fallback to `DEFAULT_RPC_URL` after N
  consecutive failures (v1: manual reset is enough; note as a hardening follow-up).
- **`getConnection()` caching**: `VaultTransactionService` caches one `Connection`. Since we
  "reload to apply," the cache is fine (rebuilt on reload).

### Files touched (Move 1)
- **new** `src/utils/rpcConfig.ts`
- `src/utils/constants.ts` (RPC/Helius consumers → getters, or re-export)
- `src/utils/ConnectionProvider.tsx`, `src/services/VaultTransactionService.ts`,
  `src/services/PortfolioScanner.ts`, `src/services/ExecutionHistoryService.ts`,
  `src/screens/ExecutionDetailScreen.tsx` (read from `rpcConfig`)
- app bootstrap (`App.tsx` or the SQLite-init path) → `await loadRpcOverride`
- `src/screens/SettingsScreen.tsx` (NETWORK section)
- `src/db/settingsRepo.ts` (no change — reuse get/set/delete)

---

## MOVE 2 — Metaplex-metadata fallback (names/images without DAS)

### Goal
When the DAS path is unavailable, the RPC fallback (`getParsedTokenAccountsByOwner`)
currently yields NFTs with **mint-slice symbols and no image** (v1.11.2 at least tags
them `isNft`). Upgrade the fallback to fetch **name / symbol / image** from on-chain
**Metaplex Token Metadata** accounts, over any standard RPC.

### Approach (no heavy dependency)
For each fallback token account flagged `isNft` (0 decimals, 1 unit):
1. Derive the Metadata PDA:
   `["metadata", TOKEN_METADATA_PROGRAM_ID, mint]` under
   `metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s`.
2. **Batch** `getMultipleAccountsInfo(metadataPdas)` (≤100 per call) — one round-trip for
   all NFT candidates, not N calls.
3. **Manually parse** the Metadata account (avoid adding `@metaplex-foundation/mpl-token-
   metadata` — heavy in the RN/Hermes bundle). Layout, from offset 0:
   `key (1) · update_authority (32) · mint (32)` then borsh strings
   `name (u32 len + bytes) · symbol (u32 len + bytes) · uri (u32 len + bytes)`.
   Trim trailing `\0` padding. A ~25-line reader in a new
   `src/services/metaplexMetadata.ts` (`parseMetadataAccount(data: Buffer)` →
   `{ name, symbol, uri }`, `metadataPda(mint)`).
4. Set `symbol = name || symbol || mint-slice`.
5. **Image**: the `uri` JSON must be fetched (`fetchWithRetry`) to read `.image`. Do this
   **lazily / bounded** — cap concurrent fetches, cache by uri in SQLite
   (`priceHistoryRepo` pattern or a new `nftMetaRepo`), and treat failure as "no image."
   Names/symbols come from-chain (no fetch); only images need the extra request.

### Limitations (document in UI + code)
- **Compressed NFTs (cNFTs)** have **no** token account and **no** Metadata account — they
  live only in the DAS index. The fallback **cannot** see them. Only DAS (Move 1 with a
  DAS provider) surfaces cNFTs. Note this in the NETWORK helper text.
- **Token-2022 NFTs**: the current fallback only queries the legacy Token program. Add a
  second `getParsedTokenAccountsByOwner` for `TOKEN_2022_PROGRAM_ID` (metadata may be the
  Token-2022 metadata extension rather than a Metaplex PDA — v1: handle Metaplex-PDA NFTs;
  note T22-native metadata as a follow-up).

### Perf / caching
- One `getMultipleAccountsInfo` for all NFT metadata (cheap).
- Cache parsed `{name, symbol, image}` by mint in SQLite; NFTs are immutable, so cache
  indefinitely. On subsequent scans, skip the metadata/uri fetch for cached mints.

### Files touched (Move 2)
- **new** `src/services/metaplexMetadata.ts` (`metadataPda`, `parseMetadataAccount`)
- **new (optional)** `src/db/nftMetaRepo.ts` (mint → {name, symbol, image} cache)
- `src/services/PortfolioScanner.ts` (enrich the RPC-fallback NFTs; optionally the
  Token-2022 sweep)

---

## Combined degradation matrix (target behaviour)

| Scenario | Fungibles | NFT categorized | NFT name/symbol | NFT image | cNFTs |
|---|---|---|---|---|---|
| DAS works (Helius/Triton/QuickNode/Aura) | ✓ | ✓ | ✓ | ✓ | ✓ |
| DAS down → RPC fallback (post Move 2) | ✓ | ✓ | ✓ (on-chain) | ✓ (uri, cached) | ✗ |
| Non-DAS custom RPC | ✓ | ✓ | ✓ (on-chain) | ✓ | ✗ |
| Pre-Move-2 (today, v1.11.2) | ✓ | ✓ | mint-slice | ✗ | ✗ |

---

## Testing
- **Move 1**: save a valid Helius URL → NFTs show names/images; save a plain public RPC
  (`api.devnet.solana.com`) → app works, NFTs categorized (Move 2 gives names, images may
  lag), DAS-probe reports "not supported"; Reset restores default; malformed URL rejected
  on Save; explorer links flip devnet/mainnet with the override.
- **Move 2**: force the DAS fallback (temporarily point at a non-DAS RPC) → the 3 test NFTs
  (`JEHGuqPi…`, `8v2C4KPN…`, `6TedPw4c…`) resolve to "DMV Test Relic #1–3" via the Metadata
  read; a cNFT does **not** appear (documented); cache hit skips refetch on the 2nd scan.
- Regression: default config (no override) behaves exactly as v1.11.2.

## Rollout
- Move 1 → a minor bump (new user-facing setting), e.g. **v1.12.0**.
- Move 2 → follow-up patch, e.g. **v1.12.1** (or fold into 1.12.0 if built together).
- No on-chain / notify-server changes. No new heavy dependencies (manual metadata parse).

## Open decisions
1. Single URL field vs. URL + separate Helius-key field (spec assumes single URL).
2. Auto-fallback to default on repeated runtime RPC failure (hardening) — in v1 or later?
3. Build Move 2 now or after seeing whether Move 1 (users' own keys) makes the fallback
   rare enough that mint-slice names are acceptable.
