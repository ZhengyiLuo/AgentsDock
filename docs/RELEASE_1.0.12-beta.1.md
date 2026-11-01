# AgentsDock 1.0.12-beta.1

This release includes main through `827ed452140db0a09bfab39905aa133f736871be`,
integrated with the release fixes already shipped in stable `1.0.11`.
The direct desktop app, npm server, short CLI and signed legacy server bridge
share version `1.0.12-beta.1`. Desktop build **1269** is available from the
[canonical release](https://github.com/ZhengyiLuo/AgentsDock/releases/tag/v1.0.12-beta.1)
and the [legacy download mirror](https://github.com/ZhengyiLuo/AgentsDock-Releases/releases/tag/v1.0.12-beta.1).
Stable subscriptions remain on `1.0.11`.

## Changes since stable 1.0.11

- Add optional named workspaces with up to four chat panes, keyboard navigation,
  reorderable tabs and live updates in every visible pane. Ordinary chats retain
  a compact header; workspace creation is available from the main toolbar.
- Let existing paired chats carry the user's actual delegated task without a
  fresh mention. Peer-authored text cannot create user authorization. Inbox
  **Edit and send** appends a message to the matching draft for manual review
  and normal Send, preserving existing text and attachments.
- Improve native Codex child cancellation and ownership-aware Stop controls.
  Preserve provider-supported background work and Side chat descendants;
  allow native Claude goal requests while a turn is running.
- Fix typed model commands, Cursor tool parsing, expired CLI credential status,
  and follow-ups in forked Claude chats.
- Improve TIFF previews, opening workspace files in split chats, compact
  composer controls and configurable Unread/Running sidebar groups.

## Publication and verification

Published on October 31, 2026 from artifact source
`c52aad2ed807a911000e41ffc0ade24d7edd4778`. The desktop repositories contain
identical assets and final notes. Their checksum-manifest SHA-256 is
`8607b21895a52cd4acedb408f86173bf70f24d8d61e22c8d8946ddb294d98a3a`.
Documentation follow-up commits do not change the frozen packages or tags.

Both `@agentsdock/server` and `agentsdock` publish `1.0.12-beta.1` on npm's
`beta` tag; both `latest` tags remain `1.0.11`. The matching
[signed legacy server bridge](https://github.com/ZhengyiLuo/AgentsServer/releases/tag/v1.0.12-beta.1)
is public, with the same runtime contents as the signed npm package.

- Source/server CI and native CLI checks passed. The
  [matched npm publication](https://github.com/ZhengyiLuo/AgentsDock/actions/runs/41193988640/attempts/2)
  verified both public packages and preserved stable defaults. A fresh registry
  installation with lifecycle scripts disabled matched all 9 CLI and 140 runtime
  files against the accepted archives and reported the matching CLI version.
- The [desktop publication workflow](https://github.com/ZhengyiLuo/AgentsDock/actions/runs/41238462413)
  verified the exact packages on macOS, Linux x64/arm64 and Windows, then
  published both desktop copies. Public asset digests, update feeds and beta
  discovery were independently checked after publication.
- The [11 macOS rehearsal jobs](https://github.com/ZhengyiLuo/AgentsDock/actions/runs/41192004543/attempts/3)
  completed their recorded installer, upgrade and recovery scopes, including
  stable `1.0.11` and `1.0.11-beta.12` baselines. Offline reconnection and two
  clients sharing one server update were observed. Separate
  [Linux rollback checks](https://github.com/ZhengyiLuo/AgentsDock/actions/runs/41192006615)
  passed.
- Isolated live Claude/Codex checks exercised conversations, cold context resume,
  workspace restoration, paired mail, draft review/send and Codex Side chat
  continuation through real app/server transports. These checks do not establish
  full native-provider content parity, populated customer-history migration,
  normal local quit/logout/reboot behavior or busy-work replacement.

Known limitation: explicitly resuming an idle native Codex goal can lack the
fresh provider-tool authority needed to read chat mail. This release does not
claim to fix that lifecycle path. New work merged after the pinned main commit
is outside this release.

macOS packages use Developer ID signing and Apple notarization. Windows
installers follow the existing unsigned distribution policy and may show
security warnings. Mobile builds and store submissions are separately scoped.
