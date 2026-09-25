# Codex account and custom endpoints

Open **Settings → Server → Codex account**. Normal Codex account status is
read-only. **Recheck** refreshes the displayed status. Manage normal ChatGPT
or OpenAI authentication with Codex on the server.

Starting with **1.0.4-beta.2**, AgentsDock no longer offers shared API-key
sign-in. AgentsServer also rejects the legacy login route from older clients.
Entering a provider key must not replace the credentials used by ordinary
Codex chats or the Codex CLI.

## Configure an endpoint

1. Choose **Custom endpoint**.
2. Enter the provider's API base URL, exact model ID and a fresh API key.
   Use the API base URL, not its website or an individual `/responses` or
   `/chat/completions` operation URL.
3. Choose **Test connection**. This makes one small request through native
   Codex and may incur provider usage. It does not save the configuration.
4. After a successful test, choose **Save endpoint** while Codex work is idle.
5. Create a chat and select **Codex · Custom endpoint** in its provider picker.
   Saving endpoint settings does not switch an ordinary Codex chat.

The endpoint must support the Responses protocol required by native Codex.
Chat Completions compatibility alone is insufficient. Editing a field invalidates
its previous connection test. Testing and saving remain available even when
normal Codex account status cannot be read, provided the server authorizes
endpoint configuration.

Custom provider keys are stored separately in private files on the selected
server and are bound to the configured URL and model. The app never reads back
a saved key. HTTPS is required except for local loopback endpoints. Normal
Codex credentials are not used to authenticate to the custom provider.

A started chat retains its provider and endpoint binding. Choose **Remove
custom endpoint** to delete the separate configuration; affected custom chats
need their original configuration restored before they can continue. Normal
Codex authentication is unchanged. Active work is not interrupted by Save or
Remove.

## Requests and recovery

The app checks request ownership against the selected server. Closing the
form, changing servers, cancelling or saving clears its key field. There is
no request on each keystroke, idle polling or automatic login retry. Provider
errors are mapped to fixed messages so they cannot echo credentials.

A successful connection test verifies a small native response with the entered
endpoint and model; it does not establish every tool or billing capability.

If shared credentials were replaced with 1.0.4-beta.1, restore authentication
through Codex's normal sign-in flow. Restoring a credential file may leave an
existing native process with its previous in-memory account. Recreate that
process after active work finishes, for example through the managed when-idle
server update. The fixed beta prevents another overwrite; it cannot reconstruct
credentials that were already replaced.
