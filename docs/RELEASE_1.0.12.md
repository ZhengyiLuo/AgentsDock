# AgentsDock 1.0.12 stable candidate

This preparation combines the reviewed beta.7 changes with the workspace
picker correction merged in PR #187. The desktop app, signed npm runtime,
legacy server bridge and short CLI share version `1.0.12`. New artifacts must
be built from this committed source; beta artifacts are not relabeled.

## Included changes

- Empty workspace panes can select an already open chat using **Move here**.
  Moving preserves history and drafts; ordinary sidebar navigation still jumps
  to the chat's existing pane.
- Custom-to-normal Codex switching prepares native plaintext context on the
  original endpoint when necessary, preserving the native thread and history.
  Progress and failure remain visible without silently changing the endpoint.
- Force Send retains the selected message while its interrupt settles and
  delivers it once automatically, preserving neighboring queued messages.
- Codex and Claude support multiple saved side chats with independent drafts,
  history, activity, followups and cancellation.
- Imported Codex user messages no longer duplicate solely because blank lines
  were compacted. Genuine repeated messages remain.
- Retain main's workspace bounds, navigation and provider recovery fixes, and
  the coordinated-update corrections already shipped in beta.6.

## Validation and availability

Component CI and isolated native app checks passed for the picker fix. The
beta.7 line also has scoped signed-package, real Codex, native CLI and upgrade
receipts. These establish earlier results, not acceptance of new stable bytes.
The stable candidate requires its own source checks, signed packages, packaged
UI journeys and isolated update validation before a publication decision.

Live Claude side-chat acceptance still needs a valid isolated test credential.
Populated provider-history migration, active provider work plus queued messages
during updates, reboot and Windows updater coverage remain unestablished by
the prior fixtures. Normal-to-custom encrypted checkpoint portability is not
claimed fixed. Preserve these limits in candidate acceptance and release notes.

Use the established Apple and server signing identities; Windows remains
unsigned under the existing distribution policy. Preparation does not publish
packages or update or restart installed services. No mobile work is included.
