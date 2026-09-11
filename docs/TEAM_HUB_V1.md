# AgentsDock Team Hub V1

Status: embedded private-network beta.6 preview. The service, authentication
boundary, first team/member/node/channel/message vertical slice, designated
AgentsServer host, Electron Teamspace client and adversarial tests are
implemented in the repository. This document does not claim a published
artifact or production remote deployment.

## Architecture decision

One designated ordinary AgentsServer hosts Team Hub in-process at
`/api/team-hub`. `AGENTSDOCK_TEAM_HUB_MODE=host` explicitly enables that host;
unset/`disabled` creates no Hub state. The mount shares the managed listener and
restart/update lifecycle, but keeps a distinct service, database and credential
boundary.

- Team Hub is the authoritative identity, membership, messaging, artifact,
  policy, audit and durable-delivery control plane.
- Each AgentsServer remains an execution plane for its own chats, provider
  processes, terminals, jobs and queue admission.
- V1 has one authoritative Hub. AgentsServer nodes enroll as independent
  clients. There is no peer-to-peer federation, multi-Hub merge or public
  discovery.
- The Hub database is transactionally bound to the designated AgentsServer's
  stable `server_identity`. A copied bound database refuses activation on a
  foreign server before migration or signing-key mutation.
- A stable `hub_id` fences desktop discovery and update/rollback checks. A
  process-specific Hub instance ID remains diagnostic only.
- A future hosted Hub can replace the embedded mount without changing Hub
  principals, memberships or credential semantics.

Same IP, LAN or Tailscale membership is not authorization. The existing
AgentsServer administrator bearer authenticates AgentsServer core/discovery
routes and one narrow, selected-route-bound parent route that issues a recipient-,
request-, server-instance- and Hub-bound bootstrap proof. It is never accepted,
copied, hashed or derived by Hub, and the proof exchange never transforms it
into a Hub credential. Hub credentials are never accepted by AgentsServer
routes.

The server contract retains three transport values for rolling-upgrade
compatibility. `loopback` preserves the host-local contract.
`tailscale_serve` advertises one canonical
`https://<machine>.<tailnet>.ts.net:8444/api/team-hub` URL. Port `8444` must be
a private Tailscale Serve mapping to the local AgentsServer listener. It must
not be a Funnel mapping. Legacy `direct_ip` is an advanced route at
the exact active AgentsServer origin,
`http://<literal-ip>:7850/api/team-hub`. It is deliberately unencrypted: an IP
address is routing, not identity, Tailnet attestation or authorization. Use it
only for compatibility with older clients on a network the operator explicitly
trusts. Current AgentsDock desktop builds never offer, restore, or select this
plaintext route; use secure server pairing or private Tailscale Serve instead.
Arbitrary hostnames, another port/origin, ordinary reverse proxies and public
ingress remain forbidden.

The managed listener keeps proxy-header rewriting disabled. A Serve request is
accepted only when its real socket peer is loopback and exact `Host`,
`X-Forwarded-Host`, `X-Forwarded-Proto=https`, `Tailscale-Headers-Info`, human
login and user-name headers match the configured Serve origin. Any Funnel or
generic `Forwarded` header fails closed. These headers select a transport and
bind bootstrap; they are never a substitute for Hub authentication.
Direct IP accepts only the exact literal-IP `Host` on a real non-loopback
socket. It rejects `Origin`, cookies and every forwarded/proxy/Tailscale/Funnel
header. It does not infer safety from `100.64/10`, `10/8` or any other address
shape. Hub bearer authentication remains mandatory on every protected route.

## Identity and credential boundaries

| Identity | Scope | Credential or authority |
| --- | --- | --- |
| Human principal | Global across teams | Hub device session |
| Membership | One principal in one team | Transactional RBAC lookup |
| Device session | One native/browser device | Short access + rotating refresh |
| Node | One AgentsServer installation | Independently enrolled Ed25519 key |
| Agent | Stable provider agent on one node | Future node assertion |
| Chat | Stable chat on one node | Future node assertion |
| Run | One bounded execution | Future node assertion and provenance |
| Turn capability | Exact delegated action | Hashed, scoped, nonced, TTL/use bounded |

Access tokens are signed, ten-minute, issuer/audience-bound credentials with
`sub`, `sid`, `jti`, `iat`, `nbf`, and `exp`. Every authenticated request
re-reads the active device session and principal. Every team mutation also
re-reads active membership, role and resource scope in the same transaction.
The token does not contain an authoritative team role.

Refresh, invitation, enrollment, bootstrap, recovery and capability secrets
are persisted only as SHA-256 hashes. Refresh tokens rotate atomically. Reuse
of a consumed ancestor commits whole-session/family revocation before returning
the same generic authentication error.

All received messages, Markdown, runbooks, skills, names and metadata are
untrusted content. They never grant authority. Credentials never enter message
bodies, audit metadata, outbox payloads, URLs, renderer state or logs.

## Local and delegated bootstrap; device recovery

A fresh Hub starts closed. It creates a mode-`0600`, short-lived one-time proof
only while the global identity database is empty. Redemption is permitted only
from the actual loopback socket peer and creates exactly one human, personal
team, active owner membership and device session in one transaction. `Host`,
`Origin` and `X-Forwarded-For` cannot claim loopback status; the CLI disables
proxy-header rewriting.

The proof value is never returned by health or printed. The CLI prints only its
file path. An expired unused proof can be safely renewed while the database is
still empty:

```bash
PYTHONPATH=server python3 -m agentsdock_team_hub.cli bootstrap-proof \
  --data-dir "${AGENTSDOCK_STATE_DIR:-$HOME/.agentsdock}/team-hub"
```

On a managed installation, use that release's interpreter instead of
`PYTHONPATH`, for example:

```bash
~/.local/share/agents-server/current/.venv/bin/python \
  -m agentsdock_team_hub.cli bootstrap-proof \
  --data-dir "${AGENTSDOCK_STATE_DIR:-$HOME/.agentsdock}/team-hub"
```

For `tailscale_serve`, the Electron main process performs a separate
dual-authority first-owner exchange. It posts the exact selected profile
identity, live server instance, Hub ID, Hub URL, canonical UUIDv4 request ID,
confirmed recipient and device fields to
`/api/admin/team-hub/bootstrap-proof` on the exact selected origin. That parent
route requires exactly one AgentsServer administrator Bearer header and the
verified Tailscale human login. The retained legacy Direct-IP API requires a
literal unsafe-transport confirmation bound into the proof and the same origin
as the authenticated active AgentsServer profile, but current desktop builds
do not invoke it. The parent route rejects
browser Origin/cookies, alternate or query credentials, redirects and proxy
headers. It returns only a five-minute `bootstrap_remote.*` proof, never a Hub
access or refresh credential. The main process separately redeems that proof
at `/api/team-hub/v1/bootstrap/redeem` with the same request ID and body.

Remote grants are hash-only, single-use, deterministic for an exact retry,
bound to the exact route kind/URL and one live server instance, and
automatically invalid after restart or a maintenance snapshot. Only one grant may be active; issuance is rate limited
per verified login and globally, and its immutable pre-bootstrap ledger is
hard-capped. Local, Serve and Direct-IP proofs are distinct realms and cannot
be redeemed through another transport. A lost response is retried with the same
UUID/body; clients do not mint a competing request ID.

Losing any existing human member's refresh token is recoverable through a
distinct local control-plane command. The POSIX owner of the mode-`0700` Hub
data directory already controls the database and signing key and is explicitly
inside this local-preview trust boundary:

```bash
PYTHONPATH=server python3 -m agentsdock_team_hub.cli device-recovery \
  --data-dir "${AGENTSDOCK_STATE_DIR:-$HOME/.agentsdock}/team-hub" \
  --email person@example.com --device-label "Replacement Mac" [--team-id TEAM_ID]
```

Issuance atomically revokes every existing device session and live refresh
token for the principal, then writes a mode-`0600`, ten-minute,
team/principal/device-bound proof and prints only its path. This fail-safe V1
behavior makes a lost or stolen device immediately unusable even before proof
delivery. Embedded redemption from actual loopback or the already verified
private Serve transport creates one fresh device session for that same identity
while preserving all legitimate memberships. Forwarded headers cannot alter
the peer/authority decision. Issuance is not exposed over HTTP.
Proof expiry, replay, wrong device label and suspended identities fail closed.
Owner-recovery issuance remains host-local; Tailnet identity alone cannot mint
a recovery proof. Audit events name a stable local-control service principal as actor and the recovered
human as the subject; they never falsely attribute local issuance to the
unauthenticated human. `owner-recovery` remains a compatibility alias whose
issuance is restricted to an active owner.

An active owner cannot be demoted, suspended or revoked in this preview. Owner
transfer is intentionally absent rather than allowing a zero-owner team.
Startup rejects pre-existing databases whose teams do not each have exactly one
active owner and active owner principal.

## Invitations and existing identities

Every invitation is one-time, short-lived, team-, recipient-email- and
role-bound. Owner/admin can issue `admin`, `member` or `guest`; there are no
recipient-unbound invites.

Unauthenticated redemption may create a session only when the normalized email
has never existed in Hub. If the email already maps to a global human
principal, redemption returns `invitation_requires_authentication` without
consuming the invitation or creating a session. The existing recipient signs
in and accepts it through `POST /v1/invitations/accept`; Hub compares the bound
email to the authenticated account. This prevents an invitation issuer from
using a token to impersonate an existing person and inherit that person's other
teams or DMs.

## Node enrollment handshake

An owner/admin issues a grant bound to one team, exact stable server identity,
display name, canonical Ed25519 public key and fingerprint. The node submits
that same public key with the grant to receive a short-lived random Hub
challenge. It signs the exact domain-separated `signing_payload` with its
private key. Hub verifies the signature, challenge/grant TTL and issuer state,
then consumes challenge and grant and creates node, credential and legacy
identity binding atomically.

Submitting a key is not proof of possession. A mismatched key, signature,
identity, team, expired/revoked grant, replay or legacy identity conflict fails
closed. An unredeemed grant does not reserve the global server identity; the
identity is claimed only after valid proof-of-possession. Node private keys
remain on the node.

## Posts and dispatch are separate operations

`POST /v1/channels/{channel_id}/messages` creates a passive record, recipient
rows for a DM and a metadata-only outbox event. It never calls AgentsServer,
creates a provider turn, changes a queue, mints a capability, or interprets
message text/mentions as execution authority.

`POST /v1/dispatches` is present only to make the product boundary explicit.
After authenticating the current session it returns:

```json
{
  "error": {
    "code": "dispatch_unavailable",
    "message": "Dispatch requires a scoped capability and node connector"
  }
}
```

with HTTP `501`. It does not parse/store request text and creates no dispatch,
turn, queue, outbox or agent effect. Dispatch stays unavailable until scoped
capability issuance and atomic token+nonce consumption, node claim/lease/
receipt recovery, exact local queue convergence, revocation races and bounded
causation are implemented and tested.

## Teamspace authorization

ACL evaluation is deny by default. Principal ACL entries take precedence over
role entries, including explicit denial. Current channel creation writes
canonical ACLs:

- team boards: owner/admin manage/read/post; member read/post; guest read;
- announcements: owner/admin manage/read/post; member/guest read only;
- private boards: explicit active participants only;
- direct messages: exactly two distinct active participants, a server-computed
  pair key, and explicit participant ACLs.

Owner/admin is not an override for a DM. Every DM list/read/post revalidates the
exact two active participants and pair hash; drift or a third participant fails
closed. Channel projections include effective `read`, `post`, `manage`, and
`dispatch` permissions so clients can gate controls.

Messages have a per-channel monotonic sequence and canonical body fingerprint.
Same idempotency key plus byte-equivalent request returns the original object;
same key plus changed content returns `409` without consuming a sequence or
creating another audit/outbox row. Thread roots must be undeleted top-level
messages and parents must belong to the same thread.

## HTTP contract

In loopback mode the Hub base URL is the selected AgentsServer profile origin
plus `/api/team-hub`. In Serve mode it is the distinct exact HTTPS URL
advertised by authenticated discovery. The protocol retains Direct IP as the
exact unencrypted literal-IP AgentsServer origin plus `/api/team-hub` only for
older-client compatibility; current AgentsDock desktop builds never select it.
There is no port `7851` or separate Hub process. The desktop reads
`capabilities.team_hub_v1` from `GET /api/health`:

```text
{
  available, designated_host, version=1,
  base_path="/api/team-hub" | null,
  transport="loopback" | "tailscale_serve" | "direct_ip" | null,
  hub_url=<exact primary route URL> | null,
  routes=[{transport, hub_url}, ...],
  hub_id, host_server_identity, message, action
}
```

When available, `hub_id` and `host_server_identity` must match the mounted Hub
health and selected server profile. `routes[0]` is the primary transport and
the bounded route list is canonical, unique and deterministically ordered. A
loopback host has `hub_url=null`; a Serve or Direct-IP host has its exact
canonical URL. When disabled, `designated_host=false`,
`available=false`, `base_path=null`, `transport=null`, `hub_url=null` and both
identities are null. A configured
host whose startup failed keeps `designated_host=true`, the fixed base path and
top-level server identity, but reports `available=false` and `hub_id=null`.

Native clients send `Authorization: Bearer ACCESS_TOKEN` and no `Origin`.
The embedded service configures no browser origins, so every browser Origin is
denied. All mutating routes
require exactly one decimal `Content-Length`, exact
`Content-Type: application/json`, an object body no larger than 64 KiB, no
`Transfer-Encoding`, valid Unicode and no extra model fields. Authorization and
local proof headers must occur exactly once. Error bodies always have:

```json
{"error":{"code":"stable_code","message":"safe message"}}
```

Public timestamps are UTC ISO-8601 strings. Success responses are raw objects,
not wrapped in a generic `data` envelope.

All routes below are relative to `/api/team-hub`. The parent wildcard CORS
middleware bypasses that prefix, so Hub's exact Origin policy owns ordinary and
preflight responses. The bare prefix returns a fixed `404` without a redirect.
Uvicorn proxy-header rewriting is disabled.

The desktop binds discovery to the active profile ID, profile generation,
stable server identity, live server instance, Hub ID, transport and Hub URL.
Switching profiles or observing a generation/identity change cancels pending
bootstrap, clears in-memory Hub credentials and requires fresh discovery. No
Hub credential or delegated proof follows a profile switch.

Automatic selection filters out every advertised Direct-IP route. It selects
only host-local loopback, private Tailscale Serve, or an explicitly pinned
secure-peer route. Before any saved refresh credential is read or sent, the
desktop rechecks route membership and verifies `/v1/health` returns the bound
`hub_id`.
Safe route changes preserve a refresh credential only for the same profile,
server URL, stable server identity and Hub identity.

### Health and sessions

```text
GET  /v1/health
POST /v1/bootstrap/redeem
POST /v1/device-recovery/redeem
POST /v1/owner-recovery/redeem             compatibility alias
GET  /v1/session
POST /v1/sessions/refresh
POST /v1/sessions/revoke
```

Health returns stable `hub_id`, restart-specific `instance_id`, API/schema
versions and `bootstrapped`/`bootstrap_required`; it returns no path or secret.
Bootstrap proof is in `X-Team-Hub-Bootstrap-Proof`; generic recovery proof is
in `X-Team-Hub-Device-Recovery-Proof`. The compatibility owner route uses
`X-Team-Hub-Owner-Recovery-Proof`.

Bootstrap, new-person invite redemption, refresh and device recovery return:

```text
AuthBundle {
  access_token, token_type="Bearer", access_expires_at,
  refresh_token, refresh_expires_at,
  session { id, device_label, expires_at },
  principal { id, email, display_name },
  teams: Team[]
}

Team { id, kind, slug, display_name, role, status }
```

### Memberships and invitations

```text
GET  /v1/teams
GET  /v1/teams/{team_id}
GET  /v1/teams/{team_id}/members
POST /v1/teams/{team_id}/invitations
POST /v1/invitations/redeem
POST /v1/invitations/accept
```

Invitation issuance body:

```json
{"invitee_email":"person@example.com","role":"member","ttl_seconds":900}
```

The response includes sanitized `invitation` metadata and the one-time `token`.
Member/guest directory projections include active identities only and redact
emails; owner/admin may view active member emails.

### Nodes

```text
POST /v1/teams/{team_id}/node-enrollments
POST /v1/node-enrollments/challenge
POST /v1/node-enrollments/redeem
GET  /v1/teams/{team_id}/nodes
```

Grant issuance requires `server_identity`, `display_name`, `public_key` and an
optional bounded `ttl_seconds`. Challenge returns `challenge_id`, public
`nonce`, expiry and the exact `signing_payload`. Redemption accepts base64
Ed25519 `signature`. Node directory details are owner/admin-only in this
preview.

### Channels and passive messages

```text
GET  /v1/teams/{team_id}/channels
POST /v1/teams/{team_id}/channels
GET  /v1/channels/{channel_id}/messages?limit=50&before_sequence=N
POST /v1/channels/{channel_id}/messages
POST /v1/dispatches                         always authenticated 501
```

Channel creation accepts:

```text
{
  kind: "board" | "announcements" | "direct",
  visibility: "team" | "private",
  slug?, display_name?, participant_principal_ids[], idempotency_key
}
```

Message creation accepts:

```text
{
  body, body_format: "plain" | "markdown",
  kind: "post" | "announcement",
  thread_root_message_id?, parent_message_id?, idempotency_key
}
```

Announcements channels accept announcements only. Boards and DMs accept posts
only.

## Persistence and audit

SQLite migrations are append-only, contiguous and checksum verified under an
immediate writer lock. File databases use foreign keys, WAL, full synchronous
writes, secure deletion and owner-only mode. First-open WAL/migration setup has
a bounded lock retry and same-process serialization. Runtime startup verifies
SQLite foreign keys/schema and team-owner invariants.

Authority-bearing identities and terminal credential states are immutable or
monotonic. Application mutations write hash-chained metadata-only audit events;
channel/message effects write deduplicated outbox rows in the same transaction.
Received content and secrets are excluded from those records. A database host
administrator remains inside the trust boundary; external audit anchoring is
deferred.

The managed host holds one interprocess runtime lease for its full lifetime;
the development standalone listener and offline restore require the same lease.
The snapshot verifier does not take that exclusive lease, so it can validate
the rollback while the old fenced service remains live; it never opens or
migrates the live database.
Restart/update closes Hub admission, drains in-flight requests with a finite
timeout, checkpoints SQLite and writes a verified bounded snapshot containing
the database, signing key and active proof files. A persistent update fence is
bound to exact `reason + update_id + snapshot + hub_id + server_identity` and
blocks Hub/local-control writes for the whole update.

Server and detached updater status writes use a shared cross-process CAS lock.
A stale runner may write only while both its update ID and a runner-owned active
phase match. Pre-install abort clears only its exact fence before publishing a
terminal status. After `install.sh` starts, the installer owns success and
rollback: it must verify candidate server/Hub identity and clear the exact fence
while rollback is still possible, or stop the candidate and run the verified
offline restore before restarting the old release. A same-operation marker
surviving a failed install remains fail-closed across restart; startup never
guesses that recovery completed.

The update fence also records the exact primary transport/URL and the canonical
Direct-IP URL, including an explicit empty value when no Direct route exists.
The detached runner, installer, candidate health check and rollback health
check preserve that ordered route set. A missing, added, reordered or changed
Direct-IP route fails the candidate instead of silently falling back.

Before starting a migration-capable candidate, the installer runs the
non-mutating `verify-snapshot` control command. It requires the exact live
operation marker and fully checks manifest hashes, SQLite integrity/migrations,
stable identities, signing key and active proof files:

```bash
~/.local/share/agents-server/current/.venv/bin/python \
  -m agentsdock_team_hub.cli verify-snapshot \
  --data-dir HUB_DATA_DIR --snapshot SNAPSHOT_DIR \
  --expected-host-identity SERVER_ID --expected-hub-id HUB_ID \
  --expected-operation-id UPDATE_ID
```

If rollback becomes necessary, `restore-snapshot` repeats the same complete
verification before changing live state. A stale installer cannot restore an
older valid snapshot for the same Hub. A successful restore atomically replaces
the Hub database, signing key and active proof set, removes WAL/SHM files and
consumes the exact maintenance fence:

```bash
~/.local/share/agents-server/current/.venv/bin/python \
  -m agentsdock_team_hub.cli restore-snapshot \
  --data-dir HUB_DATA_DIR --snapshot SNAPSHOT_DIR \
  --expected-host-identity SERVER_ID --expected-hub-id HUB_ID \
  --expected-operation-id UPDATE_ID
```

## Compatibility

Team Hub is additive and disabled by default. Existing AgentsServer profiles,
URLs, stable identities,
keychain bearer credentials and local chats continue unchanged when Hub is
absent or logged out. Hub does not import prompt bodies, transcripts, working
directories, provider credentials, terminal data or historical messages.

The current desktop stores Hub access/refresh material in the native main
process/keychain boundary and sends only sanitized Teamspace state to the
renderer. Mobile is outside this slice.

## Tested and deferred

Automated coverage includes migration checksums/integrity, 50 rounds of
eight-way threaded first-open plus an eight-process first-open, stable Hub
identity, proof locality/duplication, signed-token claim bounds, refresh replay
revocation, owner recovery, invitation impersonation resistance, node key
binding/PoP/replay, member privacy, explicit ACLs, DM administrator isolation,
message/thread/idempotency behavior and zero-effect dispatch.

Still deferred:

- an AgentsServer node connector and dispatch claim/lease/receipt execution;
- agent/chat/run metadata registration and scoped turn-capability issuance;
- artifact uploads, attachment scanning/downloads and retention purge;
- runbook/skill APIs, signature review, permission diffs and manual install;
- external audit anchoring/export and outbox delivery workers;
- SMTP/external email, passkeys/password login and hosted account recovery;
- Windows Hub-host ACL hardening;
- encrypted direct-IP transport (IP-SAN certificate or pinned-key topology),
  generic proxy/CA topology and hosted multi-machine Hub clients;
- federation, cross-team messaging and autonomous broadcast execution;
- a production remote deployment guide.

Publishing a skill will never install or execute it. A future install flow must
verify provenance, exact version/hash/signature, declared permissions,
permission diffs, reviewer separation and fresh explicit approval.
