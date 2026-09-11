# AgentsDock

Desktop and mobile clients for a self-hosted
[AgentsServer](https://github.com/ZhengyiLuo/AgentsServer): persistent agent
chats, streaming activity, files and media, scheduled jobs, and remote terminals.

## Repository layout

- `electron/`: Electron desktop client (TypeScript and React), with macOS,
  Linux, and Windows packaging.
- `mobile-react/`: React Native / Expo mobile client for iOS, iPadOS, and Android.
- `Sources/`, `Apps/`, and `ZenithDock.xcodeproj`: legacy Swift client targets.
- `server/`: frozen compatibility fixtures for cross-stack tests. This is not
  the deployable server; use the standalone AgentsServer repository.
- `website/`: static product site and setup guide. `web/` contains legacy site assets.
- `docs/`: architecture, localization, and contributor notes.

The clients connect to a separately installed AgentsServer. Provider runtimes
and their authentication live on that server, not in this source repository.

## Set up the server

Use **Set up AgentsServer** in a supported direct desktop build, or follow the
standalone server's installation instructions:

```bash
git clone https://github.com/ZhengyiLuo/AgentsServer.git
cd AgentsServer
./install.sh
```

Add the resulting server address and access token in AgentsDock. Use a private
network such as Tailscale for remote access and keep credentials out of Git.
The server needs `tmux` for persistent terminal sessions. See the
[setup guide](website/setup.html) for the connection workflow.

## Develop the desktop client

Install Node.js and the pnpm version declared in `electron/package.json`, then:

```bash
git clone https://github.com/ZhengyiLuo/AgentsDock.git
cd AgentsDock/electron
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm dev
```

`pnpm build` compiles the desktop client locally. Packaging requires the
platform-specific tooling and dependencies described in
[electron/README.md](electron/README.md). Local builds do not publish a release.

## Develop the mobile client

See [mobile-react/README.md](mobile-react/README.md) for the mobile development
workflow. Native iOS builds require macOS and Xcode; Android builds require the
Android toolchain. The Swift targets are retained for legacy development and
are not the current React Native mobile client.

## Preview the website

```bash
cd website
npm run dev
```

Open `http://localhost:4175`. Screenshots and recordings are omitted from this
source snapshot pending publication review; the site includes text placeholders.

## Downloads and contribution safety

Published desktop binaries and update metadata remain in
[AgentsDock-Releases](https://github.com/ZhengyiLuo/AgentsDock-Releases/releases).
This repository's verification workflows do not publish app builds or deploy
servers. See [the release-channel notes](docs/DIRECT_RELEASES.md).

Please omit credentials, private hostnames, transcripts, user screenshots, and
machine-specific paths from contributions. Preserve existing third-party
license and attribution notices. This snapshot does not import private
development history; see [the public development log](docs/DEV_LOG.md).
