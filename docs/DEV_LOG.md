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
