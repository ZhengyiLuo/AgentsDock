# Native Codex custom endpoints

The native desktop operator may configure one custom Responses endpoint and model for new Codex chats. This continues to use Codex app-server; it does not add a separate chat-completions engine. An OpenAI-compatible Chat Completions gateway is not necessarily compatible with Codex's Responses protocol.

Administrative routes require the exact native token header, reject browser-origin requests, and disable response caching:

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/api/admin/codex/provider` | Public selection and whether a provider key exists; never returns a key. |
| POST | `/api/admin/codex/provider/test` | One isolated native connection test using explicitly supplied inputs. |
| PUT | `/api/admin/codex/provider` | Save the endpoint, model, and a freshly entered provider key. |
| DELETE | `/api/admin/codex/provider` | Return to the original normal Codex provider/login configuration. |

Test and Save accept exactly `base_url`, `model`, and `api_key`. HTTPS is required except for literal loopback HTTP. URLs cannot contain credentials, query strings, fragments, or a `/responses` or `/chat/completions` operation suffix. The base URL, model ID, and key are bounded; invalid requests never echo supplied values.

The server saves provider credentials in a private `codex-provider` directory under its administrative state directory. A mode-0600 credential file is bound to the exact normalized endpoint and model. It is not encrypted at rest; only the server user should have access to this directory. Native config and process arguments contain the dedicated environment-variable name, never the key. Normal OpenAI/ChatGPT credentials are not copied to the custom endpoint, and Reset does not overwrite the original Codex login.

Save and Reset reject active Codex turns, goals, subagents, and side questions. They retire only the idle Codex manager, never unrelated Claude work. Cancellation cannot release admission while a credential write is still in progress. Existing native conversations are endpoint-bound: changing endpoints or models requires a new chat, or restoring that conversation's original endpoint and model. Side chats must be cleared after a provider/key change.

Test connection does not save credentials or change the active provider. It uses a separately owned Codex app-server, ephemeral auth/thread state, temporary logs/databases, a fixed minimal prompt, disabled integrations and tools, and explicit empty turn environments. The test budget is 45 seconds, followed by owned-process cleanup. Test results and errors use fixed safe messages; there are no automatic retries. Configured readiness means the local provider key is present, not that the provider accepted it; use Test connection to check access.

The isolated regression suite imports only pure modules and AST-extracted server functions. Do not import the server monolith or use production credentials to test this feature.
