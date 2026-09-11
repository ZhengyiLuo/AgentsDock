# AgentsDock 0.2.13-beta.31

- Native Codex goal progress stays visible below earlier answers while work
  continues. Older answers remain in place, with supporting tool output folded
  into bounded, on-demand progress sections.
- Send now explains that it pauses the goal to run your message. A paused
  goal and an active message are displayed as separate states.
- Historical Claude interruption markers no longer appear as fresh messages
  from you or incorrectly change running/unread state. Repaired history stays
  repaired after reopening the chat or refreshing cached events.
- Narrow light and dark layouts verified in the actual renderer.
- Restore sidebar collapse/expand controls and Cmd/Ctrl+/ shortcut; keep long
  scheduled-job labels contained, with the full title available on hover.

Use AgentsServer `0.1.26-beta.53` for the paired goal-event and Claude-history
provenance fixes. This release does not force-restart or change any server.

Direct Electron beta only. macOS binaries are Developer ID signed and
notarized by CI. Windows is an unsigned beta and may show SmartScreen warnings.
Stable and TestFlight channels are unchanged.
