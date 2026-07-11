# AgentsDock iOS/iPadOS Parity

The mobile client uses the same server contract, session identity, runtime
catalog, queue, jobs, files, and unread cursors as the Electron desktop client.
Platform-specific presentation may differ, but a chat must remain operable from
either client without losing capabilities or state.

## Shipped Baseline

- Session create/resume/fork/delete, folders, stable ordering, pin/archive, and
  cross-device read/unread state.
- Claude/Codex runtime selection with server-populated models and effort levels.
- Incremental timeline streaming, local cache, older-history paging, Markdown,
  tables, code copy, folded messages, grouped traces, and job responses.
- Queued turn edit/reorder/remove/run-now, stop, attachments, drag-in on iPad,
  image/video preview, native sharing/download, and latest-first media browser.
- Scheduled and fixed-run jobs, digest handoff, live-process logs, notifications,
  app badges, server/token settings, and phone/iPad adaptive navigation.

## Delivered Parity

| Capability | iPhone and iPad behavior |
|---|---|
| Whole-history search | Server-wide results, name-first ranking, open at hit |
| Timeline navigation | Server landmark index and exact event jumps |
| Pins | Message/file pin actions and per-chat pinned collection |
| Code review | Canonical per-turn patch, file list, line numbers, copy diff |
| Persistent terminal | Native SwiftTerm view attached to per-chat server tmux |
| Tmux workspace | Windows, splits, pane/window close, reconnect, kill session |
| Settings | Dedicated server/security/appearance/notification surface |

## Platform Rules

- iPhone uses full-screen sheets for review, terminal, media, and chat details.
- iPad uses split panes where the extra width materially improves operation.
- TestFlight remains the updater for iOS/iPadOS; Electron self-update is a
  desktop-only capability, not a missing mobile feature.
- Mobile never downloads every attachment eagerly. Preview/share/drag requests
  populate the bounded local file cache on demand.

## Verification

- The regular-width iPad build was exercised against the authenticated live
  server: a real Claude conversation loaded, complete-history search returned
  server results, its persistent tmux opened a live shell, and a three-file
  canonical patch rendered with accurate totals and line numbers.
- The compact iPhone build was exercised against the same server and a chat
  with more than 6,000 historical events. Its latest page, paging controls,
  composer, runtime summary, and adaptive header remain usable without loading
  the complete transcript or attachment inventory into memory.
- `ZenithGuardrails` protects search identity, exact history targets, diff
  parsing, terminal authentication/actions, pins, drag-out, settings, and Xcode
  target wiring. A generic iOS Simulator build is required before release.
