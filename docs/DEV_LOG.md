# Public development log

## 2026-10-31 - Prepare coordinated 1.0.12-beta.1

- Integrate main `827ed452140db0a09bfab39905aa133f736871be` with stable
  `1.0.11` release protections for the next beta desktop, npm server, short
  CLI and signed legacy bridge. Preserve the stable channel and existing
  immutable release artifacts.
- Retain main's native child ownership checks together with the released
  subagent activity labels, Side chat progress and per-turn runtime settings.
  Preserve mailbox delivery for older paired-route callers while carrying
  main's server-attested user delegation and reply identity checks.
- Advance Claude's runtime configuration revision so existing release sessions
  receive the updated native tool policy. Include notification and unread-state
  modules consistently in both runtime package formats.
- Local validation: desktop TypeScript and production build pass, along with
  the full desktop test suite and release-tooling Node/Python checks. Focused
  server merge checks pass after isolating inherited service selectors in the
  local test process. Native package and hosted source checks remain pending.
- Hosted source CI and all eight canonical server shards passed. The separate
  signing gate exposed a read-only preparation test comparing access timestamps;
  its own file/link reads can change those timestamps. Compare contents and
  exact inode, ownership, mode, size, link count and nanosecond write timestamps
  instead. Runtime behavior is unchanged; rerun the signing gate from the new
  committed test source before accepting any package.
- See [candidate notes](RELEASE_1.0.12-beta.1.md) for public changes and the
  known idle Codex goal-resume limitation. Package and native acceptance remain
  pending; this entry records preparation, not publication or deployment.

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

## 2026-10-26 — Prepare stable 1.0.11 from the published beta.12 source

- Start the stable candidate at published beta.12 product source
  `ab95ad3284f91997c2b249ac413b155f99c09ce6`. Preserve its desktop, server and CLI
  functionality; only the release version and preparation documentation change.
  Later main changes are outside this release.
- Prepare matching desktop, npm runtime, short CLI and signed legacy bridge
  packages as version `1.0.11`. Exact new package verification and local native
  upgrade acceptance remain pending; prior beta checks are not relabeled.
- Hold public publication until populated provider-history retention,
  busy/queued work, restart and recovery observations have been reviewed.
  No mobile build or publication is included. See [candidate notes](RELEASE_1.0.11.md).

## 2026-10-21 — Prepare 1.0.11-beta.12 source

- Integrate main through `b21ef7ea20bd8bc1121708590fa3bc21785c0984` with the
  published beta.2 release line. Retain the shipped Codex streaming, pending
  update, CLI PATH and managed service lifecycle protections.
- Include CLI pairing QR output, shared-chat analytics, connection recovery,
  Claude fork timestamps, and the server's Codex goal summary fields used by
  notification clients. Existing mobile changes come from main; no mobile
  package is built or uploaded as part of this preparation.
- Pin the reviewed beta.12 installer separately from every historical pin.
  Keep historical release exception tests tied to their exact original source
  fixtures, and include the pairing modules in the inert npm PATH test package.
- Focused desktop checks (1,263 cases), TypeScript and production compilation
  pass. CLI, installer, packaging, session-summary and release-tooling checks
  also pass after correcting isolated test setup. Full source CI and exact
  signed candidate acceptance remain pending.
- This is source preparation only. The new candidate still requires native
  first-install and upgrade acceptance, active-work safety, and notification
  checks through the actual client/server boundary. No new npm package,
  desktop release, bridge, mobile build or installed service is changed.

## 2026-10-21 — Verify public bridge and npm server upgrades

- On disposable GitHub-hosted Macs, exercise the published signed desktop app
  against real managed servers: `1.0.3` → legacy bridge `1.0.10` → npm
  `1.0.11-beta.2`, and npm-capable `1.0.9` → npm `1.0.10` → npm
  `1.0.11-beta.2`.
- Observe real public TLS download hosts without replacing payloads or
  disabling signature verification. The legacy first hop uses GitHub release
  assets; npm-capable hops use `registry.npmjs.org`.
- Verify automatic recovery after an offline start, a refused npm connection
  that leaves the incumbent usable, and successful retry through the App's
  visible **Retry server update** control. Preserve server identity, token,
  saved test session/event and settings. Compare all 120 stable and 129 beta
  runtime files with their independently verified public packages.
- Both scoped native jobs pass in [run 39557877984](https://github.com/ZhengyiLuo/AgentsDock/actions/runs/39557877984).
  Live provider history, busy/queued work, activation rollback, logout or reboot,
  other desktop platforms and desktop binary replacement remain outside this
  acceptance. This verifies the published versions, not the new beta.12 source.

## 2026-10-18 — Publish 1.0.11-beta.2

- Complete [paired npm publication, attempt 2](https://github.com/ZhengyiLuo/AgentsDock/actions/runs/39103091104)
  after the accepted runtime becomes publicly available. Verify and skip that
  unchanged runtime, publish the exact matching CLI through its separate Trusted
  Publisher, and verify both public archives. Both `beta` tags now resolve to
  `1.0.11-beta.2`; both stable `latest` tags remain `1.0.10`.
- A fresh isolated registry installation with setup scripts disabled resolves
  the matched CLI/runtime pair and exact dependency, and exercises command help
  without operating existing services. Native first-install and lifecycle
  acceptance remains the separately recorded candidate check below.
- [Desktop publication](https://github.com/ZhengyiLuo/AgentsDock/actions/runs/39177990728)
  passes all four native platform verifiers and publishes the
  [canonical beta](https://github.com/ZhengyiLuo/AgentsDock/releases/tag/v1.0.11-beta.2)
  and [compatibility mirror](https://github.com/ZhengyiLuo/AgentsDock-Releases/releases/tag/v1.0.11-beta.2).
  The signed [legacy server bridge](https://github.com/ZhengyiLuo/AgentsServer/releases/tag/v1.0.11-beta.2)
  is public as well. Preserve product source
  `853dcd285ef442176370632149deba21ef732eda`, native build 1261 and asset-manifest
  digest `bff0ef6024feb840c7b8e9d1a8c84817b775fc1c23711aa3f29132c96e71ec8c`.
  No accepted artifact was rebuilt, repacked or replaced.
- Keep stable releases, mobile builds and existing installations unchanged.
  Retain the disclosed clean-quit, unsigned Windows, native Windows/Linux UI,
  populated-history/busy-upgrade and logout/reboot limits. Gemini is included
  for desktop/server API connections, not mobile or Google/CLI sign-in.

## 2026-10-18 — Accept the 1.0.11-beta.2 candidate

- Freeze product source `853dcd285ef442176370632149deba21ef732eda`, native
  build 1261. [Desktop preparation](https://github.com/ZhengyiLuo/AgentsDock/actions/runs/39100809951)
  passes all four native platforms, including Developer ID signing, Apple
  notarization and the exact asset-set verification. The separate orchestration
  commit `197f07b9ca949c1a81441d18b46a048764d6dd2d` does not change product code.
  The sealed asset-manifest digest is
  `bff0ef6024feb840c7b8e9d1a8c84817b775fc1c23711aa3f29132c96e71ec8c`.
- Exercise the unmodified signed macOS app and exact packaged server through
  real UI, IPC, HTTP and Gemini CLI 0.64.0 against Google inference: connected
  API settings, direct new chat, a long first prompt, automatic short title,
  two turns with the same native session, and retained replies/title on reload.
  Title generation inserts no extra user turn. Temporary credentials and
  disposable server state are removed afterward; existing installations remain
  unchanged. Test cleanup required force-closing the owned app, so this is not
  clean-quit acceptance.
- Pass 5,392 desktop tests (six skipped), the full hosted server suite, 18 native
  Gemini CLI/HTTP cases and a 40-turn, four-chat streaming/reconnect stress check.
  [Native npm acceptance](https://github.com/ZhengyiLuo/AgentsDock/actions/runs/39099183063)
  passes on macOS and Linux, including first setup, exact runtime inventory,
  default/named lifecycle, repeat installation and preserved state on removal.
- [Paired npm publication](https://github.com/ZhengyiLuo/AgentsDock/actions/runs/39103091104)
  initially accepted the runtime upload, then exhausted 61 read-only visibility
  checks. At candidate acceptance, the CLI upload and public desktop/bridge
  release remained pending; the completion receipt above supersedes that state.
  Candidate acceptance alone was not a completed public release. Mobile Gemini,
  unsigned Windows warnings, native Windows/Linux UI, populated-history/busy
  upgrades and logout/reboot remain the disclosed boundaries.

## 2026-10-18 — Bound macOS release ticket-download recovery

- Keep product source and signed server/npm candidates frozen independently of
  the reviewed build orchestrator. Recover only a recognized network failure
  while attaching an already-accepted outer DMG notarization ticket.
- Retry the same artifact with bounded delays; require its ticket, Developer ID
  signature and every original package/updater check before accepting a build.
  Compilation, test, signing, notarization rejection and other failures still
  block release. No artifact is published by the recovery helper.

## 2026-10-18 — Prepare 1.0.11-beta.2

- Integrate current main and the built-in Gemini desktop/server provider with
  the prior published beta line. Preserve existing native ownership, login
  handoff, next-turn provider selection, CLI PATH and lifecycle protections.
- Include terminal-only first-install connection details, service logs,
  latest-first history recovery, file-link handling and copied diagnostics.
  Mobile Gemini and mobile publication remain outside this release.
- Combine Gemini's runtime files with the existing Codex runtime inventory.
  Pin the reviewed beta.2 installer separately; do not alter historical pins,
  signed artifacts, stable channels or existing installations.
- This is source preparation, not a publication or candidate acceptance receipt.
  Signed-package and real-app acceptance must precede public publication.

## 2026-10-13 — Accept imports and publish 1.0.11-beta.1

- Publish immutable source `e93391294af2cb0c35f5f04fe8e94cce77810458`, native
  build 1252. No accepted package was rebuilt, repacked or replaced.
- Exercise the signed/notarized macOS app and matching packaged server through
  the real client/server boundary with isolated data. Import a 300 MiB Claude
  image record and a 64 MiB Codex tool record; preserve native titles, surrounding
  text and Unicode. Confirm subagent/archive filtering, cancellation, repeat
  discovery, unchanged provider files and no duplicate incremental imports.
- Import and continue real Claude and Codex sessions with their original native
  IDs and remembered context. Four imported chats survive an isolated relaunch.
  Excessive retained text fails with the observed amount, limit, record ordinal
  and byte offset without creating a partial chat. All 103 focused regressions
  pass. These checks do not establish new image rendering or live Cursor parity.
- Hosted source checks and macOS/Linux native CLI lifecycle checks pass.
  [Paired npm publication](https://github.com/ZhengyiLuo/AgentsDock/actions/runs/38370285507)
  verifies both exact public archives through their separate Trusted Publishers.
  A fresh registry installation with lifecycle scripts disabled verifies both
  package versions and command help. Both `beta` tags are `1.0.11-beta.1`;
  both `latest` tags remain `1.0.10`.
- [Desktop publication](https://github.com/ZhengyiLuo/AgentsDock/actions/runs/38431444310)
  passes all four native platform verifiers and publishes the
  [canonical beta](https://github.com/ZhengyiLuo/AgentsDock/releases/tag/v1.0.11-beta.1)
  and [compatibility mirror](https://github.com/ZhengyiLuo/AgentsDock-Releases/releases/tag/v1.0.11-beta.1)
  with the same 16 sealed assets. The signed
  [legacy server bridge](https://github.com/ZhengyiLuo/AgentsServer/releases/tag/v1.0.11-beta.1)
  is also public. The asset-manifest digest remains
  `dbed888a33160639ba00992bbb5ec1d1f9ba0650c7329c27c7701f55df9579cd`.
- Retain the disclosed limits: unsigned Windows installer; no new live Cursor
  resume or native Windows/Linux app interaction acceptance; no full populated
  history, active/queued upgrade, logout/reboot or Windows updater acceptance.
  The isolated relaunch check is not clean-quit lifecycle acceptance. Temporary
  test credentials/state were removed; existing apps and servers were untouched.

## 2026-10-13 — Prepare the 1.0.11 beta integration

- Start `release/1.0.11-beta.1` from the frozen 1.0.10 release line and merge
  main through `2b666a9f`. Include streaming native-history import, the Files
  inspector, simplified server settings and connection sharing, recoverable
  empty chats, and provider/permission inheritance for new chats.
- Preserve release-line native writer handoff, pending provider selection,
  mailbox-only delivery authority, CLI service PATH and stop/start fixes.
  Combine observational catalog refresh and attributed login-reload diagnostics
  with those existing ownership protections rather than restoring older code.
- Keep the new transcript reader in every runtime manifest and compile check.
  Pin the new installer separately for this exact beta; historical installer
  hashes and accepted 1.0.10 artifacts remain unchanged.
- Local checks: 5,266 Electron tests passed (six skipped), eight build/license
  checks passed, TypeScript and production compilation passed; 407 release/CLI
  checks and 196 Python release-tooling checks passed. Targeted import,
  provenance, login, cross-chat, cleanup, goal, instance and restart regressions
  passed after resolving the runtime inventory ordering mismatch.
- Availability: source preparation only. New-beta signed packages, hosted
  native lifecycle/update checks and real-app feature acceptance are pending.
  These source checks do not establish a public release or native provider
  resume acceptance. No mobile package is built by this preparation.
