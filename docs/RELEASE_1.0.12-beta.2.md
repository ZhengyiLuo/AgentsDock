# AgentsDock 1.0.12-beta.2

This candidate includes main through
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

## Preparation and validation

Preparation is in progress. This document does not yet establish publication,
signed-package acceptance or deployment. Native build and final artifact source
will be recorded after the exact candidate passes its release checks.

The upgrade rehearsal pins the independently verified public stable `1.0.11`
and beta `1.0.12-beta.1` packages, alongside the retained legacy migration path.
Stable users must explicitly opt into Beta; normal stable feeds stay unchanged.
Signing, checksums, matching npm runtime/CLI contents and the legacy bridge
must all pass before exposing the desktop release.

macOS packages require Developer ID signing and Apple notarization. Windows
installers follow the existing unsigned distribution policy and may show
security warnings. Mobile packages and store submissions are separately scoped;
mobile changes present in the source history are not a mobile release here.

Feature checks and upgrade fixtures are scoped observations, not a claim of
full provider-native content parity, every populated customer-history migration,
or logout/reboot and busy-work replacement acceptance.
