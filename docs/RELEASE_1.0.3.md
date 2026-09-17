# AgentsDock 1.0.3

Stable desktop correction to **1.0.2**.

## Side chat authorization

- Fix Side chat incorrectly reporting that an authenticated connection is not
  authorized to ask questions. Side-question requests and cancellation now use
  the native desktop transport expected by AgentsServer, without browser-style
  headers that caused the server to reject them.
- Preserve separate side-chat context, follow-up history, cancellation and
  request ownership. Do not retry questions automatically or send them as main
  chat turns. The server's authentication checks remain unchanged.

**No server update is required for this correction** if your server already
supports Side chat. This does not add Side chat support to older servers that
lack the feature.

## Visible versions

- Show the app version beside **AgentsDock** in the sidebar.
- Show the selected server's version beside its address, using existing version
  metadata. Do not introduce background update checks or polling.

## Development verification

- Add an app development operational manual and reference it from the repo's
  development rules. Require hands-on app workflows, verification across the
  real client/server boundary and explicit disclosure of mocked or untested
  boundaries before calling a feature ready.

## Downloads

- macOS builds are Developer ID signed and notarized.
- Windows installers remain unsigned and may show the usual publisher warning.
- Linux x64/arm64 packages and Stable auto-update metadata are included.
