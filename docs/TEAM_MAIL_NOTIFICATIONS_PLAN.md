# Quiet Team Mail arrival notifications

Desktop Mail notifications use a capability-gated, recipient-scoped push hint.
They update a quiet new-mail dot without fetching mailbox contents, moving
focus, changing the selected chat, sending a message, or starting an agent.
Unsupported or unverified servers do not cause endpoint probes.

## Transport and ownership

The standalone server advertises `capabilities.team_mail_hints_v1` through
existing authenticated health discovery. The dedicated local endpoint is
`/api/team-mail-hints/events`, using `agentsdock.team-mail-hints.v1` and
the existing authenticated WebSocket subprotocol. Tokens never belong in URLs.

Committed Mail updates a durable recipient cursor and a coalescing broker.
Host/Member delivery uses a separate authenticated, pinned-mTLS stream.
Streams have bounded passive accounting rather than occupying ordinary chat
workers, request slots, or maintenance-drain leases. Idle streams do not query
the mailbox. Socket work happens after the database transaction commits.

Desktop main's `TeamMailHintController` owns one active-profile connection.
Its bounded packets contain identity metadata, a stream generation, and an
arrival cursor—not subjects, bodies, attachments, or sender display names.
The renderer subscribes to the small pending-state value only.

There is no recurring Inbox poll, thread timer, or idle watchdog. Connection
failures use bounded transport backoff. Profile, identity, membership,
connection, or authority changes retire old subscriptions and buffered events.
Read/unread and manual mailbox reads work independently of the hint stream.

## Cursor and acknowledgement

- Bind hints to the authenticated profile, server, Hub, team, recipient, and
  stream generation. Ignore stale or contradictory realms and generations.
- Coalesce duplicate or out-of-order watermarks rather than queueing work per
  message. Restore/reconnect uses a bounded snapshot, not an event backlog.
- A retained nonzero cursor includes its immutable message identity. Sequence
  numbers alone are not enough across backup/restore or reset.
- Only a fresh, applied Inbox page with matching generation and coverage can
  acknowledge arrivals. Opening Mail, cached rows, or receiving a hint cannot.
- A newer arrival survives an older page response. Capped pages cannot clear
  arrivals they did not cover. Seen state remains separate from unread status.

## Validation boundaries

Regression coverage includes bootstrap/reconnect races, coalescing, revocation,
wrong-realm packets, delayed or capped pages, teardown, and unchanged mailbox
request counts during hint delivery. Controlled transport and renderer checks
use synthetic data; they do not certify every deployed topology or device.

Runtime implementation belongs to the separate AgentsServer repository.
This repository's embedded `server/` remains a compatibility fixture.
See `electron/src/shared/team-mail-hints.ts`,
`electron/src/main/team-mail-hint-controller.ts`, and `TEAM_MAILBOX_STATE.md`.
