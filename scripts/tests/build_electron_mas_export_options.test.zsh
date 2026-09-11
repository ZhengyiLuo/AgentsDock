#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LOCAL_OPTIONS="$ROOT/electron/packaging/export-options.mas-local.plist"
UPLOAD_OPTIONS="$ROOT/electron/packaging/export-options.mas-upload.plist"

fail() {
  print -u2 -- "build_electron_mas export-options regression failed: $1"
  exit 1
}

assert_plist_value() {
  local plist="$1"
  local key="$2"
  local expected="$3"
  local actual
  actual="$(/usr/libexec/PlistBuddy -c "Print :$key" "$plist")"
  [[ "$actual" == "$expected" ]] || fail "$plist has unexpected $key"
}

for plist in "$LOCAL_OPTIONS" "$UPLOAD_OPTIONS"; do
  [[ -f "$plist" ]] || fail "missing tracked export options: $plist"
  plutil -lint "$plist" >/dev/null || fail "invalid plist: $plist"
  assert_plist_value "$plist" method app-store-connect
  assert_plist_value "$plist" signingStyle automatic
  assert_plist_value "$plist" teamID KRR35MWWHD
  assert_plist_value "$plist" testFlightInternalTestingOnly false
  assert_plist_value "$plist" uploadSymbols true
done

assert_plist_value "$LOCAL_OPTIONS" destination export
assert_plist_value "$LOCAL_OPTIONS" manageAppVersionAndBuildNumber false
assert_plist_value "$UPLOAD_OPTIONS" destination upload
assert_plist_value "$UPLOAD_OPTIONS" manageAppVersionAndBuildNumber true

print -r -- "build_electron_mas export-options regression: pass"
