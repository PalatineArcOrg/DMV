# Security Policy

Dead Man's Vault (DMV) is a **self-custody crypto-inheritance protocol**. When an
owner's heartbeats stop, the on-chain program distributes their assets to
pre-configured beneficiaries — permissionlessly and **irreversibly**. Because a bug
can move a user's entire estate to the wrong place with no recourse, security review
is the top priority, and independent scrutiny is genuinely welcome.

## Audit status — please read

DMV has had an internal multi-agent adversarial review (which caught and fixed a
Critical), and its money-math + state machine are now covered by an extensive
**property-fuzz suite** — 9 properties over conservation, idempotency, specific
bequests, a theft-must-revert battery, the post-deadline freeze, Token-2022
transfer-fee close, NFT bequests, and a stateful instruction-sequence fuzzer (see
[`FUZZ-HARNESS-PLAN.md`](./FUZZ-HARNESS-PLAN.md)) — plus an RPC-failure/race stress
harness for the crank clients ([`STRESS-TESTING-PLAN.md`](./STRESS-TESTING-PLAN.md)).
That fuzzing + stress testing found **no program bug**. **But it has NOT had a paid
professional audit.** Treat it as community-reviewed and fuzz-tested, not audited. Do
not entrust more than you can afford to lose, and prefer small vaults while the
protocol is young.

The trust model, invariants, and the exact surface we want eyes on are documented in
[`AUDIT-SCOPE.md`](./AUDIT-SCOPE.md) — start there. The design of the permissionless
execution model is in [`BUILD-SPEC-permissionless-execution.md`](./BUILD-SPEC-permissionless-execution.md).

## Deployment

| | |
|---|---|
| Network | Solana **devnet** (mainnet not yet launched) |
| Program ID | `GXCu5964mvgAJDWmcMriZpzU3vDVqPzjYCM1sxCnsoEb` |
| Surfaces | Android app; a keyless notify-server + keeper bot (permissionless cranks); and a web app at `dmvapp.palatinearc.com` |
| License | MIT — the source is public; on-chain bytecode will be published as a verifiable build at mainnet |

**Web app key-handling.** The web app (`dmvapp.palatinearc.com`) holds **no private keys** — the
owner and heir both sign with their own browser wallet, and the heartbeat agent key stays on the
phone (the on-chain `record_heartbeat` is locked to it). It reuses the app's transaction builders,
so it adds no new on-chain authority — a web heir "claim" is just another permissionless caller.
Its RPC is proxied server-side (the Helius key is never shipped to the browser), rate-limited, and
the origin rejects non-Cloudflare source IPs. Custom bring-your-own RPC is user-configurable.

## Reporting a vulnerability

**Please do NOT open a public GitHub issue for a security bug.** Instead, email:

**romulus@palatinearc.com** — with `DMV SECURITY` in the subject.

Include: a description, the impact, and a proof-of-concept or reproduction (a failing
test against the LiteSVM harness is ideal). We aim to acknowledge within a few days and
will keep you updated on the fix and any reward. Please give us reasonable time to
remediate before any public disclosure (coordinated disclosure).

### In scope
- The on-chain Anchor program (`programs/dead-mans-vault/`) — anything that lets funds
  reach a non-beneficiary, over-distributes, bypasses the post-deadline freeze, or
  **permanently blocks** a legitimate distribution (availability is a security property
  for an inheritance switch).
- The permissionless execution / crank model.
- The crank clients (`notify-server/`, `keeper-bot/`) — key handling, ownership proofs,
  DoS resistance.

### Out of scope
- Devnet-only infrastructure, RPC providers, and rate-limiting.
- Third-party wallets, Mobile Wallet Adapter, and phone OS security.
- Documented limitations (e.g. transfer-fee Token-2022 close mechanics) — see
  `AUDIT-SCOPE.md`.
- Findings requiring a compromised owner device (the agent key can only stall the
  switch, never move funds — this is by design).

## Bug bounty

A **severity-scaled bounty** is offered for valid, previously-unreported findings,
funded from protocol fees. Rewards weight toward anything that risks **loss or
misdirection of user funds** or a **permanent block** of a distribution. Email first
to coordinate scope and terms before doing any on-chain testing beyond devnet.

## Safe harbor

Good-faith security research conducted within this policy — on devnet, without
harming users, privacy, or availability, and without exfiltrating data beyond what is
needed to prove a finding — is authorized, and we will not pursue action against
researchers who follow it. If in doubt about whether an action is in scope, ask first.
