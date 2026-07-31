#!/usr/bin/env bash
# Authoritative local Android release wrapper (WP1 Phase 1, §1.2).
# The ONLY documented way to produce a production DMV APK. It runs the fail-closed manifest +
# preflight checks, records provenance, then prebuilds + gradle-assembles the release APK and writes
# a release-attestation file. Exits non-zero on any failed check.
#
#   EXPO_PUBLIC_EXPECTED_CLUSTER=mainnet-beta \
#   EXPO_PUBLIC_RPC_URL=https://<mainnet-rpc> \
#   EXPO_PUBLIC_NOTIFY_URL=https://notify.palatinearc.com \
#   EXPO_PUBLIC_PROGRAM_ID=<program-id> \
#     bash dead-mans-vault/release-tools/build-android-release.sh
#
# NEVER call `gradlew assembleRelease` / `eas build` directly for a production APK — go through this.
# The Android APK's trust boundary is this controlled host + wrapper (the program .so is CI-built and
# attested separately). See docs/MAINNET-REMEDIATION-STATUS.md.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)" # dead-mans-vault/release-tools -> repo root
APP="$ROOT/dead-mans-vault/app"

fail() { echo "✗ $*" >&2; exit 1; }
log() { echo "→ $*"; }
# Any failed step aborts (set -e) and propagates non-zero. No cleanup is needed: the only mutated
# path is the gitignored android/ build output, which `expo prebuild --clean` fully regenerates on
# the next run — a partial/failed build leaves no tracked state.
trap 'echo "✗ build-android-release aborted (line $LINENO). Partial android/ output is safe to discard (prebuild --clean regenerates it)." >&2' ERR

CLUSTER="${EXPO_PUBLIC_EXPECTED_CLUSTER:-devnet}"

# 1. Working-tree cleanliness. Production prohibits the override.
DIRTY="$(cd "$ROOT" && git status --porcelain)"
if [ -n "$DIRTY" ]; then
  if [ "${DMV_ALLOW_DIRTY:-0}" = "1" ] && [ "$CLUSTER" != "mainnet-beta" ]; then
    echo "⚠ working tree is DIRTY — proceeding under DMV_ALLOW_DIRTY=1 (non-production only). Logged." >&2
  else
    fail "working tree is dirty. Commit/stash first. Production (mainnet-beta) may NOT override; non-prod may set DMV_ALLOW_DIRTY=1."
  fi
fi

# 2. Fail-closed pre-build checks.
log "verify-manifest"
node "$SCRIPT_DIR/verify-manifest.mjs" || fail "manifest verification failed"
log "preflight (app surface, cluster=$CLUSTER)"
node "$SCRIPT_DIR/preflight-prod-build.mjs" --surface app || fail "app preflight failed"

# 3. Provenance (collected before the build).
COMMIT="$(cd "$ROOT" && git rev-parse HEAD)"
CLEAN=$([ -z "$DIRTY" ] && echo true || echo false)
MANIFEST_SHA="$(sha256sum "$ROOT/dead-mans-vault/release.manifest.json" | awk '{print $1}')"
IDL_SHA="$(node -e "process.stdout.write(String(require('$ROOT/dead-mans-vault/release.manifest.json').idlSha256||''))")"
NODE_V="$(node --version 2>/dev/null || echo unknown)"
JAVA_V="$(java -version 2>&1 | head -1 | tr -d '"' || echo unknown)"
EXPO_V="$(cd "$APP" && npx --no-install expo --version 2>/dev/null || echo unknown)"
HOST="$(hostname 2>/dev/null || echo unknown)"
WRAPPER_SHA="$(sha256sum "${BASH_SOURCE[0]}" | awk '{print $1}')"

# 4. Build.
log "expo prebuild (android, clean)"
(cd "$APP" && npx expo prebuild --platform android --clean)
# `prebuild --clean` regenerates android/ from the Expo template, overwriting gradle.properties with
# multi-arch defaults + a small heap. Re-apply the documented release props: arm64-v8a only (the
# release target for all current Android phones) + a larger heap so assembleRelease doesn't OOM here.
GP="$APP/android/gradle.properties"
set_gradle_prop() { # key value
  [ -f "$GP" ] || return 0
  sed -i "/^$1=/d" "$GP"
  printf '%s=%s\n' "$1" "$2" >>"$GP"
}
set_gradle_prop reactNativeArchitectures 'arm64-v8a'
set_gradle_prop org.gradle.jvmargs '-Xmx3072m -XX:MaxMetaspaceSize=768m'
GRADLE_V="$(cd "$APP/android" && ./gradlew --version 2>/dev/null | awk '/^Gradle/{print $2; exit}' || echo unknown)"
log "gradle assembleRelease"
(cd "$APP/android" && ./gradlew assembleRelease --no-daemon)

APK="$(ls -1 "$APP"/android/app/build/outputs/apk/release/*.apk 2>/dev/null | head -1 || true)"
[ -n "$APK" ] && [ -f "$APK" ] || fail "release APK not found after gradle build"
APK_SHA="$(sha256sum "$APK" | awk '{print $1}')"

# 5. Attestation (build-artifact dir — gitignored).
ATT="$(dirname "$APK")/release-attestation.json"
cat >"$ATT" <<JSON
{
  "artifact": "android-apk",
  "commit": "$COMMIT",
  "workingTreeClean": $CLEAN,
  "expectedCluster": "$CLUSTER",
  "releaseManifestSha256": "$MANIFEST_SHA",
  "idlSha256": "$IDL_SHA",
  "apk": "$(basename "$APK")",
  "apkSha256": "$APK_SHA",
  "nodeVersion": "$NODE_V",
  "javaVersion": "$JAVA_V",
  "gradleVersion": "$GRADLE_V",
  "expoVersion": "$EXPO_V",
  "buildHost": "$HOST",
  "wrapperSha256": "$WRAPPER_SHA",
  "builtAtUtc": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
JSON

log "APK:         $APK"
log "APK sha256:  $APK_SHA"
log "attestation: $ATT"
echo "✓ android release build complete."
