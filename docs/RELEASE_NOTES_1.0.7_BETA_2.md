# AgentsDock 1.0.7-beta.2

- Add Claude Goals to the composer, using Claude's native completion evaluator.
- Show completed goal details and support **Clear & stop** during a running tool.
- Keep Start goal available after a turn finishes, without reopening the dialog.
- Fix Claude Send now getting stuck in Starting after an incomplete Stop.
- Keep native interruption markers and internal compaction handoffs out of
  ordinary chat messages, including when reopening affected history.

Claude Goals and the history/lifecycle fixes require the matching server update.
Goals also require a Claude Code installation that supports `/goal`. Older
servers continue ordinary chat; installing the app is independent of the
connected server's version.
