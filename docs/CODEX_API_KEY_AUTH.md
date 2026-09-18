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
