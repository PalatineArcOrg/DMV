# Deploying the DMV notify-server

The notify-server watches vault heartbeats on-chain, sends FCM escalation pushes,
and (optionally) runs the keyless distribution crank after grace. It holds **no
authority over funds** — its cranker keypair only pays fees/rent — but it does
hold secrets (the shared register secret, a Helius RPC URL with an api-key, the
FCM service-account, and the cranker keypair). Treat those as sensitive.

Files here (`.example` — copy and edit, do not commit real values):

- `dmv-notify.service.example` — systemd unit (non-root, hardened, fail-closed).
- `Caddyfile.example` — reverse proxy with automatic TLS.

## Security checklist

### Run as a dedicated non-root user
```bash
sudo useradd --system --home /opt/dmv/notify-server --shell /usr/sbin/nologin dmv
sudo mkdir -p /opt/dmv/notify-server/data
sudo chown -R dmv:dmv /opt/dmv/notify-server
```
Never run the service as root. The unit sets `User=dmv` plus `NoNewPrivileges`,
`ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`, and restricts writes to the
SQLite `data/` directory only.

### Bind to loopback; Caddy is the only public entry
The Node process listens on `127.0.0.1:8787` (loopback) — it is never exposed
directly. Caddy terminates TLS and reverse-proxies to it. Do not add a public
listen address to the Node process.

### `.env` — mode 600, owned by the service user
Holds `REGISTER_SECRET` and the Helius `RPC_URL` (with its api-key).
```bash
sudo -u dmv cp .env.example /opt/dmv/notify-server/.env   # then edit
sudo chown dmv:dmv /opt/dmv/notify-server/.env
sudo chmod 600 /opt/dmv/notify-server/.env
```
Set `NODE_ENV=production` and a long random `REGISTER_SECRET` — the server
**refuses to boot** in production without a secret (fail-closed). Rotate the
secret periodically; note it also ships inside the app bundle, so it is weak
authenticity only (registration is additionally on-chain ownership-proofed; the
owner-signed path exists in-code but is dormant). Set **`EXPECTED_CLUSTER`** to the
cluster you're deploying (`devnet`/`mainnet-beta`) — the server verifies the RPC's
**genesis hash** at boot and **refuses to start (exit 1) on a mismatch or an
unreachable RPC**.

### Cranker keypair — mode 600
Only needed if `EXECUTOR_ENABLED=1`. Fund it with a little SOL; it pays fees/rent
and is **not** a vault authority. On `EXPECTED_CLUSTER=mainnet-beta` the server
**won't boot with the executor off** unless you explicitly set `ALLOW_NO_EXECUTOR=1`
(a deliberate notify-only mainnet that delegates cranking to the keeper-bot) — so a
crankerless mainnet can't ship by accident.
```bash
sudo -u dmv chmod 600 /opt/dmv/notify-server/cranker.json
```
Monitor its balance — the executor caps per-vault spend, but running the crank
still costs fees/rent over time.

### Firebase service-account JSON — mode 600
```bash
sudo chown dmv:dmv /path/to/fcm-service-account.json
sudo chmod 600 /path/to/fcm-service-account.json
```
Keep it outside the git working tree (it is gitignored). Point
`FCM_SERVICE_ACCOUNT` at it.

### Firewall
Only 80/443 (Caddy) and SSH (22) should be reachable from the internet. Port
8787 must NOT be open externally — it is loopback-only, but confirm your firewall
(e.g. `ufw`) does not expose it. PostgreSQL/Redis/etc. from other services must
also stay bound to `127.0.0.1`.

### Log hygiene
The server never logs raw device tokens or signatures, and `/health` masks the
RPC api-key. Caddy is configured (see `Caddyfile.example`) to log request
metadata only, not bodies. If you add logging, keep tokens/signatures/secrets out
of it, and rotate logs (`roll_size`/`roll_keep` in the Caddyfile, or `logrotate`).

## Install

```bash
# 1. Deploy code
sudo -u dmv git clone <repo> /opt/dmv          # or rsync; app lives in notify-server/
cd /opt/dmv/notify-server && sudo -u dmv npm install --omit=dev

# 2. Secrets (see checklist above): .env (600), cranker.json (600), FCM JSON (600)

# 3. systemd
sudo cp deploy/dmv-notify.service.example /etc/systemd/system/dmv-notify.service
# edit paths / User / absolute node path, then:
sudo systemctl daemon-reload && sudo systemctl enable --now dmv-notify

# 4. Caddy
# add deploy/Caddyfile.example (edited) to /etc/caddy/Caddyfile, then:
sudo systemctl reload caddy

# 5. Verify
curl -s https://notify.example.com/health   # { ok, executorReady, ... rpc api-key masked }
```

Run the test suite before deploying: `npm test` (from `notify-server/`).

## Operational readiness (Phase 2)

The service now boots into a classified readiness model (see `notify-server/README.md`):

- A **transient RPC outage at boot no longer crash-loops** — the server starts `DEGRADED` (API +
  `/health` up, poller/executor OFF) and recovers to `READY` automatically when the RPC returns, with
  no restart. A **positive genesis MISMATCH** at boot is still fatal (`exit 1` → systemd retries).
- Monitor `/health` for `status: READY | DEGRADED | NOT_READY`. Treat `NOT_READY` (503) and a
  `network.state == "MISMATCH"` or `[net] CRITICAL …` log line as **page-worthy**; `DEGRADED` with an
  UNKNOWN network / low cranker balance is a warning. An **executor problem never sets `NOT_READY` by
  itself** and never stops escalation.
- New env (see `.env.example`): `MIN_CRANKER_BALANCE_SOL`, `WARN_CRANKER_BALANCE_SOL`, `ALLOW_NO_FCM`,
  `REQUIRE_PROGRAM_EXECUTABLE`, `EXPECTED_CRANKER_PUBKEY`, `POLL_MAX_FAILURE_RATIO`, `POLL_MAX_FAILURE_ABS`,
  and **`ALLOW_NO_EXECUTOR`**. Defaults are safe for the existing devnet deploy (the mainnet balance
  floor does not apply on devnet). **`ALLOW_NO_EXECUTOR=1` is REQUIRED for a deliberate mainnet
  notify-only deploy** (executor delegated to a separate keeper-bot) — a mainnet server with
  `EXECUTOR_ENABLED=0` refuses to boot without it. `POLL_MAX_FAILURE_RATIO`/`POLL_MAX_FAILURE_ABS` tune
  the poll-cycle health thresholds (raise the abs cap for a large fleet).
