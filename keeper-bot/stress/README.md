# Keeper RPC-failure + race stress test (Phase 5)

`rpc-stress.mjs` proves the keeper's `crankVault` is **correctness-safe under RPC
failure and concurrent racing** — the off-chain half of the stress-testing plan
(`docs/STRESS-TESTING-PLAN.md` §5). The on-chain masks/guards (proven by the
Phase 1–4 fuzzer) are the backstop; this verifies the *client* never turns a
transient RPC failure into a misdistribution, double-pay, or lost asset.

## Run

```bash
cd keeper-bot
node stress/rpc-stress.mjs      # self-contained; exits non-zero on any failed assertion
```

Self-contained and reproducible. On the **first** run it builds a devnet-floor
program (10s/30s minimums, so a vault matures in ~40s), caches it to
`stress/dmv_devnet.so` (gitignored), and **rebuilds the prod-floor `.so`** so the
main `dead-mans-vault/target/deploy/dead_mans_vault.so` is left untouched (the fuzz
harness depends on it staying the prod build). Later runs reuse the cache and skip
the builds. Delete `stress/dmv_devnet.so` to force a rebuild after a program change.

It then spins up a **local** `solana-test-validator` (custom ports 8899/9300, fresh
throwaway ledger — never touches devnet/mainnet or the live `dmv-keeper.service`),
deploys the **cached devnet `.so`** (never the main prod one), creates matured-able
vaults with a fresh test keypair, and drives the real `crankVault` through a
fault-injecting HTTP proxy. Validator + proxy are torn down on exit.

## What it proves (all green)

| | Scenario | Result |
|---|----------|--------|
| **S1** | 35% of *all* RPC calls return 429 during a crank | crank throws under load, but a healed retry (next "tick") completes it — vault `executed`, SOL mask full, both beneficiaries paid **exactly once**, no funds stranded |
| **S2** | forced 429 on the close-path account reads (`crank.js:258` `getAccount(vaultAta)`, the "rate-limited-RPC-lies" case) | the false "0 dust" builds a `close_token_dist` that **reverts on-chain** (the Option/withheld guards fire); a healthy retry then closes it — **all token units reach beneficiaries, none lost or misdistributed** |
| **S3** | two keepers crank the same vault concurrently | executed **exactly once**, SOL mask full with **no double-pay**, `total_sol_distributed ≤ deposit` (no over-distribution) — the loser's txs no-op/revert harmlessly |

## Findings

- **No correctness bug.** No RPC-failure ordering or race produced a
  misdistribution, double-pay, or lost asset. The design — *idempotent re-crank
  next tick* + authoritative on-chain guards — is sound.
- **`crank.js:258` error-swallow is correctness-safe but not ideal.** It catches
  *any* error reading the vault ATA as "ATA missing → 0 dust/withheld". A 429
  there can't cause a wrong outcome (the on-chain close reverts, the retry heals),
  but it wastes a tick + a failed-tx fee on a doomed close. **Optional hardening
  (not applied — this phase only tests):** distinguish a genuine "account not
  found" from an RPC/transport error, and on the latter, abort the close for this
  tick (retry next tick) instead of attempting a doomed one. Low priority; purely
  an efficiency/robustness nicety, not a safety fix.
- **WebSocket confirmations fail through the proxy → web3.js polls instead.**
  Realistic (mirrors the app's "never `sendAndConfirmTransaction` on mobile" note);
  harmless — confirmation falls back to polling.
