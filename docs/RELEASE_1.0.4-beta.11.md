# AgentsDock 1.0.4-beta.11

- Keep each command block compact while Codex works: the current running call
  shares one activity row with preceding calls. Expand that row to inspect
  the individual commands.
- Preserve commentary between command blocks and pulse the current activity.
- Keep extra trace-history controls out of the default live view; reveal
  additional available detail through the reasoning option or completed history.
- Apply **Show reasoning traces** only while a turn is running. Finished and
  stopped turns use the same collapsed history under either setting, with
  retained reasoning available through explicit history expansion.

These presentation fixes work with the existing server contract.
