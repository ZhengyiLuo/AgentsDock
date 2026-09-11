#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT="$ROOT/electron"
BUNDLED_RUNTIME="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies"
TEAM_ID="${AGENTSDOCK_TEAM_ID:-KRR35MWWHD}"
MAS_APP_ID="${AGENTSDOCK_MAS_APP_ID:-com.zhengyiluo.ZenithDock}"
UPLOAD=false

usage() {
  cat <<'EOF'
Usage: ./scripts/build_electron_mas.sh [--upload]

Builds an entitlement-correct Electron MAS app, wraps it in an Xcode archive,
and lets Xcode apply cloud-managed App Store signatures. Local exports use App
Store Connect API credentials when available and otherwise retain Xcode account
authentication. With --upload, API credentials are required and the archive is
uploaded directly to App Store Connect/TestFlight.
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

source "$ROOT/scripts/lib/app_store_connect_auth.zsh"
/bin/zsh "$ROOT/scripts/tests/build_electron_mas_auth.test.zsh"
/bin/zsh "$ROOT/scripts/tests/build_electron_mas_export_options.test.zsh"
AUTHENTICATION_ARGS=()
agentsdock_resolve_asc_authentication "$UPLOAD"

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
node "$ROOT/scripts/verify_electron_compile_output.mjs" "$PROJECT"

VERSION="$(node -p 'require("./package.json").version')"
BUILD_NUMBER="$(node -p 'require("./package.json").build.buildVersion')"
STAGE_DIR="$PROJECT/dist-mas-stage"
APP="$STAGE_DIR/mas-dev-arm64/AgentsDock.app"
ARCHIVE="$ROOT/build/archives/AgentsDockElectronMac-$BUILD_NUMBER.xcarchive"
EXPORT_PATH="$ROOT/build/TestFlightElectronMacExport-$BUILD_NUMBER"

if [[ "$UPLOAD" == true ]]; then
  EXPORT_OPTIONS="$PROJECT/packaging/export-options.mas-upload.plist"
  EXPECTED_DESTINATION="upload"
  EXPECTED_MANAGED_BUILD_NUMBER=true
else
  EXPORT_OPTIONS="$PROJECT/packaging/export-options.mas-local.plist"
  EXPECTED_DESTINATION="export"
  EXPECTED_MANAGED_BUILD_NUMBER=false
fi

if [[ ! -f "$EXPORT_OPTIONS" ]]; then
  echo "Missing Xcode export options: $EXPORT_OPTIONS" >&2
  exit 2
fi
if ! plutil -lint "$EXPORT_OPTIONS" >/dev/null; then
  echo "Invalid Xcode export options: $EXPORT_OPTIONS" >&2
  exit 2
fi
if [[ "$(/usr/libexec/PlistBuddy -c 'Print :destination' "$EXPORT_OPTIONS")" != "$EXPECTED_DESTINATION" ]]; then
  echo "Xcode export destination does not match the requested release mode." >&2
  exit 2
fi
if [[ "$(/usr/libexec/PlistBuddy -c 'Print :manageAppVersionAndBuildNumber' "$EXPORT_OPTIONS")" != "$EXPECTED_MANAGED_BUILD_NUMBER" ]]; then
  echo "Xcode build-number management does not match the requested release mode." >&2
  exit 2
fi

# Xcode owns the real App Store signatures. The ad-hoc signature here makes
# Electron Builder apply the MAS sandbox/JIT entitlements to every helper so
# Xcode can preserve them while replacing the signatures in the export step.
rm -rf "$STAGE_DIR"
env CSC_IDENTITY_AUTO_DISCOVERY=false \
  node_modules/.bin/electron-builder --mac mas-dev \
  --config.appId="$MAS_APP_ID" \
  --config.mac.identity=- \
  --config.directories.output="$STAGE_DIR"

codesign --verify --deep --strict "$APP"
AGENTSDOCK_EXPECTED_BUNDLE_ID="$MAS_APP_ID" "$ROOT/scripts/audit_electron_bundle.sh" "$APP"
ENTITLEMENTS="$(mktemp -t agentsdock-entitlements).plist"
trap 'rm -f "$ENTITLEMENTS"' EXIT
codesign -d --entitlements :- "$APP" > "$ENTITLEMENTS" 2>/dev/null
if [[ "$(/usr/libexec/PlistBuddy -c 'Print :com.apple.security.app-sandbox' "$ENTITLEMENTS")" != true ]]; then
  echo "MAS staging app is missing the App Sandbox entitlement." >&2
  exit 2
fi
if [[ "$(/usr/libexec/PlistBuddy -c 'Print :com.apple.security.application-groups:0' "$ENTITLEMENTS")" != "$TEAM_ID.$MAS_APP_ID" ]]; then
  echo "MAS staging app is missing Electron's application group entitlement." >&2
  exit 2
fi
if [[ "$(/usr/libexec/PlistBuddy -c 'Print :ElectronTeamID' "$APP/Contents/Info.plist")" != "$TEAM_ID" ]]; then
  echo "MAS staging app is missing ElectronTeamID in Info.plist." >&2
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
plutil -insert ApplicationProperties.CFBundleIdentifier -string "$MAS_APP_ID" "$ARCHIVE/Info.plist"
plutil -insert ApplicationProperties.CFBundleShortVersionString -string "$VERSION" "$ARCHIVE/Info.plist"
plutil -insert ApplicationProperties.CFBundleVersion -string "$BUILD_NUMBER" "$ARCHIVE/Info.plist"
plutil -insert ApplicationProperties.SigningIdentity -string - "$ARCHIVE/Info.plist"
plutil -insert ApplicationProperties.Team -string "$TEAM_ID" "$ARCHIVE/Info.plist"

xcodebuild -exportArchive \
  -archivePath "$ARCHIVE" \
  -exportPath "$EXPORT_PATH" \
  -exportOptionsPlist "$EXPORT_OPTIONS" \
  -allowProvisioningUpdates \
  "${AUTHENTICATION_ARGS[@]}"

if [[ "$UPLOAD" == true ]]; then
  echo "Uploaded AgentsDock $VERSION ($BUILD_NUMBER) to App Store Connect/TestFlight."
else
  PACKAGE="$EXPORT_PATH/AgentsDock.pkg"
  DISTRIBUTION_SUMMARY="$EXPORT_PATH/DistributionSummary.plist"
  if [[ ! -f "$PACKAGE" || ! -f "$DISTRIBUTION_SUMMARY" ]]; then
    echo "Local export did not produce the expected package and distribution summary." >&2
    exit 2
  fi
  EXPORTED_VERSION="$(/usr/libexec/PlistBuddy -c 'Print :AgentsDock.pkg:0:versionNumber' "$DISTRIBUTION_SUMMARY")"
  EXPORTED_BUILD_NUMBER="$(/usr/libexec/PlistBuddy -c 'Print :AgentsDock.pkg:0:buildNumber' "$DISTRIBUTION_SUMMARY")"
  EXPORTED_CERTIFICATE="$(/usr/libexec/PlistBuddy -c 'Print :AgentsDock.pkg:0:certificate:type' "$DISTRIBUTION_SUMMARY")"
  EXPORTED_TEAM_ID="$(/usr/libexec/PlistBuddy -c 'Print :AgentsDock.pkg:0:team:id' "$DISTRIBUTION_SUMMARY")"
  if [[ "$EXPORTED_VERSION" != "$VERSION" || "$EXPORTED_BUILD_NUMBER" != "$BUILD_NUMBER" ]]; then
    echo "Exported package version $EXPORTED_VERSION ($EXPORTED_BUILD_NUMBER) does not match requested version $VERSION ($BUILD_NUMBER)." >&2
    exit 2
  fi
  if (( ${#AUTHENTICATION_ARGS[@]} > 0 )) && [[ "$EXPORTED_CERTIFICATE" != "Cloud Managed Apple Distribution" ]]; then
    echo "Authenticated local export did not use Apple's cloud-managed distribution certificate." >&2
    exit 2
  fi
  if [[ "$EXPORTED_TEAM_ID" != "$TEAM_ID" ]]; then
    echo "Exported package team $EXPORTED_TEAM_ID does not match requested team $TEAM_ID." >&2
    exit 2
  fi
  if ! PACKAGE_SIGNATURE="$(/usr/sbin/pkgutil --check-signature "$PACKAGE")"; then
    echo "Exported package signature verification failed." >&2
    exit 2
  fi
  if [[ "$PACKAGE_SIGNATURE" != *"3rd Party Mac Developer Installer:"* || "$PACKAGE_SIGNATURE" != *"($TEAM_ID)"* ]]; then
    echo "Exported package does not have the expected Apple installer signature for team $TEAM_ID." >&2
    exit 2
  fi
  echo "Exported and verified AgentsDock $VERSION ($BUILD_NUMBER) at $PACKAGE"
fi
