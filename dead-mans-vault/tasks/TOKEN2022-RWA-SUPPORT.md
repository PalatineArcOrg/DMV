# Token-2022 / Tokenized-Stock (RWA) Support — status, risks, plan

**TL;DR:** DMV distributes today's flagship tokenized stocks — **Backed xStocks** (TSLAx, AAPLx, …) and **Backpack Securities / Sunrise** stocks (SPCX, SNDK, MU, …) — **right now, with no program change**, because none currently attach an active transfer hook, none are default-frozen, and none are paused or fee-charging. The work items are (1) **disclose** the issuer's freeze/clawback powers, (2) **future-proof** against the issuer flipping on a hook or pause (add hook-account resolution + a graceful skip), and (3) **characterization tests** proving both the works-today and the bricks-if-flipped behavior. Verified 2026-07-05 by reading each mint live on mainnet.

---

## 1. On-chain verification (mainnet `getAccountInfo` jsonParsed)

All five mints are Token-2022 (`TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`). "Backpack stocks" and "Sunrise stocks" are one product: **Backpack Securities** is the regulated issuer, **Sunrise** (Wormhole Labs / Trek Labs, Wormhole NTT) is the tokenization gateway; the on-chain `tokenMetadata` self-identifies "<name> - Backpack Securities".

| Issuer | Ticker | Mint | Transfer hook | Default-frozen? | Paused? | Fee? | Perm. delegate + freeze | Distributable today |
|---|---|---|---|---|---|---|---|---|
| Backed xStocks | TSLAx | `XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB` | present, **programId: null** | no (`initialized`) | no | no | **both set** | ✅ YES |
| Backed xStocks | AAPLx | `XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp` | present, **null** | no | no | no | both set; **scaledUi rebasing ~1.002** | ✅ YES |
| Backpack/Sunrise | SPCX (SpaceX) | `SPCXxcqXj6e5dJDVNovHN8744zkbhM2bYudU45BimGb` | present, **null** | no | no | no | both set | ✅ YES |
| Backpack/Sunrise | SNDK (SanDisk) | `SNDKbwMUQvZhnLnxLduradgLHG5KrPuKwpnrkkGRhfH` | present, **null** | no | no | no | both set | ✅ YES |

Common extension template (both families): `metadataPointer, permanentDelegate, defaultAccountState(initialized), scaledUiAmountConfig, pausableConfig(paused=false), confidentialTransferMint(autoApprove=false — doesn't block transparent transfers), transferHook(programId=null), tokenMetadata`. None carry a transfer fee or `mintCloseAuthority`.

## 2. Why they work today (verified against DMV code)

DMV distributes via `token_interface::transfer_checked` on `InterfaceAccount` (all four token paths). For these mints that succeeds because:
- **No hook to invoke** — `transferHook.programId == null`, so Token-2022 resolves/invokes nothing; the missing hook-account-forwarding in DMV is moot.
- **Recipient ATAs aren't frozen** — `defaultAccountState = initialized`, so a crank-created beneficiary ATA immediately accepts funds.
- **Not paused, no fee** — transfer isn't blocked and conservation math is exact.
- **`transfer_checked` (not unchecked `transfer`)** is required by pausable/scaledUi mints — DMV already uses it.
- **Raw-amount distribution is correct under `scaledUiAmountConfig`** — DMV snapshots the raw ATA balance and splits by bps in raw base units; `scaledUiAmount` only scales the *displayed* amount, so beneficiaries receive the correct number of raw shares even while AAPLx rebases.

## 3. Caveats to disclose (issuer retains control — not a DMV bug)

- **Freeze authority is set on every mint** → the issuer can freeze the vault's or a beneficiary's ATA. A frozen beneficiary ATA makes that token's `execute_token_shares` revert (brick cascade, §5).
- **Permanent delegate is set on every mint** → the issuer can **claw back / burn** the tokens from any account, including after the heir receives them. Inheritance conveys the token; it cannot defeat the issuer's clawback.
- These are compliance features of regulated equity tokens. **Surface them in-app** (a "this asset is issuer-controlled; it can be frozen or recalled" note on RWA bequests) rather than implying DMV guarantees custody.

## 4. Forward risk (the real reason to build hook support)

Every mint ships the *controls* to brick a naive distributor, just switched off, behind **live authority keys**:
- `transferHook` **authority** can attach a hook program at any time → a `transfer_checked` that doesn't resolve the hook's extra accounts will then **revert**.
- `pausableConfig` authority can **pause** all transfers instantly → transfers revert until unpaused.
So "works today" is **conditional going forward**. Mitigations, in order of value:
1. **Monitor per-mint before each distribution** (cheap, do first): the crank reads `transferHook.programId` and `pausableConfig.paused` for each mint; if a hook is now set or the mint is paused, skip/defer that mint (don't `begin_token_dist` it — avoid the brick cascade) and surface it, rather than stranding the whole vault.
2. **Add transfer-hook support** (program change, §6): resolve + forward hook extra-accounts so hooked RWAs distribute.
3. **Graceful skip for un-transferable mints** (program change): so one bad mint can't block the vault's finalize/close.

## 5. The brick cascade (why one bad mint is dangerous)

If a mint's `transfer_checked` can't succeed (active hook not forwarded / paused / recipient frozen / non-transferable): the paid bit never sets → `execute_token_shares`/`execute_specific_asset` can't complete → `close_token_dist` (needs the mask full) never runs → `open_token_dists` never decrements → **the whole vault can't finalize-close** (both closes require `open_token_dists == 0`). Inheritance of the *other* assets already succeeded, but the vault and its rent strand. This is the availability-Critical the AUDIT-SCOPE §5(c) names.

## 6. Plan

### 6a. Characterization tests (safe — no bytecode change; doesn't move the audit tag)
Add a `Token-2022 extension characterization` suite proving current behavior per extension (what the real stocks use + the forward-risk flavors). Achievable with `@solana/spl-token@0.4.14`:
- **permanent-delegate mint → distributes fine** (this is what the real stocks carry — proves DMV handles it).
- **transfer-fee mint → distributes, beneficiary receives amount−fee, conservation holds** (documents the residual-stuck-close caveat).
- **default-frozen mint → recipient ATA frozen → `execute_token_shares` reverts** (the permissioned-RWA / frozen-recipient brick).
- **non-transferable mint → reverts** (brick).
- **active transfer-hook mint → reverts** (the forward-risk brick; needs a minimal hook program or a dummy hook programId).
- `scaledUiAmountConfig` + `pausableConfig` init helpers are **absent in 0.4.14** — characterize scaledUi (raw-amount correctness) by reasoning + the on-chain data; paused ≈ frozen for our purposes. (Optional: bump spl-token to create them, weighed against the MWA-style pin risk.)

### 6b. Crank monitoring (client change, no program change) — do first, cheap
In the three cranks (`ExecutionService`, `executor.js`, `keeper-bot`) and `getVaultTokenBalances`: before `begin_token_dist` for a mint, read its Token-2022 extensions; if `transferHook.programId != null` or `pausableConfig.paused`, **skip that mint** (log + surface it) instead of bricking the vault. This makes a later issuer flip non-fatal.

### 6c. Transfer-hook support (program change — pre-audit if RWA is a headline)
Swap the four token-path CPIs from Anchor's `token_interface::transfer_checked` to **`spl_token_2022::onchain::invoke_transfer_checked`** (or manual `TransferHook` account resolution via `spl-transfer-hook-interface`), and forward the hook's extra accounts through `remaining_accounts` in `execute_token_shares` / `execute_specific_asset` / `close_token_dist`. The cranks resolve the extra accounts from the mint's transfer-hook + the hook's `ExtraAccountMetaList` PDA and pass them. Add a **graceful skip** so a non-transferable/paused mint can't block finalize/close. This is a bytecode change → build + re-deploy + **re-audit scope** → land it *before* the external audit if it's in scope. Note: even with hook support, a hook that gates on a KYC/allowlist means the **beneficiary must be issuer-approved** — a compliance dependency DMV can't remove.

---
*Verified 2026-07-05 (mainnet on-chain reads). Related: AUDIT-SCOPE §5(c), AUDIT-OF-AUDIT B6/D, CLAUDE.md gotcha #17.*
