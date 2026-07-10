#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT="$ROOT/electron"
DESTINATION="$ROOT/dist/AgentsDock.app"
STAGED_DESTINATION="$ROOT/dist/.AgentsDock.next.app"
LEGACY_DESTINATION="$ROOT/dist/AgentsDock-Electron.app"
BUNDLED_RUNTIME="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies"

if [[ -d "$BUNDLED_RUNTIME/node/bin" ]]; then
  export PATH="$BUNDLED_RUNTIME/bin:$BUNDLED_RUNTIME/bin/fallback:$BUNDLED_RUNTIME/node/bin:/usr/bin:/bin:$PATH"
fi

cd "$PROJECT"

"$ROOT/scripts/build_electron_icon.sh"

if [[ ! -d node_modules ]]; then
  pnpm install --frozen-lockfile
fi

node node_modules/typescript/bin/tsc --noEmit
node_modules/.bin/vitest run
node_modules/.bin/electron-vite build
node_modules/.bin/electron-builder --mac dir --config.mac.identity=null --config.directories.output=dist-verify

mkdir -p "$ROOT/dist"
rm -rf "$STAGED_DESTINATION"
/usr/bin/ditto "$PROJECT/dist-verify/mac-arm64/AgentsDock.app" "$STAGED_DESTINATION"
/usr/bin/touch "$STAGED_DESTINATION/Contents/Resources/disable-auto-update"
/usr/bin/codesign --force --deep --sign - "$STAGED_DESTINATION"
/usr/bin/codesign --verify --deep --strict "$STAGED_DESTINATION"

rm -rf "$DESTINATION"
mv "$STAGED_DESTINATION" "$DESTINATION"
rm -rf "$LEGACY_DESTINATION"

echo "Built $DESTINATION"
