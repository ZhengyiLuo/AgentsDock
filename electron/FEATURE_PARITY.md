# macOS Feature Parity

This checklist compares the Electron client with the current Swift macOS app.
It is a release gate, not a list of aspirations. A checked item has source and
regression evidence in the Electron tree; final completion still requires a
packaged-app smoke pass.

## Conversations and navigation

- [x] Cache-first startup and selected-chat restore
- [x] Multiple chats, provider resume, fork, archive, delete, pin, unread
- [x] Search by title, folder, backend, runtime, cwd, and provider identifier
- [x] Folder creation, collapse, persistence, and drag reorder
- [x] Chat drag reorder and move-to-folder
- [x] Control-Tab navigation and command palette
- [x] Single-instance macOS behavior

## Timeline and composer

- [x] Virtualized, stable-key timeline with bounded in-memory chat cache
- [x] Incremental live events and warm-open tail reconciliation
- [x] One-page-at-a-time older history with prepend position preservation
- [x] Persisted per-chat viewport and explicit local-send jump to bottom
- [x] No automatic bottom following for incoming agent messages
- [x] Markdown, GFM tables, syntax highlighting, links, emoji, and full copy
- [x] Folded long messages and collapsed reasoning/tool traces
- [x] In-timeline unread boundary and sidebar unread state
- [x] Per-chat draft persistence, multiline keyboard behavior, paste/drop files
- [x] Queued turns: edit, remove, reorder, and Steer/send-now
- [x] Selectable transcript content across adjacent rendered rows

## Files, media, and review

- [x] Upload progress, image paste, timeline and composer drop targets
- [x] Image/video grid, preview player, download, open, reveal, pin, find in chat
- [x] Drag files out of timeline and inspector
- [x] Paged newest-first inspector media grid with lazy video thumbnail loading
- [x] Authorized relative server-file links
- [x] Codex-style per-file unified diff review and full-diff copy

## Runtime and automation

- [x] Server runtime catalog with unknown/current-value preservation
- [x] Backend lock after provider session creation
- [x] Runtime changes protected from polling overwrite
- [x] Scheduled jobs: create/edit, custom start, interval, backend, pause/run/delete
- [x] Fixed-run count and loop-forever modes
- [x] Collapsed job timeline with latest result and bounded prior history
- [x] LLM digest preview and background source-agent send-to-chat
- [x] Live process metrics/stdout and linked tmux pane capture on demand
- [x] Interactive per-chat terminal backed by a persistent remote tmux session
- [x] Tmux window tabs, pane splits, reconnect, resize, search, copy/paste, and
  explicit session teardown

## Native integration and resilience

- [x] Editable server URL/token with stable server identity
- [x] API contract mismatch warning
- [x] Native notifications and Dock unread badge
- [x] Inspector visibility, font controls, and native keyboard menus
- [x] Atomic, deduplicated file downloads
- [x] Rotating startup/crash/unresponsive logs
- [x] Offline sessions, jobs, queue, files, pins, preferences, and transcript cache

## Verification gates

- [x] `pnpm typecheck`
- [x] `pnpm test`
- [x] Production renderer/main/preload build
- [x] Local arm64 package at `dist/AgentsDock.app`
- [x] Packaged launch, cache bootstrap, authenticated server connection, and
  real-workspace render smoke check
- [x] Regression coverage for chat switching, queued turns, paging, full-copy,
  authorized file links, media state, and relaunch viewport persistence

Direct builds update from signed GitHub Release artifacts. MAS/TestFlight
builds disable that updater and receive updates from Apple.
