#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_PATH="${1:?usage: audit_electron_bundle.sh <AgentsDock.app>}"
EXPECTED_BUNDLE_ID="${AGENTSDOCK_EXPECTED_BUNDLE_ID:-com.zhengyiluo.AgentsDock}"
EXPECTED_ELECTRON_VERSION="${AGENTSDOCK_EXPECTED_ELECTRON_VERSION:-43.1.1}"
ASAR_PATH="$APP_PATH/Contents/Resources/app.asar"
INFO_PLIST="$APP_PATH/Contents/Info.plist"
ELECTRON_INFO_PLIST="$APP_PATH/Contents/Frameworks/Electron Framework.framework/Versions/A/Resources/Info.plist"
ASAR_CLI="$ROOT/electron/node_modules/.pnpm/@electron+asar@3.4.1/node_modules/@electron/asar/bin/asar.js"
FUSES_CLI="$ROOT/electron/node_modules/.pnpm/@electron+fuses@1.8.0/node_modules/@electron/fuses/dist/bin.js"

[[ -f "$ASAR_PATH" ]] || { echo "Missing app.asar in $APP_PATH" >&2; exit 2; }
[[ -f "$INFO_PLIST" ]] || { echo "Missing Info.plist in $APP_PATH" >&2; exit 2; }
[[ -f "$ELECTRON_INFO_PLIST" ]] || { echo "Missing Electron Framework Info.plist in $APP_PATH" >&2; exit 2; }
[[ -f "$ASAR_CLI" && -f "$FUSES_CLI" ]] || { echo "Install Electron dependencies before auditing a bundle." >&2; exit 2; }

BUNDLE_ID="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$INFO_PLIST")"
[[ "$BUNDLE_ID" == "$EXPECTED_BUNDLE_ID" ]] || {
  echo "Unexpected bundle identifier: $BUNDLE_ID (wanted $EXPECTED_BUNDLE_ID)" >&2
  exit 2
}

ELECTRON_VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$ELECTRON_INFO_PLIST")"
[[ "$ELECTRON_VERSION" == "$EXPECTED_ELECTRON_VERSION" ]] || {
  echo "Unexpected Electron version: $ELECTRON_VERSION (wanted $EXPECTED_ELECTRON_VERSION)" >&2
  exit 2
}

FUSE_REPORT="$(node "$FUSES_CLI" read --app "$APP_PATH")"
for expectation in \
  'RunAsNode is Disabled' \
  'EnableCookieEncryption is Enabled' \
  'EnableNodeOptionsEnvironmentVariable is Disabled' \
  'EnableNodeCliInspectArguments is Disabled' \
  'EnableEmbeddedAsarIntegrityValidation is Enabled' \
  'OnlyLoadAppFromAsar is Enabled'; do
  [[ "$FUSE_REPORT" == *"$expectation"* ]] || {
    echo "Unsafe Electron fuse state: expected '$expectation'" >&2
    echo "$FUSE_REPORT" >&2
    exit 2
  }
done

TEMP_ROOT="${TMPDIR:-/tmp}"
[[ -d "$TEMP_ROOT" && -w "$TEMP_ROOT" ]] || {
  echo "Bundle audit temp directory is unavailable: $TEMP_ROOT" >&2
  exit 2
}
TEMP_DIR="$(/usr/bin/mktemp -d "${TEMP_ROOT%/}/agentsdock-bundle-audit.XXXXXX")"
trap '/bin/rm -rf "$TEMP_DIR"' EXIT
node "$ASAR_CLI" list "$ASAR_PATH" > "$TEMP_DIR/asar-files.txt"

if /usr/bin/grep -Eiq '\.(map|ts|tsx|d\.ts|d\.mts|d\.cts)$' "$TEMP_DIR/asar-files.txt"; then
  echo "The release archive contains source maps or TypeScript sources:" >&2
  /usr/bin/grep -Ei '\.(map|ts|tsx|d\.ts|d\.mts|d\.cts)$' "$TEMP_DIR/asar-files.txt" | /usr/bin/head -20 >&2
  exit 2
fi

node "$ASAR_CLI" extract "$ASAR_PATH" "$TEMP_DIR/app"
AUDIT_TARGETS=("$TEMP_DIR/app/out" "$TEMP_DIR/app/package.json")
LEGACY_PRODUCT="$(printf '%s%s' 'Zeni' 'th')"
FORBIDDEN_PATTERN="${LEGACY_PRODUCT}"
# Supply organization-specific patterns privately; never commit private names
# or infrastructure identifiers just to maintain a public denylist.
if [[ -n "${AGENTSDOCK_PRIVATE_CONTENT_PATTERN:-}" ]]; then
  FORBIDDEN_PATTERN+="|${AGENTSDOCK_PRIVATE_CONTENT_PATTERN}"
fi
if /usr/bin/grep -R -I -n -i -E "$FORBIDDEN_PATTERN" "${AUDIT_TARGETS[@]}"; then
  echo "Release code contains a legacy brand, personal host, or personal path." >&2
  exit 2
fi

SECRET_PATTERN='-----BEGIN [A-Z ]*PRIVATE KEY-----|github_pat_[A-Za-z0-9_]{20,}|gh[opusr]_[A-Za-z0-9]{20,}|sk-(proj-|ant-)?[A-Za-z0-9_-]{20,}'
if /usr/bin/grep -R -I -n -E -e "$SECRET_PATTERN" "${AUDIT_TARGETS[@]}"; then
  echo "Release code appears to contain a private key or API token." >&2
  exit 2
fi

echo "Audited $APP_PATH: identity, Electron $ELECTRON_VERSION, fuses, source artifacts, branding, personal paths, and high-confidence secrets are clean."
