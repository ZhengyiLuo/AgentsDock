# AgentsDock 1.0.12-beta.1 — beta candidate

This candidate includes main through `827ed452140db0a09bfab39905aa133f736871be`,
integrated with the release fixes already shipped in stable `1.0.11`.
The direct desktop app, npm server, short CLI and signed legacy server bridge
share version `1.0.12-beta.1`. Stable subscriptions remain on `1.0.11`.

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

## Preparation and acceptance

This is an unpublished candidate. Source checks, signed packages, matched
npm/bridge bytes, native CLI acceptance, isolated app checks and upgrade/recovery
rehearsals must be recorded for this exact candidate before publication.
Earlier main and stable acceptance do not establish acceptance of these packages.

Known limitation: explicitly resuming an idle native Codex goal can lack the
fresh provider-tool authority needed to read chat mail. This release does not
claim to fix that lifecycle path. New work merged after the pinned main commit
is outside this candidate.

macOS packages require Developer ID signing and Apple notarization. Windows
installers follow the existing unsigned distribution policy and may show
security warnings. Mobile builds and store submissions are separately scoped.
