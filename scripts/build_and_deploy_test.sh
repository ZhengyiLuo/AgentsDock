#!/usr/bin/env bash
# Build the Mac app via direct swiftc (sandbox-safe) and deploy to an ISOLATED
# bundle on the Air so experiments never touch the working app.
#   ZenithDock.app       <- stable, what the user runs
#   AgentsDock.app  <- candidate under test
set -euo pipefail
ROOT="/Users/zen/agi/ZenithDock"
cd "$ROOT"

TMPDIR_BASE="/tmp/claude/zd_test_build"
rm -rf "$TMPDIR_BASE"; mkdir -p "$TMPDIR_BASE/cmc"
export TMPDIR="$TMPDIR_BASE"
export CLANG_MODULE_CACHE_PATH="$TMPDIR_BASE/cmc"
SDK=$(xcrun --show-sdk-path 2>/dev/null); export SDKROOT="$SDK"
FLAGS=(-sdk "$SDK" -module-cache-path "$TMPDIR_BASE/cmc" -swift-version 6 -target arm64-apple-macosx14.0 -O -wmo)

swiftc "${FLAGS[@]}" -emit-module -emit-object -parse-as-library -module-name ZenithCore \
  -emit-module-path "$TMPDIR_BASE/ZenithCore.swiftmodule" -o "$TMPDIR_BASE/ZenithCore.o" \
  Sources/ZenithCore/*.swift 2>&1 | grep -vE "xcrun_db|swiftpm|DVTFilePath|user-level cache" || true
swiftc "${FLAGS[@]}" -module-name ZenithDock -I "$TMPDIR_BASE" -framework AVKit \
  -o "$TMPDIR_BASE/ZenithDock" "$TMPDIR_BASE/ZenithCore.o" \
  $(find Sources/ZenithDock -name '*.swift') 2>&1 | grep -vE "xcrun_db|swiftpm|DVTFilePath|user-level cache" || true

if [ ! -f "$TMPDIR_BASE/ZenithDock" ]; then echo "BUILD FAILED"; exit 1; fi

# Stage into a copy of the stable bundle layout, then ship to the test path.
STAGE="$TMPDIR_BASE/AgentsDock.app"
rm -rf "$STAGE"
cp -R "$ROOT/dist/AgentsDock.app" "$STAGE"
cp "$TMPDIR_BASE/ZenithDock" "$STAGE/Contents/MacOS/ZenithDock"
codesign --remove-signature "$STAGE" 2>/dev/null || true
codesign --force --deep --sign - "$STAGE" >/dev/null 2>&1
HASH=$(shasum -a 256 "$STAGE/Contents/MacOS/ZenithDock" | awk '{print $1}')
echo "BUILD OK hash=$HASH"

rsync -a --delete "$STAGE/" air:/Users/zen/agi/AgentsDock.app/ 2>&1 | tail -1
echo "DEPLOYED to air:/Users/zen/agi/AgentsDock.app  hash=$HASH"
