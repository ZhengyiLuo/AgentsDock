# AgentsDock 1.0.4

Stable 1.0.4, desktop build 1193, is available through the existing stable update
channels. Existing stable 1.0.3 users keep one app-update action.

Update AgentsDock once to update the app and its matching server. Existing
stable 1.0.3 users keep their usual app-update action; after relaunch the app
migrates the managed server automatically. npm downloads happen under the hood,
without npm login, commands, or a separate server-update step. The app continues
to display its actual version in About.

The first migration waits for running work to finish and preserves the server's
identity, credentials, chats, and Team Hub data. Later releases can prepare the
server package while agents work, then activate it when idle. Offline servers
resume when they reconnect. The gateway can restart without stopping execution;
replacement of the execution runtime still waits for idle.

Failed updates retain a visible error and an explicit retry. Legacy servers
that omit update progress from their health response are checked through the
app's existing health refresh while their update is active. Opening recovery
keeps a failed update visible. After an explicit Retry, an open recovery panel
updates automatically as the server recovers, without another Check or reopening
Settings. Interrupted activation retains independent native recovery and verified
rollback.

Existing signed server downloads remain available during the transition.
Older unsupported installations and custom macOS directory layouts have
additional migration requirements; see [the upgrade guide](COORDINATED_UPDATES.md).

The macOS app is signed and notarized. Windows installers remain unsigned.
