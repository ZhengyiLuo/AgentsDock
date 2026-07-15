#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT="$ROOT/electron"
BUNDLED_RUNTIME="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies"

if [[ -d "$BUNDLED_RUNTIME/node/bin" ]]; then
  export PATH="$BUNDLED_RUNTIME/bin:$BUNDLED_RUNTIME/bin/fallback:$BUNDLED_RUNTIME/node/bin:/usr/bin:/bin:$PATH"
fi

if ! /usr/bin/security find-identity -v -p codesigning | /usr/bin/grep -q 'Developer ID Application'; then
  echo "A Developer ID Application certificate is required for remotely updatable macOS releases." >&2
  exit 2
fi

if [[ -z "${APPLE_API_KEY:-}" || ! -f "${APPLE_API_KEY:-}" || -z "${APPLE_API_KEY_ID:-}" || -z "${APPLE_API_ISSUER:-}" ]]; then
  echo "APPLE_API_KEY, APPLE_API_KEY_ID, and APPLE_API_ISSUER are required for notarization." >&2
  exit 2
fi

cd "$PROJECT"
"$ROOT/scripts/build_electron_icon.sh"

if [[ ! -d node_modules ]]; then
  pnpm install --frozen-lockfile
fi

node node_modules/typescript/bin/tsc --noEmit
node_modules/.bin/vitest run
node_modules/.bin/electron-vite build
rm -rf dist-release
node_modules/.bin/electron-builder --mac zip dmg --universal --publish never --config.mac.notarize=true --config.directories.output=dist-release
"$ROOT/scripts/verify_electron_release.sh" "$PROJECT/dist-release" "$(node -p "require('./package.json').version")"

echo "Built and verified direct release artifacts in $PROJECT/dist-release"
echo "Publishing is intentionally separate; create a reviewed GitHub draft with the release workflow."
