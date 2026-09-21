# Persistent execution during server updates

The implementation separates the public HTTP/WebSocket gateway from the process
that owns provider connections, running turns, approvals, tools, queues and chat
state. Replacing the gateway must leave the execution process untouched. Clients
reconnect and resume the existing event history; accepted commands are never
automatically replayed by the gateway.

This is an explicit development entry point, not the default installation or an
accepted production migration. The existing installer and coordinated npm updater
still use their established activation path. Rolling multiple execution
generations is not implemented.

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

Before enabling this layout in the ordinary one-update workflow:

1. Integrate both service lifecycles into the existing signed installer
   transaction. Preserve old-service idle handover, original credentials,
   server identity, state migration snapshots, Team Hub and secure-peer rollback.
2. Preserve worker runtime/dependencies while any process still owns them.
   Installer pruning and uninstall must understand both services and retained
   releases, including recovery after interruption or reboot.
3. Make the npm/app update coordinator distinguish gateway activation from
   execution activation. A pending execution upgrade is not a completed bundled
   update. Old and new clients need a compatible contract during that interval.
4. For new turns to use a new execution generation while older turns continue,
   extract provider actors from the shared mutable application store. Add
   generation ownership, durable event/callback routing, approval ownership and
   compatible state contracts before allowing simultaneous generations.
5. Exercise the installed native app against disposable launchd/systemd
   installations: active tools, native subagents, approval waits, reconnection,
   failed candidate, rollback, recovery and legacy migration. Verify the exact
   packaged commit after signing/packaging before enabling or releasing it.

The public update remains one user action. These internal component stages must
not create another routine manual server-update step.
