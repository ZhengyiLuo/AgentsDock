# Resolve the one signing identity that is safe to install over the canonical
# Developer ID build. Callers pass the output of `security find-identity` so
# this function stays deterministic and directly testable.
agentsdock_resolve_local_codesign_identity() {
  emulate -L zsh

  local identities="${1:-}"
  local explicit="${AGENTSDOCK_LOCAL_CODESIGN_IDENTITY:-}"
  local expected_team="KRR35MWWHD"
  local line=""
  local candidate=""

  if [[ "$explicit" == *$'\n'* || "$explicit" == *$'\r'* ]]; then
    print -u2 -- "AGENTSDOCK_LOCAL_CODESIGN_IDENTITY is invalid."
    return 2
  fi

  while IFS= read -r line; do
    [[ "$line" == *\"*\"* ]] || continue
    candidate="${line#*\"}"
    candidate="${candidate%%\"*}"
    [[ "$candidate" == "Developer ID Application:"*" ($expected_team)" ]] || continue
    if [[ -z "$explicit" || "$candidate" == "$explicit" ]]; then
      print -r -- "$candidate"
      return 0
    fi
  done <<< "$identities"

  if [[ -n "$explicit" ]]; then
    print -u2 -- "AGENTSDOCK_LOCAL_CODESIGN_IDENTITY must name an available Developer ID Application certificate for team $expected_team."
    return 2
  fi
  return 1
}

# An ad-hoc Electron bundle has a different designated requirement and cannot
# safely read the canonical build's Keychain/Safe Storage entries. Keep this
# fallback opt-in, confined to an obvious build location, and runtime-isolated.
agentsdock_require_adhoc_isolation() {
  emulate -L zsh

  local destination="${1:-}"
  local destination_parent="${destination:h}"
  local destination_name="${destination:t}"
  local canonical_parent="${destination_parent:A}"
  local canonical_home="${HOME:A}"
  local canonical_destination="$canonical_parent/$destination_name"
  if [[ "${AGENTSDOCK_LOCAL_ALLOW_ADHOC_ISOLATED:-}" != 1 ]]; then
    print -u2 -- "No matching Developer ID Application certificate is available."
    print -u2 -- "Ad-hoc local builds require AGENTSDOCK_LOCAL_ALLOW_ADHOC_ISOLATED=1 and use isolated app data."
    return 2
  fi

  if [[ "$destination" == ../* || "$destination" == */../* || "$destination" == */.. ]]; then
    print -u2 -- "An ad-hoc build destination cannot contain parent-directory traversal."
    return 2
  fi

  if [[
    "$canonical_parent" == /Applications
    || "$canonical_parent" == /Applications/*
    || "$canonical_parent" == /System/Applications
    || "$canonical_parent" == /System/Applications/*
    || "$canonical_parent" == "$canonical_home/Applications"
    || "$canonical_parent" == "$canonical_home/Applications/"*
  ]]; then
    print -u2 -- "An ad-hoc build cannot target a canonical Applications directory."
    return 2
  fi

  case "$canonical_destination" in
    /private/tmp/*/AgentsDock.app|*/AgentsDock-[Bb]uilds/*/AgentsDock.app|*/build/*/AgentsDock.app|*/dist/*/AgentsDock.app|*/.AgentsDock-stage.*/AgentsDock.app)
      return 0
      ;;
  esac

  print -u2 -- "An ad-hoc build may only target an explicit temporary or build-output AgentsDock.app path."
  print -u2 -- "It must never replace /Applications/AgentsDock.app or another canonical production-data build."
  return 2
}
