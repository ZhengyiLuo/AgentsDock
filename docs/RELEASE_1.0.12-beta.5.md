# AgentsDock 1.0.12-beta.5

This is a prepared Beta candidate, not a publication receipt. The desktop app,
signed server runtime, legacy server bridge and short `agentsdock` CLI share
version `1.0.12-beta.5`. Stable remains `1.0.11`.

## Changes since beta.4

- Public update checks use a separate, non-persistent Electron session without
  browser credentials. This avoids opening the browser cookie encryption store
  during release discovery while retaining timeouts and signed metadata checks.
- Legacy managed servers now apply the same file-descriptor headroom as the
  split server layout, giving provider processes more room to open files.
- Retain beta.4's recoverable update behavior, stale-update receipt protection
  and recovery diagnostics.

## Validation before publication

The candidate includes exact upgrade-test baselines for stable `1.0.11` and
published `1.0.12-beta.4`, including both legacy installation-root permission
modes. Stable users explicitly select Beta; existing Beta subscriptions remain
selected. These test definitions do not establish a successful native upgrade.

New signed packages still require installation, relaunch, rollback/retry and
retained-settings checks. Real active and queued work and populated native
provider history need separate acceptance. Logout/reboot and the native Windows
updater remain unverified. Scoped test reports retain their original limits.

The CI-only fallback for downloading Electron does not change the app's public
download URLs or resolve upstream GitHub download failures. The separate
browser-store wait observed during app shutdown is not claimed fixed by the
update-check session change.

Publication must use the accepted matching npm packages and signed legacy
bridge before exposing the desktop update. Existing published assets stay
unchanged. macOS packages require signing and notarization; Windows previews
remain unsigned under the existing distribution policy.
