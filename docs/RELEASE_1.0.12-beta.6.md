# AgentsDock 1.0.12-beta.6

This is source preparation, not a publication receipt. The desktop app, signed
server runtime, legacy server bridge and short `agentsdock` CLI are prepared
under the new matching version `1.0.12-beta.6`. Stable remains `1.0.11`.
The unpublished beta.5 packages and their original test records remain frozen.

## Changes since published beta.4

- Public update checks use a separate Electron session without browser
  credentials, retaining existing deadlines and signed metadata checks.
- Legacy managed servers receive the same file-descriptor headroom as the
  split server layout.
- An app update keeps waiting through a generic HTTP 503 after the exact
  server update has been admitted. The app proceeds only after verifying the
  server identity, compatible API and completed component versions. Completed,
  failed, canceled or paused history cannot authorize this restart handling;
  structured errors and failed initial admission still stop the update.
- Retain beta.4's update recovery and protection against stale update receipts.

The restart-gap correction runs in the updated app. A beta.4 app upgrading to
this release still runs its old updater until desktop replacement. A separately
verified explicit retry after its server becomes current must be reported as
legacy recovery, not a seamless first-attempt upgrade.

## Validation before publication

Upgrade tests use independently pinned public stable `1.0.11` and
`1.0.12-beta.4` packages with both `0755` and `0750` installation roots. Stable
users explicitly select Beta; existing Beta users retain their subscription.
The inherited historical and fresh-install cases remain in place.

An isolated offscreen source-app check exercised the actual Update button,
production IPC/coordinator and a real signed server-runtime update. The app
waited through a gateway-shaped 503 before handing off after verified recovery.
Release discovery, desktop download and final desktop replacement were
simulated. The first attempt failed because of the isolated download fixture;
an explicit UI retry succeeded after that fixture was corrected. These checks
do not establish signed desktop installation or live-provider preservation.

Beta.6 requires new source-bound npm and CLI packages, server signatures, legacy
bridge, native build allocation, signed desktop assets and candidate receipts.
Never relabel beta.5 packages, signatures or acceptance results. Exact-package
native installation/relaunch, rollback/retry, retained settings and provider
history/active-work validation remain release gates. Scoped rehearsals retain
their non-publication and non-acceptance flags. Reboot and native Windows
updater coverage must be reported separately.

Publish the verified matching npm pair and signed server bridge before exposing
the desktop update. macOS packages require signing and notarization; Windows
previews retain the existing unsigned distribution policy. No mobile build or
upload is included in this desktop/server preparation.
