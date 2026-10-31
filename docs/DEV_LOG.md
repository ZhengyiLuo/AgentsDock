# Public development log

## 2026-10-31 - Workspace toolbar entry and contextual chat headers

- Move Create workspace from the chat menu to a matching icon button next to
  Scheduled jobs and Terminal. Ordinary chats show title and folder together,
  with their copyable provider session ID underneath. Workspace chats retain
  a single compact title/ID/action row without the folder chip.
- Workspace menus now offer Change folder as a hover/keyboard submenu, listing
  saved and in-use folders, including folders containing only pinned chats.
  Mark the current folder and preserve the existing per-chat update path.
- Native desktop acceptance on base `aa1b8c47` (development 0.2.0/build 86)
  used a test server: created a workspace from the toolbar, reloaded, closed
  back to ordinary mode, hovered the submenu, changed and restored a test
  chat's folder through production IPC/HTTP, and verified server state and
  the newly selected checkmark. Copied the full native session ID in both
  modes. Restored the original test layout. Checked both themes and a narrow
  simulated viewport; no provider turn, server restart or deployment was needed.
- Targeted header/layout/design regressions: 58 passed. Full desktop suite:
  5,532 passed, 5 skipped. TypeScript and production build/output verification
  pass. Native Windows/Linux UI and live cross-server switching were not
  repeated. Source and local development app only; no release published.
- CI follow-up: make the existing Team Hub maintenance-cancellation test use
  event-loop notifications instead of blocking executor observers. Keep real
  temporary-store snapshots, repeated cancellation and exact-fence assertions;
  use explicit release gates and a bounded watchdog independent of filesystem
  speed. The regression now runs with a single worker. Local before/after probes
  reproduce the old failure with a constrained executor and a slow snapshot;
  both pass with the revised synchronization. No server runtime behavior changed.

## 2026-10-29 - User-authorized mailbox tasks and editable drafts

- Existing authorized chat pairs now carry the originating user's exact task
  without requiring another `@` mention. Shared, idle-wake and busy-mail guidance
  tells the receiving agent to perform work covered by that instruction without
  requesting the same authorization again. Peer-written bodies, quoted wrappers,
  reply links and internal wakes remain distinct from user instructions.
- Native steering records the incoming user's text without generated attachment
  scaffolding. Goal steering suspends earlier task attestation at the actual
  transport write, binds the correction after a valid acknowledgement and keeps
  the existing provider owner, routes and tools. Previously accepted messages
  retain their original source instruction on exact retries. Empty or oversized
  ordinary tasks still deliver peer mail without truncated authorization.
- Inbox messages have an **Edit and send** action. It loads the complete message
  into the matching chat's composer, preserves existing drafts and attachments,
  and requires normal Send after review. The original received message and its
  agent-read state are unchanged. Late responses cannot populate another pane,
  chat or server. English and Simplified Chinese are included.
- Validation uses source-built Electron 0.2.0/build 86 in an isolated native
  offscreen profile, production IPC/authenticated HTTP and a disposable full
  server with real Codex. Repeated no-mention delegation produced the requested
  files without asking for authorization again. A quoted authorization lookalike
  did not authorize an additional file. Native app clicks appended full mail,
  preserved an existing draft across chat navigation, and sent user-edited text
  through normal Send to a real provider response. Light/dark and narrow English/
  Chinese presentation were inspected. The 229 focused server tests and 343
  desktop regressions pass, along with TypeScript and production compilation.
- Component/transport regressions cover unread/read messages, attachments,
  stale responses, forged provenance, size boundaries and retry identity. Those
  edge cases are not all repeated in the native UI; Claude-provider acceptance
  is not claimed. A separate pre-existing limitation was reproduced: an idle
  native goal resume can acknowledge steering but lacks the runtime capability/
  metadata needed by Chats, which fails before mailbox dispatch. This change
  does not claim to repair that distinct goal-resume lifecycle path. Full CI
  also exposed an invalid object-only goal authority fixture and a peer-panel
  assertion preceding its effect; use a real capability fixture and await the
  existing observer without weakening assertions or increasing timeouts.
  Changes are source-only and need a matching app/server update;
  no public release or production server restart was performed.
- Latest-main revalidation: integrated `d79677ef` without changing the new
  workspace/header behavior; the only merge conflict was overlapping log entries.
  On the matching source-preview test server, native Electron input exercised
  initial pairing, repeated no-mention Codex and Claude delegation, recipient
  file creation and replies. Reviewed mail appended to an existing draft;
  navigation preserved it, a manually edited Send reached a real provider,
  and split-pane drafting left the other pane unchanged. Checked dark English
  and narrow light Chinese rendering. Focused checks: 212 server tests and
  376 desktop tests pass; TypeScript and production compilation pass. Clarified
  the documented difference between oversized ordinary-turn fallback and
  explicit-reference delegation. Live goal steering, cross-server stale replies
  and attachment retention were not repeated in this acceptance pass; their
  automated coverage and the separate idle-goal limitation above still apply.
  No production restart, public release or mobile change.

## 2026-10-28 - Optional desktop workspaces and single-row chat headers

- Ordinary chats no longer manufacture a default workspace. The chat action
  menu's Create workspace entry enables the workspace/layout bar on demand.
  Preserve existing named and multi-pane layouts, while migrating the old
  implicit single-chat default back to ordinary mode. Closing the last
  workspace keeps the selected chat and its draft; no chat or directory is
  deleted. Workspace preferences remain scoped to the connected server.
- Keep title, folder, provider session ID/copy and right-side actions in one
  chat header, including three- and four-pane layouts. Remove the redundant
  pinned Chat/file row while viewing chat and the Changes entry altogether.
  File tabs and their Chat return action remain available when viewing a file.
- Source base: `aa1b8c47`; local desktop metadata: 0.2.0/build 86. Exercised the
  visible native Electron app with disposable chats on an authorized
  AgentsServer 1.0.11-beta.12 test instance: ordinary mode, explicit and repeated workspace creation, three/four
  panes, closing a workspace, last-workspace exit, and persistence on reload.
  Opened an existing file through the real preload/IPC/server boundary and
  returned to chat without the duplicate header. Checked dark and simulated
  light system appearance and narrow three-column layouts. Primary services
  were not restarted. No new provider turn was needed for this layout change.
- Regression coverage includes legacy preference migration, explicit opt-in,
  draft retention, per-pane menu ownership, hidden tab navigation and file
  return. Desktop suite: 5,528 passed, 5 skipped; build/license script tests:
  8 passed. TypeScript, production compilation and output verification pass.
  Native Windows/Linux presentation and live cross-server switching were not
  exercised; ownership/isolation remain covered by automated regressions.
  Available in source and the local development app only; not published.

## 2026-10-28 - Cursor compound tool IDs and live analytics acceptance

- Cursor CLI 2026.10.22 emits compound tool correlation IDs containing an LF
  separator. The server previously rejected these and interrupted otherwise
  valid tool-using turns. Recognize the observed bounded compound format and
  map its entire value to a deterministic, control-free digest. Preserve ordinary
  IDs, separate the encoded namespace from literal provider IDs, and continue
  rejecting empty, oversized and unrelated control-bearing IDs. Tool start and
  completion retain the same key without conflating distinct calls.
- Reproduced the native CLI format before the fix. Added a failing-before/passing-
  after parser regression and production-runner subprocess coverage. An isolated
  native offscreen Electron app connected through its production IPC/HTTP boundary
  to a source-built test server and real Cursor API key: two file reads completed
  with distinct paired IDs, their results appeared in the UI, and a subsequent
  tool-using follow-up succeeded. No production service was restarted or deployed.
- Repeated acceptance in the user-designated installed test instance, retaining
  its existing connection identity and configuration and changing only the parser.
  The visible native desktop app selected Cursor API key and a disposable working
  directory through the UI. Three real-provider turns and six paired tool calls
  (including four file reads) completed successfully, and reloading retained the
  results. The main service was left running unchanged; this test-only patch is
  not a published update.
- Removed the temporary local-launcher analytics cancellation used during
  automated QA; this was not shipped app code. With normal consent handling
  unchanged, three real UI submissions produced exactly three Cursor Custom API
  message events in the actual Mixpanel project's raw export. Verification must
  distinguish raw ingestion from dashboards that exclude test installations.
  Earlier intercepted events were not replayed or backfilled. No new payload
  fields, credentials or message content were added.
- Follow-up desktop acceptance found that `/model default` could remain in the
  composer after a successful API-model reset: the server returned its concrete
  default rather than null. Clear the command after that confirmed normalization,
  retaining existing failure/newer-draft/server-switch guards. Added a regression
  that fails before this correction. No prompt or provider turn is submitted.
- Validation: 120 focused Cursor parser/runner/API-key regressions, 577 desktop
  regressions, TypeScript and Electron production build/output verification pass.
  Source repair is not an installed server update: existing services need to load
  the new parser before their tool-using chats benefit.

## 2026-10-28 - Custom API message metrics and local model commands

- Desktop accepted-message analytics now includes an allowlisted connection
  kind (`default` or `custom_api`) when explicitly known at submission. Keep it
  separate from the five Agent families; omit legacy/unknown values. No model,
  endpoint, credential, account, chat ID or message content is collected.
  Update the event catalog and source privacy disclosure accordingly.
- Typed `/model` opens the existing model picker; `/model <ID or unique label>`
  updates the session through the same model/effort logic as that picker.
  Commands never enter prompt composition or count as sent messages. Unknown,
  ambiguous and locked choices are rejected without starting a turn. Preserve
  attachments, failed-command drafts and newer drafts; ignore late results
  after switching servers. Keep existing slash skills and ordinary text intact.
- Based on main `9a750c7a`; source-built desktop metadata remains 0.2.0/build 86.
  An isolated native offscreen Electron app connected to a test AgentsServer
  1.0.7-beta.11 reproduced the old typed command starting a Claude turn without
  changing the selected model. After the fix, real keyboard input changed
  Claude and Codex models through production preload/IPC/HTTP and server
  persistence without adding turns. Subsequent real provider messages returned
  expected replies. Repeated switching, default reset, reload persistence,
  unknown-model draft retention and the existing picker were also exercised.
- Captured and cancelled test analytics before network transmission: default
  Claude/Codex messages included the new property; model commands did not emit
  message events. Custom API classification across all five Agents, Custom API
  accepted sends, queued/failed sends, stale-response ownership and failure
  rollback were verified with deterministic tests. The isolated test service
  had no configured Custom API endpoint; see the user-acceptance follow-up below.
  No production analytics events were sent.
- 576 focused regressions, TypeScript and the production build/output check
  passed. No server/mobile changes, release, deployment, or website publication.
- User-acceptance follow-up: at the user's request, gracefully closed the prior
  local source app and launched this branch with its existing profile and cache.
  Rebuilt and verified the loaded renderer asset, online connection, composer
  and model picker through native input. No server restart or release occurred.
  The user's subsequent live Cursor Custom API submission produced one accepted
  `message_sent` event with `backend: cursor` and `connection_kind: custom_api`.
  This verifies client submission acceptance and classification, not provider
  completion. Test telemetry is captured locally and cancelled before Mixpanel
  submission. Other live Custom API backends and a live queued-send scenario
  remain untested; their deterministic coverage is described above.

## 2026-10-27 - Honest native sign-in status in My Agents

- Separate credential discovery from verified native login. A reported
  authentication failure now overrides retained credential files; detected but
  unverified credentials show a neutral status rather than a connected check.
  Native and Custom API cards remain independent. Keep send-time verification
  and retries available after credentials are renewed outside the app.
- Add English/Chinese guidance and regressions for expired credentials, passive
  detection, latest-diagnostic selection, Recheck, recovery and independent API
  connectivity. No provider login, token storage or server admission changes.
- Based on main `eb165198`; availability is local source/build only. An isolated
  offscreen Electron app reproduced the previous false Connected label using a
  real authenticated server catalog, then verified the corrected CLI status,
  login guidance and reopening My Agents through the production renderer,
  preload, IPC and client transport. Inspected English light/dark and Chinese
  narrow-window layouts. No server deployment or user-app replacement.
- 86 focused checks, TypeScript and production compilation passed. One full
  regression run passed 5,484 tests (5 skipped), plus 8 packaging/license checks.
  A repeat full run hit an unrelated existing SecurePeerPanel timing assertion;
  all 156 tests in the focused/auth and secure-peer follow-up run passed. That
  repeat-suite failure is recorded, not counted as a successful full run.
- Live credential renewal and an actual post-login provider request remain
  pending. Recheck failure/recovery uses component fixtures; the live legacy
  server's forced catalog refresh was deliberately not invoked because it may
  initiate an unrelated provider auth handoff. Real-app inspection used passive
  reads and did not modify credentials or run agent tasks.
- Follow-up: launched the complete compiled Electron app interactively with an
  isolated cache and existing connection metadata for user acceptance. Native
  clicks opened My Agents and expanded Claude. The server now reported a
  successful native authentication, and the CLI card correctly showed Signed
  in rather than relying on credential presence. This observes recovery; the
  login operation and provider request were not initiated by this test. All 86
  focused checks, TypeScript and compilation passed again. User chat acceptance
  is pending; no server restart, deployment, publication or PR was performed.
- PR validation: repeated the full suite successfully (5,484 passed, 5 skipped,
  plus 8 packaging/license checks), TypeScript and production compilation.
  In an isolated native offscreen app, opened My Agents, inspected the verified
  CLI status, then typed and sent a short no-tools prompt to an exact-ID-bound
  disposable Claude chat. The real server/provider returned the expected reply
  and the renderer displayed it without errors. Screenshots stay local; account
  metadata is not attached to the public PR. Login renewal itself remains a
  native-provider operation, and this display fix does not prevent OAuth expiry.

## 2026-10-25 - Mobile provider pre-merge validation

- Integrated main `3ac069e`; only the development log required conflict
  resolution, retaining both sets of entries. Updated older source-contract
  tests and the composer fixture for the additional providers.
- All 428 mobile MJS checks passed, with one generated-native-metadata check
  skipped. Session creation, provider selection, recovery, optional permissions,
  transport, cross-chat references, notifications and Android discovery tests
  passed, along with TypeScript and iOS/Android production JavaScript exports.
- Maestro operated the real iOS simulator through Settings, update destinations,
  My agents and Gemini chat navigation. Home creation retained Gemini Custom API
  and Default permissions, confirmed through authenticated server readback.
  Initial scripted attempts missed a navigation tap and a keyboard-obscured
  row; waiting for navigation and bringing the row fully into view completed
  the flow. These failed attempts are not counted as passing acceptance.
- The user confirmed the refreshed physical iPhone Dev build works. Existing
  cross-agent receipt checks still show no duplicate mail or pending QA work.
  Store handoff, signed APK installation and Android provider end-to-end checks
  remain outside this validation. No release or TestFlight upload was performed.

## 2026-10-25 - Mobile Gemini identity and recoverable new-chat defaults

- Embed the desktop multicolor Gemini SVG in the mobile bundle, without a
  network image dependency or monochrome tint. Light and dark iOS simulator
  screenshots show the multicolor mark. The dark-mode scripted scroll to a
  specific QA row timed out; direct screenshot inspection verified other
  Gemini rows instead.
- Home new-chat creation keeps an available inherited provider/mode, otherwise
  randomly chooses from available choices across all five agents. Report no
  available agent only when the candidate set is empty. Preserve model and permissions after
  message failures; an earlier local fallback based on turn failure was too
  broad and has been removed. On confirmed pre-creation API/workspace validation
  failures, try remaining choices at most once each; never
  retry ambiguous writes, authentication failures, or explicit provider forms.
  Reset provider-specific defaults when switching; preserve existing chats.
- Confirmed unavailable native diagnostics override stale credential presence;
  Custom API and native modes retain independent availability. Regression
  coverage includes every agent-to-agent fallback, all-unavailable cases,
  same-agent API fallback, and bounded retries across rejected candidates.
  Ten randomized session-creation runs passed; actual simulator creation also
  verified fallback to OpenCode after a confirmed invalid-workspace rejection.
- Actual iOS simulator testing against the isolated beta.12 server reproduced
  a deleted Gemini workspace, then verified fallback creation and a real Claude
  reply. Mobile mention selection granted routes to all five providers. Codex
  sent mail to Claude, Cursor, and OpenCode and read their explicit replies.
- Gemini cross-chat preflight was blocked by native workspace trust, while
  ordinary replies worked. After explicit approval to trust only the isolated
  QA directory, actual simulator mention/send flows exercised Gemini against
  Codex, Claude, Cursor, and OpenCode in both initiating directions, with native
  one-time tool approvals and explicit return acknowledgments. No permission
  policy was disabled. Initial Claude initiation used a legacy target index
  and failed; an explicit route-discovery retry succeeded. This first-attempt
  provider tool-use failure remains a limitation, not a passing first attempt.
  Receipt checks found exactly one request and one acknowledgment per initiating
  direction, with no duplicate messages or pending QA turns/approvals.
- Simulator acceptance also verified that after a Gemini communication error,
  Home new-chat creation retained Gemini and received a real ordinary reply.
  An intermediate retry at the server default directory exposed an API-auth
  override; confirmed invalid-directory creation still falls back to another
  provider rather than silently changing Gemini's authentication.
- Session-creation and chat-reference regressions, 51 focused component/source
  checks, TypeScript, and iOS production JS export passed. Availability is local
  development only; no release or TestFlight build was published.

## 2026-10-25 - Mobile optional agents and discoverable app updates

- Add capability-gated OpenCode and Gemini choices, API-aware model catalogs,
  saved selections, permissions, and new-chat inheritance. OpenCode free models
  remain selectable without login credentials; Gemini uses configured APIs and
  its required client protocol. Preserve bound API catalogs in chat details.
- Add run-owned Gemini approvals with native-control authentication, duplicate
  response protection, foreground/event invalidation, and server-generation
  fencing. Do not expose unsupported provider reloads or Gemini forks.
- Move App updates into the primary Settings categories on both platforms.
  iOS opens App Store or TestFlight. Android discovery now reads bounded release
  pages; desktop releases can no longer hide Android updates after page one.
  Failed checks do not persist a successful up-to-date cache entry.
- Actual iOS simulator acceptance against AgentsServer 1.0.11-beta.11 verified
  OpenCode free-model and Custom API replies, Gemini replies and contextual
  follow-ups, permission deny/allow-once with file readback, and OpenCode model
  and Plan-permission inheritance. One default OpenCode model returned an empty
  response in its native transcript too; an explicitly selected free model and
  the configured API returned normally. No server code or deployment changed.
- Settings/agent/approval/interaction component checks, provider and transport
  regressions, TypeScript, iOS production JS export, and a local Android debug
  APK build passed. Real public release discovery found an Android candidate on
  page two. Android updater Settings, offline failure, and successful retry
  were exercised on an emulator. iOS Settings retained both agents and update
  destinations in dark mode.
- Availability: local development builds only, based on main `7d94b05`.
  iOS store installation is not testable on a simulator; physical-device
  App Store/TestFlight handoff and a signed production APK upgrade remain
  unverified. Android provider end-to-end acceptance remains pending.

## 2026-10-25 - Mobile new-chat defaults follow the last open chat

- Inherit the last open chat's agent, native or Custom API mode, model, effort,
  and agent-specific permissions when creating a chat from Home. Keep saved
  preferences as the fallback when no valid chat is selected on that server.
- Resolve omitted permissions with a bounded detail read before creation;
  failed reads remain retryable instead of silently resetting permissions.
  Preserve duplicate-tap protection and connection-generation checks.
- iOS simulator acceptance reproduced Claude reverting to Codex on the previous
  client, then verified Claude Plan and Codex read-only/on-request inheritance
  through the actual app with authenticated server readback. Temporary chats
  were removed without starting provider runs.
- Session-creation regressions, 39 interaction tests, TypeScript checks, and
  iOS/Android production JS exports passed. Custom API selection, Cursor,
  lookup failure, and server-switch races have automated coverage; Android
  interaction and physical-device acceptance were not exercised for this change.

## 2026-10-25 — Codex child cancellation acknowledgement (#85)

- Keep a localized Stop subagents action available for an idle Codex chat with
  authoritative, owned live children, without changing Send into Queue. Ignore
  forked history and unrelated roots; refresh the selected chat's child snapshot
  once after stopping, fenced by the current server and timeline subscription.
- Reconcile children already terminal when Stop reaches the native runtime.
  Report pending children and interrupt errors instead of treating parent
  completion as successful child cancellation. Recheck ownership after native
  reads and preserve newer lifecycle transitions during stop confirmation.
- Source: `fix/codex-subagent-stop-85`, based on `7d94b05b`; local development
  build only. Both desktop and server changes are required; no release published.
- Actual visible native Electron acceptance exercised composer submission,
  native Codex child execution, Stop, reopening the chat, and repeated use.
  Native provider records confirmed interrupted child turns; the stop control
  cleared, an independently running control chat continued, and another pane's
  draft was retained. The actual IPC/authenticated HTTP/native-provider boundary
  was exercised without a stub provider.
- The installed native provider retained the parent turn until child completion
  or interruption, even after emitting its final reply. The fully idle-parent
  case, stale terminal state, missing runtime, concurrent state/ownership changes,
  pending errors and legacy response compatibility have regression coverage;
  that historical idle-parent lifecycle was not recreated end-to-end.
- Pre-merge validation: 1,190 focused desktop tests and 240 focused server tests passed;
  TypeScript and Electron production compilation passed.
- Updated the compact-composer layout contract to recognize the shared Stop
  label, including the idle-child label; action placement and sizing are unchanged.
- Simplified Chinese consistently calls subagents “子 Agent” in the inspector,
  limits, lifecycle labels and Stop feedback. Localize the inspector heading and
  unnamed display fallback without changing provider names, identities or chat
  content. English remains unchanged. Actual native-app Settings language
  switching verified the Chinese heading, empty state and per-chat limit text,
  then restored English. The terminology follow-up passed 308 focused tests,
  TypeScript checks and the Electron production build; no server restart required.

## 2026-10-25 — Remove host-imposed provider restrictions

- Allow native background shell commands and Claude scheduling tools. Remove
  prompt rules forbidding detached work, full-history subagent forks, other
  integrations and ordinary use of the chat terminal. Native permissions and
  the exact authenticated owner of AgentsDock helpers remain intact.
- Remove default execution silence deadlines and automatic retained-connection
  eviction. Idle warnings remain informational; Stop and transport failures
  still settle owned work. Explicit operator timeouts and retention limits
  remain effective. Available-memory launch floors now default to disabled,
  matching the existing opt-in concurrency limits.
- Remove the internal Claude MCP two-call ceiling while preserving mutation
  deduplication and checking authorization before replay. Allow Codex Side chat
  subagents with verified native ancestry; inherited parent agents do not gain
  side-chat authority. Retain idle side conversations until explicit cleanup,
  and use the existing request-body bound instead of a separate 8,000-character
  question limit in both desktop validation and the server. Older servers'
  advertised limits remain honored by the desktop.
- Allow background-terminal inspection and explicit termination during a Codex
  turn without replacing its owner. Submit confirmed shell commands through
  that same live owner and notification stream; native command receipts retain
  the owner until accepted commands finish, including a late native shell turn.
  Register requests at the actual transport write boundary and do not replay
  uncertain delivery. A real service-managed source checkout can
  restart without the official installer directory layout. Remove the normal
  restart cooldown; in-flight request coalescing and exact service ownership
  remain in place.
- Real offscreen app/IPC/authenticated HTTP acceptance with Claude Code 2.1.303
  verified native background Bash and detached workers continuing after the
  reply, native schedule creation and retention through the next turn, exact
  schedule deletion and reuse of the same native connection. This verifies
  schedule retention, not delivery of a future scheduled wake into the app.
- Native Codex 0.156.1 acceptance verified a saved Side chat's full-history
  child, inherited context and file work while the parent completed normally;
  original parent readback confirmed completion. Active terminal list,
  terminate and clean used the exact original owner. Approval ancestry and
  closed-owner rejection have regression coverage; an actual child approval
  dialog was not required by the selected native permissions.
- Actual offscreen app restart acceptance used a disposable named launchd
  service and source checkout. Two confirmed requests 4.7 seconds apart each
  returned acceptance and reconnected to a new process with the same durable
  server identity. The previous source reproduced the disabled Restart button.
  Test services, processes and credential copies were cleaned up.
- Preserve native background task accounting after a Claude reply. Inspect
  retained Side chat descendants when preparing an idle-update snapshot, and
  check the same native generation before using that snapshot. Active work
  delays an idle update; idle retained conversations do not. Cancelling an
  optional Claude context sample leaves its live connection and tasks intact.
- Actual offscreen app/IPC/HTTP acceptance with Codex verified a confirmed shell
  command during an existing native tool, one normal completion of the original
  turn and a successful follow-up. A separate Side chat journey verified a
  full-history child, an immediate reply, a context-preserving follow-up, and
  the child continuing after the main chat completed. The production idle-update
  snapshot reported only that child until it finished, then cleared all work
  labels. Original credentials were unchanged and isolated copies removed.
- Focused server suites cover disabled deadlines, positive configured limits,
  long-lived native connections, ownership, concurrent helper calls, side
  context retention and restart races. Cursor/OpenCode execution tests use
  real subprocess pipes with fixture CLIs; live provider acceptance for those
  adapters is not claimed. No live server deployment or public release.
- App source `492360f7`, paired server source `1b07dbbe`; accepted local macOS
  arm64 0.2.0/build 86. TypeScript, all 5,460 desktop tests (five skipped),
  production compilation, bundle audit, Developer ID signing and strict
  signature verification passed. The exact packaged archive repeated the live
  Codex active-shell and subsequent-message journey through production IPC and
  authenticated HTTP. All 91 compiled assets matched the archive, with no
  renderer errors. Archive SHA-256 remained
  `c71bd2ccee0c7fdc7387804ff075fd85c82f065dfb4ec929fbf042cd6250cc73`
  before and after acceptance. Packaged code ran through an isolated native
  Electron bootstrap; signed-executable launch and Gatekeeper were not tested.
  No installed app or live server was replaced or restarted.

## 2026-10-25 — Set and replace Claude goals during active work

- Remove the desktop busy-turn disable and route active goal requests through
  the owning Claude session. Native queue admission is acknowledged separately
  from application of the goal. A running tool and its original subagents
  continue, including when replacing a goal that is keeping Claude running.
- Surface later native refusals in the dialog and beside the composer. Match
  each pending goal to its exact run and native command receipt; stale history
  and receipts from another request cannot settle it. Goal input remains
  separate from the existing Force Send lane.
- Explicit Stop withdraws the queued goal and uses native task controls for
  owned commands that become background tasks during interruption. Wait for
  their actual terminal receipts before retiring that provider connection.
  Clear & stop then clears the native goal through the normal idle path.
  Successful user-requested cancellation settles quietly; genuine refusals and
  unconfirmed cancellation remain visible errors.
- App source `e1cd724c`, server source `0392ba4c`; local macOS arm64
  0.2.0/build 85. TypeScript, all 5,458 desktop tests (five skipped), production
  compilation, bundle audit, Developer ID signing and strict signature checks
  passed. The server SDK, runner, goal-route and goal-projection suites passed
  226 tests. Focused regressions cover native refusal, uncertain delivery,
  concurrent Force Send, stale results and cancellation-control failure.
- The exact packaged archive passed native offscreen interaction through
  production IPC and authenticated HTTP into an isolated server with real
  Claude Code 2.1.303. Set a goal while parent and child tools were running,
  replace it while the original child remained active, and observe the same
  native session reach Goal achieved after both original tasks completed.
  The archive and signature remained unchanged, with no JavaScript errors.
- Native SDK Stop acceptance verified cancellation of the queued goal, original
  process exit without completion outputs, and a successful subsequent tool
  turn. Delayed superseded results and cancellation-control errors were checked
  with focused fixtures after that native run. Actual app Stop and Clear & stop
  also passed through production IPC/authenticated HTTP with real Claude:
  original process IDs exited, pending goals disappeared, cleared native state
  was read back, and each chat accepted a successful subsequent message without
  reviving the stopped work. The final Clear run verified quiet cancellation.
  Test profiles and processes were cleaned up. Signed-executable launch and
  Gatekeeper were not exercised.
- This is a paired app/server source fix and local package, not an installed
  update or published release. Setting a goal before the provider has bound its
  initial native session remains outside this active-session acceptance.

## 2026-10-23 — Quieter workspace selection

- Replace persistent blue stripes on workspace/chat/file tabs and focused grid
  panes with neutral selected-tab backgrounds and medium-weight titles. The
  focused pane's selected tab has a slightly stronger neutral background.
- Resize handles use a neutral hover treatment; keyboard focus retains a clear
  outline. Tab order, drag/reorder, pane selection and file state are unchanged.
- Source `88372526`, local macOS arm64 package 0.2.0/build 85. TypeScript,
  production compilation, all 5,455 desktop tests (five skipped), bundle audit,
  Developer ID signing and deep strict signature checks passed.
- Native offscreen checks exercised the exact packaged archive: select chat and
  file tabs across three/four panes, retain open files while focusing another
  pane, resize to the desktop minimum, and inspect dark/light appearance.
  Native keyboard navigation retained a visible focus outline. Production IPC
  and authenticated file reads used isolated server state; no provider ran.
  All 91 compiled assets matched; archive/signature unchanged, no JavaScript
  errors, and test processes/credentials cleaned up. Signed-executable launch
  and Gatekeeper were not exercised.
- Local desktop presentation change only. No server change, installed-app
  replacement or publication is included.

## 2026-10-23 — Keep queued messages from crowding the split-pane draft

- Give queued messages, attachments and notices a separate scrolling area above
  the draft. Short panes can grow the composer instead of forcing everything
  into a 75-pixel box. Keep the text field and Send/Stop toolbar visible together;
  smaller panes retain a full editable line and scroll longer drafts internally.
- Allocate the composer from the space remaining below the goal/context controls.
  Preserve the same draft, focus and selection when queued messages arrive or
  disappear. Single-pane queue behavior and sending contracts are unchanged.
- Source `6175fb76`, local macOS arm64 package 0.2.0/build 85. All 5,455
  desktop tests passed (five skipped), with TypeScript, production compilation,
  bundle audit, Developer ID signing and deep strict signature verification.
  An existing asynchronous file-picker focus assertion now waits for focus;
  its targeted rerun also passed after the initial full-suite timing failure.
- Native offscreen baseline reproduced a queued message pushing the input fully
  outside its visible area. The exact packaged archive then passed queue
  submission, edit/save with authoritative readback, removal and repeat use,
  retained multiline drafts, goal/alert pressure, three/four panes, divider
  dragging, light/dark and narrow-window checks. Draft and queue scroll
  independently; Send/Stop remain inside the tested panes.
- These exercised production IPC, authenticated HTTP and WebSockets in isolated
  server state with synthetic held turns; no provider ran. All 91 compiled
  assets matched the package, and its archive and signature remained unchanged.
  The archive ran through stock Electron offscreen; signed-executable launch
  and Gatekeeper were not exercised.
- App-only local trial; this layout fix needs no server update. No live service,
  installed app or published release is changed.

## 2026-10-23 — Reorder workspace tabs and preserve Claude tasks on Force Send

- Replace boxed workspace tabs with a flat rail and an active underline. Drag
  tabs to reorder, or use Alt-Shift-Left/Right. Remember order per server without
  changing selection, drafts, files or pane layouts. Keep the active tab visible
  after resizing and retain the adjacent new-workspace button during overflow.
- Claude Force Send uses native queued-input acknowledgement and Send now,
  preserving the same process, logical run, tool authority and tracked children.
  It no longer falls through Stop for ordinary user follow-ups. Explicit Stop
  keeps its cancellation behavior. Unsupported native protocols leave input
  queued; uncertain delivery is never replayed or treated as permission to
  terminate children. Proven prewrite cancellation restores the unsent input.
- Accepted follow-ups appear once in desktop/shared history, including during
  scheduled work. Recovery consumes only acknowledged input and retains a
  truncated delivery record without resending it. New route grants/provider
  actions still require their own turn; Force Send retains its original owner.
- Source `be4b6806`, local macOS arm64 package 0.2.0/build 85. All 5,457 desktop
  tests passed (five skipped), with TypeScript, compilation, bundle audit,
  Developer ID signing and deep strict verification. The scoped server SDK,
  runner, queue, goal, history and projection suites passed 518 tests.
- Real Claude Code 2.1.296 and 2.1.303 probes submitted Force Send during a
  foreground Bash command. An existing native Agent survived, completed and
  woke the parent; acknowledgement took approximately 0.7 and 1.2 seconds.
  A separate explicit Stop probe observed killed/stopped child receipts.
  These exercised the candidate SDK adapter in disposable state; server queue
  races and workflow receipts used isolated fixtures, not live user chats.
- The exact packaged archive passed native offscreen drag/keyboard, rename,
  close/add, draft/file/layout retention, per-server persistence, full restart,
  narrow overflow, resize and light/dark checks through real authenticated
  HTTP/WebSockets and production IPC. All 91 compiled assets matched; archive
  and signature remained unchanged. This ran stock Electron with the packaged
  archive, not the signed executable or Gatekeeper.
- Local trial only: no app installation, service update/restart or publication.
  Workspace tabs work with the existing server; the Claude Force Send fix
  requires installing the paired server source.

## 2026-10-23 — Readable syncing status in compact chat panes

- Place the neutral syncing status beside the working-directory control, outside
  the compact input's scrolling area. Keep the full input line and toolbar
  visible without increasing the desktop composer's height. Shared chats show
  the status without exposing the working-directory control.
- Source `99d50432`, local macOS arm64 development package 0.2.0/build 85.
  Placement regressions failed before the fix; all 5,430 desktop tests passed
  (five skipped), plus TypeScript, production compilation, bundle audit,
  Developer ID signing, required entitlements and deep strict signature checks.
- Native offscreen acceptance reproduced the clipped input in the previous
  package, then verified a full input line, readable status, accessible toolbar
  and retained typing through reconnection. Three/four panes, completed goal
  banners, light/dark themes and narrow windows passed through production IPC
  and authenticated HTTP/WebSockets in isolated state. All 91 compiled assets
  matched; archive and signature remained unchanged.
- Reconnecting activity was a disposable fixture; no provider ran. The packaged
  archive ran in stock Electron offscreen, without launching the signed executable
  or exercising Gatekeeper. This is an app-only local trial; no server update is
  required. No installed app, live service or published release was changed.

## 2026-10-23 — Keep every visible chat receiving live updates

- Remove the obsolete two-stream eviction from the desktop service. Opening a
  third or fourth pane now preserves every visible chat's history request and
  live connection. Explicit pane/workspace cleanup still releases hidden chats;
  late events from retired subscriptions remain fenced to their original owner.
- Clear ended-subscription bookkeeping so explicitly selecting a cached chat
  can reconnect it. Reconnecting streams keep their owner; this adds no polling
  or automatic retries.
- Source `50c89366`, local macOS arm64 development package 0.2.0/build 85.
  Regression tests reproduced dropped primary history/completion and stale
  subscription bookkeeping before the fixes. All 5,429 desktop tests passed
  (five skipped), plus TypeScript, production compilation, bundle audit,
  Developer ID signing, required entitlements and deep strict signature checks.
- Native offscreen acceptance reproduced missing primary replies in the old
  package, then verified all three/four panes receiving new assistant, reasoning,
  tool and completion events through production IPC, authenticated HTTP and
  WebSockets. Working, Running and Stop appear during held fixture turns and
  clear on completion. Concurrent hydration, workspace switching, hidden-pane
  cleanup and catch-up after reopening passed. All 91 compiled assets matched;
  the packaged archive and signature stayed unchanged.
- Provider events and active-run ownership were synthetic fixtures in disposable
  server state; no provider ran. The actual packaged archive ran in stock
  Electron offscreen; signed-executable/Gatekeeper launch was not exercised.
  No installed app, running service or published release was changed. This is
  an app-only local trial using existing contracts; no server update is required.

## 2026-10-23 — Three-column chat workspaces

- Place the new-workspace button immediately beside the workspace tabs. Keep
  it accessible when tabs overflow and reveal the newly selected tab.
- Add three full-height, independently resizable columns alongside the existing
  three-pane split. Remember each workspace's layout and widths separately;
  retain pane assignments, drafts and file tabs when changing arrangements.
  Keyboard focus navigation follows the visible columns. Command-Control-Left
  and Command-Control-Right cycle workspace tabs, including from the composer.
- Show each pane's chat title once in its pinned tab. Double-click that tab or
  use Rename chat in the actions menu to rename it; keep the folder control
  accessible in the toolbar. Selecting a chat already assigned to a workspace
  returns to that workspace and focuses its pane instead of opening a duplicate.
- Local macOS arm64 package: source `7187ce27`, development version 0.2.0/build
  85. All 5,425 desktop tests passed (five skipped), followed by TypeScript,
  production compilation, bundle audit, Developer ID signing, required
  entitlements and deep strict signature checks.
- Native offscreen acceptance used the packaged archive through production IPC
  and authenticated HTTP against isolated services. Verified both three-pane
  arrangements, both draggable dividers, keyboard resizing, workspace shortcuts,
  sidebar jumps without duplicate placement, title consolidation and real rename,
  pane-local file opening, retained drafts/layouts after reload, tab overflow and
  narrow presentation. All 91 compiled assets matched; archive and signature
  remained unchanged. No provider ran. Signed-executable/Gatekeeper launch was
  not exercised; this remains a local, unnotarized trial.
- Scope: app only, using existing server contracts. No server update is required;
  no installed app, live service or published release was changed.

## 2026-10-23 — Cron unread grouping on older servers

- When cron inclusion is off and an older server omits output provenance, use
  the existing scheduled-job list to keep registered cron chats in their folders
  or pinned section. Visible ordering and keyboard navigation use the same rule.
  No additional requests, transcript scans or polling are needed.
- Preserve saved inclusion settings, manual unread overrides and unread dots.
  Newer servers continue distinguishing ordinary replies from cron output.
  Older servers cannot distinguish replies within a mixed-use scheduled chat;
  their fallback applies to the registered chat until inclusion is enabled.
- Four new regressions failed before the fix. All 281 focused sidebar, session
  and store tests pass. The local macOS arm64 package uses source `13193ad2`,
  development version 0.2.0/build 85. All 5,398 desktop tests passed (five skipped),
  followed by TypeScript, production compilation, bundle audit, Developer ID
  signing, required entitlements and deep strict signature checks.
- Native offscreen acceptance reproduced the failure in the prior packaged app,
  then verified the corrected signed archive against an isolated authenticated
  server returning missing/null legacy provenance. Settings on/off, preserved
  saved choices after restart, pinned placement, ordinary and manual unread,
  keyboard order, server switching, offline cached jobs and reconnect passed.
  Auxiliary job-add/remove fixtures used the existing read-only jobs-list IPC
  through real HTTP; the existing background polling cadence was not changed.
  All 91 compiled assets matched and archive/signature remained unchanged.
  No scheduled job or provider ran. Signed-executable/Gatekeeper launch remains
  untested; this is a local unnotarized trial, not a publication or installation.
- Scope: app compatibility fix; no server update or live-state change required.

## 2026-10-23 — Tabbed chat workspaces and pane-local file tabs

- Add named workspace tabs with one, two, three or four chat panes. Three panes
  use a tall left pane and stacked right panes; four use a resizable grid.
  Each pane owns its chat and file tabs, so opening a file leaves other chats
  visible and preserves the conversation in its pinned tab.
- Remember workspace layouts, focused panes and divider sizes per server.
  Retain chat drafts, scroll positions and file edits while switching workspaces,
  servers and layouts; reducing the pane count keeps hidden chat assignments.
  Keyboard pane navigation follows the visible grid and file commands target
  the focused pane.
- Focused renderer, editor and store regressions, TypeScript and production
  compilation pass. Native offscreen desktop acceptance exercised all four
  layouts, mouse and keyboard dividers, pane-local file reads and saves, dirty
  edits, drafts, exact scroll restoration, named workspace switching, server
  isolation and app/server restart persistence through real IPC and authenticated
  HTTP in disposable state. Provider events were synthetic. Narrow-pane headers
  retain compact controls without wrapping their provider status. Escape, focus
  loss and navigation clear the drag highlight immediately.
- Local macOS arm64 package: source `fe26f598`, development version 0.2.0/build
  85. All 5,393 desktop tests passed (five skipped), followed by production
  compilation, bundle audit, Developer ID signing, required entitlements and
  deep strict signature checks.
- Packaged native offscreen smoke loaded main, preload and renderer directly
  from the signed archive; all 91 compiled assets matched. Pane-local file
  reads/saves, four-pane tabs, per-server state, app restart, retained drafts,
  native drag cancellation and narrow light layouts passed. The archive and
  signature were unchanged after testing. Signed-executable/Gatekeeper launch
  was not exercised; this remains a local, unnotarized trial build.
- Scope: desktop only, using existing server contracts. No server update is
  required for the tabbed grid. This local trial does not publish a release or
  replace an installed app.

## 2026-10-23 — Local desktop package with sidebar controls

- Built macOS arm64 from `29951a90`, combining the sidebar settings with the
  merged TIFF-preview and split-chat file-opening fixes. Development metadata
  remains 0.2.0/build 85; this is a local package, not a published release.
- The full desktop suite passed: 5,367 tests, five skipped. TypeScript,
  production compilation, bundle audit, Developer ID signing, entitlements
  and deep strict signature checks passed.
- Packaged native offscreen checks loaded main, preload and renderer directly
  from the signed archive. All 91 compiled assets match. The three sidebar
  switches, cron grouping, running-chat placement and restart persistence
  passed through real IPC and an isolated authenticated server. The archive
  and signature remained unchanged. Provider output was synthetic; no provider
  or scheduled job executed. Signed-executable/Gatekeeper launch was not tested.
- Keep metadata-free server summaries sparse, fixing the existing summary-size
  regression without changing its threshold. Known counters and pending-recovery
  nulls remain explicit; 44 targeted server tests pass. The packaged smoke used
  this corrected server source.
- Availability: local app package only. The grouping switches work with older
  servers; distinguishing cron output requires the matching server patch.
  Nothing was installed, published or deployed.

## 2026-10-22 — Configure Unread and Running sidebar sections

- Add three General settings remembered locally per server: Unread chats at the
  top (on by default), Include cron jobs in Unread (off), and Show Running
  section (on). Hidden sections return chats to their saved folders or pins;
  unread dots and activity indicators remain visible. Active chats stay out of
  Unread even when Running is hidden. Keyboard navigation follows the same order.
- Distinguish scheduled output from ordinary unread replies on the server. A
  later cron result cannot hide an unread ordinary reply, and explicit Mark
  unread still promotes the chat. Imported history does not count as a new
  ordinary reply. Existing read cursors, folders and pins remain unchanged.
- Recover existing provenance once in a background worker and persist a journal
  checkpoint for subsequent restarts. Unknown provenance and older servers keep
  the previous unread behavior; catalog, session-list and turn-admission paths
  do not wait for recovery. Include the helper in server installation and
  packaging inventories.
- Verification: 474 focused desktop tests, 14 unread-provenance regressions,
  related server projection/provider tests and runtime archive checks pass.
  TypeScript, Python compilation, production Electron compilation and entry
  verification pass. Native offscreen Electron exercised the controls through
  production IPC and authenticated server transport, including active unread
  placement, manual unread, mixed replies, keyboard navigation, narrow/light
  layouts, profile switching and app/server restarts. Final server checks also
  recovered legacy metadata without changing read cursors or event journals.
  These used synthetic provider events in disposable state; no live provider
  or scheduled job ran. A packaged release and other native platforms were not
  exercised.
- Availability: source changes for desktop and server; cron filtering requires
  both. No release, installation or live-server deployment is included.

## 2026-10-22 — TIFF previews and split-chat file opening

- Desktop attachment and workspace viewers render TIFF files through a PNG
  preview of the first page. Portable background workers decode the image;
  downloads and native Open preserve the original file. Failed previews retain
  download recovery. Queued previews retain stream backpressure instead of
  buffering every visible TIFF, and remote transfers gain no new timeout.
- Split chat delivers a fresh file-open event: Chromium otherwise drops the
  replay of the original stopped event. Delivery also waits for saved workspace
  tabs and mount effects, so restoration cannot select the prior tab over the
  clicked file. Both conversations and their drafts remain in place.
- Validation: the full desktop Vitest suite passed (5,340 tests; five skipped),
  followed by 42 media tests and 201 split/workspace tests on the final changes.
  Eight build/license script tests, TypeScript and production compilation passed.
- Native macOS offscreen acceptance reproduced both failures before the fix and
  passed the final production-compiled candidate through real authenticated
  server routes. Checks covered attachment/workspace TIFF rendering, unchanged
  original download bytes, split file links and Files browsing, repeat opens,
  focus, chat/file draft preservation, navigation, light/dark and narrow views.
  Typing and idle checks observed no workspace requests or long tasks.
  Test chats were synthetic; no provider was invoked. Native Linux/Windows
  execution remains untested.
- Local macOS arm64 package: source `541f60a17d42573c97048323dd2f9ea7152a9b60`,
  development version 0.2.0/build 85, Developer ID signed. Bundle, entitlements
  and deep strict signature checks passed. All 91 packaged compiled assets
  match the accepted outputs; TIFF worker, dependencies and notices are present.
  The same native journeys passed loading main/preload/renderer and TIFF worker
  from the signed app archive under stock Electron 43.1.1 offscreen. Archive
  bytes and signature remained unchanged. The signed executable's own launch
  and Gatekeeper acceptance were not exercised; this is not a notarized release.
- Availability: local Mac app package. This desktop fix requires no server
  update; nothing was installed, published or deployed.

## 2026-10-21 — Recover held mobile messages after a stopped queue handoff

- Handle bulk Stop events on mobile, clear obsolete promotion flags and retain
  delivery-uncertainty warnings. If a promoted row has already left the mobile
  shelf, recover it through the existing guarded authoritative queue read.
  Recovery never resends messages or introduces polling.
- Preserve a message held by Stop even when its earlier Run now request succeeds;
  show an informational paused status instead of a misleading send failure.
  Add reducer and live-store regressions to CI, including stale navigation reads.
- Make the server cancellation test's startup barrier tolerate busy CI workers;
  cancellation and slot-ownership assertions remain unchanged.
- Verification: the new mobile regressions fail before the correction and pass
  afterward. Mobile type checking, iOS JavaScript export, related store suites,
  46 interaction contracts and 121 targeted server tests pass. The broader local
  server shard is not clean in this environment and is not a passing CI result.
- Native offscreen Electron against the exact test-server source and real Claude
  exercised Run now immediately followed by Stop: both messages returned paused
  in order, one explicit retry started exactly once and the other stayed held.
  Editing, navigation, renderer reconnect and removal used production IPC/HTTP.
- Native iOS Dev with the patched bundle observed the same real cross-client
  handoff race and restored both held rows. A native Run now tap completed one
  real Claude request exactly once while the other stayed paused. Editing,
  removal, navigation and cold relaunch retained the expected queue state;
  relaunch did not resend the held message. The queue area scrolls to reveal
  actions when its content exceeds the available height. Android native
  acceptance was not exercised. No release or deployment to users is included.
- Follow-up manual testing in the visible native desktop was accepted by the
  user against the patched test service. A message already admitted before Stop
  remains interrupted in history; only an unadmitted promotion returns to the
  held queue. This distinction prevents automatic duplicate execution.
- Pre-review recheck: 280 targeted desktop tests, 126 targeted server tests,
  mobile queue reducer/store regressions and both client type checks pass.
  Full hosted CI remains a separate merge gate.

## 2026-10-21 — Restore queued messages after Stop interrupts a handoff

- When Stop pauses a message that was about to start, return it to the held
  queue immediately and clear the obsolete Starting state. Retain its text,
  attachments and order, and restore Send now, edit and remove controls.
- Treat paused snapshots from older servers as paused even if they still carry
  a promotion flag. Preserve a paused message when a successful Send now
  response is followed by a newer Stop; do not filter it out of the cache.
- Describe pending admission as waiting for the provider instead of claiming
  that the message was already handed over. Explicit Stop still prevents
  automatic delivery; retry uses the existing authenticated queue operation.
- Verification: five new queue/projection/UI regressions fail before the fix;
  190 focused server tests and 964 related desktop tests pass. TypeScript,
  Python compilation, production Electron compilation and entry verification
  pass. Native offscreen Electron reproduces the stale Starting row before
  the fix and restores retry afterward, through production IPC, authenticated
  HTTP, websocket events and server queue admission. Each of two messages
  starts exactly once on explicit retry; the other stays paused and ordered.
  Chat navigation, renderer reconnect and full app reopen retain the queue.
  This initial race was seeded and Claude replies were simulated; the subsequent
  real-provider and native-client acceptance is recorded in the follow-up above.
  No live service was modified during that initial simulated check.
- Availability: source only; the complete correction includes app and server
  changes. No release, installation, deployment or restart is included.

## 2026-10-20 — Recover Codex model-switch compaction without replacing history

- Address the remaining compaction path in #89; authentication-aware model
  retirement/default handling remains covered by #92. A compaction failure no
  longer triggers a bounded-memory replacement thread.
- Attempt at most one same-thread continuation only after a full native failed
  turn proves no execution occurred. If the original input was already accepted,
  continue with empty native input instead of inserting the user message again.
  Unknown acceptance, output/tool activity, cancellation and lost ownership all
  prevent automatic replay.
- Close failed/interrupted automatic-compaction status without reporting success.
  Explain the selected model and failure stage while retaining the native error;
  do not invent diagnostics for a fallback error the provider did not expose.
- Verification: 137 targeted runner, retirement, resume, restart and compaction
  status tests pass, along with Python source compilation and the dependency
  lock check. Two new regression tests fail on unmodified main. A wider controls
  sweep encounters an existing idle-thread-load mock failure, also reproduced
  on unmodified main; it is not fixed by this change.
- The first CI run exposed three isolated lifecycle tests whose AST fixture
  omitted the runner's compaction helpers. Load those real pure helpers in the
  fixture; all 60 follow-up, child-continuation and provider-session checks pass
  locally afterward. No production behavior changes in this follow-up.
- Personally exercised the actual native Electron client through mouse/keyboard
  input and production IPC/HTTP against an authorized test server with Codex
  CLI 0.156.1. Disposable old-model fixtures and a local fault-injection endpoint
  cover persistent compaction failure, the one-retry limit, native fallback,
  visible failure status and Stop. After removing the fault injection and
  restarting the test server, the same native conversation produced a real
  OpenAI reply recalling its earlier marker. A separate real native continuation
  confirmed that empty input adds no duplicate user message.
- The retired-model seed and failures are controlled fixtures, not a claim to
  reproduce an uncontrolled upstream outage. Cancellation during recovery proof
  and abandoned-run restart cleanup have deterministic test coverage. No new
  CLI version, mobile change, public release or production deployment is included;
  this source fix requires a server update.

## 2026-10-20 — Fix Claude running-chat fork timestamp precision

- Fix #94: recognize millisecond native timestamps within a second-truncated
  completion event when the completed reply has an exact provider message UUID.
  Keep text matching, provider identity, tool-call exclusion and future-second
  rejection intact. Legacy replies without UUIDs retain the strict cutoff;
  imported-history checkpoint handling is unchanged.
- The new regressions fail on the original implementation. All 72 focused
  live-fork and session-fork tests pass with the correction, as do Python
  source compilation and the dependency lock check.
- Personally exercised the visible native Electron app through mouse/keyboard
  input, production IPC/HTTP and real Claude against an authorized test server
  running 1.0.11-beta.11 with the narrow source patch. A same-second native
  completion successfully forked while its parent continued running. The
  native child preserved earlier tool-result context, excluded the in-flight
  parent request and completed a contextual follow-up; the parent completed
  normally. An idle fork was also checked after the parent finished.
- Availability: source branch and local test-server patch only. A server
  update is required; no Electron UI change, public release or deployment to
  other servers is included. This does not establish broader provider parity.

## 2026-10-20 — Verify history repair in the local desktop

- Integrate the existing repair-budget fix without changing Electron UI code.
  The combined branch passes 67 focused history/paging tests, desktop type
  checking, and the production Electron build.
- After an explicitly authorized local restart, AgentsServer 1.0.11-beta.2
  with the narrow source patch returns ordinary prompts and replies that its
  unpatched history page omitted. No conversation history was deleted.
- Reopened the actual desktop through its production transport, inspected
  restored historical user messages, and clicked the latest-message control.
  Recent user messages were visible directly, without opening thinking traces.
- The user also reports recovery in a second, unchanged client after the server
  restart. That report is separate from the directly exercised desktop checks.
- This verifies the targeted history failure, not full cross-machine/provider
  parity. No public release was published.

## 2026-10-17 — Keep chat messages visible in repair-heavy history pages

- Fix #91: reserve semantic-page slots for ordinary user prompts and assistant
  output before emitting same-ID history repair receipts. Give repairs a
  separate bounded allowance while retaining the absolute response cap,
  existing replay suppression, trace access and older-page cursors.
- Five focused regressions cover default and small pages, older-page reads,
  active/interrupted turns, dense corrections and the absolute response limit.
  The original allocation fails the new message-retention checks. All 159
  targeted paging, job-history, async-message, Claude-repair and Codex model
  retirement checks pass after integrating the latest main branch.
  The wider Codex native-proof suite has one existing malformed-provider-line
  failure, reproduced with the unmodified allocation; it is not fixed here.
- An isolated offscreen native Electron development app used production
  IPC/HTTP against the changed server source and synthetic Codex history with
  real native-replay proof. The 48-item response retained all 169 corrections
  and the latest user/final messages. Native input exercised trace expansion,
  collapse, older-history loading and reload: prompt/final output stayed
  visible without opening the trace. No real provider turn was submitted.
- Python source compilation and the dependency lock check pass. After an
  explicitly authorized local server patch and restart, the real desktop
  transport returned ordinary prompts and assistant output in the default
  history page; the user confirmed that the conversation was visible again.
  The post-restart UI automation did not establish its visibility assertion,
  so user confirmation and the earlier isolated native checks are recorded
  separately. This does not establish full provider-content parity.
- Availability: source branch and local server patch only; requires a server
  update, not a desktop UI change. No public release or cross-machine
  acceptance claim. Existing conversation history was retained.

## 2026-10-18 - Preview Simplified Chinese on mobile

- Add a first-pass device-local System / English / Simplified Chinese choice in mobile
  Settings, reusing unambiguous desktop translations and a mobile-specific
  catalog. Localize app-authored navigation, settings, server controls, status
  text and dates without translating user or provider content. Add Chinese iOS
  permission prompts and platform language metadata; no server update is needed.
- Refine preview terminology for model defaults, pinned chats, version, live
  status, message entry, agent attribution, server token and fork actions.
  Localize the native quick-message menu and its sent prompts in Chinese mode.
- Keep the mobile My Agents inventory aligned with the desktop Gemini backend.
- Verification on an isolated iOS Dev simulator: switch English and Chinese,
  reopen Settings, cold-launch with Chinese retained, and inspect the Chinese
  session list in light and dark themes, restoring the System theme afterward.
  The full mobile Node test suite, TypeScript, iOS and Android JavaScript
  exports, settings touch and quick-message simulator flows pass. The iOS
  native Debug compilation/install also passed during this preview.
- This is a local preview branch, not a TestFlight upload or App Store listing
  localization. Advanced actions and server-originated errors may remain English;
  Android native UI and a physical iPhone are not yet accepted.

## 2026-10-18 - Validate cross-device pairing and mobile reliability changes

- Prepare the accumulated connection-sharing, mobile recovery, media action and
  desktop sidebar changes against main 126c74f7. Update four source-contract
  assertions for multi-address health validation and active/final profile removal,
  retaining identity, namespace and durable-write ordering checks. Add the new
  QR, roaming, removal, media permission and HTTP cancellation regressions to CI.
- Verification: 128 mobile UI/configuration checks, rendered transfer checks,
  focused client/store suites and 940 desktop tests pass. Sync stress completes
  40 cycles with 36,000 events plus duplicates and 146 bounded reads. Thirty-one
  server discovery, CLI lifecycle and packaging checks pass from an isolated
  clean source fixture. Both TypeScript checks, desktop compilation, iOS/Android
  production JS exports and iOS native dependency parity pass.
- Actual iOS simulator input repeats video share-sheet open/cancel four times,
  image preview reopen/share-sheet open/cancel four times, then six cycles of
  Servers -> Settings -> Appearance. Download and Pin remain the only preview
  overflow actions; theme selection, navigation and dismissal keep working.
  Media downloads use the authenticated test server. Restore the System theme.
- The user separately confirmed the final download interaction on their physical
  iPhone. No physical device was operated during this verification round. Android
  native saving/camera and third-party share delivery remain unverified; source
  and component checks are not device acceptance. No app-store upload, npm
  publication or production server deployment is included.

## 2026-10-18 - Consolidate mobile preview download actions

- Keep Download and Pin in a single compact row, removing the separate Photos
  toolbar action. iOS Download now stages authenticated bytes and opens the
  system share sheet directly, exposing applicable photo/video saving, Files
  destinations and installed apps without an extra custom menu. Preserve the
  existing Share shortcut and do not claim that dismissing the sheet saved or
  sent anything.
- Android Download uses a bottom chooser for Save to Files, Save to Photos and
  Share / Open in. Cancellation starts no transfer; stale chat/menu callbacks
  cannot operate on a replacement chat. Documents do not offer photo saving.
- Verification on main 126c74f7 plus pending changes: rendered transfer checks,
  19 transfer unit tests, TypeScript and iOS/Android production JS exports pass.
  The rebuilt iOS Dev simulator exercised the actual authenticated test server,
  system share sheet, repeated presentation and real PNG/MP4 photo-library
  saves. Independently verify saved media dimensions/duration and a 597860-byte
  PNG written through the system Save to Files destination picker.
- Android and tablet routing have component coverage, not new native-device
  acceptance. External messages and third-party app delivery were not sent as
  part of testing. This interaction change requires no additional native module,
  server update, release or installation over the existing rebuilt Dev app.

## 2026-10-18 - Save mobile chat images and videos to Photos

- Add Save to Photos to image/video preview actions on phones and tablets,
  retaining Download and Share. Reuse authenticated, chat-scoped downloads,
  progress, cancellation, integrity checks and temporary-file cleanup. Report
  success only after the native library confirms the save; denied permission
  offers a Settings action. No server change is required.
- Add source-built Expo MediaLibrary with iOS add-only permission. Android 10+
  uses scoped MediaStore insertion without library reads; older storage writes
  stop at API 28. A composed-config regression guards plugin ordering and keeps
  broad media read permissions and legacy storage mode disabled.
- Validation on main 126c74f7 plus pending branch changes: 19 transfer unit tests,
  rendered file-transfer behavioral checks, nine platform/config checks,
  TypeScript, iOS/Android production JS exports, both iOS native Debug builds,
  native dependency parity and packaged framework ABI checks pass.
- Actual iPhone-layout simulator actions downloaded synthetic attachments from
  an authenticated test server and saved a 1000x4800 PNG and a 720x1280 six-second
  MP4. Repeat both saves using only the system's add-only grant, with no Photos
  read grant; verify dimensions and duration independently in the photo library.
  Light/dark previews, the native permission prompt and denied-access feedback
  were exercised. Denied access added no asset and never claimed success.
- The Settings action opens system Settings, but this simulator lands on the
  root page rather than the app permission page; direct permission navigation
  still needs physical-device acceptance. Android native saving and iPad native
  layout are not yet accepted; their control/permission paths use component
  fixtures. The separate iPhone Dev app was rebuilt, installed and launched
  successfully, without writing test media to the user's real photo library.
  No release, upload, server restart or publication.

## 2026-10-18 - Integrate current main into the connection and mobile fixes

- Update the working branch to main 126c74f7 while preserving the pending
  mobile, desktop and QR changes. Resolve the development-log and installer
  manifest conflicts by retaining both sets of additions, including the shared
  analytics module and terminal QR runtime files.
- Verification: 335 focused desktop tests, 81 mobile checks, both TypeScript
  checks, desktop production compilation and compiled-entry verification pass.
  Eleven installer/archive checks pass from an isolated clean source snapshot.
  The initial live-source archive check correctly rejected generated bytecode;
  the running service and its cache were not modified to bypass that guard.
- The merged native macOS desktop build passes repeated Pinned folding,
  keyboard expansion, preference reload and light/dark/narrow UI checks in an
  isolated offscreen profile. Correct the local test setup to reload its reset
  preference before repeating the workflow. Mobile source and native dependencies
  were unchanged by upstream; no new physical-device acceptance was performed.
- Source integration only: no commit, push, publication or server restart.

## 2026-10-17 — Refresh privacy-limited desktop and sharing metrics

- Integrate current main into the existing sharing-analytics work, preserving
  Gemini support, native report forms, and updated server packaging. Retain the
  two share-mode selection events and three narrowly scoped shared-web events.
- Add confirmed Agent/model/permission changes, imported Gemini API binding,
  archive/restore, Files-panel entry, native file-open outcomes, explicit server
  restart request/reconnection, language/font changes, and diagnostic-copy and
  issue-form request outcomes. Existing provider usage/configuration events can
  carry only a fixed built-in provider family, never a model/endpoint/name.
- Keep Team Network instrumentation unchanged. Do not count initialization,
  restored settings, automatic model migration, stale profile responses, or
  rejected session patches as successful user changes. Document accepted
  messages separately from completed provider work and restart requests
  separately from verified reconnection. Update the catalog and privacy source.
- Validation base: main `4ef55959`; development Electron build, not a release
  package. Type checking and desktop/shared-web builds pass. Targeted Electron
  regression suites: 939 passed; sharing and packaging Python suites: 116 passed.
- Hands-on surface: isolated native offscreen Electron, actual authenticated
  local AgentsServer routes, separate browser partition. Exercised new chat,
  Agent selection, Codex/Claude permission changes, model selection,
  archive/restore, Files opening, unavailable-file feedback, language selection,
  error copying, blocked external issue navigation, and both share modes.
  Redeemed tokens in the browser and verified reload/reconnection deduplication,
  no shared-browser install identifier, and an interactive Codex prompt/reply.
  Captured event envelopes locally; production analytics delivery was blocked.
- Remaining acceptance: actual Mixpanel ingestion, Gemini API-binding with
  credentials, managed restart success, native font-menu input, and successful
  external-file/application launch were not exercised end-to-end. Provider
  resume across sharing modes is not an acceptance claim of this change.
  These are source changes only: no deployment, release, or privacy-site publish.

## 2026-10-03 — Point issue reporting to the maintained repository

- Correct the server README's issue-report link to ZhengyiLuo/AgentsDock.
  The desktop `/feedback` command already opens that repository's new-issue
  form; preserve its existing behavior and add focused coverage for finding
  it with `/feedback`, `/issue`, and `/bug` without sending a chat message.
- All three component cases, TypeScript and the production build pass; the
  component cases mock the external-browser bridge.
  Actual app-to-browser interaction remains unverified because computer use
  is disabled. This documentation/test change does not require a server update.
  No release or deployment.

## 2026-09-30 — Share selection and recipient usage events

- Distinguish choosing View only/Interactive from successful share creation.
  Preserve the existing share-dialog opening, creation and revocation events.
  Add three narrowly scoped shared-browser events: authenticated read-only and
  interactive activation, and server-accepted interactive message submission.
  See `docs/ANALYTICS_EVENTS.md` for exact event names and counting semantics.
- Keep generic desktop analytics disabled in shared pages, including when the
  restricted bridge is installed after imports. Remove a legacy web install ID
  on initialization. Web events have no persistent viewer identifier, content,
  URLs, tokens, names, resource IDs or arbitrary event properties. Respect
  DNT/GPC and existing same-origin opt-out; deduplicate refresh/reconnect and
  receipt replay with local-only sessionStorage markers. Counts do not identify
  unique viewers or form a cross-device per-user funnel.
- Generate both server-served web artifacts from the shared tracker, retain
  dependency license notices and include the snapshot artifact in installation
  manifests. Successful snapshot GETs permit only the exact analytics script
  hash and Mixpanel destination; token forms, errors and HEADs stay scriptless.
- Exercised the actual native macOS Electron share menu through IPC/HTTP into
  a disposable AgentsServer. Separate isolated offscreen browser windows opened
  both token forms, rejected an invalid token, authenticated and showed the
  transcript. Read-only reload did not recount activation. Interactive browser
  submissions completed real Codex replies; after correcting the initialization
  boundary only shared-browser send events were emitted and no install ID
  remained. Refresh and simulated network interruption/recovery did not recount
  activation. Revocation disabled sending and returned the token entry screen
  on reload. Captured requests locally and blocked production Mixpanel delivery.
- Focused client/server tests, type checking and production desktop/shared-web
  builds pass. Actual Mixpanel ingestion, other browser engines, and live
  queued acceptance are not validated here (queued/refused receipt semantics
  are covered by targeted bridge tests). No release or server deployment.

## 2026-10-18 - Restore desktop Pinned group folding

- Connect the Pinned header to a dedicated collapse state and right-aligned
  arrow. Persist the preference in the existing server-scoped desktop cache;
  folders named Pinned remain independent. Chat pins and folder assignments do
  not change. Next/previous-chat navigation skips hidden pinned rows, while
  unread/running pinned chats remain eligible in their visible status groups.
  Emergency notifications retain the existing automatic section expansion.
- Reproduced the unresponsive header in an isolated native Electron window
  before the fix. The locally compiled app then passed mouse collapse/expand,
  Enter/Space activation, preference restoration after reload, repeated use,
  same-name folder independence and light/dark/narrow presentation checks.
  Pinning a disposable chat crossed the real authenticated test-server boundary;
  folding persisted locally. Test chats were removed without running a provider.
- Validation: 55 focused sidebar/session tests, two emergency-state regressions,
  TypeScript, production compilation and compiled-entry verification pass. The
  two initial folding/navigation regressions failed before the implementation.
  Native testing used an offscreen macOS Electron 43.1.1 development process
  with source changes over 4ef55959, not an installed release. Windows/Linux
  native acceptance was not performed. No server update, publication or merge.

## 2026-10-18 - Recover lazy media previews after a Dev transport interruption

- Backport Expo's upstream HMR recovery fix to the pinned Expo 57.0.4 package
  through a scoped pnpm patch. Lazy imports after a lost Metro graph now call
  the platform reload helper instead of accessing `window.location` on native.
  This affects development recovery, not production chat synchronization, and
  does not change the native dependency ABI.
- Stage iOS video previews with a foreground file-system download. The same
  authenticated sample failed in the background URLSession and downloaded
  successfully in the foreground session. Existing cancellation, authentication,
  cache ownership and integrity checks remain in place.
- Verification: 51 HMR and interaction checks, TypeScript, video-staging and
  deferred-import tests, and iOS/Android production JavaScript exports pass.
  The HMR regressions fail before the patch and pass afterward.
- Actual iOS simulator UI reproduced the reported undefined `reload` error
  before the patch. After the same forced Metro graph loss, the app reloaded
  without that error and reopened the chat. Subsequent automated preview-open
  assertions did not pass; full preview and video playback acceptance remain
  incomplete. The user separately confirmed opening works on the physical
  phone after reloading the patched Dev app.
- No Android native acceptance or release-binary validation was performed.
  Changes remain local source only; no server update, PR or release.

## 2026-10-18 - Decouple selected-chat recovery from slow session lists

- Foreground recovery waits for server identity validation, but no longer waits
  for the session list before fetching the selected chat and reopening its live
  stream. Joining an already-pending list refresh follows the same path.
- Reconnect restores a cached selection immediately after validation. A late
  list response does not restart that selection or supersede a newer selection;
  a selected chat removed from the server still falls back to an available chat.
- Request the same `summary=true` session list as desktop. Existing merge rules
  retain omitted detail fields and honor explicit reset values.
- Skip a redundant legacy tail request only when the returned total proves all
  events are present and neither side of the page is omitted. Unknown totals
  and incomplete pages retain the compatibility fallback. Latest-first bounded
  paging, cache visibility and authoritative stream cursors remain unchanged.
- The new foreground regression fails on the prior implementation and passes
  with this fix. Lifecycle, reconnect, validation rejection, latest-first paging,
  compatibility, client cancellation, profile isolation, cache adoption and
  state-hardening checks pass. Stress validation passes 40 cycles and 36,000
  events with 146 bounded reads; TypeScript and iOS/Android production JavaScript
  exports pass.
- Actual iOS simulator UI checks use an isolated authenticated HTTP/WebSocket
  fixture. After a cold launch, foregrounding with a 5.002-second session-list
  response starts the selected tail immediately and opens one stream 5 ms later.
  A legacy one-message response delayed by 1.5 seconds now takes one request and
  opens its stream in 1.506 seconds, instead of two serial requests. Both checks
  retain the visible message and reach Live without another screen tap.
- These are controlled transport measurements, not production latency promises
  or acceptance on the affected user's server. Android native/device acceptance
  and matching the reported TestFlight binary to source remain pending. Changes
  are local source only; no release, server deployment or PR was created.

## 2026-10-18 - Verify npm connection commands and complete setup QR output

- Keep `agentsdock token [NAME]` as the combined URL/token/QR entry point and
  `agentsdock pair [NAME]` as the QR-only shortcut. Clarify the first-install,
  setup and new-instance output in command help and package documentation.
- Real npm lifecycle tests exposed truncated terminal QR output: nonblocking
  tty writes stopped under buffer pressure, sometimes splitting UTF-8 symbols.
  Retrying nonblocking writes also allowed npm's progress indicator to corrupt
  the QR. Use normal blocking tty writes, preserve partial-write offsets, and
  bound retries of transient write errors. Credential output still goes only
  to the controlling terminal, never captured npm output or debug logs.
- Verify the complete generated QR, not merely a heading, under ordinary npm
  installation and `--foreground-scripts`, with an authenticated local HTTP
  fixture. Verify headless omission, repeat-install safety and log secrecy.
  Service creation and instance discovery in this lifecycle test are synthetic;
  no native fresh-default service was created or replaced in this iteration.
- Verification: 35 focused Node checks and all five package tests pass. The
  complete-QR lifecycle check also passes three consecutive runs in both npm
  output modes. Package tests run from an isolated source snapshot so live
  Python bytecode does not bypass or weaken the runtime packaging allowlist.
- Availability: local source only; no global CLI replacement, server restart,
  npm publication or mobile build.

## 2026-10-18 - Bound native HTTP reads and recover from canceled sync requests

- Reproduce the native fetch cancellation error with a deliberately slow HTTP
  response in an isolated iOS Dev simulator. This is a transport exception
  exposed through app error state, not a development-only warning overlay.
- Cover response bodies as well as headers with the existing request deadline.
  Race the operation against cancellation because the installed Expo iOS native
  text reader can remain pending after its transport has been canceled. A
  partial JSON response reproduced the indefinite Syncing state before this
  additional deadline guard; aborting the socket alone was insufficient.
- Preserve client/caller cancellation ownership, normalize timeouts and unexpected
  native interruptions, and keep confirmed HTTP failures distinct. A stalled
  401 body still revokes validation. Late responses cannot publish a second
  rejection, and mutations are not automatically retried.
- Keep transient automatic session-list failures in profile connection state,
  preserving cached chats and unrelated user-action errors. Selected-chat reads
  continue through the existing bounded recovery sequence without a screen tap.
- Native UI checks against an isolated authenticated HTTP/WebSocket fault fixture
  pass for stalled headers and partial JSON bodies: the cached message remains,
  the approximately 12-second deadline closes the request, and automatic recovery
  returns to Live with no global error banner. A 30-second session-list timeout
  leaves the healthy timeline Live, marks the profile degraded, and clears that
  diagnostic on the next successful refresh. This is fault-injection transport
  validation, not live-provider or affected-user-server acceptance.
- Twelve cancellation regressions, client scopes, store integration, bounded
  timeline recovery, lifecycle and address fallback checks pass. The sync stress
  check passes 40 cycles with 36,000 events; TypeScript and iOS/Android production
  JavaScript exports pass. The exact reported TestFlight binary was not rebuilt
  or matched to a release source manifest. No physical device, working server,
  release, publication or merge was operated for this investigation.

## 2026-10-18 - Fix intermittent iOS Settings taps after native menus

- A physical-device native snapshot found stale `RCTSurfaceTouchHandler`s on
  ordinary Settings views beneath the modal's own handler. Expo UI 57.0.4's
  RNHostView attached these handlers but never detached them before Fabric
  reused the views. This matches upstream Expo #47713, not a disabled theme
  option or a server synchronization dependency.
- Pin Expo UI to 57.0.7, which includes the upstream disappearance/deinit
  cleanup. Build ExpoUI from source against the installed ExpoModulesCore and
  verify package/pod/source parity. Do not change Settings actions to fire on
  touch-down or replace their existing scrolling and modal interactions.
- Add a dependency lifecycle regression and a native Maestro workflow that
  cycles Servers -> Settings -> Appearance, asserts selected themes and returns
  to System. The old simulator binary reproduced an ignored Appearance tap
  after closing Servers, remaining on the category page. Simulator-only push
  entitlement overlays were dismissed separately, not treated as this failure.
- The rebuilt simulator passes the same six-cycle drawer/settings workflow,
  including selected-state assertions for each Light/Dark switch and working
  category/back/close actions. This is actual native UI input, not handler calls.
- Focused checks (20), TypeScript, iOS/Android production JavaScript exports,
  native dependency parity and both iOS Debug builds pass. The rebuilt Dev app
  is installed on the independent physical-device and simulator identifiers;
  the user confirms Settings navigation and theme buttons work on the phone.
  No production installation, server configuration or chat content is changed.
  Android device acceptance and longer physical-device testing remain pending.

## 2026-10-18 - Add desktop unread and running sidebar groups

- Match mobile's temporary status grouping: Unread first with a blue dot,
  Running next with a green dot, then ordinary sections. Active work takes
  precedence over unread state; archived chats stay archived. Each chat appears
  once, retaining its saved folder and pinned state. Empty status groups hide.
- Add independent status collapse controls and right-aligned folder/group arrows.
  Keep status groups out of folder drop targets and match next/previous-chat
  navigation to the visible group order. Collapse state resets on workspace
  adoption and does not write server preferences.
- Verification: focused sidebar/grouping/drag/navigation/design checks, the
  desktop regression suite, TypeScript, production compilation and output checks
  pass. An isolated native Electron window exercises real menu marking, collapse
  and keyboard expansion against the authenticated test server. A disposable
  live Codex turn moves Running -> Unread -> original folder; reading removes
  empty groups. Light/dark and narrow-window screenshots confirm dot sizing and
  rightmost arrows. Temporary chats are removed afterward; no working chats or
  production app are replaced. Other desktop operating systems are not exercised.
- Availability: local source and desktop preview only; no server update or
  public release is required or performed for this grouping change.

## 2026-10-18 - Restore green mobile sent-message bubbles

- Set the shared user-message surface to soft green in light mode and muted
  deep green in dark mode. Keep assistant surfaces, text, layout and behavior
  unchanged; document both colors in the mobile design tokens.
- Verification: eight theme checks, including primary/secondary text contrast,
  TypeScript and iOS/Android Hermes exports pass. Actual iOS simulator taps
  exercise theme switching and chat reopening with temporary in-memory message
  fixtures; both green bubbles render correctly. Restore the prior workspace
  and system theme afterward. No provider message was sent; this is visual
  acceptance, not a new server integration or Android-device check.
- Availability: local development source/preview only, no public release.

## 2026-10-18 - Keep mobile agent marks independent of development networking

- Embed the original Claude/Codex PNG bytes in the shared backend-mark component,
  preserving the artwork and Cursor's vector mark. Both Debug and Release now
  render these icons without fetching a separate image from Metro.
- Generate the embedded sources during installation and verify byte-for-byte
  artwork parity, self-contained sources and repeated mounts in four focused
  component checks. TypeScript and iOS/Android Hermes production exports pass.
- On a physical iPhone running the independent Dev app, a native bundler-host
  correction restores launch over the tailnet. A subsequent cold launch without
  an explicit host argument shows the connected home screen and both bitmap
  marks. Simulator taps open, close and reopen My agents with all marks visible.
  No chat writes, production-app replacement or server changes are involved.
- Document the distinction between the Debug bundle host and the chat server.
  Debug still needs a reachable Metro service; embedding these marks does not
  make the entire development build standalone. Android device UI and a physical
  Wi-Fi-to-cellular switch after this change have not been exercised.
- Availability: local development source and installed iOS Dev preview only;
  no public release or store submission.

## 2026-10-17 - Allow removing the current mobile server

- Enable Remove for every saved connection, including the active and final
  profile, with a confirmation explaining that remote chats/tasks are retained.
  Select the next saved profile when available; otherwise clear the active
  workspace and show setup. Empty profile settings survive a cold launch.
- Persist removal before detaching the local client or deleting its credential.
  Preserve identity-scoped caches and drafts for re-addition, invalidate old
  requests, and do not require remote connectivity or completion of active work.
  A profile-settings write failure leaves the original connection and token intact.
- Verification: menu/confirmation regressions, real-HTTP store fixtures for
  active/inactive/final/offline removal, busy state, late replies, storage failure,
  credential cleanup, empty startup and re-addition pass. Existing profile,
  cache, store and multi-address reconnect regressions, TypeScript and
  iOS/Android Hermes production exports pass. Fixture requests confirm removal
  does not send remote stop/delete commands; busy state is simulated, not a
  newly started live provider task.
- In the installed iOS simulator, actual menu taps exercised cancellation and
  active/final removal. A cold restart retained the empty list. Re-adding the
  same isolated server through Add and refreshing returned the same chats over
  the production authenticated transport. QR payload injection was test setup,
  not physical camera acceptance. Physical-phone/Android UI remain unverified.
- Availability: local development source only; no server update, public release,
  or store submission is needed or performed for this change.

## 2026-10-17 - Automatically select shared server addresses on mobile

- Add QR format v2 with up to six explicit candidate addresses and a required
  durable server identity; retain v1 parsing and single-address sharing.
- CLI automatic pairing includes authenticated LAN/Tailscale candidates with
  one identity. Desktop QR sharing asks the selected remote server for its own
  binding-aware addresses through a native-token-only endpoint. Older/offline
  servers retain the saved single address; discovery never uses desktop NICs.
- Mobile staggers bounded health probes, selects the first identity match and
  cancels losers. All failures produce one error. Saved alternatives support
  reconnect without duplicating profiles or changing cache/draft ownership.
  Explicitly reusing a scanned saved identity can refresh its addresses without
  replacing credentials. Manual address edits or identity resets clear old routes.
- Verification: 30 mobile component checks, nine parser/selection checks,
  real-HTTP mobile store roaming/persistence and existing profile/client/store
  regressions pass. Desktop client/service/contract checks pass (645 tests),
  as do 25 server discovery/binding checks and 33 CLI/lifecycle checks.
  Both TypeScript checks, desktop compilation and iOS/Android Hermes exports pass.
- Actual offscreen desktop UI generated a multi-address QR against the isolated
  test server; independent native image decoding confirmed the advertised routes
  and authenticated identity. The CLI also authenticated both actual routes.
  The installed iOS simulator accepted the decoded payload, saved through an
  actual Add tap, and reconnected both directions while one route was deliberately
  rejected by a test-only fetch wrapper. All-route failure and recovery retained
  the profile; afterward the wrapper/profile were removed and selection restored.
- This is not physical camera or off-Wi-Fi phone acceptance. Actual iPhone
  Tailscale roaming and Android device UI remain unverified. Only the designated
  isolated local test service was switched to source; no production deployment,
  global CLI replacement or release was performed.

## 2026-10-17 - Simplify mobile QR connection setup

- Add server shows Scan QR code, a subtle "or add manually" caption and all
  three manual steps immediately, without an expansion action. Scanning shows a
  compact name/address confirmation; Edit details reveals the masked manual
  fields. Saving still requires successful authenticated health and the QR's
  expected identity. Existing profiles are not silently overwritten.
- Use a square camera viewport with a separate width constraint, QR icon and
  terminal/desktop source guidance. Only the scanner expands the native sheet
  to full height; ordinary server management retains half/full detents.
- Document LAN, Tailscale, remote desktop, localhost/tunnel and HTTPS cases.
  Format v1 still carries one URL, without automatic network failover. Verify
  the existing interactive token command displays all discovered address
  categories, token and terminal QR together; update its help accordingly.
- Verification: TypeScript, 28 mobile component checks, 22 binding/address
  checks and 15 CLI checks pass. The camera-enabled iOS simulator native build
  and iOS/Android production exports pass. After making manual steps immediately
  visible, TypeScript and the 28 component checks pass again; actual simulator UI
  verifies the caption, all three fields, scanner back navigation and drawer
  close/reopen without an expansion action. Earlier checks cover camera permission
  and compact confirmation. Native camera viewport bounds are 360 by 360 points.
- A decoded QR injected into the actual simulator app reaches the real test
  server, passes identity validation, and saves/activates through an actual Add
  tap. This is not a physical camera scan. The temporary profile is removed and
  prior selection restored. A real PTY token-command run verifies terminal QR
  output and authenticated health without recording credentials.
- Physical iPhone/Android camera capture, off-Wi-Fi tailnet routing and public
  HTTPS/proxy acceptance remain unverified. No public release, global CLI
  replacement, server restart or network-policy changes in this iteration.
- Additional observation outside the QR change: after switching Appearance to
  dark, the Settings close action did not dismiss the sheet on two simulator
  attempts. Restarting the QA app was needed to continue; do not treat this as
  resolved or assume it is only automation timing. No unrelated Settings fix
  is included in this iteration. After restart, dark-mode QR choice, scanner
  and dismissal pass actual UI checks; the test theme is restored afterward.

## 2026-10-17 - Stabilize mobile server setup step badges

- Replace the three native rounded-border badges with fixed 24-point SVG
  circles and numbers. A physical iPhone light-theme screenshot showed step
  two stretched into a horizontal oval; the previous overflow clipping did
  not prevent it. Preserve theme colors, step accessibility labels and all
  connection behavior. The underlying native rendering cause is not confirmed.
- Verification: TypeScript and 27 focused server form/scanner tests pass.
  Actual iOS simulator light-theme checks exercised three drawer reopen,
  expansion, input focus and return cycles; inspected all three circular
  badges in the expanded sheet. Corrected automation-only close selectors,
  keyboard dismissal and screenshot output paths during the run.
- Restarted the attached iPhone's separate Dev app and observed a fresh Metro
  bundle connection. Physical-device visual confirmation remains pending:
  runtime inspection timed out. No production app or server data changed.

## 2026-10-17 — Make Gemini a built-in provider

- Remove the Gemini preview environment gate from provider registration,
  capabilities, native import discovery, skills and cross-chat discovery.
  Compatible desktop clients now show Gemini in My Agents without an opt-in
  flag. Installation of Gemini CLI 0.64.0 and a configured API connection remain
  required for sending; Google/CLI sign-in is not offered. Old-client checks
  and unsupported-feature capabilities remain unchanged.
- Update setup documentation and preserve the Gemini icon attribution in the
  standalone server export. Repair integration-test fixtures for the current
  update-session wrapper, archive rejection helper and per-chat queue recovery;
  no unrelated production behavior is changed by those fixture corrections.
- Verification: 169 targeted server tests and 18 native CLI/HTTP tests pass.
  Desktop TypeScript, 5,246 tests (five skips), eight build/license checks and
  production compilation pass. A fresh real HTTP server without any feature
  flag exposes Gemini while correctly rejecting missing runtime/API readiness.
  Actual offscreen Electron through production IPC/HTTP and the pinned CLI
  verifies the unconfigured settings card, API setup without an initial model
  ID, model discovery/default selection, new chat, two turns and reload.
  Screens inspected; this rerun uses a loopback model, not Google inference.
  Full server regression and hosted CI remain separate gates. No installed
  server restart, public release or package publication performed.
- Integrate main's Codex retired-model selection fix without dropping either
  side's development-log entries. The post-integration run passes 141 focused
  server tests and 5,250 desktop tests (five skips), plus TypeScript, eight
  build/license checks and production compilation. The superseded local full
  server run was stopped; full-suite validation belongs to the new hosted CI.

## 2026-10-17 — Prepare the Gemini preview for review against current main

- Integrate main's history-responsiveness and desktop recovery updates while
  retaining Gemini import, title and session-identity coverage. Resolve the
  additive development-log and session-summary test conflicts without dropping
  either side's behavior. Gemini remains an opt-in, API-only development preview.
- Use the approved Chinese term for imported sessions. Update archive-label
  assertions for both the section and per-session badge, make the clipboard
  permission fixture independent of umask, and give native Gemini fixtures a
  canonical workspace path. Align the old skills test with API-only policy
  while retaining native skill discovery and unchanged terminal-login checks.
- Clarify provider versus adapter limits: Gemini has native subagents and
  terminal compression; this integration does not expose managed child
  lifecycle controls or manual compression. Current ACP Fork returns
  method-not-found, and unregistered slash commands are ordinary prompts.
- Verification: 5,246 desktop tests pass with five skips, plus eight build/license
  checks; TypeScript and production compilation pass. A focused server run
  passes 246 tests with seven optional native cases skipped. Actual offscreen
  Electron through production IPC/HTTP and the pinned CLI verifies both native
  import/API connection entry points, repeated sends, original session IDs and
  reopening. Chinese/narrow/light and English/dark rendering were inspected.
  The current integration rerun uses a loopback model fixture, not Google
  inference; earlier real-API acceptance and remaining release gaps are recorded
  in the Gemini preview document. No public release or installed-server update.

## 2026-10-17 — Explicit API continuation for native Gemini imports

- Import Chat can explicitly bind Gemini history to its saved API; existing
  history-only imports gain a localized Connect Gemini API action. The API
  destination is disclosed before selection. Other providers' import and
  account-switch restrictions remain unchanged.
- Preserve the original native UUID, workspace and transcript location. Pinned
  CLI process-only API auth does not modify the terminal's saved login, copy
  history or start a replacement session. Busy/queued work, missing history,
  revoked bindings and managed auth conflicts fail closed; failed persistence
  rolls back the binding. Forget cannot fall back to Google login.
- Verification: focused server and desktop regressions, TypeScript and
  production compilation pass. Six native CLI/HTTP contracts cover import,
  continuation, Stop/retry, Forget, title compatibility and retained history.
  Actual offscreen Electron through production IPC/HTTP and Google Developer
  API verifies both connection entry points, original contextual recall,
  repeated turns, unchanged native identity and reopen. Light/dark, narrow and
  Chinese presentation were inspected. The native fixture confirms exact API
  key headers and unchanged terminal settings; no copied transcript is created.
- Prepared on the Gemini preview branch for the authorized local desktop/test
  server update. No public release or merge. External native-history syncing,
  broader organization policies and platform acceptance remain separate.

## 2026-10-17 — Gemini first-turn summarized titles

- Prefer the native summary; if absent after a successful ordinary turn, make
  one bounded, tool-free background title request through that chat's own API
  connection. Auto resolves from its exact native model metadata. Long prompt
  excerpts retain the ending question as well as the beginning.
- No hidden chat message, native session or tool invocation is created. Manual
  names, late native titles, opt-out, connection revocation and identity changes
  reject stale results. Failure keeps the prompt fallback without repeated usage.
- Verification: 160 focused server regressions pass, plus a native CLI/HTTP
  title contract without injected summary. Actual offscreen Electron through
  production IPC/HTTP and the Google Developer API verifies short English and
  long Chinese/log naming, visible refresh, repeated turns, stable native identity
  and reopen. Manual-name and revocation races have focused server coverage.
  The broader native lifecycle run passed 29 of 30 cases; the legacy Google-login
  skills case fails identically on the unchanged baseline, independently of
  this title change. Full provider/release acceptance remains separate.
- No desktop source changes or public release. Prepared on the Gemini preview
  branch for the explicitly authorized local test-server update.

## 2026-10-17 — Require real first-turn provider title acceptance

- Tighten the provider checklist: existing native metadata and synthetic title
  adoption tests do not establish automatic generation. Require an actual App
  and real-model first-turn check with long pasted input, missing native titles,
  manual rename protection, repeated turns and reopen.
- Record Gemini's missing fallback title generator separately from its tested
  native-summary reader. Align the preview's outstanding acceptance list with
  the API-only policy; Google/CLI login is intentionally unsupported.
- Documentation only. No title-generation implementation, chat repair or
  service change is included; checks are documentation diff/link review.

## 2026-10-17 — Gemini API-only connections and clearer chat errors/archive state

- Gemini's preview now offers API connections only. The CLI remains its runtime;
  other providers' login choices are unchanged. Old Google-login chat history
  remains readable, but sends cannot fall back to that account or silently move
  to an API account. Settings, discovery and send admission agree on this policy.
- Composer errors are selectable and have a localized copy action. Timeline
  error cards also support copying. Long command text is preserved rather than
  truncated, and an empty failed-turn summary no longer hides the actual error.
- Archived chats have a muted row, archive icon and explicit label, including
  in search. They remain readable in the collapsible Archived section and are
  excluded from ordinary chat mention candidates.
- When the owning Codex resume RPC explicitly rejects the exact native thread
  as archived, the server mirrors it through the normal AgentsDock archive
  lifecycle and does not retry through exec. Jobs/routes follow the existing
  archive policy; provider history is untouched. Stale runs and other errors
  cannot cause this transition. This is response-driven, not a background scan
  of native archives or a migration of old error records.
- Verification: 705 focused desktop tests, TypeScript and production compilation
  passed. The server suite passed 230 cases with one optional native test skipped;
  that native test then passed separately. These cover credentials, archive
  lifecycle, routing and stale-run ownership. Actual offscreen Electron through production IPC/HTTP
  verifies API-only Settings, copying both error surfaces, legacy-chat recovery
  navigation, Archive persistence, mention exclusion, reopen, narrow layout,
  light/dark and Chinese. A native Gemini CLI/loopback endpoint fixture covers
  real failure propagation; separate Google Developer API Default/Plan sends
  succeeded. A disposable native Codex archive/resume probe reproduced the
  exact rejection and retained its native history without a model request.
- Not published or deployed; existing user services and chats are unchanged.

## 2026-10-17 — Compact Gemini approval actions

- Gemini tool requests now use localized Allow / Deny buttons. Full request
  details remain available, and approval still applies only to that request.
  The shared card accepts optional labels; other providers retain their
  existing controls and approval semantics.
- Verification: 37 focused desktop tests cover long tool names, English and
  Chinese, both decisions, ownership, existing Codex controls and Gemini modes.
  TypeScript and production compilation pass; 39 transport/process regressions
  pass. Actual offscreen Electron through production IPC/HTTP and the native
  Gemini CLI verifies Allow executes a disposable write, Deny does not, mode
  selection, next-turn isolation and five Stop/retry/reopen cycles. Narrow
  rendering was inspected. These deterministic model replies use a loopback
  fixture, not Google inference.
- Prepared on the same Gemini preview branch for the authorized local test
  update; no public release, push or merge. Google OAuth acceptance remains
  separate from these tool-policy and lifecycle checks.

## 2026-10-17 — Gemini early Stop/Delete stress fixes

- Reproduced immediate Stop leaving a chat fenced, first at the real process
  boundary and again through actual offscreen Electron. A process readiness
  handshake prevents signalling the guard before its handlers exist; startup
  cancellation retains the process handle for verified cleanup. Stop/Delete
  now use the Gemini-owned cleanup operation instead of killing its guard
  through generic tree termination. A failed native exec with no launched
  provider is not misclassified as surviving tools. Cursor's legacy exit
  contract is unchanged; unverified cleanup still fails closed.
- Added early Stop/cancel/exec-failure regressions and repeatable opt-in native
  long-message stress. Existing cleanup-failure and restart fences remain in
  place; no old fence is automatically repaired by this change.
- Actual offscreen desktop, production IPC/HTTP and native CLI: five consecutive
  Stop/retry/reopen cycles, Default approval and rejection, next-turn policy
  change, automatic edits, YOLO cancel/confirm, Plan write denial, keyboard
  operation, narrow/light/dark and Chinese presentation pass. Separate actual
  desktop journeys verify direct first/repeated new chat, inherited settings,
  custom-provider switching, native built-in skill activation and repeated
  picker use, and blocked untrusted handoff followed by an ordinary question.
  These deterministic flows use a local model fixture, not Google inference.
- A separate actual desktop Google Developer API run completes Default then
  Plan with the same native ID. Google OAuth-account acceptance remains open.
  Four simultaneous native chats complete 40 long-message turns and 40 socket
  reconnects with exact replies and stable identities. Native history survives
  deletion. This is bounded regression coverage, not a production load claim.
- Verification: 377 focused server regressions pass, followed by 39 transport/
  process tests including two additional failed-exec cases; 41 native CLI/HTTP
  lifecycle, permissions, skills and API-binding cases pass. Desktop: 5,214
  tests pass, five skip, plus eight compile/license checks. TypeScript and
  production compilation pass. Counts overlap and are not a readiness claim.
- Availability: same Gemini development branch and isolated local test Apps;
  no existing service, working desktop, credentials or trust settings replaced.
  No deployment, public release, push or merge. Remaining provider limitations
  are tracked in the Gemini preview documentation.

## 2026-10-17 — Gemini native permission-mode controls

- Add a localized Gemini permission menu in the desktop composer for both
  native-login and API chats: Default, Auto Edit, explicit-confirmation YOLO,
  and Plan once a native workspace handshake reports it enabled. Preserve
  next-turn semantics and the native session ID; newly created chats inherit
  the selected Gemini chat's saved mode without copying another provider's
  sandbox options. Default remains normal native approval policy.
- Pass native approval flags and confirm the requested ACP mode before the
  prompt. Preserve native folder trust, tool denies and administrator YOLO
  restrictions. Disabled Plan fails closed rather than silently running in
  Default. API profiles preserve native Plan settings without changing login.
  Shared chats do not gain this administrative permission editor.
- Keep a mode-change acknowledgement out of assistant replies by correlating
  the exact pinned CLI notice with the outstanding mode-change RPC. Identical
  text in an actual model response is still retained.
- Verification: 85 focused server/protocol/schema/packaging tests pass. Six
  additional real CLI/HTTP mode cases verify default approvals, auto-edit
  writes, shell confirmation, YOLO, Plan denial, native tool/admin restrictions,
  unavailable modes and same-session next-turn changes. The model in those
  deterministic native tests is a loopback fixture, not Google inference.
- Desktop regression: 5,214 tests pass, five skip, plus eight compile/license
  checks. TypeScript and production compilation pass. Five additional native
  regression cases cover API reconnect, resume, Auto routing, cross-chat and
  Stop/Delete isolation; these are separate from the live Google acceptance.
- Actual offscreen Electron with production IPC/HTTP and native Gemini verifies
  selecting/saving modes, pending approval isolation, denial, automatic writes,
  YOLO confirmation/cancellation, Plan blocking writes, keyboard focus,
  light/dark/narrow layouts, English/Chinese and reopening. No internal mode
  notice appears as an answer. A separate real Google Developer API run through
  this App completes Default then Plan in the same native session. Google
  OAuth-account mode acceptance and wider platform/policy coverage remain open.
- Source only on the Gemini development branch. No existing service or working
  desktop was replaced; no cleanup fence bypass, existing native trust change, public
  release or merge. The broader provider acceptance limitations remain.

## 2026-10-16 — Keep Gemini workspace trust separate from sign-in

- Report unavailable communication tools as a workspace/MCP issue, not an
  invitation to sign in again. Include the exact chat workspace and native
  trust/settings guidance without changing credentials or granting trust.
- Do not require a communication tool for every ordinary question merely
  because a chat has a durable communication permission. Use this turn's
  validated references and internal delivery purpose. Explicit communication
  and mailbox wakes still fail before model work when the tool is unavailable;
  broker authorization, native trust and approval policy are unchanged.
- Verification: the new real-CLI regression failed before the fix and passes
  afterward. 82 focused regressions and seven native CLI/HTTP cases cover
  ordinary follow-up, untrusted sender/recipient, queued cancellation, native
  denial, unknown targets and busy-recipient retry/deduplication.
- Actual offscreen Electron with production IPC/HTTP and the real native CLI
  displays the workspace-specific error, then accepts an ordinary question in
  the same chat without delivering mail; its answer survives reopening. This
  isolated check uses a loopback model fixture, not Google authentication or
  inference. Dependency lock and changed-module compilation checks pass.
- Availability: source on the Gemini development branch; not deployed or
  released. Existing development-service cleanup fencing was not bypassed.

## 2026-10-16 — Distinguish Gemini identity, chat access and delivery

- Include Gemini's native identity in detailed session responses and the
  header's ID/copy fallback. If no resumable native session has been saved,
  show a localized pending explanation instead of an unexplained dash; never
  invent a provider ID for a failed first turn.
- Label a newly granted chat route as communication permission, explicitly not
  a sent message. Queued user work still waits its turn; native MCP loading
  failures now explicitly report that no cross-chat message was sent. Folder
  trust and provider approval policy remain unchanged.
- Hide Gemini's server-attested automatic mailbox wake input, like Codex and
  Claude, without hiding real user inputs, agent progress or replies. This
  removes an empty "You" bubble exposed during actual cross-chat acceptance.
- Focused verification: 85 server regressions, eight actual CLI/HTTP lifecycle
  cases and 195 desktop component/projection cases pass; TypeScript and production compile
  pass. Native tests use a loopback model fixture, including queued sender,
  cancellation, busy recipient, reply, deduplication, revoked/unknown routes,
  denied tool approval and untrusted workspaces.
- Full desktop regression: 5,201 pass, five skip, plus eight compile/license
  checks. These counts do not substitute for the live-provider acceptance.
- Live acceptance: actual offscreen Electron with production IPC/HTTP and the
  real Google API verified queued permission without premature delivery,
  cancellation, one message each way, native IDs, purple message cards and
  reopening. Only the requested native communication tools were approved.
  A second actual-App review verifies no fake user bubble on the receiving
  mailbox turn and retained messages after reload.
- Remaining limitation: an extremely early startup Stop left a disposable
  chat behind a truthful cleanup fence. Its cleanup/race investigation remains
  open; this acceptance does not establish all lifecycle paths are ready.
- Availability: Gemini development branch and designated development service
  (server source `b668e787`), with the corrected development desktop restarted
  using its existing profile; no public release or merge. Model quota and
  workspace trust remain distinct.

## 2026-10-16 — Include Gemini native built-in skills

- Discover skills with the pinned native `skills list --all`; its default listing
  omits built-ins. Parse the native built-in marker as scope metadata rather than
  part of a skill's name, and show it in the existing composer badge. Keep native
  trust, disabled-skill and same-name override behavior, opaque selection IDs
  and file revision checks. Other providers' private skill folders are not
  advertised as Gemini capabilities.
- Verification: 43 focused server tests, three real CLI skill contracts, the
  real HTTP/CLI five-turn resume/Forget/reconnect/Delete contract, and 226
  composer tests pass. Native contracts use an isolated loopback model fixture;
  they cover built-in activation, user-skill approval, denied and approved writes,
  scope precedence, disabled entries and stale selections.
- Actual offscreen Electron using production IPC/HTTP reproduced the missing
  built-ins, then selected and activated `skill-creator` through the real CLI,
  rendered its reply and reopened the picker successfully. That activation run
  used disposable server state and a loopback model API, not Google inference.
- Live acceptance: the development service at source `b3759a17` preserved its
  identity, credentials and existing sessions. Actual offscreen Electron using
  production IPC/HTTP showed the native local and built-in inventory, selected
  `skill-creator`, observed successful native activation and rendered the exact
  requested Google API reply. Reopening the picker retained the built-in skill.
- Availability: Gemini development branch and designated development service;
  no public release, merge or mobile changes. This does not implement
  permission-mode selection or resolve the separate native-login eligibility
  issue. No client installation was required for this server-side discovery fix.

## 2026-10-16 — Always open new chats directly

- Remove the retired setup modal from the desktop dialog tree and all new-chat
  fallbacks, including first use and stale/unavailable runtime discovery. Reuse
  the last-opened chat settings; also retain custom instructions and supported
  subagent limits. Available agents remain selectable before the first send.
  Creation errors remain inline; no silent switch from a revoked API to native
  credentials, and no conversation identity or delegated/job authority copying.
- Rebind the selected provider when switching between custom API agents before
  the first turn. Do not reuse another provider's immutable connection ID;
  first-turn backend locking and credential revocation remain unchanged.
- Actual offscreen Electron with production IPC/HTTP reproduced the old
  first-chat modal, then verified direct first creation, eight inherited fields,
  Claude API to Gemini API switching, model selection, a rendered native CLI
  reply and repeated creation with the newly selected settings. This run used
  disposable server state and a loopback model API, not Google inference.
- Verification: 5,198 desktop tests pass, five skip; eight compile/license checks,
  TypeScript checks, production compilation and 37 focused server tests pass.
- Live acceptance: the same offscreen native App used the designated development
  service at source `8837b925`, created directly, inherited eight settings from
  a disposable OpenCode API chat, switched to Gemini API in the composer, and
  received the exact requested response from Google with Auto. Repeating New
  chat retained Gemini API and Auto. No endpoint credentials were changed.
- Availability: Gemini development branch and development service; the existing
  development App was restarted without packaging or changing its selected
  server. No publication, merge or mobile change. Existing provider-wide
  acceptance limitations remain unchanged.

## 2026-10-16 — Honor Gemini API Auto and saved model defaults

- Fix API chats showing Auto while admission rejected an empty model. Google's
  official Developer API now uses the pinned CLI's native `auto` alias; explicit
  chat choices and immutable connection defaults take precedence. Third-party
  gateways still require a selected model. Credential isolation and Forget
  revocation remain enforced; no global login or model setting is rewritten.
- My Agents and chat catalogs expose the effective default without pretending
  model discovery or inference succeeded. The runner now passes a saved API
  model to the CLI even when the chat has no separate override.
- Verification: 39 settings/runner/admission cases, 72 related model/runtime
  cases, 39 desktop catalog/settings cases, and two real CLI/loopback-API
  contracts including native Auto routing pass. The existing real server/CLI
  five-turn resume/Forget/reconnect/Delete contract also passes. Desktop type
  checks pass; the unchanged renderer uses its existing production compilation.
- Actual-app verification: isolated offscreen Electron using production IPC/HTTP
  against the development service, runtime source `70ed513c`. My Agents showed
  Auto without a saved model ID; an API-bound empty-model test chat displayed
  Auto and completed two consecutive real Google requests with exact requested
  replies. No model/key selection was required and no native-login fallback was
  used. The fixture chat was created through HTTP before UI sending; the rapid
  new-chat/provider-switch workflow was not accepted in this check.
- Availability: Gemini development branch and designated development service;
  no publication. This validates API Auto, not the separate Google-login quota
  issue or the remaining provider-wide acceptance checklist.

## 2026-10-16 — Bounded Gemini stress acceptance

- Runtime source `ffe22869`: a development-instance HTTP/WebSocket soak ran for
  60 seconds with 16 HTTP workers and 16 reconnecting event-stream workers.
  All 8,515 reads and 1,854 socket catch-ups succeeded; existing history and
  configuration remained unchanged. This was loopback and empty test chats,
  not a remote-network/large-history benchmark.
- A separate disposable server with actual Gemini CLI 0.64.0 and a fake local
  model API completed four concurrent chats × ten turns, with 134,890-byte
  streamed Unicode replies and 40 socket reconnects. Text stayed exact, replay
  produced no duplicate turns, UUIDs stayed isolated/stable, and Delete retained
  native history. Native repeated-output loop protection remains enabled.
- Nine additional stream/runner/approval regressions pass. An offscreen native
  Electron client used production IPC/HTTP against the updated development
  instance to inspect My Agents and select/cancel the configured Gemini API
  option in New Chat, without changing credentials or sending model requests.
- Availability: development test service only; no release/publication. Google
  account generation remains unaccepted, and full CI/platform, long-duration,
  real-network and resource-pressure acceptance are still pending.

## 2026-10-16 — Harden Gemini lifecycle and complete shared-chat wiring

- Keep native Gemini identity before visible activity/tool approval. Add an owned
  parent-death guard and verified-cleanup contract; an unconfirmed cleanup keeps
  Stop/Delete fenced instead of erasing the chat or reporting false success.
  Persist that failure fence across restart; loss of the live cleanup handle
  requires operator verification, not an automatic unlock.
  Permit only the native loader's exact leading environment-header refresh.
- Fix native-account skill discovery without an API connection and capability
  admission for scheduled chat/standalone jobs. Extend the jobs helper's provider
  selectors. Keep run-bound MCP instructions free of shell authority-file paths.
- Wire Gemini prompts, approvals and runtime updates through interactive shares.
  Fix both the shared-state allowlist and the mounted approval shelf refresh.
  Preserve share-token, CSRF, exact-chat/run and revocation checks.
- Verification: 88 Gemini cases using actual CLI 0.64.0 and a loopback fake API;
  247 related server regressions; 83 transport/cleanup/shared-control cases; 29
  jobs-helper cases; 160 queue/Stop/goal/job regression cases. These batches
  overlap and are not a unique-test total. Nine release-manifest checks pass.
  Desktop: 5,193 tests pass, five skip; type checks, production/shared builds
  and eight package/license checks pass. Native remote Google requests were not
  retried: real-account eligibility/billing acceptance remains deferred.
- Actual offscreen desktop acceptance covers API setup, New Chat, composer
  model selection, skills/approval, repeated resume, live answers and title
  import. Actual packaged shared-web acceptance covers token entry, native
  approval, two turns and revoke. English/dark, Chinese/light/narrow and keyboard
  focus were checked; native HTML-select popup interaction remains unaccepted.
- Crash-mid-tool/descendant cleanup, failed cleanup, queued Delete, unauthorized
  and revoked recipients, busy mailbox delivery, idempotent retry, WAV transport
  and three-chat concurrency have dedicated fixtures. Process sampling is not a
  security sandbox or a low-memory/load guarantee. Native Fork, native goals,
  managed subagents, side questions, explicit compaction and later external
  history reconciliation are not claimed. See the Gemini preview matrix.
- Availability: source and isolated test builds only; no server deployment,
  publication or mobile changes. Full repository CI and real-account acceptance
  remain release gates.
- The full local server-suite attempt is not a pass: it was stopped after an
  installer scenario stalled. A separate probe reproduced 22 IPC setup errors
  where the local test filesystem could not provide private POSIX file modes;
  those guards were not weakened. The relevant Gemini/adjacent suites above
  were run with disposable POSIX-backed state.

## 2026-10-16 — Extend the Gemini development preview

- Add live answer snapshots, bounded text/image/audio attachments, native
  summary adoption and opt-in main-session discovery/initial text import.
  Preserve manual titles, exact native workspace/identity, ownership exclusion
  and compatibility with older import clients. Native edits are not reconciled.
- Fix retry after an empty failed first generation without resetting existing
  conversations. Preserve native identity after exposed activity, including
  history-recorder failures; retain partial output on Stop and native tool diffs.
  CLI mode no longer assumes a custom API connection object exists.
- Exercise native queue/restart/resume, one-time approvals, denied writes,
  pending-tool Delete, retained native continuation and cross-chat send/read/
  reply. Report missing MCP under native folder trust without granting trust.
  Include new modules in installation and package manifests.
- Verification uses Gemini CLI 0.64.0, disposable state and a loopback fake model
  API: 72 Gemini tests and 247 related server regressions pass. Actual offscreen
  desktop IPC/HTTP acceptance covers API/model settings, skills, repeated sends,
  live answer delivery and native-title import. Desktop tests: 5,191 pass, five
  skip; type checking, production compilation, eight package checks and nine
  server manifest checks pass.
- Still an opt-in preview, not release-ready. Real-account acceptance is
  deferred; native Fork, later history reconciliation and remaining optional
  provider-checklist workflows are not presented as completed. No deployment
  or publication is part of this validation.

## 2026-10-15 — Use the official Gemini product icon

- Replace the approximate sparkle with Google's unmodified four-colour asset,
  bundled locally with attribution. Preserve its transparency without showing
  the fallback underneath, and include the SVG in shared-chat packaging.
- Actual desktop checks verified the sidebar, composer and new-chat provider
  picker in dark mode and emulated light/narrow layouts. Type checking,
  production and shared-renderer builds, 5,189 desktop tests and eight package
  checks passed; five desktop tests were skipped. The packaged shared-chat
  asset matches the original, but its live web route was not exercised.
- Icon-only acceptance does not resolve the Gemini preview's account, billing
  or provider-checklist limitations. No server deployment or publication.

## 2026-10-15 — Exercise Gemini connections and native skills

- Give Gemini a distinct sparkle mark and correctly name its error notice.
  Preserve custom endpoint model choices through compact session-list refreshes.
- Add bounded native skill discovery, opaque per-chat selection/revalidation,
  and native activation requests with ordinary tool permissions. API profiles
  reference installed skill assets while keeping login credentials isolated.
- Real pinned CLI/local API fixtures cover native activation, approve/deny,
  continuation and cleanup. A skill-follow-up regression found native load-time
  history normalization; accept only its exact known text/tool transformation
  while still rejecting unrelated changes and suppressing historical replay.
  Targeted desktop tests, type checking and production
  compilation pass. Real desktop sends reached Google's service but eligibility
  and API billing responses block successful real-account acceptance.
- This remains an opt-in development preview. Cross-chat, complete streaming
  parity, titles/import, mobile and the other recorded provider-checklist gates
  are not accepted merely because basic fixtures pass. Nothing is published.

## 2026-10-15 — Begin an opt-in Gemini provider preview

- Add an experimental desktop/server Gemini CLI adapter behind a development
  flag, pinned to CLI 0.64.0. Google CLI login and Gemini Developer API credentials
  remain isolated; ACP is the transport, not a separate login method.
- Wire My Agents, native model discovery, same-session continuation, bounded
  approvals and run-bound provider tools. Guard asynchronous native history
  replay so it cannot be appended as a new response. Forget must not fall back
  to another account; Delete preserves native history.
- Actual CLI and HTTP contracts used a loopback fake API and disposable state.
  Actual offscreen desktop acceptance exercised configuration, displayed model
  options, manual default selection and two sends through production IPC/HTTP.
  It caught and fixed a client backend allowlist omission and duplicate replay.
- Validation: 252 focused desktop tests, TypeScript and production compilation;
  server batches of 773 lifecycle/authorization regressions, 129 runtime checks,
  72 provider/transport checks and 20 packaging-manifest checks passed. These
  batches overlap; they are not a full-suite or real-Google acceptance claim.
- Not release-ready: real Google account/API, tool/cross-chat/native parity,
  new-chat dialog and native select-popup acceptance remain pending. Imports,
  automatic titles, attachments, fork, skills UI and mobile are not included.
  See the server's Gemini preview record for precise limits and remaining gates.
## 2026-10-17 - Camera-based server pairing

- Add a live QR scanner inside the existing mobile Add Server drawer. Reuse the
  versioned CLI payload, mask the token, authenticate the decoded address, and
  require any encoded server identity to match before enabling Add. Scanning
  never saves immediately; cancel, stale tests and duplicate camera events do
  not replace existing profiles. Manual connection remains available.
- Request camera access only on scanner entry, release the preview in the
  background, support denied-permission recovery, and keep older Dev binaries
  usable until their native camera update is installed. No microphone access,
  QR-image import, connection deep-link activation or third-party QR service.
- Interactive installation and token display render a locally generated QR
  after authenticated health. Fresh npm postinstall writes it only to the
  controlling terminal, not lifecycle logs. QR failures are nonfatal. Include
  the renderer and its notices in the exact server runtime file inventory.
- Build iOS camera code from source, matching the existing video dependency
  policy. The precompiled camera framework failed the bundled ABI gate; the
  source-built Dev app passes dependency parity and bundled-framework checks.
- Verification: TypeScript, 383 mobile UI/source tests, QR parser cases, 32 CLI
  tests, 120 installer/CLI-package tests, 33 focused installer/package checks,
  two process-startup tests, and iOS/Android Hermes exports. Nested QR payload
  directories reject linked parents in both packaging and installation.
  A real isolated server installation emitted a terminal QR; an independent
  Vision decode of its PNG authenticated the exact encoded identity. Simulator
  UI verification filled a real decoded payload, tested, saved and switched,
  then restored the original profile and removed the disposable profile.
- Integrate current main and update the isolated local test server without
  replacing the stopped legacy test instance or its data. Install and launch
  the signed camera-enabled iPhone Dev app under its separate bundle identifier;
  leave the production app unchanged.
- Acceptance boundary: the simulator received an injected decoded barcode
  event, not a physical camera image. Live phone capture and Android native
  interaction still require device verification. No release or upload.

## 2026-10-17 - Validate the mobile UI review candidate

- Update rendering-test host mocks for the appearance preference and shared
  corner tokens. Keep permission and model-selection assertions aligned with
  provider-aware routing without weakening admission or catalog-isolation checks.
  This resolves the seven test failures recorded in the preceding UI pass; no
  additional product UI changes were needed.
- All 371 mobile UI/source tests and TypeScript passed. Focused provider-mode,
  client transport, session creation, multi-server store, latest-first sync,
  preference migration, optimistic mutation, date formatting, runtime-catalog
  and smart-group regressions passed. Production-mode Hermes bundles and assets
  exported successfully for both iOS and Android; this is not a signed native
  release or store submission.
- The final installed iPhone simulator smoke passed three settings-navigation
  rounds, agent-mark checks, search dismissal, and server-editor back/close.
  Earlier checks cover API selection through the actual server. Earlier
  repeated light/dark and enlarged-text checks remain applicable. Actual server
  selection was verified without sending model requests. Live provider inference,
  Android-device and tablet acceptance remain unverified. Review candidate only;
  no TestFlight upload, deployment or merge is authorized by this validation.

## 2026-10-17 - Show agent marks in mobile chat selection

- Native chat choices now use the agent name without a Native suffix; Custom
  API choices retain their explicit label. Share a bounded, scrollable picker
  between the composer and new-chat defaults, with existing agent marks before
  each name and a trailing selection check. The iOS native menu cannot render
  these bitmap marks. Preserve provider guards, model reset and reload behavior;
  dismiss the picker before an action can show an iOS alert.
- TypeScript and focused regressions passed, including 120 picker interactions
  across iOS/Android host fixtures, explicit API routing, stale-scope rejection
  and locked-chat behavior. The installed iPhone simulator passed five rounds of
  settings, theme, agent-choice and server-drawer navigation, plus search/keyboard
  dismissal and unsaved server-editor back navigation. Light and dark screenshots,
  including enlarged text, were reviewed. A disposable chat selected an existing
  API connection through the real server and was deleted without sending a message.
  Test preferences were restored; no server credentials were edited.
- Broader UI regression testing still has seven failures: three host mocks lack
  Appearance, two theme mocks lack radius, and two source contracts still assume
  the pre-provider-mode expressions. These are recorded for follow-up, not treated
  as passing tests. No new interaction failure reproduced in the exercised iOS
  flows. Physical-device, Android device and tablet acceptance remain unverified.
  No PR, release build, upload or additional UI fixes in this test pass.

## 2026-10-17 - Distinguish mobile account modes and center server onboarding

- My agents now separates native credentials from configured Custom API
  connections using the selected server's safe runtime metadata. Mobile does
  not edit endpoint addresses or keys. Old servers retain native behavior and
  show an upgrade hint for custom connections.
- Add native/API choices to new-chat defaults and the existing pre-first-turn
  agent menu for the mobile client's Codex, Claude and Cursor backends. Send
  explicit per-chat routing, persist the selected default, isolate API model
  choices from native catalogs, and keep started chats bound to their original
  connection. Reject unavailable custom defaults or ignored routing responses
  rather than silently switching to native. OpenCode remains status-only on
  mobile; this does not implement another chat backend.
- Replace the synthetic welcome-chat entry with a centered welcome surface and
  setup action that opens the existing half-height Add Server drawer. Clear old
  ephemeral welcome state without deleting real chats or server configuration.
- Basic validation: TypeScript, focused UI, provider-selection, client transport,
  session creation, mutation and preference regressions passed. The installed
  Debug iPhone simulator exercised My agents, the default agent picker, creating
  a disposable chat and switching it to an already-configured Cursor API through
  the actual server. Confirmed the returned custom binding and removed only that
  test chat; no messages, model requests or credential changes were made.
  A reversible empty-workspace fixture exercised centered onboarding and the
  real native Add Server drawer; no connection was saved. Light-mode screenshots
  were reviewed. Live Codex/Claude API runs, Android, tablet and physical-device
  acceptance remain unverified. Local preview only; no build release or upload.

## 2026-10-17 - Contain mobile server setup badge backgrounds

- Clip the translucent fill of each numbered connection step to its fixed
  circle. This narrowly guards against a reported light-mode blue rendering
  artifact without changing inputs, validation or connection behavior.
- Basic validation: TypeScript and 15 focused checks passed. The badge clipping
  assertion failed before the change and passed after it. The Debug iPhone
  simulator exercised drawer expansion, secure dummy-token entry and editor
  back/reopen in light mode, with no stray line visible. No connection was
  tested or saved. The original intermittent artifact was not reproduced in
  the simulator, so confirmation on the reporting physical device remains
  pending. The independent phone Dev app was refreshed; no release build,
  native dependency change, dark-mode or Android acceptance in this iteration.

## 2026-10-17 - Simplify mobile settings navigation and agent status

- Open Privacy directly in the browser with an external-link indicator. Keep
  Android usage analytics in its own settings row. Add a Server shortcut that
  waits for the iOS settings sheet to dismiss before opening the existing
  half-height server drawer.
- Replace Agents & runtime with My agents: Codex, Claude Code, Cursor and
  OpenCode, matching this branch's desktop inventory. Show green checks only
  for ready agents on a connected server, mute unavailable entries and keep
  one server-machine sign-in hint. Recheck refreshes the existing server
  runtime catalog, suppresses duplicate taps and scopes pending UI state to
  the current server. Remove the persistent-goals settings control, not the
  underlying chat feature. This does not enable additional chat backends.
- Show a Tailscale server hostname only for a connected, configured tailnet
  domain. No phone VPN/account detection or inference from an IP address.
- Basic validation: TypeScript, diff whitespace checks and 14 focused tests
  passed. The Debug iPhone simulator exercised Recheck, four-agent rendering,
  repeated settings-to-server handoff, browser privacy loading and returning
  to the app. Light-mode screenshots were reviewed. Refreshed the independent
  phone Dev app without replacing the release app; physical visual acceptance,
  Android and tablet checks remain pending. No chats, profiles, provider runs
  or server settings were changed. Local preview only, no release build.

## 2026-10-17 - Simplify mobile server-editor actions

- Remove the redundant editor Cancel button; retain the header back and close
  actions. Shorten Add & switch to Add without changing successful connection
  testing, server creation or automatic activation. Keep Save for edits and the
  existing-server action when a tested connection is already saved.
- Basic validation: TypeScript and 26 focused checks passed, including the
  test/create/switch sequence in a fixture. The Debug iPhone simulator verified
  the two-button add form, back navigation and closing/reopening. No server
  profile was created or changed. Android and physical visual checks remain
  pending; local preview only.

## 2026-10-17 - Move mobile folder indicators to the trailing edge

- Move expand/collapse chevrons after the count at the right of folder headers,
  including Unread and Running. Keep status dots before the title, whole-row
  toggling and existing folder actions. Expose the expanded accessibility state.
- Basic validation: TypeScript and 27 focused checks passed. The Debug iPhone
  simulator collapsed and expanded a running group and an ordinary folder,
  restored both, and verified the light-mode layout. Android, tablet and
  dark-mode/physical visual acceptance remain pending for this small iteration.

## 2026-10-17 - Clarify mobile home buttons and simplify chat dates

- Give the settings, new-chat and server-selector buttons a consistent 1pt
  outline and themed control surface, with clearer separation in light mode.
  Preserve their touch targets, actions and the transparent footer fade.
- Show Today, Yesterday or a date for chat activity; retain the year for dates
  outside the current year and omit time-of-day. Use a shared, readable tertiary
  text color. Keep the existing activity timestamp source and chat ordering.
- Document five typography sizes, four named font weights and semantic palette
  roles. Migrate home/server text styles to these tokens and add a focused check
  against literal text metrics, weights and colors in those adopted surfaces.
  Other legacy screens remain a gradual migration, not a global font rewrite.
- Basic validation: TypeScript and 57 focused checks passed. Date tests passed
  in American and Asian time zones, including calendar and DST boundaries. The
  Debug iPhone simulator exercised settings/theme navigation and the server
  selector, with light/dark home screenshots reviewed for outlines and dates.
  Yesterday is fixture-tested; no chat or server data was changed. Android,
  tablet and physical-device visual acceptance remain pending. Local preview only.

## 2026-10-17 - Group mobile settings and add appearance preferences

- Replace the expanded settings form with App, Server and About category rows.
  Keep text size, new-chat defaults, runtime diagnostics, supported Codex goal
  settings, privacy controls and Android updates accessible in detail pages.
  Back returns to the list; close dismisses the sheet; reopening starts at the
  list. Server address and token editing remain in server management only.
- Add System, Light and Dark appearance choices, applied immediately to the app
  palette and native appearance and saved independently of server profiles.
  Preserve the latest selection during startup hydration and rapid changes;
  report local persistence failures without blocking theme selection.
- Basic validation: TypeScript and 25 focused checks passed. The Debug iPhone
  simulator exercised category navigation, back/close/reopen, text-size controls,
  light/dark switching, theme persistence after process restart and following
  system appearance changes. Light/dark screenshots were reviewed. Android
  navigation and update availability were fixture-tested only; Android, tablet
  and physical-device visual acceptance remain pending. No server settings,
  chats or provider jobs were changed. Local preview only; no release build.

## 2026-10-17 - Prioritize unread and running chats on mobile

- Add temporary Unread (blue dot) and Running (green dot) groups before ordinary
  sidebar folders, in that order. Each hides when empty. Active chats take
  precedence over unread classification, appear only once, and retain their
  saved folder and pin metadata. Archived chats and the local welcome guide
  remain in their existing sections.
- Support collapsing each temporary group without persisting it as a folder,
  adding it as a move destination, or colliding with similarly named real folders.
  Preserve search and existing chat ordering; manual row reordering remains in
  ordinary folders.
- Basic validation: TypeScript and 33 focused checks passed. The Debug iPhone
  simulator displayed real server activity, marked an empty test chat unread,
  verified group ordering and collapse/expand, restored its read state, and
  verified opening an unread chat returns it to its original folder. No messages,
  provider runs or folders were created. Run-completion transitions and empty
  groups were fixture-tested; light-mode screenshots were reviewed.
- Scope: existing unread/read-receipt semantics are unchanged. Visibility gating
  of automatic read receipts for a selected chat hidden behind the home screen
  remains a separate follow-up. Android, tablet and dark-mode/physical visual
  acceptance remain pending. Local preview only; no release or server change.

## 2026-10-17 - Number the server connection fields

- Give the shared add/edit connection form compact blue outlined step numbers
  for Name (optional), Server URL and Access token. Separate the three field
  groups with consistent spacing and use short example placeholders. Preserve
  optional-name handling, secure token entry and connection validation.
- Basic validation: TypeScript and 26 focused checks passed, including numbered
  labels and creating a profile without a name in a fixture. The Debug iPhone
  simulator verified half/full form presentation, input with the software
  keyboard, back/discard and closing. Light-mode screenshots were reviewed;
  no connection settings were saved. Android, tablet, dark-mode and physical
  visual acceptance remain pending for this iteration. Local preview only.

## 2026-10-17 - Open server management at half height

- Present server management at a half-height native detent, with a grabber to
  expand to full height or collapse again. Reopening starts at half height;
  retain the separate editor-back and drawer-close actions.
- Reuse the existing React Native Screens dependency. Keep its presenter mounted
  during dismissal without intercepting home touches while closed. Let the
  native form sheet handle keyboard resizing instead of applying duplicate
  scroll adjustments that can hide the focused input.
- Basic validation: TypeScript and 25 focused checks passed. The Debug iPhone
  simulator exercised half/full/collapsed detents, close/reopen, swipe dismissal,
  current-server selection, unsaved add input with the software keyboard,
  editor back, the edit menu, folder cancel, and opening from home search.
  Light/dark screenshots were reviewed. No server settings were saved and no
  messages or folders were created.
- Availability: local development preview only. Android, tablet and physical
  device visual acceptance remain pending. No dependency upgrade, native release,
  publication or server change.

## 2026-10-17 - Separate server-editor back and drawer close

- Use one fixed header for the server list and its editor. Add and edit show a
  back arrow with their page title instead of a redundant Servers heading and
  a second close icon. Back discards the unsaved form and dismisses its keyboard;
  the single upper-right close action dismisses the entire drawer.
- Basic validation: TypeScript and 23 focused checks passed. The Debug iPhone
  simulator exercised adding with unsaved text, returning to the list, reopening
  an empty form, closing the drawer from the editor, and editing/back navigation.
  Light-mode screenshots confirmed one title and one close action. No connection
  settings were saved and no server request contract changed.
- Availability: local development preview only; dark-mode, Android, tablet and
  physical-device visual acceptance remain pending for this iteration. No
  native release, publication or server change.

## 2026-10-17 - Shorten server overflow actions

- Remove Move up and Move down from each server's menu and shorten its remaining
  actions to Edit and Remove. Keep current-server removal disabled and preserve
  the confirmation before removing any saved connection. Stored ordering and
  server persistence are unchanged.
- Basic validation: TypeScript and 21 focused checks passed. The Debug iPhone
  simulator verified both menu labels, absence of ordering actions, opening and
  canceling the editor, and opening and canceling removal confirmation for an
  inactive profile. No server profiles were modified or removed.
- Availability: local development preview only; Android and physical-device
  visual acceptance remain pending. No release or server change.

## 2026-10-17 - Consolidate home actions and open servers directly

- Move New folder beside Search in the top row with a wider gap, removing its
  separate toolbar row. Make the server name an outlined rounded button while
  retaining truncation, connection status and the reserved refresh indicator.
- Open the existing server sheet directly instead of an intermediate popup.
  Present saved servers as tappable rows with a current-server checkmark and
  one Add server entry. Keep edit, reorder and confirmed removal in each row's
  overflow menu; show the connection editor separately from the server list.
- Close the drawer after successful selection, without reconnecting when the
  current server is selected. Keep failures visible, and prevent a completed
  switch from dismissing a newer drawer after its original view was closed.
  Preserve identity validation and secure credential handling.
- Basic validation: TypeScript and 45 focused checks passed. The Debug iPhone
  simulator exercised folder opening/cancel, direct drawer presentation,
  add/edit/cancel, current-server selection, switching between two saved
  servers and back, long-name truncation, opening from search, and testing the
  existing connection through the actual server. Screenshots were reviewed in
  light mode. No messages, folders or new server profiles were created, and
  connection settings were not saved or removed.
- Availability: local development preview only. Failed-switch and stale-view
  completion paths were fixture-tested. Dark-theme, Android, tablet and physical
  visual acceptance remain pending for this iteration; no native release,
  publication or server deployment.

## 2026-10-17 - Close home search after opening a chat

- Close and clear home search after a chat row successfully navigates, including
  history-result and local welcome rows. Cancel pending search debounce and
  invalidate stale results through the existing clear-search action. Preserve
  the query when a history result cannot open or its server scope has changed.
- Reuse the same cleanup for the close button and empty-search dismissal;
  ordinary chat navigation still opens immediately without waiting for sync.
- Basic validation: TypeScript and 27 focused checks passed, including executed
  callback tests for cleanup, immediate navigation, history success/failure and
  stale-server completion. The Debug iPhone simulator reproduced the retained
  search before the change, then verified title search, direct and submitted
  result selection, back navigation without the search field, and reopening an
  empty search against the configured server. No messages were sent.
- Availability: local development preview only. History-result failure and
  stale-server paths were fixture-tested, not exercised against a failing live
  server. Android, tablet and physical-device visual acceptance remain pending;
  no native release, publication or server change.

## 2026-10-17 - Show chat-list refresh beside the server name

- Show a small loading indicator immediately after the active server name
  during pull-to-refresh, sharing the list's existing profile-scoped refresh
  state. Clear it when that refresh settles; do not add a minimum animation
  duration or tie it to background timeline synchronization.
- Reserve the indicator's space to keep the title stable, expose the busy
  state to accessibility, and leave server switching available during refresh.
- Basic validation: TypeScript and 30 focused sidebar, server-profile and
  profile-safety checks passed. The Debug iPhone simulator exercised a real
  pull gesture with a one-shot, test-only eight-second delay before the actual
  session-list request. The indicator remained visible while pending and
  disappeared after the request returned HTTP 200. Restored the test hook;
  no production delay, messages or chat mutations were introduced.
- Follow-up validation: two unmodified, real pull-to-refresh requests returned
  HTTP 200 before the header and native refresh-control props became false in
  the same React commit. Simulator video confirmed the native control's closing
  animation remains visible afterward. This is list-refresh progress, not an
  indication that independent timeline synchronization has completed. Restored
  the local timing hooks; no application behavior was changed by this check.
- Availability: local development preview only. Physical-device visual,
  Android and tablet acceptance remain pending; no release or server change.

## 2026-10-17 - Let home chats scroll behind the footer fade

- Remove the list viewport's bottom margin so chat rows remain visible behind
  the transparent portion of the footer gradient instead of ending at a hard
  horizontal boundary. Use trailing content padding equal to the fade height
  so the final row can scroll fully above the overlay. Preserve phone-search
  layout and the independent circular actions.
- Basic validation: TypeScript and 20 focused sidebar/theme checks passed.
  The Debug iPhone simulator in dark mode exercised scrolling through the fade
  and opening/closing Settings; screenshots confirmed progressively fading
  chat rows underneath the overlay. No messages were sent or chats changed.
- Availability: local development preview only. No release, server changes or
  Android/tablet acceptance in this pass.

## 2026-10-17 - Fade home actions and dismiss unused search

- Add a touch-transparent vertical footer gradient, fading from transparent
  into a darker neutral shade in each theme. Keep the circular action sizes,
  positions and reserved list space unchanged; reuse existing SVG rendering.
- Close an empty or whitespace-only home search on blur or an outside tap.
  Preserve nonempty queries/results, and exclude touches within the search
  field and its opening button from outside-tap dismissal. Do not capture chat
  row responders or change session creation/persistence.
- Basic validation: TypeScript and 59 focused UI checks passed. The Debug iPhone
  simulator exercised empty/whitespace dismissal, input touches, nonempty query
  retention after outside taps and submission, and Settings in both themes.
  Verified that tapping a chat while empty search is open navigates on the first
  tap and returns without the search field. No messages were sent.
- Availability: local development preview; refreshed the independent physical
  iPhone Dev app. Physical visual, Android and tablet acceptance remain pending.
  No native rebuild, release, server change or publication was performed.

## 2026-10-17 - Use independent circular mobile home actions

- Move New chat from the upper toolbar to a circular bottom-right action;
  place Settings in a matching bottom-left action. Only the circles have a
  surface color, with no full-width footer background or divider. Reserve list
  space above the buttons so they cannot cover chat text or intercept row taps.
- Retain the existing guarded quick-create flow and hide both actions while
  phone search is open. Preserve the server-switch and setup guards.
- Basic validation: TypeScript, 57 focused UI checks and the existing mocked
  session-creation/fork regressions passed. The Debug iPhone simulator exercised
  Settings, search opening/closing, direct creation through the configured
  server, and back navigation without sending a message. Removed only the
  disposable chat created by this check. Development warnings briefly covered
  the first UI attempt; the actions were exercised again after dismissal.
- Confirmed a remaining mobile gap: creating a chat persists it immediately;
  the client does not yet use the server's per-client empty-placeholder dismissal
  contract. Returning without sending still retains the row. This change does
  not implement automatic cleanup or alter existing chats/drafts.
- Availability: local development preview only. Android and tablet UI acceptance
  remain pending; no release build, publication or server deployment occurred.

## 2026-10-17 - Simplify mobile home surfaces and dock phone search

- Use the same background for the home list and top safe area. Remove the
  footer divider and persistent selected-chat background/rail; retain pressed
  feedback and running/unread status indicators. Settings remains a transparent
  icon with a circular touch target.
- Place phone search below the results and immediately above the software
  keyboard. Closing clears the filter and restores Settings; the keyboard Search
  action submits the current query and dismisses the keyboard. Keep tablet
  search at the top and preserve server-generation guards and search debounce.
- Replace hard-coded component corner radii with shared small, control, sheet
  and circular tokens, preserving control dimensions and proportional shapes.
- Basic validation: TypeScript and 31 focused sidebar, theme, server-profile
  and profile-safety checks passed. The existing Debug iPhone simulator exercised
  search opening, typing, title/history results through the configured server,
  no-match results, closing/reopening and Settings opening/closing in light and
  dark themes. Verified software-keyboard positioning and Search submission.
  No chat messages were sent or server settings changed.
- Availability: local development preview only. No server update is required.
  Android, tablet, full secondary-screen and physical-device visual acceptance
  are not claimed; broader regression remains deferred for this UI iteration.
  No native release build or publication was performed.

## 2026-10-17 - Prepare an independent mobile development variant

- Add an opt-in development configuration named AgentsDock Dev with separate
  app identifiers and URL scheme, leaving the default shipping configuration
  unchanged. Reject unknown variant names instead of silently selecting the
  shipping application.
- Document separate device installation and native regeneration when changing
  variants. Check the effective Info.plist build version for generated Expo
  projects, including projects that use a literal rather than an Xcode variable.
- Validation: eight variant, native metadata and privacy checks plus TypeScript
  passed. Expo generated the independent iOS project and its distinct URL schemes.
  Native dependency parity checks and a local iOS Debug build passed. Verified
  the signed development identifier, bundled JavaScript and device provisioning,
  then installed and launched the separate app on a physical iPhone. Confirmed
  that the shipping app remained installed unchanged and the development process
  stayed running. On-device visual and connected-server acceptance remain pending;
  no existing app was replaced and no build was uploaded or published.

## 2026-10-17 - Establish mobile visual foundations

- Add shared UI typography roles, spacing and corner-radius tokens. Apply them
  to primary navigation, server management, settings forms, chat headers,
  composer surfaces and message metadata without changing their actions.
- Increase small navigation labels, soften font weights, and give chat rows
  more breathing room. Use neutral surfaces and message backgrounds while
  retaining distinct connection, running, unread and error colors.
- Preserve app-wide text scaling and measured Markdown, code and terminal
  typography. This is an incremental style pass, not a component-library
  migration or a redesign of every secondary panel.
- Basic validation: TypeScript, 31 focused UI/theme checks and the typography
  regression entrypoint passed. The existing Debug iPhone simulator exercised
  search typing/clearing, server management, chat opening, input focus and
  return navigation in light/dark themes, plus repeated Settings opening and
  closing in light mode. No messages were sent or server profiles changed.
- Availability: local development preview only. No fresh native release build,
  Android/device acceptance, full keyboard regression or publication is claimed.
  Broader testing remains deferred until the UI iteration is complete.

## 2026-10-17 - Simplify the mobile home header

- Replace the homepage brand title and footer counters with one footer Settings
  action. Keep the existing settings contents and per-chat activity indicators.
- Move server selection to the top with its original compact typography and
  connection-status dot. Long names truncate within half the available row;
  the native server menu remains, without a duplicate URL subtitle.
- Add a top-right search icon that opens and focuses the search field;
  closing search clears the filter and dismisses the keyboard.
- Replace the refresh toolbar button with native list pull-to-refresh using the
  existing generation-scoped refresh action and a request-bound loading state.
- Basic validation: TypeScript and 25 focused UI source checks passed. The local
  iPhone simulator exercised the pull gesture, server menu opening/dismissal,
  search opening, typing, closing and reopening with the filter cleared, and
  earlier repeated Settings opening/closing. No server profile was changed
  by these checks. Full regression and device coverage are deferred until the
  UI iteration is complete. Availability: local development preview only.

## 2026-10-17 — Let a Team Space host stop hosting and join another team

- Add a visible **Stop hosting…** action that invokes the existing Host-to-Member
  operation. Replace the old listener-only control, which left the Host role
  active and prevented joining another team. Confirmation explains that peer
  access stops while chats and the original team's stored data remain intact.
- Retire only the desktop's obsolete managed-host session cache after confirmed
  demotion. Keep human sign-in records, server-owned teams and peer pairings.
  Recover a committed stop whose response or follow-up health request failed
  using explicit authenticated role evidence, retaining the original warning.
- Clear the old workspace and expose joining; restore a previously joined remote
  team's workspace when the server resumes that membership. Preserve pending
  invitations and ignore results belonging to a different selected server.
- Validation: 1,040 focused desktop checks, TypeScript and production compilation
  passed. Sixteen isolated server checks and a real TLS lifecycle probe passed.
  An unrelated filesystem fixture requires its expected POSIX umask; its isolated
  rerun and the final scoped suite passed with that setting.
- Native acceptance: reproduced the missing exit in the baseline desktop, then
  personally exercised the compiled app offscreen with disposable real servers:
  cancel, failed stop and retry, successful stop, lost response after committed
  stop, invitation-based joining, and reconnect after renderer reload. Mail sent
  through native IPC was read on the new host. Reactivating the original host
  preserved its hub/team identities and saved message. Host approval and original
  team reactivation used authenticated fixture APIs; provider runtimes were not
  invoked. No installed apps or production services were changed.
- Visual acceptance: checked the actual desktop at 1040 × 780 in light and dark
  appearance, including English and Chinese confirmation, keyboard focus,
  Escape/cancel, and the recovered stop's dismissible warning and join form.
- Availability: desktop source and isolated development build only. This uses the
  existing server host-control contract; no new server deployment is required.
  Signed-package and other desktop-platform acceptance are not established here.

## 2026-10-17 — Retire unavailable Codex model choices without deleting chats

- Scope known Codex model retirements to native ChatGPT sign-in. Filter the
  discovered list, configured defaults and fallback options; publish replacement
  metadata so the desktop does not reinsert an old chat's retired selection.
  Native API-key authentication and custom endpoints keep their own availability.
- Migrate an old selection at the next admitted turn, retaining the native
  conversation ID and history. Preserve supported reasoning levels, record a
  visible model-change event, and leave running work untouched. Standalone
  scheduled runs migrate their runtime snapshot without rewriting the parent.
- Discard the older desktop model-catalog cache on upgrade, rather than retaining
  its obsolete default until the cache expires. Historical model names remain in
  history; this change does not rewrite transcripts or hide provider errors.
- Validation: 244 targeted server checks and 477 targeted desktop checks passed;
  TypeScript, production compilation and output verification passed. The desktop
  filesystem fixture suite required its expected POSIX umask; a first run under
  a restrictive umask failed an unrelated clipboard-directory fixture.
- Native acceptance: reproduced the obsolete default and reinserted selection in
  the baseline Electron app. An isolated native development app and real
  authenticated server then hid that selection, migrated a disposable saved
  selection on send, and completed two real Codex continuations with the same
  provider thread and remembered context. Reopening retained history and exactly
  one migration notice; a new chat using Server default also replied successfully.
  The QA launcher isolated local-server discovery from existing installations;
  provider calls, Keychain access and client/server transport were real.
- API/custom exceptions and scheduled-parent isolation used deterministic fixtures,
  not live paid endpoints or a long-running production schedule. Native compaction
  recovery and its error attribution remain separate work tracked in issue #89;
  this test does not establish recovery of previously failing long contexts.
- Availability: source branch and isolated development testing only. Both server
  and desktop updates are needed; no production instance or public release changed.

## 2026-10-16 — Integrate responsive history maintenance with current main

- Move provider-history preparation outside chat admission locks, retaining
  ownership proofs and source/cursor validation before committing results.
  Persist explicit send request identities and queue recovery checkpoints so
  lost responses can be retried without admitting duplicate work.
- Preserve current event-stream liveness and recovery while adding bounded
  refresh notifications when background history projection changes.
- Port the history-responsiveness changes without release-branch version bumps
  or unrelated release-only changes. This requires both updated app and server.
- Validation: 614 focused desktop tests passed; backend batches of 280 and 182
  checks passed (including overlapping transport coverage and a 330 MiB import
  fixture). TypeScript, production compilation and output verification passed.
- Isolated native Electron exercised authenticated real transports, Codex and
  Claude replies, same-provider-session continuation after restart, queued work,
  Stop and subsequent sending, navigation, and large synthetic history views.
  Eight concurrent retries after discarding a real send response joined one
  durable admission; retry after server restart retained that receipt.
- Full CI exposed incomplete isolated-test dependencies and regressions in
  native-title refresh, partial-record migration proof and empty session-list
  metadata. Restore the title lookup outside admission locks, require a fully
  scanned journal for migration and keep never-started maintenance sparse.
  Known maintenance failures and their cleared state remain visible. All 230
  targeted history, title, mailbox, provider and session-summary checks pass.
- Availability: local source integration and development app only; no public
  release or installed production update. Large fixtures validate display and
  storage behavior, not provider memory. Cold indexing still depends on
  transcript size; signed-package, cross-machine and all-provider acceptance
  are not established by these checks.

## 2026-10-15 - Remove mobile QR connection setup

- Removed the mobile camera scanner, QR-image import, connection-link handler
  and setup prompts. Removed the camera dependency and plugin, camera permission
  and pairing URL scheme. Manual server URL/token entry, authenticated connection
  tests, identity checks, secure storage, photo/video attachments and the legacy
  terminal URL scheme remain. Desktop and server pairing code is unchanged.
- Restrict terminal deep-link matching to the outer URL so a discarded connection
  payload containing a terminal URL cannot open the terminal accidentally.
- A clean candidate using the committed dependencies passed TypeScript, seven
  focused library/store test entrypoints, 310 UI checks and an iOS JavaScript
  export. One generated-native-metadata check was skipped in the source-only
  candidate. CI now checks manual connection and the absence of QR entry points.
- Actual iPhone simulator interaction verified manual add/test/save/switch
  against an isolated production server, three repeated management openings,
  light/dark presentation and a cold launch with saved-token authentication.
  Installed-bundle checks verified no camera permission or pairing scheme while
  retaining photo-library permission. Old connection links do not present setup
  or open a terminal through an embedded URL. No user chat messages were sent.
- Native acceptance used an ad-hoc-signed Debug simulator build with Keychain
  entitlements and the existing local SDK-aligned dependencies. Those unrelated
  dependency adjustments remain outside this change. No physical-device or
  Android acceptance, TestFlight upload, release or server deployment is claimed.

## 2026-10-15 - Stress-test mobile sync and connection fixes

- Added repeatable CI coverage for latest-first sync, recovery, stable native
  Markdown nodes, server-name migration and the first-page navigation change.
- Store stress passed 40 cycles across eight chats with 36,000 events and
  1,200 duplicate deliveries. Checks cover bounded snapshots, one active
  stream, repeated retry taps, transient failures, backgrounding, late HTTP
  responses and retired-stream callbacks. Rendering stress retained all 160
  paragraph host instances through 300 text/appearance updates using the real
  Markdown renderer with mocked native hosts. Profile migration preserved 64
  identities, custom names and credential versions across 100 round trips.
- A clean candidate using the committed lockfile passed all 28 focused
  TypeScript test entrypoints, type checking, 307 UI checks and an iOS production
  JavaScript export. One generated-native-metadata check was skipped because
  the source-only candidate has no generated native project. Updated stale UI
  source assertions and removed an integration fixture race by waiting for
  reconnect's optional runtime request before measuring identity rejection;
  that integration check also passed 20 consecutive runs.
- Six production mobile API clients made 60 latest-page reads and underwent
  18 forced WebSocket disconnects against the isolated production service.
  Every client received all 105 expected events in order, without duplicates.
  The fixture used synthetic Claude and Codex history, not model requests.
- Actual iPhone simulator input repeated 20 long-chat openings, three
  background/foreground cycles and five right-edge server-menu openings. All
  returned the latest content and remained operable. Adding an unnamed server
  displayed its host and port. The original profile was retained throughout.
- Native checks reused the installed development app and its local SDK-aligned
  dependencies. Those dependency adjustments are excluded from this repair PR;
  no native release archive, physical-device or real-provider parity acceptance
  is claimed. The affected real conversation still needs user confirmation.

## 2026-10-14 - Open mobile long chats latest-first

- Opening a chat, returning to the foreground, or recovering a disconnected
  timeline now fetches the latest bounded page before subscribing. Cached
  content remains visible until that page arrives; healthy live windows keep
  their bounded delta path. Older history remains available through paging,
  and servers without semantic paging retain the legacy tail fallback.
- Replacement reads retire the previous stream. Concurrent send results are
  retained, but the replacement stream starts at the HTTP snapshot boundary
  so intervening events cannot be skipped. Failed or obsolete reads cannot
  clear visible content or restart an old chat's stream.
- Markdown now memoizes its parsed AST and gives paragraphs and the root
  stable structural keys. Text updates no longer remount every native text
  view; links, code, tables, math and range-selection rendering are retained.
- Regression tests reproduced old-cursor reads and native text remounts before
  the fix. Latest-first, fallback, retry, background, concurrent-event and
  retired-response tests pass, along with store/client/history regressions,
  63 rendering/contract checks, TypeScript and an iOS production JS export.
- Exercised the installed iPhone simulator against an isolated instance of
  the production service with 2,000 synthetic turns / 8,000 initial events per
  Claude and Codex chat: latest opening, repeated reopening, live appends,
  draft retention, upward pagination, return to latest and foreground recovery.
  Light/dark rendering was inspected. A Claude live-update recording sampled
  at 30 fps had no blank transcript frames; this is not a guarantee against
  every form of flicker. The history automation was adjusted after automatic
  pagination moved its target, and the resulting older page was checked in-app.
- Availability: local mobile branch and simulator only; no server deployment,
  publication or native archive. Real provider output parity, the user's
  affected conversation, physical devices and network switching remain
  unverified. Server/provider history and model context are unchanged.

## 2026-10-14 - Use readable mobile server names

- Unnamed mobile connections now use the URL host and port instead of the
  internal server identity. Loading saved profiles repairs names equal to that
  identity while retaining other names, profile IDs, credential versions,
  timestamps and identity-scoped workspaces.
- The server selector measures its available row width explicitly so the
  intrinsic native menu label does not shrink the button to its text.
- Removed the first-page Team Network shortcut as requested, retaining its
  existing workspace and other entry points.
- Verified the installed iPhone simulator development app against the existing
  connected server: the saved name migrated, the selector filled its row, and
  right-edge taps, menu reopening and server management displayed the same
  address in light and dark modes. No chat messages were sent. New-profile,
  legacy migration, credential/draft preservation and pairing paths also passed
  focused tests; those tests use isolated fixtures, not a new live pairing.
- Profile/storage/store regressions, 14 UI source-contract checks, TypeScript
  and an iOS production JavaScript export passed. Source: local changes on
  `988edb6e`; no new native archive, physical-device or Android acceptance.
  Availability: local simulator only; no server update or publication required.
  Long-conversation sync recovery is separate and is not changed by this fix.

## 2026-10-14 — Explain failed desktop file links

- File links and binary attachment links now surface native open/download
  failures through the existing dismissible error notice. Missing linked
  attachments explain, in English and Chinese, that the agent must attach the
  file. A server filesystem path is not automatically a downloadable attachment;
  registration and authorization requirements are unchanged.
- Late errors are discarded after changing chat or server. Successful opens
  preserve their existing behavior and do not clear unrelated error notices.
- Real native offscreen acceptance reproduced the silent failure before the
  fix, then exercised missing-file HTTP 404, dismissal/retry and an authorized
  attachment HTTP 200 through the production IPC and test server. Checked dark
  English and narrow light Chinese layouts. The packaged local candidate also
  passed actual click-to-error and normal attachment opening against the server.
- Focused regression checks (51), TypeScript and production compilation passed.
  The first full suite hit the existing same-second server-update receipt test;
  its standalone rerun passed all 44 checks. The serial full-suite rerun passed
  5,176 tests (five skipped). Eight package/license checks passed.
- Availability: local desktop candidate `1.0.11-beta.1.sync.4`, retaining the
  latest-first sync changes; not published. No server update is required.
  User acceptance of the local file-link test passed before PR submission.
  Cross-machine acceptance remains pending; mobile is outside this change.

## 2026-10-14 — Open stale desktop chats latest-first

- Cached content still paints immediately, but opening/reconnecting a timeline
  now requests the latest bounded semantic page before subscribing at its
  snapshot boundary. It no longer starts a full offline-gap replay while also
  fetching that page. Older history remains available through upward paging;
  server/provider history, thinking content and chronological order are unchanged.
- A main-process authoritative tail can replace a disjoint renderer window
  without a redundant refetch or fabricated adjacency. Overlapping loaded
  prefixes retain their existing handling. Failed tail reads retain the cache;
  retired leases and buffered events cannot overwrite a replacement log.
- Native offscreen acceptance used the real authenticated test service with
  2,000 synthetic turns / 8,000 events, including long reasoning. The App opened
  at the recent tail, paged older content through real scroll/click input, and
  accepted a 57-character unsent draft without timeline requests. Six native
  service clients each reopened a stale cache five times and underwent three
  forced disconnects; all received one real Codex final reply without duplicates
  or replaying the old gap. Claude was verified separately with two real replies
  and an application-frame blackhole; recovery preserved both replies.
- Focused desktop checks, TypeScript, production compilation and 28 server
  transport/reasoning/stress checks passed. Full desktop validation passed
  5,164 tests (five skipped), plus eight package/license checks with two workers.
  Earlier high-concurrency runs encountered timing failures in unchanged secure
  peer/update settings tests; those tests were not changed by this work.
- Availability: local test candidate only; no publication, push or merge.
  Physical cross-machine/network-switching and OS sleep/wake acceptance remain
  pending. This change is desktop-side; the existing test server protocol is
  sufficient, and the working server is not changed.

## 2026-10-14 — Recover stalled desktop timeline streams

- Desktop advances its reconnect cursor only after the event consumer accepts
  a row. Consumer failures close the stream and retry from the previous cursor,
  with backoff; they cannot silently skip the failed row.
- An additive, negotiated server capability confirms completed WebSocket
  catch-up and sends lightweight idle heartbeats. Desktop reconnects after
  45 seconds without progress and renews open timelines after system wake.
  A progressing catch-up is not replaced by the periodic metadata refresh.
  Legacy clients/servers keep their existing protocol. Recovery never resends
  prompts, refreshes provider credentials or changes thinking content.
- Real loopback transport stress covered six clients, 6,000 historical rows,
  18 forced reconnects, filtered sequence gaps and 40 live appends. Every client
  received the complete expected sequence without duplicates; connection
  reservations were released. These synthetic-history tests do not call models.
- Desktop suite: 5,162 passed, five skipped; eight packaging/license checks,
  TypeScript and production compilation passed. Server catch-up/reasoning
  regressions passed. Native offscreen acceptance uses a real authenticated
  test service, separately with Codex and Claude, with a fault proxy keeping
  protocol ping/pong alive while dropping application frames. The legacy
  connection remained stale after 60 seconds despite a completed reply; the
  new connection automatically recovered the missing reply by the 40-second
  observation. Both runs retained exactly two submitted turns and two final
  replies. This is transport acceptance, not a new claim of thinking parity.
- The local arm64 test package passed bundle audit, ad-hoc signature validation
  and isolated startup. It disables updates and uses separate app data; it is
  not a notarized public release. Real cross-machine/network switching and OS
  sleep/wake remain user acceptance items; wake handling has focused regression
  coverage. The designated test server was updated; no working server restart,
  public upload, release or merge is included.

## 2026-10-14 — Shorten the README introduction and quickstart

- Reduce the feature overview and explain the app/server relationship in one
  short paragraph. Keep installation to four steps, with the npm command and
  URL/token retrieval visible.
- Add prominent website, setup and feature-guide links; keep detailed
  prerequisites and troubleshooting in the existing server guide.
- Documentation only; no runtime, installer or release behavior changed.

## 2026-10-14 — Use the published npm CLI in installation guides

- Make `npm install -g agentsdock` the primary manual installation command in
  the product and server READMEs. Explain automatic first setup, existing-state
  preservation, URL/token retrieval and the distinction from managed updates.
- Retain source installation as an advanced path and show the short commands
  for named instances. Remove obsolete unpublished-package wording from the
  server and CLI introductions.
- Organize first-time setup around the server host, prerequisites, npm install,
  address/token selection and a first provider chat. Clarify that tmux enables
  managed updates, localhost addresses cannot connect another device, and
  native Windows is a client platform rather than an npm server host.
- Link desktop downloads to the latest stable release instead of a stale
  version. Add setup troubleshooting and distinguish unreleased CLI output
  improvements from commands available in the published packages.
- Verified public npm tags and the stable package's integrity, setup guards
  and command parser without creating, restarting or changing a service.
  Checked shell syntax for all 18 command blocks, resolved 24 relative file
  links and verified the prerequisite documentation links. Documentation only;
  no fresh service installation, runtime or release change.

## 2026-10-13 — Show CLI connection details together

- Successful first-time global npm setup shows the default server URL and
  token directly in the controlling terminal, even with npm's normal hidden
  lifecycle output. Raw installer output and tokens stay out of npm's captured
  streams/debug logs. Headless installs retain a non-secret summary; existing
  installations are still left unchanged.
- Interactive `agentsdock token [NAME]` shows binding-aware connection URLs
  before the selected token and optional clipboard prompt. Interactive
  `agentsdock status [NAME]` offers an opt-in arrow-key server picker afterward.
  Cancellation shows no token; redirected status never prompts, and redirected
  explicit token commands retain raw token-only output.
- Checked the actual packaged CLI against a running macOS test instance:
  URL/token agreement, status → consent → arrow selection → token, decline,
  and redirected behavior. Authenticated health, service process/start time,
  server identity/version and configuration stayed unchanged. No clipboard
  write, service restart or global CLI replacement was performed.
- Package tests exercise real npm both with and without foreground scripts,
  checking terminal visibility and absence of credentials from npm logs.
  That first-install test uses a synthetic installer, not new native service
  creation. All 171 focused Node/Python checks passed, along with JavaScript
  syntax and diff checks. Native Linux terminal acceptance remains untested. Source only;
  no npm publication is included.

## 2026-10-13 — Explain missing uv during npm setup

- When automatic server setup cannot find or run uv, explain its Python
  environment role and show installation, verification and retry instructions.
  macOS guidance includes `brew install uv`; other platforms link the official
  installation guide. Retry commands preserve the selected stable/beta version.
- Keep installer logs and credentials out of npm diagnostics. Guidance does
  not execute package managers, download prerequisites, retry setup, or add
  telemetry. Unrelated failures retain their existing diagnostic path.
- All 44 Node CLI checks and five package checks passed, including real npm
  lifecycle execution with a synthetic missing-uv installer failure and private
  output assertions. No uv installation/removal, live service changes or new
  server creation was performed. This improvement is source-only until released.

## 2026-10-13 — Validate recovery fixes against current main

- Integrate the new batch emergency dismissal with the bounded-memory journal
  reader. A 40 MiB regression reproduced more than 80 MiB of allocations with
  the unprojected reader and passed below 8 MiB after the correction.
- Recheck 201 focused server cases, then all 31 emergency cases including the
  added regression; 907 desktop checks, TypeScript and production compilation
  passed. The 1,000-chat/1.21 GB process test passed again, retaining all 192
  queued messages and original history bytes; chat readiness took 14 seconds.
- An isolated native development app used the real authenticated server to
  dismiss two alerts with a 40 MiB intervening tool record. Both receipts were
  durable, the active banner cleared, and refresh retained the historical rows
  without restoring the banner. This fixture used no model provider.
- No published release or running user service was replaced by this merge
  validation. Signed end-to-end release acceptance remains separate.

## 2026-10-14 — Exercise receiving-client timeline synchronization

- Added component coverage for sync backfill plus overlapping authoritative
  corrections, a newer sync window arriving during scheduled empty-range
  recovery, and a genuinely empty authoritative history. Sync must preserve
  loaded messages and a stale recovery must not rebuild the newer window.
- Validation: 240 targeted synchronization, history, projection, service and
  viewport checks passed; 483 unrelated checks were excluded by the test-name
  filter. TypeScript passed.
- A native offscreen Electron fixture exercised 31 viewport observations:
  empty-cache arrival, incremental catch-up, prepend while reading, expanding
  and shrinking corrected history, disjoint replacement, hidden-tab sync and
  return, and a narrow window. It used real timeline/store reducers and wheel
  events with synthetic snapshots, not a remote server or a second physical
  machine. The unmodified baseline also passed all 31 observations; these
  checks do not reproduce the reported persistent blank viewport or establish
  that the candidate recovery fixes its cause. Remote-machine acceptance is
  still pending. This follow-up changes only tests and documentation.

## 2026-10-13 — Recover a persistently empty virtual timeline range

- When a populated timeline emits an empty virtual range after previously
  displaying messages, allow layout to settle and rebuild its measurements
  only if the viewport remains visible and empty. Retain the semantic reading
  anchor rather than reusing a potentially stale pixel offset. Initial,
  transient and hidden empty ranges do not trigger this recovery.
- Validation: 34 focused component/position checks, TypeScript and production
  compilation passed. An isolated native offscreen Electron fixture exercised
  wheel scrolling during response growth, completion/collapse and cached-event
  replay. It used the production timeline and virtualizer, with stubbed IPC;
  this was not a new live-provider request.
- This is defensive recovery for a suspected stale virtual range. The reported
  intermittent blank viewport was not reproduced, so exact-cause confirmation
  and acceptance in the affected live conversation remain pending. Visible-app
  automation was unavailable. Available as a local test package only; no server
  change or release is included.

## 2026-10-13 — Stress-test recovery and component updates with large histories

- Added an opt-in process test with 1,000 saved chats, approximately 1.21 GB of
  mixed history, 192 queued messages and 32 interrupted turns. Production
  worker/gateway startup, concurrent HTTP reads, exact queue order, single
  interrupted-run closure and original history-byte preservation passed.
- Separate isolated native acceptance exercised 32 deterministic concurrent
  runs and eight child processes: busy worker replacement was rejected, gateway
  replacement preserved work, and a failed candidate rolled back before a
  successful retry. The native App reconnected, showed pending blockers and
  cancelled the fixture reservation without stopping active work.
- Both component health and chat readiness are required: rollback restored
  HTTP before background queue reconstruction finished. Continuous work can
  still defer an ordinary idle update indefinitely under the existing policy.
- See [the stress matrix and boundaries](RECOVERY_READINESS_TESTING.md#large-state-and-busy-update-stress-pass--2026-10-13).
  These are source/runtime and native-client checks, not a signed release
  installation or platform-wide acceptance. No production code, public release
  or working service was changed by this stress pass.

## 2026-10-13 — Distinguish failed chat recovery and stream emergency receipts

- Expanded acceptance found and fixed a structured-payload regression: emergency
  journal projection no longer inherits native-import value-count limits or
  charges discarded object keys as retained metadata. Import defaults remain
  unchanged. The new regression failed before the correction.
- Additional validation passed 195 recovery/alert checks, 203 update/rollback
  checks, 99 overlapping import/admission checks and 487 desktop service/update
  checks. Native Electron also exercised Send and Refresh against an isolated
  failed-recovery HTTP server: the draft survived, the error was explicit, and
  server selection remained available. The 256 MiB HTTP fixture repeated at
  1.58 seconds. Repeating the real provider/UI acknowledgement after deployment,
  reopening the test app, and continuing the same conversation also passed.
  Test-instance identity, token and existing chats were preserved; disposable
  test data was cleaned up. See [the test matrix](RECOVERY_READINESS_TESTING.md)
  for boundaries.

- Completed queue-recovery timeouts now report failure instead of indefinitely
  claiming recovery is in progress. Admission stays closed on failure, and
  disconnecting a request cannot cancel shared queue restoration.
- Health separately reports chat readiness. Desktop connection status remains
  usable for recovery while warning about unavailable chat admission; a paired
  update stays pending or failed until reported chat recovery succeeds. Older
  servers without the field retain their existing behavior.
- Emergency receipt scans now perform linear reads and retain only lifecycle
  fields. Large unrelated records no longer cause repeated whole-line copying.
  Projection reads release the global session lock and recheck sequence state
  before applying, preserving acknowledgement idempotency and ordering.
- A real loopback HTTP fixture with a 256 MiB unrelated record acknowledged in
  about 1.6 seconds; the unchanged stable source timed out at 30 seconds. This is
  a synthetic regression, not proof of a particular user's remote cause.
- Validation: 187 focused Python checks, 5,142 desktop checks (five skipped),
  TypeScript, production compilation, bundle audit and strict ad-hoc signature
  verification passed. Permission-sensitive test fixtures used native temporary
  storage; build outputs remain local.
- A separate native Electron profile completed a real Codex request through the
  production client transport. A synthetic provider alert appeared in the UI;
  clicking Acknowledge cleared its active controls and committed exactly one
  durable acknowledgement. An explicit repeated request returned acknowledged
  false, preserving idempotency. Recovery failures were injected in isolated
  HTTP/regression fixtures, not into a user's active service.
- Available as a local test server and local desktop build. No release is
  published by this change.

## 2026-10-13 — View local server logs from the CLI

- Add `agentsdock logs [NAME]`, defaulting to the default instance, with
  `--lines` / `-n` and `--follow` / `-f`. Viewing logs does not install,
  restart, stop, or reconfigure a service.
- Select the installed macOS log layout, including gateway and worker files
  for split default installations. Bound file reads, handle rotation and
  missing files, reject unsafe paths, and escape terminal control characters.
  Linux reads the selected user-service journal without a pager.
- Verify the actual packaged command against a running macOS named instance:
  recent-log output, follow, and interruption preserved service PID/start time,
  authenticated health, identity, version and configuration. Package tests use
  disposable installations. Targeted checks: 191 passed, with one native
  systemd parser check skipped on macOS. Native Linux journal acceptance
  remains untested.
- Logs can contain private data and must be reviewed before sharing. This is
  an unpublished source change, not included in existing CLI releases.

## 2026-10-13 — Repair legacy cross-chat reply imports

- Older cross-chat reply/request imports no longer reappear as messages
  attributed to the user when the matching delivery is outside the loaded
  timeline page. The previous repair covered asynchronous handoffs but missed
  this older exchange format.
- Recovery matches the native provider input to durable delivery records.
  Genuine user quotations remain visible; the original journal, provider
  history, event identities and ordering are preserved. This does not enable
  legacy communication routes.
- All 48 focused history-repair/import-boundary tests passed. Unchanged source
  reproduced the gap, while a read-only check of an affected large history
  confirmed the candidate repair without changing its files or service state.
- An isolated native offscreen app reproduced the leaked user bubble before
  the fix. The candidate used real authenticated timeline reads, removed that
  duplicate, preserved a separate genuine quotation, and remained correct on
  chat navigation and reload. Fixture journal/provider bytes stayed identical.
  No model-provider request or new cross-chat delivery was made.
- Availability: source only; requires a server update. No production restart
  or release publication is included.

## 2026-10-13 — Dismiss emergency alerts for a chat

- The current chat's emergency banner now has one **Dismiss all** action.
  It persists acknowledgements through the alert displayed at click time;
  later alerts and other chats remain active, and historical alert rows stay
  available. Individual acknowledgements remain available in the timeline.
- The existing authenticated acknowledgement API accepts an exact durable
  alert boundary and commits the batch together. Repeated requests and another
  device acknowledging the boundary are harmless. Active work is untouched.
- An isolated native offscreen Electron run reproduced the old one-at-a-time
  behavior, then exercised the new UI through production IPC and authenticated
  HTTP into a real disposable server. It checked persistence, reconnect,
  another chat, a new alert during the request, failed request/retry, and
  supported narrow layout. Component coverage checks localized labels. Alert creation was
  synthetic; no model-provider request was needed or made.
- Focused emergency API/CLI, desktop transport/store/component checks,
  TypeScript checking and production compilation passed. A pre-existing
  clipboard test assumes umask 022; its isolated rerun passed with that umask.
- Availability: source only. This feature requires the paired app/server
  change; no release or production restart is included.

## 2026-10-13 — Recover server updates and preserve detached jobs

- Linux execution workers now restart independently of detached background
  jobs. Update admission checks the effective native service policy before
  accepting a worker replacement that preserves those jobs.
- Failed-update recovery accepts valid retained rollback releases. Activation
  also supports an existing hotfix whose Python environment belongs to a
  retained sibling release, without changing that environment or its links.
- Focused update, handoff, durability and native-service suites passed with
  platform-specific skips. Regression fixtures reproduced both recovery
  failures before the fixes. A real isolated Linux service exercised automatic
  restart and explicit stop/start, preserving a detached child's PID and start
  time across both operations. Its worker was a fixture, not a model provider.
- These changes do not publish a desktop or server release.

## 2026-10-12 — Validate large-history imports for merge

- Recheck import, incremental synchronization, Claude/Codex provenance, recent
  history repair, fork boundaries and runtime manifests: 402 of 406 checks
  passed on the development filesystem. The remaining four also fail on
  unchanged main because their fixtures require preserved inode identities or
  pre-1980 timestamps. All four passed using native temporary storage; the full
  15-case recent-history suite passed there as well. Production identity checks
  and test assertions remain unchanged.
- All 11 npm/legacy package checks passed, including actual disposable archive
  creation and offline npm installation. Python compilation, shell syntax and
  diff checks passed.
- Repeat authenticated imports for Claude and Codex confirmed explicit
  single-record limits, observed byte counts and correct record offsets.
  Rejected imports created no chats and preserved native source bytes, existing
  chats, server identity and credentials; temporary fixtures were removed.
- Native desktop UI and actual provider resume acceptance remain unverified.
  No desktop or server release publication is included in this change.

## 2026-10-12 — Explain native import resource limits

- Identify single-record text/metadata, field/scalar size, nesting, value-count,
  scan-record-count and timeout failures separately. Include observed amounts
  and limits, plus scan-relative record position and source byte offset.
- Explain that retained-byte accounting includes overhead and is distinct from
  total conversation disk size. Observed sizes are lower bounds because reading
  stops at exhaustion; do not expose transcript content in diagnostics.
- Preserve the import API's error contract, failure semantics and source bytes.
  All 97 focused reader/import/sync checks passed, including real parser errors
  reaching both providers' bulk-import responses without creating a chat.
  Changed Python compilation and diff checks passed.
  Live authenticated Claude and Codex imports of disposable 33 MiB text records
  returned the specific 32 MiB accounting limit and correct record offsets.
  Failed imports created no chats, left native fixture bytes unchanged, and
  preserved pre-existing chats, server identity and credentials. Fixtures were
  removed after verification.
  Native desktop acceptance remains pending while computer control is unavailable.

## 2026-10-12 — Stream large native history payloads

- Replace whole-record JSON loading for native imports, sync and native proof
  reads with bounded-memory projection. Opaque image/tool payloads remain in
  the unchanged provider transcript; message text and provenance are preserved.
- Remove the native import file-size cutoff and raw media-record cap. Retain
  explicit text/metadata, JSON structure, record-count and work budgets. Hash
  original bytes in chunks and keep file-identity/offset checks; a processing
  failure cannot become a successful partial import.
- Include the shared reader in both server package formats, installation,
  deployment and staged import/compilation checks.
- Isolated-reader measurements: approximately 281 MiB peak RSS with the former
  parser versus 23 MiB with streaming for the same 64 MiB image record; a
  300 MiB record used approximately 24 MiB. These are fixture measurements,
  not the running server's total memory or a guaranteed upper bound.
- Validation: 267 of 269 import/sync/provenance/package checks passed; the two
  remaining failures reproduce on unmodified main (candidate ordering and
  malformed-line native proof). Another 93 legacy-proof/deferral/fork checks
  passed. The memory-growth regression passed in separate reader processes.
  Changed Python and installer/deployment shell syntax checks passed.
- Native desktop acceptance is pending because computer control is unavailable;
  no native-provider resume or desktop UI acceptance is claimed.
- Final focused checks passed all 30 cases after reviewing blank/malformed and
  non-object JSON distinctions, including bounded-memory growth and native fork
  checkpoint behavior. Live authenticated import accepted a 300 MiB Claude image
  record and a 64 MiB Codex tool record that the preceding runtime rejected.
  Appending 40 MiB records, reopen-triggered synchronization and repeated reads
  preserved order without duplicates. Excessive retained text still failed
  explicitly. Original transcript bytes, pre-existing chat IDs/titles, server
  identity and credentials were preserved; disposable test data was removed.

## 2026-10-12 — Accept larger native transcript records

- Raise the Claude/Codex JSONL record bound from 4 MiB to 32 MiB across import,
  cursor synchronization, fork scans and native history proof readers. Include
  the actual bound in import errors. Embedded media and tool output no longer
  fail solely because one record exceeds the former 4 MiB bound.
- Preserve total-file, scan, displayed-text and aggregate proof budgets. Separate
  the existing proof-text cap from the larger raw-record cap; original provider
  history remains read-only.
- Validation: 250 of 252 targeted regression checks passed, including nine new
  boundary, synchronization and provenance cases. The two existing failures
  (candidate ordering and malformed-line native proof) also reproduce against
  unmodified main. Native desktop acceptance remains pending because computer
  control is unavailable.
- Live authenticated server checks reproduced the former rejection for separate
  5 MiB Claude image and Codex tool fixtures, then passed import, reopen-triggered
  incremental synchronization and repeated reads without duplicates after the
  update. Over-limit input still failed explicitly. Fixture source bytes and
  pre-existing chat identities/titles, server identity and credentials were
  preserved; only disposable test chats and transcripts were removed. These
  HTTP checks do not establish native-provider resume or desktop UI acceptance.

## 2026-10-12 — Verify the consolidated Files inspector for merge

- Integrate current main and preserve its release-tooling changes. Update the
  old Explorer-column style regression to require the editor's full-width layout.
- Validation: 230 of 231 focused checks passed initially; the sole failure was
  the obsolete layout expectation, and all 13 style checks passed after updating
  it. Both previously timing-sensitive directory checks passed this time.
  TypeScript, production compilation and eight package/license checks passed.
- The first hosted desktop run passed 5,138 checks but hit the second-page
  reveal fixture's one-second DOM polling limit. Await its mocked page responses
  and React commits before checking the rendered target; retain the selected-row
  and exact paging-offset assertions without changing production deadlines.
  All three focused pagination/reveal checks passed after that fixture change.
- The user reported the local app looks good and authorized the PR and merge.
  Agent-operated native acceptance remains pending because computer control is
  disabled. The local app remains the previously verified package; no runtime
  behavior changed during this merge preparation. No server update is required.

## 2026-10-11 — Show Files when opening a file

- Opening or selecting a workspace, attachment or image/PDF file tab now opens
  the right panel and selects Files, including when the panel was closed or
  showing Details/Review. The choice is remembered for subsequent reopening.
- Apply the same behavior in split chats. Reject stale notifications from a
  previous chat, working directory or server connection. Cancelling the picker
  or rejecting a file before opening a tab leaves the panel unchanged.
- Validation: all 56 focused app/file-opening checks passed. The broader
  194-case run passed 191; a separate rerun passed its large-file timeout case.
  Two remaining large-directory timing failures also reproduced against the
  preceding source, so broader editor acceptance retains that limitation.
  TypeScript and production compilation passed.
- Native desktop acceptance is pending because computer control is disabled;
  component fixtures use mocked IPC. No server changes are required.
  Local package: version 0.2.0/build 85, source `b771f38f`. Bundle audit, strict
  ad-hoc signature verification and all 25 compiled-code asset comparisons
  passed; the local app was gracefully restarted. Isolated user data and
  disabled automatic updates are retained.

## 2026-10-11 — Consolidate workspace browsing in Files

- Move the editor Explorer into the right-hand Files tab. Reuse its new
  file/folder, refresh, open beside, copy path, download, rename and delete
  operations, retaining dirty-buffer and revision checks. The editor no longer
  reserves a second tree column or Explorer resize handle.
- Remember the last Details/Files choice across panel and app reopening. Review
  remains transient. Split-chat browsing follows the focused chat without
  covering either conversation; opening a file activates the same editor.
- Preserve paged results on folder errors, allow retry, reject changed roots,
  and prevent background folder loads from resetting a quick-open selection.
- Validation: 223 focused component/style/localization checks passed (the final
  editor rerun passed all 138 cases), plus eight compilation/license checks.
  TypeScript and production compilation passed.
- Native desktop acceptance remains pending because computer control is
  disabled. Component tests use mocked IPC and cannot establish live server
  authorization or actual desktop appearance. No server API change is required.
  Local package: version 0.2.0/build 85, source `ec572e80`. Bundle audit, strict
  ad-hoc signature verification and all 25 compiled-code asset comparisons
  passed; the local app was gracefully restarted. Isolated user data and
  disabled automatic updates are retained.

## 2026-10-11 — Browse workspace files from chat details

- Add Details / Files tabs to the chat inspector, retaining Review when present.
  Files shows the server-side working directory, expandable folders, explicit
  pagination and refresh, and opens selected files in the existing editor.
- Load only the root and folders requested by the user. Clear directory state
  when the chat, server generation or working directory changes; ignore stale
  responses. Preserve existing authenticated workspace access and symlink rules.
- Validation: 172 focused checks passed, including component fixtures for
  browsing, errors/retry, paging, stale responses, English/Chinese labels and
  the Files-to-editor handoff. TypeScript and production compilation passed.
  The full desktop run had 5,125 passes and five skips; its only failure was an
  existing clipboard-permission fixture under umask 077, which passed with its
  expected umask 022; all 421 service checks passed on that rerun. All eight
  compilation-output/license checks passed.
  Native desktop acceptance is pending because computer control is unavailable;
  mocked IPC checks do not establish the real app/server journey. Availability:
  local desktop package, version 0.2.0/build 85, packaged source `61265aca`.
  Bundle audit, strict ad-hoc signature verification and packaged-renderer byte
  comparison passed. The package uses isolated app data with automatic updates
  disabled. No server API change or restart is required.

## 2026-10-11 — Reconcile hosted desktop release readiness

- Bring the release line's audited native build-number epochs into the maintained
  workflow, retaining every historical run/rerun reservation and avoiding stale
  build-number reuse after local builds.
- Add pinned canonical-draft verification without publication. The read-only
  helper reuses all four native verification jobs, rejects changed source or
  checksum seals, and emits a receipt only for matching successful results.
  Normal publication keeps its existing protected credential and mirror guards.
- Include the desktop release regressions in source CI and document permanent
  operator setup, one-time short-CLI bootstrap and npm's initial trust-validation
  deadline. Credential checks remain separate from candidate acceptance.
- Validation: 72 focused checks passed on Node 24; all 17 release-script JavaScript
  test files also passed on the local Node runtime. Workflow YAML and changed
  script syntax passed. A real read-only check verified the frozen beta.6 draft's
  metadata, checksum seal and signed server descriptor; no native assets were
  rebuilt and this does not establish full native or update acceptance.
- Availability: source tooling only. Hosted candidate builds, real native
  acceptance, first CLI publication and OIDC publication remain separate gates.
  No release, registry package, running server or signing identity changed.

## 2026-10-11 — Integrate connection pairing with matched npm releases

- Include the pairing command, bundled QR renderer and third-party notices in
  the publication verifier's exact file allowlist. Preserve source-byte binding,
  file-mode checks and rejection of extra files; include all three new files in
  tamper-rejection fixtures.
- Preserve the latest main release-pipeline checks when integrating this branch.
  Desktop QR sharing stays commented out. No package publication or deployment
  is part of this source integration.
- Update restart regression journeys to expand the active server card before
  exercising its controls; preserve safe/force confirmation and recovery checks.
  Keep the server-settings light background explicitly transparent. All 116
  related restart and light-theme checks pass.
- Allow two asynchronous test fixtures to reach their intended cancellation and
  private-revision audit checkpoints despite full-suite scheduling pauses.
  Retain the real SQLite/threaded-probe paths, all assertions and production
  deadlines; no tests are skipped.

## 2026-10-11 — Temporarily hide desktop QR sharing

- Comment out the Show QR code button and its section heading in Server settings.
  Keep the QR component and underlying sharing implementation for re-enabling
  later. Token preview/copy and other server controls remain available.
- Validation: 31 focused settings/component checks, TypeScript, production
  compilation, local bundle audits and strict ad-hoc signature checks passed.
  Retained QR tests exercise its component directly while the entry is hidden.
  Actual-app visual acceptance remains pending because computer control is blocked.
  Availability: local desktop package (0.2.0, build 85), automatic updates disabled.
  No server update is needed.

## 2026-10-11 — Inline token-copy confirmation

- Confirm a successful token copy by replacing the button's copy icon with a
  checkmark, keeping its Copy label and the card height unchanged. Remove the
  separate success line; failed copies still show a retryable error. Editing or
  folding the card clears the prior confirmation.
- Validation: 31 focused server-settings tests, TypeScript, production compilation,
  bundle audits and strict ad-hoc signature checks passed. Actual-app visual
  acceptance remains pending because computer control is blocked. Availability:
  local desktop package (0.2.0, build 85), automatic updates disabled. No server
  update is needed.

## 2026-10-11 — Masked token row in server settings

- Show the first four token characters followed by masking dots in each expanded
  server card, with a Copy button at the end that copies the complete credential.
  Short tokens remain fully masked; missing tokens disable copying.
- Mask the preview in the main process before IPC. Read only on expansion or
  after a token edit, discard stale results, and keep profile listing free of
  credentials. Preview errors never display credential-store error details.
- Validation: 215 targeted component, IPC, preload, credential-lifecycle and
  localization checks passed, together with TypeScript and production compilation.
  Fixtures cover stale credential reads, short-token masking, inactive profiles,
  edits, reopening and missing credentials. Actual-app visual/clipboard acceptance
  remains pending because computer control is blocked. Local bundle audits and
  strict ad-hoc signature verification passed (0.2.0, build 85; automatic updates
  disabled). This desktop-only local package requires no server update.

## 2026-10-11 — Give server settings a clearer layout

- Keep the server name and URL together in the collapsed header, with connection
  status alongside them. Expanded cards show version and identity on separate
  labeled rows, with wrapping for long addresses and identifiers.
- Group Copy token and Show QR code under Connect another device. Separate
  Use/Edit from the red Remove action, with more spacing and wrapping. Remove
  the duplicate status/identity block beside the active server's restart control.
- Validation: 118 targeted component/localization tests, TypeScript, production
  compilation, bundle audits and strict ad-hoc signature checks passed. Tests
  use mocked IPC; actual-app visual acceptance is pending because computer
  control is blocked. Availability: local desktop test package (0.2.0, build 85),
  automatic updates disabled; no server update is needed for this layout change.

## 2026-10-11 — Collapsible server settings cards

- Match the My Agents settings layout with server cards collapsed by default.
  Keep each name, connection status and active selection visible; place address,
  identity/version, edit/remove/use, token copy and QR actions inside the card.
  The active server's health/restart controls also live inside its card.
- Put Add server above the cards. Keep new-connection editing at the top and
  existing-connection editing inside its owning card. Folding preserves drafts,
  dismisses credential-bearing QR panels and resets removal confirmation.
  A newly saved server expands so a failed activation remains actionable.
- Validation: 118 related component/localization tests, final focused settings
  checks, TypeScript, production compilation, local bundle audit and strict
  ad-hoc signature checks passed. Component IPC is mocked;
  the actual-app visual/client-server workflow remains pending because computer
  control is blocked. This is a local desktop change with no service restart or
  public publication.

## 2026-10-11 — Remove subagent concurrency from Server settings

- Remove the Codex subagent-limit form from desktop Server settings. Opening
  the page no longer reads or offers to change this per-chat default through
  the server administration API.
- Validation: all 163 related settings/goal/server-management component tests,
  TypeScript, production compilation, local bundle audit and strict ad-hoc
  signature checks passed. Native visual acceptance remains pending because
  computer-control policy blocks the desktop app. Availability: local test
  package only; no server update is required for this UI removal.

## 2026-10-11 — Make persistent goals available without a global toggle

- Remove the persistent-goals switch from desktop Server settings. Goal creation,
  pause, resume and limits remain per-chat controls.
- Updated servers ignore the retired environment/config opt-out. Preserve the
  authenticated legacy status route as non-configurable; enabling is read-only
  and disabling returns 409 without restarting providers or changing goal state.
  Existing paused goals stay paused and unrelated shared settings are preserved.
- Validation: 151 desktop component tests, TypeScript, production compilation,
  local bundle audit and strict ad-hoc signature checks passed. Fifty isolated
  server tests passed, including actual ASGI routes with synthetic credentials,
  stale disabled settings, rejected legacy writes and unchanged goal/subagent
  state. Native App visual/goal acceptance remains pending because computer
  control is blocked. Availability: local desktop package and server source;
  existing services were not restarted or deployed.

## 2026-10-11 — Simplify saved-server actions

- Remove the up/down ordering buttons from desktop Settings → Server and
  their unused component handler. Keep the saved list order and the remaining
  connection-management actions.
- Validation: all 26 existing server-settings component tests, TypeScript,
  production compilation, local bundle audit and strict ad-hoc signature checks
  passed. Actual-app visual acceptance remains pending because computer-control
  policy blocks the desktop app. Availability: local test package only.

## 2026-10-11 — CLI and mobile QR connection pairing

- Add `agentsdock pair [NAME]` / `qrcode` with binding-aware Tailscale/LAN
  selection, authenticated health and identity checks, terminal QR output, private
  PNG export and an explicit link-output option. Local-only and ambiguous network
  selections require explicit choices. Existing services are never restarted.
- Bundle the QR renderer with its licenses so short-CLI installation remains
  offline-capable and keeps the exact same-version server dependency.
- Add mobile camera/image scanning and connection deep links. Users review the
  address, then connect and save through existing identity validation and secure
  token storage. Matching server identities are reused; failed authentication or
  an identity mismatch cannot replace a saved server. Preserve the legacy scheme.
- Validation: CLI, offline packaging, 97 instance tests, cross-client payload
  tests, mobile component/profile/setup checks and TypeScript; generated native
  permission/deep-link configuration; a packaged CLI QR independently decoded and
  authenticated against the selected live test server. Component native modules
  are mocked. Simulator UI control is blocked by computer policy; actual native
  scan/import, persistence/reopen, deep-link presentation, and physical-phone
  LAN/Tailscale acceptance remain pending. This is local development, not a public
  npm/mobile release. The iOS simulator Release build and isolated simulator
  installation passed; the QR fixture was imported for manual image-scan testing.

## 2026-10-11 — Desktop saved-server token copy and connection QR

- Add per-server Settings actions for native clipboard token copying and locally
  generated, saveable QR images, including inactive/offline saved profiles.
  Copying never returns the token through IPC. Generation/saving checks the
  selected credential revision; profile metadata stays credential-free.
- Define a versioned connection-link contract and document the separate mobile
  import work. Show local-only address and credential-sharing explanations;
  generating a QR does not change network binding or grant restricted chat access.
- Validation: focused service/IPC/preload/component/format checks, TypeScript
  and production compilation; native offscreen copy and QR display; real macOS
  clipboard and local-server authenticated health; independent Vision QR decode.
  Native save-picker interaction was blocked by computer-control policy. Picker,
  theme/layout and mobile end-to-end acceptance remain pending. No server source
  change, service restart or public publication is included.
## 2026-10-11 — Preserve certificate-chain lookup in the hosted signing probe

- Include the disposable keychain in the hosted search list only while signing
  and verifying the probe, matching macOS certificate-chain lookup requirements.
- Restore the exact original list on success and failure without replacing the
  default keychain. Add executable isolated regression checks for that boundary;
  no credential values or private signing output are exposed.

## 2026-10-11 — Identify hosted signing-preflight failure stages safely

- Add fixed public checkpoint labels to the non-publishing Developer ID probe
  so operators can distinguish certificate import, identity discovery, signing
  and verification failures without exposing credentials or raw command output.
- Preserve the protected hosted-runner guards, disposable-keychain cleanup and
  all release acceptance requirements. A failed probe remains a failed check.

## 2026-10-11 — Make release operation independent of the operator computer

- Reconcile paired npm release tooling with current main while preserving the
  frozen release branches. Include the native harness implementation as well as
  its registered workflow, stronger split-default removal/state checks and safe
  bounded failure identifiers. Keep failed product boundaries failed.
- Add a manual protected credential preflight for existing GitHub release
  access, Developer ID probe signing and read-only Apple API authentication.
  It does not publish, submit notarization, build a product, install a service,
  upload private diagnostics or replace signing identities. Hosted execution
  remains pending; structural tests are not credential validation.
- Document operator versus administrator/npm-owner responsibilities, exact
  source selection, package-specific trust and the limitations of artifact-only
  or verification-only runs. The scoped beta.6 runtime is public; the short CLI
  and matched desktop publication remain incomplete. Preserve stable defaults.
- Focused pipeline/harness/packaging source checks pass. No new candidate was
  built and no existing signed artifact, service, credential or public release
  was changed by this tooling update. See [the operator checklist](NPM_CLI_RELEASES.md#operating-releases-from-another-computer).

## 2026-10-11 — Inherit new-chat settings from the open conversation

- Both quick creation and the new-chat chooser prefer the focused conversation's
  agent, CLI/custom connection, model, reasoning and provider-specific permissions.
  Saved defaults apply only without an eligible open conversation, remain scoped
  to the server, and accept older records without permission fields. Instructions,
  native session identity, credentials and jobs are not copied.
- Unavailable inherited agents/connections require an explicit choice instead of
  silently switching providers. Late preference reads cannot cross server scopes.
- Verification: 729 focused desktop tests, typecheck and production compilation
  passed. Isolated native offscreen Electron reproduced stale model inheritance
  with the old renderer, then exercised the new renderer via actual mouse/keyboard
  input and production IPC/HTTP against an authenticated test service. Codex,
  Claude and Cursor creation preserved server-side settings; a new Codex chat
  completed a live provider turn. Unavailable OpenCode opened the chooser;
  cancel/reopen and explicit provider selection worked. The test used isolated
  in-memory credential storage, not the user's desktop profile.
- Pre-merge review also covered a Claude-only availability fixture: initialization
  cannot silently replace an unavailable inherited provider, including after
  cancel/reopen. The native offscreen app checked the chooser against a controlled
  catalog and created the explicitly selected Claude chat through real IPC/HTTP.
  User testing accepted the primary inheritance workflow.
- OpenCode availability and custom-endpoint propagation are covered by regression
  fixtures, not live authenticated OpenCode/custom-provider runs. This is a local
  desktop change; no public release, mobile change or primary-server update.

## 2026-10-11 — Separate catalog refresh from Codex sign-in reload

- Automatic reconnect/model discovery and Recheck CLIs no longer request an
  opaque-login handoff. Genuine native login revisions are still detected;
  custom endpoint managers and background-work ownership remain unchanged.
- Add a native-admin-only sign-in reload POST and wire the existing Codex CLI
  account action to it, with English/Chinese copy and truthful pending status.
  Account reads and page mounts remain passive; unsupported older servers keep
  a read-only Recheck. Profile-generation fencing applies to explicit reload.
- Log handoff source, reason and coalesced waiting/release outcomes without
  credentials, account identity, revision digests or command content.
- Validation: 67 focused server HTTP/auth/lifecycle tests and 527 desktop
  transport/service/component/preload tests passed; desktop typecheck and
  production build passed. Production desktop transport against an isolated
  installed service passed account read/reload, browser/bearer rejection,
  repeated catalog refreshes and two real Codex turns on the same native thread.
  User testing reported no issue with the refresh/reconnect workflow. Live
  keychain/background-training and implementer App-click acceptance of the new
  explicit reload action remain pending; computer control was unavailable.
  No public release or upgrade of existing primary services is included.

## 2026-10-11 — Clean unused chats on desktop startup and explicit refresh

- Recognize unused `New chat` rows without a device-local creation marker,
  including legacy placeholders and blanks whose model/settings changed.
  Check again after the initial online refresh when startup used an old cache;
  do not run cleanup on ordinary background refresh or when leaving a chat.
- Persist conditional, desktop-scoped dismissals on the server. Keep the empty
  record recoverable so a different/offline desktop's local draft remains usable.
  Subsequent changes make the row visible again. Explicit Delete is unchanged.
- Flush and protect local drafts/references/uploads before requesting cleanup;
  the server repeats its history, provider, queue, job and terminal checks under
  its lifecycle fence. New clients use a distinct endpoint, so an older server
  cannot interpret recovery-safe cleanup as permanent deletion.
- Verification: reproduced the old missing-marker behavior in an isolated
  offscreen native Electron app, then exercised the compiled app against an
  authenticated test server through the real IPC/HTTP boundary. Startup and
  sidebar refresh removed legacy/model-edited blanks; typed drafts and uploaded
  files survived. Two independent desktop profiles and server/app restarts
  preserved offline drafts and per-client cleanup. No model inference was used;
  chats/files were disposable API fixtures and typing/refresh used real UI input.
- Verification build: desktop source metadata `0.2.0` / 85 and server source
  `1.0.7-beta.11`, based on main `4de6e80b`. All 805 focused desktop and 28 server
  regressions, TypeScript and production compilation pass. Test fixtures/services
  are isolated; no primary installation changed.
  Availability: local source and compiled test app only; not published or merged.

## 2026-10-08 — Configure custom APIs before choosing a model

- Remove Model ID from Claude/OpenCode connection forms. Initial connection
  checks are read-only; saved draft model IDs cannot trigger hidden inference.
  Choose the default afterward from the endpoint catalog and reload it on demand.
- When a public or missing catalog cannot verify credentials, save a private
  `model_required` configuration, not a successful connection. It remains absent
  from available chat providers until an explicit model check succeeds. Selecting
  the first model runs that bounded check with a visible possible-cost notice.
  Already verified defaults remain metadata-only; no arbitrary model is selected.
- Preserve native administrator checks, credential redaction, revision fencing,
  Forget and existing chat bindings. Old servers that cannot retain pending
  configuration show an update message, not a Model ID field the user cannot find.
- Manual model entry and service-specific official catalog links are fallback
  controls in the later model section, not initial configuration. Include English
  and Simplified Chinese copy. Unknown gateways are not assigned another service's
  model list merely because they use that agent or API protocol.
- Verification: 62 focused component/native transport tests and 49 server tests pass;
  TypeScript and production compilation pass. These cover
  save/list/select/check, failure, refresh, profile switching and no early model
  call. A real loopback HTTP gateway exercises the production server routes and
  native authentication with synthetic credentials, not a live provider account.
  Actual App interaction remains blocked by unavailable computer control; local
  packaging and user acceptance do not imply release or merge approval.
- Full desktop regression: 5,064 pass and five skipped; eight build/license
  guards pass. Package commit `70af1129` as an audited, ad-hoc signed local App
  (package metadata `0.2.0`, build 85) with the existing isolated test profile.
  The designated local test server runs `1.0.10-beta.2.opencode.70af1129` with
  authenticated health and installed module/source parity verified. The primary
  server is unchanged. No artifacts are published and merge remains pending.

## 2026-10-07 — Prepare matched npm runtime and short CLI publication

- Extend the manual npm release workflow to prepare both `@agentsdock/server`
  and `agentsdock` from one committed source/version. Validate the accepted CLI
  receipt and all packaged files against Git, the exact scoped dependency and
  the existing signed runtime descriptor before publication. Stage CLI bytes in
  their own immutable two-asset private draft; do not modify runtime/app bundles.
- Publish and verify the runtime before the CLI; verify public resolution
  metadata and downloaded bytes for both. Preserve explicit stable baselines
  during beta publication. Matching retries skip existing uploads, while
  conflicting bytes/tags fail closed. Missing first-package ownership/trust is
  reported as incomplete publication, not a matched-release success.
- Add a manually dispatched disposable macOS/Linux native CLI acceptance
  workflow and bounded reports. It exercises genuine first-global postinstall,
  repeat-install preservation, commands, service lifecycle and cache retirement.
  Known split-default service binding refusals remain failed checks, not bypasses.
- Validation: 190 JavaScript and 142 Python checks pass, including actual offline
  npm packaging/install tests, CLI/postinstall behavior, publication guards,
  instance-manager fixtures and native harness safeguards. Changed workflows
  pass actionlint. Real fresh native-service, split-default lifecycle/removal,
  interactive setup and logout/reboot acceptance remain pending; mocked lifecycle
  checks and safe existing-state no-op installs do not establish those results.
- Preparation only: no new beta build, npm upload, release publication, signing
  identity change or existing-service modification. The short command remains
  unpublished. See [the matched npm release procedure](NPM_CLI_RELEASES.md).

## 2026-10-07 — Remember custom API drafts and clarify connection fields

- Keep non-secret endpoint drafts on this device per server connection and
  provider, even after failed checks, closing settings or restarting the app.
  Codex retains its URL too. Keys stay out of drafts; embedded URL credentials,
  query strings and fragments are not persisted. Typing does not send requests
  and disk writes are debounced, with a flush on close/page exit.
- Show protocol and authentication as separate, visible fields. Mark required
  inputs, keep provider-fixed protocols read-only, and require a model for known
  public Zen catalogs. Restored drafts never imply a verified connection.
  Include English and Simplified Chinese copy.
- Verification: 81 focused component, draft, style and native transport tests
  pass; TypeScript, eight build/license guards and production compilation pass.
  Full desktop regression: 5,039 pass, five skipped. Filesystem-sensitive tests
  use a POSIX temporary directory and the CI-compatible file-creation mask;
  security checks are unchanged.
- Package source `3a25c492` as a local ad-hoc test App, audit/sign the bundle and
  launch it with the existing isolated local-app profile. Packaged main,
  preload and renderer bytes match the validated build. No release publication
  or server restart is part of this desktop follow-up.
- A separate live Zen model check succeeds, but the reported App authentication
  rejection has not been reproduced. Computer interaction remains disabled,
  so actual App acceptance is still pending; this change must not be merged
  based on component or HTTP checks alone.

## 2026-10-07 — Align OpenCode custom API checks and runtime routes

- Resolve Anthropic API prefixes consistently for model discovery, connection
  checks and OpenCode runtime configuration. Root URLs and explicit `/v1` URLs
  work without dropping gateway prefixes or changing saved binding identities.
  Claude's SDK root convention and OpenAI-compatible routing stay unchanged.
- Stop unknown/invalid OpenCode completions instead of treating an empty step
  as success and waiting while the CLI makes repeated requests. Preserve partial
  timeline text and explicit provider HTTP status diagnostics; do not dump raw
  gateway bodies or headers. No additional retry or inference probe is added.
- Allow a bounded 256-token output budget for explicit Claude/OpenCode model
  checks. Reasoning models can consume the former 32/64-token budget before
  answering; empty or reasoning-only responses still cannot verify a connection.
  Checks remain single-shot and do not alter runtime token limits.
- Verification: 198 focused tests pass, including URL parity, credential
  isolation/revocation, catalog discovery, stream errors, lifecycle and MCP.
  Regression cases fail on the prior implementation. Lock validation and
  compilation/package-source checks pass. Existing runner fixtures emit
  recovered missing-mailbox-table warnings; these are not live-service errors.
- Four opt-in tests exercise real OpenCode 1.18.29 through the production
  process runner and a synthetic loopback gateway: root URL, explicit `/v1`,
  HTML-200 streaming response and HTTP 401. Disposable home/state and synthetic
  keys only; no real model inference in these four repeatable smoke tests.
  Run `tests.test_opencode_custom_api_smoke` with `OPENCODE_TEST_EXECUTABLE` set.
- Separate live OpenCode Zen checks pass for Chat Completions, Anthropic
  Messages and Responses. Real CLI replies also pass for Anthropic root and
  `/v1` URLs and Responses. These checks do not establish Go subscription or
  free-tier compatibility; neither was accepted in this validation.
- Desktop interaction is blocked by disabled computer access. Full app
  acceptance remains pending and the PR is held for that check, not merged.
  This is a local test candidate, not a published release. Per-model protocols
  and runtime output limits are not included.

## 2026-10-03 — Preserve automatic naming across follow-up messages

- Compare effective title runtime settings before and after session updates,
  rather than cancelling because a provider/model field was included. Normal
  and queued follow-ups with unchanged settings keep their in-flight title.
  Missing legacy default-provider fields normalize to the explicit defaults.
- Manual renames (including identical text), opt-out, archive and actual
  runtime/credential-revision changes still cancel. Stale-result checks and
  the one-attempt usage limit remain; no retroactive chat rewrites or retries.
- Verification: 279 focused server tests pass, covering naming, runtime
  updates, provider bindings and queue behavior. Regression fails on the
  previous implementation. Desktop typecheck, production compilation and 573
  focused client transport/service tests pass (with the tests' expected 022
  umask; inherited 077 made an unrelated clipboard fixture private).
- Exercised the main-based desktop build (source version 0.2.0/build 85) in an
  isolated offscreen native Electron profile against the branch's authenticated
  server. Real Codex replies, a follow-up and queued promotion completed while
  a test-only timing gate held the independent title request. Releasing the
  gate produced a summarized title, displayed in the header/list and retained
  after reload, persisted as generated metadata. Provider
  requests, HTTP/IPC, authorization and persistence were real, not mocked.
  Cursor lifecycle coverage is synthetic; its provider adapter is unchanged.
- Source only: no existing service restart, deployment or release.

## 2026-10-03 — Prefill the public bug-report form

- `/feedback` opens the existing AgentsDock GitHub bug-report form with the
  running app version/build, client platform/OS version/architecture, current
  server version, agent and selected model. Environment details use the
  existing additional-information field so no template rollout is required.
  Description and screenshot uploads remain user-entered. Remove the separate
  reproduction-steps and expected-behavior questions to shorten the form; this
  template simplification takes effect when merged into the default branch.
- Read app metadata through trusted native IPC. Capture the originating chat
  and server context before awaiting it. Mark cached offline server versions
  and server-default models explicitly; do not infer an unknown model.
  Do not include session IDs, titles, chat content, paths, server addresses or
  credentials. Opening the form does not submit an issue or send a chat turn.
- Five focused component/URL tests, TypeScript and the desktop production
  build pass. Tests mock the native browser bridge; actual UI-to-browser
  acceptance remains pending because computer use is disabled in this run.
  Built and launched an ad-hoc local macOS package (source version 0.2.0,
  build 85, based on main 3c5e6e59); bundle audit and signature validation pass.
  Startup reaches the renderer and connected server; user acceptance is pending.
  Desktop only; no server update, mobile change or public release.

## 2026-10-02 — Align update test fixtures with current idle-update policy

- Final CLI merge validation exposed two pre-existing main-branch CI failures
  after the idle-update scheduling change: isolated update fixtures omitted
  queued/run-now state, and a legacy assertion still expected automatic jobs
  to pause for a pending idle update. Supply empty queue state and assert the
  current policy allowing both automatic and manual work while waiting for idle.
- No production update behavior or safety checks changed. All 298 focused
  update, preparation, scheduling and hardening tests pass with isolated state
  and a clean environment. The CLI's 147 focused tests and installed-terminal
  status colors, token selection and cancellation checks also passed.
- No release, registry publication or existing-service restart.

## 2026-10-02 — Navigate the token chooser with arrow keys

- Use Up/Down to highlight an existing server and Enter to confirm. Esc,
  Ctrl+C or Ctrl+D cancels without exposing a token. Keep explicit `token NAME`
  and the numbered/name fallback for basic terminals without cursor control.
- Bound the rendered menu to terminal width/height, scroll longer lists and
  restore terminal input mode and cursor visibility before token/clipboard
  output, on cancellation and on read failure. No new package dependency.
- Validation: 36 JavaScript, 95 instance-manager, five CLI packaging and 11
  runtime packaging tests passed. Actual packaged pseudo-terminal tests cover
  normal/application arrow sequences, returning to the first item, Esc/Ctrl+D
  cancellation, only-selected-token output and restored terminal modes.
  Unit checks also cover wraparound, scrolling and interruption/read failure.
  Reinstalled the matching local packages on macOS; actual terminal Down/Enter,
  Down/Up/Enter and Esc flows passed with incumbent listeners/configuration
  unchanged. No provider, server lifecycle or registry publication changes.

## 2026-10-02 — Choose a server before showing its token

- Make bare `agentsdock token` list the current OS user's known local instances
  with numbered names, native service states and ports. Accept a number or exact
  name, including stopped instances, and display only that instance's token via
  the existing private-token/optional-clipboard path. Explicit `token NAME` and
  `token --instance NAME` remain available for direct or scripted use.
- Do not default automatically, even with one server. Empty input, EOF and
  Ctrl+C cancel without displaying a token; invalid choices retry. Refuse an
  implicit selection when input/output is redirected. Recheck a selected name
  before reading its token and never fall back to another instance on failure.
- Validation: 36 JavaScript tests, 92 instance-manager tests, five CLI packaging
  tests and 11 runtime packaging tests passed. Actual packaged CLI terminal
  tests in disposable homes exercise invalid-then-valid selection, name
  selection, cancellation and only-selected-token output with synthetic tokens.
  Reinstalled the committed local npm packages on macOS and exercised the actual
  chooser by number/name, cancellation, redirected-input refusal and explicit
  selection; incumbent listeners/configuration stayed unchanged and clipboard
  copying was declined. No provider, service lifecycle or release changes.

## 2026-10-02 — Make CLI status and setup guidance easier to read

- Print one readable `agentsdock status` block per instance with native service
  status, labeled connection addresses, installed runtime version and port.
  Accept an optional instance name; keep `info` JSON and single-instance token
  selection unchanged. Status inspection never starts or changes a service.
- When setup/install safely refuses existing default state, explain
  `agentsdock new` and the explicit name/port form. Preserve the error code,
  nonzero exit and no-installer behavior; do not change other error paths.
- Validation: 36 JavaScript CLI tests, 86 instance-manager tests, five CLI
  packaging tests and 11 runtime packaging tests passed. Repacked committed
  source and installed the matching local npm tarballs; exercised actual
  all-instance and named status, terminal header color, setup/install refusal,
  unknown-instance errors and unchanged JSON info. Existing service listeners
  and configurations stayed unchanged. No service restart or npm publication.

## 2026-10-02 — Validate the short npm CLI against current main

- Merge current main into the prepared CLI branch. The only conflict was two
  sets of development-log additions; retain both histories without changing
  the CLI behavior or the existing runtime lifecycle implementation.
- Install the actual matching CLI/runtime tarballs globally on Apple silicon
  macOS. Initial and repeated npm installation detect existing state and leave
  incumbent services unchanged. Exercise help/version, listing and aliases,
  default/named token output, info/status, guarded setup/install, no-journal
  recovery, and missing-target/update-argument errors.
- Exercise two disposable native launchd instances: explicit name/port and
  automatic name/free port, start/stop/restart, authenticated health and wrong
  token rejection, interactive uninstall cancellation, successful removal and
  name release. Confirm that a synthetic saved-state marker survives in the
  private backup and that incumbent listeners/configuration remain unchanged.
  Terminal output retains blue names, green success, red removal warnings,
  separate token lines and the optional clipboard prompt (declined).
- Validation: 35 JavaScript, five CLI packaging, 11 runtime packaging and 82
  instance-manager tests pass. Package the clean merged source; the source
  version remains unchanged. Both disposable services are removed afterward.
- Remaining acceptance: fresh-default macOS auto setup, real signed update
  activation, migration repair, bulk destructive operations and clipboard
  copying were not exercised. The existing split-service binding check still
  refuses the default installation; no bypass or lifecycle fix was added.
  No desktop/provider workflow, registry publication or incumbent deployment.

## 2026-09-28 — Automatically set up the first server during global npm install

- Change the earlier CLI-only install behavior: a direct global
  `npm install -g agentsdock` now invokes the bundled fresh installer, waits for
  its health-checked success receipt, and starts the first default server.
  Existing default/named installation or state is left unchanged; repeated npm
  installation never selects an upgrade or restarts an existing server.
- Keep local/dependency/link/CI installations inert. Respect `--ignore-scripts`
  and `AGENTSDOCK_SKIP_SETUP=1`; retain `agentsdock setup` for explicit/custom
  installation. Native prerequisites remain required. A failed automatic setup
  returns failure, with a recovery command, instead of reporting a ready server.
- Filter installer output before it reaches npm logs so access tokens and raw
  diagnostics are not captured there. Accept the installer's validated local,
  LAN or Tailscale address; use `agentsdock token` for private token retrieval.
  Preserve Linux per-user service environment for native systemd operations.
- Validation: 35 JavaScript tests, five facade packaging tests and 11 existing
  runtime packaging tests passed. Real npm lifecycle tests cover fresh setup,
  reinstall, skips and failure with a labelled service fixture. A separate
  disposable Linux account exercised actual global npm installation, starting
  both managed service processes and passing authenticated health; forced npm
  reinstallation preserved both process IDs, identity, token and synthetic saved
  data. The real token was absent from npm logs. The native split-aware
  uninstaller preserved saved state, and the disposable account was cleaned up.
- Native testing also found an existing instance-manager gap: its legacy binding
  validation rejects split-service removal. Split lifecycle controls remain a
  separate acceptance gap; no validation bypass was added. macOS npm entry/hook
  tests pass, but macOS first-service creation, provider chats and app workflows
  were not exercised. No existing user service was changed. This is local source
  work, not registry publication or integration into the product release pipeline.

## 2026-09-28 — Flatten public CLI instance commands

- Make `agentsdock list`, `info`, `new`, `start`, `stop`, `restart` and `remove`
  the primary instance interface. Accept `new NAME`, `token NAME`, `status NAME`,
  `uninstall NAME` and `version`; preserve the earlier `servers`/`instances`
  commands and explicit name flags. Conflicting positional/flag selectors are
  rejected rather than silently choosing a different instance.
- Document the full old/new public command mapping, bulk selectors and actual
  differences: fresh-only setup, signed updates, guarded recovery, and explicit
  uninstall targets. Source-only reconfiguration, bulk manifests, Team Hub and
  developer/transaction controls are not presented as implemented short commands.
- Validation: 27 JavaScript CLI tests and four Python packaging tests passed.
  Actual npm global/local installations exercise the flat command, version,
  per-instance token reads and rejection of restart/remove without a target.
  Synthetic configuration is retained and no service is created or controlled.
  No existing server restart, provider execution, deployment or npm publication.

## 2026-09-28 — Prepare the short agentsdock npm command

- Add the `agentsdock` CLI package, pinning the exact same-version
  `@agentsdock/server` runtime. Global npm installation exposes `agentsdock`;
  local installation uses `npx agentsdock`. Neither runs installation hooks,
  changes shell configuration nor starts or updates a server automatically.
- Expose `setup`/`install`, `servers` management, `status`, and per-instance
  `token` commands. Signed updates and guarded recovery retain the existing
  implementation. Internal helper commands and the source-installer update
  bypass are not public CLI commands; existing server signing identities,
  manifests and scoped-package behavior remain unchanged.
- Verify 25 JavaScript CLI tests and 15 Python packaging tests. Real offline npm
  global/local installs of the actual matching packages exercise the executable
  from another directory, version/help, empty-instance discovery, recovery with
  no journal, distinct synthetic default/named tokens and safe reinstall refusal.
  Package inventory, permissions, exact dependency pins, reproducibility and
  checksum receipts are checked. Add these checks to source CI; hosted execution
  has not yet run. JavaScript/Python syntax and workflow YAML checks pass.
- Availability: source and local packaging checks only. No service creation,
  restart, provider chat, desktop UI change, npm publication or deployment is
  included. Fresh service creation/control through the new wrapper still needs
  disposable native acceptance. The new public package requires owned registry
  publication and release-pipeline integration after that acceptance; current
  public registry commands and frozen release candidates are unchanged.

## 2026-10-02 — Mobile fallback for missing selectable text native view

- Diagnose a test iOS build rendering Claude assistant Markdown as red
  `Unimplemented component: <RNUITextView...>` boxes. The data and server
  response were intact; the running native app did not expose the
  `@bsky.app/react-native-uitextview` Fabric views expected by the JS bundle.
- Route Markdown and text-file previews through a local `SelectableText`
  wrapper. When both `RNUITextView` native view managers are registered, the
  app keeps the iOS range-selection behavior; otherwise it falls back to React
  Native `Text` so chat content remains readable in stale or mismatched test
  shells.
- Verified against the local 7850 server on the iPhone simulator by opening the
  affected Claude test chat and confirming the assistant Markdown renders as
  normal text with no `RNUITextView`/unimplemented component in the hierarchy.
  Focused text-selection/Markdown tests and TypeScript passed.

## 2026-10-02 — Mobile photo picker accepts videos

- Extend the iOS composer library picker from image-only selection to mixed
  photos and videos. Preserve Files attachments, add video upload naming and
  MIME inference, request read access before opening the iOS library, and keep
  iCloud-backed media download enabled for picker results.
- Use the existing upload API with video-aware attachment UI and copy. Videos
  now render with a video icon in pending, failed and uploaded states.
- Verified focused upload/composer regressions, TypeScript, iOS export, native
  prebuild, Info.plist permission text and iOS native dependency parity. Also
  ran a disposable local AgentsServer and confirmed a video selected through
  the mobile upload mapping reaches `/api/sessions/:id/files` as `video/mp4`.
  Built and launched the Debug app on the iPhone simulator, opened a real chat,
  verified the attachment menu shows `Photos and Videos`, and opened the
  multi-select iOS media picker from that option. CoreSimulator media import
  via `simctl addmedia` was not reliable in this run, so selecting a newly
  imported video inside the real picker remains unverified. Source only; no
  release or deployment.

## 2026-10-01 — Simplify the repository overview

- Group Claude Code, Codex, Cursor and OpenCode in the product introduction.
  Keep CLI prerequisites in general setup guidance and provider availability
  scoped to the client and server version.
- Remove the separate OpenCode installation callout, backend-name links,
  standalone server repository links and website development walkthrough.
  Keep stable 1.0.9 downloads and the maintained server setup documentation.
- Documentation only; no provider, mobile, installer or release changes.

## 2026-10-01 — Refresh the README for stable 1.0.9

- Point the repository's desktop badge, downloads and release notes to the
  published 1.0.9 stable release. Describe OpenCode's desktop availability and
  Codex Side chat controls, keeping mobile availability separate.
- Add the stable npm command for fresh server installations, My Agents setup
  guidance and the managed update path for existing servers, including the
  signed legacy bridge. Link backend documentation to the maintained source.
- Update the linked desktop OpenCode guide and preserve its previous anchor.
  Verify the four desktop download URLs and relative documentation links and
  anchors. Documentation only; no application, service or release changes.

## 2026-09-30 — Desktop workflow usage events

- Add 33 aggregate desktop events for side chats, custom API settings, goals,
  workspace saves and Git actions, uploads, queue/steering, built-in slash
  selection, and explicit app/server update actions. Include keyboard entry
  points in the existing Open file metric. The complete catalog and outcome
  definitions are in `docs/ANALYTICS_EVENTS.md`.
- Keep the existing anonymous envelope and `success`-only property allowlist.
  Do not send content, names, paths, model/provider details, credentials or
  resource IDs. Team Network instrumentation is unchanged; shared-browser and
  iOS analytics remain disabled. Update requests are not installation success,
  and chat-reference submission is not proof of peer delivery.
- Verified with an isolated native macOS Electron app, production IPC/HTTP and
  a disposable AgentsServer: send and queue two real Codex turns; open, send a
  follow-up and stop a side chat; save/clear a Codex goal; open a file by button
  and shortcut, edit/save it, stage it and commit the reviewed disposable index;
  open My Agents and fail a connection check against an unavailable test
  endpoint; check desktop/server updates and change the desktop channel.
  Captured analytics requests locally and blocked delivery to Mixpanel; only
  the documented property keys were present. No production app/server restart.
- Validation: 951 focused tests, TypeScript and production compilation passed.
  Live acceptance is partial for upload, steering, Claude goals, goal
  pause/resume, credential persistence, Git conflict/abort and actual update
  install/cancel/retry paths; these were not exercised in this run. No claim of
  release readiness or completed installation is made. Availability: source
  and isolated local build only; no release or deployment.

## 2026-09-29 — Preserve Claude history activity access

- Keep the activity disclosure when a compact Claude history page uses the
  final commentary as its only trace anchor. Deduplicate the visible reply
  while retaining the run and sequence needed to load its activity on demand.
- Claude text blocks are projected as assistant output in the server source;
  the desktop also surfaces legacy report-shaped commentary when those events
  are present, after ownership filtering and final-answer deduplication. These
  source changes do not imply a server deployment.
- Verified in the actual local macOS package against the connected server:
  reopened an affected historical chat, expanded the restored activity control,
  loaded its report and tool details, then collapsed it. Focused timeline/UI
  regressions (324), 88 Claude SDK/print-runner tests, TypeScript and production
  compilation passed.
- Acceptance remains partial: the running server's compact history can omit
  legacy report text until expansion. Default-visible recovery through that
  paging boundary and a new native Claude turn remain unverified. No claim of
  full native-provider parity or release readiness is made.

## 2026-09-28 — Combine editor line endings with desktop/server fixes

- Bring contributor PR #24 into the tested desktop/server follow-up branch,
  retaining Haokai Ding's authored commit and original commit reference. The
  runtime/editor test patch is unchanged; resolve only the development log by
  retaining both histories. The provider/API feature baseline is already in main
  through PR #47; this integration does not reintroduce it as an unmerged change.
- On the combined source, 339 editor/workspace/transport tests and 292 isolated
  server workspace/history/runtime tests passed, plus TypeScript and production
  compilation. Actual offscreen Electron exercised CRLF, LF and CR edit/save,
  undo/save and redo/save against a disposable authenticated AgentsServer: nine
  exact on-disk byte assertions passed. No clipboard access was used in this
  integration check. Native Windows UI was not exercised.
- Installed test apps and existing server instances are unchanged by this PR
  preparation. The contributor's fix is newly included in source, not in the
  previously installed local test package. No release or deployment is implied.

## 2026-09-28 — Manual server connection saves on macOS

- Direct macOS builds now use the bounded Keychain credential path for manual
  server creation and token replacement, not only automatic local discovery.
  Saving no longer enters synchronous Electron OSCrypt. Failed writes keep the
  old connection intact, report a recoverable error and never store plaintext.
- Rollback does not decrypt legacy ciphertext unnecessarily. Printable tokens
  containing command-parser punctuation use Keychain's hexadecimal stdin input;
  secrets remain absent from process arguments. MAS and other-platform secure
  storage paths remain unchanged. Existing custom server labels are retained.
- Validation: 473 focused desktop tests and a full suite of 5,005 tests passed
  (5 skipped). After extending printable-token transport, all 85 focused
  settings/Keychain/Team Hub tests passed again. TypeScript, production build and
  eight package/license checks passed.
- Real offscreen Electron UI exercised manual Test connection, Add & switch,
  token replacement, custom rename and process reopening against two isolated
  authenticated AgentsServer instances, using the actual macOS Keychain, not a
  credential mock. Reopened connections and both custom names survived. Failure
  rollback and secure-store denial are regression-tested; the user's remote
  machine/network and a physically locked Keychain were not exercised.
- Availability: local test build; no server restart, publication or deployment.

## 2026-09-27 — Mailbox input ownership and scoped macOS file discovery

- Integrate the existing native-continuation ownership fix: retain the initial
  Codex input turn ID separately from its later continuation. Older history
  requires exact, unambiguous assistant-item and completed-run evidence before
  classifying a replay as internal. Genuine user messages with identical words
  remain visible; original provider transcripts and audit events are not edited.
- Recursive workspace search from Home or an ancestor no longer enters the
  macOS user's private/system-managed home trees. Skip these paths before
  opening or inspecting them, including empty queries; bypass Git's recursive
  untracked-file enumeration for these broad scopes. Explicit project scopes,
  direct opens, normal same-named project folders and OS permission errors retain
  their existing behavior. This is not a new sandbox or a permission grant.
- Validation: server batches of 290 and 131 focused tests passed (overlapping);
  desktop batches of 140 and 60 passed (overlapping), plus TypeScript checking
  and production compilation. New privacy regressions cover broad and explicit
  scopes, Git fallback, empty/missing searches, aliases, symlinks and denied access.
- Isolated offscreen production Electron reproduced both discovery of synthetic
  app-container files and a duplicate internal input with the old history repair.
  Through real IPC, authenticated HTTP, WebSocket catch-up and local cache, verify
  corrected history, older-page loading, refresh and app reopening. One genuine
  same-text user input and the original replies remain. Opening the file palette,
  searching, switching workspace and explicitly opening a synthetic private path
  exercise the new search boundary. Fixture transcript/ledger hashes are unchanged.
- Limits: no real private app data or macOS TCC settings were accessed; the
  reported permission dialog and remote customer's exact ledger were not tested.
  Provider records are synthetic; continuation execution is covered by controlled
  native-router regressions, not a new live-model request. No mobile, packaged
  release, existing service restart or deployment is claimed. A new server
  candidate must include these changes; frozen release artifacts are unchanged.

## 2026-09-27 — Readable default server names

- Unnamed desktop server connections use their URL host and port rather than
  the opaque server identity. Remember whether a label is automatic or custom;
  automatic labels follow URL edits, while explicit names remain unchanged.
- Normalize exact legacy identity/hostname defaults on settings load without
  changing profile IDs, server identities, credentials or cached chat ownership.
- Validation: 64 focused settings/selector/management tests, TypeScript and
  production compilation passed. Two full-suite attempts each passed 4,997 tests
  (5 skipped) but encountered different unrelated UI timing failures; the
  WorkspaceEditor and WorkingDirectoryPopover files passed all 136 tests on
  isolated retries. Full-suite green is not claimed. Eight package/license
  checks also passed.
- Actual isolated offscreen Electron exercised legacy-name migration, adding
  an unnamed server through authenticated native HTTP, manual rename, app
  restart and switching servers. Dark/light and narrow layout were inspected.
  No live app replacement, existing service restart, mobile change or release.

## 2026-09-27 — My Agents and clearer chat deletion copy

- Rename the desktop settings section to **My Agents** / **我的 Agent**,
  including navigation, onboarding guidance, accessible card labels and server
  recovery instructions. Fill Chinese endpoint/model/key wording without
  translating product names, CLI commands or API protocol identifiers.
- Label chat deletion **Delete from AgentsDock** and explain that history in
  the original agent is retained. Sidebar, header and confirmation use the
  same wording; deletion behavior is unchanged. Correct the obsolete Codex
  Forget success message to describe blocked sends until reconnection.
- Validation: 4,991 desktop tests passed, 5 skipped, plus 8 package checks;
  41 isolated server tests, TypeScript and production compilation passed.
  The focused bilingual regression set contains 167 passing tests (included
  in the desktop total). Audited 144 connection/account/model locale entries.
- Actual offscreen production Electron with disposable profile/server state
  exercised English and Chinese settings navigation, Claude/Cursor/OpenCode API forms,
  authentication-error copy, model discovery against a synthetic loopback
  endpoint, Forget confirmation/cancellation, and chat deletion cancellation.
  Production IPC/native HTTP/storage ran intact; no real provider inference
  or native-history deletion acceptance was repeated for this copy-only change.
  Light/dark and narrow layout were inspected. Chinese startup was seeded in
  the disposable language preference; native language-popup interaction was
  not certified by this offscreen run.
- Availability: local source/build only. No live app replacement, existing
  server restart, mobile change, publication or deployment.

## 2026-09-27 — Desktop line-ending integration accepted locally

- Integrated PR #24 from contributor commit `3f29f4d9` as `a4f6b281`, retaining
  the original author. Only the development-log conflict required resolution.
- Reproduced CRLF-to-LF rewriting on the preceding main build. The candidate
  preserves CRLF, LF and CR through native edit/save, undo and redo; mixed files
  normalize to the first separator. Native clipboard paste, external reloads,
  restored YAML folds/cursor positions, UTF-8/CRLF byte-limit boundaries and
  stale-save rejection/reload recovery passed with byte-level file checks.
- Acceptance used isolated offscreen Electron 43.1.1, the production app build
  and AgentsServer `1.0.7-beta.11`, through real IPC, authenticated HTTP and
  revision-checked filesystem writes. Only disposable credential storage and
  fixture setup were synthetic; no provider inference was needed or claimed.
- Validation: 339 focused desktop tests and 53 server workspace-file tests,
  TypeScript checking and production compilation passed. Availability: local
  source/build only; no package installation, release, deployment or merge.

## 2026-09-17 — Preserve desktop editor line endings

- Preserve a file's first line-ending style when emitting edits, including undo
  and redo. External reloads adopt the newly loaded style; mixed line endings
  normalize to the first separator on edit.
- Count UTF-8 limits against serialized output, including both bytes of CRLF.
  Keep cursor, fold and replacement ranges in CodeMirror's logical coordinates.
- Add regressions for line-ending preservation, external reloads, LF inserts in
  CRLF documents, byte limits, cursor clamping and fold restoration.

## 2026-09-27 — Custom API live acceptance and API-only chat routing

- Cursor and OpenCode advertise cross-chat transport when their CLI is installed
  and this server has a verified custom API connection, even without native
  account login. This does not mark native login ready or bypass per-chat
  admission, credential revocation, CLI compatibility or route authorization.
  Capability reads use local metadata, not additional provider requests.
- Live acceptance used disposable chats and workspaces with real provider
  requests. Cursor used its official API-key service; Claude Code, Codex and
  OpenCode used a verified OpenRouter connection. All four produced a response.
  OpenCode ↔ Cursor and Claude Code ↔ Codex delivered one request and one reply
  each through the run-bound tool and mailbox, verified against server events.
  The native desktop rendered replies and recovered a successful Claude tool
  attempt after an initial model attempt used an unavailable shell command.
- A nonexistent-route attempt was rejected with no extra delivery. This is not
  a substitute for the isolated cross-chat ownership/authorization regressions.
  Settings rejected unverified credentials without saving them or falling back
  to native accounts. Direct Anthropic/OpenAI key acceptance remains unverified;
  gateway success does not certify every endpoint/model combination.
- Validation: 373 provider/server tests, 1,126 desktop tests, then 175 targeted
  routing/binding tests passed (server batches overlap). Native UI checks used
  a separate desktop profile and the designated test server. No release is
  published by this acceptance record.
- Full CI exposed summary-size and OpenAPI operation-ID regressions, an outdated
  lifecycle-lock field assertion, and two Chinese terminology inconsistencies.
  Keep legacy native connection defaults sparse while retaining explicit cache
  tombstones; keep model inventories out of per-session summaries; register
  method-specific API routes. The focused follow-up passed 108 server tests
  and 56 desktop/localization tests without relaxing the original guards.

## 2026-09-27 — Reconnect existing API chats and check on send

- Existing custom API chats can resume after explicitly verifying the same
  original URL and API key again. Forget still blocks new turns immediately;
  a different endpoint or key cannot silently take over an old chat. Applies
  to Codex, Claude Code, Cursor and OpenCode, including legacy bindings.
- The composer no longer blocks Send based on cached login, model or connection
  readiness. Server capability and ordinary submission safeguards remain.
  Actual rejected sends preserve the draft and show Check failed with the
  Configure API action. Retrying or reconnecting clears the matching old error;
  equivalent catalog refreshes do not erase a real failure notice.
- Verification: 108 isolated server tests and 502 focused desktop tests passed;
  TypeScript checking and production compilation passed. Isolated native
  Electron exercised Forget, a rejected send, draft retention, Configure API,
  reconnect and successful resubmission in the same chat through IPC, native
  HTTP authorization, production connection storage and send admission. The
  provider adapter was synthetic: live paid-provider inference remains a
  separate acceptance check. No real user's chat received a test message.
- Availability: local feature branch; authorized local app/server installation
  tracked separately. No release publication or merge is implied.
- Local acceptance: source `a4042410`, desktop `1.0.7-providers.15.local`,
  server `1.0.7-beta.15+providers.a4042410`. Bundle audit, ad-hoc signing and
  packaged-source comparison passed; the installed app loaded with its active
  profile preserved. The designated server retained its identity and provider
  settings. Read-only verification confirmed the reconnected existing chat's
  API binding is available, without sending a test message to that chat.

## 2026-09-27 — Forget revokes existing custom API chats

- Forget now durably revokes this server's existing custom API bindings for
  Codex, Claude Code, Cursor and OpenCode. New turns and model checks fail
  closed without native-login fallback; history and other instances remain
  untouched. Saving again creates a new connection, not a silent reassignment
  of old chats. Already-dispatched requests are not forcibly terminated.
- Migrate earlier empty Forget records on read. Atomic revision/epoch markers
  survive restart and later saves. Keep historical key material private for
  in-flight redaction; revocation is not secure deletion of credential files.
- Desktop immediately invalidates associated cached chat readiness and explains
  the effect in confirmation. CLI Login has no logout/disconnect action.
- Verification: 107 isolated server regressions and 443 focused desktop tests
  passed. Typecheck and production compilation passed. Actual isolated native
  Electron exercised cancellation, confirmed Forget, recovery navigation and
  reconnect through IPC, native HTTP authorization and production storage;
  the production admission function rejected the revoked chat with HTTP 409.
  Its Cursor success adapter was synthetic, not live inference. A separate
  installed-CLI loopback probe verified Cursor's dedicated key-exchange protocol
  and rejection of standalone local-agent flags; arbitrary model URLs remain
  unsupported. No real user's chat was sent a test message.
- Availability: local feature branch; local app/server installation tracked
  separately. No release publication or merge is implied.
- Local acceptance: source `c3784f6d`, desktop
  `1.0.7-providers.14.local`, server `1.0.7-beta.15+providers.c3784f6d`.
  Packaged-source comparison, bundle audit and ad-hoc signature checks passed.
  A read-only installed-server check confirmed a previously forgotten legacy
  chat remains readable but its API connection is unavailable. Only the
  authorized test instance was restarted; connection settings were preserved.

## 2026-09-27 — Cursor API-key connection

- Add a key-only Cursor API card in AI Providers, separate from CLI Login.
  Connect validates through the native Cursor model-list command before storing
  the key; new chats offer `Cursor API key` only while configured and verified.
  Models belong to that key, with `auto` as the initial default. This is not an
  arbitrary OpenAI-compatible endpoint.
- Store credentials privately per AgentsServer with revision fencing and
  immutable per-chat bindings. Forget removes the current connection for new
  chats, not keys already bound to existing chats; no machine logout occurs.
  Native transport remains administrator-only, keys are never returned, and
  failed replacement preserves the previously verified key.
- Cursor can persist API-exchanged tokens by default. Key-bound runs, checks,
  and title requests therefore use its in-memory credential store, clear
  higher-priority auth tokens, force the official service, and disable direnv
  credential overrides. Require CLI 2026.09.26 or newer (the tested isolation
  baseline). API-key turns do not change the native login diagnostic.
- Verification: 139 focused server tests passed, including a real subprocess
  runner fixture asserting the pinned key/environment and no key in argv or
  events. Native Electron → IPC → administrator HTTP → production router/store
  → rendered status exercised Connect, invalid key, and confirmed Forget with
  a synthetic Cursor adapter. The actual installed Cursor CLI rejected an
  invalid key with no native-login fallback. A valid user key and successful
  Cursor inference are still required for full live acceptance.
- Full desktop run: 4,971 passed, 3 failed, 5 skipped. The three failures were
  in unrelated sharing/editor tests; rerunning those suites together with the
  changed provider suites passed all 212 tests. Typecheck and native build are
  checked separately. No claim of a completely green full-suite run.
- Final focused reruns passed: 83 server tests and 53 desktop provider tests.
  Local ad-hoc desktop build `1.0.7-providers.13.local` passed the bundle audit,
  signature verification, and byte-for-byte comparison of 88 compiled files.
  Its actual settings page exposes the enabled key-only form. The selected
  development server was restarted and its authenticated health and Cursor
  credential route verified; other server instances were not restarted.

### Cursor API-key usage

Settings → AI Providers → Cursor → Configure API → paste a Cursor-issued key →
Connect. Create a new chat with **Cursor API key**. CLI Login remains a separate
choice and identity. The key comes from Cursor Dashboard → API Keys; see the
[Cursor authentication guide](https://cursor.com/docs/cli/reference/authentication).
Forget is in the API card's three-dot menu and requires confirmation.

## 2026-09-27 — Provider onboarding and safe empty-chat cleanup

- Default new Claude API configurations to the official Anthropic endpoint and
  authentication header; preserve previously configured third-party endpoints.
  OpenCode no longer defaults to OpenRouter. Link its official Zen documentation
  and explain protocol selection. Distinguish Cursor-issued API keys from
  arbitrary third-party model endpoints; settings-based Cursor key storage is
  not implemented by this change.
- Reconcile endpoint Save/Forget immediately and fence older catalog responses.
  Offer only connected Agent choices, including the direct-new-chat shortcut.
  Add Agent opens AI Providers; custom-API error recovery opens the matching
  provider section without rechecking native CLI authentication.
- Mark new blank placeholders from both creation paths. On startup or explicit
  list refresh, preserve drafts, attachments, references, jobs and terminals;
  discard only proven unused placeholders through a separate conditional server
  endpoint. Unsupported servers preserve the chat instead of falling back to
  ordinary Delete. The server checks again under lifecycle/deletion fences and
  preserves malformed or nonempty history. Native provider history is untouched.
- Desktop regression: 4,969 passed, 5 skipped. Server focused regression: 97
  passed. Native Electron against a disposable authenticated endpoint fixture
  verifies official Claude defaults, disconnected choices hidden, Add Agent
  navigation, successful API setup, and confirmed Forget immediately removing
  the custom choice. No real account keys were changed during fixture testing.
  Verify the API recovery button in the native composer opens the matching
  settings group. Live development-server cleanup removes only disposable
  empty test chats and retains an unsent draft. This check uncovered the editor's
  deferred draft persistence; flush live editor refs and temporarily block
  editing/admission during discard. Re-run 843 affected desktop tests after
  that fix; all pass. Verify immediate type → refresh preserves the draft and
  clear → refresh discards the same disposable placeholder, without a debounce
  wait. The signed local desktop package passes bundle audit; all 88 compiled
  files match the tested build. Verify AI Providers in the installed app,
  preserve the active server profile, and leave normal launch/debugging disabled.
  Official Cursor API-key and OpenCode Zen/Go model calls are not live-tested;
  their documentation does not imply arbitrary endpoint/model compatibility.

## 2026-09-27 — Endpoint confirmation spacing

- Use a compact, centered confirmation with consistent 24px insets, 16px content
  spacing and an 8px button gap. Wrap the actions on narrow screens; preserve
  the existing confirmation, cancellation and endpoint-only deletion semantics.
- Reproduce zero body padding in the native app, then verify real menu selection,
  centered geometry, dark/light and narrow layouts, keyboard selection, Escape,
  Cancel and repeated opening. Recheck the signed packaged code with an isolated
  profile, then leave the installed app's active server selection unchanged.
  No live endpoint is forgotten during this appearance-only check; localized
  visual acceptance remains pending.
- All 60 focused tests, type checking, compilation and 8 build/license checks
  pass. The full desktop suite reports 4,963 passes, 5 skips and 2 failures in
  unchanged Chinese terminology/OpenCode catalog assertions; retain these for
  separate follow-up. No server update, publication or merge is included.

## 2026-09-27 — Visible endpoint menu inside Settings

- Fix the custom endpoint menu painting behind the Settings dialog. Give this
  nested menu and its confirmation overlay/dialog explicit, narrowly scoped
  layers above Settings; CLI Login and endpoint removal semantics are unchanged.
- Reproduce the hidden menu in the real desktop before fixing it. Verify visible
  menu/confirmation, repeated opening, Cancel/Escape and keyboard selection in
  an isolated native app connected to the development server. Check dark and
  light/narrow presentation, then repeat menu/confirmation/cancel in the signed
  installed local package. No real credentials are removed; confirmed deletion
  transport is unchanged and covered by the preceding disposable-fixture check.
- The layering regression fails before the CSS fix; all 59 focused checks,
  TypeScript and production compilation pass. Local package only; no server
  update or public release. Localized visual acceptance is not repeated.

## 2026-09-27 — OpenCode chat tools and concise provider settings

- Add a run-bound native MCP bridge for OpenCode, preserving server authorization,
  exact process ownership, permission boundaries and private endpoint settings.
  Enable OpenCode source/target choices only on supporting servers.
- Custom API cards offer a confirmed **⋯ → Forget endpoint** action. CLI Login
  remains read-only with no Disconnect/logout action. Keep default-model selection
  visible and save a selection automatically; remove routine reload/manual-toggle,
  save-default and saved-key-check controls from connected cards.
- Verification: 244 isolated server checks and 606 desktop checks pass, with
  TypeScript, production compilation and signed local-bundle validation. Two
  real OpenCode A → B → A mailbox round trips complete with nonduplicate receipts
  and preserved delegation; the second starts through desktop mention selection
  and Send, including IPC/native HTTP and advertised client capabilities.
- OpenCode 1.18.29 executes the run-bound tool with default permissions. Its Plan
  agent also executes the bridge using a tool-capable custom API model; the free
  model's Plan request returned a provider-side 403. This does not certify every
  model or endpoint. Live stopped/busy-turn acceptance remains pending; ownership,
  cancellation and transport fences have isolated regression coverage.
- Actual desktop checks cover connected-card presentation/catalog loading and,
  against a disposable native-admin API fixture, Forget cancellation and confirmed
  removal without changing any real account. Default-model autosave has component
  coverage; native select-menu interaction and light/localized visual acceptance
  remain unverified. Update only the designated local development server/app;
  no public release or production deployment is included.

## 2026-09-27 — Independent custom API model catalogs

- Keep native CLI model catalogs separate from custom API inventories. Discover
  endpoint models with bounded pagination, readable labels and conservative
  non-chat/tool filtering; use OpenRouter's user-filtered inventory.
- Add a default-model dropdown and manual-ID fallback to connected API cards.
  Save only the model/revision, without resubmitting keys or claiming a new
  authentication check. Never automatically select the first model.
- Preserve existing chat bindings and legacy inferred choices for started Codex
  threads. Fence discovery and saves to the selected server/revision, and expose
  explicit catalog refresh for each supported custom provider in chat selectors.
- Verification: 76 isolated server checks and 96 focused desktop checks pass,
  with TypeScript, compilation and signed local-bundle validation. The real
  desktop reads all three endpoint inventories through IPC/native administration;
  manual default save, reopen and clear succeed without a key prompt. Browser
  administration is rejected. Dark/narrow layout is checked. Native select-menu
  keyboard selection, light/localized visual checks and paid model/tool requests
  remain unverified. The temporary empty UI-test chat is removed; no real provider
  history is touched. No public release is part of this validation.

## 2026-09-27 — CLI login account cards

- Match CLI Login and Custom API card styling in all provider groups. Show
  available CLI email/plan separately from custom API billing; omit unknown
  fields. Claude metadata is explicitly a saved profile, not a login probe.
- Add a read-only, native-administration account route and profile-fenced desktop
  transport. Opening a card never renews credentials or runs model inference.
- Model discovery/default selection is unchanged; catalog/compatibility UX
  improvements remain a separate research recommendation.
- Verification: 55 focused desktop checks and 17 isolated server checks pass,
  along with TypeScript, production compilation and local bundle validation.
  The installed development app exercises expansion/reopening through IPC and
  native HTTP into the real administration guard: Claude and Cursor return
  email/plan only in their CLI cards. Dark/narrow layout is checked. Light-theme
  and full localization visual acceptance remain pending. No inference, login
  renewal, credential changes or public release is part of this check.

## 2026-09-27 — Folded provider settings and managed local discovery

- Present four expandable provider groups. Separate native credential presence
  from explicit API connection checks, with brief CLI guidance only when absent.
  Chat choices show connected native and custom methods separately, native first.
- Wire Claude and OpenCode custom connections into explicit per-chat runtime
  bindings. Pin private credentials, preserve native login/settings, reject
  cross-login resume, inherit bindings on forks and fail closed without a model.
  Cursor generic third-party endpoints remain unsupported, not falsely verified.
- Discover owned managed local installations once at desktop startup; check
  listener ownership before authentication and verify durable identity. Preserve
  saved profiles and current selection; never scan LAN addresses or start services.
- Keep macOS automatic credential writes in the existing bounded Keychain helper,
  avoiding concurrent startup OSCrypt/Keychain blocking. Fail closed if secure
  storage is unavailable; normal explicit credential editing remains unchanged.
- Focused synthetic checks cover credential isolation, transport, UI and discovery.
  TypeScript and production build are checked. Real third-party model/tool
  compatibility remains user acceptance work; no broad regression or release.

## 2026-09-27 — Visible provider connection state and login guidance

- Put API configuration near the top of AI Providers and use the same
  Configure API action for Codex, Claude Code and OpenCode. Unconnected,
  unknown, draft and failed states have neutral icons; only verified saved
  API connections get a green check. A failed settings read is not signed-out
  or connected evidence. Native account identity remains separate.
- Show native sign-in guidance with fixed, copyable commands for the selected
  server, rather than executing login on a possibly unrelated desktop. Keep
  installed-but-unconfirmed runtimes neutral. Claude still confirms auth on
  actual sends; opening settings does not renew its credentials. Cursor's
  unsupported generic API configuration remains explicitly labeled.
- Exercise real Electron mouse/keyboard input through production IPC/native
  HTTP, native-admin authorization and endpoint storage against an isolated
  loopback API. Verify all three connections, bad-key retry, key clearing,
  navigation/reopen, login instructions and light/dark narrow presentation.
  Fixture credentials do not certify third-party accounts or native login.
- TypeScript and production compilation pass. Related settings/CSS tests pass;
  the full suite found one outdated translated-label assertion and one
  unrelated workspace timeout. Correct the label, and pass focused settings
  tests and all 134 workspace tests on rerun.
- Update the explicitly designated development server with this feature
  branch, preserving identity and saved credentials; verify new settings routes
  and credential-check support. No public release or main-branch merge.

## 2026-09-27 — Clear custom API identity and connection state

- Separate the native Codex account from custom API credentials and billing.
  Hide unconfigured custom choices in new-chat/composer menus without changing
  existing custom chats. Never query native account quota for a custom chat.
- Reduce forms to URL, key and Connect; fold protocol/model controls into
  Advanced. Default checks use protected read-only APIs, not model inference.
  Public catalogs cannot verify keys; known OpenRouter connections use its
  private key-status API. Claude/OpenCode model probes remain explicit opt-ins.
- Codex Connect saves only after server-side credential verification. Bind
  the saved proof to the immutable credential revision; legacy saves remain
  compatible but unverified. Preserve prior credentials on a failed replacement
  and clear entered keys after completion. Keep native login unchanged.
- Verify real Electron mouse/keyboard → production IPC/native HTTP → actual
  native-admin guard, router and storage → loopback HTTP checks. All three
  supported settings cards verify with synthetic keys; bad-key retry, reopen,
  saved recheck, separate account identity and dark/light narrow layouts pass.
  No third-party credentials, paid requests or native agent sends are exercised.
- Pass 89 related server tests. The desktop suite passes 4,944 tests (five
  skipped) with one missing CSS token; fix the token and pass its three-test
  suite. TypeScript, production build, bundle audit and ad-hoc signature pass;
  all 88 compiled files match the packaged application.
- Replace and reopen the local development App as `1.0.7-providers.2.local`,
  retaining its profile and previous bundle. Confirm the existing server's
  saved Codex endpoint is unverified, not tied to the native account. That
  server lacks the new verification/settings routes: deployment remains
  pending operator approval. Claude/OpenCode are settings-only; Cursor has
  no generic API form. Availability: local App/source only; no public release.

## 2026-09-27 — Settings-only Claude Code and OpenCode API connections

- Extend desktop AI Providers with separate Claude Code and OpenCode endpoint
  profiles. Explicitly verify a small model request before saving, show a
  timestamped API-check result, recheck saved credentials, and confirm removal.
  Keep native login and chat routing unchanged. Add OpenRouter setup guidance
  and a Cursor notice explaining why a generic model gateway is not a Cursor
  CLI service endpoint.
- Add native-only, revision-fenced server routes with private atomic storage,
  bounded request/response sizes, timeouts, no redirects or implicit proxy
  credentials, and credential-free responses. Preserve old credentials on a
  failed replacement; reject browser-origin and stale-server requests.
- Exercise the production desktop build in an isolated native profile through
  renderer mouse/keyboard input, IPC, native HTTP transport, the actual server
  authorization functions, new router/storage and real outbound HTTP. Verify
  both forms, a failed-key retry, saved recheck, removal, cancel, navigation
  and reopen. Inspect light/dark presentation and narrow layout. The model API,
  health/session data and initial server profile are synthetic fixtures; no
  user credentials, native provider login or live chat was changed.
- Pass 4,940 desktop tests (five skipped), then targeted profile-isolation
  coverage; pass 73 related server tests and nine packaging-manifest checks.
  TypeScript and production compilation pass. Chinese copy, stale responses
  and disconnected/old-server behavior are covered by component/transport
  tests. Actual third-party API and agent-tool compatibility remain unverified
  until a user supplies a test endpoint/key. Availability: local source and
  development build only; compatible client and server updates are required.

## 2026-09-27 — Dedicated desktop AI Providers settings

- Add an AI Providers section with the selected server's existing runtime
  diagnostics, Codex account information and Custom endpoint controls. Move
  those controls out of Server settings and retarget endpoint configuration
  links. Keep authentication, credential storage, transport and server behavior
  unchanged; do not introduce another provider's endpoint implementation.
- Validate the local `1.0.7-providers.local` desktop package, based on main
  `f50595b4`, through native renderer mouse/keyboard input and the production
  IPC/HTTP connection. Open and reopen the page, read the actual account and
  endpoint configuration, enter an unsaved synthetic key, navigate away, and
  verify it is cleared. Follow the composer configuration link into the new
  section. Remove the empty disposable chat used for that navigation check.
- Inspect dark and light presentation, a narrow viewport, scrolling and
  keyboard focus. Chinese copy, disconnected controls and stale server
  responses are covered by component tests, not live multi-server testing.
  Do not save credentials, probe an endpoint or send provider messages during
  these UI-only checks; those unchanged workflows are not re-certified here.
- Pass 4,932 desktop tests (five skipped), TypeScript, production compilation,
  package audit and local signature verification. Preserve the existing app
  profile. Availability: local branch and ad-hoc package only; no server
  restart, release or publication.

## 2026-09-27 — Skip native questions in no-prompt modes

- Skip Codex user-input questions under `never` and Claude SDK questions under
  `dontAsk` or `bypassPermissions` through the existing empty-answer/skip
  responses. Do not create waiting interaction cards, invent answers or grant
  additional tool permissions.
- Keep ownership, Stop and deletion checks. Use the current turn's captured
  policy, including independent Codex side conversations; preserve questions
  and answer handling in normal prompting modes.
- Pass 290 scoped server tests. A broader 299-test run has one existing
  idle-thread runtime fixture failure, reproduced against unchanged main.
  New skip regressions fail against unchanged main and pass with this fix.
- Integrate with the AI Providers settings work on one development branch.
  Pass 360 combined isolated server regressions covering question handling,
  runner policy capture, side conversations, API settings and packaging.
- Availability: source-only change; no deployment or release. Native provider
  and real App acceptance remain pending. See
  `server/docs/NO_PROMPT_USER_INPUT.md` for the local acceptance checklist.

## 2026-09-27 — Run-bound Cursor chat tools under native permissions

- Replace Shell-based helper instructions for Cursor with a private per-run
  MCP plugin. Preserve native CLI session IDs, login, working directories,
  stream output, and history. Keep explicit denies and other tool permissions.
- Reuse server capability checks and idempotent tool execution. Stop and exit
  revoke the endpoint; temporary permission/configuration files are removed.
  Clarify that accepted delivery does not imply reading or replying and must
  not trigger another send.
- Verify real Cursor Default-mode MCP calls and same-ID continuation, native
  Shell rejection, explicit MCP denial, and unchanged global configuration.
  These native probes use a synthetic inbox. Server integration tests cover
  the real IPC and live-run fence with a fixture provider process.
- Pass 256 focused Cursor, authorization and mailbox tests, plus targeted
  packaging/configuration checks and Python/shell compilation. Additional
  lifecycle coverage rejects non-regular configuration files without hanging.
- Activate the patched local beta candidate through the normal authenticated
  restart path. Preserve server identity and existing chat/native session
  associations; leave other running server instances untouched. The user
  subsequently accepted local App testing and requested source integration.
  Individual manual checklist results were not separately recorded; this does
  not replace independent full App round-trip or release acceptance evidence.
- Availability: locally tested server fix submitted for main integration; no
  public package or release publication. See
  `server/docs/CURSOR_PROVIDER_MCP.md` for the contract and limitations.

## 2026-09-27 — Keep Claude model discovery passive

- Remove disposable authenticated model-discovery processes and their forced
  teardown. Reuse bounded model metadata from real SDK initialization, with
  configuration-scoped expiry and invalidation after native auth failures.
- Preserve passive readiness, native alias labels, explicit empty pickers and
  fallback discovery. Do not promote project-specific model settings into the
  global catalog or retain private initialization/account fields.
- Pass 272 focused server tests covering catalog behavior, readiness, SDK
  lifecycle and runner integration; compile changed runtime modules and check
  the diff. Regression tests use synthetic credentials and isolated state.
- Exercise the beta candidate's compiled app in an isolated native offscreen
  Electron window through real IPC/HTTP and the native Claude SDK. Four real
  requests pass, covering server restart/resume, selecting Haiku, repeated CLI
  rechecks and app close/reopen with retained native session/context. The
  picker displays twelve sanitized native options; credentials stay unchanged.
- A before/after regression observes one disposable metadata-process attempt
  in the old path and none in the corrected path. Actual app testing also
  caught and fixed cache invalidation caused by Claude's startup counters.
- Availability: locally tested source submitted for main integration and an
  isolated patched beta server; no public release. Natural OAuth renewal and coexistence with
  older servers sharing native login remain unverified; immediate successful
  requests do not establish that repeated-login incidents are resolved.

## 2026-09-26 — Reauthorize fresh file selections across chats

- Let a fresh native drop, paste, or file-picker selection grant an idle file
  to another chat. Keep selection batches atomic, reject replay of old gestures,
  and prevent delayed upload requests from consuming a newer selection. Active
  uploads and managed attachment grants remain protected.
- Preserve the shared browser's existing upload bridge when the desktop uses
  native batch staging. Its real bridge regression caught an incompatible
  optional-method probe during integration; the corrected tests pass.
- Validate source `b3a3fad1` with TypeScript, 4,927 desktop tests (five skipped),
  eight packaging/license tests, production compilation, bundle audit and local
  ad-hoc signature verification. Use a native temporary filesystem for tests
  requiring POSIX permissions and for signing the local package.
- Launch an isolated native desktop build `0.2.0` / `85` against an existing
  test server `1.0.7-beta.11`; application startup and authenticated health,
  session and job refreshes succeed. The local candidate was subsequently
  manually tested and accepted. Computer-use permissions prevented independent
  agent-operated drag/drop and paste verification; individual manual test-case
  results were not recorded.
- Availability: source and manually accepted local test package. No server
  update is required for this fix; no server restart or release publication.

## 2026-09-26 — Restore ordinary steering during active Codex goals

- Send goal follow-ups to the existing native turn even when the model/effort
  picker has changed for future turns. Preserve the running goal, provider
  settings, original references, command and authority without Stop/restart.
- Remove the obsolete client-capability requirement for plain queued input.
  Keep the goal steering lane available for turns started from a skill.
  Report unsupported new actions separately from a turn that is not ready.
- Reproduce the reported rejection through signed desktop `1.0.7-beta.14`,
  build `1216`: start a real Codex goal at Low effort, change the picker to
  Medium, queue a plain message, and click Send now. The original server
  responds with the reported 409; corrected server source `810d89f` accepts it.
- Exercise two follow-ups on the original running goal, then explicitly Stop,
  Resume goal, change effort again, and steer the completion marker. All three
  requests receive 200, native acknowledgements appear once, the first two
  retain the original run, and the third retains the resumed run. The goal
  completes with no queued messages or renderer exceptions. This uses native
  app input, production IPC/HTTP and the actual provider against isolated state.
- Pass 211 targeted server regressions covering admission, delivery, original
  command/reference ownership, legacy queue records, transport races, queue
  recovery and goal resume; eight focused app goal tests also pass. Regression
  provider fakes are supplemented by the separate live acceptance above.
- Server-source fix only. Existing desktop builds can use it after server
  deployment; no production server deployment or public release in this pass.

## 2026-09-25 — Keep passive Claude login status out of the composer

- Do not show an upfront Claude authentication warning or Recheck button just
  because login has not been checked, or another chat has a cached login failure.
  Remove the composer's stale-auth send gate so retrying after external login
  reaches the native Claude request instead of failing solely on cached status.
- Keep actual errors from the selected chat's latest run visible, clear the
  notice after a successful retry, and preserve missing/broken CLI guidance.
  Full runtime diagnostics and manual rechecks remain available in Settings.
- Regression coverage reproduces the original unknown-state banner, verifies
  send admission without an auth probe, and covers failures, retry recovery,
  stale readiness and Settings. Pass 4,912 desktop tests (five skipped), eight
  packaging/license checks and 30 isolated server authentication/probe tests.
  Type checking and production compilation pass. The new send regression first
  exposed the stale-auth gate and passes after the correction.
- Availability: desktop source and compiled output only; no installation or
  server restart. Live desktop interaction remains unverified because computer
  accessibility permissions are unavailable. This UI correction requires an
  updated desktop app; restarting the server alone does not change it.

## 2026-09-25 — Hand off Codex work after a native re-login

- Detect conservative native file-login revisions on demand and let Recheck
  CLIs explicitly request a normal-Codex process handoff. Token renewal and file
  timestamp changes alone do not count as a new login.
- Preserve active native work, custom endpoints and stored thread identities.
  Release idle ownership before the next turn; keep goals, approvals, side
  chats and background-terminal controls usable while migration waits.
- Check pending requests and caller leases again after waiting for the process
  start lock. Inconclusive release stays retryable; accepted turns are not replayed.
- Pass 621 focused server tests and 43 desktop runtime/health tests. Verify
  isolated lifecycle regressions and a real HTTP/native CLI metadata
  fixture without real credentials or a server restart. Live OAuth renewal,
  model/history continuity and graphical client acceptance remain unverified.
  See [the handoff contract](../server/docs/CODEX_LOGIN_HANDOFF.md).

## 2026-09-25 — Remove standalone Claude auth-status checks

- Remove standalone Claude authentication-status subprocesses from startup,
  catalog refreshes, manual CLI rechecks and turn admission. Installation and
  capability checks do not claim that the user is authenticated.
- Preserve the last actual Claude authentication result and its observation
  time through installation refreshes. Allow a native retry after external
  login, while still rejecting missing or broken executables.
- Keep the existing desktop contract: unknown Claude authentication allows a
  request, whose native result updates readiness. This change requires a server
  update; it does not change the client runtime or publish a release.
- Validate 218 focused server tests, 31 desktop contract tests and TypeScript.
  An isolated HTTP server with a recording CLI fixture exercises startup and
  repeated catalog refreshes with zero auth-status invocations. Successful
  renewal using a real signed-in account is not established by these checks.
- Preserve native model discovery merged in parallel. Its disposable SDK
  initialization processes still use the native authentication environment;
  their renewal/termination behavior needs separate validation. Removing
  auth-status probes does not establish that all catalog work is passive.

## 2026-09-25 — Keep the Side chat button beside the composer

- Align the Side chat launcher with the composer's right edge, including its
  maximum width and narrow-window gutters. Preserve its existing vertical
  position and popover behavior as the draft grows or panes resize.
- Verify signed local desktop `1.0.7-beta.14`, build `1216`, from committed
  source `acdad85`. Reproduce the previous 282.5-pixel gap in the prior build;
  measure zero gap in the corrected native app at wide and narrow widths,
  horizontal and stacked split views, and with a multiline draft. Open and
  resize the popover against an isolated real server using native app input.
- Pass 4,898 desktop tests, type checking, production compilation, package audit
  and signature checks. No renderer exceptions during acceptance. This is an
  app-only local build; no server deployment or public release.

## 2026-09-25 — Repair shared-chat files and live recovery

- Restore the combined link-and-token copy action alongside individual copy
  buttons. Shared-browser attachments support downloads, image previews, and
  ordinary uploads through the existing session-owned file pipeline.
- Remove browser-only attachment count, upload-size and lifetime quotas, and
  transcript/snapshot size rejection. Keep complete messages in paginated
  snapshots; migrate existing size constraints atomically without changing
  stored links, tokens or the database version.
- Drag-and-drop and paste use the same upload path as the chooser, without the
  leftover four-file/eight-MiB restriction. Match browser submissions to their
  existing request receipts so signed attachment IDs do not leave a duplicate
  Submitted bubble after acceptance.
- A temporary live-stream error now permits the browser's existing reconnect
  behavior instead of falsely declaring the share unavailable. Actual
  revocation still ends access.
- Pass 216 affected server tests, including migration rollback, attachment
  ownership, downloads and transient live-stream recovery. Verify real HTTP
  sharing of a complete 3.64 MB message while excluding a 2.66 MB private tool
  record. Preserve an existing share byte-for-byte through database migration.
- In an isolated Chromium browser against the actual server and Codex provider,
  drop six files including 9 MiB text, an empty file and an image; preview, send,
  read them with the provider, and download unchanged bytes. Publish and download
  a new output through its Markdown link. Repeat a single-file drop onto the
  conversation, complete a tool-backed follow-up, and observe one accepted
  message without a lingering Submitted bubble. Running, completion and server
  reconnect states work. No provider or server mock is used for these checks.
- Verify the combined copy action through signed local desktop
  `1.0.7-beta.13`, build `1215`, from source `4caf335`, including native
  IPC/HTTP and exact clipboard contents. Its 4,894 desktop tests, type checking, production compilation,
  package audit and signature checks pass. Follow-up drop/submission fixes pass
  28 shared-chat and 23 desktop send tests plus type checking. The server-hosted
  browser bundle is rebuilt. No deployment or public release.
- Integrate browser follow-up `4f95a99` with current main at `8430ba6`; pass 273
  affected server, catalog and packaging tests. Stop isolated services, revoke
  test shares, remove temporary credentials, and verify the original provider
  credentials remain unchanged.

## 2026-09-25 — Carry forward the provider Delete/release checklist

- Port the documentation-only acceptance criterion from AgentsServer PR #117
  into the canonical server checklist. Require confirmed runtime release,
  preserved native history, native resume, failure handling and chat isolation.
- Verification: documentation diff reviewed; no runtime behavior or deployment
  changes. This is an acceptance checklist, not a claim that every provider has
  already passed those checks.

## 2026-09-25 — Preserve Claude input and repair imported wrappers

- Send ordinary slash-prefixed Claude messages byte-for-byte as written, using
  the provider's native per-message transport flag. Remove the injected literal
  message instruction. Deliberately selected provider commands keep working.
- Reconcile older injected copies and native command XML with their original
  messages using provider message IDs and transcript ancestry. Preserve original
  user text, quoted examples and raw transcripts. Imported-only records without
  matching original-message evidence are left unchanged.
- Carry existing same-ID history corrections in semantic pages even when the
  duplicate's old timeline entry has disappeared. Refresh provider history can
  replace a previously cached duplicate instead of simply omitting it.
- Verify the signed local desktop `1.0.7-beta.12`, build `1214`, with the real
  Claude provider: an absolute path with spaces reaches the provider unchanged,
  a native Read retrieves a new file, ordinary slash text reaches the model,
  and selecting `/context` executes the native command. Refresh provider history
  removes a cached XML duplicate while retaining the original command, result
  and file-read response. Pass 83 transport, 98 history/paging and 109 runner,
  command and goal tests.
- Server-source correction only; no production deployment or public release.

## 2026-09-25 — Restore running forks after hidden history repair

- Keep the last completed native turn as the fork point when later history
  repair adds an imported, metadata-only terminal event. That bookkeeping
  event no longer causes a running Codex or Claude fork to lose its boundary.
- Pass 69 fork tests, including a completed turn followed by mailbox work,
  hidden replay metadata, stopped turns and a currently running turn.
- Verify through the signed local desktop `1.0.7-beta.12`, build `1214`, against
  the corrected isolated server: click Fork while Codex executes a command,
  receive a native child before the parent completes, and let the parent finish
  normally. The child excludes the active turn and recalls inherited file-tool
  output without reading the file again. No renderer exceptions occur.
- This is a server-source correction. It is not deployed or publicly released;
  no desktop rebuild is required for this correction.

## 2026-09-25 — Integrate recovered features with current main

- Preserve synchronized side conversations, goal controls, upgraded Codex CLI
  detection and Python installation fixes alongside the restored provider,
  installer, history-import and named-instance features.
- Include both sets of runtime modules in installation, deployment and archive
  manifests. Keep API details in the server reference and the README concise.
- Move newly added main-branch tests into the recovered test package and align
  isolated fixtures with bounded provider discovery, import filtering and
  recipient-bound user delegation. Unattested legacy provenance stays private;
  oversized attested migration remains recoverable.
- Pass 96 focused installation tests, 40 previously failing CI-related checks,
  500 affected desktop tests and desktop type checking. Complete source CI is
  recorded on the recovery pull request. This integration does not deploy or
  publish a server, desktop application or npm package.

## 2026-09-24 — Accept local beta.12 goal shortcut correction

- Accept local arm64 desktop `1.0.7-beta.12`, build `1214`, from committed source
  `90beac268bda148cbf205a5cf38500feae41f1f7`. Pass all 4,849 active desktop tests,
  TypeScript, production compilation, compiled-package audit, Developer ID
  signature and entitlement checks.
- In the signed package, click Codex's composer goal shortcut, submit a disposable
  goal through native IPC/HTTP, observe native completion, and clear it. Open
  the same dialog again from the Add menu. The unsent main draft survives all
  actions and never becomes a submitted message.
- Verify Claude's goal shortcut still opens its dialog, both composers omit
  account usage, and the corrected controls fit a narrow window. The isolated
  packaged app reports no renderer exceptions. Production credentials remain
  unchanged and temporary credential copies are removed after acceptance.
- This local app is signed, not notarized or publicly published, with automatic
  updates disabled. The correction requires no additional server change.

## 2026-09-24 — Remove account usage preview and align goal shortcuts

- Remove the account usage indicator from the composer while provider reporting
  receives further testing. The context usage meter remains available.
- Give Codex the same goal shortcut beside the context meter and in the Add menu
  as Claude. Both entry points open the existing provider goal dialog directly,
  without sending a chat message or changing its draft.
- Keep public desktop publication on hold. Record local package acceptance
  separately after testing the corrected build through native controls.

## 2026-09-24 — Publish the signed beta.11 server

- Publish server `1.0.7-beta.11` from canonical source
  `9b04f852c5c6e698edbf47f9e64d9eb9b65a81be` and standalone export
  `278f88d1d4110b23b1cab3d30013116b7021214d` after all eight release test
  shards pass: 5,163 cases, including six skipped.
- Verify the Ed25519 signature and all 109 packaged runtime files against
  committed source. Anonymous downloads match all three signed assets.
  Archive SHA256:
  `f4e84a2cb93ba4ebcf30f9db2ab77ada4eac496bd06ce85fb4001d2a0cb17a08`.
- Both managed deployment targets accept the exact version and finish preparing
  it. Activation is scheduled for idle; both still report beta.10 at handoff.
  No running agents are interrupted. This publication changes neither desktop
  releases nor npm tags.

## 2026-09-24 — Accept local beta.11 desktop

- Accept local arm64 desktop `1.0.7-beta.11`, build `1213`, from committed source
  `9b04f852c5c6e698edbf47f9e64d9eb9b65a81be`, paired with the same server source.
  Pass all 4,843 active desktop tests, TypeScript, production compilation,
  compiled-package audit, Developer ID signature and entitlement checks.
- Personally exercise the isolated native app and signed package through actual
  IPC/HTTP with Codex and Claude: inherited tool-result context, follow-ups,
  shared history in two clients, cross-client cancellation and Clear, app closure
  while an answer continues, and native side-context retention after a server
  restart. Verify both providers' goal completion, Codex Clear, Claude Clear &
  stop, and the new Claude header panel. No provider mock is used in these checks.
- Read real account observations from both providers through the packaged UI.
  The test account reports Codex credit availability and Claude reset times;
  neither supplies a percentage. Percentage rendering and rejected-window
  precedence are covered by component/native-event regressions.
- The local package is signed but not notarized or publicly published, and its
  automatic updater is disabled. Public server-candidate validation and deployment
  are recorded separately; a built candidate is not an installed server.

## 2026-09-24 — Shared provider controls, side-chat sync and account usage

- Use the same goal summary, progress and editing layout for Codex and Claude.
  Add Claude's clickable header status panel, with its native context, pending
  interactions and goal entry point. Preserve each provider's supported actions.
- Persist side conversations on the connected server and reconcile them across
  native clients using socket notifications. Accepted answers survive app closure;
  Stop and Clear apply across clients. Codex resumes the saved native side thread;
  Claude restores its native side history. Side content remains outside the main
  transcript, and private Codex forks stay out of main-chat import discovery.
- Show provider-reported account allowance, reset times and credits when supplied.
  Missing percentages remain unknown; API and custom endpoints do not inherit
  ChatGPT allowance. Account changes invalidate observations, and usage updates
  do not become transcript events or trigger model requests.
- Respect Claude's configured data directory when locating native session history
  and goals. Preserve newly typed drafts during Clear and reject late results from
  a previous connection. Refresh side history on reconnect transitions and changes,
  without treating repeated timeline liveness notices as polling triggers.
- Source verification includes the desktop suite, provider transport/authentication,
  persistence and cancellation regressions, installation/package checks, TypeScript
  and production compilation. Native acceptance uses two isolated desktop clients
  and real providers through production IPC/HTTP; release-package acceptance is
  recorded separately after packaging. Both app and server updates are required
  for synchronized side conversations and the account usage indicator.

## 2026-09-24 — Publish the signed beta.10 server correction

- Publish server `1.0.7-beta.10` from canonical source
  `240e29414a8cc843d593d699d7252e0b7df0c401` and standalone export
  `2d84e17f8dc7d23f6ef2da8ecc8f0faeb8be6ba0` after all eight release test
  shards and the paired local app acceptance pass.
- Independently verify the Ed25519 signature and all 108 packaged runtime
  files against committed source. Anonymous downloads match all three signed
  candidate assets byte-for-byte. Archive SHA256:
  `ef5f0418ab6e0890c87b346653fcb570256e1f9bb17d0da0afd292650dfec608`.
- Managed updates prepare while agents keep working and activate when idle.
  An accepted update request does not establish completed installation.
  This publication changes neither desktop releases nor npm tags.

## 2026-09-24 — Remove side-chat answer deadlines

- Remove the 150-second answer cutoff from the shared side-chat runtime and
  Claude's native control path, and the desktop's 210-second HTTP deadline.
  Long answers retain their native conversation and follow-up context.
  Codex side chats inherit ordinary Codex transport settings.
- Preserve Stop, Clear, request-owner cancellation, disconnection and shutdown
  cleanup. Remove timeout copy that promised a retry would work on an older
  server after its native side conversation had already closed.
- Regressions fail before the correction and pass after advancing beyond the
  former deadlines. Exercise a real local HTTP connection, native conversation
  retention, the full Claude manager/control path and cancellation without
  stopping the parent. Pass 282 affected desktop and 238 server checks and
  desktop TypeScript.
- Personally reproduce the old cutoff through an isolated native offscreen
  app and real Codex. With the correction, a 225-second tool completes and the
  app receives its answer after 234 seconds. The main chat answers concurrently;
  a side follow-up retains inherited tool-result context. Stop acknowledges in
  100 ms and its owned tool exits.
- Close a private Codex process promptly when Stop arrives during stalled
  startup or fork creation. Retain ownership of delayed spawns and avoid
  restarting a closed transport after a late fork reply. All 172 affected
  adapter/transport checks pass, including unchanged durable-fork cleanup.
- Accept local desktop `1.0.7-beta.10` build `1212`, arm64, from app source
  `183083a5`, paired with server source `240e2941`. The actual signed package
  completes native Codex and Claude first questions, contextual follow-ups,
  Stop and Clear followed by another answer through production IPC/HTTP.
  The isolated packaged window reports no renderer exceptions. Claude's
  beyond-deadline control behavior is covered deterministically; the actual
  225-second tool check uses Codex. No mocked provider is used for these app
  acceptance checks.
- Pass all 4,804 active desktop tests, TypeScript, production compilation and
  compiled-package audit, plus all eight server release test shards. Verify
  the local app's Developer ID signature. This local app is not notarized or
  publicly published, and its automatic updater is disabled. Both app and
  server corrections are required to remove both answer deadlines.

## 2026-09-24 — Publish the signed beta.9 server correction

- Publish server `1.0.7-beta.9` from canonical source
  `40902a58873b6a9e298a4c9a24f55b80ebe21b4a` and exact standalone export
  `ae9d4373eaeeaf6555eefeb6c3b0243329b4f44d`. All eight release test shards
  and the canonical server, Electron and mobile-source CI checks pass.
- Correct incomplete provider-manager test fixtures exposed by the first
  release validation attempt, then rerun the full suite before signing and
  publication. No failing candidate is published.
- Verify the Ed25519 signature, all 108 packaged runtime files and executable
  modes against committed source. Anonymous downloads match all three signed
  candidate assets byte-for-byte. Archive SHA256:
  `cb442218c9e524bad126190ee1ceb89c28356f41c3d1e91a200c857d75970548`.
- Deployment uses the existing managed updater with fresh preparation and
  when-idle activation. A queued request is not completed installation;
  running agents retain their current worker until its work finishes.
  This release changes neither desktop builds nor npm tags.

## 2026-09-24 — Refresh an upgraded Codex CLI without stopping running chats

- Recheck CLI and subsequent provider operations detect a replaced CLI.
  New chats use a new process while existing turns, goals, approvals and
  background work retain their original owner. Idle chats resume their native
  thread history on the current process. Rechecking the same version does not
  restart it, and read-only inspection cannot retain an old process forever.
- Keep late notifications and approval requests tied to their emitting
  process. Include manager identity in goal reconciliation and close every
  retained process during provider shutdown.
- Pass 376 affected checks, then 67 targeted checks after the final inspection
  correction. The new regression cases cover concurrent routing, idle resume,
  pending work, delayed callbacks, shutdown and inspection-task lifetime.
- Exercise Settings > Server > Recheck CLIs in an isolated native offscreen
  app through real IPC/HTTP. A fresh GPT-6 Sol chat using ChatGPT authentication
  completes while the older process continues its existing turn. That turn
  finishes normally; its old process exits and a contextual follow-up returns
  the remembered phrase using the same native thread ID on the new process.
  A repeated same-version recheck creates no additional process. No renderer
  exceptions or changes to the production authentication file are observed.
- The live test changes a wrapper's reported version while both processes use
  the installed native CLI. It validates handoff and continuity, not historical
  compatibility between two different CLI executables. The final read-only
  inspection correction is covered by its focused lifetime regression.
- Prepare server `1.0.7-beta.9`; public signing, publication and installed
  activation are separate checks. No desktop or npm release is included.

## 2026-09-24 — Preserve existing Python permissions during server updates

- Accept same-user external Python interpreters and bounded uv runtime trees
  with group-write permissions during preparation and activation. Record the
  interpreter's bytes and mode without altering a shared installation.
- Reproduce the preparation and durability failures before the correction.
  Verify candidate and retained releases sharing a `0775` uv prefix with
  `0664` library files and internal links. Changed interpreter bytes or modes
  still invalidate the preparation receipt.
- Pass 81 focused macOS checks (one Linux-only check skipped) and 61 Linux
  checks, including real isolated worker/gateway startup and native systemd
  unit parsing. The corrected scanner also accepts an existing uv runtime
  and retained release without changing their permissions or service process.
  Complete installed-service activation remains a separate deployment check.

## 2026-09-24 — Discover current and older Claude model choices

- Resolve versioned Claude labels from native SDK initialization while retaining
  alias values and existing chat selections. Restore selectable older versions
  through a disposable native picker, not an unfiltered union of static IDs.
- Preserve native restrictions, custom gateways and curated picker settings.
  Metadata probes send no user prompt, disable tools/hooks/MCP, use bounded
  process lifetimes and output, and never return account metadata.
- Include the new runtime module in npm packages and legacy signed-package
  inputs, installer validation and direct-deploy validation.
- Verification: 189 focused server regressions pass. A real Claude Code
  2.1.281 metadata probe through the isolated server catalog returns current and
  older choices without duplicate IDs in 1.78 seconds; user settings are
  unchanged. A full local npm package contains the exact module bytes and all
  78 packaged Python sources compile.
- Boundaries: metadata-only native verification, not billed inference or
  Electron UI acceptance of this monorepo build. This is a source PR; no npm
  publication, release or service restart is part of this change.
- Integration recheck (2026-09-25): retain restored runtime modules and the
  shared catalog deadline when merging current main; move the added tests into
  `server/tests/`. All 214 focused tests pass, including three new deadline
  regressions. A fresh metadata-only native probe returns 15 unique choices in
  0.94 seconds. The local npm archive preserves the exact catalog module and
  all 83 packaged Python sources compile. No archive was published.

## 2026-09-23 — Publish the signed beta.8 server update

- Publish the legacy signed server beta `1.0.7-beta.8` from canonical source
  `8ee941e0d5469a939ffd453acbb42d8e8cfe6132` and exact standalone export
  `2bdc10afcf3e203e8d56ecf2f8d5dbc2b1a9d4d9`. Preserve the separate OpenCode
  release branch and existing stable release.
- All eight server release test shards pass. Verify the Ed25519 signature,
  all 108 packaged runtime files and the packaging policy's executable bits.
  Anonymous downloads of the three published assets match the accepted
  candidate byte-for-byte. Archive SHA256:
  `e951e8782ec948fae8562be9980d777b1918c152094464e4fbaa776413f80333`.
- The merged canonical source also passes Electron type checking, 4,803 active
  tests, production compilation, mobile-source checks and all eight server CI
  shards. This publication changes neither npm tags nor desktop releases.
- Server installation uses the existing managed updater's durable when-idle
  request. Publication and an accepted reservation do not establish completed
  activation; observe each installation's status and authenticated health.

## 2026-09-23 — Integrate accepted desktop and server work into main

- Merge the accepted release-line changes, including native Codex Side chat
  inspection and latest-message navigation, while preserving main's removal
  of the Usage analytics screen and clearer saved-server update settings.
- Resolve update-control conflicts by retaining cancellation behavior, channel
  selection state, saved-server inventory and setup only when unconfigured.
- Pass 268 focused Settings, restart, coordinated-update and timeline tests,
  TypeScript, production compilation and the compile-output audit. Personally
  open General and Updates with native input in an isolated offscreen app;
  confirm analytics removal, saved server/version display and channel state.
  This merge check does not exercise an actual update installation.

## 2026-09-23 — Clarify update settings on the main desktop line

- List saved servers and their known versions beneath the server update
  controls. Retain the server heading when a saved server is offline.
- Offer setup only before any server is configured, including when an inactive
  saved server is offline. Selected update channels expose their pressed state,
  and app update actions wait for a pending channel change.
- Adapt the Settings change to this line's existing manual server updater;
  no server update or backend contract change is required.
- Focused Settings component checks, TypeScript and production compilation
  pass. These checks use component fixtures; native click-through and real
  update transport acceptance remain pending. Availability: source/local
  compilation only, with no release or server deployment.

## 2026-09-23 — Validate local beta.8, build 1211

- Build local macOS arm64 `1.0.7-beta.8` from committed source
  `8a9605aaa4c036061a4912cf5b9ef883d45e5b3a`. Package checks, bundle audit
  and deep Developer ID signature verification pass. This local build has
  automatic updates disabled and is not a notarized public release.
- Personally exercise the exact packaged app with native input, isolated
  profiles and real IPC/HTTP. Codex Side chat reads a newly created workspace
  file, recalls its unpredictable value on follow-up, and clears successfully.
  The parent gains no conversation turns; normal provider-load metadata is
  permitted. The provider runs against the corrected isolated server.
- On a 600-turn synthetic conversation, scroll upward and use the floating
  bottom button; navigate into older history and return to the latest message;
  fork through the real HTTP memory-fork route and verify the child opens at
  the bottom. Each bottom check measures zero remaining scroll distance.
  No renderer exceptions occur. Stop all owned test apps and servers.
- Packaged archive SHA256:
  `8b94bf826ed2e3d848f83650f1b8e79c836419b4218ee51af79a6463640ca7fe`.
  Production server activation and public distribution are separate from this
  local acceptance; Side chat tool access requires the corrected server.

## 2026-09-23 — Restore side-chat inspection and reliable latest navigation

- Match native Codex Side chat: retain the parent workspace and permission
  settings, allow file inspection and ordinary tools, and keep side questions
  separate from inherited tasks. Route side approvals through the existing
  controls without borrowing the main run's helper authority. Stopping the main
  turn leaves side approvals intact; closing Side chat cleans up its own work.
- Verify real Codex reads a file created after the parent turn, remembers the
  result on follow-up, and performs a separately requested local write. Parent
  provider history, settings, goals and queues remain unchanged. Personally
  exercise the app's Side chat with native input through production IPC and
  HTTP: read another new file, verify its unpredictable value, follow up, and
  Clear. The native test window is isolated and offscreen.
- Keep the floating Jump to latest action visible in older-history windows.
  Reproduce the missing control in the actual app with a 600-turn fixture, then
  verify the corrected button reaches the latest message. Verify a new fork
  opens at the end and ordinary saved reading positions remain intact. These
  timeline checks use synthetic history and the real HTTP memory-fork path.
- Reapply the existing bounded initial bottom alignment when virtualized row
  heights settle. A focused regression covers a delayed height change and user
  scrolling cancellation; ordinary fork landing already worked in the baseline
  native fixture, so it does not establish the intermittent failure's frequency.
- Validation: 4,804 active Electron tests, eight stock Node checks, TypeScript,
  production compilation, and focused server adapter/provider/approval checks
  pass. Package acceptance is recorded separately. Side-chat tool access needs
  the server change; the scrolling corrections are app-only.

## 2026-09-23 — Publish the fresh-install npm beta

- Publish `@agentsdock/server@1.0.7-beta.5` publicly from committed source
  `5486cbcb096026e798f6b0bc20743b71d7b4a9c1`, available on
  `release/npm-1.0.7-beta.5`. This is an opt-in fresh-install server beta;
  no desktop release, existing-installation migration or server deployment.
- Download the public tarball anonymously and verify it matches the tested
  candidate byte-for-byte: SHA256
  `9d9c6b3e69bdb56cae24c38fceb86ed5074d8b576ffbe4dcff384abd6c4a9f88`.
  With Node 22.18.0 and npm 10.9.3, empty cache and no registry credentials,
  execute the public beta CLI and confirm `1.0.7-beta.5`; independently pack
  the public beta and verify its archive hash and bundled version.
- Prior isolated runtime acceptance covers authenticated health and session
  endpoints. Full managed-service installation and migration acceptance remain
  unperformed; public CLI verification does not establish either boundary.
- Publish explicitly with `--tag beta`. The registry also assigns `latest` to
  this version; two authenticated removal attempts return HTTP 400. Both tags
  still point to the beta. Use explicit `@beta` testing instructions and do not
  describe this publication as a stable release or claim tag cleanup succeeded.

## 2026-09-23 — Unify goal editors and validate local beta.7, build 1210

- Give Codex and Claude the same dedicated goal dialog, completion-condition
  field, progress styling and footer. Open Codex goals directly from the slash
  command and Edit action; keep other thread controls separate. Preserve native
  provider behavior and Codex status, token budget and time limit.
- Commit app source `c0b233346e513c436ce98967789abf09b2b13320` before building
  local 1.0.7-beta.7, build 1210. TypeScript, all 4,801 active app tests,
  production compilation, bundle audit and Developer ID signing pass; five
  existing tests remain skipped.
- Exercise the source UI with native input, production IPC, authenticated HTTP
  and actual providers. Codex retains paused status and both budgets through
  edit/save/reopen, then clears. Claude achieves a short goal and clears/stops
  a second goal. The shared layout fits a narrow light viewport. An initial
  offscreen renderer loss is not reproduced by the successful sequential retry.
- Reject the first local candidate, build 1209, after the actual packaged app
  exposes a keyboard-focus error when opening Goal from thread controls.
  Add a regression that fails before the correction, then personally verify
  build 1210: immediate typing targets the goal field, Escape restores the
  trigger, both providers open the shared dialog, and switching chats does not
  preserve an abandoned Codex draft. No renderer exceptions occur in the final
  packaged check. Close the test app and remove its temporary credential.
- Availability is a local Apple silicon app, signed but not notarized, with
  automatic updates disabled. No upload, installed-app replacement or server
  deployment. This UI correction requires no server update. Keep public build
  reservation 1208 separate from these local candidates; builds 1209 and 1210
  are consumed locally.

## 2026-09-22 — Keep interrupted mail checks out of user history

- Correct Claude mailbox-input ownership proof for stopped and failed runs.
  A recorded interruption does not change a generated instruction into user
  input. Keep the exact input hash, provider identity, source checkpoint,
  unique occurrence and time bounds; assistant replay checks are unchanged.
- Cover existing sanitized imports and first imports, stopped and failed
  terminals, and genuine human quotations. Focused server checks pass.
- Reproduce the leak through authenticated HTTP on an isolated server with a
  persisted provider-transcript fixture. Personally open it in the signed
  desktop package, update only the isolated server to a new advertised version,
  and reopen the already-cached chat. The generated input disappears while the
  identical human quotation and both assistant replies remain. Repeated chat
  switching stays correct; persisted source and event files are unchanged.
- Test transport and history repair are real; the disposable provider transcript
  is synthetic and no provider inference runs. Missing-terminal or unowned
  history is outside this correction. A server update with a new version is
  required to refresh existing desktop caches. No production deployment.

## 2026-09-22 — Validate local desktop beta.5, build 1207

- Build committed app source `92ab2320c1b6b0e41d9cb59fc3887cb3ff90e3ba` as
  1.0.7-beta.5, build 1207. TypeScript, all 4,798 active app tests, production
  compilation, bundle audit and Developer ID signing pass; five tests are
  skipped by the existing suite. Retain the compact Claude thinking correction.
- Personally exercise the exact signed app with native mouse input, production
  IPC and authenticated HTTP/WebSocket transport. With a real history response
  held for eight seconds, a cached chat reaches live 30 milliseconds after the
  click. A new streamed reply arrives before that stale response, remains
  exactly once afterward, and remains after switching away and back.
- No renderer exceptions occur. Close the isolated app and remove its temporary
  credential. Synthetic persisted messages exercise transport and reconciliation,
  not provider inference. The separate server history-repair acceptance above
  uses this unchanged app package.
- Availability is a local Apple silicon app, signed but not notarized, with
  automatic updates disabled. No publication, installed-app replacement or
  production server deployment. The syncing and thinking corrections are
  app-only; the mailbox-input correction requires the server change above.

## 2026-09-22 — Reconnect cached chats without waiting for history

- Open the live connection immediately when switching to a cached chat, while
  the existing history refresh checks imports, metadata, queues and repairs in
  the background. First opens still load their authoritative history page.
- Preserve newer live messages and queue changes when a delayed history reply
  arrives. Reset the stream cursor when server history is replaced, and prevent
  buffered events from the previous log from returning afterward.
- Reproduce the delay in an isolated native desktop app through authenticated
  HTTP and WebSocket transport: an eight-second history response kept the old
  app syncing for eight seconds. With the correction, the cached switch reaches
  live in 28 milliseconds while that response is still pending. A new message
  arrives before the response and remains visible exactly once after refresh
  and switching away and back. No renderer exceptions occur.
- Focused service, transport and store checks, TypeScript and production
  compilation pass. The controlled test uses persisted synthetic messages,
  not provider inference. Package acceptance is recorded separately.
- This correction is app-only and requires no server update.

## 2026-09-22 — Validate local desktop beta.4, build 1206

- Build committed source `230f946912c0cdf4f05da0c87e0f106973c0e5b5` as
  1.0.7-beta.4, build 1206. TypeScript, all 4,794 active app tests, production
  compilation, bundle audit and Developer ID signing pass. The first packaging
  attempt omitted the beta-track environment; correcting that local build
  configuration passes the unchanged suite. Five tests are skipped by the suite.
- Personally exercise a real Claude turn through the isolated native app,
  production IPC and authenticated server: compact thinking, live setting on/off,
  completion collapse with the setting enabled, and retained manual history.
  A 7,206-character received thinking event remains available. Verify long-text
  fixtures and bounded dark/light rendering, including a narrow viewport.
- Open the exact signed package and verify the compact disclosure, full-text
  expansion, native wheel scrolling and settings behavior on completed history.
  The panel is capped at 320 pixels, or 40 percent of the viewport height.
  No renderer exceptions occur; close the isolated test app and remove its
  temporary credential afterward.
- Availability is a local Apple silicon `.app` only, signed but not notarized,
  with automatic updates disabled by the local-build workflow. No publication,
  installed-app replacement or server deployment. This correction needs no
  server update.

## 2026-09-22 — Make Claude thinking compact and optional

- Keep Claude thinking in a single-line disclosure by default. Apply the
  existing thinking visibility setting to active Claude turns as well as Codex;
  completed and stopped turns collapse while retaining manually readable text.
- Bound expanded Claude thinking to a scrollable panel, preserve the user's
  chat font size, and replace the large colored card with subdued styling.
  Update the setting's English and Chinese descriptions.
- Targeted timeline checks, TypeScript and production compilation pass.
  Reproduce the oversized panel in an isolated native app and verify the
  corrected long-text display through production IPC and authenticated HTTP.
  Local package and live-provider acceptance are recorded separately.
- This is an app-only correction. No server update is required.

## 2026-09-22 — Validate unpublished desktop beta.3, build 1205

- Build committed source `4c87d87f28735adedd20295fbb4db4f328c794b1` as
  1.0.7-beta.3, build 1205. All 4,792 app tests, TypeScript and production
  compilation pass. The universal macOS app and installer pass signing,
  notarization, Gatekeeper, package parity, updater checksum and clean-launch
  verification. Both Linux architectures and Windows pass their release
  jobs. Windows first encounters a timeout in an unchanged history-cache
  test; the single retry passes with the same source and unchanged limits.
  All 14 assets and updater checksums are verified. Windows remains unsigned.
- Personally exercise the actual signed app through native mouse and wheel
  input, production IPC and authenticated HTTP against isolated synthetic
  histories. First visits open at latest; returning to an older message in a
  600-turn chat preserves its offset within one pixel. Repeated rapid chat
  switches and scrolling immediately before switching preserve the same row
  and offset. No renderer exceptions occur; the isolated app is closed and
  its temporary credential is removed afterward.
- The server tree is unchanged from the accepted 1.0.7-beta.2 server candidate.
  Scrolling needs no server update. Claude Goals and the history/lifecycle
  changes still require that server candidate; this entry does not record a
  production deployment.
- Keep the desktop candidate local and unpublished, with app updates
  independent of server updates and no automatic npm migration.

## 2026-09-22 — Preserve chat reading positions

- Restore the saved message and pixel offset when returning to a chat. First
  visits and readers already at the bottom still open at the latest message.
- Save the message sequence alongside the existing position. If that message
  has left the in-memory cache, use the existing history-window request to
  reload it before displaying the conversation. Do not save the interim tail.
- Keep user scrolling and explicit navigation in control of delayed restores.
  Empty or failed history requests leave the current history usable; saved
  positions from older apps remain compatible.
- Reproduce the old jump in an isolated native desktop app. Verify rapid chat
  switching and restore the exact message and offset in a 600-turn history
  beyond the cache limit through production IPC and authenticated HTTP.
  Delayed history replies do not override a newer chat selection or wheel
  input. All 4,792 app tests, TypeScript and production compilation pass.
- This is an app-only correction for desktop 1.0.7-beta.3; the prepared server
  remains 1.0.7-beta.2. Package acceptance and availability are recorded
  separately.

## 2026-09-22 — Validate unpublished desktop beta.2, build 1204

- Build committed source `5fb88e8a09e013eff13f37a706de020aa74ca0d9` as
  1.0.7-beta.2, build 1204. All 4,789 app tests pass. Universal macOS signing,
  notarization, clean launch and the stock artifact verifier pass. Windows
  and both Linux architectures pass their release jobs; all 14 assets and
  updater checksums are verified. Windows remains unsigned.
- In the actual signed macOS app, complete a native Claude goal, observe
  Start goal automatically become available without reopening the dialog,
  and send a normal follow-up that appears exactly once. The isolated server
  runs 1.0.7-beta.2; no runtime refresh or renderer reload is used.
- Prepare the signed 1.0.7-beta.2 server package from source `9ae743b`; its
  server tree exactly matches the desktop source. All eight test shards,
  signatures and archive checks pass, with identical runtime files in the npm
  and legacy packages.
- Keep these candidates unpublished while correcting chat-switch reading
  positions in the next desktop beta. No npm publication or production server
  deployment is part of this acceptance.

## 2026-09-22 — Correct goal completion refresh and compaction history

- Keep Claude runtime subscriptions stable when timeline updates replace the
  selected chat's session snapshot. A queued completion refresh now survives,
  so Start goal becomes available when the turn returns to idle. Reproduced
  the failure in packaged build 1202 and verified the correction through the
  real desktop IPC, isolated server and native Claude provider.
  Coalesce immediate shared-chat refreshes with queued event refreshes.
- Recognize Codex compaction output using its native response receipt and
  typed replacement history. Omit the proven summary during the existing
  parsing pass and repair affected imported rows on read. Ordinary assistant
  imports do not gain an additional source-prefix scan, and genuine replies
  with the same text remain visible.
- Verify the affected history through the production HTTP and semantic APIs
  and an isolated native desktop app. The compaction handoff disappears and
  the surrounding genuine replies retain their text and order.
- Preserve beta.1 artifacts as an unpublished candidate. The corrected
  candidate is 1.0.7-beta.2; package acceptance and availability are recorded
  separately.

## 2026-09-22 — Integrate native Claude Goals and repair turn transitions

- Add desktop Claude Goal controls using the installed provider's native
  `/goal` command. Read native goal-status records for active, achieved and
  cleared state; retain completed details without inventing iteration counts.
  Older servers continue normal chat without the new controls.
- Clear a running goal through Claude's native priority command, which also
  stops that turn. Keep the command receipt separate from the interrupted
  result, and retire the exact connection if confirmation times out so a later
  message can start normally.
- Preserve interruption provenance across parallel tool-result branches, so
  native interruption markers do not become ordinary user messages.
- Normalize source-proven native goal commands when reopening history and
  omit native synthetic placeholders and duplicate imported command rows.
- Do not promote a queued message to Starting when Stop is still pending.
  Preserve the queued message and use bounded, exact-run Stop for Claude's
  Send now path.
- Focused provider, runner, queue, transcript and desktop checks pass. The real
  desktop app, production IPC and isolated server complete a native goal,
  clear one during a long-running tool, and complete a normal follow-up. Live
  Send now also completes the replacement turn with an empty queue. Release
  artifacts are recorded separately; this entry does not claim a deployment.

## 2026-09-22 — Publish desktop 1.0.6, build 1201

- Publish the accepted desktop package as stable 1.0.6 in the public source
  repository and desktop release mirror, with the same 14 verified assets.
- Verify public download links, checksum manifests, Stable updater metadata
  and Beta discovery of the stable release. Authenticated release metadata
  checks confirm the source pin after anonymous API requests hit GitHub's
  rate limit. Withdrawn 1.0.4 and 1.0.5 releases remain absent.
- Keep server/npm publication unchanged; stable AgentsServer remains 1.0.3.
  Stop the owned acceptance VMs and forwards after preserving their evidence.

## 2026-09-22 — Validate desktop 1.0.6, build 1201

- Build committed source `564f38a64a9e748f810de64668e860a4c7badcca` as
  desktop 1.0.6, build 1201. macOS signing, notarization, clean launch and the
  stock release verifier pass. Windows and both Linux architectures pass
  their complete release jobs; all 14 release assets and updater checksums
  are verified. Windows remains unsigned.
- In an isolated macOS VM, the unchanged published 1.0.3 and 1.0.6-beta.1
  apps each update through the native updater and automatically relaunch the
  exact accepted package. Saved connections and the respective Stable/Beta
  preferences survive. The original authenticated 0.1.25 server keeps its
  process, identity, credentials, chats and runtime files, with no mutation
  requests during either app replacement.
- The signed package passes native Cancel during checking, download,
  pre-install refresh and the restart delay; Discard, explicit retry and
  channel switching also pass. The app process stays alive and late results
  do not restore the canceled update. These cancellation checks use isolated
  future-version metadata pointing at the accepted ZIP, without handing that
  substituted version to the native installer.
- Native connection recovery retains the authenticated chat socket during an
  injected health failure and restores Online before delayed metadata, even
  during continuous native typing and scrolling. A separate real Claude
  round trip succeeds. The original intermittent socket trigger remains
  unconfirmed. Native send-failure checks also preserve drafts and accepted
  turns without resending, including the Send now queue action.
- Finally, the accepted signed app's restored Install button upgrades the
  isolated original 0.1.25 server to the public, production-signed 1.0.3
  archive through one authenticated update request. All 82 runtime files
  match; the original identity, token, chat and event bytes survive. The app
  reconnects and shows the retained chat and installed/healthy status.
- These are desktop-only artifacts. No npm/server publication or production
  server restart is part of this release acceptance.

## 2026-09-22 — Cancel desktop updates and recover live chat promptly

- Add Cancel during app update preparation/download and Discard after download.
  Discarded updates no longer lock channel selection. Cancellation stops the
  download when supported, invalidates late callbacks and prevents a pending
  restart; native installation handoff remains the final boundary. Normal quit
  does not install a downloaded update. Focused updater and Settings checks
  pass; signed-package cancellation acceptance is recorded separately.
- Keep existing authenticated chat sockets through transient health failures,
  while retaining fresh validation for reconnecting sockets and privileged
  requests. Process health before slow session/job metadata, and allow the
  existing recovery poll during typing or scrolling without adding a poll loop.
- In an isolated native Electron app using real authenticated HTTP/WebSockets,
  an injected health rejection leaves chat sockets open. Successful health
  restores Online before an eight-second delayed chat-list response. Focused
  service/client checks, TypeScript and production compilation pass.
- Prevent failed sends from duplicating text already retyped in the composer,
  preserving current references and attachments. An authoritative live event
  can confirm acceptance when the HTTP reply is lost; the existing success and
  steering behavior then runs without resending the prompt. Focused store and
  Composer checks include lost replies and profile changes. Native UI checks
  use an authenticated protocol fixture with controlled HTTP/WebSocket faults,
  not provider inference.
- These changes address app recovery and draft handling. The original cause of
  the intermittent socket failures remains unconfirmed; bounded native error
  diagnostics preserve evidence for a recurrence. No server deployment or
  desktop publication is recorded by this entry.

## 2026-09-22 — Preserve native connection failure diagnostics

- Record request duration and bounded native socket error codes when desktop
  server requests fail. Exclude credentials, request bodies, query strings and
  exception messages; retain the original error and do not retry mutations.
- Validate focused client tests, TypeScript and production compilation. In an
  isolated native Electron app, real server switching and a Claude send/reply
  succeed; an unavailable local endpoint records `ECONNREFUSED` and the app
  reconnects after switching back to the healthy server.
- This adds diagnostics for intermittent failures. It does not establish the
  cause of a past disconnect or claim that diagnostics alone fix recovery.

## 2026-09-22 — Bound Windows release test concurrency

- Run the Windows release tests with one worker after concurrent disk-heavy
  suites exceeded their existing deadlines on hosted Windows. Settings suites
  that previously completed in about one second took about one minute during
  the affected run.
- Retain every assertion and timeout. Product behavior and other platform
  jobs are unchanged; acceptance requires a fresh complete release build.

## 2026-09-22 — Accept native legacy server update recovery

- Exercise the corrected desktop Settings through real UI interaction, production
  IPC and authenticated HTTP against original 0.1.25 installations with 0755
  and 0750 installation roots. Both install the unchanged, publicly downloaded,
  production-signed 1.0.3 archive through the original server updater.
- “Install when idle” waits while a disposable chat runs, then submits exactly
  one request using the old server's supported fields. Server identity, access
  token and existing chats survive; all 82 shipped runtime files match the
  verified archive. A protocol fixture supplies the busy chat lifecycle; this
  verifies update behavior, not live model inference.
- The 0750 installation is an actual managed Team Hub host. Its original owner,
  team, membership, message, device session, refresh credential and managed host
  binding survive. The existing access token can read the old message and post
  a new one after migration, and the maintenance fence is cleared.
- An installer failure before takeover preserves the old server and Hub data,
  clears its exact maintenance fence, and leaves a usable retry path. The retry
  completes through the native app. A release-check rate limit also leaves the
  incumbent server healthy.
- These are isolated native source-app acceptance runs. Signed desktop package
  replacement and release verification remain separate, pending checks; this
  entry does not record publication or a production server deployment.

## 2026-09-22 — Restore updates for existing servers

- Restore manual server updates in Settings → Updates when the desktop release
  has no bundled server operation, including the app-only 1.0.6 beta.
- Allow older servers with an authenticated update API to update over remote
  connections. Their lack of newer request identity fields no longer removes
  the install action or causes the desktop backend to reject it.
- Preserve the app's existing idle-waiting flow for servers without native
  update scheduling. Send the request format supported by those servers and
  retain connection ownership, authentication and signed package verification.
- Focused settings tests pass, along with update service/client/coordinator
  checks and TypeScript. Native existing-installation acceptance and release
  package verification are recorded separately before publication.

## 2026-09-22 — Give the composer model picker available space

- Remove fixed model/effort chip width caps so the full selection can use the
  available toolbar width. Keep the dropdown arrow and send controls visible,
  and expose the full selection on hover when a narrow pane still truncates it.
- Shorten the custom-provider toolbar label to “Codex · Custom”; retain the
  complete provider name in the menu and accessible button label. English and
  Chinese are covered. No provider selection or server behavior changes.
- Reproduced the clipped model and effort in an isolated native Electron app,
  then verified the complete label at the same width after the change. Exercised
  the actual picker twice through production IPC and authenticated HTTP into an
  isolated 1.0.6-beta.1 server; both effort changes persisted. Checked dark/light,
  narrow layouts, keyboard focus return, and send control visibility.
- Validation: 4,736 desktop tests passed (five existing skips), followed by 221
  focused tests after the compact-label refinement; eight build/license checks,
  TypeScript, and production compilation pass. Synthetic endpoint metadata was
  used; model inference and a release package were not exercised. All isolated
  test processes exited. Availability: source only for a subsequent desktop beta.

## 2026-09-22 — Resolve guided server setup from signed release metadata

- Remove obsolete Stable/Beta installer pins. Local and SSH guided setup now
  discover the selected published channel and verify its immutable signed
  manifest before downloading the exact verified archive.
- Keep release discovery cancellable and report its failure before starting
  an installer. Preserve the existing server channel semantics and check an
  installed server's version before selecting an older Beta.
- Validate focused setup/resolver checks, TypeScript and the production desktop
  compilation. Live public metadata checks select the published releases;
  no server version is inferred from an app-only release.
- Native Electron guided SSH setup completes against a disposable macOS server:
  the production renderer selects published Stable 1.0.3, verifies and installs
  the real archive, reconnects, and displays both saved chats. Server identity,
  access token, saved histories, protected files and release trust key remain
  unchanged. This checks an existing 1.0.3 server with Team Network hosting
  disabled; it does not certify Team Network reactivation or the packaged
  application updater. This source change does not itself publish a release.

## 2026-09-22 — Publish app-only 1.0.6-beta.1 (1196)

- Publish the accepted artifacts unchanged to the [public beta release](https://github.com/ZhengyiLuo/AgentsDock/releases/tag/v1.0.6-beta.1)
  and [legacy desktop mirror](https://github.com/ZhengyiLuo/AgentsDock-Releases/releases/tag/v1.0.6-beta.1).
  Both are prereleases with exactly 14 desktop assets and no server descriptor.
- Independent anonymous readback verifies all eight beta platform feeds select
  1.0.6-beta.1, both direct macOS DMG links respond successfully, and both public
  checksum manifests match the accepted seal. All stable feeds and latest stable
  release APIs remain on 1.0.3.
- Server and npm publication remain held. Neither a 1.0.6-beta.1 standalone
  server release nor an npm version is published. Existing server installations
  are not updated by this desktop beta.
- Users on withdrawn app versions 1.0.4/1.0.5 should install the direct desktop
  download once to replace the old updater. The native 1.0.3 update journey and
  1.0.5 direct-install recovery are recorded in the acceptance entry below.

## 2026-09-22 — Accept app-only 1.0.6-beta.1 (1196)

- Accepted product source: `d36e1637e6fa6a7cec1b11cf7ffbaf70cff8e17e`.
  This desktop beta includes no server descriptor or enrollment and cannot
  resume an older app's saved server-update plan. Server publication remains
  held; this release does not install the server-side repairs below.
- Desktop validation passes 4,736 tests with five existing skips, TypeScript,
  production compilation and native platform package verification. The universal
  macOS ZIP and DMG pass Developer ID signing, notarization, Gatekeeper, updater
  metadata, checksum, package parity and clean-launch checks. Windows remains
  explicitly unsigned. The 14-file app-only checksum seal is
  `f7bdb3ebc6cb503839b69c5855b41812d1ce6b36b895e3115b1508db7a11e547`.
- The unchanged published 1.0.3 app opts into Beta, downloads the exact signed
  package, installs through its native updater and automatically relaunches as
  build 1196. Its existing server remains on 1.0.3 with the same process; a
  legacy 0755 root and retained rollback journal are unchanged.
- The unchanged 1.0.5 app reproduces its old pre-install failure because this
  app-only release has no server descriptor. Direct replacement with the same
  signed app then succeeds, preserving its profile and the old update-plan file
  byte for byte. Users on withdrawn 1.0.4/1.0.5 should use the direct installer.
  This is not a claim that their old in-app updater was retroactively repaired.
- Both native macOS journeys preserve server/runtime files, chats, provider and
  authority files, Hub records, bootstrap claims and existing mTLS access. No
  update, restart or stop request reaches either server. A real server-owned
  terminal worker keeps its process identity and advancing heartbeat through
  app replacement. This continuity test does not exercise model inference.
- Tests use disposable native machines and private feed routing of the exact
  production-signed bytes. Stable does not offer the beta without opt-in. This
  entry accepts the unchanged artifacts before upload; publication and public
  feed readback follow separately.

## 2026-09-22 — Prepare app-only 1.0.6-beta.1; hold the server release

- Prepare an opt-in desktop beta with independent app updates and clearer
  Settings. The server release is held; no npm or standalone server release is
  included. Previously prepared paired desktop artifacts are superseded.
- An app without a bundled server target does not resume a saved server-update
  plan, contact the update endpoint, or change that saved plan. App updates can
  proceed independently of existing servers; server repairs below remain
  unreleased and are not claimed as installed by this app-only beta.
- Preserve stable 1.0.3 availability. Verify unchanged 1.0.3 and withdrawn 1.0.5
  clients against the signed app-only beta, retaining server processes, versions,
  chats and Hub data. Verify direct desktop replacement for any old updater
  whose installed gate prevents self-update.
- The app-only behavior passes 316 focused desktop tests and TypeScript checks,
  including pending, failed, newer and unreadable saved update plans. This entry
  records preparation only; native package acceptance is pending.

## 2026-09-22 — Repair update blocking after withdrawing 1.0.4 and 1.0.5

- Post-withdrawal checks found both public desktop repositories and the
  standalone server's stable feed back on 1.0.3. The 1.0.4/1.0.5 release pages
  and checked assets were unavailable, as were the public npm package metadata
  and tarballs. Withdrawal does not repair already installed apps or servers.
  Publication entries below describe the earlier state, not a current upgrade
  recommendation.
- Remove the desktop installation gate entirely: a saved server's release
  channel, API version, connectivity or failed update cannot prevent an app
  update. After relaunch, the installed app's signed bundle selects the server
  target. Ignore stale pre-install plans and an older target's failed operation
  receipt; keep already newer servers unchanged.
  Old apps that still contain the gate may need the corrected direct desktop
  installer once. Publishing npm alone cannot change their updater code.
- Remove the artificial Stable/Beta server-channel veto. For older servers that
  return that exact rejection, use their existing authenticated update route
  with the bundled target. Other authentication and update failures retain their
  own handling. Avoid a redundant latest-release lookup for a known target.
- Fix the Team Hub operation collision: a new update's maintenance fence could
  be confused with an older retained rollback journal. Recover the old terminal
  operation, then continue the same new request automatically. Clean up only
  the unstarted request when recovery cannot proceed. An already-absent restore
  receipt no longer requires stopping the live Hub to acquire its runtime lease.
- Stop the release-check request burst. Share simultaneous checks, cache recent
  results, respect GitHub's retry interval and remove the multi-page HTML
  fallback after HTTP 429. Show the cause and retry delay. Opening Settings no
  longer triggers app release discovery or unrelated server release checks.
- Simplify paired Updates to one app update control, per-server progress and a
  Retry action. Show concrete causes and keep protocol diagnostics expandable.
  Remove duplicate server-channel/recovery controls from paired releases. A
  downloaded withdrawn app is no longer offered when a fresh feed response
  confirms a different release.
- Validation: 196 focused server tests and 103 Hub/activation tests pass, along
  with installer succession and rollback regressions. The collision regression
  fails against the withdrawn source. A real native macOS 1.0.3 update API run
  starts with a 0755 installation root, retained terminal rollback journal and
  newly admitted Hub operation; it completes both services without a remaining
  journal or fence. All 107 candidate runtime files match; existing Codex/Claude
  histories, authority files, synthetic credentials, Hub records and bootstrap
  claims survive. An existing mTLS peer reads old data and writes/reads new data.
- The native migration uses a private QA feed/signing key and a captured source
  candidate retaining its 1.0.5 test label. The later retry-delay wording change
  passes nine targeted request tests separately. The 266 focused desktop tests,
  TypeScript and production compilation cover the installation gate removal.
  Native desktop UI checks exercise production IPC and authenticated HTTP, scoped Retry and
  readable dark/narrow layouts with no implicit release checks; that fixture
  deliberately rejects its test signing key and does not claim an app binary
  replacement or successful server migration. A subsequent change preserves
  the server's concrete failure text in two coordinator branches; all 55
  coordinator tests, TypeScript and production compilation pass afterward.
- This records source repair, not a new release. No live service was restarted
  or redeployed. A corrected signed desktop package still needs its complete
  update/relaunch and publication validation before shipping.

## 2026-09-22 — Publish coordinated AgentsDock 1.0.5 (1194)

- Publish the accepted build unchanged to the [public desktop release](https://github.com/ZhengyiLuo/AgentsDock/releases/tag/v1.0.5)
  and legacy desktop mirror. Both stable update feeds now offer 1.0.5.
- Publish `@agentsdock/server@1.0.5` through trusted npm publishing and verify
  that `latest` resolves to 1.0.5 and the public tarball matches the signed
  descriptor. Publish the [standalone server bridge](https://github.com/ZhengyiLuo/AgentsServer/releases/tag/v1.0.5)
  and verify its production signature, archive and 107-file runtime parity.
- Independently read both public desktop feeds without credentials. All four
  platform feeds, checksums and signed server descriptors match the accepted
  seal; all 16 uploaded asset digests match. The public release page and macOS
  ZIP/DMG download links respond successfully.
- Native acceptance covers the unchanged stable 1.0.3 app's single-update
  migration and recovery from a genuine failed 1.0.4 migration. Already
  stranded servers require `npx @agentsdock/server@1.0.5 recover` on the server
  computer, followed by Settings → Updates → Retry server update.
- The 1.0.4 desktop release remains withdrawn. npm 1.0.4 still exists as an
  immutable version, but is no longer `latest`; no npm deprecation is claimed.

## 2026-09-22 — Accept direct AgentsDock 1.0.5 (1194)

- Accepted product source: `321448f7ac5f7ae393a61660ec6168eedc9791b0`.
  The paired standalone server is `144d2eaf1690185d6fae1386f793ced32ce18e3f`;
  its runtime matches the signed npm package byte for byte across 107 files.
- Desktop validation passes 4,699 tests with five existing skips. All eight
  server test shards pass (5,031 cases), together with focused CLI, packaging
  and publication checks. Windows and Linux x64/ARM64 builds pass their native
  verification jobs. The universal macOS app and DMG pass Developer ID,
  notarization, Gatekeeper, exact updater metadata, checksums and launch checks.
  Windows installers remain unsigned.
- The unchanged published 1.0.3 app updates to signed 1.0.5/build 1194 through
  the real updater, automatically relaunches, and migrates an existing 1.0.3
  server with a `0755` installation root. One app-update click completes both;
  no separate server-update action is used.
- The unchanged published 1.0.4 app updates and automatically relaunches into
  the same accepted package with a genuinely stranded 1.0.4 server migration.
  Settings displays the pinned recovery command and copies it correctly. The
  exact npm package recovers the missing-stage transaction without restarting
  the incumbent. One native Retry click then completes the paired update, and
  reopening Settings shows both components current with no recovery prompt.
- Both paths retain server identity, Codex and Claude histories, authority and
  credential files, Hub data and bootstrap claims. An existing mutual-TLS peer
  can read retained data and exchange a new message. Both use original
  production signatures and the unchanged trust key. Private feed routing
  supplies the exact signed bytes; public registry/feed verification follows
  publication. An interrupted VM/VNC harness attempt is retained separately
  and is not used as upgrade evidence.
- Sixteen verified release assets are sealed with matching platform feeds and
  the same signed server descriptor. This entry accepts build 1194 before
  upload; publication is performed separately using these exact bytes.

## 2026-09-22 — Prepare coordinated 1.0.5 correction

- Remove the withdrawn 1.0.4 legacy desktop mirror after preserving and
  checksum-verifying its artifacts. Both public stable feeds remain on 1.0.3
  until replacement validation finishes. npm 1.0.4 remains published.
- Include the dismissible error notification, isolated concurrent downloads,
  consumed follow-up recovery and merged sidebar version-label removal.
- Reproduce the exact published installer failure against an existing 1.0.3
  server with a `0755` installation root. The old API stays in `installing`
  and rejects a new update before downloading its installer. Add an explicit
  `npx @agentsdock/server@1.0.5 recover` command for this stranded state;
  conditional Settings guidance names the server computer and copies the
  pinned command. Retry remains scoped to that server profile.
- Verify the packaged recovery command on the untouched failed installation:
  retire only its exact unfinished transaction, preserving the running process,
  server identity, trust key and Hub database inode. Recovery cannot start a
  native recovery owner or restart a service, including a phase-change race.
  Then complete ordinary authenticated API migration to paired 1.0.5 services
  and verify all 107 installed runtime files, existing histories, credentials,
  authority and an existing mutual-TLS peer's new write/read. Candidate delivery
  uses an isolated QA signing key; final production artifacts remain a gate.
- Real Codex steering, test-server restart and a fresh desktop service/window
  retain an empty consumed queue, authenticated helper access and the visible
  final answer. Native download overlap and failure-isolation checks pass.
- Focused Settings/coordinator tests (88), native history tests (30), and
  TypeScript checks pass. Correct test-only stale mailbox-text assumptions,
  macOS temporary-path canonicalization and fixture garbage collection before
  timed websocket assertions, without changing production deadlines.
- This entry records source validation, not release acceptance. Final signed
  package and desktop update/relaunch checks are required before publication.

## 2026-09-21 — Withdraw 1.0.4 from stable feeds and repair migration and queue recovery

- Withdraw the canonical desktop and standalone server 1.0.4 releases to
  drafts. Return both stable desktop feeds to 1.0.3. The immutable legacy
  mirror is marked withdrawn and prerelease; its direct downloads remain
  available pending removal. The npm package remains published while registry
  authentication for the withdrawal warning is pending. These actions do not
  change already installed applications or servers.
- Correct the acceptance scope recorded below: the previous macOS 1.0.3
  migration fixture created its installation under umask `077`, so its root
  was already private. It missed the normal existing-installation case with a
  `0755` root. Release validation now explicitly requires legacy `0755` and
  `0750` permissions, early failure with a live incumbent, and recovery after
  an older failed installer has already deleted its candidate stage.
- Tighten a safely owned legacy installation root to `0700` under its exact
  installation lock. When activation fails before taking over services,
  preserve the running incumbent and Hub database, retire only the owned
  maintenance fence, and verify authenticated health before retiring recovery
  state. Keep the strict ownership, original-link, configuration and native
  recovery-service checks intact. Preserve the staged runtime while an
  activation journal remains unfinished, including the crash window before
  the installer receives its transaction ID; clean it only after settlement.
- Consume durably acknowledged native-goal follow-ups during server queue
  recovery and in the desktop's persisted queue cache. Retain uncertain
  deliveries as paused and preserve ordinary queued work. A consumed follow-up
  must not become a new request after a server restart or chat reopening.
- Reproduce the queue failure through an isolated native offscreen Electron
  app and real server transport, then verify no replay after the fix. A separate
  genuine Codex goal accepts a typed follow-up, survives server restart without
  replay, and resumes the same provider thread with a successful authenticated
  helper read and visible final answer. Recreate the desktop service and reopen
  the window to check persisted state. Controlled-provider and genuine-provider
  evidence remain separate.
- Verify the frozen installer source on disposable native macOS installations:
  reproduce the published failure, recover its stranded transaction without a
  retained candidate, inject a fresh failure before service takeover, and retry
  the same archive successfully. Preserve the incumbent PID and Hub database
  inode during rollback, then verify paired services, all 107 installed runtime
  files, existing identity/history/authority, and an existing mutual-TLS peer's
  new write and read. This lane uses authenticated server APIs and native
  services with a guest-only QA signing key; it does not establish final
  production-signature or app update UI acceptance. A subsequent stage-retention
  guard passes its focused cleanup regressions; its additional native failure
  window remains under validation.
- Availability: source corrections under validation. This entry does not
  accept a replacement release; final signed-package migration and desktop
  relaunch acceptance remain required before publication.

## 2026-09-21 — Keep download errors dismissible and isolate simultaneous saves

- Wrap long error paths within the window and reserve a fixed-size close
  button with a translated label and tooltip. Confirm native mouse, Tab/Enter
  and Tab/Space dismissal, including repeated errors, in dark and light themes
  at wide and narrow window sizes. The isolated offscreen app reproduces the
  previous offscreen close button and passes all six corrected layout cases.
- Give each download an exclusively created UUID temporary file. Concurrent
  saves to the same destination no longer share a partial file, and an
  interrupted save cannot remove another save's in-progress file. Real
  AppService/filesystem regressions fail with the previous implementation and
  pass with the correction, including failure isolation and complete output.
- Validation: 384 service/file-action tests, 49 app/design-system tests, and
  TypeScript checks pass. Production compilation and the toast's native
  offscreen interaction pass. Error text in the toast check is a fixture;
  separate native download/HTTP and final packaged acceptance remain pending.
- Availability: source only. The sidebar version-label removal from PR #34
  is included in the coordinated correction; no replacement is published yet.

## 2026-09-21 — Publish stable 1.0.4 build 1193

- Publish and verify `@agentsdock/server@1.0.4` on npm `latest`, retaining
  `1.0.4-beta.12` on `beta`. Verify the exact signed tarball's size, SHA-256 and
  SHA-512 integrity from the public registry. Publish and verify the matching
  signed standalone bridge, then the unchanged desktop build 1193 on both
  existing stable feeds. Keep accepted product source
  `b3bf411c8feea751285a7c9b4e397ec526a61e30`, standalone export
  `8664a9399f2c282aea7a113771506e2528e6d559`, descriptor and artifact seal unchanged.
- Preserve publication run `35681737578`, which stopped at private candidate
  draft lookup before npm preflight, OIDC authentication or publication. Correct
  only the publish job's draft-access permission and explicit workflow/source
  pins. The publishing revision is
  `52ff3e3a0ee33b1c7106d5924fcf31bfdb01debf`; the accepted product source remains
  b3bf411. No product rebuild or repacking accompanies this workflow correction.
- In corrected run `35682355490`, attempt 1 successfully publishes through npm
  OIDC, then fails immediate readback while npm processes the package. Preserve
  that result. Once independent exact-byte registry verification passes,
  attempt 2 completes with preflight `publish=false`, npm publication skipped,
  and the unchanged public verifier passing. The package is published once.
- Add a follow-up visibility wait for future runs: retry only the unchanged
  read-only registry verifier, at most 61 attempts with 10-second gaps and an
  11-minute step limit. Exhaustion still fails; signature, source, archive and
  channel requirements remain intact. This polling correction changes no
  accepted product artifact and was not used by the successful publication run.
  The follow-up workflow commits are `5f1b503` and `2281c02`.
- npm provenance identifies the publishing workflow revision. The original
  signed descriptor and unchanged tarball identify the accepted product source.
  Check the public attestation's subject digest and workflow/run identity;
  independent full Sigstore trust-chain verification is outside this receipt.
- Existing stable 1.0.3 users retain one app-update action, followed by automatic
  server migration. Initial migration and execution replacement wait for idle.
  macOS is signed and notarized; Windows installers remain unsigned.

## 2026-09-21 — Accept stable 1.0.4 build 1193

- Accept desktop build 1193 from source
  `b3bf411c8feea751285a7c9b4e397ec526a61e30`, paired with standalone export
  `8664a9399f2c282aea7a113771506e2528e6d559` and signed npm descriptor SHA-256
  `851055682343f7cd97cca1f0341f0b18ffb8ce841807bd0a18409c9300855618`.
  Verify both original signatures and all 107 runtime files and modes against
  the committed source and both server archives.
- Canonical and standalone server suites each pass 4,995 tests with six existing
  skips across all eight shards. Native workflow `35679650749` passes Linux x64
  and arm64 with 4,656 tests and five skips each, and Windows x64 with 4,620 tests
  and 11 skips; all stock package verifiers pass. Windows remains unsigned.
  The universal Mac release passes 4,656 tests with five skips on its first
  attempt using four workers and unchanged timeouts, then type checking,
  compilation, Developer ID signing, notarization and stapling, Gatekeeper,
  mounted-DMG/ZIP parity, updater metadata checks and isolated startup.
- Verify the exact signed candidate on native macOS and Linux, including a
  positively observed candidate worker, induced activation failure, automatic
  rollback and explicit retry of the same archive. Begin from a preserved dead
  candidate receipt, retain it through rollback, and verify retry without manual
  cleanup. Preserve identity, credentials, chats/events, synthetic provider and
  terminal credential/configuration files, Hub authority/messages and an existing
  mutual-TLS peer; authenticate preserved content and new peer reads/writes.
  Installed permissions follow the signed installer, including its Linux
  `agent_server.py` normalization from mode `0644` to `0755`.
- The macOS native server gate starts with the original signed
  `0.1.26-beta.29` runtime and explicitly selects Stable for this test. It accepts
  that native migration route, including rollback and retry; it does not promote
  beta users automatically or establish every historical desktop/feed path.
  The Linux gate starts with the original stable 1.0.3 managed server.
- Verify one actual Update action in the unchanged stable 1.0.3 desktop with
  its genuine 1.0.3 server. The signed app replaces and relaunches itself, then
  migrates the server automatically. Both components reach 1.0.4, admission is
  released, and populated data and the existing peer remain usable.
- Verify a separate archive-only HTTP 503 failure before the old server stops.
  Its PID and boot identity remain unchanged. Normal health callbacks observe
  the failed operation despite absent legacy health progress; opening and
  reopening recovery preserves the failure. One explicit coordinated Retry
  succeeds with Advanced recovery continuously open, updating both status rows
  without Check or reopening Settings.
- Deliver these exact signed packages through an isolated HTTPS discovery
  fixture. After native app relaunch drops process-only TLS overrides, a feed
  check exposes the fixture certificate boundary. These results do not establish
  public feed propagation, which remains a separate publication check.
- Retain earlier real Codex/Claude gateway-loss evidence separately: the eight
  tested execution/provider modules are byte-identical, but these migration
  checks make no new model calls. Earlier process-loss/reboot and fresh-install
  proofs retain their original source scope. Execution replacement waits for
  idle; simultaneous execution generations and live-turn survival through
  execution-process death or reboot are not claimed.
- Seal the 16 distribution assets with SHA256SUMS SHA-256
  `e945a6bf07d256e517291774188f282260ee4ce83c0c7c82371b86b118443b89`.
  Availability: published and verified, with the exact accepted artifacts
  unchanged. Verify npm `latest`, then the signed standalone bridge, before
  exposing both existing stable desktop feeds, as recorded above.

## 2026-09-21 — Correct retry after a failed split-runtime migration

- Classify the installed runtime before authorizing shutdown or seeding recovery.
  After a verified rollback to the original server, a candidate's leftover
  process receipt is accepted as stale only under its private worker lock,
  with a conclusively absent process and matching authenticated legacy health.
  Preserve the receipt and all existing native identity, idle and update-owner
  checks; never send credentials to the stale callback endpoint.
- Acquire the installer's authenticated legacy proof when no split execution
  layout is installed, including after rollback leaves a dead worker receipt.
  The native failure test exposed this separate shell-path omission before
  shutdown; retain the Python classifier and its ownership checks.
- Pass 62 focused activation, recovery-intent, transaction and management tests,
  including a real process lease followed by abrupt process death, rollback,
  and a new admitted retry. Exercise the actual installer shell function feeding
  both Python admission checks. Cover active or malformed receipts, held or unsafe
  locks, changed ownership and published-layout races.
- Correct an asynchronous Team Network test to await the recovered host-address
  control independently of bulletin loading. The 119 related renderer tests and
  type checking pass; product behavior is unchanged by this test correction.
- Availability: source corrections awaiting official signing and fresh native
  macOS/Linux rollback-retry acceptance. Build 1192 remains unpublished and is
  retained only as preparatory test evidence.

## 2026-09-21 — Correct stable migration recovery found by native testing

- Keep expanded server recovery in sync with the active server's coordinated
  update, boot and version changes. Refresh only authoritative status; preserve
  the original failure while a refresh is pending or unavailable, without
  implicitly checking for a new release.
- Accept the additional command-display quoting used by newer tmux versions
  when proving an older macOS updater's ownership. Decode at most one extra
  serialization layer, then retain exact kernel argument, executable, ancestry,
  operation and authenticated idle checks before stopping the old service.
- Five renderer regressions fail before the fix; 285 related tests and type
  checking pass afterward. The real private tmux launch regression reproduces
  the old proof failure on tmux 3.7 and passes with the correction. All 23 helper
  tests pass on the native framework-Python host; the release interpreter and
  separate native guest pass with one framework-specific skip.
- Availability: committed corrections awaiting a new signed candidate and its
  packaged migration, failure/retry and rollback acceptance. No stable 1.0.4
  release is published from the superseded candidate.

## 2026-09-21 — Prepare the stable coordinated-update bridge

- Target the existing stable 1.0.3 app and managed server. The user keeps one
  app-update action; the updated app requests the matching server automatically,
  with npm handled by the managed updater. Retain both old stable download
  channels and the actual app version in About.
- Reproduce an older macOS migration rejection through the unchanged published
  app and an original signed beta.29 server. Verify that its original process,
  runtime, identity, chats, credentials, Hub data and peer connection survive.
  Add a read-only native ownership proof for old updaters without a recorded
  process ID, including the exact Homebrew Python framework launcher mapping.
  Retain all existing authenticated identity, idle and service ownership checks.
- Fix the reproduced stale Updating row for legacy servers that omit update
  progress from health. Observe an owned active operation through existing
  health callbacks, and stop when it pauses. Preserve a failed status when
  opening recovery; checking again remains an explicit action.
- Validate the focused coordinator and renderer regressions, TypeScript and
  production compilation. Native process/tmux proof tests cover ordinary and
  framework Python. Isolate inherited Hub configuration in four installer test
  fixtures after reproducing their failures on unchanged published source.
- Availability: source candidate. Exact signed stable package, native stable
  1.0.3 upgrade, failure/rollback, and public distribution acceptance remain
  required before release. Beta.12 publication is not stable rollout acceptance.

## 2026-09-21 — Clarify the bridge to npm updates

- Document the first coordinated release as a bridge delivered through the
  existing desktop feeds and signed standalone server updater. Existing managed
  users update the app; they do not run the fresh npm installer over their data.
- Separate the accepted beta.8-app/beta.9-server journey from older unsupported
  installations, pre-1.0 feed migrations and custom-path macOS prerequisites.
  Preserve stable/beta channels and retain legacy downloads during transition.
- Correct the migration guide and beta.12 release notes to reflect publication.
  Check the instructions against the shipped coordinator, updater, original
  one-click acceptance and public-distribution verification. No runtime or
  released artifact changes accompany this documentation update.
- Replay the released beta.29 updater contract in an isolated fixture. Its
  macOS runner lacks the new installer's admitted ownership proof, and its
  latest-only selection prevents using the old API to pin an intermediate
  release. The Linux managed-update environment passes this admission check;
  neither result establishes a complete native beta.29 migration. Keep that
  older starting point outside the accepted automatic-migration claim.

## 2026-09-21 — Publish coordinated desktop/server beta.12

- Publish direct desktop `1.0.4-beta.12` build `1189` on the public AgentsDock
  repository and its compatibility release mirror, with the accepted artifacts
  from source `2741c05a0772849f6da82f944789060b77ecb91d` unchanged.
- Publish `@agentsdock/server@1.0.4-beta.12` to the npm beta channel and the
  signed standalone migration bridge to AgentsServer. Verify the public npm
  archive against its signed size, SHA-256 and SHA-512 integrity, then verify
  all 106 runtime files and modes against the public legacy archive before
  exposing either desktop release. Both desktop mirrors retain the accepted
  checksum manifest and signed paired-server descriptor.
- Configure npm trusted publishing for the public repository's protected
  `server-npm-publish.yml` workflow and `npm-release` environment. Existing
  installations retain the signed legacy migration path; the packaged app
  requests its matching server automatically after updating.
- macOS is signed and notarized; Windows remains unsigned. Initial migration
  and execution-runtime replacement wait for idle. Running native goals on old
  servers can retain execution ownership between replies, so a final reply
  alone does not guarantee an idle migration window.

## 2026-09-21 — Accepted desktop beta.12 build 1189 candidate

- Accept the direct desktop 1.0.4-beta.12 build 1189 from committed source
  `2741c05a0772849f6da82f944789060b77ecb91d`. Native workflow
  `35661716190` passes Linux x64, Linux arm64 and Windows x64 build and package
  verification. Windows remains unsigned. The local universal Mac release
  passes 4,646 tests, type checking, compilation, Developer ID signing, Apple
  notarization and stapling, Gatekeeper, mounted-DMG/ZIP parity, updater metadata
  and blockmap checks, and an isolated startup. Five existing tests are skipped.
- Retain all release checks. Fix two asynchronous UI tests to wait for their
  rendered result or effect callback, compare signing keys independently of
  checkout line endings, and cap release test concurrency at four workers.
- Bind the app to signed npm descriptor SHA-256
  `18a4bc7c54dc749b93235bda4e0c3247123e03d85d7b2e2dc525087b7014b5b5`.
  The npm archive is byte-identical to the server candidate that passed all
  eight CI shards (4,971 cases), real Codex and Claude foreground/subagent
  gateway-loss checks, and native Linux/macOS migration and recovery checks.
  Both signed distributions contain the same 106 runtime files and modes.
- Verify the production-signed legacy archive with the original trust key on
  native Linux and macOS. Preserve identity, credentials and saved state through
  forward migration, updater/installer loss and automatic rollback. An abrupt
  macOS VM power loss at the durable activation boundary recovers automatically
  after reboot without an HTTP recovery trigger or manual repair.
- Verify one real update click in the unchanged published beta.8 app: Squirrel
  replaces it with the exact build 1189 ZIP and relaunches it automatically.
  The new packaged coordinator migrates the genuine beta.9 server to beta.12
  without a separate server-update click. Check the installed signature,
  executable, application archive and descriptor against the accepted package;
  retain the same saved profile, server identity and credential, with both
  components current and execution admission released. Discovery uses a private
  HTTPS fixture; public release propagation remains a separate publication check.
- Close the populated-data acceptance gap before publication. A genuine Linux
  beta.9 Hub host survives an interrupted signed upgrade, automatic rollback and
  retry with its saved chat/events, Hub records, approved peer, keys, provider
  paths and credential files preserved. A separate joined-server migration keeps
  its active mutual-TLS connection and content access without pairing again.
  The Mac host migration preserves both Codex and Claude histories, Hub messages,
  board content and peer authority; existing peer credentials authenticate saved
  reads and new writes. Provider credential contents are synthetic preservation
  fixtures, while Hub/peer authentication runs against the actual native services.
  Verify retired bootstrap authority remains retired; a revoked proof file is
  not required to survive snapshot recovery. These checks need no product edits.
- This records accepted build artifacts before desktop upload. Public publication
  and the live Studio upgrade are still pending. Execution-runtime replacement
  waits for idle; simultaneous execution generations are not claimed.

## 2026-09-21 — Prepare updates during work and recover interrupted activation

- Stage and verify server dependencies while agents continue working. Preserve
  the existing pending-update protocol for older clients, then acquire the exact
  idle execution hold before activating the prepared candidate.
- Extend the existing installer transaction to both native services, retaining
  configuration, previous runtime and state recovery. Bind automatic recovery
  to the admitted candidate and journal. Register an independent native recovery
  job before stopping the main services, so recovery also runs while the app
  cannot connect. Join that owner through the existing update action. Keep
  incomplete recovery fenced and distinguish verified rollback from successful
  installation.
- Require both component versions and released execution admission before
  reporting completion. Exercise the coordinator and existing updater endpoints,
  exact transaction recovery, failed launch, stale ownership and rollback results.
- Verify one real Codex turn and one real Claude turn while actual dependency
  preparation and receipt validation run. Each original foreground command and
  provider stays alive and completes exactly once, with ordered event delivery;
  execution admission remains open. These isolated tests do not activate an
  installed release or establish signed delivery acceptance.
- Real fresh installations and migration from the released legacy updater have
  passed on disposable Linux systemd and macOS launchd hosts. A Linux fault test
  kills the updater and installer after service shutdown, then verifies that the
  independent native owner restores the previous installation and reports a
  failed, retryable update without an HTTP trigger. Native testing exposed and
  fixed directory permissions, generated-cache validation and recovery ownership.
- Repeat native acceptance with credentials pinned to the connected process
  before transmission and runtime durability checked before service shutdown.
  An abrupt macOS VM shutdown during activation restores the previous release
  automatically after reboot, retaining identity, credentials and saved state.
  Correct enablement parsing for both launchd output formats found during testing.
- Exercise the production renderer, preload, native transport and coordinator in
  an isolated offscreen Electron app against an installed Linux server. Add and
  authenticate it through the UI, request the signed npm candidate, and verify
  automatic reconnection, both updated components, released admission and the
  Up to date result. Registry, signing key, version enrollment and credential
  storage are controlled QA boundaries; no app binary replacement is asserted.
- Repeat a genuine beta.9 migration after a prior rollback, then abruptly stop
  the Linux VM after the old service is disabled. After reboot, the independent
  systemd owner automatically restores beta.9, retains identity, credentials and
  saved state, and retires its recovery job without an HTTP recovery trigger.
  Cover carried-over legacy intent and pre-arm retry failures with regressions.
- Fix the Linux lock-inode reuse and closed-transport races exposed by the full
  CI suite; rerun their regressions on both Linux and macOS. Final signed-package
  acceptance remains pending. These results do not establish simultaneous
  execution generations. No release has been published or deployed by this entry.

## 2026-09-21 — Verify both server components before update completion

- Keep a coordinated update incomplete until both the gateway and execution
  runtime report the paired release. Reject inconsistent component health,
  retain failed-operation recovery, and observe gateway changes independently
  of the execution process's boot identity. Existing single-process servers
  retain their compatibility path.
- Pass focused coordinator, update and restart settings regressions, TypeScript
  checking and production compilation. Exercise the current production renderer,
  preload, service, native transport and coordinator in an isolated offscreen
  Electron window against real worker and gateway processes from the committed
  execution foundation, with controlled release version files and a QA signing
  key. Add and authenticate the isolated server through the UI, open Updates,
  verify the incomplete result, replace only the gateway, and explicitly refresh.
  Verify the same worker and server boot, both current component versions and
  the resulting Up to date row. All owned processes exit and no model turn runs.
- The QA harness substitutes credential storage and release enrollment. This
  establishes component-status handling, not installed migration, app binary
  replacement, automatic reconnect-only behavior or production signing. The
  installer and runtime migration integration remains in development; this
  change is source only and no release has been accepted or deployed.

## 2026-09-21 — Persistent execution foundation (source only)

- Separate the public gateway from the process owning chats, provider transports,
  pending approvals and tool execution. Preserve authenticated request semantics,
  event ordering and private provider callbacks during gateway replacement.
- Give gateway and execution independent process/release identities. Keep the
  actual execution version visible while an older runtime remains active.
  Retirement requires an idle worker and a durable admission hold; an API
  restart does not close provider managers or cancel accepted commands.
- Complete one disposable real turn each with Codex and Claude. Their foreground
  tools survive both graceful and forced gateway termination, then the original
  turns complete without duplicate execution. Reconnected WebSockets receive
  the complete ordered event sequence. Check both CLI logins remain valid.
- Verify separate native subagent runs for both providers: one child continues
  through both gateway replacement modes and completes its tool once. Claude's
  unanswered tool approval retains its request identity through another restart
  and resolves once after reconnect.
- Lock chat state before loading it or sweeping provider children, across both
  maintained entry points. Test both startup orders with actual processes: a
  competing server is refused while the incumbent and its registered controlled
  child remain intact. Retain ownership through shutdown stragglers.
- Start a copied production runtime through a real pending activation journal.
  Verify recovered queued turns and due jobs reach their admission checks and
  remain deferred, with no provider launch. Reject an incorrect release of the
  admission hold; permit a normal zero-turn mutation after the exact release.
- Add transport, admission, recovery, controlled subprocess and production
  application regressions. Verify existing managed-service proof and pending
  update admission behavior in isolated state. Package the seven execution modules
  in both server distributions and retain explicit single-service installer
  protection for experimental split installations.
- Exercise real launchd and user systemd replacement with controlled application
  and child-process fixtures: gateway upgrade, failed gateway rollback, busy
  worker refusal and exactly one approved side effect. Retain the worker and
  chat identities. Fix systemd working-directory rendering and exact file-mode
  restoration exposed by these native tests; restore the disposable baseline.
- Exercise the existing built desktop through an isolated offscreen Electron
  window with production renderer, preload, IPC and server transport. Connect a
  server, create a Claude chat without a turn, navigate owned history and use
  explicit reconnect after both gateway replacements. Keep selected chat and
  final text. Credential storage is substituted in this QA harness; this does
  not establish automatic reconnect-only or packaged-feature-build acceptance.
- These changes do not yet enable rolling execution generations or the normal
  npm/app migration path. The application routes still live in the retained
  execution process. Native service fixtures and desktop checks do not establish
  production state/Team Hub migration. No release build is accepted, published
  or deployed by this entry.
  See [the implementation boundary](PERSISTENT_EXECUTION.md).

## 2026-09-21 — Integrate completed desktop work into main

- Merge the completed desktop branch through `8d7745d` with main `33f9355`,
  including the Side chat popup, copy and scroll behavior, provider settings,
  reasoning controls, Claude subagent visibility and live synchronization fix.
- Retain newer main changes for analytics privacy, optimistic send feedback,
  shared-chat recovery, artifact-open errors, media layout and release workflows.
  Combine live reasoning overlays with pending-send presentation.
- Pass all 4,634 desktop tests (five intentional skips) with four workers,
  TypeScript validation, eight compile/license checks, production compilation
  and the compiled-entry guard.
- Re-exercise the merged production renderer/preload in native offscreen Electron
  with production IPC/service/native HTTP: Side chat opening and sizing, native
  copy/paste, scroll restoration, independent chat positions, pending close/reopen,
  cancellation and a subsequent question. Check light/dark and narrow layout;
  restore the clipboard. These requests use a controlled loopback response
  server; live model execution is covered by earlier feature acceptance.
- Exercise the merged desktop and isolated real server together with synthetic
  histories and controlled health failures: live updates recover in 727 ms
  during continuous native typing, including an injected 700 ms server delay.
  Preserve all 48 draft characters and retain deferred metadata application.
- Availability: source integration. This does not create a new app package or
  update a running server; paired server changes are integrated separately.

## 2026-09-21 — Resume live chat updates during input — source acceptance

- Resume requested chat subscriptions immediately after the server is healthy,
  before waiting for the foreground input pause used by background session/job
  metadata. Preserve scope and subscription ownership; hidden chats stay closed.
- Pass six focused service checks, TypeScript validation, production compilation
  and compiled-entry verification. The regression fails on the old ordering.
- Exercise actual offscreen Electron with production service, packaged renderer
  and preload, native sidebar clicks and typing, and an isolated real server.
  Synthetic histories contain 5,000 and 300 events; normal cached switches are
  already fast and are not reported as a reproduced stall.
- Inject one HTTP health failure and a 700 ms healthy response delay. On the
  old service, selected-chat recovery waits 8.93 seconds, including three seconds
  after typing stops. The correction recovers in 732 ms during continuous input;
  an independent repeat records 729 ms, preserves all 49 typed characters, and
  leaves background metadata deferred. No provider turn is part of this check.
- Availability: accepted source correction for the coordinated desktop release.
  A separate compatible server optimization avoids redundant full-history fork
  scans on timeline refreshes. Production apps and servers remain unchanged.

## 2026-09-20 — Revised beta.12 package and public release validation

- Build the revised server package from clean committed source `751c1e0`.
  Its SHA-256 is
  `bc69cb8817d3f085330306a463f61b0353186193b2357600f1613f56288995ea`.
  The standalone export preserves upstream history and all 88 runtime files;
  packaging that export through npm produces the identical archive.
- Pass native macOS fresh-install retry over the exact failed candidate's empty
  folders without cleanup. Refuse another install without changing the running
  process, identity, token or synthetic provider files. Pass candidate activation
  and forced incompatible-API rollback with the exact prior runtime and plist.
- Pass the app-driven Linux update and rollback through the production renderer,
  preload, IPC, coordinator, systemd service and detached installer. Verify all
  88 installed runtime files, identity, token and six synthetic state/history
  files. The failed update remains paused after repeated health refreshes, and
  the isolated HTTPS registry records only the two intended package downloads.
  Inspect dark and light layouts, including the minimum supported window width.
- These results cover disposable native services and controlled app-replacement,
  signing-key and distribution endpoints. Production-signed app replacement,
  public registry transport and live provider work are not established by them.
- Exercise the complete legacy bridge route from an old managed server without
  npm update support. The production app checks and starts a signed legacy
  update; the old detached updater installs the paired runtime and reconnects
  with npm update capability. The app marks the equal-version bridge current
  without a redundant npm download. Discovery and signing endpoints are controlled
  within the disposable guest; no public legacy release was published.
- Correct source CI to use runner paths in step environment variables and run
  for maintained release branches. All eight public server test shards pass.
  Update legacy release assertions for protected public workflows and reviewed
  source-branch ancestry; retain release identity and mirroring checks.
- Correct settings test fixtures to provide the required typed app-update status,
  settle initial loading and distinguish app controls from server controls.
  Pass 4,630 Electron tests with five existing skips, eight script tests and type
  checking. Retain all server operation and recovery assertions.
- Reproduce delayed app-update status dismissing an already open server restart
  confirmation or clearing a restart error. Reset these controls when Settings
  opens, preserving user actions while status finishes loading. Keep server
  polling and profile/boot checks unchanged; add regressions for both cases.
- No released app build or public npm version is accepted by this entry.
  Native signing credentials still need to be supplied to the public release
  environment, and signed publication checks remain pending.

## 2026-09-20 — Current server integration and transition signing — candidate follow-up

- Merge the six newer commits from the maintained standalone release branch,
  preserving automatic Codex/Cursor chat titles and the shared-chat Cursor fix.
  Preserve the updated shared-browser bundle. The earlier `8a52b14` archives
  below are historical QA artifacts and are superseded for release preparation.
- Include automatic title requests in update and restart blockers. Prevent new
  optional title requests after update admission closes, and allow unstarted
  queued requests to retry on a later turn. Verify an actual disposable provider
  subprocess delays update advancement and that shutdown reaps its process group.
- Pass 291 targeted title, provider-background, update and restart tests. Pass
  another 189 focused provider-isolation, storage, shared-chat, terminal and
  packaging checks, plus 33 Node publication/staging/CLI checks. Reproduce the
  terminal cancellation regression with a single-worker executor.
- Make npm packaging work in both the combined repository and standalone
  compatibility export. Select legal notices from the checkout boundary, reject
  unrelated parent files and retain exact canonical license copies in the export.
  Nine packaging tests include real offline npm archives in both layouts.
- Include the license and notice in both published server distributions and
  installed runtimes. Pass 16 focused packaging/manifest tests, including actual
  npm and legacy archive comparison of the legal files and their permissions.
- Reproduce macOS device-number changes across reboot breaking interrupted
  activation recovery. New journals bind their filesystem coordinates to a
  persistent volume UUID while retaining inode, ownership, content and live race
  checks. Negotiate the new guard-path option with older recovery helpers.
  Pass 75 activation/UUID tests and 17 installer recovery tests. In a disposable
  macOS VM, interrupt the real installer, reboot across an actual device-number
  change and verify unchanged installer retry restores the previous runtime,
  exact service plist, identity, token and six synthetic state/history files.
  A second orderly reboot retains that rollback and starts the restored service.
  Legacy journals without saved volume proof still require manual recovery if
  their device numbers changed; specialized interrupted Hub reactivation after
  remount remains unsupported. Do not describe those boundaries as accepted.
- Prepare transitional signing through the standalone repository's existing
  release secret. Its prepare-only workflow can produce both signed server
  distributions after all server test shards pass, without publishing them or
  moving the private key. Publication and native acceptance remain separate.
- Move desktop signing and publication automation into public AgentsDock.
  Keep signing credentials in the branch-restricted `direct-production`
  environment and npm OIDC in `npm-release`; ordinary CI and fork pull requests
  receive neither. Rebase the public workflow's native build counter above 1185
  and retain exact source, signature, immutable-asset and server-runtime checks.
  Preserve the private repository's history and retire its release workflows
  when the public pipeline becomes the active publisher. Secret values must be
  supplied again from their original source; they have not been copied or logged.
- Pass 60 release-orchestration tests, parse both public native workflows and
  check all 50 shell steps. Verify manual/canonical/trusted-branch guards on all
  13 jobs and the release environment on all seven jobs that use secrets.
- Reject the packaged `d9c1f50` candidate after a pristine macOS install exposes
  a missing LaunchAgents parent during volume binding. Bind a safe existing
  ancestor until publication creates and verifies the destination directory.
  Pass 77 activation tests, including missing-parent recovery checks.
- Allow retry after that failure without deleting the empty configuration and
  state/admin directories it leaves behind. Both launcher and locked installer
  reject existing data, credentials, links, locks and registered services;
  fresh installation creates no legacy migration alias. Pass 12 CLI tests,
  14 installer admission tests and two actual installer regressions from a
  clean source snapshot. Exact-package macOS retry acceptance remains pending.
- Availability: committed source candidate. Updated packaged migration and
  recovery verification are in progress; no public release or production service
  has changed.

## 2026-09-20 — npm publication and native migration validation — beta.12 candidate

- Reserve `1.0.4-beta.12` for the coordinated candidate. Do not publish the
  earlier beta.9 QA package under an already-used server release version.
- Add manual unsigned preparation and protected OIDC publication of an exact
  signed npm candidate. Verify reviewed source, accepted descriptor hash,
  signature, package identity, immutable version, channel and registry bytes.
  Keep private signing separate; inspecting or signing a candidate does not
  establish native acceptance or publish a desktop release.
- Reproduce a failed fresh installation leaving only empty runtime folders.
  Allow the npm launcher to retry only safely owned empty scaffolding, while
  retaining rejection of state, configuration, files, links, releases, locks
  and registered services. Delete no existing data and retain the installer's
  repeated admission check under its lock.
- Exercise Update through the actual production renderer, preload, IPC,
  service, coordinator and native HTTP in isolated offscreen Electron against
  a disposable Linux systemd service. Verify the detached updater downloads a
  signed HTTPS archive, validates it, activates the candidate and reconnects
  with the same identity and token. Preserve six synthetic state/history files.
- Send an intentionally incompatible signed API contract through the same
  desktop path. Observe candidate activation, rejection and real rollback to
  the prior runtime. Verify the UI pauses with an explicit retry action and
  repeated health refreshes do not download or install it again. Preserve an
  independent offline profile and inspect light/dark minimum-width layouts.
- Separately exercise real macOS launchd in disposable virtual machines:
  legacy installer to candidate, wrong-API health rejection and restoration of
  the previous runtime and exact service plist. Verify identity, token and
  six synthetic provider/configuration/history files remain unchanged. Fresh
  installation through actual offline npx succeeds; a second installation is
  refused without changing the running service.
- Test boundaries: ephemeral signing key and guest-only HTTPS registry for
  Linux; controlled app download/replacement; synthetic provider data rather
  than live model work. macOS dependency caches are preloaded after guest
  outbound network failure. These tests do not establish public npm transport,
  production-signed packaged-app acceptance or actual app replacement.
- Pass 33 focused Node tests covering publication, packaged metadata and the
  npm CLI, plus five actual npm packaging tests and nine installer admission
  tests. Preserve explicit unsupported-boundary notes instead of treating
  a dry run or simulated app replacement as an accepted public release.
- Prepare the exact beta.12 npm archive from committed source `8a52b14` in a
  clean detached checkout. Its SHA-256 is
  `ce392cf842774eb55fcd889a36e5c875d18e7a70551a77163744413fd9252241`.
  On a third pristine macOS VM, reproduce the actual failed first install and
  retry with this unchanged archive through npx, without removing the leftover
  folders. Verify beta.12/API 28 activation, then refuse repeated installation
  while preserving the running process, identity, token and provider sentinels.
- Keep native build/draft staging possible before registry publication.
  Final release verification requires both the signed npm package and matching
  legacy bridge to be public, with identical runtime files and executable bits.
- Verify the compatibility export preserves the standalone repository's ancestry
  and exact server tree. Build the beta.12 legacy archive from that export and
  compare it with the committed npm archive: all 85 runtime files and their
  executable permissions match. Both manifests remain unsigned until production
  signing; these local archives have not been made available to installed users.
- Availability: committed source candidate after focused validation. Registry
  publication, trusted-publisher execution and the complete signed native
  release remain pending. Production services and CLI credentials are untouched.

## 2026-09-20 — Coordinated npm updates — source candidate

- Import the maintained server under `server/` with its complete history.
  Retire the frozen snapshot and its legacy Swift server-text assertions.
  Verify that the initial subtree export reproduces the original standalone
  commit; require subsequent compatibility exports to preserve ancestry and
  exact contents. Keep legacy signed downloads available during migration.
- Prepare `@agentsdock/server` from the exact runtime allowlist, with no npm
  installation hooks. Stage a separate signed descriptor tying the app's
  public version to an immutable npm archive, integrity hashes and API contract.
  Keep source package metadata private and publication disabled in preparation.
- Add authenticated, identity-bound reconciliation through the existing managed
  updater. Persist signed bytes across queued work and restart, queue while busy,
  and validate candidate identity, version and API before activation commits.
  Fresh npm installation refuses existing state and services, including a
  repeated check under the installer lock.
- Add desktop coordination with durable per-server receipts, independent offline
  recovery, explicit enrollment, exact downloaded app version pinning and a
  compatibility gate before restart. Ordinary unenrolled builds keep the existing
  update behavior. The app and server retain their native packaging formats.
  Failed or canceled owned attempts stay paused until an explicit scoped retry;
  enrolled releases keep legacy controls under Advanced server recovery.
- Pass 233 focused server checks, including real HTTP authentication and
  identity guards, signed metadata, queued-work recovery, installer protection
  and candidate health rejection. Verify actual offline npm packing, CLI native
  transport, exact payload bytes and executable permissions, paired artifact
  staging and Git export rejection on divergent history.
- Pass 722 affected desktop tests, TypeScript validation and production
  compilation. Exercise the production renderer, preload, IPC, profile service,
  updater, coordinator and native HTTP against an isolated production FastAPI
  server in native offscreen Electron. Click Update, reopen a second process,
  preserve the queued receipt, display an independent offline profile, pause on
  failure/cancellation and retry explicitly. Verify dark/light minimum-width
  layouts and no automatic legacy release lookup. Feed/download, signing key,
  provider work, server activation and app quit are controlled test boundaries;
  simulated completion is not recorded as a real managed update.
- Separately exercise the real installer in a disposable Ubuntu systemd VM:
  legacy beta.9 to guest-stamped beta.12, then a deliberately incompatible
  beta.13 candidate rolls back to beta.12. Authenticated health verifies exact
  version and API, stable identity and preserved token. Six synthetic provider,
  configuration and history/state files remain byte-identical. This validates
  Linux service activation and rollback, not real provider sessions or the full
  registry-to-app update journey.
- Install the committed local npm tarball through actual offline `npx` in a
  second disposable Linux user account. Verify its independent real systemd
  service, identity and token; a second fresh-install attempt is refused and
  both services remain unchanged. Package retrieval from the public registry
  and same-user multiple-server installation are not claimed by this test.
- Compile the legacy Swift guardrail executable successfully. Its unchanged
  React mobile source-text assertion still fails before later checks; this is
  not recorded as a passing full Swift guardrail run.
- Availability: source candidate only. macOS launchd migration and rollback,
  active real-provider work and retained live chat data, registry publication,
  the complete coordinated upgrade and packaged native acceptance remain
  required before a coordinated release. No production service or published
  release is changed by this source work.

## 2026-09-20 — Side chat scroll memory — 1.0.4-beta.16 local acceptance

- Accept signed local Apple silicon macOS app **1.0.4-beta.16 / 1190** from
  `9451baae691a2f9ad93bbef8e05b60c3e1a38a12`. Verify bundle audit, Developer ID
  signature, runtime entitlements, exact version/build and isolated startup.
  All 88 compiled files in the package match the tested production output.
- Exercise the exact packaged renderer/preload with native offscreen mouse
  input. Verify exact scroll restoration after reopening, stable reading
  position when replies arrive, bottom following after a reply arrives while
  closed, Jump to latest and independent positions across two chats. The
  controlled server and unchanged provider boundary are described below.
- Availability: signed local `.app` with automatic updates disabled, not a
  notarized public release. This scroll correction needs no server update.

## 2026-09-20 — Remember Side chat reading position — source acceptance

- Restore each Side chat's reading position across closing/reopening and chat
  switches. Keep positions scoped to their server and parent chat, and reset
  them when the side conversation is cleared or its server is removed.
- Open new conversations at the bottom. Follow replies while already at the
  bottom; preserve the reading position while scrolled up and offer a compact
  Jump to latest control. Restore after the popup measures its available space.
- Pass 38 focused component/controller/layout checks, TypeScript validation
  and production compilation. In native offscreen Electron, exercise actual
  scrolling, close/reopen, delayed replies while reading older text, replies
  arriving while closed, Jump to latest and independent positions in two chats.
  The controlled server exercises production preload/IPC/native HTTP. Provider
  execution and server-picker transitions are outside this acceptance; a
  focused ownership check covers server identity changes and revisits.
- Availability: source correction. No server change is needed for scroll state.

## 2026-09-20 — Side chat button spacing — 1.0.4-beta.15 local acceptance

- Accept signed local Apple silicon macOS app **1.0.4-beta.15 / 1189** from
  `d3e4877a6b83eae994e4ee910d0e998808465850`. Verify bundle audit, Developer ID
  signature, runtime entitlements, version/build and isolated startup. All 88
  compiled files in the package match the tested production output.
- Reproduce overlapping controls in beta.14, then exercise native offscreen
  scrolling and clicks in the corrected source and exact packaged renderer.
  At normal and narrow widths, Side chat sits 30 pixels lower with a clear gap
  beneath Jump to latest. Both controls work, and the popup opens above the
  unobscured composer. The controlled timeline uses production preload/IPC and
  native HTTP; provider execution is outside this layout-only acceptance.
- Availability: signed local `.app` with automatic updates disabled, not a
  notarized public release. No server update is required.

## 2026-09-20 — Side chat button spacing — source correction

- Lower the Side chat button into the folder row above the message composer,
  separating it from the timeline's jump-to-latest arrow. Reserve room beside
  the folder control and keep the button clickable above the composer layer.
- Pass 30 existing component/layout checks, TypeScript validation and
  production compilation. No server change is required.

## 2026-09-20 — Side chat copying — 1.0.4-beta.14 local acceptance

- Accept signed local Apple silicon macOS app **1.0.4-beta.14 / 1188** from
  `3a6905319b229aaa08f1e3012af09c2d08756ef3`. Verify bundle audit, Developer ID
  signature, runtime entitlements, version/build and isolated startup. All 88
  packaged compiled files match the tested production output.
- Reproduce disabled selection in beta.13. In the corrected source and exact
  beta.14 packaged renderer/preload, use native offscreen mouse dragging to
  select user messages, assistant prose and inline code. Native copy commands
  produce the exact selected text; paste inserts it into the composer while
  the popup remains open. Restore the original clipboard after verification.
- Keyboard verification uses Meta+C/Meta+V with Chromium native edit commands;
  the hidden window does not exercise macOS global menu accelerators. The
  production menu retains its standard copy/paste roles. The controlled server
  exercises production native transport; no model-provider execution changes.
- Availability: signed local `.app` with automatic updates disabled, not a
  notarized public release. No server update is required.

## 2026-09-20 — Side chat text selection — source correction

- Restore normal text selection in Side chat history so user messages,
  assistant replies and inline code can be copied with the native shortcut.
  The popup no longer inherits the app chrome's selection-disabled style.
- Pass 27 existing component/theme checks, TypeScript validation and production
  compilation. Native clipboard and packaged-app acceptance are recorded
  above. No server change is required.

## 2026-09-20 — Compact popup — 1.0.4-beta.13 local acceptance

- Accept the signed local Apple silicon macOS app **1.0.4-beta.13 / 1187** from
  `c3aab200f66c5b36526b899b8e087658c543711a`. Verify bundle audit, Developer ID
  signature, runtime entitlements, version/build and clean isolated startup.
  All 88 packaged compiled files match the tested production output.
- Exercise the exact packaged renderer, preload and CSS in native offscreen
  Electron with keyboard focus enabled. Verify compact empty presentation,
  growing drafts, long-answer scrolling, Clear, help, close/reopen and Escape
  in dark/light themes and a narrow window. The controlled server and service
  harness preserve the boundary described below; no model provider runs.
- Availability: signed local `.app` with automatic updates disabled, not a
  notarized public release. No server update is required for this layout change.

## 2026-09-20 — Compact Side chat popup — source acceptance

- Size the popup to its content instead of reserving a full-height empty panel.
  Start with a single-line composer and grow it with the draft. Keep long
  conversations scrollable within the existing maximum popup height.
- Remove the duplicate input focus outline, manual resize grip and repeated
  explanatory text. Keep one subtle composer focus treatment, a circular Send
  button and direct Clear/Close icons. Expand context help inline when requested.
- Pass 27 existing component/theme checks and TypeScript validation. Exercise
  native offscreen Electron with production CSS ordering and keyboard focus:
  empty and long drafts, long-answer wheel scrolling, Clear shrinking the popup,
  context help, close/reopen and Escape, dark/light themes and a narrow window.
  Requests use production preload, IPC and native HTTP into a controlled local
  server; provider execution is unchanged and outside this visual acceptance.
- Availability: source correction; no server change is required.

## 2026-09-20 — Side chat popup and Claude agents — 1.0.4-beta.12 local acceptance

- Accept the local Apple silicon macOS app **1.0.4-beta.12 / 1186** from
  `a83a18e85e0b6207f5583e317dc00f902076912b`, including the popup and Claude
  subagent corrections described below. Pass 381 service/projector checks,
  100 focused popup checks, TypeScript validation and production compilation.
- Verify Developer ID signing, bundle audit, hardened-runtime entitlements,
  exact version/build and clean startup with isolated user data. All 88
  packaged compiled files are identical to the accepted production output.
- Exercise the exact packaged renderer and preload in native offscreen
  Electron through production bootstrap, store, IPC and read-only HTTP:
  opening/reopening Claude agents, opening the popup, retained drafts, direct
  Clear and Escape. The harness compiles the service from the same committed
  source and suppresses read receipts. The signed main binary is checked
  separately at startup. Real Claude side-question acceptance precedes packaging.
- Availability: signed local `.app` with automatic updates disabled. This is
  not a notarized public release, cross-platform acceptance or server deployment.
  Claude subagent visibility works with the existing server; the separate side
  question configuration correction still requires a server update.

## 2026-09-20 — Claude subagent refresh — source acceptance

- Fetch authoritative subagent state when opening Claude chats, as already
  done for Codex. Seed live tracking from that state and retain progress and
  completion in the local cache, including native `task_updated` messages.
- Exclude explicitly identified background shell and workflow tasks from the
  agent list. Reject older snapshots and replayed events after newer activity
  so reopening cannot roll an agent's status backward.
- Reproduce the missing snapshot request in isolated native offscreen Electron.
  Verify the corrected full app through production preload, IPC and native
  read-only HTTP: cold-open a real Claude chat, inspect its active and historical
  agents, open details, navigate away and reopen. The authoritative state and
  agent activity persist; background shell tasks do not flood the list.
- This read-only check does not launch a new provider agent. Focused service
  checks cover progress, both completion formats and stale-event races.
- Availability: source correction using the existing server API. No server
  update is required for this subagent visibility fix.

## 2026-09-20 — Side chat popup — source candidate

- Move Side chat to a single button beside the composer. Open the conversation
  in a floating popup without changing the main chat width, including split
  chat panes. Keep Clear and Close directly accessible in its header.
- Preserve side conversations, pending answers and drafts when the popup is
  dismissed. Retain the existing per-chat and per-server ownership rules.
- Pass 100 focused checks, TypeScript validation and production compilation.
  Exercise the full app in isolated native offscreen Electron: popup placement,
  input focus, Escape and outside-click dismissal, reopening drafts and answers,
  direct Clear, pending request retention and cancellation, split-pane isolation,
  dark/light themes, narrow layout and Chinese text. Requests cross production
  preload, IPC and native HTTP. Also exercise real native Claude through an
  isolated production server: ask about a fact present only in a completed tool
  result, ask a contextual follow-up, close/reopen and clear the popup. The
  running parent stays active, and side requests do not alter its transcript.
  The test bootstrap uses a seeded native profile; full server-picker setup is
  outside this check.
- The paired server correction preserves the connected Claude parent when
  saved effort settings change for a future turn. Existing servers require
  that correction to avoid the related side-question configuration conflict.
- Availability: source candidate. No published build or live production server
  is changed by this acceptance.

## 2026-09-20 — Compact running command blocks — 1.0.4-beta.11 local acceptance

- Keep the active Codex tool inside its compact command group. Update the
  group's single row to the latest running call and retain previous calls
  behind its disclosure. Preserve commentary boundaries and visible reasoning
  chronology. Only the current activity pulses.
- Hide extra trace-history controls in compact live Codex turns. Keep manual
  pagination in expanded live traces and explicitly opened completed history.
- Retain live-only reasoning display and identical collapsed completed/stopped
  history. This supersedes the undelivered beta.10 candidate, whose running
  call could still appear beside a separate completed-command group.
- Pass 4,598 source tests (10 skipped), 164 focused timeline checks, TypeScript
  validation and production compilation. Verify real native Codex commands
  separated by reasoning within one commentary block, including a delayed
  second call: one compact pulsing row retains both calls. Confirm a later
  commentary creates its own chronological block. Exercise the actual Settings
  entry and switch, completion, stop, unchanged completed history, reduced
  motion, both themes and no automatic trace requests in isolated native
  Electron through the production server and authenticated transport.
  Provider Responses are controlled fixtures; this is transport and display
  acceptance against the supplied visual reference, not external-model output
  or native GUI pixel parity.
- Accept signed, notarized universal macOS **1.0.4-beta.11 / 1185** from
  `494c91fd7236a430d498cb90481fc06697b5a500`. All 88 compiled files match the
  frozen source, and the final ZIP's ASAR matches the exact packaged full-app
  completion and interruption replays. Verify actual Sidebar → Settings
  interaction, compact command blocks, no extra default live controls,
  identical terminal history, reload, reduced motion and supported minimum
  width. The packaged replay uses captured native events and offline IPC;
  production transport was exercised separately in the source acceptance.
- Pass Developer ID signature, Gatekeeper, stapling, universal architecture,
  version/build, ZIP updater hashes and feed checks. The actual signed app
  launches cleanly for ten seconds with isolated user data and is then closed.
  Matching ZIP SHA-256:
  `60792d4c880914d9c05c7769289532b6d9ffe93d972fce94071d2325e923f3e9`.
- Availability: accepted local `.app` and matching ZIP. Public desktop
  publication remains blocked by the private Actions budget. Local app
  acceptance does not imply cross-platform or DMG installer acceptance.

## 2026-09-19 — Live-only reasoning display — 1.0.4-beta.10 candidate

- Apply the reasoning display preference only during an active Codex turn.
  Collapse finished and stopped turns under both settings; changing Settings
  leaves completed history unchanged. Explicit history expansion retains all
  available text in chronological order, independently of the preference.
- Group adjacent commands across hidden reasoning entries. Retain visible
  commentary and reasoning boundaries instead of moving or dropping content.
  Update the English and Chinese setting descriptions.
- Exercise completion and interruption through actual sandboxed Codex, an
  isolated production server, authenticated WebSocket, desktop service,
  preload and timeline in native offscreen Electron. Click the real Settings
  switch while running and after completion; verify both settings converge
  to collapsed history, manual expansion retains text, and hidden reasoning
  produces one command group. Check dark/light narrow layouts and no automatic
  history requests. Responses are controlled fixtures; this validates native
  transport and presentation, not external-model output or native GUI parity.
- Pass 4,594 tests (10 skipped), eight build/license guard checks, TypeScript
  validation and production compilation. Keep release verification temporary
  extraction under the configured temporary directory, with a writable-path
  check. This presentation change requires no server contract update.
- Availability: source candidate; signed local package acceptance is pending.

## 2026-09-19 — Codex activity and per-chat limits — 1.0.4-beta.9

- Present Codex commentary and command rows inline, with one muted pulsing
  current activity. Stop animation on completion or interruption and honor
  reduced motion. Preserve earlier summaries under a compact disclosure.
- Add a persistent **Show reasoning traces** switch in Settings → General.
  Keep compact presentation by default; optionally expand summaries and
  separately labeled plaintext supplied by Codex. Do not decode encrypted
  content or imply that unavailable reasoning can be recovered.
- Carry the distinct plaintext event through live transport, timeline
  projection, completion, interruption and history. Keep transient updates
  outside durable cache/cursors and distinguish summaries sharing an item ID.
  Verify the previous desktop renderer ignores the new plaintext event even
  when its trace is expanded, while continuing to display ordinary summaries.
- Add optional Codex and Claude sub-agent limits in the chat Inspector.
  Fence saves to the original server identity and generation, reject old
  servers before mutation, and retain drafts after failure. Saving during
  active work is allowed; explain each provider's application boundary.
- Verify the actual Settings entry and toggle, native Chromium animation,
  reduced motion, complete text expansion, persistence, and light/narrow
  layouts in isolated offscreen Electron. Exercise limit saves and clearing
  through production preload, IPC, HTTP authorization and server persistence;
  preserve a sibling chat and active-work status and reject unauthenticated
  writes. Provider execution is verified separately in the paired server.
- Pass 4,585 source tests (10 skipped), eight build/license guard checks and
  TypeScript validation, including scoped and unscoped preload compatibility.
- Accept local universal macOS **1.0.4-beta.9 / 1182** from
  `1641cb97dfba17b6c3b3807c79c0f63e4a36cca3`. Developer ID signatures,
  notarization, Gatekeeper, DMG/ZIP parity and updater checks pass. The signed
  executable passes its clean CI launch; all 88 packaged compiled files match
  the frozen source. Replay the native capture through the exact packaged
  renderer and preload, including Settings, persistence, reduced motion and
  completion. This packaged replay uses offline fixture transport; native
  provider and authenticated transport checks are recorded separately.
- Verify the copied app on a second Mac: matching archive SHA-256, version,
  build, deep signature and Gatekeeper acceptance. Preserve its existing app.
- Correct a Linux arm64 test that checked an unread callback before its React
  effect committed. Pass all 111 affected module tests and TypeScript checks.
  Follow-up source `5ff80a385957722c99026084036750934fcc564f` changes only
  test synchronization and type declarations; its 88 compiled files are
  byte-identical to accepted build 1182.
- Desktop publication remains blocked: the replacement prepare for build
  1183 could not start because of the GitHub Actions budget. No desktop
  beta.9 release was published. The local Mac acceptance does not certify
  the incomplete cross-platform release.
- The paired [AgentsServer beta.9](https://github.com/ZhengyiLuo/AgentsServer/releases/tag/v1.0.4-beta.9)
  is published and independently verified. Managed updates are queued to
  apply when active work finishes; scheduling is not deployment acceptance.

## 2026-09-19 — Live thinking summaries — 1.0.4-beta.8

- Display thinking summaries directly and retain expansion through completion.
  Opening historical traces loads one bounded activity page automatically;
  additional pages remain available without loading all history in the background.
- Carry live summary snapshots through the native WebSocket, profile-scoped
  service and renderer state. Keep them outside SQLite and durable read cursors,
  replace them with authoritative completed items, and restore current snapshots
  on reconnect. Retain interrupted summary text with a partial marker.
- Show custom-model summary support separately from basic tool compatibility.
- Pass 822 transport, service, state, locale and custom-provider checks, plus
  173 timeline and projection checks and TypeScript validation.
- Native acceptance follows controlled Responses through the real Codex
  app-server, production server, authenticated WebSocket, desktop service,
  preload, state and timeline. Compare rendered text and completed sections
  exactly with native public-summary notifications. Verify live visibility,
  summary/tool/summary order, reconnect, authoritative replacement and retention
  after completion without persisting transient rows.
- Stop an actual native turn that omits item completion; retain its received
  text as a partial summary. Reopen SQLite in a fresh desktop process and
  expand its historical trace to verify the partial marker and bounded load.
  Inspect light/dark layouts at narrow width. Retain finite Chromium
  ResizeObserver notifications in the evidence; geometry and warning counts
  settle, with no application errors. This is public-summary validation,
  not native GUI pixel parity or a claim about unavailable internal reasoning.
- Accept desktop **1.0.4-beta.8 / 1181** from
  `3bb296e1ea076f76f235905d3d2deb965b28e08b`. All 88 packaged compiled files
  match the source fingerprints frozen before artifact download. Replay the
  accepted native capture through the exact packaged full-app renderer,
  preload and state; live/final text and chronological tool placement match.
  This packaged replay uses offline fixture transport.
- Universal Developer ID signatures, notarization, Gatekeeper, mounted
  DMG/ZIP parity and updater checks pass locally; the signed executable passes
  its clean CI launch. Preserve the previous accepted app separately.
- Pass all four platform builds and package checks, then all four publication
  replay checks. macOS and both Linux suites pass 4,564 tests (10 skipped);
  Windows passes 4,528 (16 skipped). Publish the Windows installer under the
  documented unsigned beta policy.
- Publish after the matching signed AgentsServer **1.0.4-beta.8** is publicly
  accepted. Verify 14 exact assets and authored notes on both desktop feeds,
  every public asset digest and size against independently hashed held files,
  the exact source tag, anonymous asset availability, and downloaded checksum
  manifests/updater metadata. Release/tag metadata uses authenticated API reads.
- Releases: [desktop beta.8](https://github.com/ZhengyiLuo/AgentsDock/releases/tag/v1.0.4-beta.8),
  [legacy Beta feed](https://github.com/ZhengyiLuo/AgentsDock-Releases/releases/tag/v1.0.4-beta.8).

## 2026-09-19 — Custom endpoint model compatibility — 1.0.4-beta.7

- Separate optional saved-model compatibility checks from endpoint saving.
  Display unverified, unsupported and basic-check-passed states without
  treating model discovery as proof of native Codex compatibility.
- Respect explicit per-model effort capabilities, including empty effort
  lists, and retain manual entry for unfamiliar model IDs. Fence saved-model
  checks to the selected server and credential revision.
- Pair this client candidate with AgentsServer 1.0.4-beta.7. Its 72 focused
  provider and side-chat checks pass, including stale effort cleanup and
  retained credential ownership. Native loopback capture confirms the
  production override helper clears inherited effort while preserving
  thread instructions and unrelated thread settings.
- Exercise Settings, New chat and Composer in native offscreen Electron
  through production preload, service, native HTTP, server middleware and
  provider routes. Save without a model or test, and while a connection or
  compatibility check is pending; verify late results cannot relabel saved
  settings. Complete repeated checks through isolated native Codex against a
  controlled streaming endpoint. Filter an embedding model, clamp advertised
  efforts, and clear effort for unfamiliar/manual models. Inspect light/dark
  narrow layouts, with no overflow or typing/idle requests. Ordinary account
  status and full profile bootstrap are fixtures; chat-turn execution is
  covered separately by server regression and native request capture.
- Pass focused app, service and transport regressions, TypeScript, production
  compilation and output verification. Also complete a basic check against a
  configured external provider while preserving its saved credentials and
  ordinary account configuration. This does not certify every model or tool.
- Accept desktop **1.0.4-beta.7 / 1180** from
  `26d6e4586e077997b7a5de203fa3b0d41e876699`. All 88 packaged compiled files
  match the reviewed source and the fingerprints recorded before download.
  Inspect the exact packaged renderer/preload in isolated offscreen Electron.
  Universal Developer ID signatures, notarization, Gatekeeper, mounted
  DMG/ZIP parity and updater checks pass locally; the signed executable passes
  a clean CI launch. Recheck the native endpoint workflow against the final
  paired server code, using isolated native Codex and a controlled provider.
- Pass all four platform build and package checks, followed by all four
  publication replay checks. macOS and both Linux release suites pass 4,550
  tests (10 skipped); Windows passes 4,514 (16 skipped). Publish the Windows
  installer under the documented unsigned distribution policy.
- Publish matching sets of 14 assets and authored notes to both Beta feeds.
  Match every public asset digest and size against independently hashed held
  files, verify the exact source tag, and anonymously check all public asset
  URLs. Download both checksum manifests and all updater metadata anonymously
  and verify byte parity. Release/tag metadata uses authenticated public API
  reads after the shared anonymous API rate limit is reached.
- Releases: [desktop beta.7](https://github.com/ZhengyiLuo/AgentsDock/releases/tag/v1.0.4-beta.7),
  [legacy Beta feed](https://github.com/ZhengyiLuo/AgentsDock-Releases/releases/tag/v1.0.4-beta.7).

## 2026-09-19 — Center the Team Network mail reader — 1.0.4-beta.6

- Center mail threads in a wider reading column instead of pushing sent
  messages against the far-right edge. Align incoming and sent messages,
  increase message spacing, and soften the sent-message background.
- Reproduce the previous layout at 2,000 pixels and 70% zoom in native
  offscreen Electron using the production mail and Markdown components.
  Inspect the corrected reader at 2,000, 1,200 and 600 pixels in light and
  dark themes, including long text, code blocks and attachments. Verify no
  page overflow, native navigation and scrolling, code copy and attachment
  preview. The fixture uses synthetic read-only mail and an isolated
  clipboard; delivery and production server data are outside this check.
- Pass all 114 existing mail/style tests, TypeScript, production compilation
  and the compiled-output verifier. This layout change needs no server update.
- Accept desktop **1.0.4-beta.6 / 1178** from
  `7e9ec89e007bc32e1f7889c4f558160385773ba9`. All 88 packaged compiled files
  match the reviewed source. Inspect the packaged renderer/preload in isolated
  offscreen Electron. Universal signing, notarization, Gatekeeper, mounted
  DMG/ZIP parity and updater checks pass locally; the signed executable passes
  a clean CI launch. All four native platform builds and package checks pass,
  and the release test suite passes 4,547 tests (10 skipped).
- Publish matching sets of 14 reviewed assets and authored notes to both Beta
  feeds after all four platform replay checks pass. Verify public asset
  digests, updater metadata, exact source tag and canonical/legacy parity.
- Release: [desktop beta.6](https://github.com/ZhengyiLuo/AgentsDock/releases/tag/v1.0.4-beta.6).

## 2026-09-19 — Preserve side chats across servers — 1.0.4-beta.5

- Keep side-chat state and its native conversation owned by the saved server
  identity and chat, across connection generations. Preserve drafts, replies,
  pending work and follow-up context when switching away and back. Retain
  dispatch checks and explicit cancellation, removal and shutdown cleanup.
- Reproduce lost history/drafts and a switch-triggered close request in native
  offscreen Electron. Exercise the production panel/controller/lifecycle,
  preload, AppService switching, isolated settings/cache and native HTTP to two
  controlled servers with matching chat IDs. Verify background completion,
  follow-up continuity, server separation and cancellation after returning.
  Inspect dark and narrow/light views. The picker and store hydration are
  outside this focused fixture; provider responses are explicitly controlled.
- Also exercise a real Codex side chat against an existing authenticated
  server, using one disposable main chat with a random verification fact.
  Switch servers while its side question runs, restore its answer and draft,
  and complete a contextual follow-up in the same native side conversation.
  Verify both answers, then remove the disposable chat. Existing conversations
  and login settings remain untouched.
- Remove Electron's internal fork-error prefix. Exercise the production chat
  menu through HTTP and native Codex: reproduce a valid symlink-workspace fork
  rejection, then verify repeated forks and a child continuation with the
  corrected standalone server while the parent continues running.
- Pass 111 focused side-chat checks, four fork-error checks, TypeScript and
  production compilation with output verification. The side-chat navigation
  fix needs no server contract change; the fork workspace correction is in
  AgentsServer 1.0.4-beta.5. Include authored notes for both releases.
- Accept desktop **1.0.4-beta.5 / 1177** from
  `56f268292b889f173f7d1e0a10bdc43796545575`. All 88 packaged compiled files
  match the reviewed source. Inspect the packaged renderer/preload in isolated
  offscreen Electron. Local universal signing, notarization, Gatekeeper,
  mounted DMG/ZIP payload parity, checksums and updater metadata pass; the
  signed executable passes a clean CI launch. The macOS release suite passes
  4,547 tests (10 skipped).
- Publish matching sets of 14 reviewed assets and authored notes to both Beta
  feeds after all four native platform checks pass. Verify public asset
  digests, updater metadata, source tag and canonical/legacy parity.
- Publish the signed standalone server 1.0.4-beta.5 and submit its managed
  update for idle installation. The running service remains on beta.4 while
  active work continues; its pending update has no error.
- Releases: [desktop beta.5](https://github.com/ZhengyiLuo/AgentsDock/releases/tag/v1.0.4-beta.5)
  and [server beta.5](https://github.com/ZhengyiLuo/AgentsServer/releases/tag/v1.0.4-beta.5).

## 2026-09-19 — Inter-chat chronology — 1.0.4-beta.4

- Accept desktop **1.0.4-beta.4 / 1176** from
  `d2b40e5b3e8f208d9b36f20be1efcb460ba821f4`.

- Keep inter-chat cards among the work that happened around them, ahead of a
  later final answer even when the turn has early-created files or media.
  Give the trailing media group a presentation anchor consistent with its
  displayed position, and refresh cached rows when that anchor advances.
  Preserve original message timestamps and attachment metadata.
- Reproduce the incorrect order with the production Timeline, virtualizer and
  row components in native offscreen Electron using synthetic event snapshots.
  Exercise native controls for live/completed work, late read receipts, cold
  reopen, a genuinely later send and card expansion. Inspect light/dark output.
  Provider execution and production chat data are outside this renderer check.
- Pass 229 focused timeline tests, TypeScript and production compilation with
  output verification. No server contract change or deployment is required.
- Pass 4,538 desktop tests (10 skipped) in release CI. Verify all 88 packaged
  compiled files against the committed source and inspect the packaged
  renderer/preload. Universal macOS signing, notarization, Gatekeeper,
  DMG/ZIP parity and clean executable launch pass. Linux x64/arm64 and Windows
  x64 package and launch checks also pass; Windows remains an unsigned preview.
- Publish identical sets of 14 assets, checksum manifests and authored
  version-specific notes to both desktop Beta feeds. Independent public
  download checks confirm the exact source tag, asset digests and all four
  updater metadata files after publication.
- Release: [desktop beta.4](https://github.com/ZhengyiLuo/AgentsDock/releases/tag/v1.0.4-beta.4).

## 2026-09-18 — Custom endpoint model controls — 1.0.4-beta.3

- Accept desktop **1.0.4-beta.3 / 1175** from
  `c1dc59c56a666fe881317ff36781f78fcde6decd`, with matching standalone
  AgentsServer **1.0.4-beta.4** from
  `b4b116d022ba9d73949e56476cbfc46fdba27160`.
- Configure a Codex endpoint with its URL and separate key. Saving no longer
  requires a successful test or a model ID, and a pending test does not block it.
- Discover the endpoint's models and choose a model and reasoning effort in
  the normal chat controls. Keep an explicit model entry for endpoints without
  discovery, and keep custom catalogs separate from ordinary Codex.
- Require the matching server capability before using the new controls.
  Existing custom chats retain their endpoint when the default is edited.
- Validate production compilation and focused renderer, service and transport
  regressions. Exercise native Electron input through the production service
  and HTTP boundary with disposable state and controlled provider endpoints.
- The matching server scopes messaging instructions to its helper contract;
  the harness enforces messaging access instead of broad prompt restrictions.
  Remove the blanket identifier prohibition without adding a special
  permission paragraph for local log diagnosis or changing messaging grants.
- Exercise simultaneous normal/custom native Codex threads against controlled
  endpoints. Save and reset during active turns and a pending test; retain the
  original endpoint through model/effort changes, follow-ups and native forks.
  Stop one custom turn without interrupting the normal turn. Verify zero
  account-login calls and unchanged normal runtime identity. Live external
  gateway credentials and production background startup remain outside these
  disposable acceptance fixtures.
- Pass 4,536 desktop tests (10 skipped), TypeScript and production compilation.
  Verify all packaged compiled files against the committed source and inspect
  the packaged renderer/preload. Universal macOS signing, notarization,
  Gatekeeper, DMG/ZIP parity and clean executable launch pass. Linux x64/arm64
  and Windows x64 package and launch checks also pass; Windows remains an
  explicitly approved unsigned preview.
- Publish identical sets of 14 assets and checksum manifests to both desktop
  Beta feeds. Independent publication checks revalidate every native platform
  and confirm public updater metadata and Beta discovery. The matching signed
  server release is published and its managed update is accepted for idle
  installation; it remains pending while active work continues.
- Releases: [desktop beta.3](https://github.com/ZhengyiLuo/AgentsDock/releases/tag/v1.0.4-beta.3)
  and [server beta.4](https://github.com/ZhengyiLuo/AgentsServer/releases/tag/v1.0.4-beta.4).

## 2026-09-18 — Codex credential isolation — 1.0.4-beta.2

- Accept published desktop **1.0.4-beta.2 / 1173** from
  `f87790cf69e66261a2271c2056bd5bcd06ff666a`, with matching standalone
  AgentsServer **1.0.4-beta.2** from
  `dfc05e997b7c97b366c87400f35e4c640f8f2f85`.
- Remove shared API-key sign-in from Settings and every desktop transport
  layer. Normal Codex account status is read-only. The matching server rejects
  the legacy login route before accessing the account manager, including
  requests from older clients. This prevents Settings from overwriting the
  credentials used by ordinary Codex chats and the CLI.
- Keep one explicit Custom endpoint flow: enter URL/model/key, Test, then
  Save. Explain that a new chat must select **Codex · Custom endpoint**.
  Normal account-status failures no longer block endpoint configuration.
- Reproduce the original shared-login call in a disposable native runtime.
  Exercise the corrected Settings with native mouse/keyboard input through
  the full production server module and actual Codex process against a
  controlled Responses service. Verify failed tests and retry, exact URL/model
  persistence, invalidated tests after edits, busy-save rejection, Remove,
  account-status failure recovery and legacy-route rejection. Confirm zero
  native login calls and unchanged ordinary account state.
- Verify simultaneous normal/custom native threads and follow-ups retain
  separate credentials and models. Inspect the packaged renderer/preload and
  all 88 compiled files; the removed shared-login paths are absent. UI fixtures
  use disposable profiles and controlled endpoints; production background
  lifecycle and a live external provider account are not claimed by these checks.
- Pass focused regressions, TypeScript and production compilation. The macOS
  release run passes 4,528 tests (10 skipped), universal signature/notarization,
  DMG/ZIP parity and clean executable launch. Linux x64/arm64 and Windows x64
  packaging and native launch checks also pass. Windows remains an explicitly
  approved unsigned preview.
- Publish the verified desktop packages to the canonical and legacy Beta
  feeds with identical assets and checksum manifests. Independent publication
  checks verify every platform again and confirm public Beta discovery.
  Matching signed server artifacts are published; the managed server update
  is queued for idle installation without interrupting active work.
- Releases: [desktop beta.2](https://github.com/ZhengyiLuo/AgentsDock/releases/tag/v1.0.4-beta.2)
  and [server beta.2](https://github.com/ZhengyiLuo/AgentsServer/releases/tag/v1.0.4-beta.2).

## 2026-09-17 — Per-chat native Codex endpoint selection (beta candidate)

- Accept local desktop **1.0.4-beta.1 / 1175** from `59451a6` and matching
  standalone server **1.0.4-beta.1** from `46d72a4a`. Stamp only the desktop
  package metadata in the clean build snapshot; verify all 88 compiled files
  byte-for-byte, ARM64 Developer ID signature and disabled local updater.
  The server archive matches all 85 allowlisted source files and its checksum.
- Add **Codex · Custom endpoint** beside ordinary Codex in the composer and
  New chat. Configure its base URL, exact model and separate masked key in
  Settings; test explicitly before saving. Ordinary Codex sign-in remains
  available and existing chats retain their original provider.
- Persist the choice per chat and reject unsupported older servers before
  they can silently ignore it or replace a global provider. Started chats
  cannot switch providers. Custom readiness does not require ordinary OpenAI
  sign-in; removing the endpoint leaves custom chats unavailable, not rerouted.
- Run a real native Codex manager with simultaneous normal/custom threads and
  repeated follow-ups against two controlled Responses endpoints. Verify
  separate credentials/models, unchanged process defaults and no tool calls,
  external requests or production account/history changes. The earlier real
  gateway probe verifies the configured native protocol separately.
- Add no polling, automatic model requests or per-keystroke network work.
  Focused transport, renderer, persistence and provider-isolation checks pass.
  Scheduled jobs use the same provider-specific readiness and label.
- Exercise native offscreen mouse/keyboard input through the production
  picker, New chat and Settings, real preload/main HTTP transport and extracted
  production session routes/store. Verify Save, default/custom switching,
  persisted selection, locked-thread rejection, older-server refusal and no
  typing/idle requests. Inspect light/dark narrow layouts. Full application
  bootstrap/cache/profile lifecycle remain fixture boundaries; packaged
  production-profile startup is not claimed.
- The clean-source package pass has 4,539 desktop tests passing (10 skipped),
  TypeScript and production compilation. The clean standalone snapshot passes
  175 focused tests and the real same-manager native provider check. These are
  local test candidates, not published/notarized releases; no installed app,
  production server or active chat was replaced or restarted.

## 2026-09-17 — Native Codex custom endpoint controls (source only)

- Add endpoint base URL, exact model ID and a masked provider key to Codex
  account settings, with explicit Test connection, Save and reset actions.
  Test uses native Codex Responses behavior rather than a replacement agent.
- Keep provider credentials separate from normal Codex sign-in. Require a
  successful test of the current form before saving; invalidate it on edits
  and fence late responses by server/profile generation. Never reuse a saved
  key for a newly entered endpoint or show raw provider errors.
- Add no polling, per-keystroke requests or automatic retries. Test does not
  save configuration; Save/reset reconcile runtime readiness once.
- Exercise native offscreen Electron Settings navigation and the real
  renderer/preload/service/HTTP/router/native Codex path against a controlled
  Responses endpoint. Verify failed tests and retries, unchanged unsaved
  configuration, stale-result invalidation, busy/authorization failures,
  save/reset, missing-credential recovery and narrow localized themes.
- Full profile bootstrap, account status and runtime refresh callbacks remain
  fixture boundaries in UI acceptance; isolated tests cover admission and
  readiness reconciliation. A separate authorized probe also completes a
  native Codex response against a real external Responses gateway with its
  exact model ID. That verifies a small model request, not every tool or
  billing capability. Requires matching standalone server endpoints. No
  release, production deployment or existing account change is included.
- Full desktop tests, TypeScript and production compilation pass after the
  recovery changes. The standalone server's selective source snapshot passes
  its focused authentication, provider, side-chat and manifest regressions.

## 2026-09-17 — Native Codex API-key authentication (source only)

- Add Settings → Codex account with masked API-key sign-in, account status and
  an explicit Recheck action. Explain server-wide account scope, native Codex
  credential storage and separate API billing. Support English and Chinese.
- Use the installed Codex app-server's native account API through the selected
  server's operator-only HTTP endpoint. Do not replace Codex with a model API
  client or put credentials into settings, histories, logs or command arguments.
- Clear credentials on submit, cancel, close and server switch. Fence requests
  by profile/generation, reject redirects and use fixed secret-free errors.
  Add no polling, automatic login retries or per-keystroke network activity.
- Preserve active/queued Codex work during authentication changes. Refresh
  runtime readiness once after a successful save, including same-timestamp
  health records and a pre-login probe that was already in flight.
- Exercise the real UI with native offscreen Electron keyboard/mouse input,
  production preload, scoped service methods, native HTTP, server authorization
  and the actual Codex process using synthetic credentials in an ephemeral
  store. Verify save/recheck/repeat, busy and permission failures, stale replies,
  clearing secrets, idle traffic and narrow light/dark localized layouts.
- Full Settings/profile bootstrap and runtime-catalog behavior remain isolated
  fixture boundaries in UI acceptance; focused service tests cover readiness
  reconciliation. TypeScript, production compilation and desktop regressions
  pass. Native credential acceptance alone is not a live model/billing test.
- Requires matching standalone server authentication endpoints. Availability
  is source only: no public release, production deployment or account switch.

## 2026-09-17 — Native provider side conversations (local build)

- Build **1.0.3-local.1174 / 1174** from `36ba482`. Verify all 88 compiled
  payload files, ARM64 Developer ID signature and local-only updater marker.
- Place Side chat below Media & files, after Subagents, within one inspector.
  Verify expanded/collapsed media and narrow/light/dark native Electron layouts.
- Replace visible-text snapshots with native context: a persistent ephemeral
  Codex fork, or Claude's native side-question control used by `/btw`. Include
  provider tool results without injecting a new message into the main chat.
- Keep follow-up identity and history on the server. Clear closes only the
  selected side conversation; late requests cannot recreate it. Profile/chat
  ownership, cancellation and provider-generation fences protect the main task.
  No polling or per-keystroke network work is added.
- Require the matching native-context server capability. Do not silently fall
  back to a copied transcript on an older server or incompatible provider.
- Real disposable-provider checks cover hidden tool-result recall, follow-ups,
  cancellation while the main request runs, unchanged parent history/goals and
  Claude cold resume without a main query. Focused transport and lifecycle
  regressions cover cancellation, duplicate requests, expiry and cleanup races.
- Exercise native offscreen Electron mouse/keyboard input through production
  preload, native HTTP authorization, router, provider binding and Claude SDK
  manager into a real authenticated Claude provider. Verify first answer,
  follow-up, cancellation, Clear/new conversation and continued main work.
  Both provider adapters also pass real disposable-provider checks; synthetic
  full-boundary UI fixtures cover both providers. Session store/SDK option
  construction and full app-profile bootstrap remain fixture boundaries.
- TypeScript, production compilation and the clean-source desktop suite pass
  (4,412 tests, 10 skipped). Matching standalone server source is `39e59aad`.
  Packaged startup is not exercised; payload/signature validation does not
  claim an installed production-profile test. No server deployment, publication
  or replacement of the running app is included.

## 2026-09-17 — Side chat in the shared inspector (local only)

- Build **1.0.3-local.1173 / 1173** from `85471ed`. Verify the ARM64
  Developer ID signature, local-only updater marker and exact compiled payload
  against the accepted source. Do not replace the installed app or publish.
- Place Side chat directly below Subagents in the existing inspector scroll;
  remove its separate tab and nested inspector landmark. Keep Review available.
- Preserve per-chat drafts, replies and pending requests across panel/review
  navigation. Only the explicit Side chat shortcut focuses the composer;
  merely opening the inspector cannot steal main-chat input focus.
- Validate focused component/App regressions and TypeScript. Exercise the
  production Inspector and Side chat with native offscreen Electron input in
  light/dark and narrow layouts, using synthetic sessions and provider replies.
  This is layout/interaction acceptance; transport and providers are unchanged.
- Catch and correct a narrow-window clipping case by revealing the complete
  composer rather than only its textarea. Verify long-history wheel scrolling,
  localization and no extra transport/global-store writes while typing.
- The final package pass has 4,387 tests passing, 10 skipped. One earlier run
  encountered an intermittent pre-existing Team Network address-label timing
  assertion; its focused rerun and final full run pass without changing that
  feature. Package startup and live-provider behavior are not retested here.
- Prepare a local desktop package only. No publication, server update or
  replacement of the running application is part of this change.

## 2026-09-17 — Desktop 1.0.3 stable accepted

- Publish [AgentsDock 1.0.3](https://github.com/ZhengyiLuo/AgentsDock/releases/tag/v1.0.3),
  build **1172**, from `fa5d815118c28a1c18fa6d9afc3cc77f7d089fff`.
  Include Workspace Changes, native Side chat transport correction and the
  small 9px sidebar app-version label. Matching AgentsServer 1.0.3 is published
  for Git controls and the Codex Side chat startup correction.
- Preparation `35277907016` and publication `35279799800` pass all four
  platform gates. macOS is Developer ID signed and notarized; Windows retains
  the approved unsigned policy. Verify the exact downloaded universal Mac
  package's 1.0.3/build 1172 metadata, signature, notarization, public Stable
  update feed, bundled feature code and version typography.
- Verify identical 14-asset public and legacy releases, the pinned source tag,
  sealed checksums and fresh public updater metadata for every platform.
  Checksum-manifest SHA-256:
  `6ede115f1bceb8acbfcb37cb951b3bc10753582051db378f57913a945b44f39a`.
- Native offscreen interaction covers Sidebar themes/widths, real-repository
  Changes workflows through the production client/server boundary, and real
  provider Side chat answers, follow-ups and cancellation. A disposable Codex
  overlap check confirms cancelling the side turn leaves its separate test
  main turn active through normal completion. Official package clean-start
  checks run on disposable CI machines; local native fixtures do not claim a
  full packaged production-profile Changes journey.
- Preserve concurrent uncommitted work. Publication does not replace the
  user's running app, install on another machine, or restart either server.

## 2026-09-17 — Quiet sidebar version label (unreleased)

- Keep the installed app version beside the brand at a small, muted 9px size;
  preserve the title and control layout and keep the full version in its tooltip.
- Check production Sidebar rendering in isolated offscreen Electron at narrow
  and normal sidebar widths, light and dark themes. Verify no title/control
  overlap, working keyboard navigation, one local metadata read and no network
  requests. This is renderer acceptance, not packaged-release acceptance.

## 2026-09-17 — Workspace Changes first cut (unreleased)

- Add a lazy Changes workspace tab for repository-wide staged, unstaged,
  untracked and conflicted files, on-demand diffs, whole-file staging,
  staged-set commit review, and text conflict resolution. Continue reports
  further conflicts honestly; abort requires explicit confirmation.
- Use native operator-only, profile-scoped requests and repository revisions.
  Preserve conflict drafts on stale writes, reject late responses from another
  workspace, and add no polling or per-keystroke Git requests.
- Exercise production workspace entry/renderer, preload, HTTP client, server
  Git router and native authorization with mouse/keyboard in isolated offscreen
  Electron against disposable real repositories. Verify actual commits/index,
  stale stage and resolution rejection, merge completion, confirmed abort,
  tab switching/closing, light/dark and narrow views, and zero idle requests.
  Session lookup and app-shell context are fixtures; full installed-app startup
  and production-profile acceptance are not claimed.
- Validate focused desktop regressions, TypeScript and production compilation.
  This feature needs the matching standalone server Git endpoints. PR/MR,
  push and branch creation remain outside this first cut. Not published,
  installed or deployed; existing applications and research jobs remain intact.

## 2026-09-17 — Desktop 1.0.3 acceptance checkpoint (not published)

- Validate clean source `f387a1ac874ab3e153a648bd53e42bf4347ae4e4` with TypeScript,
  production compilation, 4,369 passing desktop tests (10 skipped) and eight
  package/license guards. Keep unrelated working-tree changes out of the pin.
- Exercise Side chat with native Electron input, production preload IPC,
  request ownership and HTTP client, the unchanged server authorization/router,
  and a real Claude provider. First answer, contextual follow-up and cancellation
  pass; the old generic transport reproduces 403. Session context and the main
  task are synthetic: this does not validate a concurrent live main agent or
  full production profile bootstrap.
- The equivalent real Codex check uncovers a separate server adapter startup
  failure before a thread starts: fresh temporary state indexes existing
  provider history synchronously and initialization times out. Do not classify
  that as an app authentication failure or extend deadlines to hide the work.
- Hold publication pending the known Codex limitation and release decision.
  No installed app or production server was replaced or restarted.

## 2026-09-17 — Desktop 1.0.3 side-chat transport and visible versions

- Correct side-question POST and cancellation to use the existing native HTTP
  transport. Generic fetch added a browser-style header that the server's
  native-only authorization rejects. Preserve the authentication boundary,
  response ownership, follow-up history, cancellation and timeout behavior.
- Replace mock-only HTTP checks with loopback wire checks reproducing the 403
  and exercising the corrected requests, redirects and cancellation.
- Show the app version and selected server version in the sidebar using local
  app status and scoped server metadata, without polling. Validate light/dark,
  narrow layout and server switching in an isolated native Electron renderer.
- Add the app development operational manual to the repository rules, requiring
  hands-on workflows and explicit accounting for real versus mocked boundaries.
- These desktop changes do not require a matching server update. Source
  preparation and focused checks are not publication or live-provider acceptance;
  record those separately when completed.

## 2026-09-17 — Desktop 1.0.2 stable accepted

- Publish [AgentsDock 1.0.2](https://github.com/ZhengyiLuo/AgentsDock/releases/tag/v1.0.2),
  build **1170**, from `94659a201581a2adf1f0938f157e519a859e1459`.
  The public and legacy repositories carry identical sets of 14 release assets
  and Stable updater metadata. Preserve unrelated uncommitted work.
- Native release preparation `35195524801` and publication `35197194846` pass
  all platform gates. macOS universal is Developer ID signed and notarized;
  Linux x64/arm64 and the explicitly unsigned Windows x64 installer are verified.
- Validate the exact committed desktop source with TypeScript, production
  compilation, 4,360 desktop tests (10 skipped) and eight package/license guards.
  Deterministic regressions cover both first-click races found by the initial
  native release attempt; the failed candidate was never published.
- Inspect the actual isolated Electron recovery dialog and full Team Network
  surface in light/dark and wide/narrow layouts. Verify cancel/focus, wrong-host
  errors, offline-to-workspace recovery and no typing-triggered requests or
  global store writes. Synthetic endpoints never mutate live networks.
- Pair with the published standalone AgentsServer 1.0.2 recovery contract.
  Members must update their own server and explicitly change a moved host's
  saved address; publication does not migrate addresses or restart services.

## 2026-09-17 — Preserve the first recovery and attachment click

- Native release checks expose a commit/passive-effect ordering race: a late
  identity reset can close the freshly opened host-address dialog or invalidate
  the first explicit attachment preview request.
- Reset only these identity-bound local states in layout effects, before the
  controls can be used. Preserve the existing stale-request fences and exact
  dependencies; add no timers, polling or per-keystroke work.
- Add deterministic commit-phase click regressions. Both reproduce the old
  failure and pass after the correction; all 300 affected renderer tests and
  TypeScript checks pass. Rebuild the held desktop 1.0.2 source rather than
  publishing the failed candidate or weakening its tests.

## 2026-09-17 — Desktop 1.0.2 endpoint recovery prepared

- Add a single Change host address action for the current Team Network and
  saved approved connections, including offline members. Reuse one localized
  dialog with the previous address prefilled; preserve approval and routes.
- Require the additive member-side AgentsServer 1.0.2 capability. Verify the
  exact local server instance, saved connection and remote trust before a
  write; reject stale replies and leave inactive connections inactive.
- Retire old authenticated state only when a validated write begins, then
  revalidate the current connection once. A lost write response permits one
  status check, not a repeated mutation. Add no polling or per-keystroke work.
- Inspect the actual isolated Electron actions and dialog in light/dark,
  wide/narrow, error, pending and unsupported-server states. Exercise explicit
  save/cancel and confirm typing makes no global store writes. These UI checks
  use synthetic endpoints and cannot mutate real Team Networks.
- Prepare stable notes against desktop 1.0.1. The release also includes the
  committed independent Side chat, indexed Mail/Bulletin search, visible
  changed-file summaries and quiet syncing status. Unrelated unfinished
  changes remain excluded. Publication acceptance is recorded separately.

## 2026-09-16 — Local desktop 1.0.1 build 1170 accepted

- Package committed source `7f116b2` as an Apple Silicon local desktop build
  with the Details / Side chat inspector layout, independent follow-ups and
  retained drafts. Exclude unrelated unfinished worktree changes.
- Validate full desktop tests, type checks, production compilation and package
  guards. Confirm all 86 compiled files match the packaged archive and the
  Developer ID signature verifies; keep local auto-updates disabled.
- Exercise the actual isolated Electron panel in light/dark and wide/narrow
  layouts, including follow-ups, hide/reopen, cancellation and stale replies.
  Provider responses are mocked in these UI checks, not live model runs.
- Prepare the matching standalone server `1.0.1-beta.2` package. Side chat needs
  that server capability installed; neither server deployment, publication nor
  replacement of the running desktop application is part of this local build.

## 2026-09-16 — Side chat in the inspector dock

- Replace the temporary question dialog with a full-height Side chat tab next
  to Details. A labeled chat-header action opens and focuses it directly,
  leaving the main conversation visible and usable.
- Keep per-chat drafts and side answers in memory when the dock is hidden or
  Details is selected. Follow-ups carry only the side conversation's bounded
  completed question/answer pairs; Clear and Cancel affect only Side chat.
- Keep typing local and introduce no polling, main timeline subscription or
  normal chat turn. Fence in-flight work by server profile, generation, chat
  and request identity; unsupported servers explain the missing capability.
- Pair with the standalone server's additive side-history support. Packaging
  does not install, publish or restart either running application or server.

## 2026-09-15 — Independent side questions (unreleased)

- Add a localized Side question entry for Codex and Claude chats. Questions and
  answers stay in a temporary panel, with independent cancellation and explicit
  context limits; they never become a normal prompt, queued turn or goal steer.
- Use one request per question, with no polling or event subscriptions. Fence
  answers and cancellation by server profile, generation, chat and request ID;
  discard stale replies when a panel closes or the user changes chats/servers.
- Require the additive standalone server capability. Older servers explain the
  missing support instead of silently forwarding a question to the main agent.
- Validate request/cancellation races and the actual renderer in light/dark,
  wide/narrow, keyboard focus, pending, answer, error and localized states.
  No installed application replacement, server restart or publication.
- Guard cross-chat Markdown whitespace and preserve the exact sent body. The
  standalone sender guidance discourages joining words and technical values;
  historical text is not rewritten by speculative spacing corrections.

## 2026-09-15 — Keep file changes visible outside collapsed progress (unreleased)

- Keep known changed-file summaries and Review accessible when a turn's progress
  is collapsed. Show a compact filename list with aggregate line counts while
  leaving full diffs and tool activity behind their existing disclosures.
- Reuse recorded diff metadata without fetching activity or parsing arbitrary
  tool output on chat open. Keep scheduled-job summaries single-rendered.
- Validate completed and live-to-completed turns, collapse/expand, exact Review
  targets and scheduled-run identity. Check actual renderer layouts in light
  and dark themes at wide and narrow sizes with network access disabled.
  Type checks, desktop regressions and production compilation pass.
- Desktop-only presentation change; no polling, provider runs, server update,
  publication or running-app replacement.

## 2026-09-15 — Local desktop 1.0.1 build 1169 accepted

- Package committed source `9ca56af` as an Apple Silicon local desktop build,
  including explicit Mail/Bulletin search and the quiet synchronization status.
  Exclude unrelated unfinished worktree changes.
- Verify TypeScript, desktop regressions, compile/license guards and production
  compilation. Confirm all 86 compiled files match the packaged archive, the
  hardened Electron bundle passes its audit, and the Developer ID signature
  verifies. Keep local auto-updates disabled.
- No publication, running-app replacement or server deployment. Indexed search
  still requires the matching standalone server update; the synchronization
  status change works without it.

## 2026-09-15 — Quiet chat synchronization status (unreleased)

- Replace the uncertain incoming-delivery warning during chat synchronization
  with a muted “Syncing…” status. Keep known incoming-delivery notices and
  explicit Stop/Send now confirmations unchanged. This is a desktop-only
  presentation change with no new requests, subscriptions or server changes.

## 2026-09-15 — Indexed Mail and Bulletin search (unreleased)

- Add explicit Search/Enter and Clear controls to Inbox, Sent and Bulletin.
  Search current subjects, message contents and sender names across accessible
  history, with indexed server queries and explicit result pagination. Typing
  stays local; no polling, timers or per-keystroke requests are introduced.
- Keep filtered results separate from ordinary snapshots, unread counts and
  notification acknowledgements. Fence old-query and old-connection results;
  preserve route, read, edit and delete behavior for individual results.
- Capability-gate the feature on the matching standalone server contract and
  migration. Older hosts retain ordinary Mail with an update explanation.
  See [Mail search](TEAM_MAIL_SEARCH.md) for compatibility and migration notes.
- Validate renderer, IPC, direct and secure-peer paths, pagination, stale
  responses, notification isolation and current-content indexing. The actual
  renderer passes eight isolated light/dark and wide/narrow journeys: typing
  and idle issue no requests; Enter searches, open/back retains the query, and
  Clear restores the normal list. Type checks and production compilation pass.
  No published artifact, installed app or running server is changed.

## 2026-09-15 — Desktop 1.0.1 accepted

- Published stable [AgentsDock 1.0.1](https://github.com/ZhengyiLuo/AgentsDock/releases/tag/v1.0.1),
  build `1168`, from reviewed source `9a13649eb5a8f01d83c4c33b8bd3af3a70163cda`.
  Includes member self-rename, durable join observation and force-update
  confirmation recovery. See [release notes](RELEASE_1.0.1.md).
- All four native build and package gates passed, followed by independent
  package replay before publication. macOS is universal, Developer ID signed,
  notarized and Gatekeeper-accepted. Windows remains unsigned under the
  release owner's standing distribution policy; its status is explicit in
  both public release listings.
- The canonical and legacy repositories publish the same fourteen artifacts.
  Both stable update feeds resolve to `1.0.1` for macOS, Linux x64, Linux arm64
  and Windows. The sealed checksum manifest's SHA-256 is
  `b1fcdc86950f190891ee6c0ea4e9bd1fd8a4495886b821362ed270d6e5250b58`;
  the verified Mac update ZIP is
  `c0649157f5f31a7b9cea37f447f7a3e465666d3f5a4f5a057b764353f01dbfc9`.
- Confirmed the downloaded Mac package contains the member-rename renderer,
  preload and main-process implementation. No installed app, live server,
  mobile distribution or unrelated worktree change was included.

## 2026-09-15 — Member self-rename, desktop 1.0.1 candidate

- Committed member self-rename in `ee277b162b34a341d2d771e92bea2697342bcc3e`.
  The owned member's directory menu now offers Rename. Saving changes its Team
  Network display and recipient names in place, without changing its host role,
  peer identity, connection or local profile label. Other members remain
  protected; stale identities and mismatched receipts are rejected.
- Verified the real paired-service principal, whose identity is distinct from
  its directory node, along with legacy node-shaped sessions. The existing
  published server API passes isolated self-rename, read-only, reprovision,
  current-mention and new-mail-label checks; no server changes were required.
- A clean archive of the committed source passes TypeScript, 4,218 desktop
  tests (10 platform/intentional skips), eight compile/license guards and
  production compilation. The actual renderer passes isolated offscreen
  dark/light and narrow-layout checks for Save, Cancel and editable failures;
  saving preserves row identity and adds no polling or role-switch operation.
- Release notes are prepared in [RELEASE_1.0.1.md](RELEASE_1.0.1.md). Native
  release packaging and publication remain pending per-release Windows signing
  approval. This is not yet an accepted or published application package.
  No installed app or live server was changed.

## 2026-09-15 — Durable team join waiting (unreleased)

- Keep one automatic-join observer attached across long HTTP observation
  windows when the server confirms a durable pending approval or activation.
  Renew only the same held read, with unchanged request, transcript, server and
  cancellation fences. Reject early responses instead of creating a hot retry
  loop; do not add inbox polling, repeated Join requests or UI refresh timers.
- Make legacy expired incoming requests discoverable in a collapsed section,
  separate from pending approvals and without approval controls. A replacement
  request hides the stale attempt. New non-expiring joins require the matching
  standalone server change on both host and joining server.
- Accepted locally: 600 focused desktop checks, type checks, production
  compilation and compile-output verification. Inspect the real host panel
  offscreen at narrow width in light and dark themes, including expired and
  replacement requests; no overflow, new network calls or approval mutations.
  No package, installation, publication or live server restart performed.

## 2026-09-14 — Force-update status recovery (unreleased)

- Recover from a force-update confirmation refused because the queued update
  changed while the confirmation was open. Read status once; never retry a
  restart or update automatically. Follow an already-started update only when
  its schedule, target and track match the approved reservation.
- Show actual installer/preflight failures instead of a stale confirmation
  error. If status cannot be verified, re-enable Check server. Clear only the
  handled recovery notice after a successful check or server-scope change;
  preserve unrelated failures and ignore responses from an old server/boot.
- Support the existing beta.8 response, including bridges that preserve only
  its error prose. No server contract change or background polling is added.
- Validate focused confirmation-race and recovery regressions, the full desktop
  suite, type checks, production compilation and compile/license guards. Inspect
  the actual Settings dialog in isolated offscreen Electron in both themes,
  covering install progress, preflight failure and manual-check recovery.
- Source fix only: no new package, publication, installation or live restart.

## 2026-09-17 — Surface native artifact-open failures

- Propagate operating-system errors when opening an artifact so the existing
  desktop action handlers can report the failure.
- Add focused service coverage for successful opens, native error responses,
  and download failures using synthetic data and mocked native boundaries.

## 2026-09-14 — Desktop 1.0.0 replacement accepted

- Published desktop `1.0.0`, build `1167`, from committed source
  `45eb06c9db69cf0afad0fe8a1a38cf0823f1c035`. The canonical release is
  [AgentsDock v1.0.0](https://github.com/ZhengyiLuo/AgentsDock/releases/tag/v1.0.0).
  This includes the native subagent setting and corrected untitled-child
  headings. The separate server history-proof correction requires the rebuilt
  standalone server; installing the desktop alone does not repair server imports.
- The explicitly approved same-version replacement preserves a verified backup
  of the withdrawn package. Existing `1.0.0` installations need a manual
  download/reinstall; same-version automatic discovery is not claimed.
- All four native package gates pass. macOS is universal, Developer ID signed,
  notarized and Gatekeeper-verified; Linux x64/arm64 and Windows x64 artifacts
  pass their package and launch checks. Windows remains an explicitly approved
  unsigned preview. The platform source suites pass: 4,130 checks on macOS and
  each Linux architecture, and 4,094 on Windows, with platform-specific skips.
- Both public repositories contain the same fourteen sealed artifacts. All
  eight public update-metadata files match the accepted replacement bytes.
  GitHub permanently retired the deleted immutable legacy `v1.0.0` tag, so the
  [legacy compatibility mirror](https://github.com/ZhengyiLuo/AgentsDock-Releases/releases/tag/1.0.0)
  uses the exact tag `1.0.0`. App versions, package filenames, signatures and
  canonical `v1.0.0` are unchanged; the frozen legacy tag was not modified.
- Actual native updates from Stable `0.2.12` and Beta `1.0.0-beta.2` both install
  the new `1.0.0` ZIP, whose SHA-256 is
  `f6914dfc7cba0ab9d762e0185c41e948a98709afb87bf113b091c3abcab919c2`.
  Real UI download/install and native replacement/relaunch pass; each journey
  retains its profile, language and original channel, then checks the canonical
  feed. Final UI screenshots were reviewed. Validation used disposable CI
  profiles, not live user apps or servers.

## 2026-09-14 — Partial-page cross-chat replay regression

- Reproduce two old, owned async deliveries reimported as provider user text.
  Full-history desktop projection can correlate the original receipts; a
  recent-only page cannot establish that proof locally.
- Add regression coverage for the server's existing source-proven replay
  marker on recent-only pages, stale cache merges, older-page overlap and a
  genuinely user-authored quotation. Original agent messages and answers keep
  their positions. This adds no desktop runtime change or background polling;
  the correction requires the rebuilt standalone server package.

## 2026-09-14 — Untitled subagent headings

- Correct the inspector fallback for native children without an explicit
  title: show a readable task/path heading and retain the provider nickname
  underneath. Explicit titles, child identities, ordering and selected output
  remain unchanged; no polling or provider-state writes are added.
- Regression cases reproduce the former nickname-first behavior and cover
  null/omitted titles, title clearing, legacy identity fields, locale changes,
  separator-only tasks and sixteen simultaneously active children.
- Inspect the actual inspector in isolated offscreen Electron at narrow width
  in light and dark themes, including completed children and open output.
- Prepare an explicitly approved replacement desktop 1.0.0, not a version
  bump. Existing 1.0.0 installations need a manual reinstall to receive it.
  The desktop naming correction is separate from the rebuilt server's
  history-proof correction. Package and publication acceptance is recorded above.

## 2026-09-14 — Local subagent-settings build accepted

- Accepted Apple Silicon local `1.0.0-beta.2`, build `1165`, from committed
  source `a1ef7b0f6314b74c1244d8504f9643099fbf3eb7`. This supersedes local
  build `1164` with caller-bound server selection for settings requests.
- Type checks, focused native HTTP/service scope tests, production compilation,
  and the full desktop suite pass. One existing secure-peer cancellation test
  failed in the initial concurrent full run, then passed independently and in
  the full rerun; its source was not changed in this work.
- Isolated offscreen Electron validation covers light/dark narrow layouts,
  local typing, save/disabled states, compatibility hints and profile-switch
  races. It does not launch the production app or access a live server.
- All 86 packaged compiled files match validated output. Developer ID signature,
  hardened runtime, entitlements, fuses and packaged version checks pass.
  Existing app bundles are preserved; this package is not installed, notarized
  or publicly released, and local automatic updates are disabled.
- The control requires standalone server `1.0.0-beta.8`. Publishing that server
  is separate from updating a live installation; no live runs are interrupted.

## 2026-09-14 — Native Codex subagent setting

- Add Codex subagent limit to desktop Settings > Server. A positive integer
  sets the server's native provider override; clearing it uses Codex's default,
  not an unlimited sentinel. The main agent is excluded from this count.
- Read on opening the settings page and write only on Save. No polling,
  keystroke requests, chat-state writes or provider restarts are introduced.
- Show when an older server, non-admin connection or legacy exec transport
  cannot change the setting. Preserve drafts on failed saves and ignore stale
  replies after switching servers. Explain new/reloaded-thread scope and
  chat-specific override precedence; provide English and Chinese labels.
- Bind settings reads and writes to the server selection displayed by the
  renderer, checking it before dispatch as well as after the response. A stale
  screen cannot send its old draft to a newly selected server.
- Use exact native-admin GET/PUT transport with request validation. Real
  loopback transport and service-scope checks cover token framing, reset,
  errors and profile races; component checks cover local editing and no polls.
- Requires AgentsServer 1.0.0-beta.8 for the setting. That server release also
  fixes plain goal steering with automatically attached saved chat routes;
  the active goal's owner and existing permissions remain unchanged.

## 2026-09-14 — Project licensing

- Add the Apache License 2.0 and project attribution notice. Preserve existing
  Expo, SwiftTerm, native-module, and other third-party licensing terms.
- Document licensing in the README and contribution guide, and declare it in
  first-party desktop, mobile, website, and Team Hub package metadata.
- Include the project LICENSE and NOTICE in future Electron packages. Existing
  published artifacts and tags are unchanged; no release is cut by this change.
- Validate the canonical license text, package metadata, preserved component
  licenses, and Electron's actual resource-copy behavior with focused checks.

## 2026-09-13 — Local live-activity build

- Accepted local-only Apple Silicon `1.0.0-beta.2`, build `1163`, from
  `f76c1f4087d855924a4498f831d8c30e05b8ac0b`, including live activity freshness,
  quiet-run/compaction indicators and native Codex subagent display names.
- Type checks, the full desktop suite, production compilation and isolated
  light/dark renderer journeys pass. All 86 packaged compiled files match the
  validated output; strict Developer ID signature, entitlements and fuse checks
  pass. Existing app bundles were preserved.
- This local app has automatic updates disabled and is not notarized or
  published. It was not launched or installed over a running app.
- Source-proven duplicate answers and leaked native wake imports still require
  the matching standalone server update; this app alone cannot fix the older
  server's history reconciliation.

## 2026-09-13 — Live activity and mailbox replay

- Preserve newer streamed run ownership when an older health request finishes
  late. Connection-only notifications do not replace live activity with cached
  health. Fresh idle health can still settle a run whose terminal was missed.
- Show a compact Working indicator when an owned run has no visible trace yet,
  including a quiet mailbox wake. Show Compacting context during live compaction
  and animate the Running header; completed and historical views stay settled.
- Keep activity reconciliation local and scoped to the connected server. No
  polling, provider requests, synthetic chat messages or minimap rows are added.
- The separate large-history server correction also suppresses source-proven
  duplicate answers imported after mailbox wakes, retaining the original answer,
  peer deliveries and real human messages. It requires a server update.
- Type checks, the full desktop suite and production compilation pass. Isolated
  full-renderer checks cover quiet wake, live compaction, resumed progress and
  actual completion in both themes, with stable timeline geometry and no added
  user messages. The duplicate correction was also checked against source-proven
  native/import pairs without changing stored transcripts or message delivery.
- No installed app, running server or published release has been changed in
  this pass.

## 2026-09-13 — Codex subagent display names

- Show the explicit Codex child-thread title before its nickname, task or path
  fallback. Names stay literal in every locale. Nicknames and paths remain
  available in details; no names are generated from prompts.
- Accept optional `subagent_title` snapshots from the standalone server's
  existing thread metadata and name-update stream. Omitted or malformed fields
  retain the known title; explicit clearing restores the existing fallback.
- Keep one stable child row and update an already-open output panel's title in
  place. Naming does not introduce polling, new provider requests or UI timers.
- Desktop type checks, production compilation, the full suite and focused
  rename/clear/lifecycle regressions pass. Isolated full-renderer checks cover
  dark/light and narrow layouts, including renaming and clearing a title while
  the output panel stays open. The change requires the matching
  standalone server update to supply explicit titles. No installed application,
  running server or published release has been changed.

## 2026-09-13 — Large-history cron and mailbox replay correction

- Correct the standalone server's native-history proof path for large chats.
  Tool-heavy logs no longer bypass duplicate checks at a total-file-size limit.
  Incomplete or cancelled proof defers import without advancing its cursor.
- Existing desktop projection keeps the original scheduled-job group and purple
  mailbox delivery while suppressing only source-proven imported copies. Genuine
  human messages remain intact, including identical quoted text.
- Add a combined desktop regression fixture covering interior same-ID repairs,
  stale event replay, overlapping older pages and SQLite reopen. Type checks and
  focused tests pass. Isolated full-renderer checks verify the read receipt,
  chronology, chat reopen and renderer reload in light and dark themes.
- This requires a server update; no desktop runtime change, package, deployment
  or release was made. Delivery, wake behavior, jobs and provider transcripts are
  unchanged. No polling or per-event filesystem reads were added.

## 2026-09-13 — Video playback in shared chats

- Interactive shares now reuse the existing chat video thumbnails and player
  for videos attached to sent messages or explicitly published by the agent.
  View only snapshots include native video players for those captured videos.
- The matching standalone server provides token-checked playback and seeking
  for the exact shared chat. Unused uploads, unrelated files and workspace paths
  remain inaccessible. Revocation checks are demand-driven; no polling or extra
  stored video copies were added.
- Preserve native event identities and chronology through current, historical
  and trace views. Unsupported native file actions stay hidden in shared mode;
  the normal desktop file controls are unchanged.
- Desktop type checks, focused media/bridge tests, the full desktop suite and
  production compilation pass. Isolated server checks cover ownership, token
  entry, byte ranges, revocation, file mutation and cancellation cleanup.
- Isolated browser acceptance passed for an uploaded WebM and a distinct
  agent-published H.264 MP4 in both viewers: decoded frames, playback, seeking,
  separate token entry and blocked media requests after revocation. Testing
  used synthetic chats and hidden browser windows, not live user sessions.
- This requires a server update, including the generated shared-web bundle.
  Existing Interactive links can be refreshed afterward; older text-only View
  only snapshots must be recreated to include videos. Browser codec support
  still applies. No desktop package, server deployment or release was made.

## 2026-09-13 — Choose a LAN address for chat sharing

- Add one localized Share address field to the existing View only / Interactive
  dialog, defaulting to the selected server connection. Operators may choose
  another reachable HTTP or HTTPS address of the same server when creating a
  share. Previously created links and tokens are unchanged.
- Keep share management and native credentials on the authenticated connection.
  The chosen browser address is validated body data, never a probe or a new
  credential destination. Creation remains one-shot; malformed or mismatched
  responses cannot silently produce a link at the wrong address.
- Editing stays local to the dialog, with no polling, address discovery or
  background refresh. The existing standalone server contract supports this
  client change without an update or restart.
- Accepted local-only Apple Silicon `1.0.0-beta.2`, build `1162`, from
  `b8a100ce75782d22edb9529d90811b5360d67a6d`. Desktop type checks, the full
  desktop suite, focused address/response regressions, and production
  compilation passed. All 151 packaged compile-output files match; bundle/fuse
  audit and strict Developer ID signature verification passed.
- Isolated offscreen renderer checks passed for both modes, light/dark themes,
  narrow layouts, localized labels, keyboard activation, invalid addresses,
  busy state, draft reset, and unchanged existing links. These used synthetic
  services; no real chat share or recipient connection was created for testing.
- This build is not notarized or published and has automatic updates disabled.
  The running app and servers were left untouched.

## 2026-09-13 — Local main integration build

- Accepted local-only Apple Silicon `1.0.0-beta.2`, build `1161`, from
  `bc73ab326c5a6fcc4a8425be41384faf9ec3ff1a`, which merges public main
  `935a76b64af2b2a7c263a15d91af87342dd88381` into the release branch.
- Include the local-chat import label correction while retaining the released
  Team Network changes. Scheduled-job controls remain in each row's context
  menu; this fetched main does not contain visible inline action buttons.
- Type checks, focused import/menu checks and production compilation passed.
  All 151 packaged compile-output files match the source build; bundle/fuse
  audit and strict Developer ID signature verification passed.
- This local build is not notarized or published and has automatic updates
  disabled. No running app, installed server or published artifact was replaced.

## 2026-09-13 — Published server goal-steering correction

- Published [AgentsServer `1.0.0-beta.4`](https://github.com/ZhengyiLuo/AgentsServer/releases/tag/v1.0.0-beta.4)
  from immutable source `b5fa0728ede6e99f228685f625198b5bdcde20a0`.
  The full release gate, downloaded signature, public asset digests and all
  76 packaged source files passed verification.
- Preserve active native Codex goals when steering during the initial turn or
  a continuation, including uploaded attachments and between-turn delivery.
  Keep one chronological follow-up across acknowledgement rollover and prevent
  stale-prompt recovery after accepted or uncertain steering. No polling added.
- Existing desktop `1.0.0-beta.2`, build `1160`, supports this server correction;
  there is no new desktop binary for the regression-only app changes below.
- An accepted idle deployment schedule is not a completed installation.
  Live-provider acceptance remains separate from the isolated protocol tests.
  Stable readiness also requires resolving the idle-goal mailbox-authority
  limitation and completing the stable-upgrade and platform acceptance gates.

## 2026-09-13 — Active-goal steering regression coverage

- Verify Send now and Cmd/Ctrl+Enter while a goal is active across a pending
  server response, acceptance and rejection. The goal and other queued work
  remain unchanged; retries cannot duplicate prompt submission or promotion.
- Confirm native goal follow-ups retain attachment rendering when reopened.
  These are renderer regression checks accompanying a standalone server fix;
  no desktop runtime change or new app build is required.
- Full Composer tests, focused goal timeline tests and desktop type checks pass.
  No app or server installation, deployment or publication is part of this change.

## 2026-09-13 — Published Team Network and cross-chat beta

- Accepted direct desktop `1.0.0-beta.2`, build `1160`, from the immutable
  source `516213ddb27b4fc641c418609a7667d14e391918`. Native build and package
  verification passed for universal macOS, Linux x64/ARM64 and Windows x64.
  macOS is signed and notarized; Windows remains an unsigned beta preview.
- Published the identical 14-asset set to the
  [public release](https://github.com/ZhengyiLuo/AgentsDock/releases/tag/v1.0.0-beta.2)
  and [legacy mirror](https://github.com/ZhengyiLuo/AgentsDock-Releases/releases/tag/v1.0.0-beta.2).
  Both match checksum-manifest SHA-256
  `6fa6cb2877d411ef423ef0c808a10286cd919f0acc5727c364e1de0620b5c445`.
  The protected publisher independently replayed all platform verifiers;
  publication recovery retained the original artifacts and source identity.
- Include quiet, separately tracked Mail and Bulletin indications through one
  metadata-only connection. Refresh stays explicit; arrivals do not fetch
  content, move the current view, interrupt an agent or change a draft.
  Bulletin edits retain version history, and incomplete refreshes cannot clear
  attention to unseen changes.
- The matching
  [AgentsServer `1.0.0-beta.3`](https://github.com/ZhengyiLuo/AgentsServer/releases/tag/v1.0.0-beta.3)
  fixes Chats provider-tool stdin replies and returns an original canceled
  receipt on exact retries without resending or waking the recipient. The
  complete server release gate, downloaded signature, exact source contents
  and older-updater compatibility passed. An app-only update does not apply
  the server corrections.
- The isolated full-desktop lifecycle journey passed 15 checkpoints using
  actual renderer, IPC and SQLite cache with synthetic transport: sent/read/
  replied messages, disconnect/backfill, reopening, single canceled-message
  identity, explicit Bulletin refresh, author edit/history/delete and scope
  retirement. A 1,000-hint burst preserved drafts, focus and scroll position
  without content requests. Real helper/TLS server journeys additionally
  covered access revocation, concurrent reads, late arrivals and idle wakes.
- No user's active provider run or live server was used for these checks.
  Publication did not install or restart either component. Stable and mobile
  channels are unchanged.

## 2026-09-13 — Quiet Team activity and cross-chat delivery regression

- Local, unreleased candidate: extend the existing single Mail notification
  connection with an independently tracked Bulletin cursor. Posts, revisions
  and deletions produce metadata-only hints; older servers retain Mail v1.
- Show quiet navigation indicators and explicit refresh affordances. Arrival
  never fetches content, navigates, interrupts an agent, or changes a draft.
  Main-process publications coalesce bursts, with no recurring idle timer;
  only small indicator components subscribe to pending state.
- A Bulletin refresh acknowledges the head captured before its complete fresh
  traversal. Partial, failed, cached or stale-scope loads cannot clear it, and
  an update arriving during refresh remains pending. Author-only, versioned
  Bulletin revisions remain supported.
- Add a cross-chat projection regression: an assistant's claim is not a send
  receipt. Actual registered/received events appear on both sides immediately,
  before recipient wake or read, without duplicate rows or repositioning.
  The matching standalone server corrects Chats provider-tool stdin handling;
  that fix and Bulletin v2 require a server update.
- Validation passed: TypeScript, the full desktop suite (3,972 tests passed,
  10 skipped), four compile-output guard tests, and production compilation.
  An isolated Electron UI journey checked dark/light and narrow Chinese
  layouts. A 200-hint burst caused no content/receipt requests or acknowledgments
  and preserved the draft node, text, focus and scroll container. Explicit
  refresh performed only the expected content requests and local acknowledgments.
- This source-change entry preceded release acceptance; see the published
  beta entry above. No live-server deployment is included.

## 2026-09-12 — Published 1.0 desktop migration bridge

- Published `1.0.0-beta.1`, build `1159`, from the exact reviewed source
  `885bfa9a382c734f7b66e9a2b6bb025333ba9d0a`. This is a beta migration bridge;
  stable `1.0.0` is not published.
- Native release builds and platform verification passed for universal macOS,
  Linux x64, Linux ARM64, and Windows x64. The macOS artifacts are Developer ID
  signed and notarized. Windows remains an explicitly unsigned beta preview,
  not a signed stable distribution.
- The release embeds the public AgentsDock desktop feed and preserves
  application identity, saved update-track preference, and explicit installation.
  Its Beta track can select a newer stable release without adding background
  polling or changing Team Network behavior.
- The exact 14-asset set is published in the
  [canonical public release](https://github.com/ZhengyiLuo/AgentsDock/releases/tag/v1.0.0-beta.1)
  and [legacy mirror](https://github.com/ZhengyiLuo/AgentsDock-Releases/releases/tag/v1.0.0-beta.1).
  Release API checks verified both releases' matching asset digests and sealed
  checksum-manifest identity. The source tag resolves to the reviewed commit above;
  checksum-manifest SHA-256 is
  `237bfd4ef1ed42fbe8e16b5549510eaea88a935296fa6b96903b5335486d169f`.
- The protected publisher replayed all four native platform verifiers and
  published the original sealed artifacts without rebuilding or replacing them.
  Canonical beta download links now point to the public source repository.
- Installed legacy-feed → public-feed upgrade acceptance passed on an isolated
  macOS runner using the signed production packages and actual updater UI.
  `0.2.13-beta.33` downloaded the bridge, completed native replacement and
  relaunch, and then checked the public feed successfully. The profile, Beta
  preference, and language were preserved. Installed application payload matched
  the published bridge; screenshots and a machine-readable receipt were retained.
  No operator app or live server was used for this acceptance journey.
- Current stable `0.2.12` downloads and the Android release feed remain on the
  legacy repository. No standalone server deployment or mobile release is part
  of this desktop migration.

## 2026-09-12 — Public desktop release migration

- Prepare the `1.0.0-beta.1` migration bridge with the public AgentsDock
  repository as its canonical desktop download and update destination.
  Keep the legacy release feed available for older installations and Android;
  publish the same verified desktop artifacts to both repositories.
- Beta subscribers can receive a newer stable release without losing their
  Beta preference. Selecting stable metadata during a normal Beta check does
  not enable downgrades. Existing startup and four-hour checks are unchanged;
  downloads still require an explicit install action to restart the app.
- Preserve application identity, signing requirements, saved settings and
  connections. Merge the current public UI and pinned-message navigation
  changes while retaining shared-chat restrictions and attribution.
- Validate release ordering against both feeds. Publication must pin the public
  source tag to the reviewed commit and resume mirrors only when the sealed
  source identity and artifact checksums match; published conflicts fail closed.
- Stable `1.0.0` remains a separate release gate. Existing stable downloads
  continue to use the verified `0.2.12` artifacts until that promotion.

## 2026-09-12 — Reusable-token chat sharing

- Keep share addresses separate from access tokens. Copy invitation includes
  both on separate lines; opening the interactive address requires manual token
  entry. Existing browser sessions can resume without storing raw tokens in
  browser storage. View-only sharing also offers an explicit token-in-link copy.
- Use one reusable token per share for multiple collaborators. Remove the
  one-person claim wording, and move revoked entries into collapsed history.
- Preserve initial-latest timeline positioning without new scroll timers or
  background refreshes. The matching server supplies paginated full-log
  snapshots and starts their viewer at the latest page.
- Focused component, bridge, URL-validation and timeline-position checks,
  TypeScript, the desktop suite and production compilation passed. Actual
  compiled desktop clicks verified both share actions, separate URL/token,
  copy/open dispatch, snapshot-only token links, and revoked-history folding
  against isolated fixtures without creating real shares.
- Accepted local arm64 candidate: `0.2.13-beta.37`, build `203`, source `699911b`.
  Developer ID signing, strict signature verification, bundle audit, and all
  151 packaged compiled-file byte comparisons passed. This local build is not
  notarized or publicly released; automatic updates are disabled. The running
  desktop was not replaced.
- These changes require AgentsServer `0.1.26-beta.66` or later. Server release
  and installation are tracked separately; the local app does not update a
  server automatically.

## 2026-09-12 — Two-action HTTP chat sharing

- Replace the preview/checkbox workflow with View only and Interactive actions.
  Each explicitly creates, copies and opens a link; existing-link revocation is
  available on demand without background refreshes.
- Derive share addresses from the selected native server connection. Support
  direct HTTP as well as HTTPS without requiring a separately configured domain.
  This requires the matching standalone server change; an app update alone is
  insufficient. HTTP is intended for trusted networks and is not encrypted.
- Serve a styled static snapshot with user bubbles, assistant Markdown, dates
  and responsive light/dark layouts. Interactive sharing reuses the chat UI and
  keeps explicit one-time Join, chat-scoped access, same-origin and CSRF checks.
- Verified actual compiled desktop right-click, both creation buttons, exact
  copy/open dispatch and lazy existing-link management with isolated fixtures.
  Verified served pages on a genuinely non-secure HTTP browser origin: Join,
  reload, prompt, queue Send now, Stop, wrong-origin/CSRF denial and used-invite
  denial. Static pages were checked at desktop and mobile widths in light/dark
  themes. These synthetic journeys did not execute providers or expose real chats.
- Accepted local arm64 candidate: `0.2.13-beta.36`, build `202`, source `ce1e0d9`.
  Production compilation, desktop checks, strict Developer ID signature, bundle
  audit and exact packaged main/preload/renderer byte comparisons passed.
  Automatic updates are disabled; this local candidate is not notarized or
  published. The running desktop was not replaced. Server changes are committed
  separately and were not deployed by this validation.

## 2026-09-12 — Quiet idle-mail wake presentation

- Keep the server-generated mailbox availability input out of the user-message
  timeline while retaining the receiving agent's progress and final answer.
  Suppression requires exact native wake metadata, not matching message text.
- Preserve genuine user inputs and unproved imported history. Verified cold and
  incremental projection for Claude and Codex with focused checks and TypeScript.
- Idle execution requires the corresponding standalone server change; this
  desktop change alone does not wake an idle recipient or update its server.
- Validated the compiled Electron renderer with synthetic Claude and Codex
  live-progress, completion and sidebar-reopen journeys. Each retained one
  genuine user bubble and both original and wake answers, without duplicate
  output or an internal wake notice. No live provider execution was exercised.
- Accepted local arm64 candidate: `0.2.13-beta.35`, build `201`, source `ffe6168`.
  Production compilation, desktop tests, strict Developer ID signature, bundle
  audit and matching packaged main/preload/renderer bytes passed. The app has
  automatic updates disabled; it is not notarized or published. The running
  desktop was not replaced.

## 2026-09-12 — Local desktop beta.34 candidate

- Accepted local universal macOS installer: `0.2.13-beta.34`, build `157`, exact
  committed source `85654170df60df954d0efea1f68d0fd34e37a2a2`.
- Verified Developer ID signing, notarization ticket, Gatekeeper acceptance,
  embedded version/build and updater ZIP checksum. This candidate includes the
  large-share preview and browser-sharing changes described below.
- Desktop publication was canceled at the user's request. No public beta.34
  release was created; the installer was retained locally and the running app
  was not replaced. The signed candidate has normal direct-update support.
- Full cross-platform release acceptance is not claimed: macOS and Linux x64
  build jobs passed, an ARM renderer fixture exposed a passive-effect assertion
  race, and the remaining workflow was canceled. The fixture correction is
  retained separately and is not part of this installer.

## 2026-09-12 — Large chat sharing

- Preview and confirm text snapshots independently of raw tool-log size and
  message count, retaining bounded UTF-8 snapshot and individual message sizes.
  The matching server release preserves existing shared links and revocations
  when upgrading snapshot storage.
- Page the review dialog in groups of 20 messages, resetting scroll position on
  each page. Confirmation still covers the complete reviewed snapshot, not just
  the visible page. Strip native IPC boilerplate from share errors.
- Give snapshot requests transport headroom beyond the server's bounded scan;
  do not change unrelated request deadlines or add retries or background work.
- Verified the actual desktop right-click, preview, paging, confirmation and
  old-server error journey with a synthetic 2,384-message snapshot and a source
  boundary larger than 64 MiB. Only 20 message elements were mounted at once;
  confirmation from the second page retained the original full-snapshot digest.
- Interactive sharing requires the matching standalone server implementation;
  publishing the desktop alone does not add missing server endpoints.

## 2026-09-12 — Shared-browser recovery and control parity

- Resume an already joined browser session on reload without consuming another
  invitation. Preserve session identity when loading older timeline pages.
- Disable shared provider controls and close permission popovers when access is
  lost; retain a usable Close action and explain the disconnected state.
- Stop further writes after an uncertain acknowledgment instead of offering an
  automatic duplicate send. Do not misreport an accepted action as failed when
  only its subsequent refresh fails. Release failed local upload staging slots.
- Expand exact cross-chat message bodies on demand within the shared chat,
  preserving recipient edits without sending messages or marking mail read.
- Wire the web file-drop surface into the existing one-way upload path. Reject
  oversized selections before staging a partial selection. Native desktop file
  selection behavior is unchanged.
- Rechecked the actual compiled shared renderer in an isolated Chromium browser:
  join/reload, older history, expanded message scrolling, queue controls, Stop,
  goal controls, settings/models/permissions, approvals, schedules, uploads,
  pushed owner results, one-use invitations and read-only/interactive revocation.
  The idle stream made no additional chat-history requests across its heartbeat.
  Provider callbacks and owner state were synthetic, not production research jobs.
- The final web pass also verified Claude approval/Stop and revoked-popover
  behavior, actual rejected/accepted file drops, a narrow light-mode layout and
  lost-response duplicate prevention. Confirmed reload after a retained draft
  created a fresh document and restored one accepted queue receipt without a
  resend. Claude permissions saved and re-rendered through browser form events;
  native OS popup interaction remains unverified because the isolated window
  could not take keyboard focus.
- Accepted local arm64 candidate: `0.2.13-beta.33` build `200`, committed desktop
  source `d44e1ad`. Developer ID signature and all 86 compiled archive files
  verified. The running app was preserved; this candidate is not notarized or
  published and has automatic updates disabled. The subsequent web-only drop
  change is included in the separately packaged shared renderer at `6839cf2`.
- The matching standalone server changes and web bundle are committed locally,
  not deployed. Public HTTPS ingress and real provider execution remain separate
  deployment acceptance steps. No direct file, terminal or other-chat API was
  added to guest access; sharing remains trusted agent collaboration, not a sandbox.

## 2026-09-12 — Receipt-based outgoing chat status

- Replace the unconditional outgoing “Sent to” heading with “To” and an
  explicit status. Distinguish unconfirmed delivery, stored unread mail,
  agent-read receipts, cancellation and failure; preserve legacy queue status.
- Correlate receipts to the exact message and participants. A default unread
  state or registration event alone is not proof of mailbox storage. Reading
  is not represented as processing or replying.
- Preserve target navigation, on-demand message expansion and existing
  controls. Add no polling, automatic resend, agent invocation or server change.
- Verified synthetic receipt states in the actual desktop renderer, including
  on-demand expansion and target navigation, plus focused component checks.
  These checks do not establish the delivery of any particular live message.
- Accepted local arm64 candidate: `0.2.13-beta.33` build `198`, source
  `2734708`. Developer ID signature and all 86 compiled archive files verified.
  The running app was preserved. This candidate is not notarized or publicly
  released and has automatic updates disabled.

## 2026-09-12 — Full control within a shared chat

- Expand the interactive invitation disclosure and required confirmation to
  full control of the one shared chat: prompt/upload, stop/steer, send queued
  messages now, manage the queue, change model/chat settings and permissions,
  manage goals, and create/edit/delete scheduled jobs.
- Retain the boundary against direct terminal access, file browsing/download,
  other chats and server administration. The collaborator can still ask the
  existing agent to use its tools and context; this is not a tool sandbox.
- Explicitly explain that revoking access does not undo accepted work or
  scheduled jobs. Snapshot sharing remains read-only and unchanged.
- Reuse the native timeline, composer, queue, approvals, goal and schedule
  components in the token-scoped browser view. Keep file browsing/downloads,
  working-directory controls, terminals, other chats and administration out.
- Receive shared-chat changes through one demand-open stream, not polling.
  Keep model choices across updates and refresh cached Codex/Claude status
  after a snapshot commits. Use the native positioned settings modal.
- Validated the compiled browser UI against the isolated token router and
  native adapters with synthetic provider/store mutations: prompt queueing,
  edit/reorder/send-now/stop, goal pause/resume, settings and permissions,
  model choices, schedule create/edit/delete and approval responses. Verified
  that a second browser cannot reuse an invitation and revocation disables
  further guest actions and ends the live stream. No
  production provider run or live user job was started by these checks.
- The expanded guest controls require the matching standalone server update;
  this source change does not deploy or publish that server.
- Accepted local arm64 candidate: `0.2.13-beta.33` build `197`, desktop source
  `ed1b20e`. Developer ID signature and all 86 compiled archive files verified.
  The running app was preserved. This candidate is not notarized or publicly
  released and has automatic updates disabled. The subsequent settings-modal
  correction affects only the separately packaged web renderer.

## 2026-09-12 — Explicit chat sharing

- Add right-click **Share chat** with two separate choices: a reviewed,
  read-only text snapshot and a one-time invitation to a live chat.
- Interactive sharing explicitly grants trusted use of the existing agent's
  tools/context. The guest web surface has no native terminal, file browser,
  downloads, other chats, or administration; it is not a provider sandbox.
- Use exact native-authenticated, server-scoped management requests with no
  redirects or automatic retries. Show missing HTTPS hosting honestly, retain
  new link secrets only in the open dialog, and provide exact revocation.
- Mark shared-chat prompts as Collaborator in the timeline and queue. Do not
  add an inbox poller, background navigation, or automatic sharing.
- Validated the actual isolated Electron right-click/preview/confirmation,
  copy/revoke and collaborator-label journey against synthetic share responses,
  plus actual loopback native-header transport and affected regression checks.
  New interactive sharing requires the separately updated standalone server;
  no server deployment or public app release is included in this source change.

## 2026-09-12 — Preserve proven assistant replay corrections

- Keep exact server-proven Codex and Claude assistant replay corrections in the
  local SQLite cache when an older page or buffered stream repeats the same
  event. Reuse the existing identity/provenance merge checks; do not infer
  duplicates from similar text or remove original scheduled reports.
- The standalone server also corrects Codex history comparisons when native
  delivery removed leading decorations from the same provider message. That
  server correction is separate and requires deployment before historical
  duplicates can be repaired. No polling or background refresh was added.
- Verified the actual isolated Electron service, SQLite cache and renderer:
  repair, stale replay, switching chats and reload preserve corrections while
  all original scheduled reports, genuine messages and the running job remain
  intact. Provider transport was synthetic. Claude's equivalent cache path was
  verified with SQLite close/reopen and shared provenance checks, not a second
  graphical journey.
- Accepted local arm64 candidate: `0.2.13-beta.33` build `193`, source `c9c5210`.
  Developer ID signature and all 86 compiled archive files verified. The
  running app was preserved; this candidate is not notarized or publicly
  released and has automatic updates disabled. The standalone server patch
  is committed separately and has not been deployed.

## 2026-09-11 — Cross-chat heading navigation

- Make the sender or recipient name on purple cross-chat messages open the
  exact referenced chat. Grouped inbox messages keep a separate unread-count
  disclosure, so clicking the sender does not expand or consume mail.
- Reuse normal chat navigation without additional requests, polling or route
  grants. Guard the originating server scope; do not resolve duplicate display
  names or turn imported label-only messages into guessed links.
- Verified actual isolated Electron navigation for Codex and Claude, both
  directions, keyboard activation, historical exchange legs and grouped inbox
  messages. Unread mail remains unread and collapsed after returning. The
  synthetic transport recorded no mail or execution actions.
- Accepted local arm64 candidate: `0.2.13-beta.33` build `192`, source `9fae5cff`.
  Developer ID signature and all 86 compiled archive files verified. The
  running app was preserved; this local candidate is not notarized or publicly
  released and has automatic updates disabled. No server change is required.

## 2026-09-11 — Lazy history repair after server upgrades

- On an observed server-version change, invalidate only that server's cached
  history verification. Opening a chat then uses the existing bounded
  authoritative history check so corrections to older messages are received.
- Do not clear cached content on version change or refresh every chat.
  Repeated health responses do not trigger another invalidation. Version and
  verification changes share one transaction, preserving retryability if
  storage is exhausted. Failed or offline history requests keep cached content.
- Verified the actual isolated Electron health-upgrade journey: one lazy
  history audit corrects older runtime records, genuine inputs and answers
  remain visible, and the unsent draft survives. Repeated health responses,
  switching chats and reloading do not repeat the audit or fetch unopened
  chats. Transport was synthetic; no live provider run was started.
- Accepted local arm64 candidate: `0.2.13-beta.33` build `190`, source `fb986357`.
  Developer ID signature and all 86 compiled archive files verified. Automatic
  updates are disabled; this candidate is not notarized or publicly released.
  The running app was left untouched. Historical corrections require standalone
  server `0.1.26-beta.61` and reopening the affected chat after the upgrade.
- Published standalone server `0.1.26-beta.61` from `34b66875` after its full
  release validation passed. Verified the downloaded manifest signature,
  archive digest and all 67 packaged files against the committed source.
  Managed activation is when-idle; publication does not imply installation.
  No public desktop or mobile release was made in this pass.

## 2026-09-11 — Typed provider notice coverage

- Extend the same source-proven runtime metadata contract to known provider
  compaction summaries and infrastructure notices. A provider user-role record
  is not automatically a message authored by a person.
- Keep real user text, quotations, assistant output and live activity intact;
  preserve exact repairs through stale event replay and disk-cache reloads.
  No background refresh or polling is added. Historical repair requires the
  matching standalone server update.
- Verified mixed Codex and Claude messages in the actual isolated Electron
  service, SQLite, IPC and renderer: user input, quotations, public progress,
  expanded tool details, final answers, goal activity, scheduled output and
  passive purple mail remain visible. Runtime notices stay out of user bubbles
  across stale replay and reopening. Transport was synthetic; unknown future
  provider formats and live provider execution are not certified by this check.
- Accepted local arm64 candidate: `0.2.13-beta.33` build `189`, source `864e15de`.
  Developer ID signature and all 86 compiled archive files verified. Automatic
  updates are disabled; the app is not notarized or publicly released. Historical
  repair requires standalone server `0.1.26-beta.61`; the running app was left
  untouched.

## 2026-09-11 — Codex interruption notice provenance

- Apply the source-proven runtime notification contract to typed interruption
  notices as well as subagent completions. Neither becomes a message from the
  user, and an old imported notice does not stop current work.
- Preserve genuine user quotations and retain exact corrections across stale
  event responses and disk-cache reloads. Historical corrections require the
  matching standalone server update; this is a local desktop change only.
- Verified both runtime notice types together in the actual isolated Electron
  service, SQLite, IPC and renderer: source-proven corrections, stale replay,
  switching chats and reload preserve genuine quotations and assistant output.
  Provider transport was synthetic; no live provider turn was started.
- Accepted local arm64 candidate: `0.2.13-beta.33` build `188`, source `9cbed1e3`.
  Developer ID signature and all 86 compiled archive files verified. Automatic
  updates are disabled; this candidate is not notarized or publicly released.
  The running app was left untouched. Historical repair requires standalone
  server `0.1.26-beta.61`.

## 2026-09-11 — Codex subagent notification provenance

- Treat source-proven imported subagent completion notifications as runtime
  metadata, not messages authored by the user. Preserve genuine quotations,
  assistant answers, native subagent activity and original timestamps.
- Keep the exact correction across stale same-ID events and disk-cache reloads;
  require source identity, a full-text digest and no positive human provenance.
- Verified the actual isolated Electron service, cache and renderer: the legacy
  bubble is corrected, a genuine identical quotation remains, and stale replay,
  switching chats and reloading do not restore the bogus input. Transport and
  provider history were synthetic; no real provider turn was started.
- Historical repair also requires the matching standalone server correction.
  No mobile or public desktop release is included in this local change.

## 2026-09-11 — Storage recovery and native history replay

- Keep the desktop open after local storage exhaustion. Preserve the original
  database and saved drafts; use temporary storage only for rebuildable cache
  data. Failed draft saves block window close, with an explicit Retry saving
  action after space is freed. An incomplete legacy credential migration keeps
  its original settings protected and requires reopening after recovery.
- Prevent failed event-cache batches from advancing the durable history cursor.
  Handle browser storage quota errors in layout controls without crashing React.
  Recovery is user-triggered, with no new storage or inbox polling.
- Recognize the server's exact source-proven native replay marker. Keep original
  human messages and scheduled reports, suppress only verified imported copies,
  and preserve the correction when an older cached response arrives later.
- Verified disk-full startup, preserved drafts, failed-close handling and a
  successful explicit retry using the actual desktop service, SQLite, IPC,
  preload and renderer with isolated fault injection. The system disk was not
  filled, and no provider turn was started by this check.
- Verified the native replay correction in the actual isolated Electron UI:
  duplicate history is removed while the original human message, scheduled
  report and genuine later question remain, including after switching chats
  and reloading. Preserve unmatched output across silent imported boundaries.
- Accepted local arm64 candidate: `0.2.13-beta.33` build `186`, source `a4fc5ba1`.
  Developer ID signature and all 86 compiled archive files verified. Automatic
  updates are disabled; the app is not notarized or publicly released, and the
  installed/running app was not replaced. Historical corrections and passive
  mailbox reads require standalone server `0.1.26-beta.61`.

## 2026-09-11 — Passive agent mailbox

- Show passive incoming agent messages as compact purple sender groups in
  chronological position. Only adjacent messages are grouped; human follow-ups
  and progress remain boundaries. Preserve individual identities and replies.
- Expand and delete exact messages on demand. Opening a message does not mark
  it read by the agent. Long expanded bodies have a bounded scroll surface.
- Use the existing event stream, without inbox polling or duplicate execution
  queue rows. Grouping is linear and preserves immutable cached inputs.
- Verified the actual desktop main process, cache, IPC and renderer with
  synthetic transport: grouping, edited full-body scrolling, exact deletion,
  read-state updates and reopening. This is not a live-provider execution test.
- Requires the matching standalone server mailbox contract. No server
  deployment or public release is included in this local implementation.
- Accepted local arm64 candidate: `0.2.13-beta.33` build `185`, source `bac1876e`.
  Developer ID signature and all 86 compiled archive files verified. Automatic
  updates are disabled; this candidate is not notarized or published, and the
  installed/running app was not replaced.

## 2026-09-11 — Scheduled history ownership

- Keep explicitly job-owned output inside Scheduled Job cards even when a
  paged response omits the start event or scheduled-purpose field. Match cold
  history, incremental updates, and late ownership metadata.
- Preserve ordinary imported/user messages and independently rendered
  emergency, Mail, and cross-chat receipts.
- Older Claude imports also require the standalone server's source-proven
  historical-page correction; this desktop change does not replace that repair.
- Local arm64 candidate: `0.2.13-beta.33` build `184`, source `3088ead6`.
  Production build, signature and all compiled archive files verified; not
  notarized or published. The installed/running app was left untouched.

## 2026-09-11 — Expanded queued messages

- Keep expanded message rows at their natural height so the queue scrolls
  instead of clipping the body. The queue retains its existing height limit.
- Verified long Codex and Claude messages with wheel scrolling to the final
  paragraph, reachable queue actions, and collapse in light/dark narrow views
  using the actual desktop renderer and synthetic transport.
- Accepted local arm64 candidate: `0.2.13-beta.33` build `183`, source
  `a300d1d9`. Signature and compiled archive verified; not notarized or
  published. No server update is required.

## 2026-09-11 — Chronological agent messages

- Place agent messages between the progress before and after their send or
  delivery-start event. Keep the sender's live or stopped state below the
  message, and retain that position when delivery receipts arrive later.
- Preserve earlier answers during incremental receipt updates. Keep tool
  calls and results together when activity is split around a message, including
  explicitly loaded trace pages.
- Preserve full queued message bodies, recipient edits, and compare-and-swap
  revisions during stream updates and stale receipt replay.
- Do not display scheduled-job input as a public result. Preserve genuine
  user-authored quotations of provider control text.
- Validated live, completed, queued-reply, and reopened views in the actual
  desktop renderer with synthetic Codex and Claude transport. Checked both
  themes, narrow layout, and typing/scrolling in long cached conversations.
  This does not certify live provider execution, server history pagination,
  or minimap navigation. No server deployment or public release is included.
- Accepted local desktop candidate: `0.2.13-beta.33` build `182`, arm64,
  source `22a19ce1`. Developer ID signature and compiled archive contents
  verified. Final desktop UI pass includes stop-after-send, late delivery
  receipts, and reopening for both providers. This candidate is not notarized
  or published, and its automatic updater is disabled.

## 2026-09-11 — Current desktop development

- Bring current desktop changes into this repository: source-proven history
  deduplication, readable asynchronous agent-message queues, revision-safe
  recipient edits, explicit Send now priority, and actual chat names.
- Include on-demand Mail threads, agent-only replies, searchable chat routing,
  guarded Host rename, negotiated unlimited chat routes, and Team Network
  translations. Quiet arrival hints update a badge without polling Inbox
  contents or navigating away from the current chat.
- Include native provider skills and commands in the slash palette, retaining
  capability negotiation and unsupported-server fallbacks.
- Preserve synthetic test data, the source-only CI boundary, and the existing
  public binary update feed. No release, native mobile build, or server
  deployment is part of this source migration.
- Validation: desktop type checks, the complete desktop test run, and the
  production bundle build passed. Local validation used Node 26; source CI
  remains pinned to the documented Node 24 environment.

## Source verification

- Mobile CI now runs the cross-chat protocol, projection, route/queue race,
  rendering, recipient-picker, and native-workspace resolution regressions.
- The additional checks use synthetic data and mocked native boundaries;
  source CI still does not build signed applications or publish releases.

## Documentation

- Reorganized the README into a product overview, installation steps, and
  separate desktop, mobile, and website development workflows.
- Clarified the client/server boundary, current versus legacy client sources,
  and the distinction between local builds and release publishing.
- Checked development commands against package scripts and source CI, and
  checked installation guidance against the standalone server documentation.
- Refreshed the public README hero with a centered product introduction,
  website, community, and release badges, and an approved desktop and mobile
  product image. Placed the introduction below a more compact product image to
  keep the opening layout focused.
- Updated the introduction to name the currently supported agent backends,
  speak directly to AI researchers, and provide direct current download links
  for every available platform with a matching desktop release badge.
- Verified the README with GitHub's Markdown renderer and checked every new
  destination and badge URL before review. Reviewed the supplied image and its
  metadata before inclusion.

## Mobile cross-chat parity — 0.1.1 (171)

- Apple validation and processing completed successfully; build 171 is active
  for internal TestFlight testing with automatic notifications enabled.
  External beta review was not submitted. Binary source: `aa1153be`.
- Align mobile with the current desktop async agent-message protocol: one
  Markdown card per message, pending incoming messages in the queue, and
  delivery-time chronology without duplicating internal provider prompts.
- Show granted chat access, pending grants, route limits, loading/errors, and
  revision-safe Revoke controls. Reconnects fence stale requests and callbacks.
- Add exact queued-message removal with truthful confirmation, duplicate-tap
  protection, and desktop purple pending-message styling.
- Include offline server inboxes in `@@` discovery and distinguish capability-gated
  `@@bulletin` posts from `@@all` inbox broadcasts.
- Validate real component handlers against synthetic native hosts, projection
  and store/API race regressions, broad library tests, and native build checks.
  Synthetic rendering does not substitute for physical-device touch/pixel QA.
- Release preparation uses generated, ignored native projects and resolves the
  configured workspace name rather than assuming the legacy project name.
- Signed arm64 iPhone/iPad archive and exported IPA passed deep signature,
  framework ABI, version, production-entitlement, and matching-symbol checks.
  The production JavaScript bundle contains the new features and excludes the
  visual test fixture.

## Source snapshot

- Includes the Electron desktop and React Native mobile clients, legacy Swift
  targets, compatibility fixtures, and project documentation.
- Private development history, operational incident notes, and unreviewed
  screenshots and recordings are not included.
- This source snapshot does not itself publish or change any installed release.

## Electron workflow controls

- Added native provider skills and commands to the composer slash palette.
- Refined scheduled-job status, direct actions, working-directory navigation,
  and compact unavailable-agent guidance.
- Added a grouped keyboard-shortcuts page to Settings with localized labels.
- Documented privacy-preserving usage events for these workflows.
- Validated the affected Electron behavior with focused tests, type checking,
  a production build, and a local desktop UI pass.

Future entries should describe public-facing changes and validation without
including credentials, user data, private infrastructure, or internal history.

## Recovered Codex turns do not duplicate user messages

History reconciliation now recognizes exact public Codex message items even
when Stop or server-restart recovery omitted the normal completion receipt.
It repairs already imported copies and prevents duplicate inputs on subsequent
imports without rewriting the transcript. Genuine repeated messages in distinct
turns remain visible.

The new recovered-stop regression failed before the change and passed afterward;
all 40 native history-repair tests passed. The signed desktop build 1245 was
exercised against an isolated patched server over its real HTTP interface using
a synthetic recovery ledger/provider transcript: the original input and answer
remained visible, the replay was hidden, and a genuine later repeat survived
reopening. No live provider turn, user installation, release, or service restart
was part of this replay acceptance.

### Pending idle updates leave scheduled work running

An update reserved for when the server is idle no longer blocks automatic
scheduled jobs or automatic titles. These use the same update admission policy
as ordinary turns. Previously parked, unchanged schedule occurrences are
rearmed on startup or update-status reconciliation without cancelling the
pending update or rewriting edited schedules.

Idle updates also wait for queued messages, including already persisted ones,
instead of treating their ability to survive a restart as permission to jump
ahead of them. Existing active-work checks remain in place. Explicit force
updates keep their separate, confirmed behavior.

The focused scheduler, update, admission, status-reconciliation, and generated
title suites passed (248 tests). The unchanged signed desktop build 1245 was
exercised against an isolated patched server with real Codex: an automatic
scheduled turn completed and appeared in the chat while another chat's native
tool continued and the update stayed pending. The pending reservation was a
test fixture with updater polling disabled; no installation or live deployment
was exercised. Provider credentials were copied only into disposable test state
and the original remained unchanged. This is a source fix, not a published beta.

## 2026-10-02 — Codex browsing and unchanged sign-in rechecks

- Selecting, reopening, or reconnecting a chat now reads Codex status without
  automatically resuming its native thread. Explicit provider controls still
  load a persisted thread; normal Send uses the existing server resume path.
  Browsing therefore does not hold the provider lifecycle lock needed by Send.
- Recheck CLIs no longer retires a native Codex process when its known sign-in
  revision is unchanged. Subagent inspection can read the owning process while
  a genuine login handoff is pending. Native request/callback ownership scopes
  idle handoff to the affected chat, preserving other chats' ongoing work.
- Validation: 54 desktop controls tests, TypeScript checking, production compile
  and compiled-entry verification; 130 targeted server tests. A local compiled
  Electron app exercised real authenticated HTTP and native Codex in isolated
  state: first message and follow-up both produced the expected answers, browsing
  an unloaded persisted chat issued zero native-load requests, and an unchanged
  sign-in recheck allowed the follow-up while another chat's shell work completed
  without interruption. Original credentials were unchanged; test copies removed.
- Acceptance boundary: this validates unchanged-sign-in rechecks, not migration
  between different real accounts. An earlier forced process-retirement probe
  encountered Codex's retained native writer after unsubscribe; that probe is
  failed, and genuine cross-process credential handoff remains unaccepted.
  No public release, installed-app replacement, or live-service deployment.
