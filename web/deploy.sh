#!/usr/bin/env bash
# Build the DMV web claim portal and mirror it to the Caddy web root.
set -euo pipefail
cd "$(dirname "$0")"
export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"
echo "[deploy] building…"
npm run build
mkdir -p /var/www/dmvapp
rsync -a --delete dist/ /var/www/dmvapp/ 2>/dev/null || { rm -rf /var/www/dmvapp/*; cp -r dist/* /var/www/dmvapp/; }
echo "[deploy] mirrored dist/ -> /var/www/dmvapp"
