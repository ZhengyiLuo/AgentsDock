# ZenithDock

Native macOS, iOS, and iPadOS frontend for a remote ZenithDock agent server.

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
the matching app/framework signing identities.

## Build The iOS/iPadOS App

The mobile SwiftUI target is `ZenithDockIOS` and reuses `ZenithCore`.

```bash
swift build -c release --target ZenithDockIOS
xcodebuild -scheme ZenithDockIOS -destination 'generic/platform=iOS' build
xcodebuild -scheme ZenithDockIOS -destination 'platform=iOS Simulator,name=iPhone 17' build
```

## Archive For TestFlight

The iOS scheme builds one TestFlight binary for both iPhone and iPad:

```bash
xcodebuild archive \
  -project ZenithDock.xcodeproj \
  -scheme ZenithDockIOS \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath build/ZenithDockIOS.xcarchive
```

The macOS scheme builds the Mac TestFlight binary:

```bash
xcodebuild archive \
  -project ZenithDock.xcodeproj \
  -scheme ZenithDockMac \
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
