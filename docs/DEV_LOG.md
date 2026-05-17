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
