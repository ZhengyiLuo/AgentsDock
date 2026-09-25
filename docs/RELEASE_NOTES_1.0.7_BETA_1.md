# AgentsDock 1.0.7-beta.1

- Add Claude Goals to the composer. Set a completion condition and follow
  Claude's native evaluator, including completed goal details.
- Clear a running goal with **Clear & stop**, including while a tool is running.
- Keep native goal controls and command history readable after reopening a chat.
- Fix Claude Send now getting stuck in Starting after an incomplete Stop.
- Fix native interruption markers appearing as user messages after parallel
  tool results.

Claude Goals and the lifecycle fixes require the matching server update. Goals
also require a Claude Code installation that supports `/goal`. Older servers
continue to support ordinary chat; app installation is independent of the
connected server's version.
