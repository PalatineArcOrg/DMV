# Lessons

Self-improvement log: patterns to avoid repeating. Review at session start.

## Security-audit scope = the whole trust boundary, not just the program (2026-07-04)

**What happened:** Asked to "scan the smart contracts" before mainnet, I audited only
the on-chain Anchor program. A user-supplied second-opinion review then found real
issues in the **notify-server** (fail-open auth, unproofed registration, RPC-amplification
DoS) and the **app's agent-key storage** (no biometric gate) — none of which the
program-only audit covered.

**Why it matters:** DMV's security guarantees don't live only on-chain. The keyless
crank server is load-bearing for autonomy, and the app's agent key gates the liveness
clock. Those are part of the attack surface even though they aren't "the smart contract."

**How to apply:** For any audit of a system with off-chain components that enforce or
enable its guarantees (crank/keeper services, key storage, admin endpoints, indexers),
scope the review to the full trust boundary. State the scope explicitly up front and call
out what's *excluded* so the user can widen it.

## On-chain guards can require companion crank changes (2026-07-04)

**What happened:** Adding `NothingToDistribute` to `begin_token_dist` (rejects a mint the
vault neither holds nor bequeaths) would have broken the notify-server crank, whose
`collectMints` enumerated 0-balance token accounts and would then abort on the new error.

**How to apply:** When adding a rejecting constraint to an instruction, grep every caller
(app `ExecutionService`/`ClaimService`, server `executor.js`, tests) and confirm none can
now hit the new error path in normal operation. New reverts are as breaking as new logic.

## tsc/Node green ≠ Hermes/Metro green (2026-07-04, broke v1.13.0)

**What happened:** Moving the raw account parsers into a separate module
(`utils/rawAccountParsers`) type-checked and passed Node tests, but the imported
function resolved to `undefined` in the Metro/Hermes release bundle — vault creation
"succeeded" while the app couldn't read the vault back, and the retry path threw
"undefined is not a function" on device.

**How to apply:** Keep hot-path account parsers INLINE in the module that uses them,
and verify a unique constant from the new code actually appears in the built bundle
(`unzip -p app.apk assets/index.android.bundle | grep -oac '<marker>'`). Non-ASCII
strings (e.g. "≈") are stored UTF-16 in Hermes bytecode — check those with
`strings -el`, ASCII grep silently misses them. A release-bundle check is part of
"tested"; tsc and Node are not sufficient.

## Re-fetch on-chain masks before gate checks in a multi-step crank (2026-07-04)

**What happened:** The notify-server executor paid the last specific bequest and then
evaluated the finalize gate against the *in-memory* AssetPlan mask fetched before the
payment — so it skipped finalize and aborted on `close_token_dist`
(`VaultNotExecuted`), leaving a real vault stuck one step from done (5 SOL + an NFT
undistributed until a second pass).

**How to apply:** In any crank that both mutates and then gates on on-chain state,
re-fetch every mask/flag immediately before the gate. Also guard later steps on a
fresh copy of the state they require (e.g. only attempt closes when a fresh `executed`
is true) so a not-yet-ready step skips instead of aborting the whole run.

## Coordinated releases: never ship one side of a two-sided auth change (2026-07-04)

**What happened:** The app started signing notification registrations (owner
signMessage) while the deployed server still accepted unsigned ones — all friction, no
benefit, and the auto background wallet popup was unreliable, so vaults silently went
unregistered and killed-app notifications died.

**How to apply:** A request-signing change is a protocol change: ship the verifying
server and the signing client together (with a transition window accepting both), sign
at a deliberate wallet moment (inside an existing MWA session), and keep the dormant
path clearly marked with its activation checklist.

## Test-validator clocks lag wall-clock (2026-07-04)

**What happened:** A test waited `Date.now()`-based for an on-chain time window
(`EXECUTED_CLOSE_DELAY`) and still hit `CloseDelayNotElapsed` — the local validator's
`Clock` sysvar lags wall time under load.

**How to apply:** When a test waits for an on-chain time condition, poll the chain's
clock (`getBlockTime(getSlot())`) until it passes the target; never sleep by wall time.

## Anchor `.all()` dies on one undecodable account (2026-07-04)

**What happened:** The keeper bot's first scan crashed with `Invalid bool: 252` —
devnet still carries legacy-layout VaultConfig accounts from older program versions,
and `program.account.x.all()` throws on the first decode failure.

**How to apply:** For program-wide scans, use `getProgramAccounts` with the
discriminator filter and decode each account in its own try/catch, skipping failures.
Any long-lived program accumulates undecodable legacy accounts.
