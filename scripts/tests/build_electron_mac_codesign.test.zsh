#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
source "$ROOT/scripts/lib/electron_local_codesign.zsh"
TEST_ROOT="$(/usr/bin/mktemp -d /tmp/agentsdock-electron-codesign-test.XXXXXX)"
trap '/bin/rm -rf "$TEST_ROOT"' EXIT

fail() {
  print -u2 -- "build_electron_mac codesign regression failed: $1"
  exit 1
}

make_test_bundle() {
  local bundle="$1"
  local identifier="$2"
  local executable="$3"
  /bin/mkdir -p "$bundle/Contents/MacOS"
  /bin/cp /usr/bin/true "$bundle/Contents/MacOS/$executable"
  /usr/bin/plutil -create xml1 "$bundle/Contents/Info.plist"
  /usr/bin/plutil -insert CFBundleIdentifier -string "$identifier" "$bundle/Contents/Info.plist"
  /usr/bin/plutil -insert CFBundleExecutable -string "$executable" "$bundle/Contents/Info.plist"
  /usr/bin/plutil -insert CFBundleName -string "$executable" "$bundle/Contents/Info.plist"
  /usr/bin/plutil -insert CFBundlePackageType -string APPL "$bundle/Contents/Info.plist"
  /usr/bin/plutil -insert CFBundleVersion -string 1 "$bundle/Contents/Info.plist"
}

assert_runtime_entitlements() {
  local target="$1"
  local output="$TEST_ROOT/entitlements-$RANDOM.plist"
  /usr/bin/codesign -d --entitlements - --xml "$target" > "$output" 2>/dev/null \
    || fail "could not extract ad-hoc entitlements"
  local entitlement
  for entitlement in \
    com.apple.security.cs.allow-jit \
    com.apple.security.cs.allow-unsigned-executable-memory \
    com.apple.security.cs.disable-library-validation; do
    [[ "$(/usr/libexec/PlistBuddy -c "Print :$entitlement" "$output" 2>/dev/null)" == true ]] \
      || fail "$target lost required entitlement $entitlement"
  done
}

IDENTITIES=$'  1) AAA "Apple Development: Example (OTHERTEAM)"\n  2) BBB "Developer ID Application: Zhengyi Luo (KRR35MWWHD)"\n     2 valid identities found'

unset AGENTSDOCK_LOCAL_CODESIGN_IDENTITY AGENTSDOCK_LOCAL_ALLOW_ADHOC_ISOLATED
[[ "$(agentsdock_resolve_local_codesign_identity "$IDENTITIES")" == "Developer ID Application: Zhengyi Luo (KRR35MWWHD)" ]] \
  || fail "automatic Developer ID discovery did not choose the canonical team"

AGENTSDOCK_LOCAL_CODESIGN_IDENTITY="Developer ID Application: Zhengyi Luo (KRR35MWWHD)"
[[ "$(agentsdock_resolve_local_codesign_identity "$IDENTITIES")" == "$AGENTSDOCK_LOCAL_CODESIGN_IDENTITY" ]] \
  || fail "an explicit matching Developer ID identity was not honored"

AGENTSDOCK_LOCAL_CODESIGN_IDENTITY="Apple Development: Example (OTHERTEAM)"
if agentsdock_resolve_local_codesign_identity "$IDENTITIES" >/dev/null 2>&1; then
  fail "an explicit non-Developer-ID identity was accepted"
fi

AGENTSDOCK_LOCAL_CODESIGN_IDENTITY="Developer ID Application: Other (OTHERTEAM)"
if agentsdock_resolve_local_codesign_identity "$IDENTITIES" >/dev/null 2>&1; then
  fail "an explicit foreign-team identity was accepted"
fi

unset AGENTSDOCK_LOCAL_CODESIGN_IDENTITY
if agentsdock_resolve_local_codesign_identity $'  1) AAA "Apple Development: Example (OTHERTEAM)"' >/dev/null 2>&1; then
  fail "a development identity was silently treated as the canonical identity"
fi
AGENTSDOCK_LOCAL_DEVELOPER_TEAM_ID=OTHERTEAM
if agentsdock_resolve_local_codesign_identity $'  1) AAA "Developer ID Application: Other (OTHERTEAM)"' >/dev/null 2>&1; then
  fail "a legacy environment override bypassed the hardcoded Developer ID team"
fi
unset AGENTSDOCK_LOCAL_DEVELOPER_TEAM_ID

if agentsdock_require_adhoc_isolation "/Applications/AgentsDock.app" >/dev/null 2>&1; then
  fail "canonical installation accepted ad-hoc signing without opt-in"
fi

AGENTSDOCK_LOCAL_ALLOW_ADHOC_ISOLATED=1
if agentsdock_require_adhoc_isolation "/Applications/AgentsDock.app" >/dev/null 2>&1; then
  fail "canonical installation accepted ad-hoc signing with opt-in"
fi
if agentsdock_require_adhoc_isolation "/System/Applications/AgentsDock.app" >/dev/null 2>&1; then
  fail "system Applications accepted ad-hoc signing with opt-in"
fi
if agentsdock_require_adhoc_isolation "$HOME/Applications/AgentsDock.app" >/dev/null 2>&1; then
  fail "the user Applications directory accepted ad-hoc signing with opt-in"
fi
if agentsdock_require_adhoc_isolation "/Users/example/agi/AgentsDock.app" >/dev/null 2>&1; then
  fail "ambiguous app destination accepted ad-hoc signing"
fi
agentsdock_require_adhoc_isolation "/Users/example/agi/AgentsDock-builds/test/AgentsDock.app" \
  || fail "explicit build output rejected ad-hoc isolation"
agentsdock_require_adhoc_isolation "/private/tmp/local-test/AgentsDock.app" \
  || fail "temporary output rejected ad-hoc isolation"

/bin/mkdir -p "$TEST_ROOT/AgentsDock-builds/output" "$TEST_ROOT/Applications"
if agentsdock_require_adhoc_isolation "$TEST_ROOT/AgentsDock-builds/../Applications/AgentsDock.app" >/dev/null 2>&1; then
  fail "a parent traversal bypassed the canonical destination allowlist"
fi
/bin/ln -s /Applications "$TEST_ROOT/AgentsDock-builds/applications-link"
if agentsdock_require_adhoc_isolation "$TEST_ROOT/AgentsDock-builds/applications-link/AgentsDock.app" >/dev/null 2>&1; then
  fail "a real symlink bypassed the canonical Applications rejection"
fi
agentsdock_require_adhoc_isolation "$TEST_ROOT/AgentsDock-builds/output/AgentsDock.app" \
  || fail "a canonicalized temporary build destination was rejected"

grep -Fq "agentsdock_resolve_local_codesign_identity" "$ROOT/scripts/build_electron_mac.sh" \
  || fail "local build no longer resolves a safe signing identity"
grep -Fq "sign_electron_local.mjs" "$ROOT/scripts/build_electron_mac.sh" \
  || fail "local build no longer signs nested Electron code with project entitlements"
grep -Fq "SIGNED_TEAM_ID" "$ROOT/scripts/build_electron_mac.sh" \
  || fail "local build no longer verifies the Developer ID team"
grep -Fq 'Contents/Resources/adhoc-isolated-user-data' "$ROOT/scripts/build_electron_mac.sh" \
  || fail "ad-hoc fallback no longer embeds its runtime isolation marker"
grep -Fq "adhoc-isolated-user-data" "$ROOT/electron/src/main/user-data-path.ts" \
  || fail "runtime no longer honors the ad-hoc isolation marker"
grep -Fq "agentsdock-electron-local-adhoc" "$ROOT/electron/src/main/user-data-path.ts" \
  || fail "runtime no longer separates ad-hoc and production user data"
if grep -Fq 'codesign --force --deep --sign -' "$ROOT/scripts/build_electron_mac.sh"; then
  fail "the unsafe deep ad-hoc signer returned"
fi
grep -Fq '[[ "$SIGNED_TEAM_ID" == KRR35MWWHD ]]' "$ROOT/scripts/build_electron_mac.sh" \
  || fail "the canonical Developer ID team check is no longer hardcoded"

SIGNING_APP="$TEST_ROOT/Signing Fixture.app"
SIGNING_HELPER="$SIGNING_APP/Contents/Frameworks/Signing Fixture Helper.app"
make_test_bundle "$SIGNING_APP" com.zhengyiluo.AgentsDock.SigningFixture "Signing Fixture"
make_test_bundle "$SIGNING_HELPER" com.zhengyiluo.AgentsDock.SigningFixture.helper "Signing Fixture Helper"
node "$ROOT/scripts/sign_electron_local.mjs" \
  "$SIGNING_APP" \
  - \
  "$ROOT/electron/packaging/entitlements.mac.plist" \
  "$ROOT/electron/packaging/entitlements.mac.inherit.plist" \
  adhoc > "$TEST_ROOT/adhoc-sign.log"
/usr/bin/codesign --verify --deep --strict "$SIGNING_APP" \
  || fail "the ad-hoc fixture did not pass strict nested verification"
SIGNING_DETAILS="$(/usr/bin/codesign -d --verbose=4 "$SIGNING_APP" 2>&1)"
[[ "$SIGNING_DETAILS" == *$'Signature=adhoc'* ]] || fail "the fixture was not ad-hoc signed"
[[ "$SIGNING_DETAILS" == *$'TeamIdentifier=not set'* ]] || fail "the ad-hoc fixture unexpectedly acquired a team identity"
[[ "$SIGNING_DETAILS" == *'(adhoc,runtime)'* ]] || fail "the ad-hoc fixture lost hardened-runtime signing flags"
[[ "$SIGNING_DETAILS" != *$'Timestamp='* ]] || fail "the ad-hoc fixture unexpectedly requested a timestamp"
assert_runtime_entitlements "$SIGNING_APP"
assert_runtime_entitlements "$SIGNING_HELPER"

print -r -- "build_electron_mac codesign regression: pass"
