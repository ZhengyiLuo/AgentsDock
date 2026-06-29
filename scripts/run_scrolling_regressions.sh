#!/bin/zsh
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
repo_root="$(cd "${script_dir}/.." && pwd)"
cd "${repo_root}"

cache_root="${TMPDIR:-/tmp}/zenithdock-scrolling-regressions"
mkdir -p "${cache_root}/clang" "${cache_root}/swiftpm"
export CLANG_MODULE_CACHE_PATH="${cache_root}/clang"
export SWIFTPM_MODULECACHE_OVERRIDE="${cache_root}/swiftpm"

swift run --disable-sandbox --scratch-path "${cache_root}/build" ZenithGuardrails

app_path="${1:-${AGENTSDOCK_TEST_APP:-${repo_root}/dist/AgentsDock-test.app}}"
if [[ -d "${app_path}" ]]; then
  binary="${app_path}/Contents/MacOS/AgentsDock-test"
else
  binary="${app_path}"
fi

if [[ ! -x "${binary}" ]]; then
  print -u2 "AgentsDock-test harness binary not found: ${binary}"
  print -u2 "Pass an existing .app or executable path; this runner does not build the app."
  exit 2
fi

if ! output="$("${binary}" --timeline-harness 2>&1)"; then
  print -r -- "${output}"
  exit 1
fi
print -r -- "${output}"

required_scenarios=(
  stream-below-viewport
  height-change-above-viewport
  prepend-single-page
  active-momentum-priority
  chat-switch-isolation
)

for scenario in "${required_scenarios[@]}"; do
  expected="AppKitTimelineHarness passed scenario=${scenario}"
  count="$(printf '%s\n' "${output}" | grep -Fc "${expected}" || true)"
  if [[ "${count}" != "1" ]]; then
    print -u2 "Expected exactly one native pass record: ${expected}; found ${count}"
    exit 1
  fi
done

print "AgentsDock scrolling regressions passed"
