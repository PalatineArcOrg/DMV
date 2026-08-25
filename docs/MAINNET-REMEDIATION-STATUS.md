# DMV Mainnet Remediation — Status

Public status tracker for the pre-mainnet hardening + protocol-redesign work. This is the tracked,
sanitized companion to a private authoritative implementation plan (see **Plan authority** below).
It intentionally contains **no exploit mechanics** — only phase/branch/status information.

**Overall status:** IN PROGRESS — Phases 1–3 complete (merged to `devnet`); Phase 4 in review (draft PR,
not merged); Phases 5–10 not started; Phases 12, 13 and 14 have fix branches open in [PR #55](https://github.com/Romulus-Sol/DMV/pull/55); Phases 11 and 15 are unfixed. **Phases 11–15 are all mainnet-blocking and were all found by on-device / live-service observation, not by any offline gate.**
**Mainnet:** NO-GO until the Track B phases (6–10) ship and pass an external implementation review.
**Last updated:** 2026-08-25.

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
| 11 | **Agent-rotation preflight recovery** | `wp1-rotation-preflight-recovery` | A | 🔴 **Not started — MAINNET BLOCKING** | — |
| 12 | **Startup key-presence check requires authentication** | `wp1-startup-key-check-fix` | A | 🟠 **Fix branch open — MAINNET BLOCKING** | 8 new tests; app 562/562; tsc clean |
| 13 | **Release preflight must fail closed on a missing/invalid RPC URL** | `wp1-preflight-rpc-fail-closed` | A | 🟠 **Fix branch open — MAINNET BLOCKING** | 9 new preflight tests (27 total); 7 fail if the gate is reverted |
| 14 | **Account guard broke under Hermes — heartbeats impossible on device** | `wp1-parser-hermes-subarray` | A | 🟠 **Fix branch open ([PR #55](https://github.com/Romulus-Sol/DMV/pull/55)) — MAINNET BLOCKING** | 5 new tests; 3 fail if the fix is reverted; app 571/571; verified on-chain on device |
| 15 | **Vault re-creation leaves notifications silently unregistered** | `wp1-registration-lifecycle` | A | 🔴 **Not started — MAINNET BLOCKING** | — |

Phases run one at a time; each is implemented on its own branch, fully tested, reviewed, and merged
before the next begins.

### Phase 11 — agent-rotation preflight refuses recovery in the states it exists to fix

**MAINNET BLOCKING.** Found 2026-08-08 while establishing recovery paths ahead of on-device
Phase 4 acceptance.

The app cannot rotate the agent key in exactly the situations where rotation is the remedy.
`AgentRotationCoordinator.commonPreflight` resolves the on-chain agent against local
SecureStore and refuses unless it is found in the **active** slot:

```ts
const stored = await dependencies.resolveStoredAgent(preflight.value.state.agent.toBase58());
if (stored.status !== 'active_match') return { status: 'active_agent_mismatch' };
```

`commonPreflight` gates **both** `createCandidate` and `rotate`, so a user in a broken state
cannot even generate a candidate:

| Broken state | `resolveForOnChainPublicKey` | Rotation |
|---|---|---|
| Key lost or unreadable after an upgrade/reinstall | `no_match` | refused |
| Slot present but fails validation | `corrupt_slot` | refused |
| Key survives only in the `previous` slot | `previous_match` | refused |

The restriction is client-side only. On-chain `rotate_agent` takes three accounts — `owner`
(Signer), `vault_config`, `heartbeat_record` — and the old agent never signs, so the protocol
permits exactly the recovery the app blocks. The web owner console has no rotation path, so
there is currently **no shipped route** for an owner whose agent key is gone.

Impact: such an owner cannot restore liveness through any first-party client. The switch keeps
counting down while the app reports rotation unavailable. On mainnet that is a path to an
unwanted distribution with no user-accessible remedy.

Proposed fix (design only — **not implemented**): allow owner-signed rotation to proceed when
resolution is `no_match`, `corrupt_slot` or `previous_match`. None of those weakens the
guarantee — owner authority plus candidate possession is unchanged; only the *old* key's
whereabouts differ. Keep `active_match` as the normal path and keep refusing
`multiple_matches`. Requires review of the WP 4.7 promotion invariants, which assume the old
active key is present and readable (`promoteCandidate` requires `active.publicKey === oldAgent`).

Interim mitigation: a standalone break-glass client that submits owner-signed `rotate_agent`
directly, proven end-to-end on a disposable devnet vault (create → destroy agent key → rotate
with the owner key alone → new agent heartbeats → old agent rejected). It is an operator tool,
not a user-accessible remedy, so it does not clear this phase.

### Phase 12 — startup key-presence check requires authentication (false "Agent Recovery Required")

**MAINNET BLOCKING.** Reproduced on a Seeker 2026-08-08 during Phase 4 on-device
acceptance, upgrading v1.13.20 → 1.13.21.

A fingerprint prompt appears at cold start and is followed by **"Agent Recovery
Required — The on-chain heartbeat agent does not match a usable active key on this
installation."** The key is intact: Settings then shows the agent matching on-chain
(`Create candidate` offered, no recovery warning).

Phase 4 changed what "do I have a key?" means:

| | v1.13.20 | Phase 4 |
|---|---|---|
| `getAgentPublicKey()` | `getItemAsync(PUBLIC_KEY)` — unauthenticated | `getPublicKey('active')` → `readSlot()` |
| `hasAgentKey()` | `getItemAsync(PUBLIC_KEY)` — unauthenticated | `hasCompleteSlot('active')` → `readSlot()` |

`readSlot()` loads the **secret** under `requireAuthentication` when `auth === '1'`.
`RootNavigator` runs the check at launch, in a background async block with no resumed
Activity, so the read cannot prompt, throws, and a healthy key is reported missing.

Impact is worse than a cosmetic alert: it tells owners their agent is unusable and
directs them to the recovery flow. An owner who acts on it replaces a working key — and
under Phase 11 may find rotation refused midway, leaving them worse off than if they had
ignored the app.

**Fix (this branch):** add metadata-only `hasStoredSlot` / `getStoredPublicKey`, sharing
`readSlot`'s shape rule (including the legacy-active allowance) but never touching the
secret, and point the two startup-facing `KeyManager` methods at them. Presence answers
"is a key stored?"; loading for signature still requires authentication, so custody is
unchanged. Eight tests model a cold start where every authenticated read throws; three
fail if the fix is reverted.

### Phase 13 — release preflight passes a build with no RPC URL

**MAINNET BLOCKING.** Found 2026-08-08 when a Phase 4 acceptance APK proved unable to
reach Solana.

`EXPO_PUBLIC_RPC_URL` is inlined into the JS bundle at build time and becomes
`DEFAULT_RPC_URL`. The release preflight validated the RPC URL **only for mainnet
builds** — for devnet it merely formatted the value for display:

```js
`rpc=${rpc ? redact(rpc) : '(unset)'}  notify=${notify ? redact(notify) : '(unset)'}`
```

So a devnet release built without `.env` printed `rpc=(unset)`, **passed**, and was
attested as a valid production artifact. The resulting APK had an empty
`DEFAULT_RPC_URL`. Constructing the RPC connection then throws, and because
`HeartbeatCoordinator` collapses any throw from readiness into one state, the owner
sees only *"The on-chain vault state could not be validated safely. No local or
on-chain heartbeat was recorded."* — with no indication that the build has no
endpoint. The deadline fails identically. **Heartbeats are impossible and the cause is
invisible.**

This directly contradicts Phase 1's goal that *"a production client build cannot bypass
its network/manifest preflight"*: the gate existed and the absence sailed through it.

**Fix (this branch):**

- `validateRpcUrl` runs on **every** cluster: present, parseable, HTTPS, no embedded
  credentials. Absence is an error, not a formatted `(unset)`.
- Cluster/host consistency, asymmetric by design: a mainnet build rejects
  devnet/testnet/local hosts; a devnet build rejects mainnet hosts. A devnet host is
  deliberately **not** required to contain the literal "devnet" — neutral first-party
  proxy hostnames are legitimate devnet endpoints and such a rule would reject them.
- The release wrapper now greps the built `assets/index.android.bundle` for the
  resolved RPC host and **refuses to attest** if absent. Preflight proves the value was
  in the environment; this proves it reached the bundle.
- The attestation records `rpcHost`, so an artifact's endpoint is auditable after the
  fact.

**The regression test is the absence**, since silent absence was the gap: nine tests
cover unset, empty/whitespace, malformed, non-HTTPS, mainnet-host-on-devnet, embedded
credentials (asserting the secret never reaches errors or summary), plus positive cases
for a neutral proxy host and a real devnet provider. Seven fail if the gate is removed.

> **Withdrawn:** an earlier Phase 13 recorded a suspected on-device defect where
> heartbeat readiness returned `invalid_on_chain_state`. That was **diagnosed in error** —
> the cause was this preflight gap producing an RPC-less APK, not application code. A
> `BigInt`/`readBigUInt64LE` hypothesis raised during that investigation was also
> refuted (the rotation card exercises the same parser successfully on-device). Both are
> recorded here so neither is re-investigated.


### Phase 14 — account guard depended on a Buffer-only method; Hermes made heartbeats impossible

**MAINNET BLOCKING — the most severe defect found in Phase 4 acceptance.** Reproduced on
a Seeker 2026-08-08; fixed and confirmed on-chain the same day.

`isProgramAccount`, the gate every raw account parser runs first, ended with:

```js
info.data.subarray(0, 8).equals(disc)
```

`buffer@6.0.3` overrides `Buffer.prototype.slice` but **not `subarray`**, so `subarray` is
inherited from `Uint8Array`. Under Node, species handling returns a `Buffer` and `.equals`
exists. **Under Hermes it returns a plain `Uint8Array`, which has no `.equals`** — the call
threw a `TypeError`.

`isProgramAccount` is invoked **outside** each parser's `try/catch`, so the throw escaped to
the caller. `AgentReadinessService` caught it and returned
`invalid_on_chain_state('vault account validation failed')`.

**Effect: no heartbeat could be submitted at all.** The dead-man's switch could not be reset
from the device. The deadline failed identically (same accounts, same parser), and agent
rotation was stuck at *create candidate* because its preflight parses the same accounts. The
owner saw only *"The on-chain vault state could not be validated safely"* — the same string
for every possible cause.

**Why no automated gate caught it:**

- `tsc`, 571 unit tests and a Metro/Hermes bundle check all passed. Node's `subarray` returns
  a `Buffer`, so the defect is invisible off-device by construction.
- `fetchVaultConfig` tries Anchor first and falls back to the raw parse, so before Phase 4
  this path was rarely load-bearing. Startup vault fetch, the migration alert and the rotation
  card's *display* all kept working, which repeatedly misdirected diagnosis.
- **Phase 4 made the raw parse the sole path** for heartbeat readiness and the deadline. A
  long-latent defect became fatal.

**Fix:** an index-based prefix compare depending on nothing but indexing. Adds
`programAccountProblem`, which names the failing check — owner, length or discriminator —
rather than returning a bare boolean. Five tests pass plain `Uint8Array` data to model the
Hermes shape; they fail three ways against the original implementation, and a `Buffer` case
pins that off-device behaviour is unchanged.

**Verified on device:** after installing the fix, `total_heartbeats` advanced 3 → 4 → 5,
confirmed on two independent RPCs.

**Standing lesson.** This is the fourth Hermes-only failure in this codebase, after v1.13.0,
v1.13.9 and v1.13.16. The existing guardrail says to keep hot-path helpers inline; it should
be widened: **on a Hermes hot path, do not rely on `Buffer`-only methods surviving a
`subarray`/`slice`, and do not place a throwing guard outside the `try` that is meant to
contain it.** Both halves were required to turn this into a total loss of function — the
second is what made a parse failure indistinguishable from every other cause.

### Phase 15 — revoke-and-recreate silently ends escalation notifications

**MAINNET BLOCKING.** Observed on devnet 2026-08-25: no escalation notifications arrived for
an overdue vault. Server-side diagnosis found the vault was not being watched at all.

Sequence, from the notify-server's own log:

```
Aug 08 15:14:57   revoke_vault closes the vault account on-chain
Aug 08 15:15:00   [drop] deregistered_missing -> GoNx3dqY     (poller.js:120)
Aug 08 15:18:03   initialize_vault re-creates a vault at the SAME address
                  ...nothing re-registers it
```

The registrations table then held **zero rows**, and the server logged **zero FCM sends**
afterwards. The vault went overdue on 2026-08-24 and entered Stage 1 with no push.

**Neither component is malfunctioning.** The poller's auto-drop is correct and carefully
guarded — it re-checks liveness, network verification and program readiness *after* the probe
before deleting, so a transient blip cannot drop a registration. `revokeVault.ts` documents the
behaviour as intentional: *"the notify-server's poller auto-drops the registration … the
on-chain close is the source of truth and needs no extra prompt."* For a revoke that ends a
vault's life, that is right.

**The gap is the lifecycle.** The design treats revoke as terminal, but revoke-and-recreate is
an ordinary flow — the app even supports atomic close+reinit for zombie vaults. Nothing
re-registers on vault creation, registration is deliberately owner-signed so it cannot
reattach itself, and **nothing in the UI indicates the vault is unwatched**. The owner is left
believing they are covered.

That matters more here than in most products. Escalation pushes are the mechanism by which a
living owner learns their switch is counting down. Losing them silently is a path to an estate
distributing while the owner is alive and unaware — the exact failure the product exists to
prevent. Execution itself is unaffected: the keeper cranks from on-chain state and does not
depend on registration.

A second instance of the same class: **the FCM device token changes on every app reinstall**,
so a reinstalled app is also silently unwatched until the owner re-registers, with no signal
that anything is wrong.

**Proposed fix (design only — not implemented):**

- On successful vault creation, if a registration previously existed for that owner (or the
  app holds a prior signed-registration record), prompt to re-register rather than leaving it
  to the owner to remember.
- Surface registration state on the Dashboard — an explicit "notifications: not registered"
  is the missing signal, and it covers the reinstall case for free.
- Consider having the server distinguish *deregistered because the vault ended* from
  *deregistered because it went missing mid-life*, so the two are auditable apart.

Care is needed not to overcorrect: registration must stay a deliberate owner-signed action,
and re-registration must not become an automatic background call. The fix is a prompt and an
indicator, not silent re-registration.

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
11. **Rotation preflight recovery** — an owner whose agent key is lost, unreadable or only present in the `previous` slot can still rotate through a first-party client; the app stops refusing the one action that restores liveness.
12. **Startup key presence** — a cold-start presence check answers from unauthenticated metadata, so a device that cannot show a biometric prompt never reports a healthy key as missing.
13. **Release RPC gate** — no release build, on any cluster, can be produced or attested without a valid RPC URL that reaches the bundle.
14. **Hermes-safe account parsing** — the account guard depends only on indexing, and a guard that can throw sits inside the try that contains it.
15. **Registration lifecycle** — a vault cannot end up unwatched without the owner being told; re-creation and reinstall both surface the unregistered state instead of failing silently.

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
