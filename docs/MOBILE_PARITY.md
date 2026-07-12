# AgentsDock iOS/iPadOS Parity

The mobile client uses the same server contract, session identity, runtime
catalog, queue, jobs, files, and unread cursors as the Electron desktop client.
Platform-specific presentation may differ, but a chat must remain operable from
either client without losing capabilities or state.

## React Rewrite Audit

This table is the source of truth for the React rewrite. `Working` means the
capability has both a UI path and an implemented store/server path. `Partial`
means data or APIs exist but the complete user workflow is not wired. The audit
was refreshed on 2026-07-12 against the old Swift iOS client and the Electron
desktop client.

| Capability | Status | iPhone and iPad behavior |
|---|---|---|
| Chat lifecycle | Working | Create, resume by provider ID, fork, rename, archive, delete, pin, move between folders, and stable move-up/down ordering. |
| Chat action menu | Working | Native long-press menu plus swipe actions for pin/archive/delete; read/unread and folder moves are included. |
| Folder management | Working | Create folders from the sidebar, fold sections, and long-press a folder header to move it up or down. |
| Runtime selection | Working | Server-populated Claude/Codex models and effort levels; backend locks after a provider session starts. |
| Queue | Working | Edit, reorder, remove, run-now/steer, stop, and attachment retention on send failure. |
| Timeline | Working | Cached latest page, live incremental events, older paging, Markdown/tables/code, full-text copy/folding, grouped traces, jobs, errors, and media. |
| Whole-history search | Partial | Server-wide content search and name-first ranking work. A result opens the right chat, but exact event reveal is not wired yet. |
| Timeline landmarks | Partial | The server index is fetched and cached, but the React UI does not yet expose the navigator or exact landmark jumps. |
| Pins | Partial | Message/file pin state, visual feedback, full-message preview/copy, file preview, and unpin work. Exact reveal in the timeline is not wired yet. |
| Code review | Working | Canonical per-turn patch, file list, additions/deletions, line-oriented diff, and copy-complete-diff. |
| Files and media | Partial | Paged metadata, image/video preview, gallery navigation, native share/download, and latest-first browser work. Find-in-chat and iPad drag-in/drag-out are not wired yet. |
| Scheduled jobs | Working | Create/edit, fixed or looping runs, first-run time, enable/pause, run now, refresh, and delete. |
| Live processes | Partial | Process details, command/path copy, snapshot stdout, refresh, and copy stdout work. Selecting arbitrary attached logs for tailing is not wired yet. |
| Tmux submitters | Working | Chat-linked or machine-wide pane list plus on-demand captured output and copy. |
| Persistent terminal | Working | Native SwiftTerm view attached to per-chat server tmux, with windows, splits, navigation, close, copy, paste, keyboard focus, and reconnect. |
| Digest handoff | Working | Source-agent preview/generation, detail level, user prompt, archived-target filtering, and send to target chat. |
| Notifications and badges | Working | Background agent notifications and per-chat unread badge count use server read cursors. |
| Settings | Partial | Server address/token and automatic system appearance work. Explicit appearance and notification preferences are not wired yet. |

## Platform Rules

- iPhone uses full-screen sheets for review, terminal, media, and chat details.
- iPad uses split panes where the extra width materially improves operation.
- TestFlight remains the updater for iOS/iPadOS; Electron self-update is a
  desktop-only capability, not a missing mobile feature.
- Mobile never downloads every attachment eagerly. Preview/share requests
  populate the bounded local file cache on demand.

## Verification

- TypeScript must pass before every native build.
- Both compact iPhone and regular-width iPad simulator builds are required for
  parity changes; menus, sheets, keyboard behavior, and terminal focus must be
  exercised in each size class.
- A feature stays `Partial` until its end-to-end UI behavior is exercised. API
  presence or a cached store value alone does not count as delivery.
