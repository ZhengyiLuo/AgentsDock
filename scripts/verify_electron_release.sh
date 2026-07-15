#!/bin/zsh
set -euo pipefail

ARTIFACT_DIR="${1:?usage: verify_electron_release.sh <artifact-dir> <expected-version>}"
EXPECTED_VERSION="${2:?usage: verify_electron_release.sh <artifact-dir> <expected-version>}"
METADATA="$ARTIFACT_DIR/latest-mac.yml"

[[ -f "$METADATA" ]] || { echo "Missing latest-mac.yml" >&2; exit 2; }

METADATA_VERSION="$(/usr/bin/awk '/^version:/ { print $2; exit }' "$METADATA" | /usr/bin/tr -d '\"\047')"
ZIP_NAME="$(/usr/bin/awk '/^path:/ { sub(/^path:[[:space:]]*/, ""); print; exit }' "$METADATA" | /usr/bin/tr -d '\"\047')"
ZIP_SHA512="$(/usr/bin/awk '/^sha512:/ { sub(/^sha512:[[:space:]]*/, ""); print; exit }' "$METADATA" | /usr/bin/tr -d '\"\047')"

[[ "$METADATA_VERSION" == "$EXPECTED_VERSION" ]] || { echo "Metadata version $METADATA_VERSION does not match $EXPECTED_VERSION" >&2; exit 2; }
[[ -n "$ZIP_NAME" && -f "$ARTIFACT_DIR/$ZIP_NAME" ]] || { echo "Metadata does not reference an existing zip" >&2; exit 2; }
[[ -n "$ZIP_SHA512" ]] || { echo "Metadata is missing the zip sha512" >&2; exit 2; }

ACTUAL_SHA512="$(/usr/bin/openssl dgst -sha512 -binary "$ARTIFACT_DIR/$ZIP_NAME" | /usr/bin/openssl base64 -A)"
[[ "$ACTUAL_SHA512" == "$ZIP_SHA512" ]] || { echo "latest-mac.yml sha512 does not match $ZIP_NAME" >&2; exit 2; }

DMG_COUNT="$(/usr/bin/find "$ARTIFACT_DIR" -maxdepth 1 -type f -name '*.dmg' | /usr/bin/wc -l | /usr/bin/tr -d ' ')"
[[ "$DMG_COUNT" -ge 1 ]] || { echo "Missing DMG artifact" >&2; exit 2; }

TEMP_DIR="$(/usr/bin/mktemp -d /tmp/agentsdock-release.XXXXXX)"
trap '/bin/rm -rf "$TEMP_DIR"' EXIT
/usr/bin/ditto -x -k "$ARTIFACT_DIR/$ZIP_NAME" "$TEMP_DIR"
APP_PATH="$(/usr/bin/find "$TEMP_DIR" -maxdepth 2 -type d -name 'AgentsDock.app' -print -quit)"
[[ -n "$APP_PATH" ]] || { echo "Zip does not contain AgentsDock.app" >&2; exit 2; }

BUNDLE_VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP_PATH/Contents/Info.plist")"
[[ "$BUNDLE_VERSION" == "$EXPECTED_VERSION" ]] || { echo "Bundle version $BUNDLE_VERSION does not match $EXPECTED_VERSION" >&2; exit 2; }

/usr/bin/codesign --verify --deep --strict --verbose=2 "$APP_PATH"
/usr/sbin/spctl --assess --type execute --verbose=4 "$APP_PATH"
/usr/bin/xcrun stapler validate "$APP_PATH"

echo "Verified AgentsDock $EXPECTED_VERSION: metadata, sha512, Developer ID signature, Gatekeeper, and notarization ticket."
