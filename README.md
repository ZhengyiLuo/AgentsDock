# ZenithDock

Electron macOS/Linux and native iOS/iPadOS frontends for a remote ZenithDock
agent server.

## Dev Log

Keep implementation memory in [`docs/DEV_LOG.md`](docs/DEV_LOG.md). Update it
after meaningful debugging sessions, architecture decisions, deploys, and UX
rules that we should not rediscover the hard way.

## Run The Server

The local source of truth is:

```bash
server/agent_server.py
```

Deploy it to your server:

```bash
./server/deploy.sh <ssh-host>
```

The deployed runtime copy lives under the configured remote app directory.

```bash
cd ~/Zenithbot
uv run python scripts/agent_server.py serve --bind 0.0.0.0 --port 7850
```

Optional user service:

```bash
mkdir -p ~/.config/systemd/user
cp ~/Zenithbot/systemd/zenithbot-agent.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now zenithbot-agent.service
```

Optional access token:

```bash
systemctl --user edit zenithbot-agent.service
```

```ini
[Service]
Environment=ZENITHDOCK_AGENT_TOKEN=replace-with-a-long-random-token
```

The Mac app shows `Agent access token` in the right inspector's Security
section. The iOS/iPadOS app shows `Access token` in the sidebar server card.
When the server variable is set, the same token is required for API calls,
uploads, websocket live traces, and file/video previews.

## Run The Mac App

```bash
swift run
```

Edit the server URL in the app toolbar or inspector.

To refresh the local distributable app used during development:

```bash
./scripts/build_local_mac.sh
```

This clean-copies the Xcode-built app to `dist/ZenithDock.app` and preserves
the matching app/framework signing identities. The script also tries to sync
the app directly to the MacBook Air at `/Users/zen/agi/ZenithDock.app` when
`zens-macbook-air` is reachable over SSH. Override with `ZENITHDOCK_MBA_HOST`
or `ZENITHDOCK_MBA_DEST` if needed.

### Electron macOS app

The production macOS client lives in `electron/`. Build the canonical local
app with:

```bash
./scripts/build_electron_mac.sh
```

The result is `dist/AgentsDock.app`. See
[`electron/FEATURE_PARITY.md`](electron/FEATURE_PARITY.md) for the parity and
verification contract. The local build is ad-hoc signed and does not upload a
release.

Each chat also owns an optional persistent remote terminal. Opening the
Terminal tab creates or reattaches to a tmux session on the agent server; app
disconnects detach the client without stopping shells, windows, panes, or
long-running processes. The agent host must have `tmux` installed and run an
agent server with API contract v5 or newer.

Terminal tabs expose window creation, selection, and hover-close controls.
Closing a non-final tab kills that tmux window and its panes; closing the final
tab requires confirmation because it ends the chat's persistent tmux session.

Direct downloads use `electron-updater` with public release assets hosted on
the `ZenithBotServer` GitHub Releases channel. The source repository stays
private and no GitHub credential is embedded in the app. A production release
requires a Developer ID Application certificate and notarization:

```bash
./scripts/build_electron_release.sh

# Build and publish the signed zip/dmg plus latest-mac.yml.
GH_TOKEN=... AGENTSDOCK_PUBLISH_MODE=always ./scripts/build_electron_release.sh
```

The Mac App Store/TestFlight build is a separate sandboxed target. It never
runs the direct updater because Apple owns updates for that channel. Xcode
applies cloud-managed App Store signatures, so the build does not depend on a
local Apple Distribution certificate:

```bash
# Export a locally installable App Store package.
./scripts/build_electron_mas.sh

# Upload the same build directly to TestFlight.
./scripts/build_electron_mas.sh --upload
```

### Electron Linux app

Build portable x86_64 Linux artifacts from macOS or Linux with:

```bash
./scripts/build_electron_linux.sh
```

The build runs TypeScript validation and the complete Electron regression suite
before producing both an AppImage and a tarball under `dist/linux/`. Override
the architecture with `AGENTSDOCK_LINUX_ARCH=arm64`. The AppImage is the default
distribution artifact and does not require installation.

## Build The iOS/iPadOS App

The mobile SwiftUI target is `ZenithDockIOS` and reuses `ZenithCore`.

```bash
swift build -c release --target ZenithDockIOS
xcodebuild -scheme AgentsDockIOS -destination 'generic/platform=iOS' build
xcodebuild -scheme AgentsDockIOS -destination 'platform=iOS Simulator,name=iPhone 17' build
```

## Archive For TestFlight

The iOS scheme builds one TestFlight binary for both iPhone and iPad:

```bash
xcodebuild archive \
  -project ZenithDock.xcodeproj \
  -scheme AgentsDockIOS \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath build/ZenithDockIOS.xcarchive
```

The legacy Swift macOS scheme can still build its Mac archive, but the
production desktop client is now the Electron MAS target documented above:

```bash
xcodebuild archive \
  -project ZenithDock.xcodeproj \
  -scheme AgentsDockMac \
  -configuration Release \
  -destination 'generic/platform=macOS' \
  -archivePath build/ZenithDockMac.xcarchive
```

For real TestFlight uploads, use Xcode with automatic signing enabled for both
`ZenithDockIOS` and `ZenithDockMac`, then upload the archives from Organizer.

Open `Package.swift` in Xcode and select the `ZenithDockIOS` scheme for mobile
iteration. Set the server URL from the app's server settings.

## Current V1

- Multiple chats grouped by folder
- Claude/Codex backend switch per chat
- Fork chat action
- Prompt streaming via WebSocket event timeline
- File upload to the agent server
- Artifact/video/image preview from returned manifests
- Interval/loop job creation panel

## iOS Architecture Note

The package has a platform-neutral `ZenithCore` library target with:

- API client
- session/job/file/event models
- WebSocket URL construction
- multipart file upload

The macOS app target is the desktop UI. The iOS/iPadOS target imports
`ZenithCore` and has its own mobile state/view layer around the same remote
server API. Both app targets archive from `ZenithDock.xcodeproj`.
