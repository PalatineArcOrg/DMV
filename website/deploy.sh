#!/usr/bin/env bash
# Deploy the DMV marketing site: repo `website/` -> the live Caddy root `/var/www/dmv`.
#
# The repo is the source of truth. This regenerates changelog.html straight from
# CHANGELOG.md, then syncs the static assets. Run manually, or let the post-commit
# hook run it automatically (see website/README.md). Idempotent + safe to re-run.
set -euo pipefail

WEB="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # the repo website/ dir
LIVE="${DMV_SITE_ROOT:-/var/www/dmv}"

# node lives under nvm and isn't on a bare hook's PATH — add every installed version.
if ! command -v node >/dev/null 2>&1; then
  export PATH="$(echo "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | tr ' ' ':'):$PATH"
fi
command -v node >/dev/null 2>&1 || { echo "[deploy] node not found on PATH — aborting" >&2; exit 1; }
[ -d "$LIVE" ] || { echo "[deploy] live root $LIVE missing — aborting" >&2; exit 1; }

# 1. regenerate the changelog page from CHANGELOG.md, written straight to live
node "$WEB/gen-changelog.mjs" "$LIVE/changelog.html"

# 2. sync the tracked static assets
install -m 644 "$WEB/index.html" "$LIVE/index.html"
install -m 644 "$WEB/icon.png"   "$LIVE/icon.png"
chmod 644 "$LIVE/changelog.html"

echo "[deploy] website/ -> $LIVE  (index.html, icon.png, changelog.html regenerated)"
