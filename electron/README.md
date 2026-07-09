# AgentsDock Electron

This directory contains the macOS Electron client that is being developed as a
feature-compatible replacement for the Swift macOS frontend. The Swift macOS,
iOS, and iPadOS applications remain in the repository and are not overwritten
by the Electron development build.

## Local build

From the repository root:

```bash
./scripts/build_electron_mac.sh
```

The script runs TypeScript checks, the regression suite, the production Vite
build, and an unsigned local Electron package. It installs the result at:

```text
dist/AgentsDock-Electron.app
```

It never replaces `dist/AgentsDock.app`, which is the Swift development app.

## Development

The project uses the Node runtime bundled with Codex when it is available. A
normal Node 22+ and pnpm installation also works.

```bash
cd electron
pnpm install --frozen-lockfile
pnpm dev
```

Logs are written to:

```text
~/Library/Application Support/agentsdock-electron/logs/agentsdock.log
```

The access token is stored as a generic macOS Keychain password under the
`com.zhengyiluo.AgentsDock` service. Packaged startup never decrypts legacy
Electron `safeStorage` data synchronously; that can block before a window exists
when an ad-hoc signing identity changes.

The app uses a local SQLite cache at the same application-support location.
Server identity scopes sessions, preferences, timeline rows, read state, jobs,
files, and pins so aliases for one server share data without contaminating a
different server.

## Architecture

- `src/main`: server client, SQLite cache, downloads, native integration, IPC
- `src/preload`: context-isolated, typed renderer bridge
- `src/renderer`: React UI, Zustand state, virtualized timeline
- `src/shared`: API types, IPC contract, URL and queue reducers

The renderer is cache-first. It opens the cached tail immediately, subscribes
to live events, and performs an `after=<last cached seq>` reconciliation in the
background. Incoming events are coalesced to one renderer publish per animation
frame. Timeline rows are virtualized with stable semantic keys.

See [FEATURE_PARITY.md](FEATURE_PARITY.md) for the implementation contract and
verification status.
