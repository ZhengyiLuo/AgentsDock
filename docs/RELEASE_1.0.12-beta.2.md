# AgentsDock 1.0.12-beta.2

This release includes main through
`9f6f1f13704e767717b5131e2df1213306a58abd`, integrated with the release fixes
already shipped in `1.0.12-beta.1`. The direct desktop app, npm server, short CLI
and signed legacy server bridge share version `1.0.12-beta.2`. Stable
subscriptions remain on `1.0.11`.

## Changes since beta.1

- Toggle the workspace toolbar without creating or deleting a layout. Use its
  plus button to create workspaces; hiding the toolbar retains split panes,
  the selected chat and drafts. Visibility is remembered per server.
- Stop the current agent with Escape while the composer is focused. Open
  popovers close first. Browse previous composer prompts without replacing
  another chat's draft, and use deliberate Enter actions for queued messages.
- Attach editable file and symbol references from the connected workspace.
  Python and TypeScript/JavaScript editors add project completion, diagnostics,
  hover, definitions and references when the corresponding language servers
  are installed on the server. Missing tools have explicit setup/retry guidance;
  they are not installed automatically. New files support inline naming.
- Sort the sidebar by Folders, Latest or Name, with the selection retained per
  server. Preferences groups reasoning and sidebar behavior settings together.
  Changing display order preserves folders, pins and unread/running behavior.
- Recover failed server connections with an explicit reconnect action instead
  of misleading provider-login advice. Preserve unsent messages for retry.
- Improve Claude scheduled-turn and goal continuation, native child lifecycle,
  and history reconciliation. Retain long Claude reports in compact history.
  Keep native Claude child messages separate from AgentsDock chat routes;
  cross-chat delivery still requires the user's delegation and an accepted
  AgentsDock receipt.
- Preserve Codex goal follow-up ownership and history, including explicitly
  selected chat references and skills. Keep internal goal-resume markers out of
  user message bubbles. Retain existing child-only Stop behavior,
  Side chat controls, custom-endpoint isolation and signed-update protections.
- Improve runtime discovery/transport cleanup and identify the actual failed
  activation boundary without weakening installer ownership or recovery checks.

## Publication and validation

Published on 2026-11-02 UTC from frozen product source
`9e816c6b3b73508a47764b4d4ea546e41bcd3857`, native build **1270**:
[canonical desktop](https://github.com/ZhengyiLuo/AgentsDock/releases/tag/v1.0.12-beta.2),
[compatibility mirror](https://github.com/ZhengyiLuo/AgentsDock-Releases/releases/tag/v1.0.12-beta.2),
and the [signed legacy server bridge](https://github.com/ZhengyiLuo/AgentsServer/releases/tag/v1.0.12-beta.2).
Both npm packages, `@agentsdock/server` and `agentsdock`, select this version on
`beta`; their stable `latest` tags and both desktop stable releases remain
`1.0.11`. Stable users must explicitly opt into Beta.

[Paired npm publication](https://github.com/ZhengyiLuo/AgentsDock/actions/runs/41391793355)
verified the original accepted archives. An independent fresh, scripts-disabled
registry installation matched all runtime/CLI files and executable permissions,
the exact runtime dependency, CLI version and help, without installing a service.
The bridge contains the same signed runtime.
[Desktop publication](https://github.com/ZhengyiLuo/AgentsDock/actions/runs/41392454191)
rechecked all four native platforms and published identical assets and notes to
both download repositories. Public checks confirmed source tags, asset digests,
signed descriptors, beta feed selection and preserved stable defaults.

The exact signed macOS app and matching signed runtime passed real Claude and
Codex contextual follow-ups, repeated messages, matching-version checks, history
rendering, workspace state and existing editor-draft recovery. Native keyboard
and mouse input exercised the production client/server boundary in an isolated,
hidden app launched directly. Packaged history retained genuine same-worded user
messages while hiding internal Codex goal-resume lifecycle markers. Source QA
also exercised goal steering, Escape cancellation, Claude native child completion
and Python language-server diagnostics after an isolated tools installation.

All 11 scoped [macOS replay cases](https://github.com/ZhengyiLuo/AgentsDock/actions/runs/41290724301)
passed with the original candidate, including beta.1 to beta.2 coordination,
offline reconnect and shared-operation multi-client checks. Both installation-root
permission variants passed the scoped [Linux rollback checks](https://github.com/ZhengyiLuo/AgentsDock/actions/runs/41290726125).
[Native CLI acceptance](https://github.com/ZhengyiLuo/AgentsDock/actions/runs/41289067074)
passed on macOS and Linux. These reports retain their narrower acceptance limits.

Local macOS LaunchServices relaunch acceptance remains incomplete; further restart
testing was explicitly deferred for this beta. Checks do not establish full native
provider content parity, every populated customer-history migration, busy-work
replacement, logout/reboot survival, the native Windows updater, or idle Codex
goal-resume cross-chat mail authority. Automated analytics collection was disabled
for isolated QA. These limits are also included in both public release notes.

macOS packages use Developer ID signing and Apple notarization. Windows installers
follow the existing unsigned distribution policy and may show security warnings.
Mobile packages and store submissions remain separately scoped. No mobile release
or installed-service deployment is included. Later documentation commits do not
change the frozen artifact source or authorize rebuilding this version.
