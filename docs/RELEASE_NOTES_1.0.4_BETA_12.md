# AgentsDock 1.0.4-beta.12 — release notes

Published September 21, 2026, as direct desktop build 1189, with the matching
public npm package and signed legacy server bridge. Native-package acceptance
and public server distribution verification passed before desktop publication.

## App and server updates together

Update AgentsDock once to request the matching server release for your saved
servers. After the first legacy migration, servers can download and prepare
later updates while agents work, then wait for work to finish before changing
the execution runtime. The initial beta.9 migration waits for idle before its
old updater starts downloading and preparing the bridge. Offline servers
continue when they reconnect. Settings shows each server's progress and offers an explicit retry
after failure. Automatic chat-title requests also finish before the server
restarts. A server's stable or beta channel is preserved.

This release bridges existing managed installations to npm updates. Update the
app using its current update control; after relaunch, it migrates a supported
legacy server through the existing signed server updater. No separate npm login
or server reinstallation is required. The complete one-click journey was tested
from desktop beta.8 and server beta.9. Older unsupported installations and
pre-1.0 desktop feed migrations have separate prerequisites; see
[the upgrade paths](COORDINATED_UPDATES.md#how-existing-users-reach-npm-updates).

## Server installation through npm

New self-hosted installations on supported macOS and Linux systems can use:

```sh
npx @agentsdock/server@1.0.4-beta.12 install
```

The service keeps its own managed runtime, independent of the npm cache. The npm
package has no installation hooks. Existing servers continue through their managed
updater, preserving installation paths and server identity. Old signed server
downloads remain available during the transition; very old unmanaged servers may
need the guided installer once.

Older macOS servers installed in custom directories need one migration with the
original installation, configuration and state directory settings. Those releases
did not retain all three paths in their service configuration. Default-directory
installations migrate automatically; new installations retain those paths for
future updates.

## Recovery

Failed candidate health checks restore the previous server runtime. If a first
installation fails before creating state or a service, installation can retry over
its empty leftover folders. Existing installations, configuration, chat data and
registered services remain protected from the fresh installer.

Restart confirmations and errors stay visible while update information loads.

An independent recovery service is registered before stopping the server. It
can restore an interrupted update even while the app cannot connect. A verified
rollback is reported as a failed update with a retry option. Both the gateway
and execution runtime must reach the requested release and reopen admission
before Settings reports success.

New macOS update journals retain filesystem identity across reboot. Older
interrupted journals without that record may still need manual recovery after
a filesystem remount.

The gateway can restart while existing agents continue. Replacing the execution
runtime still waits for idle; this release does not run old and new execution
runtimes simultaneously.
