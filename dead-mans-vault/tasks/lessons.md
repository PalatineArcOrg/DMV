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
