# DMV Repository Coordination

These rules apply to every task in this repository unless the user explicitly
authorizes a narrower exception for one exact action.

## Network and live-system boundaries

- Devnet only.
- Mainnet remains NO-GO.
- Never touch Fox unless the user explicitly authorises one exact action.
- Never submit a Fox heartbeat.
- Never rotate Fox's agent.
- Never request a Fox owner signature.
- Never alter Fox's notification registration.
- Do not deploy or upgrade the Solana program without a separate explicit gate.
- Treat a disposable devnet canary as a live action that requires its own explicit
  gate and must never use Fox.

## Seeker and Android boundaries

- Never uninstall the current Seeker app.
- Never clear Seeker app data.
- Never build or publish an APK unless explicitly authorised.
- Never change Android signing identity unless explicitly authorised.

## Secrets and destructive actions

- Never expose private keys, seed phrases, credentials, notification tokens or
  environment values.
- Never delete files, backups, worktrees, APKs or credentials without explicit
  authorisation.

## Git and delivery

- Do not merge PRs.
- Do not begin another phase automatically.
- Use normal branches; no force-push, rebase or detached-HEAD development.
- Work one coherent work package at a time.
- A program deployment, devnet canary, APK operation, signing-identity change and
  draft PR are separate gates; approval for one does not approve another.

## Work-package discipline

- Run relevant tests after every work package.
- Update `docs/coordination/STATUS.md` before stopping.
- Stop after each major gate so the user can review the result.
- Separate genuine security/safety blockers from documentation or evidence
  housekeeping.
- Correct prior assumptions openly when source inspection disproves them.
- Prefer the onchain vault and heartbeat accounts as liveness authority. Never
  describe the heartbeat path as local-only.

## Phase 4 boundary

- Follow `docs/coordination/PHASE4.md` and record durable choices in
  `docs/coordination/DECISIONS.md`.
- Do not implement Phase 4 merely because its design documents exist.
- Any proposed program-level rotation hardening must first be separated from
  app-only work, checked against the deployed devnet program and approved through
  the program-upgrade gate.
