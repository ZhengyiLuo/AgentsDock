#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT="$ROOT/electron"
BUNDLED_RUNTIME="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies"
PUBLISH_MODE="${AGENTSDOCK_PUBLISH_MODE:-never}"

if [[ -d "$BUNDLED_RUNTIME/node/bin" ]]; then
  export PATH="$BUNDLED_RUNTIME/bin:$BUNDLED_RUNTIME/bin/fallback:$BUNDLED_RUNTIME/node/bin:/usr/bin:/bin:$PATH"
fi

if ! /usr/bin/security find-identity -v -p codesigning | /usr/bin/grep -q 'Developer ID Application'; then
  echo "A Developer ID Application certificate is required for remotely updatable macOS releases." >&2
  exit 2
fi

if [[ "$PUBLISH_MODE" != "never" && -z "${GH_TOKEN:-}" ]]; then
  echo "GH_TOKEN is required when AGENTSDOCK_PUBLISH_MODE is not 'never'." >&2
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
node_modules/.bin/electron-builder --mac zip dmg --publish "$PUBLISH_MODE" --config.directories.output=dist-release

echo "Built direct release artifacts in $PROJECT/dist-release"
