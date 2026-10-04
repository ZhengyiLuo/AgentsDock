# AgentsDock 1.0.4-beta.7

- Show model compatibility clearly for custom Codex endpoints, with an optional
  basic check using the saved endpoint credentials.
- Keep unfamiliar model IDs available and offer only explicitly supported
  reasoning effort settings for each model.
- Keep model checks separate from saving endpoint settings and preserve each
  existing chat's endpoint selection.

Requires AgentsServer 1.0.4-beta.7 for the model compatibility and reasoning
capability contract. A successful basic check covers isolated native tool calls
and a follow-up; it does not certify every tool or integration.
