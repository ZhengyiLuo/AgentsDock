# AgentsDock Cross-Chat Handoffs

Status: optional route hints, one-way handoffs, and bounded two-chat exchanges
are implemented for the desktop beta. Watches, artifact transfer, and group
exchanges remain deferred.

## Product Contract

- `@` is the primary composer shortcut; `/chat` opens the same picker.
- A selection inserts one visible inline chip bound to the target's immutable
  route. Plain mention-like text is never routing authority.
- `@Chat` is an optional target hint, not a delivery command. It never forwards
  the raw source prompt. The agent may prepare a one-way Send, start an
  asynchronous Ask, or make no cross-chat contact.
- Ordinary user turns are default-deny. Successful admission of an exact local
  single-`@Chat` chip from a v2 client durably grants that directional
  source-to-target route; later turns receive only the source chat's current
  grants. There is no ambient all-chat ceiling or required Inspector setup.
- Scheduled jobs never inherit source-chat grants. A job stores only its own
  exact route selections through the job editor/helper, and every firing
  revalidates those exact targets, revisions, and actions. The prompt keeps the
  matching single `@Chat` marker; `@@` is not current authoring syntax.
- Incoming work enters the target's normal durable FIFO. It does not steer or
  interrupt a running turn.
- Cross-chat activity renders as distinct blue agent-to-agent timeline cards
  in both chats. It never masquerades as a direct user message.
- Delivery is text-only. No transcript, reasoning trace, attachment, artifact,
  terminal state, working directory, model setting, or permission setting is
  inherited across chats.
- The target always retains its own backend, model, working directory,
  approvals, sandbox, and provider settings.
- Durable local grants are limited to the same authenticated AgentsServer and
  support native Codex app-server and Claude Agent SDK chats. An explicitly
  paired Team Network route may also appear as `@Remote`; this release grants
  only its exact instruction action and revalidates the connection, route,
  revision, and action at admission and delivery. Self, archived, deleted,
  unsupported-transport, unpaired, and arbitrary foreign-server targets fail
  closed.

## Agent-selected actions

### Ask & return reply

Calling `ask` on an available opaque route creates a durable exchange and
queues its first request leg in the target chat. The hint itself does nothing.

The current configured-route Ask contract is limited to one exact A↔B pair,
two conversational legs, and a 24-hour lifetime:

```text
1 A -> B  initial request, reply expected
2 B -> A  terminal answer only
```

Configured-route Ask has no follow-up capability. A successful non-empty
recipient final automatically returns one terminal answer when no explicit
terminal response won the one-use CAS. Failures and empty results return one
bounded terminal status instead of leaving the source waiting indefinitely.

Historical action-specific request/reply grants remain readable for safe
compatibility. Those legacy exchanges were limited to six conversational legs
and 72 hours, and an explicit response could set `request_response`:

- `false`: send a terminal answer leg; no reply is automatically requested.
- `true`: ask a deliberate follow-up. This is allowed only when two leg slots
  remain: one for the follow-up and one for its answer.

For that historical compatibility path, an explicit response atomically
consumes the run's one-use response capability and suppresses automatic
final-result forwarding. If the recipient does not respond explicitly, a
successful non-empty final answer is returned automatically only when its
inbound leg expects a reply. An inbound terminal answer remains eligible for
an explicit follow-up during its recipient run, but its ordinary final answer
does not bounce automatically.

There is no prose heuristic and no automatic third-party expansion. A new leg
always targets the other participant in the original pair. A failed, stopped,
deleted, archived, expired, or unavailable recipient is represented durably in
both timelines; failures that leave the other participant waiting enqueue a
native terminal status turn. User cancellation closes the exchange and updates
the cards without creating a provider reply obligation.

### Send only

Calling `send` with agent-authored bounded text creates one attributed target
turn and never creates a return obligation. The source prompt is not reused as
the message body.

### Send my final result

AgentsServer registers this obligation before the source provider starts. A
successful, non-empty source final answer is delivered once to the selected
target. Failure, stop, cancellation, deletion, or an empty result closes the
obligation visibly. Reasoning, tool output, partial text, and attachments are
not forwarded.

## Authority and Security

The UI sends structured `ChatReference` records with the source prompt. Each
new same-server grant contains the stable target ID, title snapshot, exact
UTF-16 display span, `grant_intent: true`, and the action:

```text
route
```

AgentsServer requires `agent_cross_chat_routes_v2` and validates the exact
single-`@Chat` span and local target before durable admission. It stages the
route under a hidden crash journal, fsyncs the matching `turn_started` or
`turn_queued` admission ID, then exposes it. Startup rolls back a marker with
no matching event and finalizes one with a matching event without recreating a
later edit or revoke. Scheduled runs issue only their independent persisted
job targets. Provider helper requests are loopback-only, bound to the live run
and source chat, one-use per route, and idempotent for a same-key retry.
The desktop administrator bearer is not a substitute for this capability.

Secure paired-server references are never ambient and are not persisted into
scheduled jobs. A newly authored `@Remote` carries an exact
`target_server_identity`, connection ID, route ID, route revision, and
`instruction` action; historical secure request/reply records remain readable
without widening their grant.

For a historical action-specific exchange delivery, the provider receives a
capability for only the current `(exchange_id, inbound_leg_id)`. Its durable
compatibility ledger enforces:

- the immutable participant pair
- one child per inbound leg
- one outbound exchange leg per source run
- one idempotency key per exchange
- the six-leg budget and 72-hour expiry
- compare-and-swap response ownership between explicit and automatic replies
- terminal cancellation/failure over stale provider or queue completions

Relayed text is untrusted content. It carries no routing authority, and any
mentions inside it are not parsed into grants.

Per-run capabilities enforce the AgentsServer API boundary. The server strips
its administrator bearer from provider environments and the shared tmux
environment. This beta does not claim hostile-process isolation between
arbitrary programs running as the same operating-system user; that requires a
separate credential-storage or OS-user boundary.

## Durable Model

One-way handoffs retain the v1 `cross_chat_envelopes` ledger. Bounded exchanges
add two tables without changing old rows.

```text
cross_chat_exchanges
  id
  requester_session_id
  responder_session_id
  authorization_source_run_id
  status: waiting_request | active | completed | failed | cancelled | expired
  max_legs
  used_legs
  active_leg_id
  expires_at
  error_code
  error
  lifecycle_status
  created_at
  updated_at

cross_chat_exchange_legs
  id
  exchange_id
  parent_leg_id
  ordinal
  source_session_id
  source_run_id
  target_session_id
  kind: request | reply | status
  expects_reply
  response_state: open | explicit_committed | automatic_committed | closed
  body
  body_chars
  body_sha256
  idempotency_key
  status: registered | submitting | queued | running |
          delivered | failed | cancelled | expired
  queued_id
  queue_position
  target_run_id
  lifecycle_status
  error_code
  error
  created_at
  updated_at
```

Current configured-route Ask uses conversational ordinals 1 and 2. Historical
action-specific compatibility exchanges use ordinals 1 through 6 and consume
their legacy exchange budget. A terminal failure notice is a correlated
`kind=status` leg with ordinal 0; it does not consume budget and never grants a
response capability.

## Server and Helper Contract

The health capability remains named `cross_chat_handoffs_v1` for compatibility
and advertises `version: 7`, `default_action: route`,
`features.route_hint_mentions: true`, `durable_route_grants: true`, and
`agent_ambient_local_handoffs: false`. API contract 20 uses the
`default_deny` agent-route policy. The server still reads beta legacy
`direct_message` and `@@` records for migration/recovery, but quarantines them
from ordinary authority; they never mint durable grants or resurrect a revoked
route. Nonterminal raw-prompt delivery envelopes are never resubmitted.
Scheduled Jobs remains version 5 and uses only exact per-job grants.

Desktop turns retain the additive `cross_chat_handoffs_v1` and v2 exchange
capabilities, and current route-grant authoring sends
`agent_cross_chat_routes_v2`. Only that token plus explicit `grant_intent`
provenance may persist a local `@Chat` grant; v1/v6 snapshots are readable but
cannot become policy. A queued-turn edit may bind only an already-current
durable route and never mints or restores one. Removing a chip does not revoke
the durable route; DELETE with its exact expected revision does.

Current opaque-route helper endpoints:

```text
GET  /api/agent/cross-chat/routes
POST /api/agent/cross-chat/routes/{route_id}/handoffs
```

Action-specific compatibility and exchange-response endpoints:

```text
POST /api/agent/cross-chat/handoffs
POST /api/agent/cross-chat/exchanges/{exchange_id}/responses
```

Desktop discovery, detail, and cancellation routes:

```text
GET  /api/chats/search
POST /api/cross-chat/handoffs
GET  /api/cross-chat/handoffs/{handoff_id}
POST /api/cross-chat/handoffs/{handoff_id}/cancel
GET  /api/cross-chat/exchanges/{exchange_id}
POST /api/cross-chat/exchanges/{exchange_id}/cancel
```

The one-way v1 route retains its existing semantics: same-key retries converge
on one envelope; a busy or paused target receives one durable FIFO item;
queued cancellation removes only the matching target row; and source/target
lifecycle projection is replayed after restart. The queued-only v1 cancel route
does not stop an already admitted target run.

The current packaged helper grammar uses only opaque route IDs returned by the
capability-scoped list command:

```text
agentsdock-chats list
agentsdock-chats send --route ROUTE_ID --message TEXT
agentsdock-chats ask --route ROUTE_ID --message TEXT
agentsdock-chats respond --exchange EXCHANGE_ID \
  --inbound-leg LEG_ID --message TEXT [--request-response]
```

`--target OPAQUE_HANDLE` remains accepted only when a legacy action-specific
or secure delivery capability prints that exact command; it is not a chat ID
and is not the command shape for a current `@Chat` hint. Route messages are
non-empty, bounded to 16,000 characters and 64 KiB UTF-8, and artifact grants
are rejected.

## Queue, Completion, and Recovery

1. Persist the exchange authorization before the source provider starts.
2. Atomically create the initial leg when the source invokes `ask`.
3. Append source and target lifecycle events and bind a durable target queue or
   live-run owner before the item becomes schedulable.
4. Admit the target run with a compare-and-swap from that exact owner.
5. At terminal time, preserve an already committed explicit child; otherwise
   create at most one automatic answer when the inbound leg expects it.
6. Reconcile queue ownership, provider terminal events, missing child commits,
   missing failure-status outbox legs, expiry, and lifecycle projection after
   restart and periodically.

Cancellation removes only the queue row whose queued ID and exchange-leg ID
both match. Recovery removes terminal legs that still retain a stale queue
owner, including rows hidden behind a paused user item. It never removes or
reorders unrelated user queue entries.

## Events and Desktop Projection

Exchange events include compact IDs, participants, direction, leg kind and
status, reply expectation, budget, expiry, titles, body preview/hash, and
stable error codes. Full bodies remain in the ledger and load only when the
user expands a card.

Existing one-way handoffs continue to project:

```text
cross_chat_handoff_registered
cross_chat_handoff_received
cross_chat_handoff_queued
cross_chat_handoff_started
cross_chat_handoff_delivered
cross_chat_handoff_failed
cross_chat_handoff_cancelled
```

Bounded exchanges add:

```text
cross_chat_exchange_registered
cross_chat_exchange_leg_registered
cross_chat_exchange_leg_received
cross_chat_exchange_leg_queued
cross_chat_exchange_leg_started
cross_chat_exchange_leg_delivered
cross_chat_exchange_leg_failed
cross_chat_exchange_leg_cancelled
cross_chat_exchange_completed
cross_chat_exchange_failed
cross_chat_exchange_cancelled
cross_chat_exchange_expired
```

One semantic timeline row is keyed by each exchange leg, plus one exchange
summary row. Later lifecycle events replace the earlier state in that row.
Cards show incoming/outgoing direction, counterpart, reply expectation,
current leg and exchange state, legs used and remaining, round/expiry details,
the full message on expansion, navigation to the counterpart, and cancellation
while the exchange is active.

## Failure Rules

| Condition | Behavior |
|---|---|
| Target busy | Queue in durable FIFO and show its position |
| Target paused | Preserve the queued leg behind the pause boundary |
| Target archived/deleted | Fail closed and notify the waiting participant |
| Source archived/deleted | Close the exchange; do not create new work from it |
| Provider fails or stops | Persist failure and notify the waiting participant |
| Server restarts | Rebuild queue/turn ownership and replay durable outbox gaps |
| Duplicate same-key call | Return the existing leg without duplicate work |
| Different second response | Reject because the run capability is already used |
| Historical follow-up with fewer than two slots | Reject without burning the terminal-answer retry |
| Current configured-route body/answer exceeds 16,000 characters or 64 KiB UTF-8 | Reject/fail visibly; never truncate silently |
| Historical action-specific message exceeds 100,000 characters | Reject/fail visibly; never truncate silently |
| TTL expires | Mark expired, remove stale queue ownership, and update both cards |
| User cancels | Close durably, remove the exact queued owner, and update both cards |

## Validation

Release gates cover:

- authority binding, one-use routes, idempotency, self/archived/deleted targets,
  and native Codex↔Claude transport eligibility
- idle, busy, paused, queued, running, stopped, cancelled, and deleted delivery
- current configured-route Ask's two-leg/24-hour/no-follow-up boundary
- historical explicit response versus automatic-final races in both interleavings
- historical bidirectional deliberate follow-ups and terminal answers
- historical six-leg accounting and two-slot follow-up reservation
- cancellation/expiry commits, late provider terminals, and exact queue cleanup
- restart recovery after provider-terminal, response-child, status-outbox, queue,
  and lifecycle commit boundaries
- one semantic blue row per leg, details/cancel IPC, workspace switching, action
  defaults, keyboard selection, old-server fallback, and stored-reference
  compatibility

## Deferred Work

- event-driven watches and source resumption based on watched conditions
- explicit artifact grants and copies
- cross-server/profile federation
- group or third-party exchange expansion
- automatic target interruption
- transcript visibility without an explicit digest
- user-configurable exchange budgets or TTLs

Watches, when implemented, must use durable server events, watermarks, expiry,
and cancellation. They must not keep a provider turn alive to poll another
chat.
