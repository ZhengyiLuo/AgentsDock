# AgentsDock 1.0.12-beta.3

This candidate integrates main through
`5de30b23f5153c20dd11980aca4aac6a6a6f6363` with the fixes already published
in `1.0.12-beta.2`. Desktop, the npm runtime, short CLI and signed legacy server
bridge share `1.0.12-beta.3`. Stable subscriptions remain on `1.0.11`.

## Changes since beta.2

- Recoverable coordinated updates prepare each saved server independently,
  preserve supported interrupted work, restart that server and resume its chats.
  The desktop installs only after all saved servers are healthy. Partial failure
  remains visible and retry does not reinstall servers already current.
- Native Codex goals retain their identity and usage across an update. Claude
  must confirm stopping before restart; Cursor's first turn waits until its
  native session is saved. Unsupported background work waits for a safe boundary.
  Continuation is not an exact instruction checkpoint or an exactly-once
  guarantee for external tool effects.
- Restore file/chat split controls inside workspace panes, leave only the
  focused chat when exiting workspace mode, and create chats in empty panes.
- Improve terminal typing feedback, return to the live position when typing
  after scrolling, and bound queued output without discarding terminal bytes.
- Clarify Claude context usage, recover failed context reads, treat local slash
  commands such as `/compact` as completed turns, and display their diagnostic
  output separately from user messages. Preserve versioned model labels.
- Refresh completed chats outside the current view and make connection/recovery
  status more accurate.
- Allow authorized agents to create top-level chats with immediate mailbox
  routes, while distinguishing the worker's delegated task from the creator's
  orchestration.

## Preparation status

This document currently records source preparation, not publication. The exact
signed packages, native build, update/recovery observations and publication
receipts must be recorded before calling this release available.

Source validation includes desktop type checking and production compilation,
5,948 passing desktop tests (six skipped), and eight packaging/license checks.
The scoped upgrade harness now pins the independently verified public beta.2
and stable 1.0.11 baselines. It retains all historical source/signature/hash and
installation-root permission checks.

PR #98's isolated native multi-server acceptance is source evidence, not
acceptance of these new production packages. Installed-version upgrade,
offline/failure behavior, retained settings and active-work safety still need
the exact candidate. Native Windows updater and logout/reboot behavior are
separate from package verification and must not be described as tested without
their own observations.

The intended macOS artifacts require Developer ID signing and notarization.
Windows follows the approved unsigned distribution policy. Mobile builds,
store submissions and deployment to existing services are not included.
