# AgentsDock 1.0.5

This release corrects the 1.0.4 update failure and bundles the matching server
update with the desktop app update.

- Upgrade existing server installations with legacy directory permissions and
  recover safely from a failed 1.0.4 migration. Preserve existing chats,
  credentials, identity and Team Hub data; an early failure leaves the existing
  server running and permits retry.
- Prevent an already delivered goal follow-up from being replayed after a
  server restart or chat reopening.
- Keep the error notification's close button visible when an error contains a
  long filename or path. Isolate simultaneous downloads so they cannot share or
  remove each other's temporary files.
- Remove app and server version labels from the sidebar. Retain version
  information in Settings.
- Include the merged Side chat, reasoning display and chat synchronization
  fixes. Restore native custom-endpoint retries and model effort metadata,
  preserve connected Claude parent settings for side questions, and report
  failed scheduled turns accurately.

Stable 1.0.3 and 1.0.4 app users can update directly to 1.0.5. The app handles
the matching server update; initial server migration and execution replacement
wait for idle. macOS packages are signed and notarized. Windows packages remain
unsigned.
