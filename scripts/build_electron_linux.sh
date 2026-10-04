#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT="$ROOT/electron"
BUNDLED_RUNTIME="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies"
OUTPUT="$ROOT/dist/linux"
ARCH="${AGENTSDOCK_LINUX_ARCH:-x64}"
ICON_SOURCE="$ROOT/Sources/ZenithDockIOS/Resources/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png"
ICON_OUTPUT="$PROJECT/build/AgentsDock.png"
COORDINATED_STAGE=""
COORDINATED_CONFIG_ARGS=()
cleanup_coordinated_stage() {
  if [[ -n "$COORDINATED_STAGE" && -d "$COORDINATED_STAGE" ]]; then
    rm -rf "$COORDINATED_STAGE"
  fi
}
trap cleanup_coordinated_stage EXIT

case "$ARCH" in
  x64)
    ARCH_FLAG="--x64"
    ;;
  arm64)
    ARCH_FLAG="--arm64"
    ;;
  *)
    echo "Unsupported Linux architecture: $ARCH (expected x64 or arm64)" >&2
    exit 2
    ;;
esac

if [[ -d "$BUNDLED_RUNTIME/node/bin" ]]; then
  export PATH="$BUNDLED_RUNTIME/bin:$BUNDLED_RUNTIME/bin/fallback:$BUNDLED_RUNTIME/node/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
fi

mkdir -p "$(dirname "$ICON_OUTPUT")" "$OUTPUT"
cp "$ICON_SOURCE" "$ICON_OUTPUT"

cd "$PROJECT"
if [[ -n "${AGENTSDOCK_COORDINATED_MANIFEST:-}" || -n "${AGENTSDOCK_COORDINATED_SIGNATURE:-}" ]]; then
  COORDINATED_STAGE="$(mktemp -d "$ROOT/dist/.coordinated-linux.XXXXXX")"
  node "$ROOT/scripts/prepare_electron_coordinated_config.mjs" "$PROJECT" "$COORDINATED_STAGE"
  COORDINATED_CONFIG_ARGS=(--config "$COORDINATED_STAGE/electron-builder.json")
fi
if [[ ! -d node_modules ]]; then
  pnpm install --frozen-lockfile
fi

node node_modules/typescript/bin/tsc --noEmit
node_modules/.bin/vitest run
node_modules/.bin/electron-vite build
node "$ROOT/scripts/verify_electron_compile_output.mjs" "$PROJECT"

rm -rf "$OUTPUT"
mkdir -p "$OUTPUT"
node_modules/.bin/electron-builder \
  --linux AppImage tar.gz \
  "$ARCH_FLAG" \
  --publish never \
  "${COORDINATED_CONFIG_ARGS[@]}" \
  --config.directories.output="$OUTPUT"

APPIMAGE="$(find "$OUTPUT" -maxdepth 1 -type f -name '*.AppImage' -print -quit)"
TARBALL="$(find "$OUTPUT" -maxdepth 1 -type f -name '*.tar.gz' -print -quit)"
test -n "$APPIMAGE"
test -n "$TARBALL"
chmod +x "$APPIMAGE"

echo "Built $APPIMAGE"
echo "Built $TARBALL"
