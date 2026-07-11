# Dependency vulnerability waivers

**Policy (addresses external-audit finding 7 "audits are non-blocking").** CI **fails on any
unwaived high/critical advisory** for the internet-facing **notify-server** (the `notify-server`
job runs `audit-ci` gated by `security/audit-ci.jsonc`). Every accepted advisory is listed below
with its rationale. To accept a new one, add its GHSA id to `audit-ci.jsonc` **and** document it
here — never re-add `|| true`.

Scope note: the **mobile app** and the **Rust program** audits remain *reported* (non-blocking)
for now — see "Not yet gated" below. This waiver file is the single record for all three.

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

## Not yet gated (reported)

- **Mobile app (`app-typecheck` job) — reported.** The shipped artifact is a **native arm64
  APK**; `yarn audit` surfaces ~30 high advisories that are almost entirely **build-time**
  dependencies (Metro bundler, Expo/EAS CLI, `tar` — e.g. GHSA-34x7-hfp2-rc4v node-tar — etc.)
  that **do not run in the shipped app**. The only *runtime-reachable* highs are the same
  `@solana/web3.js` transitive ones gated above. Gating the app on build-tool churn would be
  noise + constant maintenance. **Revisit** when a runtime-reachable-only app audit is feasible.
- **Rust program (`program` job) — reported.** `cargo audit` was **0 vulnerabilities / 5
  informational** as of 2026-07-06. Enumerating current RUSTSEC ids and gating `cargo audit`
  (via `deny.toml` / `--ignore`) is a **follow-up** slice.

## Review cadence
Re-review this file **before the mainnet cutover** and on any major `@solana/web3.js` upgrade.
