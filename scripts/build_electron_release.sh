#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT="$ROOT/electron"
BUNDLED_RUNTIME="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies"
RELEASE_TRACK="${AGENTSDOCK_RELEASE_TRACK:-stable}"

case "$RELEASE_TRACK" in
  stable) METADATA_NAME="latest-mac.yml" ;;
  beta) METADATA_NAME="beta-mac.yml" ;;
  *) echo "AGENTSDOCK_RELEASE_TRACK must be stable or beta." >&2; exit 2 ;;
esac

if [[ -d "$BUNDLED_RUNTIME/node/bin" ]]; then
  export PATH="$BUNDLED_RUNTIME/bin:$BUNDLED_RUNTIME/bin/fallback:$BUNDLED_RUNTIME/node/bin:/usr/bin:/bin:$PATH"
fi

DEVELOPER_ID_IDENTITY="${AGENTSDOCK_DEVELOPER_ID_IDENTITY:-$(/usr/bin/security find-identity -v -p codesigning | /usr/bin/awk -F '"' '!found && /Developer ID Application/ { value=$2; found=1 } END { print value }')}"
if [[ -z "$DEVELOPER_ID_IDENTITY" ]]; then
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
node "$ROOT/scripts/verify_electron_compile_output.mjs" "$PROJECT"
rm -rf dist-release
node_modules/.bin/electron-builder --mac zip dmg --universal --publish never --config.mac.notarize=true --config.directories.output=dist-release

# Electron Builder notarizes the app before creating the disk image. Sign and
# notarize the outer DMG separately so Gatekeeper can validate the installer
# itself before it is mounted. Its pre-signing blockmap is no longer valid and
# is intentionally omitted; macOS auto-update metadata points at the zip.
setopt local_options null_glob
DMG_ARTIFACTS=("$PROJECT"/dist-release/*.dmg)
(( ${#DMG_ARTIFACTS[@]} > 0 )) || { echo "Electron Builder did not produce a DMG." >&2; exit 2; }
for DMG in "${DMG_ARTIFACTS[@]}"; do
  /usr/bin/codesign --force --timestamp --sign "$DEVELOPER_ID_IDENTITY" "$DMG"
  /usr/bin/xcrun notarytool submit "$DMG" \
    --key "$APPLE_API_KEY" \
    --key-id "$APPLE_API_KEY_ID" \
    --issuer "$APPLE_API_ISSUER" \
    --wait
  /usr/bin/xcrun stapler staple "$DMG"
  /bin/rm -f "$DMG.blockmap"
done

# Signing the outer DMG changes its bytes after Electron Builder has generated
# update metadata. macOS updates consume the zip, so omit the now-stale DMG
# entry instead of publishing incorrect size/hash data.
METADATA="$PROJECT/dist-release/$METADATA_NAME"
[[ -f "$METADATA" ]] || { echo "Electron Builder did not produce $METADATA_NAME." >&2; exit 2; }
/usr/bin/awk '
  /^  - url: .*\.dmg$/ { skipping_dmg = 1; next }
  skipping_dmg && (/^  - url:/ || /^path:/) { skipping_dmg = 0 }
  !skipping_dmg { print }
' "$METADATA" > "$METADATA.tmp"
/bin/mv "$METADATA.tmp" "$METADATA"

"$ROOT/scripts/verify_electron_release.sh" "$PROJECT/dist-release" "$(node -p "require('./package.json').version")" "$RELEASE_TRACK"

echo "Built and verified direct release artifacts in $PROJECT/dist-release"
echo "Publishing is intentionally separate; create a reviewed GitHub draft with the release workflow."
