#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DERIVED_DATA="${ROOT}/build/DerivedDataLocalMac"
BUILT_APP="${DERIVED_DATA}/Build/Products/Release/ZenithDock.app"
DIST_DIR="${ROOT}/dist"
DIST_APP="${DIST_DIR}/ZenithDock.app"

cd "${ROOT}"

xcodebuild \
  -scheme ZenithDockMac \
  -configuration Release \
  -destination platform=macOS \
  -derivedDataPath "${DERIVED_DATA}" \
  build \
  -quiet

rm -rf "${DIST_APP}"
mkdir -p "${DIST_DIR}"
ditto "${BUILT_APP}" "${DIST_APP}"

codesign --verify --deep --strict --verbose=2 "${DIST_APP}"

MBA_HOST="${ZENITHDOCK_MBA_HOST:-zens-macbook-air}"
MBA_DEST="${ZENITHDOCK_MBA_DEST:-/Users/zen/agi}"
if ssh -o BatchMode=yes -o ConnectTimeout=5 "${MBA_HOST}" "mkdir -p '${MBA_DEST}'" >/dev/null 2>&1; then
  rsync -a --delete "${DIST_APP}" "${MBA_HOST}:${MBA_DEST}/"
  echo "Synced MBA: ${MBA_HOST}:${MBA_DEST}/ZenithDock.app"
else
  echo "Skipped MBA sync: ${MBA_HOST} is not reachable over SSH" >&2
fi

echo "${DIST_APP}"
