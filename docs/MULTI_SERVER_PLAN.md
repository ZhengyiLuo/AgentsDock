# AgentsDock Multi-Server Plan

Status: initial implementation complete; automated validation passes. A
two-server soak and signed release verification remain before publication.

## Objective

Add first-class support for multiple AgentsServer installations without mixing
their chats, credentials, caches, jobs, terminals, runtime settings, or unread
state.

The selected server acts as a workspace boundary. Switching servers replaces
the chat sidebar and active workspace, but it must feel immediate by showing
that server's local cache before the network refresh completes.

## Product Decisions

1. One server workspace is active at a time.
2. The full chat sidebar is not merged across servers.
3. A permanent server selector sits above the chat sidebar.
4. Cmd-P may search cached chats across all servers and switch automatically.
5. Notifications carry both profile ID and session ID and switch before opening.
6. Only the active server is continuously polled in the first release.
7. Inactive servers show their last cached status and unread count.
8. Folders, ordering, archived state, selected chat, drafts, and timeline position
   remain independent per server.
9. A future All Servers inbox may show only pinned and unread chats. It is not
   part of the initial implementation.
10. Cross-server digest delivery is deferred. Existing digest actions remain
    scoped to the active server.

## Why Not Merge Every Chat

A merged sidebar creates ambiguous folder ownership, duplicate conversations
after server migrations, session ID collisions, runtime/model confusion, and a
real risk of sending work to the wrong machine. It would also require polling
and indexing every server continuously. Isolated workspaces preserve correctness
while global search and notifications remove most switching friction.

## Existing Architecture

The Electron app currently assumes one server in these areas:

- `electron/src/main/settings.ts`: one URL, token, and server identity.
- `electron/src/main/service.ts`: one client, one poller, one stream, and one
  mutable server ID.
- `electron/src/main/ipc.ts`: only get/apply settings operations.
- `electron/src/shared/types.ts`: public settings describe one server.
- `electron/src/shared/ipc.ts`: no profile management or switching API.
- `electron/src/renderer/src/store/app-store.ts`: renderer state and several
  module-level maps assume one current server.
- `electron/src/renderer/src/components/Sidebar.tsx`: no server selector.
- `electron/src/renderer/src/components/Dialogs.tsx`: settings edit one endpoint.

The local SQLite cache already scopes most durable records by `server_id`. That
is the foundation to preserve. The dangerous area is volatile renderer and
main-process state, especially late async responses during rapid switching.

## Profile Model

Use a stable local profile ID that is separate from both endpoint URL and the
server-provided canonical identity.

```ts
interface StoredSettingsV2 {
  schemaVersion: 2
  activeProfileId: string
  profiles: StoredServerProfile[]
}

interface StoredServerProfile {
  id: string
  name: string
  serverUrl: string
  serverIdentity?: string | null
  encryptedAccessToken?: string
  keychainAccessToken?: boolean
  serverSetupComplete: boolean
  createdAt: string
  updatedAt: string
}

interface PublicServerProfile {
  id: string
  name: string
  serverUrl: string
  serverIdentity?: string | null
  hasAccessToken: boolean
  serverSetupComplete: boolean
  connectionState: "online" | "connecting" | "retrying" | "offline" | "cached"
  cachedUnreadCount: number
}
```

Identity meanings:

- `profile.id`: stable local UI and credential identity.
- `serverUrl`: editable connection endpoint.
- `serverIdentity`: canonical identity returned by AgentsServer health.
- Cache namespace: canonical server identity when known, otherwise
  `profile:<profile.id>`.

If a newly added URL resolves to an identity already owned by another profile,
offer to update/merge that profile rather than creating a duplicate workspace.

## Credential Storage

- Keep tokens out of renderer payloads.
- Use one Keychain account per profile, such as
  `agent-access-token:<profile-id>`.
- Preserve the existing service name unless a deliberate migration is needed.
- MAS/safeStorage builds store the encrypted token in the corresponding profile.
- Deleting a profile deletes only that profile's credential.
- Updating a URL must not silently discard its token.

## Settings Migration

On first launch with the old single-server schema:

1. Generate a profile UUID.
2. Move the existing URL, identity, setup state, and encrypted token into it.
3. Migrate the fixed Keychain account to the profile-specific account.
4. Name the profile from the known server identity or endpoint host.
5. Set it as `activeProfileId`.
6. Write schema v2 atomically.
7. Keep a rollback-safe backup until the new settings file is validated.

Migration must be idempotent and covered by tests for Keychain and safeStorage
variants.

## Main-Process Switching Lifecycle

Add a monotonically increasing `connectionGeneration`. Every network operation,
stream callback, timer, and async refresh captures its generation. Results are
applied only when their generation still matches.

Switching profile A to profile B:

1. Increment `connectionGeneration` immediately.
2. Persist B as the active profile.
3. Stop A's timeline stream and release its lease.
4. Close A's terminal connections and terminal leases.
5. Cancel or invalidate A's polling, search backfill, pending event flush, file
   refresh, runtime refresh, and subagent projection work.
6. Reset service-local selected session and indexes.
7. Configure the HTTP client with B's URL and token.
8. Load B's cached sessions, jobs, runtime catalog, unread metadata, and selected
   session using B's cache namespace.
9. Return one cached bootstrap payload to the renderer immediately.
10. Health-check B in the background.
11. Reconcile its canonical server identity and merge fallback cache namespace
    data if this is its first successful connection.
12. Refresh the newest session metadata, selected timeline tail, jobs, queued
    turns, and runtime catalog.
13. Apply only results carrying B's current generation.

Do not reload the BrowserWindow during switching. Cached offline workspaces must
remain browsable when health checks fail.

## Renderer Switching Lifecycle

Renderer state needs a `profileGeneration` or the main-process generation in
every profile switch result.

On switch:

1. Flush the active draft before leaving.
2. Cancel active search and older-page requests.
3. Increment the renderer selection epoch.
4. Clear module-level in-flight maps and pending live-event buffers.
5. Apply B's cached bootstrap in one Zustand transaction.
6. Restore B's selected chat, draft, timeline anchor, sidebar scroll, and folder
   collapse state.
7. Render the cached sidebar immediately with a Connecting or Offline indicator.
8. Merge remote changes incrementally without reordering the sidebar unless the
   server metadata explicitly changed.

Any in-memory map currently keyed only by session ID must either be cleared on
switch or keyed by `profileId:sessionId`. This includes snapshot memory, pending
events, older-page loads, prefetches, selection epochs, and session patches.

## IPC Surface

Replace the single settings apply flow with explicit profile operations:

```ts
servers.list()
servers.getActive()
servers.add(input)
servers.update(profileId, patch)
servers.remove(profileId)
servers.reorder(profileIds)
servers.switch(profileId)
servers.testConnection(input)
```

`servers.switch()` returns the target profile's cached bootstrap payload and
starts its remote refresh. Profile mutation results expose no token values.

Keep compatibility wrappers temporarily so the setup installer and older UI
paths can migrate incrementally.

## UI Design

### Sidebar Selector

Place a compact server selector below or beside the AgentsDock title:

- connection-status dot
- profile display name
- optional host subtitle when useful
- chevron opening the profile popover

The popover contains saved profiles in user-defined order, each with cached
unread count and last-known connection state, followed by Add Server and Manage
Servers actions.

Switching is one click. Keep the old sidebar visible only until the cached target
bootstrap arrives, then replace it as one transaction. Do not animate individual
chat rows between server workspaces.

### Server Management

The Settings window gets a Servers section supporting:

- add through manual endpoint or existing setup installer
- rename
- edit URL and token
- test connection
- reorder
- set active
- remove with confirmation
- inspect identity, app/server version, and last connection error

Removing a profile should preserve its local cache by default. Destructive cache
deletion can be a separate advanced action later.

### Global Navigation

Cmd-P ranks current-server title matches first, then current-server cached
content, then other-server cached title/content results. A result from another
server displays its profile name and switches profiles before opening the chat.

Notification payloads must include `profileId`, `serverIdentity`, and `sessionId`.
Clicking a notification activates the existing window, switches profiles, then
opens the requested chat. It must never create another app window.

## Background Activity

Initial release:

- Poll and stream only the active server.
- Keep last-known unread counts for inactive profiles.
- Refresh an inactive profile only when selected or opened through a
  notification/search result.

Possible follow-up:

- Lightweight metadata-only polling for inactive servers with a strict interval
  and concurrency budget.
- All Servers inbox for unread and pinned chats.

## Failure Behavior

- Offline target: show cached sidebar and Offline state, with reconnect action.
- Bad token: keep cache visible and show Authentication Required for that profile.
- Missing Codex/Claude: show profile-local server diagnostics, not a global error.
- Server identity changed: require confirmation before binding old cache to the
  new identity.
- Duplicate canonical identity: offer merge/update and prevent duplicate profile
  histories.
- Rapid A -> B -> A switching: only the final generation may update the UI.
- Profile removed while inactive: remove credentials and selector entry without
  touching the active workspace.
- Active profile removal: require selecting a replacement first.

## Tests

Add regression coverage for:

1. V1 single-server settings migrate without losing credentials.
2. Two profiles with the same session ID never share events or drafts.
3. Late A responses cannot mutate B after switching.
4. Rapid A -> B -> A switching settles on the final A state.
5. Streams, terminals, timers, and polling are torn down on switch.
6. An offline profile opens its cache immediately.
7. Duplicate URLs and duplicate canonical identities reconcile correctly.
8. Search results switch to the correct profile before selecting a chat.
9. Notifications route to the correct profile and existing app window.
10. Removing a profile removes only its credential.
11. Sidebar order and selected chat are restored independently per profile.
12. Archived chats remain unloaded except for name metadata.
13. Switching does not trigger a full-window loading flyby or row animation.
14. Ten rapid switches do not leak requests, listeners, or terminal sessions.

## Implementation Stages

### Stage 1: Model and Migration

- Add profile types and schema v2.
- Add per-profile Keychain handling.
- Implement migration and tests.
- Do not change visible UI yet.

### Stage 2: Service Isolation

- Add profile CRUD IPC.
- Add connection generation guards.
- Implement teardown and cached bootstrap switching.
- Verify two test endpoints without renderer changes.

### Stage 3: Renderer State

- Add active profile state.
- Make all volatile maps profile-safe.
- Restore per-profile drafts, selections, and scroll anchors.
- Add stale-response regression tests.

### Stage 4: UI

- Add sidebar selector and profile popover.
- Replace single-server settings with server management.
- Update first-run setup to create profiles.
- Add cross-profile Cmd-P and notification routing.

### Stage 5: Verification and Release

- Run Electron tests, typecheck, lint, and package checks.
- Test with two real servers, including one offline server.
- Soak rapid switching while a chat, job, terminal, and media refresh are active.
- Rebuild the packaged `AgentsDock.app` from the repository root.
- Verify the packaged build on a secondary Mac when available.
- Commit in reviewable stages.
- Cut TestFlight/release only after the two-server soak passes.
- If server code changes, publish the matching AgentsServer revision with the app.

## Acceptance Criteria

- Switching servers shows the target cached sidebar in under 150 ms on a warm
  cache and never reloads the BrowserWindow.
- No chat, draft, event, unread marker, job, file, terminal, or runtime setting
  appears under the wrong server.
- Offline profiles remain browsable.
- Same-server URL aliases do not create duplicate workspaces.
- Current profile state survives restart.
- Cmd-P and notifications can cross profiles safely.
- Repeated rapid switching does not increase listener, timer, or connection
  counts.
- Existing single-server users migrate without setup prompts or token loss.

## Maintenance Starting Point

Before changing the implementation, inspect these files together:

- `electron/src/main/settings.ts`
- `electron/src/main/service.ts`
- `electron/src/main/ipc.ts`
- `electron/src/shared/types.ts`
- `electron/src/shared/ipc.ts`
- `electron/src/renderer/src/store/app-store.ts`
- `electron/src/renderer/src/components/Sidebar.tsx`
- `electron/src/renderer/src/components/Dialogs.tsx`

Preserve profile-aware credentials, cache namespaces, and generation-guarded
switching when changing the server selector or workspace lifecycle.
