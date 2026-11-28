# AgentsDock 1.0.12-beta.7 preparation

This candidate pairs the desktop app, npm server, signed legacy server bridge
and `agentsdock` CLI at `1.0.12-beta.7`. Stable remains `1.0.11` and the public
beta remains `1.0.12-beta.6` until a separately authorized publication.

## Changes

- Switching a Codex chat from a custom endpoint to normal Codex first prepares
  a native plaintext context checkpoint on the original endpoint when needed.
  The native thread and existing history stay intact. Preparation progress and
  failure are visible; a failed preparation keeps the original connection.
- Force Send retains the chosen queued message while an interrupt finishes,
  then sends it once automatically. The queue shows the wait without an error
  toast asking the user to retry.
- Codex and Claude side chats support multiple saved conversations with
  separate drafts, history, activity, followups and cancellation.
- Codex history import no longer duplicates user messages solely because
  consecutive blank lines were compacted. Genuine repeated messages remain.
- Include main's workspace divider bounds, pinned-message navigation, provider
  model catalog and recovery improvements. Preserve the updater corrections
  already shipped in beta.6.

## Preparation and validation

The component PRs passed their source CI. Focused tests and actual Electron
UI/IPC/server checks exercised endpoint preparation, deferred Force Send,
independent side chats and imported-history reconciliation. Those isolated
checks used synthetic provider endpoints or handles; they are not evidence of
live account parity. A separately authorized existing-chat recovery completed
native compaction on its original custom provider, then restored normal Codex
with its native thread and original rollout prefix preserved.

The combined candidate needs its own signed packages, native build allocation,
packaged UI checks and isolated upgrade receipts. Live Claude side-chat testing
requires a valid isolated credential; no shared login is refreshed for testing.
Normal-Codex-to-custom portability of encrypted checkpoints is not claimed
fixed by the reverse-direction repair. Historical receipts and their untested
provider-history, busy-work, reboot and Windows-update boundaries remain
separate from this candidate's results.

The existing Apple and server signing identities are retained. Windows remains
explicitly unsigned. No mobile build, public publication, or live-server
deployment is part of this preparation.
