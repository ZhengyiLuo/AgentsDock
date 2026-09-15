# AgentsDock Electron

This directory contains the cross-platform AgentsDock desktop client for
macOS, Linux, and Windows. The Swift macOS, iOS, and iPadOS applications remain
in the repository and are not overwritten by the Electron development build.

## Local build

From the repository root:

```bash
./scripts/build_electron_mac.sh
```

The script runs TypeScript checks, the regression suite, the production Vite
build, and an ad-hoc signed local Electron package. It installs the result at:

```text
dist/AgentsDock.app
```

The local app contains an update-disable marker and cannot consume or replace a
signed production release. Direct desktop releases are built and notarized in
CI, then pass through a reviewed GitHub draft. See
[`../docs/DIRECT_RELEASES.md`](../docs/DIRECT_RELEASES.md).

On Windows 10/11 x64, use PowerShell 7 from the repository root:

```powershell
cd electron
pnpm install --frozen-lockfile
pnpm package:win
cd ..
./scripts/verify_electron_windows.ps1 dist/windows 0.2.10-beta.2 beta x64 allow-unsigned
```

The installer, blockmap, and updater metadata are written to `dist/windows`.
Local Windows packages are unsigned unless `CSC_LINK` and
`CSC_KEY_PASSWORD` point to an Authenticode certificate. Stable publication
fails closed without signing credentials unless the release owner explicitly
approves the unsigned Windows installer in both preparation and publication.
That exception must be disclosed in the release notes; macOS signing and
notarization requirements remain unchanged.

## Development

The project uses the Node runtime bundled with Codex when it is available. A
normal Node 22+ and pnpm installation also works.

```bash
cd electron
pnpm install --frozen-lockfile
pnpm dev
```

On macOS, logs are written to:

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

Renderer visual changes follow the token and component guidance in
[DESIGN_SYSTEM.md](DESIGN_SYSTEM.md).

The renderer is cache-first. It opens the cached tail immediately, subscribes
to live events, and performs an `after=<last cached seq>` reconciliation in the
background. Incoming events are coalesced to one renderer publish per animation
frame. Timeline rows are virtualized with stable semantic keys.

Every selected chat also owns a lightweight workspace surface rooted at its
server-side `cwd`. Chat remains the pinned default tab. Use `Cmd+O` to search
and open a UTF-8 source file, switch explicitly from read-only to edit mode,
and save with `Cmd+S`; `Shift+Cmd+O` remains the attachment picker. Syntax
support is loaded only after a file opens, clean inactive files are evicted
from memory, and revision-checked saves prevent overwriting agent changes.
Files above 512 KiB use a lightweight read-only text viewer instead of the
syntax parser so opening source never competes with the chat renderer.

See [FEATURE_PARITY.md](FEATURE_PARITY.md) for the implementation contract and
verification status.
