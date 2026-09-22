# AgentsDock 1.0.4-beta.4

- Fix inter-chat messages appearing below a later final answer when the turn
  includes files or media. Messages now stay interleaved with the surrounding
  work at their original position in the conversation.
- Preserve that order during live updates, after reopening a chat, and when
  read receipts arrive. Messages actually sent after the final answer still
  appear afterward.
- Keep attachment metadata and message timestamps unchanged. This is a
  desktop display correction; no server upgrade or conversation migration is
  required.

Verified with the production timeline in native offscreen Electron using a
reproduction history, including card expansion and light/dark presentation.
Focused chronology regressions, type checking and production compilation pass.
