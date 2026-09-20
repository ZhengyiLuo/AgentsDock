# AgentsDock 1.0.4-beta.5

- Keep each server's side-chat conversation and draft when switching servers.
  An answer already in progress continues on its original server and is
  available when you return. Follow-ups retain their side-chat context.
- Keep side chats separate across servers, including chats with matching IDs.
  Explicit cancellation and clearing still apply to the original side chat.
- Show the useful fork failure message without Electron's internal IPC prefix.
- Pair with AgentsServer 1.0.4-beta.5 to fix valid native Codex forks being
  rejected when a workspace path contains a symlink, and to show clearer fork
  failure reasons.
