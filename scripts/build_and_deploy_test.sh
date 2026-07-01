#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DERIVED_DATA="${ROOT}/build/DerivedDataAgentsDockTest"
BUILT_APP="${DERIVED_DATA}/Build/Products/Release/AgentsDock.app"
DIST_APP="${ROOT}/dist/AgentsDock-test.app"
TEST_BUNDLE_ID="com.zhengyiluo.AgentsDockTest"

cd "${ROOT}"

xcodebuild \
  -project ZenithDock.xcodeproj \
  -scheme AgentsDockMac \
  -configuration Release \
  -destination platform=macOS \
  -derivedDataPath "${DERIVED_DATA}" \
  PRODUCT_BUNDLE_IDENTIFIER="${TEST_BUNDLE_ID}" \
  'SWIFT_ACTIVE_COMPILATION_CONDITIONS=$(inherited) AGENTSDOCK_APPKIT_TIMELINE' \
  CODE_SIGN_IDENTITY=- \
  CODE_SIGN_STYLE=Manual \
  DEVELOPMENT_TEAM= \
  build \
  -quiet

rm -rf "${DIST_APP}"
mkdir -p "${ROOT}/dist"
ditto "${BUILT_APP}" "${DIST_APP}"

mv \
  "${DIST_APP}/Contents/MacOS/AgentsDock" \
  "${DIST_APP}/Contents/MacOS/AgentsDock-test"
plutil -replace CFBundleDisplayName -string "AgentsDock-test" "${DIST_APP}/Contents/Info.plist"
plutil -replace CFBundleName -string "AgentsDock-test" "${DIST_APP}/Contents/Info.plist"
plutil -replace CFBundleExecutable -string "AgentsDock-test" "${DIST_APP}/Contents/Info.plist"

if [[ -d "${DIST_APP}/Contents/Frameworks" ]]; then
  while IFS= read -r -d '' framework; do
    codesign --force --sign - "${framework}"
  done < <(find "${DIST_APP}/Contents/Frameworks" -maxdepth 1 -name "*.framework" -print0)
fi
codesign --force --sign - "${DIST_APP}"
codesign --verify --deep --strict --verbose=2 "${DIST_APP}"

swift run ZenithGuardrails

if server_url="$(defaults read com.zhengyiluo.ZenithDock serverURL 2>/dev/null)"; then
  defaults write "${TEST_BUNDLE_ID}" serverURL "${server_url}"
fi
if access_token="$(security find-generic-password -s com.zhengyiluo.ZenithDock -a agent-access-token -w 2>/dev/null)"; then
  defaults write "${TEST_BUNDLE_ID}" agentAccessToken "${access_token}"
fi

MBA_HOST="${ZENITHDOCK_MBA_HOST:-zens-macbook-air}"
MBA_DEST="${ZENITHDOCK_MBA_DEST:-/Users/zen/agi}"
if ssh -o BatchMode=yes -o ConnectTimeout=5 "${MBA_HOST}" "mkdir -p '${MBA_DEST}'" >/dev/null 2>&1; then
  rsync -a --delete "${DIST_APP}" "${MBA_HOST}:${MBA_DEST}/"
  echo "Synced MBA test build: ${MBA_HOST}:${MBA_DEST}/AgentsDock-test.app"
else
  echo "Skipped MBA test sync: ${MBA_HOST} is not reachable over SSH" >&2
fi

echo "${DIST_APP}"
