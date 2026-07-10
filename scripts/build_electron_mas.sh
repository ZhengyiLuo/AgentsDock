#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT="$ROOT/electron"
BUNDLED_RUNTIME="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies"
TEAM_ID="${AGENTSDOCK_TEAM_ID:-KRR35MWWHD}"
UPLOAD=false

usage() {
  cat <<'EOF'
Usage: ./scripts/build_electron_mas.sh [--upload]

Builds an entitlement-correct Electron MAS app, wraps it in an Xcode archive,
and lets Xcode apply cloud-managed App Store signatures. With --upload, the
archive is uploaded directly to App Store Connect/TestFlight.
EOF
}

for arg in "$@"; do
  case "$arg" in
    --upload)
      UPLOAD=true
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -d "$BUNDLED_RUNTIME/node/bin" ]]; then
  export PATH="$BUNDLED_RUNTIME/bin:$BUNDLED_RUNTIME/bin/fallback:$BUNDLED_RUNTIME/node/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
fi

cd "$PROJECT"
"$ROOT/scripts/build_electron_icon.sh"

if [[ ! -d node_modules ]]; then
  pnpm install --frozen-lockfile
fi

node node_modules/typescript/bin/tsc --noEmit
node_modules/.bin/vitest run
node_modules/.bin/electron-vite build

VERSION="$(node -p 'require("./package.json").version')"
BUILD_NUMBER="$(node -p 'require("./package.json").build.buildVersion')"
STAGE_DIR="$PROJECT/dist-mas-stage"
APP="$STAGE_DIR/mas-dev-arm64/AgentsDock.app"
ARCHIVE="$ROOT/build/archives/AgentsDockElectronMac-$BUILD_NUMBER.xcarchive"
EXPORT_PATH="$ROOT/build/TestFlightElectronMacExport-$BUILD_NUMBER"

if [[ "$UPLOAD" == true ]]; then
  EXPORT_OPTIONS="$ROOT/build/TestFlightExportOptions.plist"
else
  EXPORT_OPTIONS="$ROOT/build/TestFlightExportOptionsLocal.plist"
fi

if [[ ! -f "$EXPORT_OPTIONS" ]]; then
  echo "Missing Xcode export options: $EXPORT_OPTIONS" >&2
  exit 2
fi

# Xcode owns the real App Store signatures. The ad-hoc signature here makes
# Electron Builder apply the MAS sandbox/JIT entitlements to every helper so
# Xcode can preserve them while replacing the signatures in the export step.
rm -rf "$STAGE_DIR"
env CSC_IDENTITY_AUTO_DISCOVERY=false \
  node_modules/.bin/electron-builder --mac mas-dev \
  --config.mac.identity=- \
  --config.directories.output="$STAGE_DIR"

codesign --verify --deep --strict "$APP"
ENTITLEMENTS="$(mktemp -t agentsdock-entitlements).plist"
trap 'rm -f "$ENTITLEMENTS"' EXIT
codesign -d --entitlements :- "$APP" > "$ENTITLEMENTS" 2>/dev/null
if [[ "$(/usr/libexec/PlistBuddy -c 'Print :com.apple.security.app-sandbox' "$ENTITLEMENTS")" != true ]]; then
  echo "MAS staging app is missing the App Sandbox entitlement." >&2
  exit 2
fi

rm -rf "$ARCHIVE" "$EXPORT_PATH"
mkdir -p "$ARCHIVE/Products/Applications"
ditto "$APP" "$ARCHIVE/Products/Applications/AgentsDock.app"

plutil -create xml1 "$ARCHIVE/Info.plist"
plutil -insert ArchiveVersion -integer 2 "$ARCHIVE/Info.plist"
plutil -insert CreationDate -date "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$ARCHIVE/Info.plist"
plutil -insert Name -string AgentsDockMac "$ARCHIVE/Info.plist"
plutil -insert SchemeName -string AgentsDockMac "$ARCHIVE/Info.plist"
plutil -insert ApplicationProperties -dictionary "$ARCHIVE/Info.plist"
plutil -insert ApplicationProperties.ApplicationPath -string Applications/AgentsDock.app "$ARCHIVE/Info.plist"
plutil -insert ApplicationProperties.Architectures -array "$ARCHIVE/Info.plist"
plutil -insert ApplicationProperties.Architectures.0 -string arm64 "$ARCHIVE/Info.plist"
plutil -insert ApplicationProperties.CFBundleIdentifier -string com.zhengyiluo.ZenithDock "$ARCHIVE/Info.plist"
plutil -insert ApplicationProperties.CFBundleShortVersionString -string "$VERSION" "$ARCHIVE/Info.plist"
plutil -insert ApplicationProperties.CFBundleVersion -string "$BUILD_NUMBER" "$ARCHIVE/Info.plist"
plutil -insert ApplicationProperties.SigningIdentity -string - "$ARCHIVE/Info.plist"
plutil -insert ApplicationProperties.Team -string "$TEAM_ID" "$ARCHIVE/Info.plist"

xcodebuild -exportArchive \
  -archivePath "$ARCHIVE" \
  -exportPath "$EXPORT_PATH" \
  -exportOptionsPlist "$EXPORT_OPTIONS" \
  -allowProvisioningUpdates

if [[ "$UPLOAD" == true ]]; then
  echo "Uploaded AgentsDock $VERSION ($BUILD_NUMBER) to App Store Connect/TestFlight."
else
  test -f "$EXPORT_PATH/AgentsDock.pkg"
  echo "Exported AgentsDock $VERSION ($BUILD_NUMBER) to $EXPORT_PATH/AgentsDock.pkg"
fi
