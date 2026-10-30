# AgentsDock Electron

This directory contains the cross-platform AgentsDock desktop client for
macOS, Linux, and Windows. The Swift macOS, iOS, and iPadOS applications remain
in the repository and are not overwritten by the Electron development build.

## Shared-chat analytics bundles

The shared browser keeps generic desktop analytics disabled. Three narrowly
scoped browser events are documented in `docs/ANALYTICS_EVENTS.md`. Regenerate
both served artifacts after changing the shared tracker/bridge (from repo root):

```bash
cd electron
pnpm exec vite build --config vite.shared-chat.config.ts
pnpm exec vite build --config vite.share-analytics.config.ts
cd ..
node scripts/package_shared_chat_web.mjs electron/out/shared-chat server/interactive_chat_share_web.py
node scripts/package_shared_chat_analytics.mjs electron/out/share-analytics/snapshot-analytics.js server/shared_chat_analytics_web.py
```

These generate source artifacts only; server deployment requires separate
authorization. Read-only pages authorize only the exact bundled script hash.
## Gemini

Gemini is a built-in desktop/server provider; no development flag is required.
Install `@google/gemini-cli@0.64.0` on the server machine and configure its API in
**Settings → My Agents → Gemini**. Google/CLI login is not offered. A matching
server must advertise Gemini support; the card's presence does not mean the CLI
or API is ready. Mobile support is separate. See
[setup, supported features and validation](../server/docs/GEMINI_PROVIDER_PREVIEW.md).

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
Direct macOS builds also use the bounded Keychain helper when manually adding
servers or replacing tokens. A failed write leaves the existing connection
intact and reports an error; it never falls back to synchronous OSCrypt or
plaintext. Sandboxed Mac App Store and other-platform storage is unchanged.

The app uses a local SQLite cache at the same application-support location.
Server identity scopes sessions, preferences, timeline rows, read state, jobs,
files, and pins so aliases for one server share data without contaminating a
different server.

New chat opens the composer directly, including the first chat on a server.
It inherits the last-opened chat's agent/connection, model, thinking, permissions,
workspace, folder, custom instructions and supported subagent limit. Without
previous settings it prefers an available agent; discovery still loading does
not reopen the old setup dialog. Before the first message, use the composer's
Agent picker to switch agents or open My Agents. Credentials, native session
identity, goals and delegated/job authorization are not copied.

Settings → Server starts with collapsed cards showing each saved server's name,
URL and connection status. Add server is above the cards. Expand a card for
separate version and identity rows. A token field shows its first four characters
with the remainder masked, and Copy at the end copies the complete credential.
Short tokens stay fully masked. The token field is grouped separately from
Use/Edit and the red Remove action. **Show QR code** locally renders the selected
saved connection for another device, including servers hosted on other machines.
It does not require local server installation. Updated servers supply their own
LAN/Tailscale candidates through authenticated native address discovery; the QR
then lets mobile choose a reachable address and retain alternatives. Older or
offline servers fall back to the saved single address. Sharing does not switch
the active server. The active card also contains restart controls.
Persistent goals have no server-wide Settings toggle. Updated servers keep the
capability available by default; each chat retains its own goal controls.
With a matching server, Claude goals can be set or replaced during current
work. The app shows the pending request until Claude applies it at its next
native boundary; setting a goal does not interrupt the current tool or agents.
Native refusals remain visible and leave the completion condition available
for retry.
The camera-enabled mobile app can scan it from **Servers > Add Server > Scan QR
code** and authenticates before saving. Older mobile builds need an app update.
The image does not make a loopback-only server reachable from a phone. See
[`SERVER_CONNECTION_SHARING.md`](../docs/SERVER_CONNECTION_SHARING.md) for the
format and remaining acceptance checks.

<a id="opencode-optional-beta-backend"></a>

## OpenCode

OpenCode is available in desktop stable 1.0.9 with AgentsServer 1.0.9 and appears
in the chat backend picker. The server must advertise the OpenCode v1 contract;
an older server shows an upgrade requirement and cannot silently switch the
chat to another backend.
Install the server-supported OpenCode CLI and configure its provider on the
server host. Settings → My Agents → OpenCode reports readiness and setup
guidance and supports custom API connections. OpenCode is optional and does not
block other providers when it is absent. This availability applies to desktop;
mobile provider support depends on its separately released client.

Choose a server-advertised model, or leave the model empty to use OpenCode's
native default. Existing AgentsDock chats resume their native OpenCode session
on subsequent turns. Uploaded attachments use the normal native file flow.
The Skills menu requires the separate server OpenCode provider-command
capability; selected skills retain their opaque server-owned identifiers.

Permissions apply to future turns: **OpenCode settings** preserves native
policy, which may allow shell commands; **Full access** allows tools and
commands automatically; **Plan only** applies a read-only tool policy, not an
operating-system sandbox. Changing the permission mode or working directory
resets native OpenCode context while retaining the visible AgentsDock timeline.

OpenCode supports explicitly authorized cross-chat routes through the run-bound
AgentsDock tool on matching servers, including tool-capable custom API models.
The 1.0.9 release does not provide external history import, native session forks,
side chats, live steering, or native goals for OpenCode.
Ordinary queued follow-ups and Stop remain available. A copied-memory fork
is not presented as a native clone.

## Architecture

- `src/main`: server client, SQLite cache, downloads, native integration, IPC
- `src/preload`: context-isolated, typed renderer bridge
- `src/renderer`: React UI, Zustand state, virtualized timeline
- `src/shared`: API types, IPC contract, URL and queue reducers

Renderer visual changes follow the token and component guidance in
[DESIGN_SYSTEM.md](DESIGN_SYSTEM.md).
All feature work and bug fixes also follow the hands-on acceptance requirements
in [APP_DEV_OPERATIONS.md](../docs/APP_DEV_OPERATIONS.md). Mocked checks alone
do not establish that a feature works through the real app/server connection.

The renderer is cache-first. It opens the cached tail immediately, requests the
latest bounded semantic page, then subscribes to events after that page's
boundary. Reopening a stale cache does not replay the entire offline gap;
older history loads on upward navigation. Failed refreshes retain the cache.
Incoming events are coalesced to one renderer publish per animation frame.
Timeline rows are virtualized with stable semantic keys.

Settings → General has three sidebar switches, remembered locally per server:
**Unread chats at the top** (on), **Include cron jobs in Unread** (off), and
**Show Running section** (on). Turning a section off leaves its chats in their
saved folders or pins, with unread and activity indicators intact. Active chats
never move into Unread while Running is hidden. Cron-only unread output stays
in its folder by default; an unread ordinary reply still promotes the chat even
if a later cron result arrives. Explicit **Mark unread** also promotes it.
Cron attribution requires the matching server change; older servers or pending
history recovery retain ordinary unread grouping until provenance is known.

Chats appear only once; their saved folder and pinned state are unchanged.
Reading a completed chat returns it to its ordinary section, and empty status
groups disappear. Groups and folders use
right-aligned collapse arrows. Status collapse state lasts within the current
workspace, and next/previous-chat shortcuts follow the visible group order.
Pinned also collapses, remembers its state per server across reopening, and
stays independent of real folders with the same name.
Status groups are not folder drop targets; dragging a chat out can still assign
it to a real folder.

Every selected chat also owns a lightweight workspace surface rooted at its
server-side `cwd`. The right-hand Details panel has a **Files** tab for browsing
that directory and opening files in the existing workspace editor. It replaces
the editor's separate Explorer pane and retains new file/folder, refresh and
right-click actions (open beside, copy path, download, rename and delete), with
the existing unsaved-edit and revision checks. Folders load on expansion or
when revealing the active file; large folders have an explicit Load more button.
Changing chat, server or working directory clears the old tree. Symlinks retain
the server's existing access restriction. The last Details/Files selection is
remembered across panel and app reopening; temporary Review views do not change
that preference. Opening or selecting a file tab (including attachment and
image/PDF previews) automatically opens the right panel on Files. Cancelling
the file picker does not change the panel. In split chat, Files follows the focused chat and browsing
does not cover the conversations until a file editor or dialog is needed.
Opening a file waits for saved editor tabs to restore, so the requested file
becomes selected instead of leaving the split-chat return screen visible.
TIFF attachments and workspace images use a PNG preview of the first page in
the desktop media viewer; downloading or opening the original keeps the TIFF
file unchanged. Preview decoding runs outside the app's main thread.

Chat remains the pinned default tab. Use `Cmd+O` to search
and open a UTF-8 source file, switch explicitly from read-only to edit mode,
and save with `Cmd+S`; `Shift+Cmd+O` remains the attachment picker. Syntax
support is loaded only after a file opens, clean inactive files are evicted
from memory, and revision-checked saves prevent overwriting agent changes.
Files above 512 KiB use a lightweight read-only text viewer instead of the
syntax parser so opening source never competes with the chat renderer.

The **Changes** tab reviews the selected workspace's entire Git worktree, not
only changes attributed to an agent turn. Open it to inspect staged, unstaged,
untracked and conflicted files; stage/unstage whole files; review and commit the
staged set; or resolve text conflicts before continuing an existing merge or
rebase. Abort requires confirmation. Git reads happen only on opening the tab,
explicit refresh, file selection and action reconciliation—there is no polling.
Repository revisions fence mutations against changes made by other agents or
editors. This requires matching standalone AgentsServer Git endpoints and the
native operator connection; shared-chat web guests have no Git controls.

This first cut does not create branches/merges, push, or manage PRs/MRs. Binary
conflicts and repositories requiring executable Git hooks/custom filters may
need the terminal; the app reports that rather than bypassing repository policy.

See [FEATURE_PARITY.md](FEATURE_PARITY.md) for the implementation contract and
verification status.
