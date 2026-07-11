# Dependency vulnerability waivers

**Policy (addresses external-audit finding 7 "audits are non-blocking").** CI **fails on any
unwaived high/critical advisory** for the internet-facing **notify-server** (the `notify-server`
job runs `audit-ci` gated by `security/audit-ci.jsonc`). Every accepted advisory is listed below
with its rationale. To accept a new one, add its GHSA id to `audit-ci.jsonc` **and** document it
here — never re-add `|| true`.

Scope note: the **notify-server** and the **Rust program** audits are **blocking**; the **mobile
app** audit stays *reported* by design (native APK, build-time deps) — see the sections below.
This waiver file is the single record for all three.

---

## Gated: notify-server (BLOCKING)

Both accepted advisories are **transitive via `@solana/web3.js`** and resolve only with a major
Solana-stack upgrade. The notify-server is a keyless service: it deserializes **fixed-layout
on-chain account data** and validated request bodies — it does not feed attacker-controlled
variable-length buffers into the vulnerable code paths.

| Field | Waiver 1 | Waiver 2 |
|-------|----------|----------|
| **Advisory** | GHSA-3gc7-fjrx-p6mg | GHSA-w5hq-g745-h8pq |
| **Package** | `bigint-buffer` | `uuid` (v3/v5/v6) |
| **Severity** | High | High (moderate in this tree) |
| **Direct/transitive** | Transitive: `@solana/web3.js` → `@solana/spl-token` → `@solana/buffer-layout-utils` → `bigint-buffer` | Transitive: `@solana/web3.js` / `jayson` → `uuid` |
| **Issue** | Buffer overflow in `toBigIntLE()` on attacker-controlled buffer sizes | Missing buffer bounds check when a `buf` is supplied |
| **Reachability here** | Low — server decodes fixed-size on-chain accounts (discriminator-checked), never passes untrusted-length buffers to `toBigIntLE` | Low — `uuid` is used internally by the RPC client for request ids, not on any untrusted-input path |
| **Production impact** | Low | Low |
| **Compensating controls** | Discriminator + bounds-checked account parsing; validated/size-capped request bodies; runs behind Caddy (CF-only origin, rate-limited) | Same request-path hardening; ids are server-generated |
| **Upgrade blocker** | Resolves only with a major `@solana/web3.js` (Solana-stack) upgrade | Same |
| **Owner** | Romulus-Sol | Romulus-Sol |
| **Review date** | Re-review before mainnet + on any `@solana/web3.js` major bump | same |
| **Planned resolution** | Drop when the Solana-stack upgrade lands | same |

---

## Also gated: Rust program (BLOCKING)

`cargo audit` in the `program` job is **blocking** (default mode: fails on **vulnerabilities**,
passes on informational warnings). As of 2026-07-11 the tree has **0 vulnerabilities** and **5
informational warnings** — all `unmaintained`/`unsound` notices on deep transitive Solana-stack
deps, none an exploitable vulnerability, so `cargo audit` (default) does not fail on them:

| RUSTSEC | Crate | Kind | Note |
|---------|-------|------|------|
| RUSTSEC-2025-0141 | `libsecp256k1` | unmaintained | transitive (Solana stack) |
| RUSTSEC-2025-0161 | `anyhow` | unmaintained | transitive build/tooling |
| RUSTSEC-2026-0190 | `rand` | unsound (`downcast_mut`) | transitive |
| RUSTSEC-2026-0097 | `rand` | unsound | transitive |

A future **vulnerability** (not a warning) will fail the gate. To accept one, add
`cargo audit --ignore RUSTSEC-…` in `ci.yml` and document it here. If we ever want to fail on the
informational warnings too, add `--deny warnings` (not done — they're non-exploitable noise here).

## Not gated (reported) — FINAL decision

- **Mobile app (`app-typecheck` job) — reported, and this is the settled decision.** The shipped
  artifact is a **native arm64 APK**; `yarn audit` surfaces ~30 high advisories that are almost
  entirely **build-time** dependencies (Metro bundler, Expo/EAS CLI, `tar` — e.g.
  GHSA-34x7-hfp2-rc4v node-tar — etc.) that **do not run in the shipped app**. The only
  *runtime-reachable* highs are the same `@solana/web3.js` transitive ones **already gated on the
  notify-server** above. Gating the app on RN/Expo build-tool churn would be pure noise + constant
  maintenance for zero shipped-app risk. **Decision: leave the app audit reported** unless a
  runtime-reachable-only audit mechanism becomes available (no such tool today for the RN bundle).

## Review cadence
Re-review this file **before the mainnet cutover** and on any major `@solana/web3.js` upgrade.
