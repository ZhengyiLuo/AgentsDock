# AgentsDock 1.0.10-beta.1

- Same-server agent messages now use the mailbox exclusively. Older request/reply callers no longer inject delivery instructions into the conversation.
- Codex Side chat shows live provider reasoning and activity using the shared reasoning visibility setting. Completed or cancelled activity stays available in a collapsed view.
- Existing Codex chats can switch between a custom endpoint and normal Codex while preserving their history. Pending changes apply after owned work finishes.
- Custom endpoint failures retain the upstream error and use native Codex retries. Connection replacement cleans up the previous listener, and retrying after a tool result does not replay completed tool work.
- Restored scrolling in the video playback-speed menu.

This beta pairs desktop and server version 1.0.10-beta.1. Windows installers are unsigned. Stable releases and stable npm selection remain unchanged.
