# DMV Mainnet Remediation — Status

Public status tracker for the pre-mainnet hardening + protocol-redesign work. This is the tracked,
sanitized companion to a private authoritative implementation plan (see **Plan authority** below).
It intentionally contains **no exploit mechanics** — only phase/branch/status information.

**Overall status:** IN PROGRESS — Phases 1–3 complete (merged to `devnet`); Phase 4 in review (draft PR,
not merged); Phases 5–10 not started.
**Mainnet:** NO-GO until the Track B phases (6–10) ship and pass an external implementation review.
**Last updated:** 2026-07-31.

---

## Plan authority

The detailed implementation plan is maintained privately (it discusses not-yet-shipped changes in
depth) and is **not** committed to this public repository by design. Its integrity is pinned by hash:

| | |
|---|---|
| Document | `dead-mans-vault/tasks/MAINNET-REMEDIATION-IMPLEMENTATION-PLAN.md` (private / local) |
| SHA-256 | `7201a633ffafd869380911d8d5661fe34944074e9c964363b76d966ee1e30116` |
| External review | Reviewed + **approved** 2026-07-13 (corrections applied); implementation underway |
| Baseline | `audit-2026-07-10` tag (program byte-identical since) |

A phase begins only after the private plan is reviewed and its SHA-256 recorded in the local
remediation log. This file is updated as phases complete.

---

## Work packages & phases

**Track A** = client/server/CI hardening (no program `.rs` change).
**Track B** = the reduced protocol redesign (program + client + tests).

| # | Phase | Branch | Track | Status | Tests |
|---|-------|--------|-------|--------|-------|
| 1 | Production build preflight enforcement | `wp1-production-preflight-enforcement` | A | ✅ **Complete** — merged to `devnet` `6255e18` ([PR #39](https://github.com/Romulus-Sol/DMV/pull/39)) | CI green ([run 29279995835](https://github.com/Romulus-Sol/DMV/actions/runs/29279995835)) |
| 2 | Server & keeper operational-readiness | `wp1-operational-readiness` | A | ✅ **Complete** — merged to `devnet` `2beba3f` ([PR #41](https://github.com/Romulus-Sol/DMV/pull/41)) | CI green ([run 29501916126](https://github.com/Romulus-Sol/DMV/actions/runs/29501916126)); notify-server 183 + keeper-bot 86 unit tests |
| 3 | Owner-signed notification registration | `wp1-signed-notification-auth` | A | ✅ **Complete** — merged to `devnet` `c0723a0` ([PR #48](https://github.com/Romulus-Sol/DMV/pull/48)) | CI green |
| 4 | Verified heartbeat transport | `phase4-transactional-heartbeat` | A | 🔍 **In review** — draft PR open, **not merged**; on-device acceptance testing outstanding | app 525/525 + tsc + Metro/Hermes bundle; disposable local-validator rotation 2/2 |
| 5 | Release artifact & IDL provenance | `wp1-release-provenance` | A | Not started | — |
| 6 | Decouple SOL finalization from token bequests | `wp2-sol-finalization` | B | Not started | — |
| 7 | Persistent vault authority + logical revocation | `wp2-persistent-vault-authority` | B | Not started | — |
| 8 | Non-closing late-SOL distribution | `wp2-late-sol-sweep` | B | Not started | — |
| 9 | Post-finalization token recovery + client alignment | `wp2-post-finalize-token-recovery` | B | Not started | — |
| 10 | Regression, fuzzing, docs, external-review package | `wp2-mainnet-review-candidate` | B | Not started | — |

Phases run one at a time; each is implemented on its own branch, fully tested, reviewed, and merged
before the next begins.

---

## Phase goals (high level)

1. **Preflight enforcement** — a production client build cannot bypass its network/manifest preflight; the authoritative Android release runs through a single attested local wrapper; the web build runs preflight automatically.
2. **Operational readiness** — mainnet services fail closed on static misconfiguration, degrade (not crash) on transient dependency loss, and never let an executor problem silence owner notifications; separate `apiReady / fcmReady / networkVerified / pollerReady / executorReady / escalationReady` health domains.
3. **Signed notifications** — mainnet notification registration/deregistration proves control of the owner wallet; token-refresh is reconciled deliberately rather than in the background.
4. **Heartbeat transport** — heartbeat *submission* fails open; heartbeat *confirmation* fails closed via independently verified RPC endpoints in distinct failure domains.
   > **Delivered scope note (Phase 4 branch).** The confirmation half is complete and then some: transaction results are classified structurally (`value.err` inspected, ambiguous outcomes preserved as recoverable), post-state is verified against the canonical `HeartbeatRecord`, submitted signatures are journalled durably before send and reconciled read-only without automatic resend, and deadline/escalation authority is pinned to confirmed chain time. **The multi-endpoint half is not delivered** — every read and write uses one RPC connection, so there is currently no second failure domain. Separately, the readiness preflight means a tap now requires two successful account reads before submission, which narrows "submission fails open" relative to the prior behaviour. Both are recorded as open review items in `docs/coordination/STATUS.md`; neither is a devnet blocker.
5. **Release provenance** — one enforced IDL across build variants; a clean CI-built, hash-attested production program artifact; enforceable dependency waivers; documented required checks.
6. **SOL-finalization decoupling** — SOL inheritance finalizes independently of token/NFT bequests; a stuck token can never block it.
7. **Persistent authority** — no v1 instruction destroys the core vault account; revocation is a logical, terminal deactivation that preserves owner withdrawal rights.
8. **Late-SOL distribution** — a repeatable, non-destructive sweep of post-finalization SOL to the deterministic largest-share beneficiary.
9. **Post-finalization recovery** — executors/keeper continue token/NFT recovery after SOL finalization; all removed-instruction call sites are gone across app/web/keeper/notify.
10. **Review candidate** — full regression + fuzz suite, migrated tests, coordinated deployment runbook, and an external-implementation-review package pinned to the final commit.

---

## Deployment model (summary)

- **Devnet:** a single coordinated maintenance cutover (services stopped → program deployed → IDL published → services/clients updated → smoke vault → resume). Existing devnet accounts may retain unrecoverable rent after the upgrade.
- **Mainnet:** one externally-reviewed program/client release, deployed before any public vault creation is enabled; upgrade authority transferred to the designated multisig after the smoke vault passes.

Devnet and mainnet use different compiled program binaries (a demo-timing feature vs production
timing floors) with different `.so` hashes but the **same** IDL; the release attestation records the
exact binary, IDL, and manifest hashes with the enabled feature set.

---

## Residual risks (disclosed)

Persistent core PDA; permanently-locked core rent; terminal revocation (no same-wallet v1 re-init);
largest-beneficiary late-SOL semantics; token recovery after finalization relies on first-party keeper
retries rather than a second on-chain bounty; RPC-provider independence is operator-attested; release
safety depends on branch-protection enforcement and deploying the attested CI artifact; the Android
APK is built on a controlled host (the program `.so` is CI-built and reproducibly attested).
