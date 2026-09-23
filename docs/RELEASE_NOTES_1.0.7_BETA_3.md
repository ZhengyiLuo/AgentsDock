# AgentsDock 1.0.7-beta.3

- Keep your reading position when switching between chats, including older
  messages that need to be loaded again.
- Preserve deliberate scrolling during chat loading, so a late response does
  not pull you back to another position.
- Add native Claude Goals with completion details and Clear & stop.
- Restore Start goal automatically when a turn finishes.
- Fix Claude Send now getting stuck in Starting after an incomplete Stop.
- Keep native interruption markers and internal compaction handoffs out of
  ordinary chat messages when reopening affected history.

The scrolling fixes work with existing servers. Claude Goals and the
history/lifecycle fixes require server 1.0.7-beta.2. Goals also require a Claude
Code installation that supports `/goal`. Older servers continue ordinary chat;
installing the app is independent of the connected server's version. This app
package does not automatically install or update the server.
