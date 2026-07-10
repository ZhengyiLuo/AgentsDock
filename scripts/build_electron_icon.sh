#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE="$ROOT/Sources/ZenithDockIOS/Resources/Assets.xcassets/AppIcon.appiconset"
OUTPUT="$ROOT/electron/build/AgentsDock.icns"
ICONSET="$(mktemp -d "${TMPDIR:-/tmp}/agentsdock-icon.XXXXXX")/AgentsDock.iconset"

cleanup() {
  rm -rf "${ICONSET:h}"
}
trap cleanup EXIT

mkdir -p "$ICONSET" "${OUTPUT:h}"

for size in 16 32 128 256 512; do
  cp "$SOURCE/AppIcon-mac-${size}.png" "$ICONSET/icon_${size}x${size}.png"
  cp "$SOURCE/AppIcon-mac-${size}@2x.png" "$ICONSET/icon_${size}x${size}@2x.png"
done

iconutil -c icns "$ICONSET" -o "$OUTPUT"
echo "Built $OUTPUT"
