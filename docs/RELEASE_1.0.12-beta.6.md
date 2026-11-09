# AgentsDock 1.0.12-beta.6

Published on **2026-11-09 UTC**: desktop build **1275**, the signed
`@agentsdock/server` runtime, the short `agentsdock` CLI and the signed legacy
server bridge share version `1.0.12-beta.6`. Both npm `beta` tags select this
version. Stable remains `1.0.11`. The unpublished beta.5 candidate is unchanged.

Download the [desktop release](https://github.com/ZhengyiLuo/AgentsDock/releases/tag/v1.0.12-beta.6),
its [legacy mirror](https://github.com/ZhengyiLuo/AgentsDock-Releases/releases/tag/v1.0.12-beta.6),
or the [signed server bridge](https://github.com/ZhengyiLuo/AgentsServer/releases/tag/v1.0.12-beta.6).

[Matched npm publication](https://github.com/ZhengyiLuo/AgentsDock/actions/runs/42537649524)
verified both exact archives and preserved both stable `latest` tags. A fresh,
isolated registry install with setup scripts disabled verified `agentsdock@beta`,
its exact runtime dependency and CLI help without operating installed services.
[Desktop publication](https://github.com/ZhengyiLuo/AgentsDock/actions/runs/42538264142)
reverified all four native platforms before publishing the unchanged packages.
Both public desktop copies have the same 16 asset digests, signed server metadata,
update feeds and documented limitations. Public metadata was verified separately
from the native upgrade rehearsals below; a new installed upgrade through the
public feed is not claimed.

## Changes since beta.4

- Keep an app update waiting through a generic HTTP 503 after the exact server
  update has been admitted. Continue only after verifying the original server
  identity, compatible API and completed component versions. Failed initial
  admission and structured errors still stop the update.
- Check public updates through a separate Electron session without browser
  credentials, preserving deadlines and signed metadata verification.
- Give legacy managed servers the same file-descriptor headroom as the split
  server layout.
- Retain beta.4's stale-receipt protection and update recovery.

## Updating from beta.4

The restart-gap correction runs in the new app. An installed beta.4 app still
runs its old updater until desktop replacement. If it shows an incomplete-update
HTTP 503, wait until the saved server shows **Up to date**, then click
**Update AgentsDock** again. This is explicit recovery, not a seamless upgrade.

Stable users must select the Beta update track to receive this version. Existing
Beta subscriptions and saved connections are retained. Stable defaults remain
on `1.0.11`.

## Validation and limits

- [Source CI](https://github.com/ZhengyiLuo/AgentsDock/actions/runs/42530511814)
  and [server CI](https://github.com/ZhengyiLuo/AgentsDock/actions/runs/42530486244)
  passed on the frozen source.
- [Native preparation](https://github.com/ZhengyiLuo/AgentsDock/actions/runs/42533005192)
  produced the signed, notarized universal Mac app and the Windows, Linux x64
  and Linux arm64 packages. [Independent verification](https://github.com/ZhengyiLuo/AgentsDock/actions/runs/42534917122)
  passed on all four native platforms using the exact complete asset manifest.
- [Matched CLI acceptance](https://github.com/ZhengyiLuo/AgentsDock/actions/runs/42533001728)
  passed on macOS and Linux, including real global setup, default and named
  service lifecycle, exact runtime files, cache independence and removal while
  preserving the fixture's retained state.
- [Native Mac upgrade and recovery checks](https://github.com/ZhengyiLuo/AgentsDock/actions/runs/42534945814)
  passed all eleven cases across retained attempts 1, 2 and 4, using the exact
  signed beta.6 candidate. These cover public beta.4, stable `1.0.11` and the
  older installation baseline in both `0755` and `0750` modes, fresh setup,
  interrupted downloads and failed-stage cleanup/retry. Original transient
  Apple ticket-lookup failures from attempts 1–3 remain in the record; retries
  changed neither source nor packages. Both beta.4 modes required the documented
  post-completion recovery: three total Update clicks including the deliberate
  offline-refusal check, with no additional server restart.
- [Linux rollback and retry](https://github.com/ZhengyiLuo/AgentsDock/actions/runs/42534947832)
  passed with both `0755` and `0750` installation roots. An isolated candidate
  worker fault caused real rollback, restored authenticated baseline health and
  preserved state. Retrying the same signed version completed successfully.

A separate isolated check exercised the production coordinator and a real
signed beta.4-to-beta.6 server update with active Codex and Claude work, queued
messages and a persistent goal. Native session identity and prior events were
retained; continuation and queued requests resumed. An offscreen native
source-app check retained the unsent draft and history after quit/relaunch.
These checks do not establish active-provider behavior during packaged desktop
replacement. Hosted package rehearsals use synthetic history and exact-artifact
HTTPS replay; their original non-publication and non-acceptance flags remain.

**Known beta limitation:** interrupting a Claude background task during a forced
update can produce duplicate messages after provider-history refresh. See
[issue #166](https://github.com/ZhengyiLuo/AgentsDock/issues/166). Rendered history
is not fully validated for this case, and exactly-once external tool effects are
not established. The behavior also reproduced with the old beta.4 coordinator
updating to the new server; this is not an old-server-to-old-server proof.

Logout/reboot survival, natural OAuth renewal, complete populated-history
migration, and the native Windows updater remain outside this acceptance.
Windows preview installers are unsigned. No mobile build or upload is included.

## Immutable release identity

- Product source: `0e46b3f81e98596da3d91c73137f89efeee05686`.
- Source branch: `release/prepare-1.0.12-beta.6`.
- Legacy server export: `c2c2e71cd774a46c556b560e5a0680240f487911`.
- Complete desktop `SHA256SUMS` digest:
  `077e92c9fc82d27d183694bfa4e40d5253d5ccd1bf229d88e537fc9557d7dc01`.
- Signed npm descriptor digest:
  `6289ad62804f6c7a64ac41f9a2361d0fed42bb99a1427840e9f42db0892eafd9`.

Later documentation commits are not new artifact sources. Never rebuild or
replace this version's accepted packages.
