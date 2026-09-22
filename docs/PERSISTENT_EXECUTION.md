# Persistent execution during server updates

The implementation separates the public HTTP/WebSocket gateway from the process
that owns provider connections, running turns, approvals, tools, queues and chat
state. Replacing the gateway must leave the execution process untouched. Clients
reconnect and resume the existing event history; accepted commands are never
automatically replayed by the gateway.

Stable 1.0.4 build 1193 passes native migration, rollback/retry, populated-data
preservation and actual packaged-app healthy and failure/recovery paths.
The matching npm package, signed standalone bridge and both stable desktop feeds
are published and verified. The installer selects this layout by default and the
coordinated updater stages dependencies while existing work continues. Replacing
the execution runtime still waits for idle; simultaneous execution generations
are not implemented.

```text
AgentsDock clients
       |
       v
replaceable public gateway
       |
       | authenticated private Unix socket
       v
execution owner -- provider subprocesses -- tools / subagents
       |
       +-- chat state, events, queues, pending approvals
       +-- private callback listener for provider helpers
```

## Implemented boundaries

- `server/execution_service.py` starts either component. Only the execution
  process loads the application and runs its startup/shutdown lifecycle. Its
  runtime directory is bound to the application's state directory to prevent
  two independently locked workers from sharing the same state.
- `server/execution_ownership.py` also locks that state directory for the
  process lifetime across both maintained entry points. Acquisition precedes
  chat loading and orphan-provider cleanup; shutdown stragglers retain the
  lease. Previously released servers without this lock still require a verified
  stopped-service handover during initial migration.
- `server/execution_transport.py` forwards ASGI messages over a private socket.
  It preserves the original peer address, scheme and ordered duplicate headers,
  including headers the server rejects. It streams HTTP and WebSocket traffic
  with backpressure. Gateway loss disconnects client attachments without
  cancelling accepted execution work or retrying mutations.
- Provider helpers use a loopback listener owned by the execution process, so
  their requests do not depend on the replaceable gateway.
- `/api/health` retains the actual execution server version and instance. It
  adds separate gateway/execution identities. An updated gateway never reports
  an older execution runtime as upgraded.
- `server/execution_control.py` exposes maintenance only on the worker's private
  callback listener. It requires a separate local control credential and exact
  worker identity. It is not exposed through the public gateway.
- `server/execution_maintenance.py` admits retirement only while work is idle.
  The application holds its real turn/queue/mutation locks while taking that
  decision. A durable sealed hold closes admission before the service manager
  may stop a worker. A timeout does not authorize killing busy agents.
- `server/execution_install.py` journals both native service configurations,
  pins execution to its retained release, and records separate component health.
  Gateway activation must preserve the worker PID and instance identity.
- `server/execution_manage.py` provides explicit activation/recovery against
  launchd or user systemd. It does not replace the production installer's state,
  Team Hub or secure-peer rollback machinery. A running legacy server without
  the maintenance protocol is not directly migrated by this controller.
- `server/execution_activation.py` integrates the paired jobs with the main
  installer's state, Team Hub and secure-peer recovery transaction. A legacy
  service must prove its exact admitted idle update before it is stopped.
  `server/execution_legacy_runner.py` proves older macOS updater ownership when
  status omits its process ID. After rollback, a leftover candidate receipt is
  classified under its worker lock with authenticated legacy health and proof
  that the candidate process is gone; it never authorizes a stale callback.
- `server/update_preparation.py` downloads and stages the signed candidate
  without changing the active release, service configuration or admission.
  `server/execution_preparation.py` seals the prepared source and dependencies
  in a receipt that is checked again before activation. Pending updates retain
  the existing older-client contract.
- `server/update_handoff.py` transfers the exact worker's sealed idle hold to
  the detached installer. Failed attempts retain an identifiable retry path;
  cleanup cannot release another operation's hold.
- `server/update_recovery.py` binds interrupted activation to the accepted
  update, source directory identity, API version and retained installer journal.
  Verified rollback remains a failed, retryable update, rather than successful
  installation. Completion requires both native component versions and released
  execution admission, including during same-version repair.
- `server/execution_recovery.py` registers an independent native recovery owner
  before either main service stops. Its retained standard-library bootstrap can
  resume the exact journal without an HTTP connection or candidate dependencies.
  `server/execution_recovery_status.py` settles only the matching abandoned
  update after verified commit or rollback; a live updater retains settlement.
- `server/execution_http.py` verifies the connected TCP socket belongs to the
  expected native process and rechecks that process's role before transmitting
  credentials. A stale callback receipt or reused public port cannot authorize
  an authenticated probe to an unrelated listener.

Existing execution is still one state-owning process. Replacing that process
requires idle handover; the current health contract reports
`rolling_worker_upgrade: false`. Application route implementations currently
remain in that execution process too; updating only the gateway does not update
those implementations. The change protects against gateway restart and crash,
not execution-process failure, operating-system restart or machine loss.

## Acceptance and remaining integration

The focused suites are `server/test_execution_*.py`. They distinguish pure
transport/control tests, controlled process fixtures and actual production
application processes. `server/scripts/check_execution_providers.py --backend
both` separately verifies real Codex and Claude using the server's Python
environment. It makes one model turn per selected provider with the existing
login and retains private local evidence. A fixture result must not be labeled
provider acceptance.

The current signed release passes native candidate-start failure, automatic
rollback and same-byte retry on macOS and Linux, including a retained dead
candidate receipt and normal retry without cleanup. It preserves chats/events,
synthetic provider/terminal credential files, Hub authority/messages and an
existing mutual-TLS peer, with authenticated reads and new writes afterward.
The macOS original beta.29 server gate explicitly selects Stable; it establishes
that native server route, not automatic channel promotion or every older app.

The exact packaged stable 1.0.3-to-1.0.4 journey passes with one Update action.
A separate pre-stop archive failure preserves the old PID and boot while normal
health callbacks observe the failed operation. Opening recovery preserves that
failure; one explicit coordinated Retry updates both the primary and continuously
expanded recovery status without Check or reopening Settings. Both components
must reach the target and release the maintenance hold before completion.
These packages use isolated discovery for migration acceptance. Separate public
delivery verification is recorded in [Coordinated updates](COORDINATED_UPDATES.md).

Retained real Codex/Claude evidence covers tools, subagents and approvals across
gateway loss. Its eight execution/provider modules are byte-identical in this
release, but the current migration fixtures make no new model calls. Earlier
native process-loss and reboot recovery proofs remain scoped to their recorded
source; they are not new final-build tests. Restoring an interrupted installer
after reboot does not establish live-turn survival through execution-process
death, reboot or machine loss. Pruning and uninstall must continue to preserve
any runtime or dependencies still owned by a process or recovery transaction.

For new turns to use a new execution generation while older turns continue,
provider actors still need to be extracted from the shared mutable application
store. Generation ownership, durable event/callback routing, approval ownership
and compatible state contracts are prerequisites for simultaneous generations.
The current release does not implement that architecture.

The public update remains one user action. These internal component stages must
not create another routine manual server-update step.

Older macOS releases did not record the configuration directory in their managed
service. Default-path installations retain the automatic migration path. A custom
installation from those releases needs one explicit migration with its original
`AGENTS_SERVER_INSTALL_DIR`, `AGENTS_SERVER_CONFIG_DIR` and `AGENTSDOCK_STATE_DIR`
values. The installer refuses a known path mismatch before staging; it does not
guess an unknown configuration path. New split services record all three roots
for subsequent updates.
