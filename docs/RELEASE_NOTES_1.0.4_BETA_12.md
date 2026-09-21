# AgentsDock 1.0.4-beta.12 — draft release notes

Status: candidate; not published. Signed native-package acceptance and the public
server distribution checks must pass before these notes accompany a release.

## App and server updates together

Update AgentsDock once to request the matching server release for your saved
servers. Busy servers wait for work to finish; offline servers continue when they
reconnect. Settings shows each server's progress and offers an explicit retry
after failure. Automatic chat-title requests also finish before the server
restarts. A server's stable or beta channel is preserved.

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

## Recovery

Failed candidate health checks restore the previous server runtime. If a first
installation fails before creating state or a service, installation can retry over
its empty leftover folders. Existing installations, configuration, chat data and
registered services remain protected from the fresh installer.

Restart confirmations and errors stay visible while update information loads.

New macOS update journals retain filesystem identity across reboot, allowing an
interrupted installation to restore the previous server when the installer is
run again. Older interrupted journals without that identity record may still
need manual recovery after a filesystem remount.
