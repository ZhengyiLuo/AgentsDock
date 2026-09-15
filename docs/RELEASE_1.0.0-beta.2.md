# AgentsDock 1.0.0-beta.2

- Quiet Team Network indicators distinguish new Mail from Bulletin changes.
  Refresh stays explicit: incoming notifications never open a view, fetch a
  feed, move focus or change an unsent draft.
- Share one metadata-only notification connection for Mail and Bulletin.
  Coalesce bursts without adding a recurring inbox polling timer. Older
  servers retain their Mail-only notification behavior.
- Keep newer Bulletin changes pending when they arrive during a refresh.
  Partial, failed or cached loads cannot incorrectly clear the indicator.
- Preserve immediate, chronological cross-chat sent/received messages and
  their read states without duplicate timeline rows.
- Include translated indicators and refresh affordances in light and dark
  layouts. Existing author-only announcement edits retain version history.

Use AgentsServer `1.0.0-beta.3` for Bulletin notifications and the provider-tool
stdin reply fix. An app-only installation does not apply that server fix.
Neither release forces a server restart or interrupts research jobs.

Direct Electron beta only. Official macOS artifacts are Developer ID signed
and notarized. Windows remains an unsigned beta preview. Stable and mobile
release channels are unchanged.
