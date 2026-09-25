# Public development log

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
