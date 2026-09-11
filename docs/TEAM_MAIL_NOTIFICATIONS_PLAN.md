# Team Mail notifications — prerequisites implemented, transport pending

This is not an enabled event lane. Local prerequisites now include the Hub's
durable recipient cursor/coalescing broker and the desktop's pure metadata
parser/state reducer. Reply and Mark Unread remain independent. No notification
delivery, packaged acceptance, deployment, or completed notification journey is
claimed. Keep the new transport disabled until its complete path is verified.

## Implemented prerequisites (September 10)

- Server `mail_hints.py`, migration 0020, and store-only cursor/coverage methods:
  one recipient existence watermark, exact immutable arrival anchor, commit-only
  publication, bounded one-cursor subscriptions, and recipient-only wakeups.
  No callbacks/socket work under the write transaction, and no polling.
- Desktop `shared/team-mail-hints.ts`: strict body-free metadata, exact
  profile/generation/stream/server/Hub/team/recipient fences, bounded scalar
  state, and fresh-page-only seen advancement. Repeated reconnects retain
  unreviewed arrivals. A restored cursor cannot clear newer/uncovered mail;
  hints, snapshots, and page coverage reject contradictory arrival identities.
  Pure-state tests cover delayed bootstrap, capped/stale pages, reset/replay,
  repeated reconnects, and no timer/network effects. Nothing imports this module
  into a running listener or UI yet.
- Snapshots validate the client's retained sequence **and immutable message ID**
  against its exact recipient copy. A restore can reuse or overtake an old
  sequence, so comparing only maxima is insufficient. This avoids changing the
  backup/restore lifecycle. Nonzero page coverage requires a matching predecessor
  ID; omitted/stale proof cannot acknowledge a prefix.

The broker is process-local to one HubStore. Source review confirmed that the
supported managed host retains one `app.state.store` and passes that exact object
to its secure-peer adapter and local provider helpers. Managed/standalone serve
entry points hold the runtime lease; provider helper subprocesses call back into
AgentsServer rather than opening a second Hub database. Legacy network mailbox
items use different tables and are not Team Messages arrivals. Arbitrary direct
HubStore embedding still must not introduce an unshared writer or broker.

The secure stream must have its
own admission/teardown accounting instead of retaining the gateway's 32 HTTP
workers, per-source slots, adapter's four peer requests, or runtime in-flight
leases. It must also avoid `ManagedTeamHubHost._in_flight`: mounting a lifetime
websocket under the ordinary Hub request drain would block maintenance. Store
tests and a pure reducer are not evidence that this path exists.

## What exists

- Hub `store.py` commits `team.message.created` to `outbox_events` with the mail.
  There is no outbox dispatcher or Team Mail subscription. The outbox IDs are
  not a ready-made ordered recipient cursor.
- `SecurePeerRuntime.maintenance_once()` renews credentials and heartbeats the
  active peer every 30 seconds. The secure gateway/client use bounded HTTP
  request/response and close connections; there is no mail push stream.
- AgentsServer has bounded websocket fanout for chat sessions and emergency
  alerts. Chat sockets depend on visible sessions and cannot deliver global
  Mail hints reliably. Emergency alerts demonstrate the right singleton
  lifetime, but their protocol is not a general-purpose Team channel.
- Desktop `server-client.ts` / `service.ts` own the emergency stream. Generic
  `AppEventMap` broadcast and preload `events.on` already exist; one listener
  can live in app-store initialization. TeamNetwork's current unread count is
  only a snapshot of loaded Inbox rows. Sidebar remains mounted when Mail is
  closed and is the appropriate place for a quiet new-mail dot.

## Smallest complete path to implement later

`committed mail → recipient hint broker → Host local websocket`

`committed mail → recipient hint broker → authenticated peer stream → Member
runtime → Member local websocket → desktop singleton → badge`

Add only a negotiated, recipient-scoped metadata lane. A generic event bus,
outbox drain loop, inbox poll, or agent execution route is unnecessary. The
cross-server stream is genuinely missing and needs its own bounded protocol
and tests; it cannot be obtained by registering another desktop listener.
Reusing the heartbeat to query for mail would still be polling.

After the transaction commits, notify a coalescing broker with the exact server
recipients and message sequence. Cover every creation path at the store
boundary, including local helpers and secure peers. Never emit on rollback or
again for an idempotent replay. Notification failure must not fail committed
mail; reconnect recovers from durable state. Do not perform socket I/O under
the database write lock. Ordinary server Inbox copies only: no Bulletin,
skills, human-mailbox expansion, or wake-up of an agent.

Each stream has one replaceable pending watermark, not one queued task per
message. Subscribe before reading the initial authoritative watermark, then
merge raced updates by maximum sequence. Use one serial writer per stream and
bounded packet sizes, connection admission, and send timeouts. A future peer
stream must not consume all 32 current gateway HTTP worker slots; reserve
control capacity and close streams on shutdown, revocation, or role changes.

## Cursor, reconnect, and acknowledgment rules

- Use the existing `message.sequence` domain. The server snapshot is the last
  committed arrival for the exact mailbox, not an unread count. Prefer a small
  durable per-recipient high-water projection updated with mail creation if
  metadata-query profiling cannot guarantee cheap reconnect reads. Do not scan
  bodies, attachments, or the general outbox on a timer.
- Keep `latestHintThrough` separate from durable `seenThrough`; pending means
  `latestHintThrough > seenThrough`. Duplicate/out-of-order hints are no-ops.
  A hint means arrivals not yet reviewed on this desktop, not an exact count
  of currently unread messages. Existing unread badges retain their semantics.
- Reconnect sends one authoritative scalar snapshot, not an inbox or event
  backlog. Use transport-failure backoff only; add no idle mail timer. Preserve
  pending state while offline. Explicitly handle a restored/regressed cursor
  with a reset snapshot instead of retaining an unreachable watermark forever.
- Do not acknowledge on socket receipt, merely opening Mail, cached rows, or
  `onUnreadSnapshot`. Inbox pagination is ascending and capped at 16 × 25 rows:
  a page covering through 400 cannot clear a hint for 900.
- Add negotiated page *coverage* metadata if needed; it must describe what the
  returned page actually covers, not the mailbox's newest existence watermark.
  A complete empty/deleted-mail catch-up also needs authoritative coverage.
  Advance `seenThrough` only after a fresh user-loaded, exact-mailbox response
  passes its request-generation fence and is applied. Record it even if the
  corresponding hint has not arrived yet. Older replies cannot clear newer
  hints. Existing `has_more` or cached `latestSequence` alone is not proof.
- Main caches the latest hint in bootstrap state. Renderer initialization must
  buffer early events and max-merge them with bootstrap after profile binding;
  otherwise an event arriving before active-profile initialization is lost.
- A Member's one upstream stream can serve several desktops, each with its own
  retained seen anchor. The Member's validated cursor does not prove a desktop's
  older cursor, especially across restore/restart. Validate each desktop anchor
  through a one-time authenticated scalar request when connecting, or explicitly
  reset an unproven cursor. A cached highwater alone must not suppress reset.

## Scope, privacy, and UI boundaries

Derive recipient ownership from authenticated Hub/peer claims, never a supplied
mailbox ID alone. Revalidate membership, certificate, and active connection on
subscribe/replay/send. Bind packets to verified AgentsServer identity, Hub,
team, recipient server ID, and current role/connection authority. Main stamps
profile ID/generation; renderer checks both that fence and the exact realm.
Persist seen state under the stable realm/recipient key, not transient session
generations. Retire old subscriptions and buffered packets on identity, route,
membership, profile, or authority change.

Packets contain only bounded identifiers and a scalar watermark: no subject,
body, sender display name, recipient list, or access token. Reuse authenticated
websocket subprotocol credentials and existing pinned mTLS verification; do
not put tokens in URLs, event payloads, logs, or local plaintext cursor files.

The sole renderer listener updates a scalar pending flag. Sidebar and the Mail
navigation button select that flag. No toast, sound, OS notification, focus
change, or automatic navigation. No calls to `useTeamMessages.refresh()`,
`invalidateTeamNetworkSnapshot()`, roster/workspace refresh, detail prefetch,
or receipt mutation. Summaries/body load only through existing user actions.

## Estimated implementation surface and acceptance

Server: Hub `store.py` and a small hint broker; `secure_peer.py`,
`secure_peer_runtime.py`, `agent_server.py`; Hub `service.py` /
`secure_peer_hub.py` only for negotiated coverage projection; capability,
manifest, and possibly one high-water migration update. Keep the stream lane
separate from the frozen JSON proxy rather than redesigning that proxy.

Desktop: `shared/types.ts`, `shared/team-network.ts`, `main/server-client.ts`,
`main/service.ts`, Team Hub capability/query negotiation, `store/app-store.ts`,
`Sidebar.tsx`, `TeamNetwork.tsx`, and the successful page path in
`TeamMessagesBoard.tsx`. Generic preload event plumbing can be reused.

Required tests: commit/rollback/idempotency; subscribe/snapshot race; bounded
coalescing/slow peers; restart/offline recovery; cursor reset; revoked or wrong
realm; renderer bootstrap/profile race; capped/stale pages and delayed hints;
singleton teardown; and zero automatic Inbox/detail/roster requests on hints.
Server checks remain isolated and must not import/start the monolith or touch
live state. Notification implementation and end-to-end acceptance remain pending.
