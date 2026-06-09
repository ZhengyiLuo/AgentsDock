# ZenithDock Dev Log

This file is the working memory for ZenithDock. Update it whenever a debugging
session, architecture decision, deploy, TestFlight upload, or UX rule would be
painful to rediscover later.

## Update Rules

- Add entries newest first.
- Include concrete paths, commands, symptoms, and verification results.
- Record failed theories too, especially if we might accidentally repeat them.
- Do not use temporary paths as source-of-truth. The repo is
  `/Users/zen/agi/ZenithDock`.
- Normal Mac app bundle path is
  `/Users/zen/agi/ZenithDock/dist/ZenithDock.app`.
- If a staged bundle is ever created for safety, call that out and delete it
  once the normal bundle is updated.
- Every TestFlight release must also update the server side: deploy/restart the
  active server and push the latest server repository/code to GitHub so app and
  server contract versions do not drift.

## 2026-06-09 Follow-Up - Pull Server MR

Context:

- User asked to pull the server-code MR.
- `ZhengyiLuo/ZenithBotServer` had PR #1 already merged into `origin/main`:
  `Merge pull request #1 from ZhengyiLuo/fix/codex-event-stream-parser`.
- A separate `origin/fernando` branch exists but diverged from
  `69d7abe Repair stale unread cursors`; it is not a GitHub PR ref and was not
  merged into local `main`.

Change:

- Fast-forwarded standalone server repo `/Users/zen/agi/ZenithbotServer` to
  `6c78f1a`.
- Synced the pulled `agent_server.py` into
  `/Users/zen/agi/ZenithDock/server/agent_server.py` so app-local deploy paths
  match the standalone server source.

Verification:

- `python3 -m py_compile agent_server.py` passed in the standalone server repo.
- `python3 -m py_compile server/agent_server.py` passed in the app repo.
- `swift run ZenithGuardrails` passed.

## 2026-06-05 Follow-Up - Near-Bottom Timeline Scroll Churn

Context:

- User reported that scrolling near the end of long Mac chat histories was
  still clunky.
- Root cause found in the Mac timeline: live selected-chat updates preserved
  exact scroll origin on every visible agent event and expanded the rendered row
  window while already at the bottom. That created forced layout restores and
  gradually heavier row projection during streaming.

Change:

- Live bottom updates now keep the visible row window stable instead of growing
  it for every incoming event.
- Passive scroll-position preservation now runs only when the selected timeline
  is away from the bottom, avoiding unnecessary forced layout restores at the
  end of the chat.
- Added guardrails for both behaviors.

Verification:

- `swift run ZenithGuardrails` passed.

## 2026-06-03 Follow-Up - TestFlight Build 50

Context:

- User requested TestFlight after the stale-manifest artifact recovery fix and
  bottom-scroll churn reduction.
- A Claude turn wrote its video manifest to an older run file, so the app did
  not show the delivered MP4 until the server recovered the stale manifest.

Change:

- Bumped `CURRENT_PROJECT_VERSION` from `49` to `50`.
- Reusing `MARKETING_VERSION` `0.1.1`.
- `server/agent_server.py` now recovers recent leftover manifest files for the
  same session/run window after normal manifest collection.

Verification:

- `swift run ZenithGuardrails` passed.
- `python3 -m py_compile server/agent_server.py` passed.
- Deployed/restarted the active `sonic` server with `server/deploy.sh sonic`.
- Uploaded iOS/iPadOS build `50` successfully: `Uploaded ZenithDockIOS`.
- Uploaded macOS build `50` successfully: `Uploaded ZenithDockMac`.
- Rebuilt local Mac app at `dist/ZenithDock.app`.
- MBA sync was skipped because `zens-macbook-air` was unreachable over SSH.
- Pushed standalone `ZhengyiLuo/ZenithBotServer` with the latest server code.

## 2026-06-02 Follow-Up - Timeline Fly-By Regression Guard

Context:

- User reported the message fly-by effect returned after build 49.
- Root cause was not only event count. Disk cache trims large message bodies;
  the latest server snapshot can replace those same event ids with full text,
  causing huge row expansion without adding many events.

Change:

- Mac and iOS/iPadOS timeline snapshot masking now compares projected rendered
  text weight as well as event-count deltas.
- Heavy same-row text expansion masks the timeline until the latest snapshot is
  applied and bottom positioning can settle.
- Small no-op cached refreshes still avoid the foreground spinner.
- Added guardrails so future anti-flyby checks cover text expansion, not just
  large event batches.

Verification:

- `swift run ZenithGuardrails` passed.
- `xcodebuild -project ZenithDock.xcodeproj -scheme ZenithDockIOS -configuration Debug -destination 'generic/platform=iOS Simulator' build -quiet` passed.
- Rebuilt local Mac app at `dist/ZenithDock.app`; build script synced it to
  `zens-macbook-air:/Users/zen/agi/ZenithDock.app`.

## 2026-06-02 Follow-Up - TestFlight Build 49

Context:

- User requested pushing the latest app to TestFlight after the queue acceptance,
  drag reorder, right-panel shortcut, and Codex failure surfacing fixes.
- Build 49 should carry the latest app/server contract, including visible Codex
  JSON failures and disabled server-launched Codex image-generation tooling.

Change:

- Bumped `CURRENT_PROJECT_VERSION` from `48` to `49`.
- Reusing `MARKETING_VERSION` `0.1.1`.

Verification:

- `swift run ZenithGuardrails` passed.
- `python3 -m py_compile server/agent_server.py` passed.
- Rebuilt local Mac app at `dist/ZenithDock.app`; the build script also synced
  `ZenithDock.app` to `zens-macbook-air:/Users/zen/agi/`.
- Deployed/restarted the active `sonic` server with `./server/deploy.sh sonic`;
  service responded with token-required health.
- Uploaded iOS/iPadOS build `49` successfully: `Uploaded ZenithDockIOS`.
- Uploaded macOS build `49` successfully: `Uploaded ZenithDockMac`.
- Pushed standalone `ZhengyiLuo/ZenithBotServer` at `b305ed8`.
- Pending: app Git push after this log completion commit.

## 2026-06-02 - Surface Codex Tool Failures

- A Codex turn in `CMA-ES - Gripper - Dev` accepted the user prompt but then
  produced no visible assistant response. The remote event log showed Codex
  emitted `type:error` / `turn.failed` with
  `The model 'gpt-image-2' does not exist`, then exited with empty
  `result_text`.
- The server previously stored those Codex failures as raw events only, so the
  app showed a sent user bubble and silence.
- `server/agent_server.py` now converts Codex JSON `error` and `turn.failed`
  events into visible `error` cards, including nonzero exits with no stderr.
- Server-launched Codex turns now pass `--disable image_generation` to avoid
  the currently broken image-generation tool path while preserving normal image
  file attachments.

## 2026-06-02 - Remove Dead Composer Mic

- Removed the Mac composer microphone icon because voice input is not wired up
  yet and the static icon looked like a broken button.
- Added a `ZenithGuardrails` check so the disabled/dead mic affordance cannot
  quietly return before real voice input exists.

## 2026-06-02 - Queue Accepted Event Contract

- Fixed a queue reliability regression where accepted sends could fail to show
  the queued row/user turn until websocket delivery caught up.
- `server/agent_server.py` now returns the exact `turn_queued` or
  `turn_started` event in the `/api/sessions/{session_id}/turns` response.
- `Sources/ZenithDock/State/AppStore.swift` and
  `Sources/ZenithDockIOS/State/MobileAppStore.swift` ingest that accepted event
  immediately, with existing event-ID dedupe still handling the later websocket
  copy.
- This keeps the composer clear and the queue shelf visible even after stream
  reconnects or server restarts.

## 2026-06-02 - Right Panel Keyboard Shortcut

- Added a Mac app command for the existing right inspector visibility state.
- `Cmd-L` now toggles the right side panel using the same
  `rightInspectorVisible` storage as the header button, so the keyboard and UI
  stay in sync.
- Added a guardrail that requires the app-level `Cmd-L` command.

## 2026-06-02 - Reliable Queue Event Reconciliation

- Tightened the send/queue contract so `/turns` returns the accepted
  `turn_started` or `turn_queued` event and Mac/iOS render that event
  immediately instead of waiting on websocket delivery.
- Queue action 404s now reconcile stale local queued rows quietly on Mac and
  iOS, including generic `Not Found` responses from cache/server drift.
- Plain Stop now leaves queued turns pending. Only normal turn completion or
  explicit Send Now drains the next queued turn; Send Now still reserves the
  exact queued item before interrupting the current run.
- Added guardrails for immediate accepted-event rendering, stale queue row
  reconciliation, and the Stop-vs-Send-Now queue drain rule.

## 2026-06-02 - Single-Shot Chat Drag Reorder

- Fixed the Mac sidebar chat drag/drop reorder path that still animated through
  repeated neighbor swaps after a drop.
- `server/agent_server.py` now lets `/api/sessions/{session_id}/order` accept
  `target_id` plus `placement` (`before`/`after`) and computes the final section
  order in one save/response.
- `Sources/ZenithDock/State/AppStore.swift` now sends that single target
  placement request for drag/drop instead of looping over `up`/`down` reorder
  calls.
- The old `direction` path remains for context-menu `Move Up` / `Move Down`.
- Guardrails now explicitly reject the repeated-swap loop and require the
  server target-placement API.

## 2026-06-02 - Mac Asset Downloads And Chat Drag Reorder

- Added explicit Mac download buttons for assets in the timeline artifact grid,
  plain file rows, message attachment cards, uploaded-file cards, pinned file
  rows, and the right-side Files & Videos inspector.
- The Mac download path reuses `ArtifactDragFileCache.shared.localFile`, so
  remote files are first cached locally, then saved with `NSSavePanel`, and the
  saved file is revealed in Finder.
- Fixed Mac sidebar reorder mode so chat rows are actually draggable. Reorder
  mode now shows before/after insertion rules and translates a chat drop into
  the current server-supported up/down reorder calls.
- Chat drag reorder is intentionally limited to compatible sections: pinned
  chats reorder with pinned chats, archived with archived, and folder chats
  inside the same folder. Moving across folders still uses the existing
  `Move to Folder` action.
- `Tools/ZenithGuardrails/main.swift` now protects chat-row drag/drop reorder
  and explicit Mac artifact download controls.

## 2026-06-02 - Mac Cache Freshness Must Come From Server

- Fixed a Mac cache-divergence bug where two Macs could show different history
  for the same chat, especially after switching machines or endpoints.
- The warm-cache fast path still renders the local tail immediately, but it now
  skips the REST latest-tail refresh only when a recent successful
  `/api/sessions` response from the server proves the cached `latest_event_seq`
  is current.
- `Sources/ZenithDock/State/AppStore.swift` no longer lets
  `memoryCachedChat(sessionID)?.session.latest_event_seq` prove freshness,
  because that was self-referential local metadata and could validate a stale
  cache on one Mac.
- `Tools/ZenithGuardrails/main.swift` now checks that session-list freshness is
  refreshed on every successful `/api/sessions` call and that local chat cache
  metadata cannot be used as the freshness authority.

## 2026-06-02 - iOS Timeline Fly-By Mask

- Fixed an iOS/iPadOS timeline regression where opening a chat could visibly
  fly through message history while the latest tail snapshot and bottom
  positioning settled.
- `Sources/ZenithDockIOS/State/MobileAppStore.swift` now has a mobile
  large-batch timeline mask for cold session snapshots. Cached rows can still
  render quickly, but cold large tails are hidden until layout has a stable
  bottom target.
- `Sources/ZenithDockIOS/Views/MobileTimelineView.swift` now keeps newly opened
  chats visually masked until short non-animated bottom-settle passes complete.
  Top-edge older-history autoload is also disabled while opening/loading/applying
  a large batch, so it cannot accidentally page upward during chat open.
- `Tools/ZenithGuardrails/main.swift` now checks these iOS-specific fly-by
  guards so future performance work does not silently reintroduce the waterfall.

## 2026-06-02 - Queue Submit Composer Clear

- Fixed a queued-send edge where the Mac composer could keep the submitted text
  visible after the server had already accepted the queued turn.
- The native Mac text view now clears itself immediately after a non-empty submit,
  while the store still avoids publishing full draft text on every keystroke.
- Mac and iOS submits now send to the captured chat/session id instead of the
  currently selected chat at async execution time, so switching chats during a
  submit cannot restore or send the wrong draft.
- Attachments are cleared only if the accepted submit still belongs to the
  currently selected chat and the pending attachment ids have not changed.
- Guardrails now check the captured-session send path and native-submit clear.

## 2026-06-02 - Claude Tool Output Decode Guard

- Fixed Mac/iOS chat-open failures on Claude chats where historical
  `tool_finished.output` was a JSON array of content blocks instead of a string.
- Server now normalizes legacy non-string `output` fields in `read_events`, and
  new Claude tool-result events are written as compact text from the start.
- `ZEvent` also decodes flexible `output` values defensively, including text,
  image, and tool-reference blocks, so a malformed/older server response does
  not brick the entire chat view.
- Added a `ZenithGuardrails` regression test that decodes a Claude-style array
  output event and verifies both client and server guards stay in place.

## 2026-06-02 - Live Artifact Watching And Codex Defaults

- Added a server-side live manifest watcher for Claude and Codex turns. The
  watcher polls the run manifest while the provider is still running, waits for
  artifact file size/mtime stability, emits `artifact_created` with the active
  `run_id`, and leaves final manifest collection as a deduped cleanup pass.
- This should let videos/files appear during a long turn once they are fully
  written, instead of waiting for `turn_finished`.
- Guardrails now require the live manifest watcher and stable-file check so the
  timeline does not regress back to end-of-turn artifact delivery.
- Codex runtime catalog discovery now prefers `gpt-5.5` as the resolved server
  default when that model is present and keeps GPT-5.5 default effort at `xhigh`
  instead of accepting a misleading `medium` debug-catalog default.
- Mac send no longer waits for a title-save request before posting a new-chat
  turn. The server already titles from the first prompt, so the turn reaches the
  provider path faster and the running indicator appears sooner.
- Multi-message text selection/copy remains punted for now; the reliable path is
  still per-message full-text/copy controls.

## 2026-06-01 - LLM Handoff Digests

- Handoff digest creation now runs an actual LLM summarizer. The old
  deterministic transcript/file pack is kept only as internal source material
  for the summarizer.
- The digest endpoint must not return the raw source pack directly. If the LLM
  summarizer fails, the request should fail visibly instead of pretending a
  hard-coded pack is a digest.
- Mac and iOS/iPadOS pass the target chat id into digest creation so the LLM
  can tailor the handoff to the target backend/session/cwd.
- Digest sheets now default to `Normal` context depth and display
  `Summarizing with LLM` while the server runs the summarizer.
- Preview remains a blocking LLM summary request because the user explicitly
  wants to see the digest.

## 2026-06-01 - Source-Chat Handoff Digest Turns

- Changed background handoff sends so the digest is generated as a real tagged
  turn in the source chat, using that chat's normal Claude/Codex backend and
  runtime.
- The source digest turn uses a short visible prompt plus hidden handoff
  instructions, renders in the yellow digest/queue palette, and keeps the user
  on the source chat while it runs.
- When the source digest turn finishes, the server forwards the resulting digest
  to the target chat as a normal queued/started target turn.
- Existing handoff lifecycle status cards now collapse to the newest status per
  digest job, preventing stale `Digest Generating` spinners after ready/sent/error
  events exist.
- Fixed Mac and iOS timeline projection ordering so non-run events flush any
  buffered run output first; newer digest/status rows no longer appear above
  older assistant text.

## 2026-06-01 - Per-Chat Composer Drafts

- Composer drafts are now saved per chat and scoped by canonical server
  namespace, so switching chats restores the unsent message for that chat
  instead of wiping it.
- Mac draft persistence stays off the published SwiftUI text path: the native
  text view reports changes into a private, debounced draft cache so typing
  stays snappy.
- iOS/iPadOS restores and saves the selected chat's draft through the same
  local draft cache.
- Submitted drafts clear only the submitted session, and failed sends restore
  the draft for that same session.

## 2026-06-01 - Job Deferred Timeline State

- Scheduled jobs that hit a busy chat are deferred, not failed: the server
  pushes `next_run_at` out by the busy retry delay and the scheduler retries
  later.
- `job_deferred` events must render as orange job/status cards on Mac and
  iOS/iPadOS, alongside `job_created` and `job_ran`, so users can see that the
  job is still alive but waiting for the active turn to finish.

## 2026-06-01 - Claude Resume Poison Guard

- Fixed a server-side Claude resume bug where `error_during_execution` results
  could overwrite a valid Claude provider session id with the failed run's
  diagnostic `session_id`.
- Claude provider ids are now persisted only after a successful `result` event;
  failed result events surface as timeline errors but leave the previous resume
  id intact.
- Added `ZenithGuardrails` coverage so streamed Claude session ids cannot be
  saved before the result succeeds.
- Diagnosed the live `OSMO Stability` failure as a poisoned resume-id cascade,
  not deleted server state.

## 2026-06-01 Follow-Up - TestFlight Build 48

Context:

- Build 47 was uploaded before the deeper UI responsiveness optimization pass.
- Build 48 ships the optimized Mac/iOS timeline/store changes so TestFlight
  matches the current Git state.

Change:

- Bumped `CURRENT_PROJECT_VERSION` from `47` to `48`.
- Includes `34d87c3 Optimize timeline responsiveness`.

Verification:

- Pending: `swift run ZenithGuardrails`
- Pending: iOS/iPadOS archive/export upload
- Pending: macOS archive/export upload
- Pending: Git push

## 2026-06-01 Follow-Up - UI Responsiveness Optimization

Context:

- User reported that the UI still did not feel snappy, especially during chat
  switching, typing while background refreshes run, and iOS timeline opens.
- Investigation found repeated `@Published` writes from heartbeat/session
  polling, duplicate timeline settle hooks, unbounded selected-chat video
  metadata loads, and a computed iOS `displayEvents` hot path.

Change:

- Mac store now gates repeated status/reachability/socket/display-event/file
  publishes so identical heartbeat data does not invalidate the whole UI.
- Mac warm-cache chat switches now skip the REST latest-tail call when the
  session list already proves the local cache is current, then attach the live
  websocket directly.
- Mac selected-chat video metadata fetch is paged instead of pulling every
  video for large chats during chat switch.
- Mac and iOS timelines no longer run a duplicate `displaySignature` scroll
  settle after `displayEvents.count` already handled the same update.
- iOS raw events are no longer published directly; the mobile store now exposes
  a filtered `displayEvents` publication boundary like macOS.
- Added guardrails for the fresh-cache skip, paged video fetch, and iOS
  display-event publication boundary.

Verification:

- `swift run ZenithGuardrails`
- `xcodebuild -project ZenithDock.xcodeproj -scheme ZenithDockMac -configuration Release -destination platform=macOS build -quiet`
- `xcodebuild -project ZenithDock.xcodeproj -scheme ZenithDockIOS -configuration Debug -destination 'generic/platform=iOS Simulator' build -quiet`

## 2026-06-01 Follow-Up - TestFlight Build 47

Context:

- User requested shipping the latest app state to TestFlight and Git before a
  deeper UI performance optimization pass.
- This release includes the latest folder reorder interaction fixes from
  `81b3c31 Tighten folder reorder interactions`.

Change:

- Bumped `CURRENT_PROJECT_VERSION` from `46` to `47`.

Verification:

- `swift run ZenithGuardrails`
- `xcodebuild -project ZenithDock.xcodeproj -scheme ZenithDockIOS -configuration Release -destination generic/platform=iOS -archivePath build/archives/ZenithDockIOS-47.xcarchive archive -quiet -allowProvisioningUpdates`
- `xcodebuild -exportArchive -archivePath build/archives/ZenithDockIOS-47.xcarchive -exportOptionsPlist build/TestFlightExportOptions.plist -exportPath build/TestFlightIOSExport-47 -quiet -allowProvisioningUpdates`
  uploaded successfully: `Uploaded ZenithDockIOS`.
- `xcodebuild -project ZenithDock.xcodeproj -scheme ZenithDockMac -configuration Release -destination generic/platform=macOS -archivePath build/archives/ZenithDockMac-47.xcarchive archive -quiet -allowProvisioningUpdates`
- `xcodebuild -exportArchive -archivePath build/archives/ZenithDockMac-47.xcarchive -exportOptionsPlist build/TestFlightExportOptions.plist -exportPath build/TestFlightMacExport-47 -quiet -allowProvisioningUpdates`
  uploaded successfully: `Uploaded ZenithDockMac`.
- Git push succeeded for app repo commit
  `787b45f Bump build 47 for TestFlight`.

## 2026-06-01 Follow-Up - TestFlight Build 46

Context:

- User requested a TestFlight push after the Mac `Ctrl-Tab` chat-switching
  shortcut and recent timeline performance fixes.

Change:

- Bumped `CURRENT_PROJECT_VERSION` from `45` to `46`.
- Uploaded build `46` for both TestFlight platforms:
  - iOS/iPadOS: `build/archives/ZenithDockIOS-46.xcarchive`
  - macOS: `build/archives/ZenithDockMac-46.xcarchive`
- Server repo push was checked as part of the release rule;
  `/Users/zen/agi/ZenithBotServer` was already up to date.

Verification:

- `swift run ZenithGuardrails`
- `xcodebuild -project ZenithDock.xcodeproj -scheme ZenithDockIOS -configuration Release -destination generic/platform=iOS -archivePath build/archives/ZenithDockIOS-46.xcarchive archive -quiet -allowProvisioningUpdates`
- `xcodebuild -exportArchive -archivePath build/archives/ZenithDockIOS-46.xcarchive -exportOptionsPlist build/TestFlightExportOptions.plist -exportPath build/TestFlightIOSExport-46 -quiet -allowProvisioningUpdates`
  uploaded successfully: `Uploaded ZenithDockIOS`.
- `xcodebuild -project ZenithDock.xcodeproj -scheme ZenithDockMac -configuration Release -destination generic/platform=macOS -archivePath build/archives/ZenithDockMac-46.xcarchive archive -quiet -allowProvisioningUpdates`
- `xcodebuild -exportArchive -archivePath build/archives/ZenithDockMac-46.xcarchive -exportOptionsPlist build/TestFlightExportOptions.plist -exportPath build/TestFlightMacExport-46 -quiet -allowProvisioningUpdates`
  uploaded successfully: `Uploaded ZenithDockMac`.
- Both archives report `CFBundleShortVersionString = 0.1.1` and
  `CFBundleVersion = 46`.

## 2026-05-31 Follow-Up - Right Panel Collapse And Pinned Items

Problem:

- The Mac inspector/right panel was always visible, which cost horizontal room
  during focused chat work.
- Important timeline messages/files had no first-class place to live after they
  scrolled away.

Change:

- Added a persistent Mac header toggle for the right inspector panel. When
  hidden, the detail column releases its width and the header button brings it
  back.
- Added local, server-namespaced pinned timeline items for the selected chat.
  Timeline messages, artifact groups, and the files/videos inspector now expose
  pin controls.
- The inspector now has a `Pinned` shelf with compact rows plus `Find`, `Open`,
  `Copy`, and `Unpin` actions.
- Pinned item state migrates when the app adopts a canonical server identity,
  matching the chat cache/read-state behavior.
- Added guardrails for inspector collapse and pinned item wiring.

Verification:

- `swift run ZenithGuardrails`
- `swift build --product ZenithDock`

## 2026-05-27 Follow-Up - Sidebar Reorder Mode

Problem:

- Reordering chats/folders depended on tiny up/down controls and context menus.
  That did not feel like a real draggable reorder UI.

Change:

- Mac and iOS/iPadOS sidebars now expose an explicit `Reorder` / `Done` mode.
- While reorder mode is enabled, folders and visible chat rows use native list
  drag reordering.
- Folder headers hide the noisy arrow controls during normal browsing and keep
  collapse behavior available.
- Added store-level `reorderFolders` helpers and guardrails for drag reorder
  mode.

## 2026-05-27 Follow-Up - Code Review Diff Surface

Problem:

- The trace code-review sheet could treat command text, `git status`, or grep
  output as if it were a diff. That produced fake file rows and huge unreadable
  text blobs instead of real code changes.
- The review modal only showed one selected file at a time, which felt unlike
  Codex's continuous review pane.

Change:

- The review sheet now renders all captured file hunks in one continuous right
  pane, closer to Codex's review surface.
- Diff extraction no longer uses shell command text as review content and no
  longer treats `git status` as a hunk source.
- File discovery can still use structured patch/diff/stat output, but the
  detailed pane only shows real patch/unified-diff hunks. If no hunk was
  captured for a file, the row says so instead of dumping unrelated text.
- Added guardrails so broad command/status text cannot regress into fake code
  review content.

## 2026-05-27 Follow-Up - Fixed-Run Scheduled Jobs

Problem:

- Scheduled jobs only exposed a binary loop/no-loop mode. No-loop jobs were
  always one-shot, but some workflows need a bounded repeated status/check run
  such as 5 total runs without leaving a forever loop enabled.

Change:

- Added `max_runs` to the shared job model and server job API.
- Loop jobs still run forever until paused/deleted. Non-loop jobs now default to
  one run, but can be configured to run a fixed number of times at the chosen
  interval.
- Mac and iOS/iPadOS job creation/edit sheets expose a mode picker plus run
  count controls for fixed-run jobs.
- Job rows now label finite jobs as `Run once` / `Run N times`.
- Added guardrails for the app/server fixed-run job contract.

## 2026-05-27 Follow-Up - Queued Send Draft Clearing

Problem:

- Some queued sends cleared the visible editor immediately but left the backing
  `prompt` string intact. Later SwiftUI refreshes could repopulate the composer
  with the already-submitted message, making it look like queue submit failed.

Change:

- Mac and iOS now clear the backing prompt after any successful selected-chat
  send, including explicit submitted snapshots from the native editors.
- The clear only fires if the backing prompt still matches the submitted text,
  so a newer draft typed while the request is in flight is preserved.
- Added guardrails for the queued-send draft clearing rule.

## 2026-05-27 Follow-Up - Agent Launch Deferred UX And Concurrency

Problem:

- The server correctly deferred new manual agent launches when the global active
  run cap was reached, but the Mac app surfaced the HTTP 503 as a modal alert
  with raw JSON (`agent launch deferred: server already has ...`).
- The active server has moved to a stronger machine, so the old manual cap of 4
  was too conservative.

Change:

- Raised the default `ZENITHBOT_MAX_ACTIVE_AGENT_RUNS` from 4 to 10.
- Mac and iOS now classify `agent launch deferred` API responses as inline
  launch status (`Launch deferred`) instead of modal errors.
- API JSON `detail` payloads are unwrapped before display.
- Added guardrails for the cap and non-modal deferred-launch behavior.

## 2026-05-26 Follow-Up - Timeline Message Timestamps

Change:

- Mac and iOS timeline message bubbles now show each event's local update time
  in the header next to `You`, `Assistant`, or job labels.
- System/job cards also display the event time; grouped job status rows use the
  latest known job event time.
- The timestamp comes from existing server event metadata (`event.ts`), so this
  does not require a server contract change.
- Added `ZenithGuardrails` coverage to keep timestamps attached to future
  message-row refactors.

## 2026-05-26 Follow-Up - Large Timeline Sync Flyby Mask

Problem:

- During chat sync/open-latest-message refreshes, large timeline snapshots could
  still visibly fly through the Mac timeline. The previous cached-refresh mask
  hid some paint, but SwiftUI could still build/reveal a large replacement row
  set in the same update window.

Change:

- Mac `AppStore` now publishes `isApplyingLargeTimelineBatch`.
- Large session snapshots and buffered websocket catch-up bursts set that mask
  before mutating `events`/`displayEvents`, then reveal after a short layout
  settle delay.
- `TimelineView` now structurally suspends row construction for those large
  batches, not just cold opens. Normal low-volume live streaming still renders
  immediately.
- Added `ZenithGuardrails` checks so future timeline tuning cannot silently
  remove the large-batch mask.

## 2026-05-22 Follow-Up - TestFlight Build 41

Release checklist:

- Synced `server/agent_server.py` into `/Users/zen/agi/ZenithbotServer`.
- Committed and pushed `ZhengyiLuo/ZenithBotServer`:
  `8a3492a Update server contract for TestFlight 41`.
- Deployed/restarted the active server with `./server/deploy.sh sonic`.
- Confirmed `zenithbot-agent.service` was active and authenticated health
  requests returned `200`.
- Bumped `CURRENT_PROJECT_VERSION` from `40` to `41`.
- `swift run ZenithGuardrails` passed.
- `python3 -m py_compile server/agent_server.py` passed.
- Uploaded iOS/iPadOS build 41 successfully: `Uploaded ZenithDockIOS`.
- Uploaded macOS build 41 successfully: `Uploaded ZenithDockMac`.
- Refreshed local Mac app at `dist/ZenithDock.app`; verified codesign and
  `CFBundleVersion = 41`.

## 2026-05-22 Follow-Up - Server/App Compatibility Gate

Problem:

- The app and server now share behavior contracts such as `server_identity`.
  If the app connects to an older server, it can look online while read-state
  and cache behavior are subtly wrong.

Change:

- Server `/api/health` now reports `api_contract_version`.
- Mac and iOS/iPadOS require agent API contract v2.
- If the server omits the version or reports an older value, the app marks the
  server offline and shows an inline `Server upgrade required` message instead
  of loading sessions/jobs.
- Added guardrails so the health contract check does not regress.

Deploy/TestFlight:

- Deployed the v2 server contract to `sonic` with `./server/deploy.sh sonic`;
  service restarted and app health checks returned `200`.
- Bumped `CURRENT_PROJECT_VERSION` from `39` to `40`.
- Uploaded iOS/iPadOS build 40 successfully: `Uploaded ZenithDockIOS`.
- Uploaded macOS build 40 successfully: `Uploaded ZenithDockMac`.
- Refreshed local Mac app at `dist/ZenithDock.app`; verified codesign and
  `CFBundleVersion = 40`.

## 2026-05-22 Follow-Up - TestFlight Build 39 Upload Blocked

Changes:

- Bumped `CURRENT_PROJECT_VERSION` from `38` to `39` for the shared Xcode
  project.
- Prepared build 39 with the server-identity local-state namespace changes,
  archived-section folding, and batched websocket catch-up behavior.

Verification:

- `swift run ZenithGuardrails`
- `python3 -m py_compile server/agent_server.py`
- Archived iOS/iPadOS build 39:
  `build/archives/ZenithDockIOS-39.xcarchive`
- Archived macOS build 39:
  `build/archives/ZenithDockMac-39.xcarchive`
- Refreshed local Mac app at `dist/ZenithDock.app`; verified codesign and
  `CFBundleVersion = 39`.

Upload status:

- iOS/iPadOS export/upload failed with Xcode account credentials error:
  `missing Xcode-Token`.
- macOS export/upload failed with the same Xcode account credentials error.
- No App Store Connect API key was present under the repo or
  `~/.appstoreconnect/private_keys`, so this machine needs Xcode account
  re-authentication or an API-key upload setup before TestFlight upload can
  complete.

Follow-up:

- Redeployed the current server to `sonic` with `./server/deploy.sh sonic` and
  confirmed `zenithbot-agent.service` was active.
- Retried TestFlight exports after Xcode credentials were restored.
- Uploaded iOS/iPadOS build 39 successfully: `Uploaded ZenithDockIOS`.
- Uploaded macOS build 39 successfully: `Uploaded ZenithDockMac`.

## 2026-05-22 Follow-Up - Claude Runtime Default Label

Problem:

- Claude chats showed `Default` for runtime because the server only surfaced a
  concrete Claude default when `CLAUDE_MODEL`/`ANTHROPIC_MODEL` was set.
- Claude CLI `--help` exposes model aliases and effort values, but not the full
  resolved default model ID.

Change:

- Server Claude runtime catalog now reports `sonnet` as the default alias unless
  `CLAUDE_MODEL`, `ANTHROPIC_MODEL`, or `ZENITHBOT_CLAUDE_MODEL` overrides it.
- Claude catalog includes selectable `sonnet`, `opus`, and `haiku` aliases plus
  effort levels `low`, `medium`, `high`, `xhigh`, and `max`.
- App-side fallback catalog now also labels Claude default as `Sonnet`, so the
  UI no longer degrades to bare `Default` if catalog refresh fails.
- Deployed the server change to Sonic and restarted `zenithbot-agent`.

Verification:

- `python3 -m py_compile server/agent_server.py`
- `swift run ZenithGuardrails`
- Mac Release build and iOS simulator build.
- Refreshed `/Users/zen/agi/ZenithDock/dist/ZenithDock.app`; codesign passed.
- Live `/api/runtime/catalog` on Sonic reports Claude default model `sonnet`
  with label `Sonnet`.

## 2026-05-22 Follow-Up - Atomic Send Now Queue Fix

Problem:

- `Send Now` appended a visible `turn_stopped` card, then relied on the generic
  queue runner to pick the front queued item.
- That made the user prompt disappear or show late because Mac filtered
  queued `turn_started` events.
- It could also run the wrong queued prompt if queue ordering/recovery changed
  between the interrupt and the next queue drain.
- The Mac composer was still vertically stretching, leaving a huge empty queue
  area even after the rows were compact.

Change:

- Added a server-side `RUN_NOW_TURNS` slot so `Send Now` reserves the exact
  queued item before interrupting the active run.
- `Send Now` now calls the stop helper with `emit_event=False` and
  `schedule_queue=False`; the normal run-finally path releases the active slot
  and starts the reserved queued item first.
- Mac and iOS hide `turn_stopped` from normal timelines.
- Mac no longer filters queued `turn_started` prompts, so the actual sent
  message appears as the user turn.
- Pinned the Mac composer/card to intrinsic vertical size so the queue shelf
  grows only with queued rows.
- Added guardrails for exact run-now reservation, silent interrupt, hidden stop
  events, and visible queued user prompts.

Verification:

- `python3 -m py_compile server/agent_server.py`
- Deployed `/home/zen/Zenithbot/scripts/agent_server.py` to Sonic and restarted
  `zenithbot-agent`.
- `swift run ZenithGuardrails`
- Mac Release build and iOS simulator build.
- Refreshed `/Users/zen/agi/ZenithDock/dist/ZenithDock.app`; codesign passed.

## 2026-05-22 Follow-Up - Queue Send Now Deploy And Compact Shelf

Problem:

- `Send Now` returned `{"detail":"Not Found"}` because the app had the new
  button but the deployed Sonic server had not yet loaded the new queue routes.
- Restarting the server would previously lose in-memory queued turns because the
  queue was only reconstructed from runtime memory.
- The Mac queued-message shelf reserved too much vertical space for one queued
  message.

Change:

- Added server startup recovery for pending queued turns by replaying persisted
  queue events (`turn_queued`, update/reorder/run-now, start/unqueue).
- Deployed `/home/zen/Zenithbot/scripts/agent_server.py` on Sonic and restarted
  `zenithbot-agent`; startup recovered `queued=2`.
- Made the Mac queue shelf use a fixed compact height based on queued message
  count, capped at 128 px.
- Reduced the Mac composer editor fixed height when queued messages are visible.

Verification:

- `python3 -m py_compile server/agent_server.py`
- Remote `python3 -m py_compile /home/zen/Zenithbot/scripts/agent_server.py.new`
- `systemctl --user restart zenithbot-agent`
- Sonic service active with `queued=2` and route `/queue/{queued_id}/run-now`
  present.
- `swift run ZenithGuardrails`
- Mac Release build.
- Refreshed `/Users/zen/agi/ZenithDock/dist/ZenithDock.app`; codesign passed.

## 2026-05-22 Follow-Up - Local Network Permission Diagnosis

Problem:

- A Mac app instance showed the server as offline for `http://10.112.213.92:7850`
  while Terminal could reach the server and the server process was listening.
- macOS logs showed `Local network prohibited` with `NSURLErrorDomain -1009`
  and CFStream code `50`, meaning the app was blocked by Local Network privacy.

Change:

- Added explicit Local Network privacy diagnostics on Mac and iOS for `-1009`
  plus stream code `50`.
- Confirmed the app bundles already include `NSLocalNetworkUsageDescription`,
  `NSAllowsLocalNetworking`, and the network client entitlement.

Verification:

- `curl -i http://10.112.213.92:7850/api/health` reached the server and got
  expected `401` without a token.
- `nc -vz -w 5 10.112.213.92 7850`
- `ssh sonic 'ss -ltnp | grep 7850'`
- `swift run ZenithGuardrails`
- Mac Release build and iOS simulator build.
- Refreshed `/Users/zen/agi/ZenithDock/dist/ZenithDock.app`; codesign passed.

## 2026-05-22 Follow-Up - Composer Queue Shelf And Queue Actions

Problem:

- Pending queued messages were still represented as timeline cards on Mac,
  which made them feel like sent history instead of editable follow-up work.
- The queue only supported removal. There was no way to edit, reorder, or force
  one queued message to run next by interrupting the current turn.

Change:

- Added server queue APIs for editing queued prompts, moving queued turns
  up/down, and "run now" behavior that moves a queued turn to the front and
  stops the current run so the queue runner can start it next.
- Added hidden queue metadata events (`turn_queue_updated`,
  `turn_queue_reordered`, `turn_queue_run_now`) so queue state survives reloads
  without polluting the chat timeline.
- Mac queued messages now render in a bottom composer shelf with Send Now, move
  up/down, edit, and remove controls.
- iOS/iPadOS queued messages use the same server actions through the queued item
  menu.
- Updated guardrails so pending queued turns stay out of the Mac timeline.

Verification:

- `python3 -m py_compile server/agent_server.py`
- `swift run ZenithGuardrails`
- `xcodebuild -project ZenithDock.xcodeproj -scheme ZenithDockMac -configuration Release -destination platform=macOS build -quiet`
- `xcodebuild -project ZenithDock.xcodeproj -scheme ZenithDockIOS -configuration Debug -destination 'generic/platform=iOS Simulator' build -quiet`
- Refreshed `/Users/zen/agi/ZenithDock/dist/ZenithDock.app` from the fresh
  Release build.
- `codesign --verify --deep --strict --verbose=2 dist/ZenithDock.app`

## 2026-05-22 Follow-Up - Folder Move And Collapse Controls

Problem:

- Folders were only implicit labels derived from chat metadata. Chats could move
  between folders, but folder sections themselves could not be moved up/down or
  folded.

Change:

- Added client-side folder order and collapsed-folder state on Mac and iOS.
- Mac sidebar folder headers now expose collapse/expand plus move up/down
  controls and a context menu.
- iOS/iPadOS sidebar folder headers now expose collapse/expand and a menu for
  move up/down.
- Folder order/collapse is stored in `UserDefaults`; chat folder names still
  persist on the server as before.

Verification:

- `swift run ZenithGuardrails`
- `xcodebuild -project ZenithDock.xcodeproj -scheme ZenithDockMac -configuration Release -destination platform=macOS build -quiet`
- `xcodebuild -project ZenithDock.xcodeproj -scheme ZenithDockIOS -configuration Debug -destination 'generic/platform=iOS Simulator' build -quiet`
- Refreshed `/Users/zen/agi/ZenithDock/dist/ZenithDock.app` from the fresh
  Release build.
- Local `dist/ZenithDock.app` `CFBundleVersion = 38`.
- `codesign --verify --deep --strict --verbose=2 dist/ZenithDock.app`

## 2026-05-22 Follow-Up - iOS Ultra-Wide Video Layout

Problem:

- Videos with very wide/lateral aspect ratios looked awkward on iOS because the
  poster views used fixed heights with `scaledToFill`, which cropped or visually
  stretched the preview.

Change:

- Timeline video posters and Files & Videos grid thumbnails now use a stable
  16:9 frame with `aspectRatio(..., contentMode: .fit)`.
- Thumbnail images use `scaledToFit()` so ultra-wide videos letterbox cleanly
  instead of being cropped.

Verification:

- `swift run ZenithGuardrails`
- `xcodebuild -project ZenithDock.xcodeproj -scheme ZenithDockIOS -configuration Debug -destination 'generic/platform=iOS Simulator' build -quiet`

## 2026-05-22 Follow-Up - iOS Video Download / Save

Problem:

- iOS video artifacts only had open/play links. Opening the authenticated video
  URL did not reliably give the user a native "Save Video" / file download path.

Change:

- Added `MobileArtifactShareButton`, which downloads the remote artifact URL to a
  local cached file first, then opens `UIActivityViewController` with that local
  file.
- Added save/share controls to timeline artifact videos and the iOS/iPadOS
  Files & Videos panel.
- Reused the existing artifact download cache so drag-out and save/share use the
  same local-file preparation path.

Verification:

- `swift run ZenithGuardrails`
- `xcodebuild -project ZenithDock.xcodeproj -scheme ZenithDockIOS -configuration Debug -destination 'generic/platform=iOS Simulator' build -quiet`

## 2026-05-22 Follow-Up - TestFlight Build 38

Change:

- Bumped `CURRENT_PROJECT_VERSION` from 37 to 38 for the shared Xcode project
  build settings.
- Prepared build 38 for TestFlight with the job interval presets, first-run /
  next-run custom time scheduling, and the matching server scheduler API.

Verification:

- `swift run ZenithGuardrails`
- `python3 -m py_compile server/agent_server.py`
- `xcodebuild -project ZenithDock.xcodeproj -scheme ZenithDockMac -configuration Release -destination generic/platform=macOS -archivePath build/archives/ZenithDockMac-38.xcarchive archive -quiet -allowProvisioningUpdates`
- `xcodebuild -project ZenithDock.xcodeproj -scheme ZenithDockIOS -configuration Release -destination generic/platform=iOS -archivePath build/archives/ZenithDockIOS-38.xcarchive archive -quiet -allowProvisioningUpdates`
- Uploaded macOS build 38. Export output ended with `Uploaded ZenithDockMac`.
- Uploaded iOS/iPadOS build 38. Export output ended with
  `Uploaded ZenithDockIOS`.
- Archive `CFBundleVersion = 38` for both macOS and iOS/iPadOS.
- Archive `ITSAppUsesNonExemptEncryption = false` for both macOS and iOS/iPadOS.
- Refreshed `/Users/zen/agi/ZenithDock/dist/ZenithDock.app` from the verified
  build-38 macOS archive.
- Local `dist/ZenithDock.app` `CFBundleVersion = 38`.
- `codesign --verify --deep --strict --verbose=2 dist/ZenithDock.app`

## 2026-05-22 Follow-Up - Deploy Custom Job Timing Server

Problem:

- Custom job start/next times did not take effect if the Mac/iOS app was updated
  but the live agent server was still on the older scheduler API. Older Pydantic
  request models ignored `first_run_at` and `next_run_at`, so the scheduler fell
  back to `now + interval`.

Action:

- Deployed the current `server/agent_server.py` to `sonic` with
  `./server/deploy.sh sonic`.
- The deploy helper compiled the remote server, restarted
  `zenithbot-agent.service`, and confirmed the health endpoint was responding.
- Verified the remote server file contains `first_run_at`, `next_run_at`, and
  `parse_job_timestamp`.

## 2026-05-22 Follow-Up - Job Interval And Start-Time Controls

Problem:

- Scheduled jobs only exposed a raw seconds field. That made common intervals
  annoying to pick and did not let the user choose when the first/next run
  should fire.
- Editing an existing job could also reset the next run time indirectly because
  the interval was always patched back to the server.

Change:

- Added a reusable Mac job interval control with presets from 30 seconds through
  24 hours plus a custom seconds field.
- Added first-run controls for new jobs and next-run controls for existing
  jobs. New jobs can start after the interval, now, in 5/15/60 minutes, or at a
  custom date/time. Existing jobs can keep the current next run or explicitly
  reschedule it.
- Extended the server job API with optional `first_run_at` on create and
  `next_run_at` on update. Timestamps accept ISO-8601 strings or epoch seconds.
- Added matching iOS/iPadOS interval presets and first-run/next-run controls so
  mobile job scheduling does not fall back to raw seconds only.
- Existing job edits now only patch the interval/loop/enabled/backend values
  when they actually changed, so prompt/title edits do not reschedule by
  accident.

Verification:

- `swift run ZenithGuardrails`
- `python3 -m py_compile server/agent_server.py`
- `xcodebuild -project ZenithDock.xcodeproj -scheme ZenithDockMac -configuration Release -destination platform=macOS build -quiet`
- `xcodebuild -project ZenithDock.xcodeproj -scheme ZenithDockIOS -configuration Debug -destination 'generic/platform=iOS Simulator' build -quiet`
- Re-ran `swift run ZenithGuardrails`, `python3 -m py_compile
  server/agent_server.py`, and the iOS simulator build after adding the mobile
  scheduling UI.
- Refreshed `/Users/zen/agi/ZenithDock/dist/ZenithDock.app` from the fresh
  default DerivedData Release product.
- Verified `dist/ZenithDock.app` has `CFBundleVersion = 37`.
- `codesign --verify --deep --strict --verbose=2 dist/ZenithDock.app`

## 2026-05-22 Follow-Up - macOS TestFlight Build 37 Upload

Change:

- Bumped `CURRENT_PROJECT_VERSION` from 36 to 37 for the shared Xcode project
  build settings.
- Uploaded macOS TestFlight build 37. This build includes the timeline position
  settle fix after switching chats/threads.
- Refreshed `/Users/zen/agi/ZenithDock/dist/ZenithDock.app` from the verified
  macOS archive at
  `/Users/zen/agi/ZenithDock/build/archives/ZenithDockMac-37.xcarchive`.

Verification:

- `swift run ZenithGuardrails`
- `xcodebuild -project ZenithDock.xcodeproj -scheme ZenithDockMac -configuration Release -destination generic/platform=macOS -archivePath build/archives/ZenithDockMac-37.xcarchive archive -quiet -allowProvisioningUpdates`
- `xcodebuild -exportArchive -archivePath build/archives/ZenithDockMac-37.xcarchive -exportOptionsPlist build/TestFlightExportOptions.plist -exportPath build/TestFlightMacExport-37 -quiet -allowProvisioningUpdates`
- Export output ended with `Uploaded ZenithDockMac`.
- Archive `CFBundleVersion = 37`.
- Archive `ITSAppUsesNonExemptEncryption = false`.
- Local `dist/ZenithDock.app` `CFBundleVersion = 37`.
- `codesign --verify --deep --strict --verbose=2 dist/ZenithDock.app`

## 2026-05-22 Follow-Up - Settle Timeline Position After Thread Switch

Problem:

- Switching between chats/threads could land at an incorrect timeline position.
  The app was requesting bottom immediately, but SwiftUI could still be laying
  out the old/new row set, so the first scroll sometimes targeted stale
  geometry.

Change:

- Bottom jumps now settle over the next few layout passes after thread switches,
  explicit bottom requests, and live auto-follow.
- Delayed settles are guarded by the selected session ID, so a late scroll from
  one thread cannot affect another thread after a quick switch.

Verification:

- `swift run ZenithGuardrails`
- `swift build --product ZenithDock`
- `xcodebuild -project ZenithDock.xcodeproj -scheme ZenithDockMac -configuration Release -destination platform=macOS build -quiet`
- Refreshed `/Users/zen/agi/ZenithDock/dist/ZenithDock.app` from the fresh
  default DerivedData Release product:
  `/Users/zen/Library/Developer/Xcode/DerivedData/ZenithDock-goqrrfavgklzurgabmpxjsmlicso/Build/Products/Release/ZenithDock.app`.
- Verified `dist/ZenithDock.app` has `CFBundleVersion = 36`.
- `codesign --verify --deep --strict --verbose=2 dist/ZenithDock.app`

## 2026-05-21 Follow-Up - Stable Sidebar During Cached Switches

Problem:

- Chats could appear to jump in the sidebar during selection. The likely cause
  was stale cached `ZSession` metadata being applied before the server latest
  tail arrived. If cached `folder`, `pinned`, `archived`, or `sort_order` did
  not match the current server list, the clicked row could temporarily move
  sections/order, then move again when server metadata arrived.

Change:

- Cached chat application is now timeline-only for existing sessions. It can
  populate events/files instantly, but it no longer replaces existing sidebar
  session metadata. Cached session metadata is only appended if the session is
  missing from the list.
- Added a guardrail so `applyCachedChat` cannot regress to assigning
  `sessions[idx] = cached.session`.

Verification:

- `swift run ZenithGuardrails`
- `swift build --product ZenithDock`
- `xcodebuild -project ZenithDock.xcodeproj -scheme ZenithDockMac -configuration Release -destination platform=macOS build -quiet`
- Refreshed `/Users/zen/agi/ZenithDock/dist/ZenithDock.app` from the fresh
  default DerivedData Release product:
  `/Users/zen/Library/Developer/Xcode/DerivedData/ZenithDock-goqrrfavgklzurgabmpxjsmlicso/Build/Products/Release/ZenithDock.app`.
- Verified `dist/ZenithDock.app` has `CFBundleVersion = 36`.
- `codesign --verify --deep --strict --verbose=2 dist/ZenithDock.app`

## 2026-05-21 Follow-Up - Lighter Chat Switch Cache Path

Problem:

- After build 36, chat switching correctness improved but still had short
  frozen intervals. The remaining hot path was local: warm-cache switches could
  rebuild up to 1,440 cached events before the authoritative latest tail
  replaced them, and the delayed disk-cache writer sanitized/truncated large
  event text on the main actor.

Change:

- Warm-cache render snapshots now keep only the latest 480 events. Disk cache
  can still retain 1,440 events, but opening/switching a chat renders only the
  recent tail before the server latest-tail refresh lands.
- Applying a disk or memory cache now adjusts `omittedHistoryEventCount` for
  cached events hidden by the warm tail cap.
- Disk-cache sanitization and JSON encoding now run in a detached utility task.
  The main actor only captures the current snapshots and installs a small warm
  memory cache.

Verification:

- `swift run ZenithGuardrails`
- `swift build --product ZenithDock`
- `xcodebuild -project ZenithDock.xcodeproj -scheme ZenithDockMac -configuration Release -destination platform=macOS build -quiet`
- Refreshed `/Users/zen/agi/ZenithDock/dist/ZenithDock.app` from the fresh
  default DerivedData Release product:
  `/Users/zen/Library/Developer/Xcode/DerivedData/ZenithDock-goqrrfavgklzurgabmpxjsmlicso/Build/Products/Release/ZenithDock.app`.
- Verified `dist/ZenithDock.app` has `CFBundleVersion = 36`.
- `codesign --verify --deep --strict --verbose=2 dist/ZenithDock.app`

## 2026-05-21 Follow-Up - macOS TestFlight Build 36 Upload

Change:

- Bumped `CURRENT_PROJECT_VERSION` from `35` to `36` for iOS/iPadOS, macOS,
  and `ZenithCore`.
- Uploaded macOS TestFlight build `36`. This build includes the latest-tail
  cached-open rule so stale Macs refresh from the server's newest tail page
  instead of websocket-replaying from old cache state.
- Refreshed `/Users/zen/agi/ZenithDock/dist/ZenithDock.app` from the verified
  build-36 macOS archive.

Verification:

- `swift run ZenithGuardrails`
- `xcodebuild -project ZenithDock.xcodeproj -scheme ZenithDockMac -configuration Release -destination generic/platform=macOS -archivePath build/archives/ZenithDockMac-36.xcarchive archive -quiet -allowProvisioningUpdates`
- `xcodebuild -exportArchive -archivePath build/archives/ZenithDockMac-36.xcarchive -exportOptionsPlist build/TestFlightExportOptions.plist -exportPath build/TestFlightMacExport-36 -quiet -allowProvisioningUpdates`
  uploaded successfully: `Uploaded ZenithDockMac`.
- Verified archive has `CFBundleVersion = 36` and
  `ITSAppUsesNonExemptEncryption = false`.
- Verified `dist/ZenithDock.app` has `CFBundleVersion = 36`.
- `codesign --verify --deep --strict --verbose=2 dist/ZenithDock.app`

## 2026-05-21 Follow-Up - Latest Tail Wins on Cached Open

Problem:

- Build 35 still let machines diverge when one Mac had a stale cached chat.
  The cached-open logic tried to be clever with a probe/delta path, and earlier
  versions connected the websocket before the authoritative refresh. On a long
  gap, that could replay a large unbounded backlog and still leave the local
  timeline short of the server's latest page.

Decision:

- Keep the rule simple: whenever a cached chat is selected/opened, show the
  cached UI immediately, then always request the server's latest tail window
  (`limit=480&tail=true`) and rebuild the selected chat cache from that.
- Do not websocket-replay from the stale cached seq. Connect live streaming
  only after the latest tail has been applied, using the new `lastSeq`.
- Replace the selected timeline with the latest tail window for this refresh
  instead of merging old local history forward. Older history can still be
  requested explicitly from the top.

Verification:

- `swift run ZenithGuardrails`
- `swift build --product ZenithDock`
- `xcodebuild -project ZenithDock.xcodeproj -scheme ZenithDockMac -configuration Release -destination platform=macOS build -quiet`
- Refreshed `/Users/zen/agi/ZenithDock/dist/ZenithDock.app` from the fresh
  default DerivedData Release product:
  `/Users/zen/Library/Developer/Xcode/DerivedData/ZenithDock-goqrrfavgklzurgabmpxjsmlicso/Build/Products/Release/ZenithDock.app`.
- Verified `dist/ZenithDock.app` has `CFBundleVersion = 35`.
- `codesign --verify --deep --strict --verbose=2 dist/ZenithDock.app`

## 2026-05-21 Follow-Up - TestFlight Build 35 Upload

Change:

- Bumped `CURRENT_PROJECT_VERSION` from `34` to `35` for iOS/iPadOS, macOS,
  and `ZenithCore`.
- Uploaded build `35` for both TestFlight platforms. This build includes the
  cached-open probe fix: cached chats only show the "Opening latest messages"
  overlay when the server proves there are newer events.
- Refreshed `/Users/zen/agi/ZenithDock/dist/ZenithDock.app` from the verified
  build-35 macOS archive because the normal Release product cache still showed
  an old local `CFBundleVersion`.

Verification:

- `swift run ZenithGuardrails`
- `xcodebuild -project ZenithDock.xcodeproj -scheme ZenithDockIOS -configuration Release -destination generic/platform=iOS -archivePath build/archives/ZenithDockIOS-35.xcarchive archive -quiet -allowProvisioningUpdates`
- `xcodebuild -exportArchive -archivePath build/archives/ZenithDockIOS-35.xcarchive -exportOptionsPlist build/TestFlightExportOptions.plist -exportPath build/TestFlightIOSExport-35 -quiet -allowProvisioningUpdates`
  uploaded successfully: `Uploaded ZenithDockIOS`.
- `xcodebuild -project ZenithDock.xcodeproj -scheme ZenithDockMac -configuration Release -destination generic/platform=macOS -archivePath build/archives/ZenithDockMac-35.xcarchive archive -quiet -allowProvisioningUpdates`
- `xcodebuild -exportArchive -archivePath build/archives/ZenithDockMac-35.xcarchive -exportOptionsPlist build/TestFlightExportOptions.plist -exportPath build/TestFlightMacExport-35 -quiet -allowProvisioningUpdates`
  uploaded successfully: `Uploaded ZenithDockMac`.
- Verified both archives have `CFBundleVersion = 35` and
  `ITSAppUsesNonExemptEncryption = false`.
- `codesign --verify --deep --strict --verbose=2 dist/ZenithDock.app`

## 2026-05-21 Follow-Up - Build 34 Cached Open Probe

Problem:

- Build 34 made cached chat opens fast, but too quiet: warm cached chats could
  connect the websocket and run a background delta without an obvious loading
  path. If new server events existed, the user could interpret the no-spinner
  path as "new messages are not showing."
- Reverting to a full tail snapshot on every open would bring back the old
  text fly-by and high CPU path for huge chats.

Change:

- Warm cached chat opens now do a one-event probe:
  `/api/sessions/{id}?after=<cachedLastSeq>&limit=1`.
- If the probe says the cached seq is current, the app leaves the timeline
  completely alone: no spinner, no row rebuild, no scroll jump.
- If the probe sees a newer server seq, the app shows the existing "Opening
  latest messages" overlay, fetches only the delta after the current seq, merges
  it, saves cache, and scrolls to bottom if the user was already at bottom.
- Cold/no-cache opens still use the old full latest-tail loading path.

Verification:

- `swift run ZenithGuardrails`
- `swift build --product ZenithDock`
- `xcodebuild -project ZenithDock.xcodeproj -scheme ZenithDockMac -configuration Release -destination platform=macOS build -quiet`
- Refreshed `/Users/zen/agi/ZenithDock/dist/ZenithDock.app` with `ditto`.
- `codesign --verify --deep --strict --verbose=2 dist/ZenithDock.app`

## 2026-05-21 Follow-Up - TestFlight Build 34 Upload

Change:

- Bumped `CURRENT_PROJECT_VERSION` from `33` to `34` for iOS/iPadOS, macOS,
  and `ZenithCore`.
- Uploaded build `34` for both TestFlight platforms. This includes the fixed
  Mac composer, duplicate-selection fix, cached chat lazy switch work, and
  cached-chat delta sync.

Verification:

- `swift run ZenithGuardrails`
- `xcodebuild -project ZenithDock.xcodeproj -scheme ZenithDockIOS -configuration Release -destination generic/platform=iOS -archivePath build/archives/ZenithDockIOS-34.xcarchive archive -quiet -allowProvisioningUpdates`
- `xcodebuild -exportArchive -archivePath build/archives/ZenithDockIOS-34.xcarchive -exportOptionsPlist build/TestFlightExportOptions.plist -exportPath build/TestFlightIOSExport-34 -quiet -allowProvisioningUpdates`
  uploaded successfully: `Uploaded ZenithDockIOS`.
- `xcodebuild -project ZenithDock.xcodeproj -scheme ZenithDockMac -configuration Release -destination generic/platform=macOS -archivePath build/archives/ZenithDockMac-34.xcarchive archive -quiet -allowProvisioningUpdates`
- `xcodebuild -exportArchive -archivePath build/archives/ZenithDockMac-34.xcarchive -exportOptionsPlist build/TestFlightExportOptions.plist -exportPath build/TestFlightMacExport-34 -quiet -allowProvisioningUpdates`
  uploaded successfully: `Uploaded ZenithDockMac`.
- Verified both archives have `CFBundleVersion = 34` and
  `ITSAppUsesNonExemptEncryption = false`.

## 2026-05-21 Follow-Up - Composer and Warm-Selection Hot Path

Problem:

- Typing in the Mac composer was still sluggish with long pasted prompts.
- Follow-up: the bounded line-count pass still left AppKit/SwiftUI negotiating
  editor height while typing. Even if the scan was small, resizing/layout
  feedback was the wrong shape for a chat composer.
- Quick chat switching could still show the “Opening latest messages” overlay
  because the sidebar published `selectedSessionID` before `AppStore.select`
  had applied the warm cache.
- Regression during the first pass: after moving sidebar selection to explicit
  `store.select`, `RootView` still had its old `selectedSessionID` observer and
  could start a second selection on the same click. That felt like a freeze when
  switching chats.
- Follow-up: cached chat switches still hit the server immediately and kicked
  off file/video metadata refreshes. Switching away also sanitized/copied up to
  1,440 events into memory cache, and timeline projection allocated trimmed
  copies of large assistant/job strings just to test whether they were empty.
- Follow-up: delaying a full tail refresh still caused a visible “fly-by” when
  the cached timeline was replaced by the server tail. The right behavior is to
  load on open, but only load the delta after the cached seq.

Change:

- The composer no longer scans for non-whitespace or splits the full draft on
  the keystroke path. Placeholder presence now uses the native text storage
  length, and composer height uses a bounded first-440-character scan.
- Follow-up simplification: removed auto-growing height entirely. The Mac
  composer is now a fixed-height native `NSTextView` inside its own scroll view,
  with no line-count callbacks/tasks into SwiftUI while typing. The text layout
  manager allows non-contiguous/background layout for long drafts.
- Sidebar selection now routes through an explicit `store.select(sessionID:)`
  binding instead of directly mutating `store.selectedSessionID`, so warm cached
  chat data can be applied before the visible selection flips.
- Removed the duplicate `RootView` selected-session observer. Selection now has
  one owner on Mac: explicit UI/store calls into `AppStore.select`.
- Warm-cache chat switches now show cache, connect the websocket after cached
  `lastSeq`, and issue a lightweight HTTP delta request with `after=<lastSeq>`.
  Cached opens no longer replace the timeline with a fresh tail snapshot and do
  not refresh the file/video side panel unless the user clicks refresh/load more.
- Memory chat snapshots no longer sanitize/clip large text on the click path;
  disk cache sanitization still happens in the delayed cache write.
- Timeline rendering now projects a bounded recent event window in `body`, and
  assistant/job grouping uses non-allocating visible-text checks instead of
  `trimmingCharacters` copies on large strings.
- Added guardrails for bounded line-count work and explicit warm-cache sidebar
  selection, plus a guardrail against duplicate RootView selection.
- Refreshed `/Users/zen/agi/ZenithDock/dist/ZenithDock.app`.

Verification:

- `swift build --product ZenithDock`
- `swift run ZenithGuardrails`
- `xcodebuild -project ZenithDock.xcodeproj -scheme ZenithDockMac -configuration Release -destination platform=macOS build -quiet`
- `codesign --verify --deep --strict --verbose=2 dist/ZenithDock.app`

## 2026-05-21 Follow-Up - TestFlight Build 32 Upload

Change:

- Bumped `CURRENT_PROJECT_VERSION` from `31` to `32` for iOS/iPadOS, macOS,
  and `ZenithCore`.
- Uploaded build `32` for both TestFlight platforms. This build includes the
  inline full-text expansion, warmer chat switching cache, and lighter composer
  keystroke path.

Verification:

- `swift run ZenithGuardrails`
- `xcodebuild -project ZenithDock.xcodeproj -scheme ZenithDockIOS -configuration Release -destination generic/platform=iOS -archivePath build/archives/ZenithDockIOS-32.xcarchive archive -quiet -allowProvisioningUpdates`
- `xcodebuild -exportArchive -archivePath build/archives/ZenithDockIOS-32.xcarchive -exportOptionsPlist build/TestFlightExportOptions.plist -exportPath build/TestFlightIOSExport-32 -quiet -allowProvisioningUpdates`
  uploaded successfully: `Uploaded ZenithDockIOS`.
- `xcodebuild -project ZenithDock.xcodeproj -scheme ZenithDockMac -configuration Release -destination generic/platform=macOS -archivePath build/archives/ZenithDockMac-32.xcarchive archive -quiet -allowProvisioningUpdates`
- `xcodebuild -exportArchive -archivePath build/archives/ZenithDockMac-32.xcarchive -exportOptionsPlist build/TestFlightExportOptions.plist -exportPath build/TestFlightMacExport-32 -quiet -allowProvisioningUpdates`
  uploaded successfully: `Uploaded ZenithDockMac`.
- Verified both archives have `CFBundleVersion = 32` and
  `ITSAppUsesNonExemptEncryption = false`.

## 2026-05-21 Follow-Up - Restore Sidebar Provider Icons

Problem:

- The sidebar single-dot cleanup went too far and replaced the Claude/Codex
  provider icons with plain status dots.

Change:

- Mac and iOS/iPadOS sidebar rows now show the provider logo again.
- Running/unread status is a single optional tiny badge on the provider icon.
- Idle and archived rows do not show an extra standalone status dot.
- Updated guardrails so future sidebar cleanups keep backend icons while
  avoiding duplicate dot clutter.

Verification:

- `swift run ZenithGuardrails`

## 2026-05-21 Follow-Up - Strict Tmux Submitter Defaults

Problem:

- The first tmux inspector narrowing still let unrelated panes into the default
  view when many chats shared the same project cwd, or when broad tokens from
  recent chat text overlapped with other submitter sessions.

Change:

- Default tmux inspector results now require a strict chat link:
  the deterministic per-chat tmux session name or an explicit tmux target
  mentioned in recent chat events.
- Same-cwd and generic submitter keyword matches remain visible as chips, but
  no longer qualify a pane for the default list. The `All` toggle remains the
  machine-wide escape hatch.
- Removed broad chat-text token mining from the server filter and added
  guardrails so it does not come back.

Verification:

- `python3 -m py_compile server/agent_server.py`
- `swift run ZenithGuardrails`

## 2026-05-21 Follow-Up - Narrow Tmux Submitter Inspector

Problem:

- The Mac `Tmux Submitters` inspector showed many unrelated panes because
  `/home/zen` counted as a chat working directory and because submitter-like
  keywords alone were enough to include a pane.

Change:

- Server tmux filtering now treats broad home/default roots as too generic to
  count as a chat cwd.
- Default tmux inspector results now require an actual chat link:
  per-chat tmux session, meaningful chat cwd, or a token from the recent chat
  context. Generic `osmo` / `train` / `submitter` keyword matches are still
  shown as chips, but no longer pull unrelated panes into the default list.
- The Mac inspector copy now says the `All` checkbox is the machine-wide view.
- Added guardrails for the narrower default filter.

Verification:

- `python3 -m py_compile server/agent_server.py`
- `swift run ZenithGuardrails`
- `swift build --product ZenithDock`
- `xcodebuild -scheme ZenithDockMac -configuration Release -destination platform=macOS -derivedDataPath build/DerivedData build -quiet`
- Refreshed `/Users/zen/agi/ZenithDock/dist/ZenithDock.app` and verified
  codesign.
- Deployed to `sonic` with `./server/deploy.sh sonic`; service restarted and
  responded to health with auth-required, which confirms the server is up.

## 2026-05-21 Follow-Up - Sidebar Single Dot Indicator

Problem:

- Sidebar chat rows became visually busy after provider logos, running badges,
  and unread badges all stacked around the same row.

Change:

- Mac and iOS/iPadOS sidebar rows now use one compact status dot total.
- Dot priority is unread, running, archived, then backend-colored idle state.
- Provider logo assets remain available in roomier surfaces like the composer
  and running-agent banner.
- Added guardrails so dense sidebar rows stay on the single-dot treatment.

Verification:

- `swift run ZenithGuardrails`

## 2026-05-21 Follow-Up - TestFlight Build 31 Upload

Change:

- Bumped `CURRENT_PROJECT_VERSION` from `30` to `31` for iOS/iPadOS, macOS,
  and `ZenithCore`.
- Uploaded build `31` for both TestFlight platforms after adding the export
  compliance plist flag.
- Refreshed the normal local macOS app at
  `/Users/zen/agi/ZenithDock/dist/ZenithDock.app` from the signed build `31`
  macOS archive.

Verification:

- `swift run ZenithGuardrails`
- `xcodebuild -scheme ZenithDockIOS -configuration Release -destination generic/platform=iOS -archivePath build/archives/ZenithDockIOS-31.xcarchive archive -quiet -allowProvisioningUpdates`
- `xcodebuild -exportArchive -archivePath build/archives/ZenithDockIOS-31.xcarchive -exportOptionsPlist build/TestFlightExportOptions.plist -exportPath build/TestFlightIOSExport-31 -quiet -allowProvisioningUpdates`
  uploaded successfully: `Uploaded ZenithDockIOS`.
- `xcodebuild -scheme ZenithDockMac -configuration Release -destination generic/platform=macOS -archivePath build/archives/ZenithDockMac-31.xcarchive archive -quiet -allowProvisioningUpdates`
- `xcodebuild -exportArchive -archivePath build/archives/ZenithDockMac-31.xcarchive -exportOptionsPlist build/TestFlightExportOptions.plist -exportPath build/TestFlightMacExport-31 -quiet -allowProvisioningUpdates`
  uploaded successfully: `Uploaded ZenithDockMac`.
- Verified both archives have `CFBundleVersion = 31` and
  `ITSAppUsesNonExemptEncryption = false`.
- Verified `dist/ZenithDock.app` codesign and plist values.

## 2026-05-21 Follow-Up - TestFlight Export Compliance Flag

Problem:

- TestFlight builds can show `Missing Compliance` when the app bundle does not
  declare its encryption/export-compliance status.

Change:

- Added `ITSAppUsesNonExemptEncryption = false` to both app plists:
  `Apps/ZenithDockIOS/Info.plist` and `Apps/ZenithDockMac/Info.plist`.
- Added a guardrail so future plist edits do not drop the flag.

Verification:

- `plutil -lint Apps/ZenithDockIOS/Info.plist Apps/ZenithDockMac/Info.plist`
- `swift run ZenithGuardrails`
- `swift build --product ZenithDock`
- `xcodebuild -scheme ZenithDockIOS -configuration Debug -destination generic/platform=iOS build -quiet`
- `xcodebuild -scheme ZenithDockIOS -configuration Debug -destination generic/platform=iOS -derivedDataPath build/DerivedDataIOS build -quiet`
- `xcodebuild -scheme ZenithDockMac -configuration Release -destination platform=macOS -derivedDataPath build/DerivedData build -quiet`
- Verified both built app plists print `false` for
  `ITSAppUsesNonExemptEncryption`.
- Refreshed `/Users/zen/agi/ZenithDock/dist/ZenithDock.app` and verified
  codesign.

## 2026-05-21 Follow-Up - Live Timeline Auto-Follow

Problem:

- During selected-chat streaming, new event rows could push the timeline bottom
  away before the scroll request landed. The Mac timeline then rejected the
  request because its local `isAtBottom` flag had already flipped false, causing
  visible stream jank and unread/bottom-button weirdness while the chat was in
  front.

Change:

- Mac timeline now centralizes bottom-follow decisions with
  `shouldFollowBottomRequest`.
- Newer selected-chat events auto-scroll when the timeline was at/near bottom,
  the store still considers it at bottom, or the selected chat is actively
  running.
- Auto-follow uses event sequence checks, so prepending older history still
  preserves the user's scroll position instead of jumping to the bottom.
- iOS/iPadOS timeline received the same sequence-aware live-follow behavior.
- Added guardrails for live auto-follow so future scroll changes do not regress
  this.

Verification:

- `swift run ZenithGuardrails`
- `swift build --product ZenithDock`
- `xcodebuild -scheme ZenithDockIOS -configuration Debug -destination generic/platform=iOS build -quiet`
- `xcodebuild -scheme ZenithDockMac -configuration Release -destination platform=macOS -derivedDataPath build/DerivedData build -quiet`
- Refreshed `/Users/zen/agi/ZenithDock/dist/ZenithDock.app` and verified
  codesign.

## 2026-05-21 Follow-Up - Manual Mark Chat Unread

Problem:

- The app only marked chats unread automatically when new visible agent output
  arrived while the chat was not read. There was no way to manually revisit a
  chat later by marking it unread.

Change:

- Added `Mark as Unread` / `Mark as Read` actions to Mac and iOS/iPadOS chat
  row context menus.
- Manual unread moves the local server-scoped read cursor to just before the
  latest visible agent event, so the unread state persists across refreshes.
- Mac keeps a manual-unread override while the selected chat is open so the
  bottom observer does not immediately clear the badge. Pressing the bottom/new
  button clears the manual unread mark intentionally.
- Added guardrails for the manual unread actions and cursor behavior.

Verification:

- `swift run ZenithGuardrails`
- `swift build --product ZenithDock`
- `xcodebuild -scheme ZenithDockIOS -configuration Debug -destination generic/platform=iOS build -quiet`
- `xcodebuild -scheme ZenithDockMac -configuration Release -destination platform=macOS -derivedDataPath build/DerivedData build -quiet`
- Refreshed `/Users/zen/agi/ZenithDock/dist/ZenithDock.app` and verified
  codesign.

## 2026-05-21 Follow-Up - Tmux Submitter Visualizer

Problem:

- Agents often launch long-running work inside tmux, but the app could only show
  the currently running Claude/Codex process tree. If a submitter lived in tmux,
  the user had no lightweight way to discover it or inspect recent pane output.

Change:

- Added server endpoints:
  `/api/sessions/{session_id}/tmux` and
  `/api/sessions/{session_id}/tmux/capture`.
- The tmux list is on demand. It filters panes that match the chat working
  directory, the app-owned `zd_<session>` tmux session, or submitter-like
  keywords such as `submit`, `sbatch`, `osmo`, `train`, `render`, `ray`.
- Added shared Swift models and a Mac inspector card named `Tmux Submitters`.
  The UI loads only when clicked, can show all tmux panes, and captures a pane's
  latest output on demand.
- Added guardrails for the server endpoints, shared models, store methods, and
  inspector UI.
- Deployed the updated server to `sonic` with `./server/deploy.sh sonic`.

Verification:

- `python3 -m py_compile server/agent_server.py`
- `swift run ZenithGuardrails`
- `swift build --product ZenithDock`
- `xcodebuild -scheme ZenithDockMac -configuration Release -destination platform=macOS -derivedDataPath build/DerivedData build -quiet`
- Refreshed `/Users/zen/agi/ZenithDock/dist/ZenithDock.app` and verified
  codesign.

## 2026-05-21 Follow-Up - iOS No Auto-Open First Chat

Problem:

- iOS/iPadOS could jump into the first chat automatically whenever the session
  list refreshed with no selected chat, or after deleting the selected chat.

Change:

- Removed the mobile `sessions.first` auto-selection fallback from session
  refresh. Refresh now only clears selection if the currently selected chat no
  longer exists.
- Deleting the selected chat now returns to the empty `No Chat Selected` state
  instead of opening the next chat.
- Create, resume, and fork still explicitly open the newly created chat.
- Added guardrails so iOS refresh/delete cannot regress to first-chat
  auto-selection.

## 2026-05-20 Follow-Up - Stable Sidebar Order

Problem:

- The server sorted chats by `updated_at`, so job output, archive toggles,
  runtime saves, and metadata refreshes could make rows jump around.
- Archive/unarchive changes made on another app instance could lag until the
  user selected the chat, because session-list sync only ran every 30 seconds.

Change:

- Added server-side `sort_order` metadata and migrated existing sessions into
  their current visible order once. The session list now sorts by archive/pin/
  folder group and explicit `sort_order`, not recent activity.
- New chats enter the top of their section. Moving between folder/pinned/
  archived sections puts the chat at the top of the destination section; normal
  activity does not reorder rows.
- Added `/api/sessions/{session_id}/order` to move a chat up/down within its
  current section by swapping `sort_order` with its neighbor.
- Added Mac and iOS/iPadOS context-menu controls for `Move Up` / `Move Down`.
- Mac and iOS/iPadOS now refresh the session list every live-tracking tick
  after health succeeds, so archive/unarchive and unread metadata sync much
  faster across app instances connected to the same server.
- Added guardrails for `sort_order`, stable app ordering, manual reorder
  controls, and the server reorder endpoint.

Deploy:

- Deployed `server/agent_server.py` to `sonic` and restarted
  `zenithbot-agent.service`.
- Fixed `server/deploy.sh` so the default remote app path is `Zenithbot`
  relative to the SSH home. The old `~/Zenithbot` default stayed literal inside
  the remote compile command.

## 2026-05-20 Follow-Up - TestFlight Build 30 Uploaded

Summary:

- Build `30` includes stable sidebar ordering, manual chat move up/down, and
  faster session-list sync for archive/unarchive changes.
- Bumped all Xcode targets from build `29` to build `30`.
- Committed the ordering fix:
  `e4196a4 Keep sidebar session order stable`.
- Committed the deploy-script fix:
  `18d8074 Fix default server deploy path`.
- Committed the build bump:
  `c960d8b Bump build number for TestFlight 30`.
- Archived and uploaded iOS/iPadOS build `30` successfully:
  `Uploaded ZenithDockIOS`.
- Archived and uploaded macOS build `30` successfully:
  `Uploaded ZenithDockMac`.
- Refreshed and codesign-verified
  `/Users/zen/agi/ZenithDock/dist/ZenithDock.app`.
- Both packages are processing in App Store Connect/TestFlight.

Commands:

- `xcodebuild -scheme ZenithDockIOS -configuration Release -destination generic/platform=iOS -archivePath build/archives/ZenithDockIOS-30.xcarchive archive -quiet -allowProvisioningUpdates`
- `xcodebuild -exportArchive -archivePath build/archives/ZenithDockIOS-30.xcarchive -exportOptionsPlist build/TestFlightExportOptions.plist -exportPath build/TestFlightIOSExport-30 -quiet -allowProvisioningUpdates`
- `xcodebuild -scheme ZenithDockMac -configuration Release -destination generic/platform=macOS -archivePath build/archives/ZenithDockMac-30.xcarchive archive -quiet -allowProvisioningUpdates`
- `xcodebuild -exportArchive -archivePath build/archives/ZenithDockMac-30.xcarchive -exportOptionsPlist build/TestFlightExportOptions.plist -exportPath build/TestFlightMacExport-30 -quiet -allowProvisioningUpdates`

## 2026-05-20 Follow-Up - Scheduled Job Unread State

Problem:

- Unread state worked only for events arriving through the currently selected
  chat websocket. Scheduled jobs can append output while another chat is open,
  so those chats never became unread from the sidebar session-list refresh.

Change:

- Server sessions now track `latest_event_seq` and
  `latest_agent_event_seq` metadata as events are appended.
- Agent-visible events include normal assistant text/results, errors,
  artifacts, and scheduled-job `job_ran` / `job_error` events.
- The Mac and iOS/iPadOS apps now keep a server-scoped local
  `lastReadAgentSeq` map and reconcile unread rows from `/api/sessions`.
- Selecting/reading a chat updates the local last-read seq; scheduled-job output
  in non-selected chats now shows as unread after the next session refresh.
- Added guardrails so server session metadata, scheduled-job visibility, Mac
  unread reconciliation, and iOS sidebar unread indicators do not regress.

## 2026-05-20 Follow-Up - TestFlight Build 29 Uploaded

Summary:

- Build `29` includes server/app support for scheduled-job unread/read state.
- Bumped all Xcode targets from build `28` to build `29`.
- Committed the functional fix:
  `4f4e7ff Fix scheduled job unread state`.
- Committed the build bump:
  `f9eb0e2 Bump build number for TestFlight 29`.
- Archived and uploaded iOS/iPadOS build `29` successfully:
  `Uploaded ZenithDockIOS`.
- Archived and uploaded macOS build `29` successfully:
  `Uploaded ZenithDockMac`.
- Refreshed and codesign-verified
  `/Users/zen/agi/ZenithDock/dist/ZenithDock.app`.
- Both packages are processing in App Store Connect/TestFlight.

Commands:

- `xcodebuild -scheme ZenithDockIOS -configuration Release -destination generic/platform=iOS -archivePath build/archives/ZenithDockIOS-29.xcarchive archive -quiet -allowProvisioningUpdates`
- `xcodebuild -exportArchive -archivePath build/archives/ZenithDockIOS-29.xcarchive -exportOptionsPlist build/TestFlightExportOptions.plist -exportPath build/TestFlightIOSExport-29 -quiet -allowProvisioningUpdates`
- `xcodebuild -scheme ZenithDockMac -configuration Release -destination generic/platform=macOS -archivePath build/archives/ZenithDockMac-29.xcarchive archive -quiet -allowProvisioningUpdates`
- `xcodebuild -exportArchive -archivePath build/archives/ZenithDockMac-29.xcarchive -exportOptionsPlist build/TestFlightExportOptions.plist -exportPath build/TestFlightMacExport-29 -quiet -allowProvisioningUpdates`

## 2026-05-20 Follow-Up - TestFlight Build 28 Uploaded

Summary:

- Build `28` includes the unread marker repair and the large-chat history
  paging/cache fixes.
- Bumped all Xcode targets from build `27` to build `28`.
- Committed the build bump:
  `c9152f7 Bump build number for TestFlight 28`.
- Archived and uploaded iOS/iPadOS build `28` successfully:
  `Uploaded ZenithDockIOS`.
- Archived and uploaded macOS build `28` successfully:
  `Uploaded ZenithDockMac`.
- Refreshed and codesign-verified
  `/Users/zen/agi/ZenithDock/dist/ZenithDock.app`.
- Both packages are processing in App Store Connect/TestFlight.

Commands:

- `xcodebuild -scheme ZenithDockIOS -configuration Release -destination generic/platform=iOS -archivePath build/archives/ZenithDockIOS-28.xcarchive archive -quiet -allowProvisioningUpdates`
- `xcodebuild -exportArchive -archivePath build/archives/ZenithDockIOS-28.xcarchive -exportOptionsPlist build/TestFlightExportOptions.plist -exportPath build/TestFlightIOSExport-28 -quiet -allowProvisioningUpdates`
- `xcodebuild -scheme ZenithDockMac -configuration Release -destination generic/platform=macOS -archivePath build/archives/ZenithDockMac-28.xcarchive archive -quiet -allowProvisioningUpdates`
- `xcodebuild -exportArchive -archivePath build/archives/ZenithDockMac-28.xcarchive -exportOptionsPlist build/TestFlightExportOptions.plist -exportPath build/TestFlightMacExport-28 -quiet -allowProvisioningUpdates`

## 2026-05-19 Follow-Up - Inline Mac Connection Failures

Problem:

- On the first Mac connection attempt, a normal server-unreachable state showed
  as a blocking modal alert.

Finding:

- Mac startup/background refresh already passed `showErrors: false`, but
  user-triggered reconnect and refresh paths still promoted `NSURLErrorDomain`
  failures into global `errorText`.
- `RootView` shows every `errorText` as a modal, so a missing server became an
  app-stopping alert instead of an inline red/offline status.

Change:

- Added `connectionProblemText` to the Mac store for inline server reachability
  failures.
- Network connection failures now update the server status area and do not set
  modal `errorText`.
- Auth/token and real app/action errors still use the modal path.
- `refresh()` now stops after health fails instead of continuing into sessions
  and jobs requests against a known-offline server.
- Added guardrails so Mac connection failures stay inline.

## 2026-05-19 Follow-Up - TestFlight Build 26 Uploaded

Summary:

- Build `26` includes the latest-tail chat open fix and structural timeline row
  suspension to avoid text fly-by CPU spikes.
- Bumped all project targets from build `25` to build `26`.
- Committed the build bump:
  `e012cad Bump build number for TestFlight 26`.
- Archived and uploaded iOS/iPadOS build `26` successfully:
  `Uploaded ZenithDockIOS`.
- Archived and uploaded macOS build `26` successfully:
  `Uploaded ZenithDockMac`.
- Both packages are processing in App Store Connect/TestFlight.

Commands:

- `xcodebuild -scheme ZenithDockIOS -configuration Release -destination generic/platform=iOS -archivePath build/archives/ZenithDockIOS-26.xcarchive archive -quiet -allowProvisioningUpdates`
- `xcodebuild -exportArchive -archivePath build/archives/ZenithDockIOS-26.xcarchive -exportOptionsPlist build/TestFlightExportOptions.plist -exportPath build/TestFlightIOSExport-26 -quiet -allowProvisioningUpdates`
- `xcodebuild -scheme ZenithDockMac -configuration Release -destination generic/platform=macOS -archivePath build/archives/ZenithDockMac-26.xcarchive archive -quiet -allowProvisioningUpdates`
- `xcodebuild -exportArchive -archivePath build/archives/ZenithDockMac-26.xcarchive -exportOptionsPlist build/TestFlightExportOptions.plist -exportPath build/TestFlightMacExport-26 -quiet -allowProvisioningUpdates`
- Refreshed and verified `/Users/zen/agi/ZenithDock/dist/ZenithDock.app`.

## 2026-05-19 Follow-Up - Suspend Timeline Rows While Opening

Problem:

- The timeline fly-by also caused high CPU, because SwiftUI still laid out
  hidden rows under the loading mask.

Finding:

- `.opacity(0)` hid the timeline visually but did not stop row projection,
  Markdown rendering, card layout, or scroll metric work.
- iOS could do similar work after applying a memory cache because it cleared
  `isLoading` before the network tail snapshot replaced the cache.

Change:

- Mac timeline now structurally suspends row projection/rendering while the
  initial mask is up and the selected latest snapshot is not loaded yet.
- iOS/iPadOS timeline does the same while chat loading is active.
- The timelines render only a lightweight loading shell until the latest tail
  snapshot is ready, then render one invisible layout pass, scroll to bottom,
  and reveal.
- Added guardrails that fail if row rendering is not suspended during open.

## 2026-05-19 Follow-Up - Latest Tail Snapshot On Chat Open

Problem:

- The timeline could still visibly fly through text after the latest-message
  spinner.

Finding:

- The previous masking fix hid most intermediate layout, but chat open still
  used cached history as a base and requested `after=<cached seq>` with
  `tail=false`.
- For long chats, that returned a middle catch-up page instead of the latest
  page. The app then published that intermediate text before landing.

Change:

- On Mac and iOS/iPadOS, chat open now always requests the latest tail page:
  `limit=<initial page>` and `tail=true`.
- Cached history remains a hidden warm start/fallback, but successful network
  load replaces it with the latest snapshot instead of merging a catch-up
  segment.
- Added guardrails that fail if chat open reintroduces `requestAfter` or
  `tail=false` catch-up behavior.

## 2026-05-19 Follow-Up - TestFlight Build 25 Uploaded

Summary:

- Build `25` includes the archive-chat support and latest-timeline reveal
  gating fixes.
- Bumped all project targets from build `24` to build `25`.
- Committed the build bump:
  `49bc592 Bump build number for TestFlight 25`.
- Archived and uploaded iOS/iPadOS build `25` successfully:
  `Uploaded ZenithDockIOS`.
- Archived and uploaded macOS build `25` successfully:
  `Uploaded ZenithDockMac`.
- Both packages are processing in App Store Connect/TestFlight.

Commands:

- `xcodebuild -scheme ZenithDockIOS -configuration Release -destination generic/platform=iOS -archivePath build/archives/ZenithDockIOS-25.xcarchive archive -quiet -allowProvisioningUpdates`
- `xcodebuild -exportArchive -archivePath build/archives/ZenithDockIOS-25.xcarchive -exportOptionsPlist build/TestFlightExportOptions.plist -exportPath build/TestFlightIOSExport-25 -quiet -allowProvisioningUpdates`
- `xcodebuild -scheme ZenithDockMac -configuration Release -destination generic/platform=macOS -archivePath build/archives/ZenithDockMac-25.xcarchive archive -quiet -allowProvisioningUpdates`
- `xcodebuild -exportArchive -archivePath build/archives/ZenithDockMac-25.xcarchive -exportOptionsPlist build/TestFlightExportOptions.plist -exportPath build/TestFlightMacExport-25 -quiet -allowProvisioningUpdates`
- Refreshed and verified `/Users/zen/agi/ZenithDock/dist/ZenithDock.app`.

## 2026-05-19 Follow-Up - Mask Initial Timeline Positioning

Problem:

- Switching/opening chats could briefly show a large wall of history moving
  through the timeline before the app restored the latest-message position.
- The root cause was visual, not data loading: rows rendered before the
  `ScrollViewReader` bottom scroll settled.

Change:

- Added an initial-positioning mask in
  `Sources/ZenithDock/Views/TimelineView.swift`.
- During session restore, timeline rows still lay out invisibly so the bottom
  anchor exists, then the app scrolls to bottom without animation and reveals
  the timeline after a short settle delay.
- Empty chats are handled by revealing once `loadedSessionID` matches the
  selected session.
- The bottom/new-message button stays hidden while the positioning mask is up.

Verification:

- `swift build --product ZenithDock` passed.
- `swift run ZenithGuardrails` passed.
- `xcodebuild -scheme ZenithDockMac -configuration Release -destination platform=macOS build -quiet` passed.
- `xcodebuild -scheme ZenithDockIOS -configuration Debug -destination generic/platform=iOS build -quiet` passed.
- Refreshed and verified `/Users/zen/agi/ZenithDock/dist/ZenithDock.app`.

## 2026-05-19 Follow-Up - Folded Message Notice Styling

Summary:

- Removed the fold notice from the rendered Markdown body in
  `Sources/ZenithDock/Views/EventViews.swift`.
- Folded messages now show a tinted footer chip with:
  - hidden character count
  - note that copy/full text use the complete message
  - `Open full text` action
- The footer tint follows message type: user green, job orange, assistant accent.

Verification:

- `swift run ZenithGuardrails` passed.
- `swift build --product ZenithDock` passed.
- `xcodebuild -scheme ZenithDockMac -configuration Release -destination platform=macOS build -quiet` passed.
- `xcodebuild -scheme ZenithDockIOS -configuration Debug -destination generic/platform=iOS build -quiet` passed.
- Refreshed and verified `/Users/zen/agi/ZenithDock/dist/ZenithDock.app`.

## 2026-05-19 Follow-Up - Fork History Copy And Scroll Jitter

Findings:

- Codex memory-fork fallback already packs the latest window:
  `build_fork_memory()` reads the newest `160` events with `tail=True`, clips
  each message around `ZENITHBOT_FORK_MEMORY_ITEM_CHARS` / `1800` chars, and
  caps the whole seed at `ZENITHBOT_FORK_MEMORY_CHARS` / `24000` chars.
- The visible fork timeline copy was not latest:
  `copy_fork_history()` called `read_events(parent_id, limit=10000)`, but
  `read_events()` clamps every request to `ZENITHBOT_MAX_EVENT_RESPONSE_LIMIT`
  / `1000` and, without `tail=True`, returns the first events.

Changes:

- `server/agent_server.py` now uses `iter_session_events(parent_id)` for the
  internal fork history copy, so it is not capped by API pagination.
- Made macOS unread state non-chatty:
  - `markSessionRead` and `markAgentUnread` now no-op when state is unchanged.
  - Timeline scroll metrics only clear unread state near bottom when the
    selected chat actually has unread state.

Verification:

- `python3 -m py_compile server/agent_server.py` passed.
- `swift run ZenithGuardrails` passed.
- `swift build --product ZenithDock` passed.
- `xcodebuild -scheme ZenithDockMac -configuration Release -destination platform=macOS build -quiet` passed.
- `xcodebuild -scheme ZenithDockIOS -configuration Debug -destination generic/platform=iOS build -quiet` passed.
- Refreshed and verified `/Users/zen/agi/ZenithDock/dist/ZenithDock.app`.
- Deployed `server/agent_server.py` to `sonic:/home/zen/Zenithbot/scripts/agent_server.py`
  and restarted `zenithbot-agent.service`.
  - First deploy attempt with the default `~/Zenithbot` path copied the file,
    but remote `py_compile` failed because the script quotes `~`.
  - Reran with `ZENITHDOCK_REMOTE_APP_DIR=/home/zen/Zenithbot`.
  - Health check got `401` without a token, which means the service is back up
    and enforcing auth.

## 2026-05-18 Follow-Up - Mac TestFlight Build 24 Uploaded

Summary:

- Mac-focused UI build with:
  - Codex-style trace/change-set presentation
  - folded long messages
  - unread agent-message indicators
- Bumped all project targets from build `23` to build `24` for a macOS
  TestFlight upload.
- Committed the build bump:
  `d3ac97f Bump build number for Mac TestFlight 24`.
- Archived and uploaded macOS build `24` successfully:
  `Uploaded ZenithDockMac`.
- The package is processing in App Store Connect/TestFlight.

Commands:

- `swift run ZenithGuardrails`
- `xcodebuild -scheme ZenithDockMac -configuration Release -destination platform=macOS build -quiet`
- `xcodebuild -scheme ZenithDockMac -configuration Release -destination generic/platform=macOS -archivePath build/archives/ZenithDockMac-24.xcarchive archive -quiet -allowProvisioningUpdates`
- `xcodebuild -exportArchive -archivePath build/archives/ZenithDockMac-24.xcarchive -exportOptionsPlist build/TestFlightExportOptions.plist -exportPath build/TestFlightMacExport-24 -quiet -allowProvisioningUpdates`
- Refreshed and verified `/Users/zen/agi/ZenithDock/dist/ZenithDock.app`.

## 2026-05-18 Follow-Up - Timeline Trace UI And Unread Agent Messages

Summary:

- Improved macOS timeline trace presentation in
  `Sources/ZenithDock/Views/EventViews.swift` and
  `Sources/ZenithDock/Views/TraceChangeSetView.swift`.
- Trace groups now stay folded by default, show a quiet preview line, and can
  surface a compact Codex-style edited-files card when tool output includes
  patch/git/diff signals.
- The edited-files card is intentionally cheap:
  - parses existing tool commands/output only
  - avoids live file-system diff work
  - shows top changed files inline and opens a review sheet with the raw
    diff/stat/patch snippets
- `TraceChangeSetView.swift` must be present in the manual Xcode macOS target
  source list; SwiftPM saw it automatically, but the first Xcode build caught
  the missing project entry.
- Long assistant/user messages now fold more generally, not only context
  digests. Copy and Full text still use the complete message.
- Added macOS unread agent-message state:
  - `AppStore.unreadAgentSessionIDs`
  - sidebar unread dot/title emphasis
  - bottom jump button shows `New` when unread selected-chat output arrives
  - jumping to bottom or being at bottom clears the unread mark

Verification:

- `swift build --product ZenithDock` passed.
- `swift run ZenithGuardrails` passed.
- `xcodebuild -scheme ZenithDockMac -configuration Release -destination platform=macOS build -quiet` passed.
- `xcodebuild -scheme ZenithDockIOS -configuration Debug -destination generic/platform=iOS build -quiet` passed.
- Refreshed and verified `/Users/zen/agi/ZenithDock/dist/ZenithDock.app`.

## 2026-05-18 Follow-Up - Stable 0.1.1 Marker

Summary:

- Bumped Xcode `MARKETING_VERSION` from `0.1.0` to `0.1.1` for iOS, macOS,
  and `ZenithCore` build configurations.
- Stable tag target is the current Codex-style composer build.
- Next UX direction from screenshots:
  - show code edits as a compact changed-files card with per-file diff review
  - keep reasoning/tool traces available but folded away from the main answer

Verification:

- `swift run ZenithGuardrails` passed.
- `swift build --product ZenithDock` passed.
- `xcodebuild -scheme ZenithDockMac -configuration Release -destination platform=macOS build -quiet` passed.
- `xcodebuild -scheme ZenithDockIOS -configuration Debug -destination generic/platform=iOS build -quiet` passed.
- Refreshed and verified `/Users/zen/agi/ZenithDock/dist/ZenithDock.app`.

## 2026-05-18 Follow-Up - Codex-Style Mac Composer

Summary:

- Reworked the macOS composer in
  `Sources/ZenithDock/Views/ComposerView.swift` into a Codex-style command bar.
- The editor remains the existing `StablePromptEditor` / `PromptTextView`
  bridge, so the `ZTextPresenceGate` typing guardrail stays intact.
- Attachments now live inside the composer surface when present.
- The bottom strip includes:
  - plus button for file attach/drop
  - compact backend menu
  - compact model/effort menu populated from `store.runtimeCatalog`
  - subtle running spinner with a small stop button
  - circular send/queue button
- The old large running pill was removed from the composer.

Verification:

- `swift run ZenithGuardrails` passed.
- `swift build --product ZenithDock` passed.
- `xcodebuild -scheme ZenithDockMac -configuration Release -destination platform=macOS build -quiet` passed.
- `xcodebuild -scheme ZenithDockIOS -configuration Debug -destination generic/platform=iOS build -quiet` passed.
- Refreshed and verified `/Users/zen/agi/ZenithDock/dist/ZenithDock.app`.

## 2026-05-18 Follow-Up - Composer Typing Guardrail

Why the regression happened:

- The earlier composer isolation kept normal typing inside `NSTextView` and
  debounced updates back to SwiftUI.
- The immediate-placeholder fix accidentally added a SwiftUI state callback from
  `textDidChange` on every keystroke.
- That made the placeholder update instantly, but it also invalidated the
  composer SwiftUI tree while typing, bringing back sluggish input.

Guardrail:

- Added `ZTextPresenceGate` in `Sources/ZenithCore/ZenithCore.swift`.
  - It publishes only when text crosses empty/non-empty.
  - It explicitly does not publish during continued typing.
- `Sources/ZenithDock/Views/ComposerView.swift` now uses the gate at the
  NSTextView-to-SwiftUI bridge, with a comment explaining the footgun.
- Added `ZenithGuardrails`, a lightweight Swift executable guardrail:
  - Verifies `ZTextPresenceGate` behavior.
  - Scans `ComposerView.swift` to ensure the composer still uses the gate before
    calling `onTextPresenceChange`.
- Expanded `ZenithGuardrails` into the first targeted regression suite:
  - Endpoint cache keys include normalized server URL, so cloned servers with
    the same session IDs cannot share local chat cache.
  - Runtime default labels show actual server defaults when the catalog knows
    them.
  - Pasted `/api/health` URLs normalize back to the server root.
  - Shell copy normalization collapses accidental double continuations while
    leaving LaTeX-looking text alone.

Verification:

- `swift run ZenithGuardrails` passed.
- `xcodebuild -scheme ZenithDockMac -configuration Release -destination platform=macOS build -quiet` passed.
- `xcodebuild -scheme ZenithDockIOS -configuration Debug -destination generic/platform=iOS build -quiet` passed after rerunning serially; the first parallel attempt hit Xcode's shared build DB lock.
- Refreshed `/Users/zen/agi/ZenithDock/dist/ZenithDock.app` from the Release
  build and verified codesign.

Note:

- Plain `swift test` is still not the right guardrail command for this package,
  because SwiftPM tries to compile the iOS executable target for macOS and fails
  on `UIKit`. Use `swift run ZenithGuardrails` for this regression check.

## 2026-05-18 Follow-Up - Mac TestFlight Build 23 Uploaded

Summary:

- Build `22` included the composer typing regression from the immediate
  placeholder state callback.
- Committed the fix:
  `e61ed08 Fix Mac composer typing regression`.
- Bumped all project targets from build `22` to build `23` for a macOS-only
  TestFlight replacement.
- Committed the build bump:
  `4584978 Bump build number for Mac TestFlight 23`.
- Archived and uploaded macOS build `23` successfully:
  `Uploaded ZenithDockMac`.
- The package is processing in App Store Connect/TestFlight.

Commands:

- `xcodebuild -scheme ZenithDockMac -configuration Release -destination generic/platform=macOS -archivePath build/archives/ZenithDockMac-23.xcarchive archive -quiet -allowProvisioningUpdates`
- `xcodebuild -exportArchive -archivePath build/archives/ZenithDockMac-23.xcarchive -exportOptionsPlist build/TestFlightExportOptions.plist -exportPath build/TestFlightMacExport-23 -quiet -allowProvisioningUpdates`

## 2026-05-18 Follow-Up - Composer Typing Regression

Problem:

- Mac TestFlight build `22` made the composer feel sluggish again.
- The regression came from the immediate placeholder fix: the `NSTextView`
  delegate called back into SwiftUI state on every keystroke to update text
  presence, undoing the earlier composer isolation.

Changes:

- `Sources/ZenithDock/Views/ComposerView.swift`
  - Only publish text presence when the editor crosses empty/non-empty.
  - Guard the SwiftUI state assignment as well, so normal typing remains inside
    `NSTextView` and does not invalidate the composer view tree.

Verification:

- `swift build --product ZenithDock` passed.
- `xcodebuild -scheme ZenithDockMac -configuration Release -destination platform=macOS build -quiet` passed.
- Refreshed `/Users/zen/agi/ZenithDock/dist/ZenithDock.app` from the Release
  build and verified codesign.

## 2026-05-18 Follow-Up - Mac TestFlight Build 22 Uploaded

Summary:

- Bumped all project targets from build `21` to build `22` for a macOS-only
  TestFlight upload.
- Committed the build bump before archiving:
  `8b8763e Bump build number for Mac TestFlight 22`.
- Archived and uploaded macOS build `22` successfully:
  `Uploaded ZenithDockMac`.
- The package is processing in App Store Connect/TestFlight.

Commands:

- `xcodebuild -scheme ZenithDockMac -configuration Release -destination generic/platform=macOS -archivePath build/archives/ZenithDockMac-22.xcarchive archive -quiet -allowProvisioningUpdates`
- `xcodebuild -exportArchive -archivePath build/archives/ZenithDockMac-22.xcarchive -exportOptionsPlist build/TestFlightExportOptions.plist -exportPath build/TestFlightMacExport-22 -quiet -allowProvisioningUpdates`

## 2026-05-18 Follow-Up - Endpoint-Scoped Chat Cache

Problem:

- After copying server state from one host to another, both servers shared the
  same ZenithDock session IDs.
- The app cache was keyed only by session ID, so switching server endpoints
  could briefly show cached chat history from the previous endpoint and make the
  two independent servers look live-synced.

Changes:

- `Sources/ZenithDock/State/AppStore.swift`
  - Reset session/event/job state when the configured server endpoint changes.
  - Namespaced memory and disk chat cache by normalized server URL.
- `Sources/ZenithDockIOS/State/MobileAppStore.swift`
  - Namespaced the in-memory chat cache by resolved server URL.

Behavior:

- Switching endpoints now clears the old selection and fetches the new server's
  session list/history window from the network.
- Long chats still load the latest window first; older pages are pulled as the
  user scrolls up.

Verification:

- `swift build --product ZenithDock` passed.
- `xcodebuild -scheme ZenithDockIOS -configuration Debug -destination generic/platform=iOS build -quiet` passed.

## 2026-05-18 Follow-Up - TestFlight Build 21 Uploaded

Summary:

- Bumped all project targets from build `20` to build `21`.
- Committed the build bump before archiving:
  `cdb3e6f Bump build number for TestFlight 21`.
- Archived and uploaded iOS/iPadOS build `21` successfully:
  `Uploaded ZenithDockIOS`.
- Archived and uploaded macOS build `21` successfully:
  `Uploaded ZenithDockMac`.
- Both packages are processing in App Store Connect/TestFlight.

Commands:

- `xcodebuild -scheme ZenithDockIOS -configuration Release -destination generic/platform=iOS -archivePath build/archives/ZenithDockIOS-21.xcarchive archive -quiet -allowProvisioningUpdates`
- `xcodebuild -exportArchive -archivePath build/archives/ZenithDockIOS-21.xcarchive -exportOptionsPlist build/TestFlightExportOptions.plist -exportPath build/TestFlightIOSExport-21 -quiet -allowProvisioningUpdates`
- `xcodebuild -scheme ZenithDockMac -configuration Release -destination generic/platform=macOS -archivePath build/archives/ZenithDockMac-21.xcarchive archive -quiet -allowProvisioningUpdates`
- `xcodebuild -exportArchive -archivePath build/archives/ZenithDockMac-21.xcarchive -exportOptionsPlist build/TestFlightExportOptions.plist -exportPath build/TestFlightMacExport-21 -quiet -allowProvisioningUpdates`

## 2026-05-17 Follow-Up - Smooth Older Timeline Paging

Problem:

- Pulling/reaching the top of long chats could feel janky, with a large amount
  of old transcript visibly flying through the timeline.
- The old behavior revealed about 100 rows at a time and, when a server page was
  fetched, made every newly fetched row visible immediately before restoring the
  previous anchor.

Decision:

- Keep infinite scroll, but reveal older history in smaller slices.
- Mac now reveals 40 rows per top reach; iOS/iPadOS reveals 36.
- When a server page returns, keep most fetched rows hidden and reveal only one
  slice above the current anchor.
- Apply row-window changes in a no-animation transaction and restore the anchor
  both immediately and on the next run loop.
- Add a short history-load cooldown so one top reach cannot cascade through
  multiple hidden/server pages.

Verification:

- `git diff --check` passed.
- `xcodebuild -scheme ZenithDockMac -configuration Release -destination platform=macOS build -quiet` passed.
- `xcodebuild -scheme ZenithDockIOS -configuration Debug -destination generic/platform=iOS build -quiet` passed after rerunning once; the first concurrent attempt hit Xcode's shared build DB lock.
- Refreshed `/Users/zen/agi/ZenithDock/dist/ZenithDock.app` from the Release
  build and verified codesign.

## 2026-05-17 Follow-Up - TestFlight Build 20 Uploaded

Result:

- Bumped all project targets from build `19` to build `20`.
- Committed and pushed the build bump before archiving:
  `bde2a22 Bump build number for TestFlight 20`.
- Archived and uploaded iOS/iPadOS build `20` successfully:
  `Uploaded ZenithDockIOS`.
- Archived and uploaded macOS build `20` successfully:
  `Uploaded ZenithDockMac`.
- Both packages are processing in App Store Connect/TestFlight.

Commands:

- `xcodebuild -scheme ZenithDockIOS -configuration Release -destination generic/platform=iOS -archivePath build/archives/ZenithDockIOS-20.xcarchive archive -quiet -allowProvisioningUpdates`
- `xcodebuild -exportArchive -archivePath build/archives/ZenithDockIOS-20.xcarchive -exportOptionsPlist build/TestFlightExportOptions.plist -exportPath build/TestFlightIOSExport-20 -quiet -allowProvisioningUpdates`
- `xcodebuild -scheme ZenithDockMac -configuration Release -destination generic/platform=macOS -archivePath build/archives/ZenithDockMac-20.xcarchive archive -quiet -allowProvisioningUpdates`
- `xcodebuild -exportArchive -archivePath build/archives/ZenithDockMac-20.xcarchive -exportOptionsPlist build/TestFlightExportOptions.plist -exportPath build/TestFlightMacExport-20 -quiet -allowProvisioningUpdates`

## 2026-05-17 Follow-Up - Instant Mac Composer Placeholder

Problem:

- The Mac composer placeholder text (`Message`) disappeared on the debounced
  SwiftUI draft update, so it could linger briefly after typing began.

Decision:

- Keep the debounced full draft sync for typing performance.
- Add a lightweight immediate text-presence callback from the native
  `NSTextView` delegate.
- Drive placeholder visibility from that immediate boolean instead of the
  debounced draft string.

Verification:

- `git diff --check` passed.
- `swift build --product ZenithDock` passed.

## 2026-05-17 Follow-Up - Make Live Process Inspection Opt-In

Problem:

- Live process/stdout details were displayed and refreshed automatically when a
  chat was running.
- Health refresh, session selection, and `turn_started` events could all fetch
  process snapshots without the user asking.
- The Mac and iOS process inspectors also polled the server every 1.5 seconds
  while visible.

Decision:

- Remove automatic process snapshot fetches from health refresh, session
  selection, and turn-start handling.
- Keep process snapshot cleanup when a selected chat is no longer active or
  when the selected chat changes.
- Change Mac and iOS process sections to opt-in controls: collapsed by default,
  with an explicit `Inspect Live Process` button.
- Show process rows, stdout tail, and attached log output only while the
  inspector is open.
- Add `Hide`/collapse behavior that clears process/stdout/log state.
- Keep manual `Refresh` available after the inspector is opened.

Verification:

- Searched for eager `refreshSelectedProcesses(showErrors: false)` calls and
  polling `.task` loops; none remain.
- `git diff --check` passed.
- `swift build --product ZenithDock` passed.
- `xcodebuild -scheme ZenithDockMac -configuration Release -destination platform=macOS build -quiet`
  passed.
- First iOS Xcode build failed because parallel Xcode builds locked the shared
  DerivedData build database; reran serially.
- `xcodebuild -scheme ZenithDockIOS -configuration Debug -destination generic/platform=iOS build -quiet`
  passed.

## 2026-05-17 Follow-Up - Stop Timeline Jump And Remove Terminal Churn

Problem:

- The chat timeline could jump upward while typing or clicking in the composer.
- The history loader had an `onAppear` path that synthesized a top-of-scroll
  geometry value. When the view re-rendered, it could reveal older rows and
  restore an old anchor even though the user had not scrolled to the top.
- Timeline body evaluation also walked long event arrays more than once per
  render to derive rows and job metadata.
- The terminal UI had been punted, but stale terminal state/methods were still
  present in the Mac store and iOS still had a terminal section/sheet.

Decision:

- Remove the synthetic `handleHistoryTopChange(0)` calls from Mac and iOS.
- Gate automatic history loading on real scroll geometry and `!isAtBottom`.
- Keep manual `Load Older` behavior unchanged.
- Add cached timeline projections on Mac and iOS so a render derives rows and
  job metadata together instead of recomputing them separately.
- Reuse one markdown link context per selected chat render instead of creating
  it per row.
- Remove client-side terminal state, terminal polling, and the iOS terminal UI.
  Server terminal endpoints remain dormant for a future separate design.

Verification:

- Confirmed no `handleHistoryTopChange(0)` synthetic trigger remains.
- Confirmed no client-side `terminalSnapshot`, `terminalInput`, terminal
  refresh/open/input/kill hooks, or mobile terminal view references remain.
- `git diff --check` passed.
- `swift build --product ZenithDock` passed.
- `xcodebuild -scheme ZenithDockIOS -configuration Debug -destination generic/platform=iOS build -quiet`
  passed.
- `xcodebuild -scheme ZenithDockMac -configuration Release -destination platform=macOS build -quiet`
  passed.

## 2026-05-17 Follow-Up - Timeline Paging And Scroll Anchors

Problem:

- The default loaded chat window felt too short on long chats.
- Auto-load older history on scroll-top could fire once and then appear stuck.
- When a server history page was fetched, the store prepended events but the
  timeline kept rendering the same suffix window, so newly loaded older rows
  could remain hidden.
- Loading recent content from cache replacement could throw away the old
  position instead of merging into the cached timeline.

Decision:

- Increase Mac initial/older event pages to 160 and the in-memory loaded cap to
  2,000 events.
- Increase iOS/iPadOS initial/older event pages to 160.
- Increase rendered row windows: Mac starts at 100 rows and reveals 100 rows
  per page; iOS/iPadOS starts at 110 rows and reveals 100 rows per page.
- Make `loadOlderHistory()` return the count of newly inserted events.
- After fetching older history, expand the rendered row limit by the number of
  newly inserted timeline rows and restore the previous top row anchor.
- When new content arrives while the user is not at bottom, grow the rendered
  window enough to preserve the current visible rows rather than sliding the
  suffix window forward.
- Cached chat catch-up now merges the fetched page instead of replacing the
  cached event window with only the latest tail.

Verification:

- `git diff --check` passed.
- `swift build --product ZenithDock` passed.
- Plain `swift build --product ZenithDockIOS` is not a valid iOS verifier
  because it builds for macOS and cannot import `UIKit`.
- `xcodebuild -scheme ZenithDockIOS -configuration Debug -destination generic/platform=iOS build -quiet`
  passed.
- `xcodebuild -scheme ZenithDockMac -configuration Release -destination platform=macOS build -quiet`
  passed.
- Refreshed `/Users/zen/agi/ZenithDock/dist/ZenithDock.app` and verified
  codesign.

## 2026-05-17 Follow-Up - Public-Clean Server Deploy Script

Problem:

- The server folder is being prepared for a public repository.
- The deploy helper was named `deploy_nv.sh` and baked in private machine
  defaults like `nv` and `/home/zen/Zenithbot`.
- The server script still mentioned the private agent host name in comments and
  prompt prelude text.

Decision:

- Rename `server/deploy_nv.sh` to `server/deploy.sh`.
- Make the deploy host explicit via `ZENITHDOCK_REMOTE_HOST` or the first
  command argument.
- Default the remote app directory to `~/Zenithbot` instead of an absolute
  personal home path.
- Neutralize server README examples to use `<ssh-host>`.
- Make the server README read correctly when `server/` is split into the root
  of the standalone public server repository.
- Remove the personal copyright line and private host wording from
  `server/agent_server.py`.

Verification:

- Scanned `server/` for private hostnames, personal names, home paths, obvious
  token/API key patterns, and hardcoded Tailscale/LAN IPs.
- Remaining `zenith*` matches in `server/` are product/service names, not
  personal information.

## 2026-05-17 Follow-Up - Punt Mac Terminal And Isolate Composer

Problem:

- The embedded terminal kept consuming time without reaching a polished result.
- Keeping terminal machinery in the Mac app made the chat UI harder to reason
  about while debugging typing latency.
- The composer still felt sluggish because live `AppStore` updates could
  invalidate the composer tree while the user was typing.

Decision:

- Remove the Mac Terminal tab entirely.
- Delete `TerminalWorkspaceView.swift`.
- Remove SwiftTerm from `Package.swift`, the Xcode project, and package lock
  files.
- Remove the Terminal inspector card and old terminal sheet.
- Simplify the root/content area back to a single chat timeline.
- Wrap the native message editor in an equatable `StablePromptEditor` so
  global `AppStore` churn does not poke the AppKit text view unless editability
  or an explicit reset changes.
- Increase draft binding debounce from 40 ms to 180 ms. AppKit owns keystrokes;
  SwiftUI receives slower metadata updates for send enablement/height.

Verification:

- Source/project search has no active `SwiftTerm`, `TerminalWorkspaceView`,
  `WorkspacePane`, or `ChatTerminal` references.
- `swift build --product ZenithDock` passed.
- `xcodebuild -scheme ZenithDockMac -configuration Release -destination platform=macOS build -quiet`
  passed.
- Replaced `/Users/zen/agi/ZenithDock/dist/ZenithDock.app` cleanly instead of
  overlaying with `ditto`, because stale removed resources broke codesign.
- `codesign --verify --deep --strict /Users/zen/agi/ZenithDock/dist/ZenithDock.app`
  passed.
- Confirmed the dist bundle contains no SwiftTerm resources.

## 2026-05-17 Follow-Up - Composer Typing Performance And Terminal Cursor

Problem:

- The Mac composer felt sluggish while typing.
- The embedded terminal cursor rendered as an oversized bright green block.

Decision:

- Let the native `NSTextView` own the immediate keystroke stream and throttle
  SwiftUI binding sync by 40 ms.
- Flush the current AppKit text immediately on Return/send so queued sends still
  use the exact typed content.
- Disable spell checking, grammar checking, autocorrection, and smart insert/
  delete for the message box.
- Switch SwiftTerm to a steady bar cursor and ask tmux to use `cursor-style bar`
  for the attached chat session.

Verification:

- `swift build --product ZenithDock` passed.
- `xcodebuild -scheme ZenithDockMac -configuration Release -destination platform=macOS build -quiet`
  passed.
- `/Users/zen/agi/ZenithDock/dist/ZenithDock.app` was refreshed.
- `codesign --verify --deep --strict /Users/zen/agi/ZenithDock/dist/ZenithDock.app`
  passed.

## 2026-05-17 Follow-Up - Strip Header Runtime Knobs And Repair Terminal Attach

Problem:

- The chat header still had backend/model/effort runtime controls even though
  the inspector already owns those settings.
- The embedded terminal could still show a dead `[exited]` tmux pane because it
  attached to server-created tmux state without repairing dead sessions first.
- Keeping the terminal mounted while Chat was active made composer typing feel
  sluggish.

Decision:

- Remove the runtime switcher from the chat header entirely. Runtime settings
  stay in the side inspector.
- Stop pre-creating the terminal session through the server when opening the
  Terminal tab.
- Compute the per-chat tmux name in the Mac app using the same `zd_<session>`
  convention as the server.
- Launch SSH with a remote script that:
  - enters the chat working directory,
  - detects an existing tmux session,
  - kills it if every pane is dead,
  - creates it when missing,
  - then `exec`s `tmux attach-session`.
- Do not instantiate SwiftTerm while the Terminal tab is hidden, so the chat
  composer is not competing with a hidden terminal renderer.

Verification:

- `swift build --product ZenithDock` passed.
- `xcodebuild -scheme ZenithDockMac -configuration Release -destination platform=macOS build -quiet`
  passed.
- `/Users/zen/agi/ZenithDock/dist/ZenithDock.app` was refreshed.
- `codesign --verify --deep --strict /Users/zen/agi/ZenithDock/dist/ZenithDock.app`
  passed.

## 2026-05-17 Follow-Up - Responsive Mac Headers And Terminal Focus

Problem:

- The Mac chat and terminal headers still clipped buttons at narrow content
  widths, even after pinning the server status pill.
- Keeping the terminal mounted made Chat/Terminal switching faster, but the
  hidden terminal still called `makeFirstResponder` and stole focus from the
  chat composer while typing.
- The first embedded SSH command exited immediately after printing
  `[exited] Connection ... closed` on at least one launch.

Decision:

- Convert the chat and terminal headers to two-row layouts: title/status on top,
  visible Chat/Terminal tabs plus actions on the second row.
- Use `ViewThatFits` so secondary controls collapse into an actions menu instead
  of disappearing off the right edge.
- Pass `isActive` into the SwiftTerm wrapper and only focus the terminal when
  the Terminal tab is active.
- Keep the user's SSH config available again, but keep known-hosts sandbox-safe
  via app-owned known-hosts and an explicit `bash -lc 'cd ... && exec tmux ...'`
  remote command.

Verification:

- `swift build --product ZenithDock` passed.
- `xcodebuild -scheme ZenithDockMac -configuration Release -destination platform=macOS build -quiet`
  passed.
- `/Users/zen/agi/ZenithDock/dist/ZenithDock.app` was refreshed.
- `codesign --verify --deep --strict /Users/zen/agi/ZenithDock/dist/ZenithDock.app`
  passed.

## 2026-05-17 Follow-Up - Terminal Tab Visibility And Sandboxed SSH

Problem:

- The new tab strip pushed the server status button into the scrollable header
  controls, so the green/red server state was no longer reliably visible.
- Switching between Chat and Terminal felt sluggish because the root view was
  tearing one workspace down and constructing the other.
- The embedded SSH terminal failed in the signed app with:
  `hostkeys_find_by_key_hostfile ... Operation not permitted` because sandboxed
  `/usr/bin/ssh` could not read `/Users/zen/.ssh/known_hosts`.

Decision:

- Pin the server status pill outside the scrollable toolbar controls in the
  Chat header and add the same pill to the Terminal header.
- Keep Chat and Terminal mounted in a `ZStack` and switch by visibility/hit
  testing, so the terminal process is not destroyed on every tab switch.
- Gate terminal tmux creation on the terminal tab actually being active.
- Launch SSH with an app-owned known-hosts file under Application Support,
  `StrictHostKeyChecking=accept-new`, `GlobalKnownHostsFile=/dev/null`, and
  `SSH_ASKPASS_REQUIRE=never`.

Verification:

- `swift build --product ZenithDock` passed.
- `xcodebuild -scheme ZenithDockMac -configuration Release -destination platform=macOS build -quiet`
  passed.
- `/Users/zen/agi/ZenithDock/dist/ZenithDock.app` was refreshed.
- `codesign --verify --deep --strict /Users/zen/agi/ZenithDock/dist/ZenithDock.app`
  passed.

## 2026-05-17 Follow-Up - Real Mac Terminal Tab

Problem:

- The first per-chat terminal UI was a tmux `capture-pane` viewer with HTTP
  input forwarding.
- It did not feel like a terminal: no proper cursor behavior, no native
  interactive PTY, and tmux pane/window workflows were awkward.
- The Chat/Terminal switch also looked like a settings segmented control
  labeled `Pane`, not a tab.

Decision:

- Add SwiftTerm to the macOS target and replace the fake terminal surface with
  an embedded `LocalProcessTerminalView`.
- Opening the Terminal tab now ensures the server-side per-chat tmux session
  exists, then runs a local PTY command:
  `ssh -tt <user>@<server-host> tmux new-session -A -s <session> -c <cwd>`.
- Removed the explicit attach mental model from the terminal surface. Existing
  tmux sessions attach automatically; missing ones are created by the server.
- Added terminal toolbar actions that send tmux shortcuts into the PTY:
  new window, split right, split down, interrupt, and kill session.
- Replaced the macOS Chat/Terminal picker with a shared tab-strip component in
  both chat and terminal headers.

Files changed:

- `Package.swift`
- `Package.resolved`
- `ZenithDock.xcodeproj/project.pbxproj`
- `ZenithDock.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved`
- `Sources/ZenithDock/Views/RootView.swift`
- `Sources/ZenithDock/Views/TimelineView.swift`
- `Sources/ZenithDock/Views/TerminalWorkspaceView.swift`

Verification:

- `swift build --product ZenithDock` passed.
- Installed the missing Xcode Metal Toolchain component with
  `xcodebuild -downloadComponent MetalToolchain` because SwiftTerm includes a
  Metal shader resource.
- `xcodebuild -scheme ZenithDockMac -configuration Release -destination platform=macOS build -quiet`
  passed.
- `/Users/zen/agi/ZenithDock/dist/ZenithDock.app` was refreshed from the Xcode
  Release build.
- `codesign --verify --deep --strict /Users/zen/agi/ZenithDock/dist/ZenithDock.app`
  passed.

## 2026-05-16 Follow-Up - Click Into Collapsed Job Runs

Problem:

- Grouping repeated scheduled-job status runs made the timeline much calmer,
  but older grouped runs were only compact previews.
- The user still needs a way to inspect a specific hidden run when debugging.

Decision:

- Older runs inside a grouped job-status disclosure are now clickable rows.
- Clicking an older run opens the existing full-message/details sheet with copy
  support.
- The row keeps a compact preview plus an `Open` affordance so the default
  timeline stays quiet.
- Implemented for macOS and iOS/iPadOS.

Files changed:

- `Sources/ZenithDock/Views/EventViews.swift`
- `Sources/ZenithDockIOS/Views/MobileEventViews.swift`

Verification:

- `git diff --check` passed for the touched files.
- `xcodebuild -scheme ZenithDockMac -configuration Release -destination platform=macOS build -quiet`
  passed.
- `xcodebuild -scheme ZenithDockIOS -configuration Debug -destination 'generic/platform=iOS Simulator' build -quiet`
  passed.
- `/Users/zen/agi/ZenithDock/dist/ZenithDock.app` was refreshed and codesign
  verification passed.

## 2026-05-16 Follow-Up - macOS Build 19 Server URL And Tailscale Fix

Problem:

- On a Mac mini, SSH to `100.88.206.6` worked but the macOS TestFlight app
  could not reach the agent server.
- The Mac app also still felt unable to edit/change the server URL.
- Root cause was twofold:
  - The macOS target only generated an Info.plist and did not include ATS
    exceptions like the iOS target.
  - The repo had a new Mac Info.plist, but the Xcode project was not actually
    using it yet.
  - The URL editor was still hidden in a small popover.

Decision:

- Add `Apps/ZenithDockMac/Info.plist` with `NSAllowsLocalNetworking` and narrow
  HTTP exceptions for `10.112.215.37` and `100.88.206.6`.
- Wire the macOS target to use that plist with `GENERATE_INFOPLIST_FILE = NO`
  and `INFOPLIST_FILE = Apps/ZenithDockMac/Info.plist`.
- Replace the toolbar popover with a real server settings sheet.
- Add a plain draft server URL field plus `Apply & Reconnect` to the right
  inspector Security section.
- Add `AppStore.applyServerSettings(serverURL:accessToken:)` so both UI entry
  points commit the draft only when the user applies it.
- Bumped project build number to `19`.

Verification:

- `xcodebuild -scheme ZenithDockMac -configuration Release -destination platform=macOS build -quiet`
  passed.
- Verified `/Users/zen/agi/ZenithDock/dist/ZenithDock.app/Contents/Info.plist`
  has `CFBundleVersion = 19`, `NSAllowsLocalNetworking = true`, and exceptions
  for `10.112.215.37` and `100.88.206.6`.
- `/Users/zen/agi/ZenithDock/dist/ZenithDock.app` was refreshed and codesign
  verification passed.
- Archived and uploaded macOS build `19`:
  `Uploaded ZenithDockMac`.

## 2026-05-16 Follow-Up - TestFlight Build 18 Uploaded

Result:

- Bumped all project targets from build `17` to build `18`.
- Archived and uploaded iOS/iPadOS build `18` successfully:
  `Uploaded ZenithDockIOS`.
- Archived and uploaded macOS build `18` successfully:
  `Uploaded ZenithDockMac`.
- Both packages are processing in App Store Connect/TestFlight.

Commands:

- `xcodebuild -scheme ZenithDockIOS -configuration Release -destination 'generic/platform=iOS' -archivePath build/archives/ZenithDockIOS-18.xcarchive archive -quiet`
- `xcodebuild -exportArchive -archivePath build/archives/ZenithDockIOS-18.xcarchive -exportOptionsPlist build/TestFlightExportOptions.plist -exportPath build/TestFlightIOSExport-18 -quiet`
- `xcodebuild -scheme ZenithDockMac -configuration Release -destination 'generic/platform=macOS' -archivePath build/archives/ZenithDockMac-18.xcarchive archive -quiet`
- `xcodebuild -exportArchive -archivePath build/archives/ZenithDockMac-18.xcarchive -exportOptionsPlist build/TestFlightExportOptions.plist -exportPath build/TestFlightMacExport-18 -quiet`

## 2026-05-16 Follow-Up - Mac Server URL Editing

Problem:

- Editing the Mac server URL from the toolbar popover was brittle because the
  text field was bound directly to `store.serverURLString`.
- That made the live networking client observe half-typed values and made the
  field feel like it was fighting edits.

Decision:

- The server settings popover now edits local draft fields.
- Nothing is committed while typing.
- `Apply & Reconnect` trims and saves the URL/token, then refreshes the server.
- The app still accepts either `host:port` or a full `http://host:port` URL; the
  displayed field is not rewritten while typing.

Files changed:

- `Sources/ZenithDock/Views/RootView.swift`

Verification:

- `xcodebuild -scheme ZenithDockMac -configuration Release -destination platform=macOS build -quiet`
  passed.
- `/Users/zen/agi/ZenithDock/dist/ZenithDock.app` was refreshed and codesign
  verification passed.

## 2026-05-16 Follow-Up - TestFlight Build 17 Upload Blocked By Xcode Credentials

Update:

- Retried after Xcode credentials were fixed.
- iOS upload succeeded: `Uploaded ZenithDockIOS`.
- macOS upload succeeded: `Uploaded ZenithDockMac`.
- Both build `17` packages are now processing in App Store Connect/TestFlight.

Result:

- Bumped all project targets from build `16` to build `17`.
- Archived iOS successfully at
  `build/archives/ZenithDockIOS-17.xcarchive`.
- Archived macOS successfully at
  `build/archives/ZenithDockMac-17.xcarchive`.
- Initial upload/export to App Store Connect failed for both platforms before
  package upload because Xcode could not load Apple ID credentials from
  Keychain.

Errors:

- iOS export failed with `Failed to Use Accounts` and:
  `missing Xcode-Username` / `missing Xcode-Token`.
- macOS export failed with `Failed to Use Accounts` and:
  `missing Xcode-Token` for `zhengyiluo5@gmail.com`.

Commands already run:

- `xcodebuild -scheme ZenithDockIOS -configuration Release -destination 'generic/platform=iOS' -archivePath build/archives/ZenithDockIOS-17.xcarchive archive -quiet`
- `xcodebuild -exportArchive -archivePath build/archives/ZenithDockIOS-17.xcarchive -exportOptionsPlist build/TestFlightExportOptions.plist -exportPath build/TestFlightIOSExport-17 -quiet`
- `xcodebuild -scheme ZenithDockMac -configuration Release -destination 'generic/platform=macOS' -archivePath build/archives/ZenithDockMac-17.xcarchive archive -quiet`
- `xcodebuild -exportArchive -archivePath build/archives/ZenithDockMac-17.xcarchive -exportOptionsPlist build/TestFlightExportOptions.plist -exportPath build/TestFlightMacExport-17 -quiet`

Next step:

- Wait for App Store Connect processing, then enable the build in TestFlight if
  needed.

## 2026-05-16 Follow-Up - Composer Attachment UX

Problem:

- Dragging files onto the Mac chat box did not reliably attach them.
- Pending attachments in the composer had no remove affordance.
- Image attachments looked like generic file pills instead of showing a preview.
- Historical `file_uploaded` events could repopulate the pending attachment
  shelf when loading/scrolling history.

Decision:

- The Mac composer card is now a drop target, and the underlying native
  `NSTextView` also accepts file drops directly.
- iOS/iPadOS composer also accepts drops on the composer card where the platform
  supports it.
- Pending attachments now have an `xmark.circle.fill` remove button.
- Pending image attachments render thumbnails using the authenticated file URL.
- `uploads` is kept as pending composer state only. Historical files remain in
  timeline/files panels and no longer refill the composer attachment shelf.

Files changed:

- `Sources/ZenithDock/State/AppStore.swift`
- `Sources/ZenithDock/Views/ComposerView.swift`
- `Sources/ZenithDock/Views/TimelineView.swift`
- `Sources/ZenithDockIOS/State/MobileAppStore.swift`
- `Sources/ZenithDockIOS/Views/MobileComposerView.swift`
- `Sources/ZenithDockIOS/Views/MobileTimelineView.swift`

Verification:

- `git diff --check` passed for the touched files.
- `xcodebuild -scheme ZenithDockMac -configuration Release -destination platform=macOS build -quiet`
  passed.
- `xcodebuild -scheme ZenithDockIOS -configuration Debug -destination 'generic/platform=iOS Simulator' build -quiet`
  passed.
- `/Users/zen/agi/ZenithDock/dist/ZenithDock.app` was refreshed and codesign
  verification passed.

## 2026-05-16 Follow-Up - macOS TestFlight Upload

Result:

- Archived and uploaded the native macOS target to App Store Connect/TestFlight.
- Upload completed successfully and App Store Connect reported the package is
  processing.

Commands:

- `xcodebuild -scheme ZenithDockMac -configuration Release -destination 'generic/platform=macOS' -archivePath build/archives/ZenithDockMac.xcarchive archive -quiet`
- `xcodebuild -exportArchive -archivePath build/archives/ZenithDockMac.xcarchive -exportOptionsPlist build/TestFlightExportOptions.plist -exportPath build/TestFlightMacExport -quiet`

Notes:

- The upload used `build/TestFlightExportOptions.plist` with
  `destination=upload`, `method=app-store-connect`, automatic signing, team
  `KRR35MWWHD`, and internal TestFlight only.
- This is separate from `/Users/zen/agi/ZenithDock/dist/ZenithDock.app`, which
  is the local dev bundle.
- App Store Connect may take a few minutes to finish processing before the Mac
  build appears in TestFlight.

## 2026-05-16 Follow-Up - Collapse Repeated Scheduled Job Runs

Problem:

- Frequent loop jobs could create a wall of repeated job output cards.
- This made health-check chats hard to scan because every scheduled run was
  rendered as a full timeline message.

Decision:

- Consecutive `job_ran` outputs from the same scheduled job are grouped into
  one timeline row.
- The grouped row shows the latest job status/result directly.
- Earlier runs in that consecutive batch are hidden behind a small disclosure
  with compact previews.
- Job styling is toned down from a heavy orange/brown block to a quieter card
  with an orange status rail.
- The same grouping behavior is implemented for macOS, iOS, and iPadOS.

Files changed:

- `Sources/ZenithDock/Design/Theme.swift`
- `Sources/ZenithDock/Views/EventViews.swift`
- `Sources/ZenithDock/Views/TimelineView.swift`
- `Sources/ZenithDockIOS/Design/MobileTheme.swift`
- `Sources/ZenithDockIOS/Views/MobileEventViews.swift`
- `Sources/ZenithDockIOS/Views/MobileTimelineView.swift`

Verification:

- `git diff --check` passed for the touched files.
- `xcodebuild -scheme ZenithDockMac -configuration Release -destination platform=macOS build -quiet`
  passed.
- `xcodebuild -scheme ZenithDockIOS -configuration Debug -destination 'generic/platform=iOS Simulator' build -quiet`
  passed.
- `/Users/zen/agi/ZenithDock/dist/ZenithDock.app` was refreshed and codesign
  verification passed.

## 2026-05-16 Follow-Up - Job Detail Popups Own Prompt And Interval

Problem:

- The job UI was getting crowded with interval controls in the sidebar/details
  form.
- Existing jobs needed a direct way to edit the prompt, not only pause/run/delete.
- The same behavior needs to exist across macOS, iOS, and iPadOS.

Decision:

- New-job creation keeps a compact title row and moves prompt, interval, and
  loop controls into a `Job Details` sheet.
- Existing job rows expose `Edit Job`, opening a detailed sheet with title,
  prompt, backend, enabled, loop, and interval.
- Store `PATCH /api/jobs/{id}` calls now send title, prompt, interval, loop,
  enabled, and backend fields.
- The visible inline interval editor is removed from job rows and mobile job
  creation.

Files changed:

- `Sources/ZenithDock/State/AppStore.swift`
- `Sources/ZenithDock/Views/InspectorView.swift`
- `Sources/ZenithDockIOS/State/MobileAppStore.swift`
- `Sources/ZenithDockIOS/Views/MobileChatOptionsView.swift`

Verification:

- `xcodebuild -scheme ZenithDockMac -configuration Release -destination platform=macOS build -quiet`
  passed.
- `xcodebuild -scheme ZenithDockIOS -configuration Debug -destination 'generic/platform=iOS Simulator' build -quiet`
  passed after replacing shorthand SwiftUI `Section("Prompt")` footer usage
  with explicit header/footer form.
- `/Users/zen/agi/ZenithDock/dist/ZenithDock.app` was refreshed and codesign
  verification passed.

## 2026-05-16 20:08 PDT - Start Repo Dev Log And Capture Mac CPU Loop

### 2026-05-16 Follow-Up - Job Runs Must Render Actual Output

Problem:

- The first job timeline collapse rendered `job_ran` status cards but could hide
  the real response.
- Normal display mode hides `turn_finished` when `assistant_text` exists for the
  same run, so using only `turn_finished.result_text` as the job output source
  was insufficient.

Decision:

- Build a synthetic job run row keyed by `run_id`.
- Render one orange `Job Response` bubble per job run.
- Use `turn_finished.result_text` first when present.
- Fall back to joined `assistant_text` chunks when `turn_finished` is filtered
  or not loaded.
- Hide `job_ran`, `turn_started`, `assistant_text`, trace/tool internals,
  `turn_finished`, and run-scoped `error` events from the main timeline once a
  job run row exists.
- Keep raw events in server history for debugging.

Files changed:

- `Sources/ZenithDock/Views/TimelineView.swift`
- `Sources/ZenithDock/Views/EventViews.swift`
- `Sources/ZenithDockIOS/Views/MobileTimelineView.swift`
- `Sources/ZenithDockIOS/Views/MobileEventViews.swift`

Verification:

- Confirmed Zen-nv event history had job output in `assistant_text` and
  `turn_finished.result_text`.
- `xcodebuild -scheme ZenithDockMac -configuration Release -destination platform=macOS build -quiet`
  passed.
- `xcodebuild -scheme ZenithDockIOS -configuration Debug -destination 'generic/platform=iOS Simulator' build -quiet`
  passed.
- `/Users/zen/agi/ZenithDock/dist/ZenithDock.app` was refreshed and codesign
  verification passed.

### 2026-05-16 Follow-Up - Command Copy Must Preserve Shell Continuations

Problem:

- Copying a response/code block could preserve model-emitted shell line
  continuations as `\\`.
- In a real shell, `\\` at end-of-line does not continue the command. It escapes
  a literal backslash, then the following `--flag` lines run as separate
  commands and fail with `command not found`.

Decision:

- Add shared `ZClipboardText.normalizedForCopy`.
- It only collapses doubled trailing backslashes to a single `\` when the text
  is shell-like or the code block language is shell/terminal/console.
- Avoid doing this for LaTeX/table-like lines.
- Use it for Mac and iOS/iPadOS code block display/copy, full-message copy, and
  full-text sheet display/copy.

Files changed:

- `Sources/ZenithCore/ZenithCore.swift`
- `Sources/ZenithDock/Views/Components/MarkdownView.swift`
- `Sources/ZenithDock/Views/EventViews.swift`
- `Sources/ZenithDockIOS/Views/MobileEventViews.swift`

Verification:

- `git diff --check` passed for the touched files.
- `xcodebuild -scheme ZenithDockMac -configuration Release -destination platform=macOS build -quiet`
  passed.
- `xcodebuild -scheme ZenithDockIOS -configuration Debug -destination 'generic/platform=iOS Simulator' build -quiet`
  passed.
- `/Users/zen/agi/ZenithDock/dist/ZenithDock.app` was refreshed and codesign
  verification passed.

### 2026-05-16 Follow-Up - Editable Job Intervals And Orange Job Responses

Problem:

- Jobs could be created with an interval, but existing jobs did not expose a
  clear way to change their firing interval.
- Scheduled job runs were visually too similar to normal chat turns.
- Job-triggered runs produced the same multi-part timeline as manual turns:
  prompt/process/tool/assistant/final events.

Decision:

- Mac and iOS/iPadOS job rows expose an inline `Every N sec` editor.
- Updating an enabled job's `interval_seconds` on the server immediately
  reschedules `next_run_at` to `now + new interval`.
- Job-created/job-ran cards use orange styling.
- Job-triggered run internals remain in the event stream for debugging, but the
  main timeline folds them into one orange `Job Response` bubble using the final
  `turn_finished` result.

Files changed:

- `server/agent_server.py`
- `Sources/ZenithDock/State/AppStore.swift`
- `Sources/ZenithDock/Views/InspectorView.swift`
- `Sources/ZenithDock/Views/TimelineView.swift`
- `Sources/ZenithDock/Views/EventViews.swift`
- `Sources/ZenithDockIOS/State/MobileAppStore.swift`
- `Sources/ZenithDockIOS/Views/MobileChatOptionsView.swift`
- `Sources/ZenithDockIOS/Views/MobileTimelineView.swift`
- `Sources/ZenithDockIOS/Views/MobileEventViews.swift`

Verification:

- `python3 -c 'import py_compile; py_compile.compile("server/agent_server.py", cfile="/private/tmp/agent_server.pyc", doraise=True)'`
  passed.
- `xcodebuild -scheme ZenithDockMac -configuration Release -destination platform=macOS build -quiet`
  passed.
- `xcodebuild -scheme ZenithDockIOS -configuration Debug -destination 'generic/platform=iOS Simulator' build -quiet`
  passed after rerunning sequentially to avoid Xcode's build DB lock.
- `/Users/zen/agi/ZenithDock/dist/ZenithDock.app` was refreshed and codesign
  verification passed.
- Server was copied to Zen-nv, compiled there, restarted directly on port 7850,
  and `/api/health` returned OK.

### 2026-05-16 Follow-Up - Do Not Clip Normal Chat Messages

Problem:

- Assistant messages that were intended to provide full shell commands were
  clipped before markdown rendering.
- This could cut a fenced `bash` block mid-command and show a confusing
  "characters hidden / Open full text" footer.

Decision:

- Normal assistant/user messages should render complete inline.
- Context digests may still be folded because they are intentionally large
  handoff payloads.
- Copy buttons and full-text sheets must continue to use the complete message.

Files changed:

- `Sources/ZenithDock/Views/EventViews.swift`
- `Sources/ZenithDockIOS/Views/MobileEventViews.swift`

### Context

ZenithDock now has a native macOS app, an iOS/iPadOS app, shared `ZenithCore`,
and a Zen-nv agent server. We have been iterating fast, and some fixes have
been reversed or rediscovered. This log exists to stop that.

### Source Of Truth

- Local repo: `/Users/zen/agi/ZenithDock`
- Mac app bundle: `/Users/zen/agi/ZenithDock/dist/ZenithDock.app`
- Server source: `/Users/zen/agi/ZenithDock/server/agent_server.py`
- Deployed server copy on Zen-nv:
  `/home/zen/Zenithbot/scripts/agent_server.py`
- Deploy command from repo root: `./server/deploy_nv.sh`
- Health check on Zen-nv: `curl -s http://127.0.0.1:7850/api/health`

### Current Architecture Notes

- `ZenithCore` owns shared models and API client behavior for macOS and
  iOS/iPadOS.
- macOS UI lives under `Sources/ZenithDock`.
- iOS/iPadOS UI lives under `Sources/ZenithDockIOS`.
- The server can run Claude or Codex backends, stream events, queue messages,
  manage jobs, expose files/videos, and inspect live processes for the current
  chat.
- Runtime options should come from the server/catalog, not a hard-coded UI list.
- Token auth is optional for local dev but must protect API, upload, websocket,
  and file/video preview routes when `ZENITHDOCK_AGENT_TOKEN` is set.

### UX Rules To Preserve

- Queued messages belong visually at the bottom composer area until sent, not
  mixed into persisted chat history.
- Stop agent must stop the active backend process group, not merely update UI.
- Files & Videos should be foldable, latest-first, paged, and not dominate the
  inspector.
- Video grids should show previews. Clicking a video should open a player
  without auto-fullscreen.
- Each video/file should support open, copy/open link, find in chat, and drag
  out where possible.
- Dragging files into the main timeline should upload/attach them.
- Long messages and digests should fold aggressively, with a visible full-text
  affordance near the top of the message.
- Tool calls and reasoning traces should be folded by default. The main chat
  should emphasize assistant/user text, not raw tool noise.
- Go-to-bottom should be small and hidden when roughly at the bottom.
- User bubbles should stay visually distinct; queued messages need their own
  color/state.
- Editable server URL fields must not fight the user while typing. Do not
  aggressively rewrite the text field contents during edits.
- iPhone/iPad composer should grow sensibly, dismiss keyboard on scroll, support
  enter-to-send behavior intentionally, and preserve Shift+Enter for newlines
  when hardware keyboards are used.

### Mac 100% CPU Loop

Observed symptom:

- ZenithDock process hit roughly 100% CPU and became sluggish/unresponsive.

Useful sample:

- Sampled process `80867` with `sample 80867 5 -file /tmp/ZenithDock.sample.txt`.
- Main thread was in SwiftUI layout/prefetch code, including:
  - `SwiftUICore LazySubviewPlacements.updateValue`
  - `LazyLayoutViewCache.updatePrefetchPhases`
  - `LazyStack<>.place`
  - `ForEachList.applyNodes`

Current interpretation:

- This sample points at a SwiftUI lazy layout loop, not AV/video decode and not
  the server.
- The user explicitly pushed back that selectable text itself should not be
  blamed without evidence. Do not roll back selectable text as a reflex.

Changes made after this sample:

- `Sources/ZenithDock/Views/TimelineView.swift`
  - Replaced the main timeline `LazyVStack` with a plain `VStack`.
  - This is acceptable because the Mac timeline already limits rendered rows
    with `visibleRowLimit`.
  - Throttled `TimelineScrollObserver` reporting from `0.05s` to `0.15s`.
- `Sources/ZenithDock/Views/InspectorView.swift`
  - Replaced the Files & Videos `LazyVGrid` with a small manual row layout.
  - Replaced the expensive `files.map(\.id).joined(separator: "|")` change key
    with a cheap count/first/last token.

Verification:

- `xcodebuild -scheme ZenithDockMac -configuration Release -destination platform=macOS build -quiet`
  passed.
- Normal app bundle was refreshed with `ditto` into
  `/Users/zen/agi/ZenithDock/dist/ZenithDock.app`.
- `codesign --verify --deep --strict /Users/zen/agi/ZenithDock/dist/ZenithDock.app`
  passed.

Important caution:

- We have been back and forth on `LazyVStack`. Do not reintroduce lazy timeline
  layout unless a fresh CPU sample shows a different bottleneck and the rendered
  row cap is no longer enough.

### Open Follow-Ups

- If the 100% CPU loop returns, collect a fresh sample before changing UI code.
- If the sample still shows SwiftUI layout placement, inspect timeline rows,
  text selection, markdown rendering, and scroll observer together rather than
  blaming one feature in isolation.
- Confirm after a real relaunch that the rebuilt
  `/Users/zen/agi/ZenithDock/dist/ZenithDock.app` is the binary being used.
- Keep adding log entries after major Mac/iOS/server changes.

## 2026-05-17 Follow-Up

### Per-Chat Tmux Terminal

User request:

- Add a terminal for each chat.
- Opening the terminal should create a tmux session if needed, and reattach to
  the same tmux session later from either Mac or iOS/iPadOS.
- The app should support sending commands, refreshing output, interrupting, and
  killing the tmux session.

Scope/implementation:

- This first version is server-backed and tmux-native, but not a full ANSI
  terminal emulator.
- The server uses deterministic tmux names derived from the ZenithDock chat id,
  so Mac and iOS attach to the same tmux session.
- The terminal UI renders `tmux capture-pane` output and sends input through
  `tmux send-keys`.

Changes:

- `server/agent_server.py`
  - Added terminal request models.
  - Added tmux helpers for deterministic naming, create/attach, capture,
    send input, interrupt key support, and kill.
  - Added endpoints:
    - `GET /api/sessions/{session_id}/terminal`
    - `POST /api/sessions/{session_id}/terminal/open`
    - `POST /api/sessions/{session_id}/terminal/input`
    - `DELETE /api/sessions/{session_id}/terminal`
  - Chat deletion best-effort kills the chat's tmux session.
- `Sources/ZenithCore/ZenithCore.swift`
  - Added `ZTerminalSnapshot`.
- `Sources/ZenithDock/State/AppStore.swift`
  - Added terminal snapshot/input state and terminal API methods.
- `Sources/ZenithDock/Views/InspectorView.swift`
  - Added a Mac Terminal inspector section and terminal sheet.
  - Supports start/open, send command, refresh, interrupt, and kill.
- `Sources/ZenithDockIOS/State/MobileAppStore.swift`
  - Added mobile terminal state and API methods.
- `Sources/ZenithDockIOS/Views/MobileChatOptionsView.swift`
  - Added iPhone/iPad Terminal section and terminal sheet.

Verification:

- `python3 -m py_compile server/agent_server.py` passed.

### Embedded Per-Chat Tmux Terminal Tab

User issue:

- The per-chat tmux feature opened as a popup and behaved like a command sender.
- Desired behavior is a tab beside the chat timeline that feels like a normal
  terminal attached to the chat's persistent tmux session.

Changes:

- `Sources/ZenithDock/Views/RootView.swift`
  - Added a main content pane switcher for `Chat` and `Terminal`.
- `Sources/ZenithDock/Views/TimelineView.swift`
  - Added the same pane switcher to the chat header.
- `Sources/ZenithDock/Views/TerminalWorkspaceView.swift`
  - Added a native macOS terminal pane backed by the selected chat's tmux
    session.
  - Captures typed characters, paste, return, tab, escape, arrows, page keys,
    backspace/delete, and Ctrl-letter chords and forwards them to tmux.
  - Polls tmux output while the terminal tab is visible and auto-resizes the
    tmux pane based on the visible terminal size.
- `Sources/ZenithDock/Views/InspectorView.swift`
  - The Terminal section now switches to the embedded terminal tab instead of
    opening a separate terminal window.
- `server/agent_server.py`
  - Added terminal pane resize support and reports tmux pane dimensions in
    terminal snapshots.
- `Sources/ZenithCore/ZenithCore.swift`
  - Added optional terminal `columns` and `rows` fields.

Known limitation:

- This is still a tmux capture-pane renderer, not a full ANSI/xterm emulator.
  Normal shell typing and control keys work, but rich full-screen terminal apps
  may not render perfectly until we add a real terminal emulator layer.

Verification:

- `python3 -m py_compile server/agent_server.py` passed.
- `swift build --product ZenithDock` passed.
- `xcodebuild -project ZenithDock.xcodeproj -scheme ZenithDockIOS -sdk iphonesimulator -configuration Debug CODE_SIGNING_ALLOWED=NO build` passed.

### Stale Cache Catch-Up Without Live Backlog Replay

User issue:

- Opening the app on another machine, or after not syncing for a while, made
  the app churn through old chat history.
- Old `turn_started` / `turn_finished` traffic arrived over the WebSocket as if
  it were live, causing visible "running" flicker and sluggish catch-up.

Root cause:

- The app showed cached chat history, fetched one small page after the cached
  sequence, then opened the WebSocket from that still-stale sequence.
- If many events happened while the device was away, the socket replayed the
  backlog one event at a time through the live ingestion path.

Changes:

- `server/agent_server.py`
  - `/api/sessions/{session_id}` now includes `latest_seq`,
    `events_omitted_after`, and `event_count` metadata for after-cache
    requests.
  - Sequence-bound scanning is only used for catch-up requests that need to know
    whether more events remain after the returned page.
- `Sources/ZenithDock/State/AppStore.swift`
  - Mac now uses cached chat only for instant display.
  - If the cache is stale beyond one page, it loads the latest tail snapshot and
    connects the live socket from the latest sequence instead of replaying the
    backlog.
- `Sources/ZenithDockIOS/State/MobileAppStore.swift`
  - iPhone/iPad use the same stale-cache catch-up behavior.

Verification:

- `python3 -m py_compile server/agent_server.py` passed.
- `swift build --product ZenithDock` passed.
- `xcodebuild -project ZenithDock.xcodeproj -scheme ZenithDockIOS -sdk iphonesimulator -configuration Debug CODE_SIGNING_ALLOWED=NO build` passed.
- `xcodebuild -scheme ZenithDockMac -configuration Release -destination platform=macOS build -quiet`
  passed.
- `xcodebuild -scheme ZenithDockIOS -configuration Debug -destination generic/platform=iOS build -quiet`
  passed.
- Refreshed `/Users/zen/agi/ZenithDock/dist/ZenithDock.app` with `ditto`.
- `codesign --verify --deep --strict /Users/zen/agi/ZenithDock/dist/ZenithDock.app`
  passed.

### Wide-Screen Response Width

User issue:

- On wide Mac screens, assistant/job chat responses were still constrained by
  narrow legacy caps, leaving too much unused horizontal space.

Changes:

- `Sources/ZenithDock/Views/TimelineView.swift`
  - Removed the Mac timeline content cap of `980`.
- `Sources/ZenithDock/Views/EventViews.swift`
  - Assistant and job response bubbles can now expand to available width.
  - User bubbles remain capped to keep short prompts readable.
- `Sources/ZenithDockIOS/Views/MobileEventViews.swift`
  - Mirrored the assistant/job expansion behavior for wide iPad layouts.

Verification:

- `xcodebuild -scheme ZenithDockMac -configuration Release -destination platform=macOS build -quiet`
  passed.
- `xcodebuild -scheme ZenithDockIOS -configuration Debug -destination generic/platform=iOS build -quiet`
  passed.
- Refreshed `/Users/zen/agi/ZenithDock/dist/ZenithDock.app` with `ditto`.
- `codesign --verify --deep --strict /Users/zen/agi/ZenithDock/dist/ZenithDock.app`
  passed.

### Job Scheduling UX And Runtime

User issue:

- The old job creation flow was unintuitive because the user edited job details
  in one control, then had to click a separate `New Job` / `Create Job` button
  elsewhere to submit.
- Job status cards needed to show how long each scheduled run took.

Changes:

- `Sources/ZenithDock/Views/InspectorView.swift`
  - Replaced the split Mac job creation controls with a single prominent
    `Schedule Job...` entry point.
  - The schedule sheet now has explicit `Cancel` and `Schedule Job` actions.
  - The sheet footer repeats the primary schedule action with the current
    schedule summary.
- `Sources/ZenithDockIOS/Views/MobileChatOptionsView.swift`
  - Mirrored the same `Schedule Job...` flow on iPhone/iPad.
  - Added a bottom safe-area schedule action inside the mobile sheet.
- `Sources/ZenithDock/Views/TimelineView.swift`
  - Job run rows now track start, finish, and latest event timestamps.
- `Sources/ZenithDockIOS/Views/MobileTimelineView.swift`
  - Mirrored job run timing metadata on iPhone/iPad.
- `Sources/ZenithDock/Views/EventViews.swift`
  - Job status labels now include runtime, for example `runtime 2m 14s`.
  - Grouped job status cards show runtime for the latest run, and expanded
    older runs include runtime in their labels.
- `Sources/ZenithDockIOS/Views/MobileEventViews.swift`
  - Mirrored runtime labels on iPhone/iPad job status cards.

Verification:

- `xcodebuild -scheme ZenithDockMac -configuration Release -destination platform=macOS build -quiet`
  passed.
- `xcodebuild -scheme ZenithDockIOS -configuration Debug -destination generic/platform=iOS build -quiet`
  passed.
- Refreshed `/Users/zen/agi/ZenithDock/dist/ZenithDock.app` with `ditto`.
- `codesign --verify --deep --strict /Users/zen/agi/ZenithDock/dist/ZenithDock.app`
  passed.

### Live Stdout Tail

User issue:

- The live process inspector needed the process stdout, not just PID/process
  metadata or attached log files.
- The first stdout panel was readable but had no close/collapse affordance.

Changes:

- `server/agent_server.py`
  - Added a bounded per-active-run stdout ring buffer.
  - Claude/Codex stdout is copied into this buffer as the server reads it, so
    the app never competes with the parser for the underlying pipe.
  - Process snapshots now include `stdout_tail`.
- `Sources/ZenithCore/ZenithCore.swift`
  - Added `ZProcessOutputTail` and exposed it on `ZProcessSnapshot`.
- `Sources/ZenithDock/Views/InspectorView.swift`
  - Added a Live stdout panel to the Mac process inspector.
  - The panel supports copy, collapse/expand, and an explicit hide button.
  - Collapsed mode shows only the latest stdout line.
- `Sources/ZenithDockIOS/Views/MobileChatOptionsView.swift`
  - Added the same Live stdout panel for iPhone and iPad.

Verification:

- `python3 -m py_compile server/agent_server.py` passed.
- `xcodebuild -scheme ZenithDockMac -configuration Release -destination platform=macOS build -quiet`
  passed.
- `xcodebuild -scheme ZenithDockIOS -configuration Debug -destination generic/platform=iOS build -quiet`
  passed.
- Refreshed `/Users/zen/agi/ZenithDock/dist/ZenithDock.app` with `ditto`.
- `codesign --verify --deep --strict /Users/zen/agi/ZenithDock/dist/ZenithDock.app`
  passed.

### Live Process Inspector Details

User issue:

- The live process inspector showed process rows, but the rows were too terse to
  understand what each live child process was actually doing.

Changes:

- `Sources/ZenithDock/Views/InspectorView.swift`
  - Added a process detail sheet reachable from each live process row.
  - The sheet shows PID, parent, process group, state, CPU, RSS, elapsed time,
    working directory, and full command line.
  - Full command and cwd are selectable and have copy buttons.
  - Attached log hints can be tailed from the details sheet, with the matching
    log tail rendered inline.
- `Sources/ZenithDockIOS/Views/MobileChatOptionsView.swift`
  - Added the same process detail flow for iPhone and iPad using a mobile sheet.
  - Mobile details include process facts, selectable command/cwd blocks, copy
    buttons, and attached log-tail actions.

Verification:

- `xcodebuild -scheme ZenithDockMac -configuration Release -destination platform=macOS build -quiet`
  passed.
- `xcodebuild -scheme ZenithDockIOS -configuration Debug -destination generic/platform=iOS build -quiet`
  passed.
- Refreshed `/Users/zen/agi/ZenithDock/dist/ZenithDock.app` with `ditto`.
- `codesign --verify --deep --strict /Users/zen/agi/ZenithDock/dist/ZenithDock.app`
  passed.

### Timeline Video Posters And Queued Color

User issue:

- Queued messages visually collided with job cards because both used the same
  warm/orange treatment.
- Timeline videos could look blank or unplayable before opening, especially
  when the system video control did not expose an obvious poster frame.

Changes:

- `Sources/ZenithDock/Design/Theme.swift`
  - Changed queued message bubbles/strokes to a yellow status treatment so they
    are distinct from orange job cards.
- `Sources/ZenithDockIOS/Design/MobileTheme.swift`
  - Mirrored the queued yellow treatment for iPhone and iPad.
- `Sources/ZenithDock/Views/Components/InlineVideoView.swift`
  - Added macOS video thumbnail generation with a small cache.
  - Timeline videos now show a poster-style preview with play/open controls
    before launching the inline player.
- `Sources/ZenithDockIOS/Views/MobileEventViews.swift`
  - Added iPhone/iPad timeline video poster generation and a tappable preview
    that opens the existing video sheet.

Verification:

- `xcodebuild -scheme ZenithDockMac -configuration Release -destination platform=macOS build -quiet`
  passed.
- `xcodebuild -scheme ZenithDockIOS -configuration Debug -destination generic/platform=iOS build -quiet`
  passed.
- Refreshed `/Users/zen/agi/ZenithDock/dist/ZenithDock.app` with `ditto`.
- `codesign --verify --deep --strict /Users/zen/agi/ZenithDock/dist/ZenithDock.app`
  passed.

### Server Job Backpressure And Event Append Fix

User issue:

- `zen-nv` became flaky and eventually stopped responding while loop jobs were
  active.
- `/api/health` accepted a TCP connection but did not return, which pointed to
  a wedged or overloaded agent server/host rather than a simple offline port.

Likely cause found:

- `append_event` reread the whole chat `events.jsonl` file to compute the next
  sequence number every time the server wrote an event.
- Long chats plus recurring job output made that an O(history size) disk/CPU
  hit for every assistant/tool/job event.
- Scheduled jobs also had no global active-run or host-pressure guard, so jobs
  across different chats could start together.

Changes:

- `server/agent_server.py`
  - Added an in-memory event sequence cache initialized by tail-reading the
    latest JSONL event instead of counting every line.
  - Added scheduled-job backpressure for active run count, load per CPU, and
    available memory.
  - Deferred scheduled jobs now reschedule instead of launching when the host is
    already busy or low on memory.
  - `/api/health` now reports active run count and job guard thresholds/state.

Verification:

- `python3 -m py_compile server/agent_server.py` passed.

### Server Crash Breadcrumbs And Launch Guards

User issue:

- After `zen-nv` hung, we needed a way to tell whether the culprit was a
  scheduled job, a rendering/training process, or unrelated host pressure.
- Guardrails should live on the server, because the frontend may not be open
  when loop jobs or long renders are running.

Changes:

- `server/agent_server.py`
  - Added a rolling host-health JSONL log at
    `$ZENITHBOT_AGENT_DIR/host_health.jsonl`.
  - The health monitor samples load, available memory, active ZenithDock runs,
    and top host processes every 15 seconds by default.
  - Top processes are marked when their process group belongs to an active
    ZenithDock agent run, which helps distinguish agent-owned work from other
    rendering/training sessions.
  - Added `/api/diagnostics/host` to return the latest host snapshot plus a
    tail of recent breadcrumb records.
  - Added general launch admission guards for manual/queued turns, separate
    from the scheduled-job guard. New launches are rejected/deferred when active
    run count, load per CPU, or available memory exceed configured thresholds.
  - Queued turns now requeue and retry later when a launch is deferred by host
    pressure instead of being dropped.

Verification:

- `python3 -m py_compile server/agent_server.py` passed.

### Mac Terminal Tab Header Polish

User issue:

- The new Chat/Terminal switcher looked like a form control in the Mac header:
  the visible `Pane` label consumed space and made adjacent controls look
  cramped.
- The terminal `Attach` button was unclear; it sounded like file attachment
  rather than reconnecting to tmux.

Changes:

- `Sources/ZenithDock/Views/TimelineView.swift`
  - Hid the picker label so the header shows only the Chat/Terminal segmented
    tab control.
- `Sources/ZenithDock/Views/TerminalWorkspaceView.swift`
  - Hid the duplicate picker label in the Terminal tab header.
  - Renamed `Attach` to `Reconnect` when a tmux session exists, and `Start tmux`
    when one does not.

### Local Job Next-Run Times

User issue:

- Job rows displayed raw UTC ISO timestamps such as
  `2026-05-17T23:43:44Z`.
- The app should show next-run times in the Mac's current time zone.

Changes:

- `Sources/ZenithDock/Support/Formatting.swift`
  - Added shared server ISO timestamp parsing and local timestamp formatting
    using `TimeZone.autoupdatingCurrent`.
- `Sources/ZenithDock/Views/InspectorView.swift`
  - Job subtitles now show local next-run times, e.g. `next 4:43 PM today`.
- `Sources/ZenithDock/Views/EventViews.swift`
  - Job-created/job-ran summaries use the same local formatter.
  - Job runtime parsing now reuses the shared server date parser.

### Supersonic Tailscale HTTP Endpoint

User issue:

- After migrating the server to `supersonic00`, curl with the copied token
  returned `ok: true` for `http://100.73.184.23:7850/api/health`, but the Mac
  app only connected to the old `http://100.88.206.6:7850` Tailscale endpoint.

Finding:

- The Mac app bundle had ATS exceptions for `10.112.215.37` and
  `100.88.206.6`, but not the new `100.73.184.23` Tailscale IP.
- `NSAllowsLocalNetworking` alone is not enough for every Tailscale
  `100.64.0.0/10` address on macOS, so the old endpoint worked because it was
  explicitly whitelisted.

Changes:

- `Apps/ZenithDockMac/Info.plist`
  - Added an explicit ATS exception for `100.73.184.23`.
- `Apps/ZenithDockIOS/Info.plist`
  - Added the same explicit `100.73.184.23` exception.

### Public-Facing Server Labels And Runtime Defaults

User issue:

- App copy still mentioned the original machine name in empty states, error
  text, README snippets, and local-network usage text.
- The model picker showed `Server default` without explaining which model and
  reasoning effort the server would actually use.

Changes:

- Removed machine-specific wording from user-facing app strings and README
  examples.
- Replaced hardcoded `/home/zen` fallback working directories with the
  `default_cwd` reported by `/api/health`, falling back to `~` before the first
  health response.
- Changed fresh-install default endpoint to localhost; saved user endpoints are
  still preserved by UserDefaults.
- Extended `/api/runtime/catalog` so the server reports `default_model` and
  `default_effort` where the backend CLI exposes them.
- Fixed Codex catalog sorting so priority `0` is treated as the highest
  priority instead of missing. This makes Codex server default display as
  `GPT-5.5` with `XHigh` effort on the updated server.
- Updated runtime labels so menus and summaries show labels such as
  `Server default (GPT-5.5)` instead of opaque `Server default`.

Verification:

- `python3 -m py_compile server/agent_server.py` passed.
- `swift build --product ZenithDock` passed.
- `xcodebuild -scheme ZenithDockMac -configuration Release -destination platform=macOS build -quiet` passed.
- `xcodebuild -scheme ZenithDockIOS -configuration Debug -destination generic/platform=iOS build -quiet` passed.
- Refreshed `/Users/zen/agi/ZenithDock/dist/ZenithDock.app` from the Release
  build and verified codesign.
- Deployed the server update to the `sonic` endpoint and verified
  `/api/runtime/catalog` reports `default_model = gpt-5.5` and
  `default_effort = xhigh` for Codex.

### Archived Chats And Digest Targets

User issue:

- Old or parked chats should be archivable instead of deleted.
- Archived chats should not appear as target choices in the create-digest
  window.

Changes:

- Added persisted `archived` / `archived_at` session state on the server and
  in the shared Swift session model.
- Moved archived chats out of normal Pinned/Folder lists and into an Archived
  section where they can be restored or deleted.
- Added Archive/Unarchive actions on macOS and iOS/iPadOS.
- Filtered digest target pickers to active, non-archived chats.
- Added a guardrail check so archive state and digest filtering do not regress.

### Latest Timeline Reveal Gating

User issue:

- Opening a chat showed the `Opening latest messages` spinner briefly, then
  the timeline still visibly flew through intermediate text before landing.

Finding:

- The Mac timeline masked the view during session switching, but the store
  published cached chat rows before the network/latest snapshot finished.
- The reveal logic treated non-empty cached rows as ready, so the mask could
  drop before the final latest-page layout had settled.

Changes:

- Added explicit Mac session-selection loading state to `AppStore`.
- Kept the timeline masked while the latest snapshot is still loading.
- Retried the reveal when the latest snapshot load completes, then scrolled to
  bottom without animation before showing the timeline.
- Added a guardrail check for this reveal contract.

### Video Metadata Loading

User issue:

- Long-running chats with many files could show only a few videos in the Mac
  Files & Videos panel.

Finding:

- The server had no saved-video count cap, but the Mac app loaded a mixed
  newest-first file page. If the newest page was mostly logs/CSVs/images, older
  videos were hidden until more mixed pages were loaded.
- Artifacts written by an active run still appear after the run writes the
  ZenithDock manifest and the server collects it.

Changes:

- Added a server `content_prefix` query on `/api/sessions/{session_id}/files`.
- Mac now fetches `video/` metadata independently from the mixed file page and
  renders that independent list in the video grid.
- Added a guardrail check so video metadata cannot regress back to being
  limited by mixed file pagination.

Verification:

- `python3 -m py_compile server/agent_server.py` passed.
- `swift run ZenithGuardrails` passed.
- `swift build --product ZenithDock` passed.
- `xcodebuild -scheme ZenithDockMac -configuration Release -destination platform=macOS build -quiet` passed.
- Refreshed `/Users/zen/agi/ZenithDock/dist/ZenithDock.app` from the Release
  build and verified codesign.

### TestFlight Build 27

Changes:

- Bumped `CURRENT_PROJECT_VERSION` from `26` to `27`.
- Uploaded iOS/iPadOS build 27 to App Store Connect.
- Uploaded macOS build 27 to App Store Connect.

Verification:

- `swift run ZenithGuardrails` passed before archiving.
- `xcodebuild -scheme ZenithDockIOS -configuration Release -destination generic/platform=iOS -archivePath build/archives/ZenithDockIOS-27.xcarchive archive -quiet -allowProvisioningUpdates` passed.
- `xcodebuild -exportArchive -archivePath build/archives/ZenithDockIOS-27.xcarchive -exportOptionsPlist build/TestFlightExportOptions.plist -exportPath build/TestFlightIOSExport-27 -quiet -allowProvisioningUpdates` uploaded successfully.
- `xcodebuild -scheme ZenithDockMac -configuration Release -destination generic/platform=macOS -archivePath build/archives/ZenithDockMac-27.xcarchive archive -quiet -allowProvisioningUpdates` passed.
- `xcodebuild -exportArchive -archivePath build/archives/ZenithDockMac-27.xcarchive -exportOptionsPlist build/TestFlightExportOptions.plist -exportPath build/TestFlightMacExport-27 -quiet -allowProvisioningUpdates` uploaded successfully.

### Runtime Autosave And Backend Icons

User issue:

- The Mac inspector's `Save Runtime` button added unnecessary friction.
- Backend icons in the chat list looked generic or misleading; Codex used a
  search glyph and Claude used a grid glyph.

Changes:

- Runtime picker changes now autosave on macOS and iOS/iPadOS.
- Custom model text autosaves after a short debounce, and pressing return saves
  immediately.
- Removed the Mac `Save Runtime` button.
- Renamed the iOS options save button to `Save Session Details` so runtime no
  longer appears manual there.
- Centralized backend icon/tint choices in app theme helpers:
  - Claude uses `sparkles` with orange tint.
  - Codex uses `terminal` with green tint.
- Added guardrails for runtime autosave and backend icon regressions.

Verification:

- `swift run ZenithGuardrails` passed.
- `swift build --product ZenithDock` passed.
- `swift build --product ZenithDockIOS` still fails under SwiftPM because it
  compiles the iOS target for macOS and cannot import UIKit; use Xcode for this
  target.
- `xcodebuild -scheme ZenithDockMac -configuration Release -destination platform=macOS build -quiet` passed.
- `xcodebuild -scheme ZenithDockIOS -configuration Debug -destination generic/platform=iOS build -quiet` passed.
- Refreshed `/Users/zen/agi/ZenithDock/dist/ZenithDock.app` from the Release
  build and verified codesign.

### Run-Scoped Timeline Trace Grouping

User issue:

- Long runs still rendered as a tall alternating stack of `Assistant` and
  `Trace` rows.
- Trace cards were collapsed internally, but each assistant/tool/reasoning phase
  still occupied a separate timeline row.

Changes:

- Mac and iOS timeline projection now collect assistant chunks by `run_id`.
- Assistant chunks from the same run render as one combined assistant message.
- Tool/reasoning/system trace events from the same run render as one combined
  trace card.
- Orphan trace events still group contiguously for debug/history cases.
- Added a guardrail check so timeline projection keeps run-scoped trace
  grouping.

### Inline Video Play Autoplay

User issue:

- Pressing Play on a timeline video only loaded the video controls. The user had
  to press Play again inside the video timeline.

Changes:

- Inline timeline video placeholders now preserve the user's play intent.
- macOS `AVPlayerView` starts playback immediately after the inline player is
  created from the placeholder Play action.
- iOS/iPadOS inline web video receives the same autoplay intent through the
  generated HTML and attempts `video.play()` after load.
- Added a guardrail check so the inline Play button keeps meaning play, not just
  load.

### Real Backend Logo Marks And Runtime Fallback

User issue:

- Claude/Codex icons still looked wrong after the previous pass because Codex
  rendered as a terminal box and Claude rendered as a generic sparkle.
- The runtime model menu could collapse to only `Server default` when the server
  catalog was unavailable or returned no specific Codex models.

Changes:

- Replaced SF Symbol backend placeholders with small SwiftUI vector logo marks:
  - Claude uses an orange radial/starburst mark.
  - Codex uses a multicolor loop mark instead of the terminal glyph.
- Updated macOS and iOS/iPadOS sidebar rows, composer chips, and running-agent
  status to use the logo views.
- Added a local Codex catalog fallback that includes GPT-5.5, GPT-5.4,
  GPT-5.3 Codex, GPT-5.3 Codex Spark, GPT-5.2, and reasoning efforts while the
  server catalog is empty or late.
- Kept server/CLI catalog discovery as the primary source whenever it reports
  concrete options.
- Strengthened guardrails so Codex cannot silently regress to the terminal
  symbol again.

### Structured Code Review Sheet

User issue:

- The existing `Code Changes` modal looked like a debug dump compared with
  Codex's review panel.
- The file list could also pick up diff body fragments as fake changed files.

Changes:

- Reworked the macOS code-change review sheet into a two-pane review surface:
  file navigator on the left and selected-file diff rows on the right.
- Added colored add/delete rows, old/new line numbers, hunk metadata rows, and a
  copy-diff button.
- Added per-file section parsing for unified diffs and `apply_patch` payloads.
- Tightened changed-file extraction so raw `+...` and `---` diff body lines do
  not become fake file rows.
- Added a guardrail to keep the review sheet structured instead of regressing
  to one giant code block.

### Supplied Backend Icon Assets

User issue:

- The generated backend marks still did not match the actual Claude/Codex icons
  the user wanted.

Changes:

- Added the user-supplied Claude and Codex images to the shared asset catalog so
  both macOS and iOS/iPadOS use the same backend marks.
- Processed the Claude icon to remove the white background and the Codex icon to
  remove the black JPG corner matte.
- Updated the macOS and iOS backend logo views to render the supplied assets,
  while keeping the generic CPU fallback only for unknown backends.
- Added guardrails so the app cannot regress to SF Symbol placeholders or
  generated backend marks without the asset files present.

Follow-up:

- Fixed the supplied asset logo views to size and clip the image inside the logo
  view itself. A frame around the outer SwiftUI group could let the resizable
  image visually escape its layout slot and balloon inside the composer.
- Composer/running-status chips now pass a 13px icon size directly instead of
  relying on an outer frame.
- Runtime labels no longer say `Server default (...)` when the resolved
  default is known; the UI shows the actual model/effort, such as `GPT-5.5` and
  `XHigh`.
- Backend logo asset catalogs now ship 16/32/48 px renditions so even intrinsic
  image sizing cannot balloon the composer icon to the original 225 px source
  export.

### Backend Lock After Chat Start

User issue:

- Changing backend after a Claude/Codex provider session exists can make one
  ZenithDock chat represent two incompatible provider threads.

Changes:

- Added `ZSession.isBackendLocked`, true when `session_id`,
  `claude_session_id`, or `codex_thread_id` is present.
- Server session updates now return HTTP 409 if a backend change is attempted
  after the chat has started.
- Disabled backend controls in the macOS composer/inspector and iOS/iPadOS
  timeline/options once the backend is locked.
- Added guardrails for the shared lock property, server conflict response, and
  UI-disabled controls.

Follow-up:

- The locked macOS composer backend display is now a normal read-only chip
  rather than a disabled menu. Disabling the menu dimmed the supplied backend
  icon and made it look dark/muddy even though the backend was merely locked.

### New Message Marker Repair

User issue:

- The selected-chat new-message marker could disappear or never render when an
  agent replied while the user was scrolled away from the bottom.

Changes:

- The macOS store now tracks the first unread agent event sequence per session,
  not just a boolean unread session ID.
- The timeline renders an inline `New messages` divider before the first row at
  or after that unread sequence.
- Split strict bottom detection from "near bottom" button hiding. Read clearing
  now requires a strict bottom threshold, while the floating button can still
  show `New` even if the user is near the bottom.
- Added guardrails for unread sequence tracking, inline marker rendering, and
  strict read-clearing behavior.

Follow-up:

- Scheduled-job responses (`job_ran`) are visible agent output and now count for
  unread/new-message state.
- The store now tracks whether the selected timeline is actually at bottom, so
  live selected-chat agent/job output can mark unread immediately when the user
  is scrolled away.
- Fixed the macOS scroll observer to deliver a trailing scroll-position report
  after throttling. Without that, a quick scroll away from bottom could leave
  stale `at bottom` state and immediately clear the marker.

### History Window And Scroll Preservation

User issue:

- Huge chats could reopen with only a very small latest window, even when the
  local cache had more history. Loading older messages could also jump because
  trace/job grouping changes row IDs as older events arrive.

Changes:

- Mac chat selection now requests 480 latest events, which is three of the
  existing 160-event history pages.
- The local chat cache now keeps 1,440 events so a warmed chat retains several
  recent pages instead of immediately shrinking back to one tail page.
- Fresh server snapshots merge with same-chat cached events instead of replacing
  them wholesale. The hidden-older count is reduced by the preserved local
  events so the `Load Older` count stays honest.
- Older-history paging now stores both the rendered row ID and a representative
  event ID. If trace/job folding changes the row ID, the timeline restores to
  the row containing the same event instead of jumping to the new top.
- Added guardrails for the larger initial window, larger cache, cache-preserving
  snapshot merge, and event-ID scroll anchor fallback.

### Queue Removal Visibility

User issue:

- Removing a queued message could leave a normal-looking user bubble labeled
  `Removed from queue`, which made it look like the message still existed in
  the conversation.

Changes:

- The server already removes the queued turn from its in-memory queue and emits
  a `turn_unqueued` audit event.
- The macOS timeline now hides any `turn_queued` row that has a matching
  `turn_unqueued` event.
- macOS and iOS/iPadOS now also remove the queued row locally immediately after
  a successful unqueue request, so the UI does not wait on the websocket echo.
- Added guardrails so cancelled queued turns cannot regress into visible chat
  bubbles again.

### Prompt Image Attachments

User issue:

- Images sent with a prompt were uploaded, but the later chat history only
  showed the prompt text. The picture was not rendered with the user turn.
- Pasting a copied image directly into the macOS chat box did not attach it.

Changes:

- macOS and iOS/iPadOS stores now resolve `turn_started` / `turn_queued`
  `file_ids` back into known session file metadata.
- User message bubbles render those prompt attachments, including inline image
  thumbnails and compact fallback chips for non-image files.
- The macOS text editor now intercepts pasteboard file URLs and raw image data.
  Raw images are written to a temporary PNG under `ZenithDockPasteboardImages`
  and passed through the normal upload queue.
- Added guardrails for prompt attachment rendering and pasteboard image import.

### Timeline Live Scroll Jump

User issue:

- During live updates, the chat could briefly jump up toward older history and
  then snap back to the bottom.

Changes:

- Fixed macOS and iOS/iPadOS live-follow row limiting. Being at the bottom no
  longer expands the rendered row window to the full chat history.
- Programmatic bottom scrolls now briefly suppress older-history auto-load, so
  a transient top-reader geometry update cannot request older pages while the
  app is following a live stream.
- Added guardrails for capped live-follow row growth and bottom-scroll history
  suppression.

### Agent Tool Error Recovery Prompt

User issue:

- Agents were often stopping after an inspection command failed, especially
  malformed JSON reads or using the wrong command for a file.

Investigation:

- The deployed `supersonic00` server did not contain an explicit "stop on
  error" system prompt.
- The injected Claude/Codex prompt also did not tell agents how to recover from
  ordinary tool failures, so provider defaults could treat a failed inspection
  as enough reason to answer early.

Changes:

- Added explicit recovery instructions to both the Claude system prompt and the
  Codex prompt prelude.
- Failed commands, JSON parse mistakes, missing files, and missing Python
  aliases are now described as debugging signals, not stopping conditions.
- Agents are told to retry with safer alternatives such as `python3`, `jq`,
  `python3 -m json.tool`, `rg`, `sed`, `head`, `tail`, or a small script before
  declaring a real blocker.
- The recovery rule now explicitly says non-intrusive fixes should be attempted
  directly, while destructive removals, broad overwrites, missing credentials,
  or approval-sensitive actions remain stop-and-ask boundaries.

### Warm-Cache Chat Opens

User issue:

- Opening a previously loaded chat could show `Opening latest messages` for a
  while even when there were no new messages and the local cache was warm.

Root cause:

- The earlier stale-history fix masked the timeline for the entire latest-tail
  fetch whenever `isSelectingSession` was true.
- That prevented stale flashes, but it also hid valid selected-chat cache while
  the server refresh was still in flight.

Changes:

- macOS now reveals cached selected-chat rows immediately when `loadedSessionID`
  already matches the selected chat, while the latest snapshot refreshes in the
  background.
- iOS/iPadOS now only suspends the timeline while loading if there are no cached
  display events to show.
- Updated guardrails so cold opens still mask, but warm selected-chat cache is
  allowed to render.

### Native-Only Mac Composer Typing

User issue:

- Mac composer typing still felt noticeably slower than the Codex app.

Root cause:

- The composer no longer published text presence every keystroke, but it still
  synced the full draft into SwiftUI every 180 ms. That was enough to re-render
  composer chrome, height logic, menus, and parent layout during active typing.

Changes:

- Removed recurring full-draft SwiftUI sync during normal typing.
- The native `NSTextView` now owns the full draft until Enter/send. SwiftUI only
  receives empty/non-empty state and visible line-count changes.
- The send button triggers a `submitRevision` that asks the native text view for
  its current text instead of relying on a live SwiftUI draft binding.
- Updated guardrails to forbid reintroducing scheduled full-draft sync from the
  composer.

### Less Aggressive Message Folding

User issue:

- Normal long messages were folding a little too early, making the timeline feel
  over-compressed.

Changes:

- Increased Mac folding limits by 1.5x:
  - context digests: 1,200 -> 1,800 characters and 12 -> 18 lines
  - normal messages: 2,800 -> 4,200 characters and 32 -> 48 lines
- Increased iOS/iPadOS folding limits by 1.5x:
  - context digests: 900 -> 1,350 characters and 10 -> 15 lines
  - normal messages: 1,200 -> 1,800 characters and 12 -> 18 lines
- Added a guardrail so these thresholds do not quietly regress.

### Threshold-Based Timeline Scroll Reporting

User issue:

- Mac chat timeline scrolling still felt heavier than it should.

Root cause:

- The timeline used a hidden SwiftUI `GeometryReader` preference at the top of
  the scroll content to detect older-history loading.
- The AppKit scroll observer also reported continuous pixel-distance changes,
  even though the UI only needs to know when the viewport crosses top/bottom
  thresholds.

Changes:

- Removed the top SwiftUI geometry preference reader from the Mac timeline.
- The AppKit scroll observer now reports both distance from top and distance
  from bottom.
- Scroll metrics are equality-bucketed around the thresholds that matter:
  strict bottom, near bottom, top visible, and top left viewport. Middle-of-chat
  scrolling no longer publishes every pixel into SwiftUI.
- Added a guardrail so the timeline does not regress to geometry-preference
  scroll tracking.

### Warm Chat Opens Without Spinner

User issue:

- Re-opening a chat that had been opened a few minutes earlier could still show
  `Opening latest messages` for a long time, even when there were no new
  messages.

Root cause:

- The Mac memory chat cache was only eight chats and depended on the delayed
  disk-cache write path. A recently viewed chat could miss the warm-memory path
  if the delayed write was canceled or the tiny cache was churned.
- The timeline also always armed the opening mask on selection changes, then
  waited for later settle logic to remove it.

Changes:

- Mac now snapshots the currently selected chat into memory before switching
  away, independent of the delayed disk-cache writer.
- Increased Mac warm chat cache capacity from 8 to 32 chats.
- The Mac timeline no longer arms the opening mask when the selected chat
  already has warm display events, and it drops the mask immediately if warm
  cache becomes available during the selection refresh.
- Added guardrails for warm-cache selection behavior.

### Quick-Switch Warm Cache Ordering

User issue:

- Quickly switching between chats could still show `Opening latest messages`
  for too long.

Root cause:

- Selection changed before warm memory cache was applied. That gave the timeline
  a moment to treat the destination chat as a cold open and arm the opening
  mask, even when the cache was available.

Changes:

- Mac now fetches and applies warm memory cache before publishing the selected
  chat ID during normal selection.
- Re-selecting a chat whose network load is already in flight now also applies
  memory cache before publishing the selection.

### Inline Full Text Expansion

User issue:

- `Open full text` opened a separate window/sheet instead of expanding inside
  the chat timeline.

Changes:

- Mac and iOS folded message bubbles now toggle full text inline.
- The fold footer switches between `Open full text` and `Collapse`.
- Copy still uses the complete backing message.
- Added guardrails so folded message full text does not regress to a sheet.

### Lighter Composer Keystroke Hot Path

User issue:

- Mac composer typing still felt very slow.

Root cause:

- The native editor no longer synced the full draft into SwiftUI, but
  `textDidChange` still trimmed the whole draft and recomputed line counts on
  every keystroke.

Changes:

- Presence detection now uses an early-exit whitespace scan and publishes only
  when empty/non-empty state changes.
- Visible line-count updates are deferred briefly and coalesced, so normal
  typing does not split/count the full draft for every keypress.
- Added guardrails against reintroducing whole-draft trimming on the keystroke
  path.

### Archived Section Folding

User issue:

- The Archived sidebar section could not be folded even though custom folders
  had collapse controls.

Changes:

- Added a persisted Archived-section collapsed state on Mac and iOS/iPadOS.
- Replaced the plain Archived `Section` headers with custom chevron headers.
- Added guardrails so Archived cannot regress to a permanently expanded
  section.

### Batched Stream Catch-Up

User issue:

- Opening a stale chat could visibly “fly through” many websocket catch-up
  events, with the inspector event count climbing one event at a time.

Root cause:

- Websocket catch-up events were applied immediately as individual mutations.
  That is fine for live typing, but terrible for a large missed-history burst.

Changes:

- Mac now buffers a short websocket burst and applies it as one event batch.
- Large catch-up bursts turn on the existing opening mask until the batch is
  applied, so real backfill looks like loading instead of visible timeline
  churn.
- Added guardrails for the buffered catch-up path.

### Server Identity For Local State

User issue:

- The unread/new-agent-message tag could misfire when the same agent server was
  reached through different URLs.

Root cause:

- Local read state and chat cache were persisted locally, but the namespace was
  the normalized URL. That prevented cloned servers from colliding, but treated
  one server reached through LAN/Tailscale/hostname URLs as separate local
  histories.

Changes:

- The server health response now includes an opaque `server_identity` derived
  from machine identity and agent state directory.
- Mac and iOS/iPadOS adopt that identity after health succeeds and use it for
  read-state/cache namespaces. URL namespace remains the pre-health fallback.
- Mac migrates existing URL-scoped read state and disk chat cache into the
  server-identity namespace the first time the identity is learned.
- Added guardrails for the identity-based namespace path.

Follow-up deployment:

- Deployed the updated `server/agent_server.py` to `sonic` with
  `./server/deploy.sh sonic`.
- Restarted `zenithbot-agent.service`; `systemctl --user is-active` reported
  `active`.
- Unauthenticated local health now returns `401`, and service logs show
  authenticated app health/session requests returning `200`.

### Local Mac Bundle Signing

User issue:

- Launching `/Users/zen/agi/ZenithDock/dist/ZenithDock.app` crashed before the
  app started. The macOS crash report showed a dyld abort loading
  `ZenithCore.framework` because the mapped framework and process had different
  signing team identities.

Root cause:

- The local dist refresh path could overwrite or re-sign the app bundle after
  Xcode had already embedded matching Apple Development signatures. Re-signing
  the app/framework ad-hoc under hardened runtime caused dyld library
  validation to reject the embedded `ZenithCore.framework`.

Changes:

- Added `scripts/build_local_mac.sh` as the blessed local Mac build path.
- The script builds `ZenithDockMac` with Xcode, clean-removes the old dist app,
  copies the fresh app, preserves Xcode's matching app/framework signatures,
  and runs strict deep codesign verification.
- Verified the rebuilt dist app has matching `KRR35MWWHD` team signatures on
  the app and `ZenithCore.framework`.
- Smoke-launched `/Users/zen/agi/ZenithDock/dist/ZenithDock.app`; the process
  stayed running and no newer crash report was created.

### Mac Sidebar Reorder Mode

User issue:

- Chat rows and folders should not be draggable during normal use.
- After pressing `Reorder`, the sidebar should switch into a dedicated reorder
  mode where rows/folders are draggable and no longer behave as normal click
  targets.

Changes:

- Normal mode has no drag/drop hooks on chats or folders.
- Reorder mode enables drag/drop for chat rows and folder headers.
- Chat selection is ignored while reorder mode is active.
- Folder headers show a drag affordance instead of a collapse button while
  reorder mode is active, so folder collapse cannot fire accidentally.
- Updated guardrails so Mac reorder mode keeps this split behavior.
- Refreshed `/Users/zen/agi/ZenithDock/dist/ZenithDock.app`.

### Mac Sidebar Drop Indicator

User issue:

- Dragging in reorder mode had no clear visual indication of where the item
  would land.

Changes:

- Replaced plain row/header `.onDrop` closures with `DropDelegate`
  implementations for sessions and folders.
- Hovering over the top half of a row/header shows an insertion rule above it;
  hovering over the bottom half shows the rule below it.
- Drop placement now preserves before/after intent instead of only moving
  toward the hovered item.
- Added guardrails for the insertion rule and before/after placement model.
- Refreshed `/Users/zen/agi/ZenithDock/dist/ZenithDock.app`.

### Mac Sidebar Reorder State Machine

User issue:

- The blue insertion rule could remain visible after a drop, which exposed that
  the reorder indicator was only tracking the last hovered target instead of the
  full drag lifecycle.

Changes:

- Added explicit `sidebarDragPayload` state alongside the hover target.
- Drag indicators now render only when both an active drag payload and a valid
  non-self target are present.
- Drop delegates validate payload type and self-drops before showing an
  insertion target.
- Drop, exit, and reorder-mode exit all clear the drag payload and hover target.
- Reorder moves now use the local payload state instead of asynchronously
  reading `NSItemProvider`, reducing stale-state races.
- Added guardrails for active drag payload tracking and explicit cleanup.
- Refreshed `/Users/zen/agi/ZenithDock/dist/ZenithDock.app`.

### MacBook Air App Sync

User rule:

- After local Mac builds, also send the built app directly to the MacBook Air.

Changes:

- `scripts/build_local_mac.sh` now attempts to sync
  `/Users/zen/agi/ZenithDock/dist/ZenithDock.app` directly to
  `zens-macbook-air:/Users/zen/agi/ZenithDock.app`.
- The sync uses `rsync -a --delete` so the `.app` bundle is copied directly,
  not zipped.
- If the MacBook Air is asleep/offline or SSH is unavailable, the script logs a
  clear `Skipped MBA sync` message while leaving the local build successful.
- The attempted manual sync in this session could not complete because both
  `zens-macbook-air` and the last known Tailscale IP `100.98.6.43` timed out on
  SSH.

### Expanded Message Markdown Cap

User issue:

- A folded message could say `Full text shown inline` while the body still
  displayed `[message trimmed for UI]`.

Root cause:

- `MessageBubble` correctly passed the complete text when expanded, but
  `MarkdownView` had its own unconditional 32k-character UI cap and appended
  the trim marker.

Changes:

- Added `allowTruncation` to Mac `MarkdownView`.
- Expanded message bubbles pass `allowTruncation: false`, so full inline text
  really renders full inline text.
- Collapsed previews still keep the Markdown renderer cap as a last-resort
  safety valve.
- Added guardrails so expanded Mac messages bypass MarkdownView truncation.
- Refreshed `/Users/zen/agi/ZenithDock/dist/ZenithDock.app`; MBA sync was
  attempted and skipped because `zens-macbook-air` was unreachable over SSH.

### Mac Older-History Paging Window

User issue:

- A long chat such as `CMA-ES Render to LeRobot` could not load older history,
  and loading history still failed to preserve the visible timeline position.

Root cause:

- The Mac store refused to call the server once the local timeline reached the
  2,000-event render window, even when the server still reported hidden older
  events.

Changes:

- Older-history loading now uses a fixed server page size and keeps paging even
  when the local window is full.
- When an older page overflows the local window, the app slides the window by
  dropping newest overflow rows instead of blocking the older load.
- The history banner no longer replaces `Load Older` with a dead-end local
  window-limit label while the server still has older pages.
- Timeline anchor restoration now repeats across a few layout passes, which is
  less brittle when SwiftUI regroups trace/job rows after prepending history.
- Added guardrails so future changes do not reintroduce a local-cap gate on
  older-history paging.

### Local Mac Build Signing Repair

User issue:

- The freshly rebuilt local Mac app crashed immediately at launch.

Root cause:

- The crash report was a dyld launch abort: `ZenithCore.framework` was rejected
  because the embedded framework and app were not signed with the same team
  identity for hardened runtime library validation.

Changes:

- `scripts/build_local_mac.sh` now detects an Apple Development signing
  identity, signs embedded frameworks first, then signs the app with the Mac
  entitlements.
- Verified both the app and `ZenithCore.framework` report the same Team ID.
- Smoke-launched `/Users/zen/agi/ZenithDock/dist/ZenithDock.app`; no newer
  ZenithDock crash report was produced and the process stayed running.

### Timeline Media Grids And No Auto-Follow

User issue:

- Artifact/video cards could put media before the text description, and runs
  with many videos produced one giant full-width video card per file.
- New selected-chat messages could force the timeline downward while the user
  was reading elsewhere.

Changes:

- Mac and iOS artifact cards now render description text before media.
- Artifact events from the same agent run are grouped into a compact
  `Files & Videos` grid instead of separate giant timeline cards.
- Prompt attachments now use bounded grids instead of horizontal strips.
- New selected-chat agent output no longer auto-scrolls the timeline; it marks
  the chat unread and leaves movement to the explicit bottom/latest control.

### Mac Clipboard Image Paste

User issue:

- Pasting an image from the clipboard into the Mac composer did not attach it.

Changes:

- Kept the existing `Cmd-V` interception in the native text view, but expanded
  clipboard image detection beyond `NSImage(pasteboard:)`.
- The composer now scans top-level and per-item pasteboard types that conform
  to `UTType.image`, converts the image data to a temporary PNG, and sends it
  through the normal upload/attachment path.
- Added guardrails for typed pasteboard image data so this does not regress
  back to only one clipboard representation.

Follow-up:

- Image-only clipboards can leave the standard Paste action disabled before
  `paste(_:)` is ever called. The composer now validates Paste as available
  when the pasteboard contains files or image data and catches `Command-V`
  directly as a fallback.
- Added paste diagnostics to the app log so clipboard representation mismatches
  are visible without guessing.

### Explicit Load Older Navigation

User issue:

- Clicking `Load Older` could look like a no-op because the app loaded rows
  above the viewport and then preserved the same visible card.

Changes:

- Automatic top-edge history paging still preserves position.
- The explicit `Load Older` button now reveals the newly loaded older page and
  scrolls to it, so the click has visible feedback.
- Older-history logs now include the server `before` cursor, received event
  count, added event count, loaded window size, and remaining omitted count.

Follow-up:

- Some long chats can have older server pages that contain only timeline-hidden
  events such as `raw_event`. The app now advances through a bounded number of
  invisible pages in one `Load Older` action until it finds visible rows.
- The log now reports `skipped_invisible_pages` so this class of failure is
  diagnosable.

### Thread Open Latest Position

User issue:

- Opening a thread could leave the timeline at a previous or non-latest
  position instead of landing on the newest message.

Changes:

- Mac and iOS timelines now arm a one-shot `pendingOpenBottomSessionID` on
  thread selection.
- Once that selected thread's rows are actually loaded, the timeline consumes
  the pending request and scrolls to the bottom/latest message.
- This is separate from live-message behavior: opening a thread lands latest,
  while new messages that arrive afterward still do not force-scroll the reader.

### Run Artifact Ordering

User issue:

- Videos/artifacts from an agent turn could render before the assistant text,
  even though they are easier to understand after the message.

Root cause:

- The timeline projection grouped assistant text and trace events by `run_id`,
  but treated same-run `artifact_created` events as generic run events. That
  flushed the active assistant run early and placed the artifact row before the
  final text.

Changes:

- Mac and iOS timeline projections now collect same-run `artifact_created`
  events in `activeArtifactEvents`.
- When a run flushes, the row order is assistant text, artifacts/videos, then
  the folded trace.
- Added guardrails so future trace grouping work does not regress artifact
  ordering.

### Rendered Older-Page Navigation

User issue:

- The previous explicit older-page fix still looked broken when older rows were
  already in the local render window. Pressing `Show Older` expanded the window
  above the viewport but preserved the same visible card, so the click looked
  like a no-op.

Root cause:

- Only the server-backed `Load Older` path scrolled to the newly revealed page.
  The in-memory `Show Older` path reused the automatic top-edge behavior, which
  intentionally preserves position.

Changes:

- Added a separate `revealOlderRowsShowingNewPage` path for explicit user
  clicks.
- Automatic scroll-to-top paging still preserves position.
- Explicit `Show Older` and `Load Older` now both use delayed no-animation
  settling through `scrollToOlderPageTarget`, so the user lands on the newly
  revealed older page instead of watching nothing happen.

### Cached Tail Refresh Preserves Older Pages

User issue:

- Older history appeared to load, then disappeared after switching chats or
  refreshing the selected chat.

Root cause:

- `refreshCachedSessionLatestTail` requested the latest server tail correctly,
  but applied that snapshot with `preserveExisting: false`. That replaced the
  locally loaded older pages with only the latest tail, shrinking long chats
  back down after every freshness check.

Changes:

- Cached latest-tail refresh now merges with existing selected-chat events using
  `preserveExisting: true`.
- The merge path still updates the latest tail and omitted count, but no longer
  throws away older pages already loaded into the local cache.
- Updated guardrails to protect this exact regression.

### Older-Page Render Target Diagnostics

User issue:

- The Air logs showed no `loaded older` entry after the failing test, which
  means the click path often stayed in the local `Show Older` branch instead of
  reaching the server-backed `Load Older` branch.

Root cause:

- Timeline helper methods computed rows from the full loaded event list, while
  the body renders a projected suffix window. In long chats, a manual older-page
  target could be calculated from rows that were not actually present in the
  current `ScrollView`, making the scroll look broken.

Changes:

- Added `renderedRows(visibleLimit:)`, matching the same projected event window
  used by the visible timeline.
- `Show Older`, `Load Older`, anchor capture, and anchor restore now target
  projected rows that SwiftUI actually renders.
- Added explicit `show older rows` and `load older intent` log lines with row
  limits and target row IDs so future paging failures are diagnosable from the
  app log.

Follow-up:

- Air logs showed the failing path was the automatic top-edge loader: it fetched
  older events from the server, but did not emit explicit button logs.
- The automatic loader now always expands the visible row window by one page
  when server events are added, instead of depending on a row-count delta that
  can be hidden by grouping/projection.
- Added an `auto older loaded` log line with row limits, rendered row count, and
  the preserved anchor so the automatic infinite-scroll branch is visible in
  logs too.

Second follow-up:

- Fresh Air logs showed `auto older loaded` firing, but `rendered_rows` stayed
  tiny (`19`, `31`, `38`) even after hundreds of events were loaded.
- Root cause: the Mac timeline still projected only a latest-event suffix before
  building rows. Newly fetched older events were outside that suffix, so the
  app could fetch and cache older history without making it renderable.
- The Mac timeline now projects the full bounded local event window. The store
  already caps loaded timeline events, so older history remains bounded while
  actually being visible.

Third follow-up:

- Logs after the full-window projection showed older pages were loaded and
  renderable, but automatic top-edge loading still preserved the old top row.
  That meant the new older page landed above the viewport and the user saw no
  obvious change.
- Automatic older-history loading now reveals the newly loaded older page by
  scrolling to the row just before the previous top anchor.
- Manual explicit loading still uses the same older-page scroll helper.

Fourth follow-up:

- The anchor-based reveal still left too much room for SwiftUI grouping to pick
  an unhelpful row.
- `loadOlderHistory()` now returns `firstAddedEventID` alongside the count.
- Automatic and explicit older-page navigation now scroll directly to the row
  containing the first newly loaded event. This makes the scroll target
  deterministic instead of inferred from the previous viewport.

Fifth follow-up:

- Air logs then showed the server pages were loading, but some long sessions
  had hundreds of loaded events collapsed into only a few rendered rows.
- Timeline rows now retain the source event IDs they represent, so scroll
  targeting works even when assistant text is merged for display.
- Oversized assistant and trace groups are split into bounded chunks. Older
  history pages now create real visible scroll targets instead of disappearing
  inside one giant grouped row.

Sixth follow-up:

- Fresh Air logs exposed a more serious stale-response path: an older-history
  request could finish after the user switched chats and still mutate the
  current timeline.
- `loadOlderHistory()` now captures the selection generation and drops stale
  responses before applying events.
- Restored cached chats now keep the expanded `maxCachedTimelineEvents` window
  instead of shrinking back to the warm tail on every chat switch.

Seventh follow-up:

- The latest logs showed older pages were loading and row counts were growing,
  but reveal could still scroll to a row outside SwiftUI's rendered suffix.
- Older-page reveal now calculates how many rows are required to include the
  target, expands the visible suffix to cover it, and logs the exact target row.

Eighth follow-up:

- Automatic top-edge loading still used the old preserve-anchor helper when
  older rows were already cached locally. That made the app expand the visible
  row window and then restore the exact old top row, which looked like a no-op.
- The automatic path now uses the same "show newly revealed page" helper as the
  explicit Load Older action.

Ninth follow-up:

- Air logs showed opening a chat could immediately trigger `auto older loaded`
  before the bottom scroll finished settling.
- Root cause: the open-selection handler reset history-load suppression to the
  past, and `scrollToBottom()` could shorten a longer suppression window.
- History-load suppression is now monotonic and opening a chat suppresses
  top-edge autoload long enough for the repeated bottom-scroll settling passes.

Tenth follow-up:

- Air logs still showed `auto older loaded` after opening CMA-ES Debug, which meant the open-to-latest request was being consumed before real timeline rows were renderable.
- The Mac timeline now waits for the large-batch/opening mask to drop before consuming the pending latest-position request, retries when that mask clears, and keeps bottom settling alive through longer SwiftUI layout passes.
- The AppKit scroll observer no longer cancels its forced-bottom window just because an empty/non-scrollable placeholder reports distance-from-bottom zero. It only declares success once real scrollable content is at the bottom.

Eleventh follow-up:

- A second Air-log edge showed latest-tail refreshes could fire a forced-bottom revision while the large-batch mask was active, then return before recording a pending latest-position request.
- `forceOpenThreadToLatest` now records the pending session and suppression window before checking renderability, so the mask-clear retry can finish the open-to-latest scroll.

Twelfth follow-up:

- Cached chat opens could still blink twice because the timeline hid rows whenever `isRefreshingCachedDelta` flipped true, then hid them again if the latest-tail response tripped the large-batch mask.
- Warm cached timelines now stay visible during background latest-tail refreshes; only cold opens without renderable rows show the positioning overlay.
- Large-batch masking for preserved cached chats now counts only newly added snapshot events, so a no-op latest-tail response no longer masks the timeline just because the server returned a large tail window.

- Warm-cache chat selection now reports the normal connected state instead of `Refreshing latest chat`, because the tail refresh is background work once cached rows are already visible.

## 2026-05-29 - Trace Density And Video Preview Paging

- Compacted adjacent collapsed trace rows after timeline projection so history pages do not land inside a wall of one-card-per-run reasoning traces. Trace event IDs are still retained on the compacted row for deterministic older-history scroll targets.
- Timeline file/video artifact cards now show the first four previews by default with an explicit show-more control.
- The Mac files/videos inspector now starts video previews at four items and pages four at a time, newest first via the existing `sessionVideos` ordering.

## 2026-05-29 - Queue Reconciliation And Claude Opus 4.8

- Added Claude Opus 4.8 to both the shared fallback runtime catalog and the server runtime discovery fallback. Selecting it sends the existing Claude launch path through `--model claude-opus-4-8`.
- Mac and iOS queue actions now treat `queued turn not found` as a stale local queue row instead of a user-facing modal. The client removes the stale queued message from local state and lets websocket/history reconciliation fill in the true server state.
- Added guardrails for Opus 4.8 catalog coverage and stale queued-turn reconciliation.
- Deployed the updated server to `sonic`; `zenithbot-agent.service` is active and the deployed `agent_server.py` compiles.

## 2026-05-29 - Timeline Video Artifact Ordering

- Fixed manifest artifact events so the server includes the active `run_id` when emitting `artifact_created` and `artifact_error`.
- Mac and iOS timeline projection now also groups older nil-run manifest artifacts into the currently active run, so videos/files render after the assistant message instead of before it.
- The existing timeline artifact grid now receives the whole turn's artifacts together, restoring compact grid behavior for multi-video turns.

## 2026-05-29 - Archived Sidebar Subtitle Cleanup

- Removed the redundant `archived` subtitle suffix from chats already shown inside the Archived section on Mac and iOS.
- Added a guardrail so archive state remains section-based instead of repeated on every row.

## 2026-05-29 - Mac Timeline Overscroll Clamp

- Disabled rubber-band elasticity on the Mac timeline's underlying `NSScrollView` so the chat cannot drift into a large blank area below the last message.
- Added a defensive scroll-origin clamp before timeline scroll metrics are reported, covering any AppKit/SwiftUI pass that still produces an out-of-range document origin.
- Added guardrails for both the disabled elasticity and the clamp path.

## 2026-05-29 - Fast Chat Open Spinner Coalescing

- Kept the fast warm-cache chat opening path visually quiet by delaying the `Opening latest messages` overlay until the structural mask persists long enough to matter.
- Reset stale opening-overlay state on chat switches, so a cold-open mask and a large-batch mask cannot show as two quick spinner flashes.
- Added guardrails around the delayed overlay and warm-cache masking rules to protect the improved chat-switch speed.

## 2026-05-29 - Job Sheet Labels And Stronger Timeline Clamp

- Replaced free-sizing job sheet labels with a fixed, one-line `JobFormLabel`, preventing labels like `Mode` from wrapping vertically when the segmented controls are wide.
- Removed the Mac timeline's extra bottom padding and zeroed the underlying `NSScrollView` content/scroller insets so the chat cannot expose artificial blank space below the last message.
- Tightened the timeline clamp to run immediately on scroll attach, bounds changes, scroll-view frame changes, and document frame changes instead of waiting for the throttled metrics report.

Follow-up:

- Mac chat opens now call the bottom scroll before revealing masked timeline rows, preventing a visible top-then-bottom jump during selection.
- Removed late `0.75s` / `1.25s` SwiftUI bottom-settle passes and kept only short stabilization passes; the AppKit scroll observer remains responsible for geometry-based forced-bottom settling.

Second follow-up:

- Added a timeline-specific `NSClipView` that overrides `constrainBoundsRect` and clamps proposed scroll origins to the document bounds. This closes the remaining rubber-band/overscroll path when SwiftUI still allowed the scroll view to drift past the last message despite disabled elasticity.

Third follow-up:

- Removed the remaining symmetric timeline content padding. The timeline now keeps horizontal/top padding only, so the bottom sentinel can sit flush against the scroll view bottom instead of leaving a real 20 pt blank scrollable gutter above the composer.

## 2026-05-29 - Compact File Artifacts And Job Sheet Labels

- Timeline artifact cards now split previewable media from regular files. Images and videos keep preview tiles; plain files render as compact rows with a small icon, metadata, open action, and drag-out support.
- Replaced the Mac job sheet's grid-based form rows with fixed-label `JobFormRow` rows so labels like `Mode` and `Options` cannot squeeze vertically beside segmented controls.

## 2026-05-29 - Quiet Warm-Cache Chat Refreshes

- Warm cached Mac chat opens now preserve the visible timeline during background latest-tail and stream backfill refreshes. Cold opens can still use the large-batch positioning mask, but a chat that already has renderable cached rows should not switch from visible content back into an opening spinner.

## 2026-05-29 - Claude 1M Model Choices

- Added explicit Claude model dropdown choices for `opus[1m]` and `claude-opus-4-8[1m]` in both the shared fallback catalog and server runtime catalog.
- The server now labels those aliases as `Opus 1M` and `Opus 4.8 1M`, and still passes the selected value directly through `claude -p --model`.

## 2026-05-29 - Cross-Device Unread Cursor Authority

- Mac and iOS session refresh now adopt the server `last_read_agent_event_seq` as authoritative, including decreases from another device's manual unread state or from stale local caches.
- In-flight local read posts are still protected, so a refresh cannot briefly move the local cursor backward while this device is actively syncing a newer read cursor.

## 2026-05-29 - No Live Message Auto-Scroll

- Removed the remaining store-level live-message bottom-scroll triggers. Mac streamed event batches no longer call `requestScrollToBottom()`, and iOS streamed events no longer bump `scrollRevision`.
- Explicit navigation still scrolls: opening/selecting chats, pressing the bottom/latest button, and forced open-to-latest requests keep their existing behavior.
- Follow-up: sending a user message still requests an immediate bottom scroll, so active sends land at the composer/latest-turn area while passive agent output remains non-disruptive.

## 2026-05-29 - Build 42 TestFlight Release

- Deployed the current server to `sonic` with `./server/deploy.sh sonic`; `zenithbot-agent.service` is active and the deployed server contains the Claude Opus 4.8 / 1M runtime options.
- Confirmed the standalone `ZenithBotServer` repository matches `server/agent_server.py` and pushed `main` to GitHub at `6d41fdd`.
- Uploaded TestFlight build 42 for iOS/iPadOS and macOS from `build/archives/ZenithDockIOS-42.xcarchive` and `build/archives/ZenithDockMac-42.xcarchive`.

## 2026-05-29 - Runtime Save Race Fix

- Runtime picker changes now save immediately and optimistically update the local session, so a quick send cannot overwrite the selected Claude model back to default before the save request lands.
- Turn requests now include the current session model/effort. The server treats omitted runtime fields as "preserve current" and explicit empty strings as "reset to default."
- Follow-up: composer and mobile inline runtime menus now stage the chosen runtime synchronously before their async save task starts. This closes the click-model-then-send race where send could still read the old default runtime.

## 2026-05-29 - Folded Code Copy Uses Full Source

- Fixed folded-message code blocks on Mac and iOS so the visible clipped markdown is separate from the copy source.
- `MarkdownView` / `MobileMarkdownView` now accept full backing markdown for copy actions and match code blocks by order, so the inline code-copy button copies the complete original fenced block even while the message stays folded.
- Added guardrails to catch regressions where folded message bubbles stop passing full text into markdown/code copy actions.

## 2026-05-30 - Runtime Selection Stale Merge Fix

- Fixed the remaining Claude runtime snap-back-to-Sonnet path.
- Root cause: a quick send can trigger unrelated session responses, such as auto-title updates, while the runtime save is still in flight. Those stale session payloads could overwrite the locally staged model back to the server's old default before the turn body was built.
- Mac and iOS now keep pending runtime patches authoritative across server session merges until the server confirms the same backend/model/effort. Sends also capture the selected runtime before any auto-title/session updates.
- Follow-up: inspector/options picker drafts now preserve their in-flight runtime selection while the save spinner is active, so UI refreshes cannot visually snap the control back to Sonnet before the server reply lands.
- Follow-up: runtime saves now persist against the captured chat ID instead of `selectedSessionID`, and switching chats only clears the visible save indicator without canceling the network save. This fixes the pick Opus, switch away, switch back path.

## 2026-05-30 - Passive Timeline Scroll Stability

- Mac live agent output now publishes a passive scroll-preservation revision before rendering streamed assistant/job/error events.
- The timeline scroll observer records the prior NSScrollView visible origin and restores it after passive live layout changes, canceling any leftover forced-bottom settling from an earlier send. Explicit sends and open-latest actions still request bottom scrolling.
- Added guardrails so streamed event batches cannot reintroduce bottom-scroll requests without also preserving the live viewport.

## 2026-05-30 - Runtime Draft Sync Regression

- Fixed the chat-switch path that could reset a Claude session back to the default model. The session inspector and iOS options sheet were using `onChange` handlers on draft picker state, so loading another chat into the draft fields could look like a user backend change and autosave `model=""`.
- Runtime pickers now use explicit user-action bindings. Programmatic `syncDrafts()` updates no longer fire autosaves, while real picker changes still save immediately.
- Pending runtime patches now reconcile against confirmed server session payloads and expire after a short timeout, so stale local runtime state cannot mask server truth indefinitely.
- Added guardrails for the user-action binding requirement and pending-runtime reconciliation.

## 2026-05-31 - Build 43 TestFlight Prep

- Bumped the shared Xcode `CURRENT_PROJECT_VERSION` from `42` to `43` for the iOS/iPadOS and macOS TestFlight upload containing the runtime draft-sync regression fix.
- Uploaded TestFlight build `43` for both platforms:
  - `build/archives/ZenithDockIOS-43.xcarchive` -> `Uploaded ZenithDockIOS`
  - `build/archives/ZenithDockMac-43.xcarchive` -> `Uploaded ZenithDockMac`

## 2026-05-31 - Chat Switch Warm Cache Optimization

- Profiling logs showed memory-cache chat switches restoring up to `1,440` events and rebuilding timeline projections for all of them even though the UI initially renders only the last `100` rows.
- Memory-cache switches now render a `480` event warm tail while the full disk cache still retains the expanded local window. This preserves a three-page recent context without making every chat switch pay for older pages.
- Cached latest-tail refreshes now skip timeline rebuilding when the server response contains no new visible events, and no longer send a second bottom-scroll request for no-op refreshes.
- Rebuilt `/Users/zen/agi/ZenithDock/dist/ZenithDock.app` and synced the app bundle to `zens-macbook-air:/Users/zen/agi/ZenithDock.app`.

## 2026-05-31 - Arbitrary Agent HTTP Transport

- Build 43 still shipped narrow ATS exception domains for a few lab/Tailscale IPs, which meant a friend's iOS device could hit `-1022` when the agent URL moved to a different HTTP host.
- Replaced the per-IP ATS whitelist with a simple `NSAllowsArbitraryLoads` policy for both iOS/iPadOS and macOS TestFlight builds. ZenithDock is a user-configured private agent client; the bearer token and reachable private network are the security boundary, not a baked-in IP list.
- Polished the Local Network usage prompt and updated the `-1022` error copy so it no longer tells users to install a build with a hard-coded ATS exception.
- Added `ZenithGuardrails` coverage that fails if `NSExceptionDomains`, `NSAllowsLocalNetworking`, or lab/Tailscale IP literals come back in either app plist.

## 2026-05-31 - Build 44 TestFlight Prep

- Bumped the shared Xcode `CURRENT_PROJECT_VERSION` from `43` to `44` for the iOS/iPadOS and macOS TestFlight upload containing the arbitrary agent HTTP transport fix and warm chat-switch cache optimization.
- Uploaded macOS TestFlight build `44` from `build/archives/ZenithDockMac-44.xcarchive` -> `Uploaded ZenithDockMac`.

## 2026-05-31 - iOS Chat Open Fly-By Fix

- iOS chat opening was reusing the animated bottom-scroll helper, so a newly loaded timeline could visibly scroll through history before landing at the newest message.
- Changed iOS bottom positioning to default to a non-animated transaction. The explicit bottom button still animates, but chat selection/history snapshot application now jumps directly to the latest row.
- Removed the extra `scrollRevision` emitted after `MobileAppStore.select` loads a chat snapshot; send still emits its scroll revision, while opening a chat relies on the timeline's pending-open settle path.
- Added `ZenithGuardrails` checks so iOS chat opens cannot accidentally reintroduce send-style animated scroll revisions or animated default bottom positioning.

## 2026-05-31 - Mac Chat Tail Window Reduction

- Mac chat selection was still pulling and rendering `480` recent events on warm switches, while memory/disk cache retained `1,440` events and disk cache preserved up to `12,000` characters per text field.
- Cut the Mac latest-tail fetch and warm-cache render window to `240` events, retained cache to `720` events, and per-field disk-cache string cap to `6,000` characters.
- Older-history paging remains explicit through `Load Older`/scroll-top behavior, so switching chats should favor fast recent context while long history is still available on demand.

## 2026-05-31 - Build 45 TestFlight Prep

- Bumped shared Xcode `CURRENT_PROJECT_VERSION` from `44` to `45` for iOS/iPadOS and macOS TestFlight.
- Build `45` includes the iOS chat-open fly-by fix and the smaller Mac chat-switch tail/cache windows.
- Uploaded TestFlight build `45` for both platforms:
  - `build/archives/ZenithDockIOS-45.xcarchive` -> `Uploaded ZenithDockIOS`
  - `build/archives/ZenithDockMac-45.xcarchive` -> `Uploaded ZenithDockMac`
- The first iOS archive attempt hit Xcode/CoreSimulator `AssetCatalogSimulatorAgent` / `MPSCore` policy noise; retrying with isolated DerivedData at `/private/tmp/ZenithDockArchiveDD45` succeeded.

## 2026-06-03 - Visible History Paging Contract

- Investigated `CMA-ES - Gripper - Rewrite` missing large chunks on one Mac and found the newest server page could contain only `raw_event` records. The UI filters those out but still advanced its latest-seen cursor, so visible assistant/artifact messages just before the raw tail could be skipped.
- Bumped the agent API contract to v4 and added `visible=true` session-history paging. The server now pages by displayable timeline events and reports visible omitted counts instead of raw sequence gaps.
- Updated macOS and iOS/iPadOS session open and older-history fetches to request visible pages. iOS also now skips invisible-only older pages the same way the Mac path already did.
- Added `ZenithGuardrails` checks so future history fetches cannot regress to raw-event tail windows.

## 2026-06-03 - Mac Timeline Scroll Smoothing

- The v4 visible-history fix correctly returns real timeline events instead of raw trace noise, but that also made the Mac timeline render more heavy rows at once on long chats.
- Reduced the default Mac rendered row window from `100` to `80`, the page reveal size from `40` to `32`, and the hidden event projection budget from `480` to `360`.
- Cached collapsed trace summaries, including expensive code-change extraction, so SwiftUI scroll/layout passes do not repeatedly parse tool output for every visible trace row.
- Added `ZenithGuardrails` coverage for the smaller render window and trace-summary cache.

## 2026-06-03 - Composer Draft Debounce And Scroll Budget

- The native Mac composer was still copying the full text buffer into draft
  persistence on every keystroke. This was cheap for short prompts but painful
  for long command blocks.
- Changed the `NSTextView` bridge to debounce full-draft persistence and flush
  immediately only on send or when switching chats.
- Changed Mac draft persistence so the store does not copy the entire draft
  dictionary when scheduling every debounce save.
- Trimmed the default Mac timeline render window again, from `80` rows to `64`
  rows, and reduced the projection budget to make normal scrolling lighter.
- The job scheduler sheet now reads the selected chat draft from the per-session
  draft store instead of the old published composer prompt.
- Added guardrails so full draft text cannot accidentally get pushed through
  SwiftUI/global store on every key again.

## 2026-06-03 - Authoritative Queue State And Switch Churn Fix

- Found a real queue bug: after server restart, rebuilt pending queues were
  reconstructed from event history but not scheduled to drain, so an idle chat
  could keep queued turns forever.
- The server now exposes authoritative `queued_turns` on session responses and
  schedules rebuilt queues during startup; startup logs include `queue_drains`.
- The Mac queue shelf now renders from server queue state instead of scanning the
  loaded timeline window. Event inference remains only as an older-server
  fallback.
- Cached-fresh chat selection now still fetches once when queue state is unknown,
  preventing zombie queued rows from old cached `turn_queued` events.
- Queue action buttons now operate by `queued_id` directly and update compact
  local queue state, so stale event-window logic cannot block Send Now/remove.
- Reduced chat-switch churn by avoiding redundant published resets and by
  skipping timeline rebuilds for hidden queue metadata events.
- Verified with `python3 -m py_compile server/agent_server.py`,
  `swift run ZenithGuardrails`, and a local macOS build. The rebuilt app was
  synced to `zens-macbook-air:/Users/zen/agi/ZenithDock.app`, and the active
  `sonic` server was deployed/restarted.

## 2026-06-03 - Bottom Scroll Performance Pass

- Sampled the running Mac app during sluggish scrolling and found the main
  thread in SwiftUI/AppKit layout while app symbols repeatedly recomputed
  selected-chat media lists (`sessionVideos`, `mergedFiles`, and sort work).
- Changed the Mac store so `sessionVideos` is a cached published list rebuilt
  only when selected-chat files/video metadata changes, not during ordinary
  SwiftUI body updates.
- Removed redundant latest-first sorting from the Files & Videos inspector; the
  store already maintains the selected media lists in newest-first order.
- Reduced bottom-scroll observer churn by avoiding per-bounds-change manual
  clamping, throttling metric reports, shortening force-bottom chase time, and
  removing forced layout from the repeated bottom-scroll path.
- Added guardrails to keep media merge/sort work out of render-time scroll paths
  and to prevent reintroducing forced layout in bottom-scroll retries.
- Verified with `swift run ZenithGuardrails` and a local macOS build. The
  rebuilt app was synced to `zens-macbook-air:/Users/zen/agi/ZenithDock.app`.

## 2026-06-03 - Recover Stale Manifest Artifacts

- Debugged a Claude turn that rendered a valid MP4 but showed no Dock
  attachment. The agent wrote the artifact manifest to an older run manifest
  path from resumed context instead of the current run's canonical manifest
  path, so the server watcher never consumed it.
- Registered the stranded manifest with the server collector, producing
  `artifact_created` for `chunk3_forcegate5x_3x3.mp4`.
- Added turn-end recovery for recent leftover manifests in the same session.
  The sweep is bounded to six-hour-old manifests so old abandoned manifests do
  not get resurrected during unrelated turns.
- Added guardrails requiring both Claude and Codex runs to sweep recent
  leftover manifests after collecting the primary manifest.
