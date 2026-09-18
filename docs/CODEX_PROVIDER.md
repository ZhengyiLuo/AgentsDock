# Native Codex custom endpoints

The native desktop operator may configure one custom Responses endpoint and model, then choose **Codex · Custom endpoint** for an individual chat. Ordinary **Codex** keeps its existing native configuration and sign-in; saving a custom endpoint does not replace that account or change existing chats. Both options use the same native Codex app-server, not a separate chat-completions engine. An OpenAI-compatible Chat Completions gateway is not necessarily compatible with Codex's Responses protocol.

Session create/update requests use `backend: "codex"` with `codex_provider: "default" | "custom"`; missing selection means `default`. The selected provider is returned in session detail and summary, preserved by forks, and locked once a native conversation starts. Custom chats use the configured exact model ID. The runtime catalog publishes separate `backends.codex.custom_provider` metadata without replacing ordinary Codex models or account readiness. Clients must require `capabilities.codex_provider_v1.per_chat === true` before saving or selecting a custom endpoint on older servers.

Administrative routes require the exact native token header, reject browser-origin requests, and disable response caching:

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/api/admin/codex/provider` | Public selection and whether a provider key exists; never returns a key. |
| POST | `/api/admin/codex/provider/test` | One isolated native connection test using explicitly supplied inputs. |
| PUT | `/api/admin/codex/provider` | Save the endpoint, model, and a freshly entered provider key. |
| DELETE | `/api/admin/codex/provider` | Remove the custom endpoint; ordinary Codex sign-in stays unchanged. |

Test and Save accept exactly `base_url`, `model`, and `api_key`. HTTPS is required except for literal loopback HTTP. URLs cannot contain credentials, query strings, fragments, or a `/responses` or `/chat/completions` operation suffix. The base URL, model ID, and key are bounded; invalid requests never echo supplied values.

The server saves provider credentials in a private `codex-provider` directory under its administrative state directory. A mode-0600 credential file is bound to the exact normalized endpoint and model. It is not encrypted at rest; only the server user should have access to this directory. Native config and process arguments contain the dedicated environment-variable name, never the key. Normal OpenAI/ChatGPT credentials are not copied to the custom endpoint, and Reset does not overwrite the original Codex login.

The legacy `/api/admin/codex/auth/api-key` mutation is disabled for all clients,
including when no custom endpoint is saved. It cannot replace the shared CLI
login; provider keys must use the custom endpoint routes above.

Save and Reset reject active Codex turns, goals, subagents, and side questions. They retire only the idle Codex manager, never unrelated Claude work. Cancellation cannot release admission while a credential write is still in progress. Existing custom conversations are endpoint-bound: changing endpoints or models requires a new chat, or restoring that conversation's original endpoint and model. Removing the endpoint does not silently reroute those chats through the normal account. Custom side chats must be cleared after a provider/key change; ordinary Codex side chats retain their normal provider.

Test connection does not save credentials or change the active provider. It uses a separately owned Codex app-server, ephemeral auth/thread state, temporary logs/databases, a fixed minimal prompt, disabled integrations and tools, and explicit empty turn environments. The test budget is 45 seconds, followed by owned-process cleanup. Test results and errors use fixed safe messages; there are no automatic retries. Configured readiness means the local provider key is present, not that the provider accepted it; use Test connection to check access.

The isolated regression suite imports only pure modules and AST-extracted server functions. Do not import the server monolith or use production credentials to test this feature.
