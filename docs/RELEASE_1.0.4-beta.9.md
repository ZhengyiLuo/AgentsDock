# AgentsDock 1.0.4-beta.9

- Match Codex's compact activity presentation with inline progress text,
  quiet command rows, and one pulsing current activity. Respect reduced motion
  and stop the pulse when the turn finishes or stops.
- Add **Show reasoning traces** in Settings → General. Keep the compact view
  by default; enable the switch to expand available summaries and separately
  labeled provider-supplied reasoning. Remember the display choice.
- Preserve supplied reasoning through live updates, reconnects, completion,
  and interruption. Availability depends on the provider; encrypted reasoning
  is not displayed.
- Add optional sub-agent limits for individual Codex and Claude chats in the
  Inspector. Save without interrupting active work and show when each native
  provider will apply the change. Leave the field empty to inherit existing
  configuration.

Requires AgentsServer 1.0.4-beta.9 for plaintext reasoning and per-chat limits.
Claude retains its native concurrency rules and exceptions. A loaded Codex
thread may retain its previous limit until the next provider process starts
when restoring an unspecified native default; the app reports that condition.
