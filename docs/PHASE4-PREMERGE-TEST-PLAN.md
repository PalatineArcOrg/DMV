# Phase 4 — Pre-merge Test Plan

Acceptance criteria for merging `phase4-transactional-heartbeat` into `devnet` (PR #51).

Phase 4 rewrote the heartbeat submission path, the deadline/escalation authority, the
agent key store and the rotation flow. It changes no on-chain program code, so the
risk is **not** fund safety — it is **liveness**: a regression here does not misroute
an estate, it stops an owner from proving they are alive. That is the failure this
plan is built to catch.

The code is thoroughly tested in isolation and **entirely unproven in the app**. No
APK containing it has ever been built.

## Standing rules

- **Devnet only. Mainnet remains NO-GO.**
- **Fox is not a test subject.** Tier 3 is the only tier that touches it, and only
  after every prior tier passes. Never submit a Fox heartbeat, rotate its agent,
  request a Fox owner signature or alter its notification registration to satisfy a
  step in this plan.
- Use **freshly generated disposable** owners, vaults and agents for Tier 2.
- Do not deploy or upgrade the program. Every APK build, install and devnet action is
  its own gate.
- **Any STOP condition halts the tier.** Record what happened and re-plan; do not work
  around it to reach a green line.

---

## Tier 0 — Complete

Evidence recorded in `docs/coordination/STATUS.md`.

| Check | Result |
|---|---|
| App unit suite (`npm test`) | 525/525, 35 files |
| `npx tsc --noEmit` | Clean |
| Metro/Hermes bundle (`expo export --platform android`) | Clean — 6.04 MB `.hbc`, zero resolution errors, app source present exactly once |
| Disposable local-validator rotation | 2/2 scenarios |
| CI (7 required jobs) | Green |

---

## Tier 1 — Pre-merge, no device required

These close the gaps CI cannot currently see. All are cheap. **All must pass before
Tier 2.**

### T1.1 — Legacy agent-key upgrade path ★ highest risk in the branch

`KeyManager` was rewritten around three SecureStore slots (`active` / `candidate` /
`previous`) and a new `dmv_agent_key_complete` marker. The `active` slot deliberately
reuses the legacy key names, and `AgentKeySlotManagerCore.readSlot` accepts a legacy
slot with no completion marker via its `isLegacyActive` branch. There is a unit test
for this.

**What is untested: a real store written by a pre-Phase-4 build.** Every existing
install has a key with no `complete` marker. If the legacy branch is wrong, readiness
returns `agent_missing` and **every existing user's heartbeat stops** — silently, from
their point of view, while the on-chain deadline keeps running.

- Construct a SecureStore state exactly as v1.13.20 wrote it: `dmv_agent_secret_key`,
  `dmv_agent_public_key`, `dmv_agent_key_auth` — and **no** `dmv_agent_key_complete`.
- Cover both auth flags: `'1'` (biometric-gated) and `'0'`/absent (no lock screen).
- Assert `hasCompleteSlot('active')`, `getPublicKey('active')` and `loadSlot('active')`
  all succeed and return the original key.
- Assert a subsequent rotation promotes correctly from a legacy `active` slot.

**Pass:** legacy keys load unchanged in all three auth shapes.
**STOP if:** any legacy shape yields `MissingSlotError` or `CorruptSlotError`.

### T1.2 — SQLite migration against a populated pre-Phase-4 database

Three new tables arrive via `database.ts`. Unit tests use fresh in-memory databases;
nobody has opened a populated legacy file.

- Take a database file written by a pre-Phase-4 build with real `heartbeat_history`
  rows, run migration, and assert: migration succeeds; existing rows survive; the new
  `heartbeat_operations`, rotation and candidate-funding tables and their partial
  unique index exist; a heartbeat can be recorded afterwards.
- Run migration **twice** to confirm idempotency.

**Pass:** no data loss, no migration error, second run is a no-op.

### T1.3 — Release-tier integration suite

The `integration` job is `workflow_dispatch`-only and skipped on PRs. It now also runs
`tests/agent-rotation-local-validator.ts`, picked up by Anchor's `tests/*.ts` glob.

- Dispatch it against the branch and confirm green.
- Confirm the reported test count matches expectation, and correct the stale
  "39-test suite" comment in `ci.yml` if it no longer holds.

### T1.4 — Hermes bundle gate wired in

PR #52 adds the Metro/Hermes bundle job. Merge it to `devnet`, then merge `devnet` into
this branch so PR #51 is actually gated by it — `pull_request` runs use the workflow
from the PR's own branch.

**Pass:** `app-bundle` appears green on PR #51.

---

## Tier 2 — Device acceptance on a disposable vault

Requires an APK build (its own gate) and a device install (its own gate).

### T2.0 — Build gate: what to assert on the APK

Build via the authoritative local wrapper (`release-tools/build-android-release.sh`),
**not** EAS. EAS signs with its own managed credentials, which would change the signing
certificate and force an uninstall — destroying the very SecureStore agent key T2.1
exists to test.

Assert on the built APK: package `com.romulusol.deadmansvault`, versionName `1.13.21`,
versionCode `107`, ZIP integrity, attestation `commit` / `expectedCluster` / `apkSha256`,
and above all that the signing certificate equals the shipped v1.13.20 certificate
(`FAC61745…033B9C`). `expo prebuild --clean` regenerates `android/` from a template
carrying a fixed debug keystore, and that is what preserves in-place upgradeability.

> **Do not expect a single ABI.** A correct build ships **four** — `arm64-v8a`,
> `armeabi-v7a`, `x86`, `x86_64` — and the shipped v1.13.20 contains exactly the same
> four. `reactNativeArchitectures=arm64-v8a` in `gradle.properties` only governs which
> React Native libraries are **compiled from source**; prebuilt `.so` files from
> dependencies are packaged for every ABI regardless. A four-ABI APK is therefore normal
> and must not be flagged. Compare ABI shape against the previous shipped release, not
> against `reactNativeArchitectures`. (Measured 2026-08-08 on the v1.13.21 build: four
> ABIs, 70,552,539 bytes — within 84 KB of v1.13.20's 70,468,291.)

Building on this host needs swap: peak demand is ~5 GB across the Gradle JVM
(`-Xmx3072m` + 768 MB metaspace) and a separately forked Kotlin compile daemon (~1.9 GB).
See the Swap section of the root `CLAUDE.md`.

### T2.1 — Upgrade in place over the existing install ★ do this first

Not a fresh install. Install over an existing pre-Phase-4 build that already holds a
real agent key and heartbeat history — this is what every current user will experience,
and it is the on-device counterpart to T1.1 and T1.2.

**Pass:** app launches; the vault is recognised; the agent key still matches the
on-chain agent; the dashboard reaches a verified deadline state; a heartbeat succeeds.
**STOP if:** the dashboard reports `agent_missing` or `agent_mismatch` after an upgrade
that changed no key. That is the regression this whole tier exists to catch.

### T2.1 result — 2026-08-08: PASS (key survival)

A SecureStore slot written by v1.13.20 was read by Phase 4 for the first time on a
Seeker and the key survived: the Settings rotation card showed the agent matching the
on-chain value, with no "Recovery required". `isLegacyActive` is validated on real
hardware.

**Provenance caveat, recorded deliberately.** The evidence was gathered while the device
had a **custom RPC override** set in Settings. That mattered, because the APK used for
this run was built without `.env` and therefore had no default RPC (see remediation
Phase 13) — the override was the only reason the app could reach chain at all.

The result nevertheless stands, because **key survival is RPC-independent**:
`hasAgentKey()` / `getAgentPublicKey()` read SecureStore only. The RPC was needed solely
to fetch the on-chain agent for comparison, and that fetch demonstrably succeeded — the
card rendered the matching pubkey. A different endpoint could not have made a missing
key appear present.

Two criteria did **not** clear on that run and are re-run against a corrected build:

- the cold-start "Agent Recovery Required" alert — a false negative, tracked as
  Phase 12; its criterion moves to the first build containing that fix;
- heartbeat submission and deadline rendering — blocked by the RPC-less build, retested
  per the acceptance run below.

### T2.1b — acceptance run for a corrected build

Run against an APK whose attestation carries a non-empty `rpcHost` and which passed the
wrapper's bundle check. **Leave any custom RPC override in place** until the corrected
build is installed and (a) passes — the override is what keeps the device usable.

**(a) Heartbeat succeeds.** Tap heartbeat. It must reach `confirmed_on_chain`, not
`invalid_on_chain_state`. Verify **on-chain via an independent RPC** (not the app's) that
`total_heartbeats` advanced **3 → 4** and `last_heartbeat` moved. The on-chain read is
the verdict; the UI is corroboration.

**(b) Deadline renders verified.** The status card must show a real countdown, not
"Deadline unverified". *Depends on production mode being on:* stage durations must sum
to the on-chain grace (259,200+604,800+604,800 = 1,468,800 = 17d). In demo mode the sum
is 90s and `stage_configuration_invalid` is expected and correct — confirm the mode
before reading this as a failure.

**(c) No regression on the rotation card.** Agent still matches on-chain, vault Active,
interval/grace correct, no "Recovery required". This path worked on the previous build;
it must not break.

**Not in this run: the cold-start alert.** The false "Agent Recovery Required" is
Phase 12 and is not fixed in a build made from the Phase 4 head. That criterion belongs
to the **first build containing `wp1-startup-key-check-fix`** — i.e. after that branch is
reviewed and merged. Expect the alert to still appear here; it is a known false negative
and not a T2.1b failure.

### T2.2 — Normal heartbeat

Readiness passes → fee state shown → tap → **no premature success**. The button must
not turn green until confirmation *and* post-state verification complete.

**Pass:** signature appears; Explorer shows success; `total_heartbeats` increases by
exactly one; `last_heartbeat` advances; the next deadline is recomputed from chain
state; local history stores the confirmed signature; the notification quotes a next-due
date derived from the verified chain timestamp, not from when the button was pressed.

### T2.3 — Failure paths

Exercise, individually: RPC unavailable before signing; agent below the exact fee;
device key locked/unavailable; agent/on-chain mismatch (disposable setup only);
on-chain program rejection; confirmation timeout.

**Pass, for every case:** no green "Vault Secured"; no local history success; no
escalation reset; no success notification; a distinct and accurate message; the
signature stays visible and durable wherever submission may have occurred; **no
automatic resend**.

### T2.4 — Restart reconciliation

Kill the app between submission and confirmation. Reopen.

**Pass:** the journal is read on focus; the signature reconciles to the correct
outcome; no second heartbeat is ever sent automatically; confirmed local state is
repaired idempotently.
**Also assert:** while the operation is blocking, a new heartbeat is refused with a
clear message, and that block **clears by itself** within roughly blockhash expiry
(~60–90s) once the outcome is known. A block that persists indefinitely is a STOP —
that is a liveness failure, not a safety feature.

### T2.5 — Deadline and escalation authority

Use a disposable short-duration vault or demo mode. Never a long-lived vault.

**Pass:** stages 0–3 track canonical chain timing; device wall clock is not authority;
crossing the final deadline forces a fresh chain read rather than projecting into
Stage 4; the boundary matches the program exactly (`now < finalDeadline` permits a
heartbeat, `>=` is executable).

### T2.6 — Agent fee readiness and top-up

**Pass:** exact fee and current balance displayed; low reserve **warns without
blocking** an affordable heartbeat; verified insufficiency blocks *before* signing;
top-up discloses amount plus owner fee, takes one owner signature, reaches the
canonical agent, and changes no heartbeat count, liveness or escalation state.

### T2.7 — Crash-safe rotation

On a disposable vault: create candidate → confirm the active key is untouched → fund
candidate → owner-authorised rotation → interrupt around submission if practical →
reconcile.

**Pass:** candidate becomes the authorised on-chain agent; `total_heartbeats` did not
increment during rotation; the old agent's heartbeat is now rejected; the new agent's
heartbeat succeeds; the old key is retained in the `previous` slot.

### T2.8 — Notification registration and stage alerts

**Pass:** registration status is accurate and deliberate; no duplicate active
registration; stage 1, 2 and 3 pushes each arrive exactly once on a short-duration
disposable vault, with content matching the stage; pushes still arrive with the app
backgrounded, killed and the device locked; a successful heartbeat stops later stage
alerts.

### T2.9 — Degraded network behaviour

Phase 4 raised RPC usage materially: the deadline refresh is four calls every 30s while
the dashboard is mounted, and a heartbeat attempt costs roughly fifteen calls against
about four before. This repo has a documented history of 429s.

**Pass:** under a throttled or rate-limited RPC the readiness gate degrades to a clear
"could not verify" state and **recovers** — it must not latch into permanently refusing
taps. Record observed call volume.

---

## Tier 3 — Fox

Only after Tiers 0–2 pass in full and the results are reviewed.

Fox is a live devnet vault with a running deadline. Treat the first Fox heartbeat on a
Phase 4 build as a distinct, deliberate, observed action. Confirm beforehand that Fox
has a large margin to its deadline, so that a failure is recoverable by reverting to
the previous build rather than by racing a clock.

---

## Merge criteria

Merge PR #51 only when: Tier 1 fully passes; Tier 2 passes on a disposable vault; CI
including `app-bundle` is green; the diff has been reviewed; and merge is explicitly
authorised for that PR. Green CI alone is not sufficient — no CI job in this repository
can observe a heartbeat failing on a real device.
