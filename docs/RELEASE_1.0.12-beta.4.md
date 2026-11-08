# AgentsDock 1.0.12-beta.4

This coordinated beta contains the reviewed beta.3 source plus the updater
status reconciliation fix. Desktop, the npm runtime, short CLI and signed legacy
server bridge share `1.0.12-beta.4`. Stable subscriptions remain on `1.0.11`.
The unpublished beta.3 artifacts remain unchanged.

## Changes since public beta.2

- Prepare each saved server independently during coordinated updates. Keep
  partial failures visible and retryable, and skip servers already current.
  The desktop installs after all saved servers are healthy.
- Preserve supported interrupted work across server updates, including native
  Codex goal identity and usage. Wait for Claude to confirm stopping and for
  Cursor's first native session to become durable. Unsupported background work
  waits for a safe boundary. Continuation does not guarantee an exact instruction
  checkpoint or exactly-once external tool effects.
- Keep a live updater's progress when a stale status check overlaps a new
  heartbeat, process, phase or recovery owner. Update check/start requests must
  retain that refreshed operation rather than finalize or replace it.
- Restore workspace split controls, leave only the focused chat when exiting
  workspace mode, and allow chat creation in empty panes.
- Improve terminal typing feedback and return to the live position when typing
  after scrolling, while retaining queued terminal bytes.
- Clarify Claude context usage and recovery, complete local slash commands such
  as `/compact`, separate diagnostics from user messages and preserve model labels.
- Refresh completed chats outside the current view and improve connection and
  recovery status.
- Allow authorized agents to create top-level chats with immediate mailbox
  routes while keeping delegated work distinct from orchestration.

## Verification and availability

This is a preparation record, not a publication receipt. Source checks include
227 focused updater, endpoint, runner and recovery tests for the reconciliation
fix. An isolated development app exercised real authenticated HTTP, preserved
refreshed update receipts, and completed disposable Codex and Claude conversations
retained after navigation. The failed-liveness interleaving was simulated.

Earlier beta.3 desktop compilation, source tests and scoped hosted package/update
checks remain evidence for their original source and artifacts. They do not
establish acceptance of these new packages. The final signed outgoing desktop
update, automatic relaunch, active-task recovery and populated native history
journeys remain unverified. Native Windows replacement and logout/reboot behavior
also remain separate from package verification. Record later observations against
their exact source, version and artifact hashes; do not mark an untested boundary
as passed.

macOS packages require Developer ID signing and notarization. Windows follows
the approved unsigned distribution policy. Mobile/store releases and deployment
to existing services are outside this release.
