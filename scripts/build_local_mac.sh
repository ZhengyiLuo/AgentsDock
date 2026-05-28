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

echo "${DIST_APP}"
