# Resolve optional App Store Connect API authentication for Xcode exports.
# The caller must define AUTHENTICATION_ARGS before invoking this function.
agentsdock_resolve_asc_authentication() {
  emulate -L zsh
  setopt null_glob

  local require_credentials="${1:-false}"
  local config_dir="${2:-$HOME/.appstoreconnect}"
  local key_path="${AGENTSDOCK_ASC_KEY_PATH:-}"
  local issuer_id="${AGENTSDOCK_ASC_ISSUER_ID:-}"
  local key_id=""
  local credential_material_present=false
  local -a discovered_keys=()

  AUTHENTICATION_ARGS=()

  # Preserve the original independent overrides: an explicit key can use the
  # default issuer, and an explicit issuer can use the discovered default key.
  # An explicit key path remains authoritative even when it is invalid, so the
  # resolver never silently switches to a different key/account.
  if [[ -n "$key_path" ]]; then
    credential_material_present=true
  else
    discovered_keys=("$config_dir/private_keys"/AuthKey_*.p8)
    if (( ${#discovered_keys[@]} > 0 )); then
      key_path="${discovered_keys[1]}"
      credential_material_present=true
    fi
  fi

  if [[ -n "$issuer_id" ]]; then
    credential_material_present=true
  else
    if [[ -f "$config_dir/issuer_id" ]]; then
      issuer_id="$(<"$config_dir/issuer_id")"
      credential_material_present=true
    elif [[ -e "$config_dir/issuer_id" ]]; then
      credential_material_present=true
    fi
  fi

  issuer_id="${issuer_id//[[:space:]]/}"
  if [[ -n "$key_path" ]]; then
    key_id="${key_path:t:r}"
    key_id="${key_id#AuthKey_}"
  fi

  if [[ -n "$key_path" && -f "$key_path" && -r "$key_path" && -s "$key_path" && -n "$key_id" && -n "$issuer_id" ]]; then
    AUTHENTICATION_ARGS=(
      -authenticationKeyPath "$key_path"
      -authenticationKeyID "$key_id"
      -authenticationKeyIssuerID "$issuer_id"
    )
    return 0
  fi

  if [[ "$require_credentials" == true ]]; then
    print -u2 -- "App Store Connect API credentials are required for TestFlight upload."
    print -u2 -- "Set AGENTSDOCK_ASC_KEY_PATH and AGENTSDOCK_ASC_ISSUER_ID, or install ~/.appstoreconnect/private_keys/AuthKey_*.p8 plus ~/.appstoreconnect/issuer_id."
    return 2
  fi

  if [[ "$credential_material_present" == true ]]; then
    print -u2 -- "Warning: App Store Connect credentials are incomplete or invalid; continuing with Xcode account authentication for local export."
  fi
  return 0
}
