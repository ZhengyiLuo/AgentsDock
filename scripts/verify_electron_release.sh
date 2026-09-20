#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ARTIFACT_DIR_INPUT="${1:?usage: verify_electron_release.sh <artifact-dir> <expected-version> [stable|beta]}"
EXPECTED_VERSION="${2:?usage: verify_electron_release.sh <artifact-dir> <expected-version> [stable|beta]}"
EXPECTED_TRACK="${3:-stable}"
ARTIFACT_DIR="$(cd "$ARTIFACT_DIR_INPUT" && pwd)"
case "$EXPECTED_TRACK" in
  stable)
    METADATA_NAME="latest-mac.yml"
    EXPECTED_CHANNEL="latest"
    ;;
  beta)
    METADATA_NAME="beta-mac.yml"
    EXPECTED_CHANNEL="beta"
    ;;
  *) echo "Expected track must be stable or beta." >&2; exit 2 ;;
esac

ZIP_NAME="AgentsDock-${EXPECTED_VERSION}-mac-universal.zip"
ZIP_BLOCKMAP_NAME="${ZIP_NAME}.blockmap"
DMG_NAME="AgentsDock-${EXPECTED_VERSION}-mac-universal.dmg"
ZIP_PATH="$ARTIFACT_DIR/$ZIP_NAME"
ZIP_BLOCKMAP_PATH="$ARTIFACT_DIR/$ZIP_BLOCKMAP_NAME"
DMG_PATH="$ARTIFACT_DIR/$DMG_NAME"
METADATA="$ARTIFACT_DIR/$METADATA_NAME"

[[ -f "$METADATA" ]] || { echo "Missing $METADATA_NAME" >&2; exit 2; }
[[ -f "$ZIP_PATH" ]] || { echo "Missing $ZIP_NAME" >&2; exit 2; }
[[ -s "$ZIP_BLOCKMAP_PATH" ]] || { echo "Missing or empty $ZIP_BLOCKMAP_NAME" >&2; exit 2; }
[[ -f "$DMG_PATH" ]] || { echo "Missing $DMG_NAME" >&2; exit 2; }

ZIP_COUNT="$(/usr/bin/find "$ARTIFACT_DIR" -maxdepth 1 -type f -name "AgentsDock-${EXPECTED_VERSION}-mac-*.zip" | /usr/bin/wc -l | /usr/bin/tr -d ' ')"
BLOCKMAP_COUNT="$(/usr/bin/find "$ARTIFACT_DIR" -maxdepth 1 -type f -name "AgentsDock-${EXPECTED_VERSION}-mac-*.zip.blockmap" | /usr/bin/wc -l | /usr/bin/tr -d ' ')"
DMG_COUNT="$(/usr/bin/find "$ARTIFACT_DIR" -maxdepth 1 -type f -name "AgentsDock-${EXPECTED_VERSION}-mac-*.dmg" | /usr/bin/wc -l | /usr/bin/tr -d ' ')"
[[ "$ZIP_COUNT" == 1 && "$BLOCKMAP_COUNT" == 1 && "$DMG_COUNT" == 1 ]] || { echo "Expected exactly one versioned universal zip, zip blockmap, and DMG" >&2; exit 2; }
if [[ -n "$(/usr/bin/find "$ARTIFACT_DIR" -maxdepth 1 -type f -name '*.dmg.blockmap' -print -quit)" ]]; then
  echo "Found a stale pre-signing DMG blockmap; macOS updates must use the zip metadata." >&2
  exit 2
fi

JS_YAML="$(/usr/bin/find "$ROOT/electron/node_modules/.pnpm" -path '*/node_modules/js-yaml/index.js' -print -quit)"
[[ -f "$JS_YAML" ]] || { echo "Install Electron dependencies before verifying macOS artifacts." >&2; exit 2; }
node - "$ZIP_BLOCKMAP_PATH" "$ZIP_PATH" <<'NODE'
const [blockmapPath, zipPath] = process.argv.slice(2)
const fs = require('fs')
const zlib = require('zlib')

function fail(message) {
  console.error(message)
  process.exit(2)
}

let blockmap
try {
  blockmap = JSON.parse(zlib.gunzipSync(fs.readFileSync(blockmapPath)).toString('utf8'))
} catch (error) {
  fail(`Zip blockmap is not valid gzip-compressed JSON: ${error instanceof Error ? error.message : String(error)}`)
}
if (!blockmap || blockmap.version !== '2' || !Array.isArray(blockmap.files) || blockmap.files.length !== 1) {
  fail('Zip blockmap must contain exactly one version-2 file entry')
}
const entry = blockmap.files[0]
if (entry.name !== 'file' || entry.offset !== 0 || !Array.isArray(entry.sizes) || !Array.isArray(entry.checksums) || entry.sizes.length === 0 || entry.sizes.length !== entry.checksums.length) {
  fail('Zip blockmap has an invalid file/chunk layout')
}
if (entry.sizes.some((size) => !Number.isSafeInteger(size) || size <= 0) || entry.checksums.some((checksum) => typeof checksum !== 'string' || checksum.length === 0)) {
  fail('Zip blockmap contains invalid chunk sizes or checksums')
}
const mappedSize = entry.sizes.reduce((total, size) => total + size, 0)
if (mappedSize !== fs.statSync(zipPath).size) fail('Zip blockmap size does not match the update zip')
NODE
ZIP_SHA512="$(node - "$JS_YAML" "$METADATA" "$EXPECTED_VERSION" "$ZIP_NAME" <<'NODE'
const [yamlPath, metadataPath, expectedVersion, expectedPackage] = process.argv.slice(2)
const fs = require('fs')
const yaml = require(yamlPath)

function fail(message) {
  console.error(message)
  process.exit(2)
}

const metadata = yaml.load(fs.readFileSync(metadataPath, 'utf8'))
if (!metadata || metadata.version !== expectedVersion) fail(`Updater metadata version does not match ${expectedVersion}`)
if (metadata.path !== expectedPackage || typeof metadata.sha512 !== 'string') fail(`Updater metadata must point at ${expectedPackage}`)
if (!Array.isArray(metadata.files)) fail('Updater metadata is missing files[]')
const entries = metadata.files.filter((entry) => entry && entry.url === expectedPackage)
if (entries.length !== 1 || typeof entries[0].sha512 !== 'string') fail(`Updater metadata must contain exactly one files[] entry for ${expectedPackage}`)
if (entries[0].sha512 !== metadata.sha512) fail('Updater metadata top-level and files[] sha512 values disagree')
if (metadata.files.some((entry) => entry && typeof entry.url === 'string' && entry.url.endsWith('.dmg'))) fail('Updater metadata contains a stale outer-DMG entry')
process.stdout.write(entries[0].sha512)
NODE
)"
ACTUAL_SHA512="$(/usr/bin/openssl dgst -sha512 -binary "$ZIP_PATH" | /usr/bin/openssl base64 -A)"
[[ "$ACTUAL_SHA512" == "$ZIP_SHA512" ]] || { echo "$METADATA_NAME sha512 does not match $ZIP_NAME" >&2; exit 2; }

/usr/bin/codesign --verify --strict --verbose=2 "$DMG_PATH"
/usr/sbin/spctl --assess --type open --context context:primary-signature --verbose=4 "$DMG_PATH"
/usr/bin/xcrun stapler validate "$DMG_PATH"

TEMP_ROOT="${TMPDIR:-/tmp}"
[[ -d "$TEMP_ROOT" && -w "$TEMP_ROOT" ]] || {
  echo "Release verification temp directory is unavailable: $TEMP_ROOT" >&2
  exit 2
}
TEMP_DIR="$(/usr/bin/mktemp -d "${TEMP_ROOT%/}/agentsdock-release.XXXXXX")"
MOUNT_DIR="$TEMP_DIR/dmg"
DMG_ATTACHED=false
SMOKE_PID=""
cleanup() {
  if [[ -n "$SMOKE_PID" ]] && /bin/kill -0 "$SMOKE_PID" 2>/dev/null; then
    /bin/kill -TERM "$SMOKE_PID" 2>/dev/null || true
  fi
  if [[ "$DMG_ATTACHED" == true ]]; then
    /usr/bin/hdiutil detach "$MOUNT_DIR" -quiet >/dev/null 2>&1 || /usr/bin/hdiutil detach "$MOUNT_DIR" -force -quiet >/dev/null 2>&1 || true
  fi
  /bin/rm -rf "$TEMP_DIR"
}
trap cleanup EXIT

/usr/bin/ditto -x -k "$ZIP_PATH" "$TEMP_DIR/zip"
APP_PATH="$(/usr/bin/find "$TEMP_DIR/zip" -maxdepth 2 -type d -name 'AgentsDock.app' -print -quit)"
[[ -n "$APP_PATH" ]] || { echo "Zip does not contain AgentsDock.app" >&2; exit 2; }

BUNDLE_VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP_PATH/Contents/Info.plist")"
BUNDLE_BUILD="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$APP_PATH/Contents/Info.plist")"
BUNDLE_ID="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP_PATH/Contents/Info.plist")"
EXECUTABLE_NAME="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$APP_PATH/Contents/Info.plist")"
[[ "$BUNDLE_VERSION" == "$EXPECTED_VERSION" ]] || { echo "Bundle version $BUNDLE_VERSION does not match $EXPECTED_VERSION" >&2; exit 2; }
if [[ -n "${AGENTSDOCK_EXPECTED_BUILD_NUMBER:-}" && "$BUNDLE_BUILD" != "$AGENTSDOCK_EXPECTED_BUILD_NUMBER" ]]; then
  echo "Bundle build $BUNDLE_BUILD does not match $AGENTSDOCK_EXPECTED_BUILD_NUMBER" >&2
  exit 2
fi
[[ "$BUNDLE_ID" == com.zhengyiluo.AgentsDock ]] || { echo "Unexpected bundle identifier $BUNDLE_ID" >&2; exit 2; }
MAIN_EXECUTABLE="$APP_PATH/Contents/MacOS/$EXECUTABLE_NAME"
ARCHS="$(/usr/bin/lipo -archs "$MAIN_EXECUTABLE")"
[[ "$ARCHS" == *arm64* && "$ARCHS" == *x86_64* ]] || { echo "macOS app is not universal: $ARCHS" >&2; exit 2; }
MACHO_COUNT=0
while IFS= read -r -d '' CANDIDATE; do
  FILE_KIND="$(/usr/bin/file -b "$CANDIDATE")"
  if [[ "$FILE_KIND" == *Mach-O* ]]; then
    CANDIDATE_ARCHS="$(/usr/bin/lipo -archs "$CANDIDATE")"
    [[ "$CANDIDATE_ARCHS" == *arm64* && "$CANDIDATE_ARCHS" == *x86_64* ]] || { echo "Packaged Mach-O is not universal: $CANDIDATE ($CANDIDATE_ARCHS)" >&2; exit 2; }
    MACHO_COUNT=$((MACHO_COUNT + 1))
  fi
done < <(/usr/bin/find "$APP_PATH/Contents" -type f -print0)
[[ "$MACHO_COUNT" -gt 0 ]] || { echo "Could not find packaged Mach-O binaries" >&2; exit 2; }

UPDATE_CONFIG="$APP_PATH/Contents/Resources/app-update.yml"
[[ -f "$UPDATE_CONFIG" ]] || { echo "Packaged app is missing app-update.yml" >&2; exit 2; }
[[ ! -e "$APP_PATH/Contents/Resources/disable-auto-update" ]] || { echo "Release app disables automatic updates" >&2; exit 2; }
node - "$JS_YAML" "$UPDATE_CONFIG" "$EXPECTED_CHANNEL" <<'NODE'
const [yamlPath, configPath, expectedChannel] = process.argv.slice(2)
const fs = require('fs')
const yaml = require(yamlPath)
const config = yaml.load(fs.readFileSync(configPath, 'utf8'))
if (!config || config.provider !== 'github' || config.owner !== 'ZhengyiLuo' || config.repo !== 'AgentsDock' || config.channel !== expectedChannel) {
  console.error('Packaged updater configuration does not match the public AgentsDock release feed')
  process.exit(2)
}
NODE

"$ROOT/scripts/audit_electron_bundle.sh" "$APP_PATH"
/usr/bin/codesign --verify --deep --strict --verbose=2 "$APP_PATH"
/usr/sbin/spctl --assess --type execute --verbose=4 "$APP_PATH"
/usr/bin/xcrun stapler validate "$APP_PATH"
TEAM_ID="$(/usr/bin/codesign -d --verbose=4 "$APP_PATH" 2>&1 | /usr/bin/awk -F= '/^TeamIdentifier=/{ value=$2 } END { print value }')"
ZIP_CDHASH="$(/usr/bin/codesign -d --verbose=4 "$APP_PATH" 2>&1 | /usr/bin/awk -F= '/^CDHash=/{ value=$2 } END { print value }')"
[[ "$TEAM_ID" == KRR35MWWHD ]] || { echo "Unexpected Developer ID team $TEAM_ID" >&2; exit 2; }
[[ -n "$ZIP_CDHASH" ]] || { echo "Could not read zip app signature identity" >&2; exit 2; }

/bin/mkdir -p "$MOUNT_DIR"
/usr/bin/hdiutil attach -readonly -nobrowse -mountpoint "$MOUNT_DIR" "$DMG_PATH" >/dev/null
DMG_ATTACHED=true
DMG_APP_PATH="$(/usr/bin/find "$MOUNT_DIR" -maxdepth 2 -type d -name 'AgentsDock.app' -print -quit)"
[[ -n "$DMG_APP_PATH" ]] || { echo "DMG does not contain AgentsDock.app" >&2; exit 2; }
DMG_BUNDLE_VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$DMG_APP_PATH/Contents/Info.plist")"
DMG_BUNDLE_ID="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$DMG_APP_PATH/Contents/Info.plist")"
"$ROOT/scripts/audit_electron_bundle.sh" "$DMG_APP_PATH"
DMG_CDHASH="$(/usr/bin/codesign -d --verbose=4 "$DMG_APP_PATH" 2>&1 | /usr/bin/awk -F= '/^CDHash=/{ value=$2 } END { print value }')"
[[ "$DMG_BUNDLE_VERSION" == "$EXPECTED_VERSION" && "$DMG_BUNDLE_ID" == "$BUNDLE_ID" ]] || { echo "DMG app identity does not match the zip app" >&2; exit 2; }
[[ "$DMG_CDHASH" == "$ZIP_CDHASH" ]] || { echo "DMG and zip contain different signed app payloads" >&2; exit 2; }
/usr/bin/codesign --verify --deep --strict --verbose=2 "$DMG_APP_PATH"
/usr/sbin/spctl --assess --type execute --verbose=4 "$DMG_APP_PATH"
/usr/bin/xcrun stapler validate "$DMG_APP_PATH"

SMOKE_DATA="$TEMP_DIR/user-data"
/bin/mkdir -p "$SMOKE_DATA"
AGENTSDOCK_DISABLE_ANALYTICS=1 AGENTSDOCK_USER_DATA="$SMOKE_DATA" "$MAIN_EXECUTABLE" >"$TEMP_DIR/smoke.log" 2>&1 &
SMOKE_PID=$!
for _ in {1..10}; do
  if ! /bin/kill -0 "$SMOKE_PID" 2>/dev/null; then
    /usr/bin/tail -80 "$TEMP_DIR/smoke.log" >&2 || true
    echo "Signed macOS app exited during the clean-runner smoke window" >&2
    exit 2
  fi
  /bin/sleep 1
done
/bin/kill -TERM "$SMOKE_PID" 2>/dev/null || true
wait "$SMOKE_PID" 2>/dev/null || true
SMOKE_PID=""

echo "Verified AgentsDock $EXPECTED_VERSION ($EXPECTED_TRACK): exact metadata/assets, blockmap/SHA-512, universal Developer ID app parity, Gatekeeper, notarization, updater feed, DMG signature, and clean-runner launch."
