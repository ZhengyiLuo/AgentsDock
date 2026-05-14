# ZenithDock

Native macOS frontend for Zenithbot running on `zen-nv`.

## Run The Server On Zen-nv

The local source of truth is:

```bash
/Users/zen/agi/ZenithDock/server/agent_server.py
```

Deploy it to Zen-nv:

```bash
cd /Users/zen/agi/ZenithDock
./server/deploy_nv.sh
```

The deployed runtime copy lives at `/home/zen/Zenithbot/scripts/agent_server.py`.

```bash
cd /home/zen/Zenithbot
/home/zen/anaconda3/bin/python3 scripts/agent_server.py serve --bind 0.0.0.0 --port 7850
```

Optional user service:

```bash
mkdir -p ~/.config/systemd/user
cp /home/zen/Zenithbot/systemd/zenithbot-agent.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now zenithbot-agent.service
```

## Run The Mac App

```bash
cd /Users/zen/agi/ZenithDock
swift run
```

Default server URL is `http://10.112.215.37:7850`; edit it in the toolbar if needed.

## Build The iOS/iPadOS App

The mobile SwiftUI target is `ZenithDockIOS` and reuses `ZenithCore`.

```bash
cd /Users/zen/agi/ZenithDock
swift build -c release --target ZenithDockIOS
xcodebuild -scheme ZenithDockIOS -destination 'generic/platform=iOS' build
xcodebuild -scheme ZenithDockIOS -destination 'platform=iOS Simulator,name=iPhone 17' build
```

Open `Package.swift` in Xcode and select the `ZenithDockIOS` scheme for mobile
iteration. The default server URL is the same Zen-nv endpoint:
`http://10.112.215.37:7850`.

## Current V1

- Multiple chats grouped by folder
- Claude/Codex backend switch per chat
- Fork chat action
- Prompt streaming via WebSocket event timeline
- File upload to Zen-nv
- Artifact/video/image preview from returned manifests
- Interval/loop job creation panel

## iOS Architecture Note

The package has a platform-neutral `ZenithCore` library target with:

- API client
- session/job/file/event models
- WebSocket URL construction
- multipart file upload

The macOS app target is only the desktop UI. The iOS/iPadOS target imports
`ZenithCore` and has its own mobile state/view layer around the same Zen-nv
server API.
