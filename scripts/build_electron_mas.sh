#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT="$ROOT/electron"
BUNDLED_RUNTIME="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies"
PROFILE="${AGENTSDOCK_MAS_PROFILE:-$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles/7adf263f-0143-4438-99c7-b5c58f968102.provisionprofile}"

if [[ -d "$BUNDLED_RUNTIME/node/bin" ]]; then
  export PATH="$BUNDLED_RUNTIME/bin:$BUNDLED_RUNTIME/bin/fallback:$BUNDLED_RUNTIME/node/bin:/usr/bin:/bin:$PATH"
fi

if [[ ! -f "$PROFILE" ]]; then
  echo "Set AGENTSDOCK_MAS_PROFILE to the Mac App Store profile for com.zhengyiluo.ZenithDock." >&2
  exit 2
fi
if ! /usr/bin/security find-identity -v -p codesigning | /usr/bin/grep -q 'Apple Distribution'; then
  echo "An Apple Distribution certificate with its private key is required for the MAS package." >&2
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
rm -rf dist-mas
node_modules/.bin/electron-builder --mac mas \
  --config.mas.provisioningProfile="$PROFILE" \
  --config.directories.output=dist-mas

echo "Built Mac App Store package in $PROJECT/dist-mas"
