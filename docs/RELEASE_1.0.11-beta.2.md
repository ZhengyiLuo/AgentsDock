# AgentsDock 1.0.11-beta.2

## What's new

- **Gemini for desktop and server:** configure a Gemini API in My Agents, choose a model, and chat using the native Gemini CLI runtime. Includes native skills, per-chat approval modes, streaming tool activity, scoped agent-to-agent messaging, queues, Stop/Delete, original-session imports and automatic short titles. Install Gemini CLI 0.64.0 on the server. Google/CLI sign-in and mobile Gemini are not included.
- **Faster long-chat recovery:** open the latest conversation first, load older history on demand, and recover blank timeline ranges. File links now open supported attachments or explain when a file is unavailable.
- **Clearer npm setup:** first-time interactive installation displays the server URL and token together directly in the terminal, without copying the token into npm logs. Missing-uv errors include installation and retry steps. Token/status commands show connection addresses; `agentsdock logs` reads local service logs.
- **More reliable history and recovery:** keep native-history maintenance off the chat-admission path, suppress proven internal handoffs replayed as user messages, dismiss emergency alerts per chat, and recover failed server updates without losing detached jobs.
- **Provider and chat polish:** new chats open directly with the last-used settings, errors can be copied, archived chats are clearly marked, and Codex retires unavailable account models without changing custom-endpoint model IDs.

Desktop, server and both npm packages share version `1.0.11-beta.2`. This is a
beta release; stable `1.0.10` and npm `latest` remain unchanged.

## Limits

- The isolated macOS acceptance app required force-closing during test cleanup;
  clean quit remains unvalidated.
- Windows installers are unsigned and may show security warnings.
- Gemini uses API connections only, with the installed CLI as its runtime.
  Native Fork, managed child-agent controls, Goal, `/btw`, explicit compaction,
  ongoing reconciliation of external Gemini history and mobile Gemini are not
  offered by this integration. Plan mode requires native workspace support.
- Native Windows/Linux desktop interaction, reboot/logout, full populated-history
  and active/queued-work upgrades remain separate acceptance boundaries. Do not
  treat provider/source tests as proof of those workflows.

Install the beta command with `npm install -g agentsdock@beta`. Reinstalling the
CLI leaves existing servers unchanged; update them explicitly through the app
or `agentsdock update`.
