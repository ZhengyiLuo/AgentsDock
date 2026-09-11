# AgentsDock Team Hub V1

Team Hub is hosted by one designated, ordinary AgentsServer. It is mounted on
that server's existing listener at `/api/team-hub`; users do not start a
second Hub process for the beta.3 preview. Remote Teamspace uses a distinct
private Tailscale Serve HTTPS origin on port `8444` that proxies to that same
listener.

The in-process mount is still a separate security boundary:

- Hub state, signing key, proofs and SQLite database live under the private
  `<AgentsServer state>/team-hub` directory.
- The AgentsServer administrator bearer is accepted by core/discovery routes
  and the narrow Serve-bound parent bootstrap-proof issuance route, but is
  never accepted by a Hub route or transformed into a Hub credential.
- Hub access/refresh credentials are never accepted by AgentsServer routes.
- A passive Hub post never starts a provider turn. Dispatch is authenticated
  but deliberately returns `501` without storing or executing anything.

## Enable the designated host

Set this on exactly one managed AgentsServer and restart it:

```bash
AGENTSDOCK_TEAM_HUB_MODE=host
```

For host-local use, leave `AGENTSDOCK_TEAM_HUB_URL` unset. For private remote
use, configure a Serve-only (never Funnel) `8444` mapping to the loopback
AgentsServer listener and persist the exact canonical URL:

```bash
AGENTSDOCK_TEAM_HUB_URL=https://atlas.example-tailnet.ts.net:8444/api/team-hub
```

The hostname must be the certificate-verifiable lowercase `*.ts.net` machine
name with at least one Tailnet label, and the port/path must be exactly
`:8444/api/team-hub`. Literal `100.x`/other IP URLs, credentials, query,
fragment, alternate port/path and trailing dot/slash are rejected.

Leaving `AGENTSDOCK_TEAM_HUB_MODE` unset or setting it to `disabled` creates no
Hub files. With `AGENTSDOCK_TEAM_HUB_MODE=host`, leaving
`AGENTSDOCK_TEAM_HUB_URL` unset selects the loopback transport.
Authenticated `GET /api/health` advertises `capabilities.team_hub_v1`:

```json
{
  "available": true,
  "designated_host": true,
  "version": 1,
  "base_path": "/api/team-hub",
  "transport": "tailscale_serve",
  "hub_url": "https://atlas.example-tailnet.ts.net:8444/api/team-hub",
  "hub_id": "hub_...",
  "host_server_identity": "server_...",
  "message": "This AgentsServer hosts Team Hub over private Tailscale Serve.",
  "action": null
}
```

The desktop accepts the advertised URL only from its authenticated active
profile, then verifies that `/api/team-hub/v1/health` returns the advertised
stable `hub_id`. Profile/generation/server changes discard pending bootstrap
and in-memory Hub credentials; authority never follows a profile switch.

## Bootstrap and recovery

First activation creates a mode-`0600`, 15-minute owner proof at:

```text
<AgentsServer state>/team-hub/bootstrap-owner.proof
```

Select that proof file in the native Teamspace setup flow. The main process
reads it and sends it once in `X-Team-Hub-Bootstrap-Proof`; the secret is not
placed in renderer state or the clipboard. Health and discovery never return a
proof or proof path.

On a Serve host, Start uses a five-minute delegated proof instead of selecting
the local file. The main process calls the Serve-only parent endpoint
`/api/admin/team-hub/bootstrap-proof` with the AgentsServer bearer, exact
server instance/Hub/URL/request UUID and recipient fields. The verified
Tailscale login must equal the normalized recipient. The returned
`bootstrap_remote.*` proof is redeemed separately at the Hub endpoint; the
parent response never contains Hub access or refresh credentials. Same-UUID
retries are idempotent, while replay, changed bodies, restart, snapshot,
wrong recipient or wrong transport fail closed.

An expired empty-database proof can be renewed locally. For a source checkout:

```bash
PYTHONPATH=server python3 -m agentsdock_team_hub.cli bootstrap-proof \
  --data-dir "${AGENTSDOCK_STATE_DIR:-$HOME/.agentsdock}/team-hub"
```

On an installed host, run the same control command with the managed release's
interpreter:

```bash
~/.local/share/agents-server/current/.venv/bin/python \
  -m agentsdock_team_hub.cli bootstrap-proof \
  --data-dir "${AGENTSDOCK_STATE_DIR:-$HOME/.agentsdock}/team-hub"
```

The local host operator can recover an existing member's lost device session:

```bash
PYTHONPATH=server python3 -m agentsdock_team_hub.cli device-recovery \
  --data-dir "${AGENTSDOCK_STATE_DIR:-$HOME/.agentsdock}/team-hub" \
  --email person@example.com \
  --device-label "Replacement Mac"
```

For an installed host, replace `PYTHONPATH=server python3` with
`~/.local/share/agents-server/current/.venv/bin/python`.

Pass `--team-id` if the address is ambiguous. Recovery is bound to the exact
existing principal and device label, revokes all older sessions/refresh
families, and never creates a principal or team. Local-control commands are
refused throughout a managed update fence.

## Beta.3 transport boundary

Loopback mode retains the host-local beta.2 rules. Serve mode accepts only an
actual loopback proxy peer plus the exact configured Host/XFH/XFP and verified
Tailscale human identity headers. Any Funnel marker, generic Forwarded header,
direct remote `:7850` call, literal Tailnet-IP origin, ordinary reverse proxy,
or browser Origin is denied. Tailscale membership is transport evidence, not
Hub authorization; normal routes still require Hub access credentials.

The Hub has exact Host/Origin policy, bounded JSON bodies, duplicate-header
rejection and per-login plus global rate limits. Parent wildcard CORS does not
wrap the Hub.
The bare `/api/team-hub` prefix returns a fixed `404` without a Host-derived
redirect.

POSIX owner-only file modes are required. Windows Hub-host ACL hardening is
deferred. Ordinary AgentsServer chat support is unchanged.

## Implemented slice

- stable Hub identity and stable AgentsServer host binding;
- personal-team bootstrap, users, memberships and RBAC;
- short-lived signed access tokens, rotating hashed refresh credentials,
  replay-family revocation, logout and local device recovery;
- recipient/role/team-bound invitations with authenticated acceptance for an
  already-existing global identity;
- Ed25519-bound node challenge and proof-of-possession enrollment;
- explicit-ACL boards, announcements and exact two-person DMs;
- threaded passive posts, canonical idempotency, audit chain and durable
  outbox projections;
- bounded request admission/drain, verified DB/key/proof snapshots, exact
  operation-owned update fences, non-mutating rollback preflight and offline
  restore;
- an inert authenticated `POST /v1/dispatches` returning `501`.

The standalone `serve` command remains a development compatibility tool for
an unbound database. It refuses an embedded-bound database and shares the same
exclusive runtime lease, so it cannot bypass the one-designated-host rule.

## Test

```bash
uv sync --project team-hub --dev
uv run --project team-hub python -m unittest discover -s team-hub/tests -v
```

Server integration tests additionally cover the mounted credential/CORS
boundary, loopback and Serve transports, delegated bootstrap, managed
restart/update drain, snapshot/restore,
operation ownership and vendored source parity.

The complete API and security contract is in
[`docs/TEAM_HUB_V1.md`](../docs/TEAM_HUB_V1.md).
