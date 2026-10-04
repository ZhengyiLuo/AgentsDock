#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT="$ROOT/electron"
DESTINATION="${AGENTSDOCK_LOCAL_APP_DESTINATION:-$ROOT/dist/local/AgentsDock.app}"
DESTINATION_DIR="$(dirname "$DESTINATION")"
LOCAL_CACHE_ROOT="${AGENTSDOCK_LOCAL_CACHE_ROOT:-$DESTINATION_DIR/cache}"
export TMPDIR="${AGENTSDOCK_LOCAL_TMPDIR:-$LOCAL_CACHE_ROOT/tmp}"
export ELECTRON_CACHE="${ELECTRON_CACHE:-$LOCAL_CACHE_ROOT/electron}"
export ELECTRON_BUILDER_CACHE="${ELECTRON_BUILDER_CACHE:-$LOCAL_CACHE_ROOT/electron-builder}"
PREVIOUS_DESTINATION="$DESTINATION_DIR/.AgentsDock.previous.app"
BUILD_LOCK="$DESTINATION_DIR/.AgentsDock.local-build.lock"
BUNDLED_RUNTIME="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies"
PACKAGE_DIR=""
STAGE_DIR=""
COORDINATED_STAGE=""
COORDINATED_CONFIG_ARGS=()
ENTITLEMENTS_PLIST=""
LOCK_HELD=0

source "$ROOT/scripts/lib/electron_local_codesign.zsh"

if [[ "$DESTINATION" != /*/AgentsDock.app ]]; then
  echo "AGENTSDOCK_LOCAL_APP_DESTINATION must be an absolute path ending in /AgentsDock.app." >&2
  exit 2
fi

CODESIGN_IDENTITIES="$(/usr/bin/security find-identity -v -p codesigning 2>/dev/null || true)"
SIGNING_MODE=developer-id
SIGNING_STATUS=0
SIGN_IDENTITY="$(agentsdock_resolve_local_codesign_identity "$CODESIGN_IDENTITIES")" || SIGNING_STATUS=$?
if [[ "$SIGNING_STATUS" != 0 ]]; then
  if [[ "$SIGNING_STATUS" != 1 ]]; then
    exit "$SIGNING_STATUS"
  fi
  agentsdock_require_adhoc_isolation "$DESTINATION"
  SIGNING_MODE=adhoc-isolated
  SIGN_IDENTITY=-
fi

cleanup_build_paths() {
  if [[ ! -e "$DESTINATION" && ! -L "$DESTINATION" && ( -e "$PREVIOUS_DESTINATION" || -L "$PREVIOUS_DESTINATION" ) ]]; then
    mv "$PREVIOUS_DESTINATION" "$DESTINATION"
  fi
  if [[ -n "$PACKAGE_DIR" && -d "$PACKAGE_DIR" ]]; then
    rm -rf "$PACKAGE_DIR"
  fi
  if [[ -n "$STAGE_DIR" && -d "$STAGE_DIR" ]]; then
    rm -rf "$STAGE_DIR"
  fi
  if [[ -n "$COORDINATED_STAGE" && -d "$COORDINATED_STAGE" ]]; then
    rm -rf "$COORDINATED_STAGE"
  fi
  if [[ -n "$ENTITLEMENTS_PLIST" && -f "$ENTITLEMENTS_PLIST" ]]; then
    /bin/rm -f "$ENTITLEMENTS_PLIST"
  fi
  if [[ "$LOCK_HELD" == 1 && -d "$BUILD_LOCK" ]]; then
    rm -rf "$BUILD_LOCK"
  fi
}
trap cleanup_build_paths EXIT

acquire_build_lock() {
  if mkdir "$BUILD_LOCK" 2>/dev/null; then
    print -r -- "$$" > "$BUILD_LOCK/pid"
    LOCK_HELD=1
    return
  fi

  local lock_pid=""
  if [[ -f "$BUILD_LOCK/pid" ]]; then
    lock_pid="$(<"$BUILD_LOCK/pid")"
  fi
  if [[ "$lock_pid" == <-> ]] && kill -0 "$lock_pid" 2>/dev/null; then
    echo "Another AgentsDock local build is already running (pid $lock_pid)." >&2
    exit 3
  fi

  local stale_lock="$DESTINATION_DIR/.AgentsDock.local-build.stale.$$"
  if ! mv "$BUILD_LOCK" "$stale_lock" 2>/dev/null; then
    echo "Another AgentsDock local build acquired the build lock." >&2
    exit 3
  fi
  rm -rf "$stale_lock"
  if ! mkdir "$BUILD_LOCK" 2>/dev/null; then
    echo "Could not acquire the AgentsDock local build lock." >&2
    exit 3
  fi
  print -r -- "$$" > "$BUILD_LOCK/pid"
  LOCK_HELD=1
}

mkdir -p "$DESTINATION_DIR" "$TMPDIR" "$ELECTRON_CACHE" "$ELECTRON_BUILDER_CACHE"
acquire_build_lock

if [[ ! -e "$DESTINATION" && ! -L "$DESTINATION" && ( -e "$PREVIOUS_DESTINATION" || -L "$PREVIOUS_DESTINATION" ) ]]; then
  mv "$PREVIOUS_DESTINATION" "$DESTINATION"
fi
if [[ ( -e "$DESTINATION" || -L "$DESTINATION" ) && ( -e "$PREVIOUS_DESTINATION" || -L "$PREVIOUS_DESTINATION" ) ]]; then
  rm -rf "$PREVIOUS_DESTINATION"
fi

if [[ -d "$BUNDLED_RUNTIME/node/bin" ]]; then
  export PATH="$BUNDLED_RUNTIME/bin:$BUNDLED_RUNTIME/bin/fallback:$BUNDLED_RUNTIME/node/bin:/usr/bin:/bin:$PATH"
fi

cd "$PROJECT"

if [[ -n "${AGENTSDOCK_COORDINATED_MANIFEST:-}" || -n "${AGENTSDOCK_COORDINATED_SIGNATURE:-}" ]]; then
  mkdir -p "$ROOT/dist"
  COORDINATED_STAGE="$(mktemp -d "$ROOT/dist/.coordinated-mac.XXXXXX")"
  node "$ROOT/scripts/prepare_electron_coordinated_config.mjs" "$PROJECT" "$COORDINATED_STAGE"
  COORDINATED_CONFIG_ARGS=(--config "$COORDINATED_STAGE/electron-builder.json")
fi

"$ROOT/scripts/build_electron_icon.sh"

if [[ ! -d node_modules ]]; then
  pnpm install --frozen-lockfile
fi

node node_modules/typescript/bin/tsc --noEmit
node_modules/.bin/vitest run
node_modules/.bin/electron-vite build
node "$ROOT/scripts/verify_electron_compile_output.mjs" "$PROJECT"
PACKAGE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/agentsdock-electron-local.XXXXXX")"
STAGE_DIR="$(mktemp -d "$DESTINATION_DIR/.AgentsDock-stage.XXXXXX")"
STAGED_DESTINATION="$STAGE_DIR/AgentsDock.app"
node_modules/.bin/electron-builder --mac dir --publish never "${COORDINATED_CONFIG_ARGS[@]}" --config.mac.identity=null --config.directories.output="$PACKAGE_DIR"

/usr/bin/ditto "$PACKAGE_DIR/mac-arm64/AgentsDock.app" "$STAGED_DESTINATION"
/usr/bin/touch "$STAGED_DESTINATION/Contents/Resources/disable-auto-update"
if [[ "$SIGNING_MODE" == adhoc-isolated ]]; then
  /usr/bin/touch "$STAGED_DESTINATION/Contents/Resources/adhoc-isolated-user-data"
fi
"$ROOT/scripts/audit_electron_bundle.sh" "$STAGED_DESTINATION"
if [[ "$SIGNING_MODE" == developer-id ]]; then
  node "$ROOT/scripts/sign_electron_local.mjs" \
    "$STAGED_DESTINATION" \
    "$SIGN_IDENTITY" \
    "$PROJECT/packaging/entitlements.mac.plist" \
    "$PROJECT/packaging/entitlements.mac.inherit.plist" \
    developer-id
else
  node "$ROOT/scripts/sign_electron_local.mjs" \
    "$STAGED_DESTINATION" \
    - \
    "$PROJECT/packaging/entitlements.mac.plist" \
    "$PROJECT/packaging/entitlements.mac.inherit.plist" \
    adhoc
fi
/usr/bin/codesign --verify --deep --strict "$STAGED_DESTINATION"

if [[ "$SIGNING_MODE" == developer-id ]]; then
  SIGNED_TEAM_ID="$(/usr/bin/codesign -d --verbose=4 "$STAGED_DESTINATION" 2>&1 | /usr/bin/awk -F= '/^TeamIdentifier=/{ value=$2 } END { print value }')"
  [[ "$SIGNED_TEAM_ID" == KRR35MWWHD ]] || {
    echo "Local Electron app has unexpected Developer ID team $SIGNED_TEAM_ID." >&2
    exit 2
  }
else
  SIGNATURE_KIND="$(/usr/bin/codesign -d --verbose=4 "$STAGED_DESTINATION" 2>&1 | /usr/bin/awk -F= '/^Signature=/{ value=$2 } END { print value }')"
  [[ "$SIGNATURE_KIND" == adhoc ]] || {
    echo "Isolated local Electron app was not ad-hoc signed as expected." >&2
    exit 2
  }
  [[ -f "$STAGED_DESTINATION/Contents/Resources/adhoc-isolated-user-data" ]] || {
    echo "Ad-hoc local Electron app is missing its user-data isolation marker." >&2
    exit 2
  }
fi

ENTITLEMENTS_PLIST="$(mktemp "${TMPDIR:-/tmp}/agentsdock-electron-entitlements.XXXXXX")"
/usr/bin/codesign -d --entitlements - --xml "$STAGED_DESTINATION" > "$ENTITLEMENTS_PLIST" 2>/dev/null
for ENTITLEMENT in \
  com.apple.security.cs.allow-jit \
  com.apple.security.cs.allow-unsigned-executable-memory \
  com.apple.security.cs.disable-library-validation; do
  [[ "$(/usr/libexec/PlistBuddy -c "Print :$ENTITLEMENT" "$ENTITLEMENTS_PLIST" 2>/dev/null)" == true ]] || {
    /bin/rm -f "$ENTITLEMENTS_PLIST"
    echo "Local Electron app is missing required entitlement $ENTITLEMENT." >&2
    exit 2
  }
done
/bin/rm -f "$ENTITLEMENTS_PLIST"
ENTITLEMENTS_PLIST=""

if [[ -e "$DESTINATION" || -L "$DESTINATION" ]]; then
  mv "$DESTINATION" "$PREVIOUS_DESTINATION"
fi
if ! mv "$STAGED_DESTINATION" "$DESTINATION"; then
  exit 1
fi
rm -rf "$PREVIOUS_DESTINATION"

echo "Built $DESTINATION"
