# Native Codex API key authentication

The desktop Codex settings can read the selected server's native Codex account
and submit an API key to Codex's own credential store. Both routes require the
exact native operator token header and reject browser origin, cookies, fetch
metadata and preflight requests. Provider helpers and shared-chat guests cannot
use these controls. The `codex_auth_v1` health capability advertises support.

- `GET /api/admin/codex/auth` calls native `account/read` with
  `refreshToken: false` and returns only `available`, `auth_mode`, `email`,
  `plan_type` and `requires_openai_auth`. Email and plan apply only to ChatGPT
  accounts. Responses are not cached.
- `POST /api/admin/codex/auth/api-key` accepts only `{"api_key":"..."}` in a
  bounded JSON body. Keys contain 1–4096 printable ASCII characters without
  whitespace; the request limit is 8192 bytes. It sends exactly one native
  `account/login/start` request with `type: "apiKey"`. Success reports native
  credential acceptance, not a successful model request or billing check.

Changing authentication returns 409 while Codex work is active or queued,
including native controls, subagents, active goals and Side chat requests. The
existing admission barrier prevents new Codex turns and Side requests until
the operation finishes. No server or provider restart is requested. A stalled
account request never retires the shared provider transport.

AgentsServer does not write credentials to its own configuration, chat events,
history, logs or command arguments. Provider errors are replaced with fixed
messages, authentication notifications are excluded from chat subscribers, and native
stderr capture is disabled after a credential submission to exclude delayed
diagnostics. Native Codex controls its own credential persistence.

An ambiguous failure is never retried automatically. Refresh authentication
status before submitting again. Exec-only Codex transport is unsupported.
These controls do not perform ChatGPT browser login, logout, or a direct model
API request.

`test_codex_auth_isolated.py` exercises the real router and extracted native
authorization/admission functions with synthetic state and transport. It never
imports the server runtime, accesses a real credential store or calls a model.
