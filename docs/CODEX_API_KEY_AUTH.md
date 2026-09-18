# Codex API-key sign-in

Open **Settings → Codex account → Use API key** on the selected server.
Enter the key in the masked field and choose **Sign in with API key**.
This requires the matching AgentsServer authentication endpoints and an
authenticated native administrator connection. Older servers show an update
message rather than attempting a terminal command or another login route.

The app still runs the installed `codex app-server`, including its tools,
sessions and native context management. It does not make direct model API
requests or implement a separate agent loop. OpenAI documents this native
[`account/login/start` API-key flow](https://learn.chatgpt.com/docs/app-server#auth-endpoints).

## Scope and storage

- This changes the Codex account for the server user, not for one chat.
  Active and queued Codex work must finish first; sign-in never stops a run.
- The key goes to the selected server over its existing authenticated
  connection. Use HTTPS or a trusted encrypted network for a remote server.
- Codex owns credential storage. AgentsDock does not save the key in its
  settings, cache, chat history or logs. Closing the form, changing servers,
  cancelling or submitting clears the password field.
- API usage is billed separately from a ChatGPT subscription. Saving a key is
  not proof that the account has credit or access to a particular model.
- Existing ChatGPT authentication is unchanged until a key is submitted.
  To return to ChatGPT sign-in, use the normal `codex login` flow as the server
  user, then choose Recheck. This feature does not add a second OAuth flow.

## Requests and failures

Account state is fetched when the settings control opens and when Recheck is
chosen. There is no polling, per-keystroke network activity or automatic login
retry. A successful save triggers one runtime-catalog refresh so an old
unauthenticated status does not keep blocking the composer.

The renderer's profile ID and generation are checked before sending a key.
Late responses cannot be attributed to a newly selected server. The native
HTTP transport rejects redirects, and errors are mapped to fixed messages
before they cross IPC, so a provider error cannot echo a submitted key.

If a request disconnects after submission, choose Recheck before trying again:
the native runtime may already have saved the credential.

## Custom endpoints

The expanded account form also provides **Custom endpoint** with an API base
URL, exact model ID and masked provider key. This still uses the installed Codex
runtime, with its native custom Responses provider configuration. A provider
that only supports Chat Completions is not automatically compatible.

1. Enter the provider's API base URL, not its website/model-catalog URL or an
   individual `/responses` or `/chat/completions` operation URL.
2. Enter its exact model ID and a fresh key for that endpoint.
3. Choose **Test connection**. This runs one small, isolated native Codex request
   and may incur provider usage. It does not save settings or change live chats.
4. After a successful test, choose **Save endpoint** while Codex work is idle.
   Editing any field invalidates the previous result. There is no automatic
   test, retry, polling or credential submission while typing.

Custom credentials are separate from the normal Codex account. The server
keeps them in endpoint-bound, owner-only credential storage and passes them to
its owned Codex process; the app never reads back the key. HTTPS is required
except for local loopback endpoints. The normal ChatGPT/OpenAI login is not
forwarded to the custom provider.

The selected endpoint is for new Codex chats. A thread bound to a different
provider cannot silently send its history to the newly selected endpoint.
Choose **Use Codex default** to remove the override and use the original
Codex configuration and account again. Existing work is never stopped by Save
or reset.

Connection failures are reported separately from saving a key. A successful
test establishes a small native response for that model and endpoint, not
every tool, model or billing capability. Provider error bodies are not shown,
because they can contain credentials. These controls require the matching
AgentsServer provider endpoints.
