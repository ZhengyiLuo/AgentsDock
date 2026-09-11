#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
source "$ROOT/scripts/lib/app_store_connect_auth.zsh"

TEST_ROOT="$(/usr/bin/mktemp -d /tmp/agentsdock-asc-auth-test.XXXXXX)"
trap '/bin/rm -rf "$TEST_ROOT"' EXIT

CASE_DIR=""
RESOLVER_STATUS=0
RESOLVER_STDERR=""
AUTHENTICATION_ARGS=()

fail() {
  print -u2 -- "build_electron_mas auth regression failed: $1"
  exit 1
}

reset_case() {
  unset AGENTSDOCK_ASC_KEY_PATH AGENTSDOCK_ASC_ISSUER_ID
  CASE_DIR="$TEST_ROOT/$1"
  /bin/mkdir -p "$CASE_DIR/config"
  AUTHENTICATION_ARGS=()
  RESOLVER_STATUS=0
  RESOLVER_STDERR=""
}

run_resolver() {
  local required="$1"
  local stderr_path="$CASE_DIR/stderr.txt"
  if agentsdock_resolve_asc_authentication "$required" "$CASE_DIR/config" 2>"$stderr_path"; then
    RESOLVER_STATUS=0
  else
    RESOLVER_STATUS=$?
  fi
  RESOLVER_STDERR="$(<"$stderr_path")"
}

assert_status() {
  [[ "$RESOLVER_STATUS" == "$1" ]] || fail "unexpected resolver status"
}

assert_args() {
  local -a expected=("$@")
  (( ${#AUTHENTICATION_ARGS[@]} == ${#expected[@]} )) || fail "unexpected authentication argument count"
  local index
  for (( index = 1; index <= ${#expected[@]}; index++ )); do
    [[ "${AUTHENTICATION_ARGS[$index]}" == "${expected[$index]}" ]] || fail "authentication argument $index did not match"
  done
}

assert_contains() {
  [[ "$1" == *"$2"* ]] || fail "expected diagnostic was missing"
}

assert_not_contains() {
  [[ "$1" != *"$2"* ]] || fail "diagnostic exposed credential material"
}

reset_case local_without_credentials
run_resolver false
assert_status 0
assert_args
[[ -z "$RESOLVER_STDERR" ]] || fail "credential-free local export emitted a warning"

reset_case upload_without_credentials
run_resolver true
assert_status 2
assert_args
assert_contains "$RESOLVER_STDERR" "credentials are required for TestFlight upload"

reset_case discovered_credentials
/bin/mkdir -p "$CASE_DIR/config/private_keys"
DISCOVERED_KEY="$CASE_DIR/config/private_keys/AuthKey_DISCOVERED123.p8"
print -r -- "PRIVATE_KEY_CONTENT_MUST_NOT_APPEAR" > "$DISCOVERED_KEY"
print -r -- $'  discovered-issuer-id \n' > "$CASE_DIR/config/issuer_id"
run_resolver false
assert_status 0
assert_args \
  -authenticationKeyPath "$DISCOVERED_KEY" \
  -authenticationKeyID DISCOVERED123 \
  -authenticationKeyIssuerID discovered-issuer-id
[[ -z "$RESOLVER_STDERR" ]] || fail "valid discovered credentials emitted a warning"

reset_case explicit_credentials_win
/bin/mkdir -p "$CASE_DIR/config/private_keys" "$CASE_DIR/explicit"
print -r -- "DEFAULT_PRIVATE_KEY_CONTENT" > "$CASE_DIR/config/private_keys/AuthKey_DEFAULT123.p8"
print -r -- "default-issuer-id" > "$CASE_DIR/config/issuer_id"
EXPLICIT_KEY="$CASE_DIR/explicit/AuthKey_EXPLICIT456.p8"
print -r -- "EXPLICIT_PRIVATE_KEY_CONTENT_MUST_NOT_APPEAR" > "$EXPLICIT_KEY"
AGENTSDOCK_ASC_KEY_PATH="$EXPLICIT_KEY"
AGENTSDOCK_ASC_ISSUER_ID=$' explicit-issuer-id\n'
run_resolver true
assert_status 0
assert_args \
  -authenticationKeyPath "$EXPLICIT_KEY" \
  -authenticationKeyID EXPLICIT456 \
  -authenticationKeyIssuerID explicit-issuer-id
[[ -z "$RESOLVER_STDERR" ]] || fail "valid explicit credentials emitted a warning"

reset_case explicit_key_with_default_issuer
/bin/mkdir -p "$CASE_DIR/config/private_keys" "$CASE_DIR/explicit"
print -r -- "DEFAULT_PRIVATE_KEY_CONTENT" > "$CASE_DIR/config/private_keys/AuthKey_DEFAULT789.p8"
print -r -- "default-issuer-id" > "$CASE_DIR/config/issuer_id"
EXPLICIT_ONLY_KEY="$CASE_DIR/explicit/AuthKey_EXPLICITONLY123.p8"
print -r -- "EXPLICIT_ONLY_PRIVATE_KEY_CONTENT" > "$EXPLICIT_ONLY_KEY"
AGENTSDOCK_ASC_KEY_PATH="$EXPLICIT_ONLY_KEY"
run_resolver false
assert_status 0
assert_args \
  -authenticationKeyPath "$EXPLICIT_ONLY_KEY" \
  -authenticationKeyID EXPLICITONLY123 \
  -authenticationKeyIssuerID default-issuer-id
[[ -z "$RESOLVER_STDERR" ]] || fail "explicit key plus default issuer emitted a warning"

reset_case explicit_issuer_with_discovered_key
/bin/mkdir -p "$CASE_DIR/config/private_keys"
DISCOVERED_ONLY_KEY="$CASE_DIR/config/private_keys/AuthKey_DISCOVEREDONLY456.p8"
print -r -- "DISCOVERED_ONLY_PRIVATE_KEY_CONTENT" > "$DISCOVERED_ONLY_KEY"
print -r -- "default-issuer-must-not-win" > "$CASE_DIR/config/issuer_id"
AGENTSDOCK_ASC_ISSUER_ID="explicit-only-issuer-id"
run_resolver false
assert_status 0
assert_args \
  -authenticationKeyPath "$DISCOVERED_ONLY_KEY" \
  -authenticationKeyID DISCOVEREDONLY456 \
  -authenticationKeyIssuerID explicit-only-issuer-id
[[ -z "$RESOLVER_STDERR" ]] || fail "explicit issuer plus discovered key emitted a warning"

reset_case invalid_explicit_key_local
/bin/mkdir -p "$CASE_DIR/config/private_keys"
print -r -- "DEFAULT_PRIVATE_KEY_MUST_NOT_REPLACE_EXPLICIT" > "$CASE_DIR/config/private_keys/AuthKey_DEFAULT999.p8"
print -r -- "default-issuer-id" > "$CASE_DIR/config/issuer_id"
INVALID_LOCAL_KEY="$CASE_DIR/missing/AuthKey_INVALIDLOCAL123.p8"
AGENTSDOCK_ASC_KEY_PATH="$INVALID_LOCAL_KEY"
run_resolver false
assert_status 0
assert_args
assert_contains "$RESOLVER_STDERR" "continuing with Xcode account authentication"
assert_not_contains "$RESOLVER_STDERR" "$INVALID_LOCAL_KEY"
assert_not_contains "$RESOLVER_STDERR" "DEFAULT_PRIVATE_KEY_MUST_NOT_REPLACE_EXPLICIT"

reset_case invalid_explicit_upload
MISSING_KEY="$CASE_DIR/missing/AuthKey_MISSING123.p8"
/bin/mkdir -p "$CASE_DIR/config/private_keys"
print -r -- "DEFAULT_PRIVATE_KEY_MUST_NOT_REPLACE_INVALID_EXPLICIT" > "$CASE_DIR/config/private_keys/AuthKey_DEFAULTUPLOAD123.p8"
print -r -- "default-upload-issuer-id" > "$CASE_DIR/config/issuer_id"
AGENTSDOCK_ASC_KEY_PATH="$MISSING_KEY"
AGENTSDOCK_ASC_ISSUER_ID="UPLOAD_ISSUER_MUST_NOT_APPEAR"
run_resolver true
assert_status 2
assert_args
assert_contains "$RESOLVER_STDERR" "credentials are required for TestFlight upload"
assert_not_contains "$RESOLVER_STDERR" "UPLOAD_ISSUER_MUST_NOT_APPEAR"
assert_not_contains "$RESOLVER_STDERR" "$MISSING_KEY"
assert_not_contains "$RESOLVER_STDERR" "DEFAULT_PRIVATE_KEY_MUST_NOT_REPLACE_INVALID_EXPLICIT"

reset_case incomplete_discovered_local
/bin/mkdir -p "$CASE_DIR/config/private_keys"
print -r -- "DISCOVERED_PRIVATE_KEY_CONTENT_MUST_NOT_APPEAR" > "$CASE_DIR/config/private_keys/AuthKey_PARTIAL123.p8"
run_resolver false
assert_status 0
assert_args
assert_contains "$RESOLVER_STDERR" "continuing with Xcode account authentication"
assert_not_contains "$RESOLVER_STDERR" "DISCOVERED_PRIVATE_KEY_CONTENT_MUST_NOT_APPEAR"

print -r -- "build_electron_mas auth regression: pass"
