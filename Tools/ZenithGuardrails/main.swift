import Foundation
import ZenithCore

enum GuardrailFailure: Error, CustomStringConvertible {
    case failed(String)

    var description: String {
        switch self {
        case .failed(let message): message
        }
    }
}

func assert(_ condition: @autoclosure () -> Bool, _ message: String) throws {
    guard condition() else { throw GuardrailFailure.failed(message) }
}

func checkTextPresenceGateBehavior() throws {
    var gate = ZTextPresenceGate()

    try assert(gate.shouldPublish(""), "initial empty state should publish")
    try assert(!gate.shouldPublish(""), "repeated empty state must not publish")
    try assert(gate.shouldPublish("h"), "first non-empty character should publish")
    try assert(!gate.shouldPublish("he"), "continued typing must not publish")
    try assert(!gate.shouldPublish("hello"), "continued typing must not publish")
    try assert(gate.shouldPublish(""), "transition back to empty should publish")
    try assert(!gate.shouldPublish(""), "repeated empty state must not publish")

    gate.reset()
    try assert(gate.shouldPublish("reset"), "reset should allow initial state to publish again")
    try assert(!gate.shouldPublish("reset again"), "post-reset continued typing must not publish")
}

func checkComposerUsesPresenceGate() throws {
    let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
    let composerURL = cwd.appendingPathComponent("Sources/ZenithDock/Views/ComposerView.swift")
    let source = try String(contentsOf: composerURL, encoding: .utf8)

    try assert(source.contains("private var presenceGate = ZTextPresenceGate()"), "Composer coordinator must keep a ZTextPresenceGate")
    guard let guardRange = source.range(of: "guard presenceGate.shouldPublish(hasText: hasText) else { return }"),
          let callbackRange = source.range(of: "parent.onTextPresenceChange(hasText)") else {
        throw GuardrailFailure.failed("Composer publishPresence must gate SwiftUI callbacks")
    }
    try assert(guardRange.lowerBound < callbackRange.lowerBound, "Composer must gate text presence before calling SwiftUI")
    try assert(source.contains("private var promptHeight: CGFloat {\n        78\n    }"), "Mac composer must use a fixed editor height instead of resizing while typing")
    try assert(!source.contains("let sendableText = value.trimmingCharacters"), "Composer must not trim the whole draft on every keystroke")
    try assert(!source.contains("hasSendableText(value)"), "Composer must not scan the whole draft for sendable text on every keystroke")
    try assert(!source.contains("value.split(separator: \"\\n\""), "Composer must not split the whole draft on every line-count update")
    try assert(!source.contains("scheduleVisibleLineCount"), "Composer must not schedule line-count work while typing")
    try assert(!source.contains("onVisibleLineCountChange"), "Composer must not publish line-count changes into SwiftUI while typing")
    try assert(!source.contains("pendingLineCount"), "Composer must not keep deferred line-count tasks")
    try assert(source.contains("submitRevision"), "Composer send button must submit native text without syncing draft text per keystroke")
    try assert(!source.contains("scheduleSync"), "Composer must not schedule recurring full-draft SwiftUI sync while typing")
    try assert(!source.contains("parent.text ="), "Composer must not publish the full draft binding during normal typing")
    try assert(source.contains("allowsNonContiguousLayout = true"), "Composer text view should allow non-contiguous layout for long drafts")
}

func checkEndpointCacheKeysAreServerScoped() throws {
    let sessionID = "sess_same_after_copy"
    let fallback = "http://127.0.0.1:7850"
    let first = ZEndpointCache.key(serverURL: "http://100.88.206.6:7850", sessionID: sessionID, default: fallback)
    let second = ZEndpointCache.key(serverURL: "100.73.184.23:7850/api/health", sessionID: sessionID, default: fallback)

    try assert(first != second, "cloned servers with the same session ID must not share chat cache keys")
    try assert(first.hasSuffix("|\(sessionID)"), "cache key should preserve session ID suffix")
    try assert(second == "http___100_73_184_23_7850|\(sessionID)", "cache key should normalize host and strip health path")
}

func checkRuntimeDefaultLabels() throws {
    let catalog = ZRuntimeCatalogSnapshot(backends: [
        "codex": ZRuntimeBackendCatalog(
            models: [ZRuntimeOption(value: "gpt-5.5", label: "GPT-5.5")],
            efforts: [ZRuntimeOption(value: "xhigh", label: "XHigh")],
            default_model: "gpt-5.5",
            default_effort: "xhigh"
        )
    ])
    let sessionData = Data(#"{"id":"sess","title":"Chat","backend":"codex"}"#.utf8)
    let session = try JSONDecoder().decode(ZSession.self, from: sessionData)

    try assert(catalog.modelLabel(nil, backend: "codex") == "GPT-5.5", "model default label should show resolved model without server-default wording")
    try assert(catalog.effortLabel(nil, backend: "codex") == "XHigh", "effort default label should show resolved effort without server-default wording")
    try assert(catalog.compactSummary(for: session) == "Codex · GPT-5.5 · XHigh", "runtime summary should include resolved defaults without server-default wording")

    let fallbackCatalog = ZRuntimeCatalogSnapshot.fallback
    try assert(fallbackCatalog.models(for: "codex").contains { $0.value == "gpt-5.5" }, "Codex fallback catalog must include GPT-5.5 while server discovery is unavailable")
    try assert(fallbackCatalog.efforts(for: "codex").contains { $0.value == "xhigh" }, "Codex fallback catalog must include XHigh effort while server discovery is unavailable")
}

func checkBackendLocksAfterProviderStart() throws {
    let activeSessionData = Data(#"{"id":"sess","title":"Chat","backend":"codex","codex_thread_id":"019e"}"#.utf8)
    let activeSession = try JSONDecoder().decode(ZSession.self, from: activeSessionData)
    let emptySessionData = Data(#"{"id":"new","title":"Chat","backend":"codex"}"#.utf8)
    let emptySession = try JSONDecoder().decode(ZSession.self, from: emptySessionData)
    let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
    let server = try String(contentsOf: cwd.appendingPathComponent("server/agent_server.py"), encoding: .utf8)
    let composer = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/Views/ComposerView.swift"), encoding: .utf8)
    let inspector = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/Views/InspectorView.swift"), encoding: .utf8)
    let mobileOptions = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDockIOS/Views/MobileChatOptionsView.swift"), encoding: .utf8)
    let mobileTimeline = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDockIOS/Views/MobileTimelineView.swift"), encoding: .utf8)

    try assert(activeSession.isBackendLocked, "Provider-backed sessions must lock backend switching")
    try assert(!emptySession.isBackendLocked, "New sessions without provider IDs must allow backend selection")
    try assert(server.contains("session_backend_locked(sess)"), "Server must enforce backend lock")
    try assert(server.contains("status_code=409"), "Backend lock violation should return a conflict")
    try assert(composer.contains("if session.isBackendLocked"), "Mac composer backend picker must switch to a read-only chip after chat starts")
    try assert(!composer.contains(".disabled(session.isBackendLocked)"), "Mac composer backend chip must not dim the icon when locked")
    try assert(inspector.contains(".disabled(session.isBackendLocked)"), "Mac inspector backend picker must disable after chat starts")
    try assert(mobileOptions.contains(".disabled(session.isBackendLocked)"), "iOS options backend picker must disable after chat starts")
    try assert(mobileTimeline.contains(".disabled(session.isBackendLocked)"), "iOS timeline backend picker must disable after chat starts")
}

func checkServerURLNormalization() throws {
    let fallback = "http://127.0.0.1:7850"

    try assert(
        ZenithServerURL.normalized("100.73.184.23:7850/api/health", default: fallback) == "http://100.73.184.23:7850",
        "health endpoint paste should normalize to server root"
    )
    try assert(
        ZenithServerURL.normalized("http://100.73.184.23:7850/", default: fallback) == "http://100.73.184.23:7850",
        "trailing slash should be stripped"
    )
}

func checkShellCopyNormalization() throws {
    let input = "python train.py \\\\\n  --checkpoint_path \"$MODEL\" \\\\\n  --port 6666"
    let expected = "python train.py \\\n  --checkpoint_path \"$MODEL\" \\\n  --port 6666"
    let normalized = ZClipboardText.normalizedForCopy(input, language: "bash")

    try assert(normalized == expected, "shell copy should collapse accidental double continuations")
    try assert(
        ZClipboardText.normalizedForCopy("\\begin{tabular}\\\\", language: nil) == "\\begin{tabular}\\\\",
        "LaTeX-looking text should not be normalized as shell"
    )
}

func checkCodeBlockCopyUsesFullText() throws {
    let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
    let markdown = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/Views/Components/MarkdownView.swift"), encoding: .utf8)

    try assert(markdown.contains("private var visibleDisplayText"), "Mac code block should keep a separate visible display string")
    try assert(markdown.contains("private var copyText"), "Mac code block should keep a separate full copy string")
    try assert(markdown.contains("ZClipboardText.normalizedForCopy(text, language: language)"), "Mac code block copy must use the full backing text")
    try assert(markdown.contains("copyToPasteboard(copyText)"), "Mac code block copy button/context menu must copy the full backing text")
    try assert(markdown.contains("CodeHighlighter.highlight(visibleDisplayText"), "Mac code block rendering should still use the visible truncated display text")
}

func checkMessageFoldingThresholds() throws {
    let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
    let macEvents = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/Views/EventViews.swift"), encoding: .utf8)
    let mobileEvents = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDockIOS/Views/MobileEventViews.swift"), encoding: .utf8)

    try assert(macEvents.contains("isContextDigest ? 1_800 : 4_200"), "Mac message folding character limits should allow 1.5x more text before folding")
    try assert(macEvents.contains("isContextDigest ? 18 : 48"), "Mac message folding line limits should allow 1.5x more lines before folding")
    try assert(mobileEvents.contains("isContextDigest ? 1_350 : 1_800"), "iOS message folding character limits should allow 1.5x more text before folding")
    try assert(mobileEvents.contains("isContextDigest ? 15 : 18"), "iOS message folding line limits should allow 1.5x more lines before folding")
    try assert(macEvents.contains("@State private var fullTextExpanded"), "Mac folded messages must expand full text inline")
    try assert(mobileEvents.contains("@State private var fullTextExpanded"), "iOS folded messages must expand full text inline")
    try assert(macEvents.contains("Button(fullTextExpanded ? \"Collapse\" : \"Open full text\")"), "Mac Open full text action must toggle inline expansion")
    try assert(mobileEvents.contains("Button(fullTextExpanded ? \"Collapse\" : \"Full text\")"), "iOS Full text action must toggle inline expansion")
    try assert(!macEvents.contains("@State private var fullTextOpen"), "Mac folded messages must not open full text in a sheet")
    try assert(!mobileEvents.contains("@State private var fullTextOpen"), "iOS folded messages must not open full text in a sheet")
}

func checkArchiveSessionBehavior() throws {
    let sessionData = Data(#"{"id":"sess","title":"Archived","backend":"codex","archived":true,"sort_order":10}"#.utf8)
    let session = try JSONDecoder().decode(ZSession.self, from: sessionData)
    try assert(session.archived == true, "ZSession must decode archived session state")
    try assert(session.sort_order == 10, "ZSession must decode stable manual sidebar order")

    let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
    let macStore = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/State/AppStore.swift"), encoding: .utf8)
    let mobileStore = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDockIOS/State/MobileAppStore.swift"), encoding: .utf8)
    let macSidebar = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/Views/SidebarView.swift"), encoding: .utf8)
    let mobileSidebar = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDockIOS/Views/MobileSidebarView.swift"), encoding: .utf8)
    let macDigest = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/Views/SessionManagementSheets.swift"), encoding: .utf8)
    let mobileDigest = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDockIOS/Views/MobileChatOptionsView.swift"), encoding: .utf8)
    let server = try String(contentsOf: cwd.appendingPathComponent("server/agent_server.py"), encoding: .utf8)

    try assert(macStore.contains("sessions.filter { $0.archived != true }"), "Mac active session lists must filter archived chats")
    try assert(mobileStore.contains("sessions.filter { $0.archived != true }"), "iOS active session lists must filter archived chats")
    try assert(macStore.contains("orderedSessions("), "Mac session rows must use stable explicit ordering")
    try assert(mobileStore.contains("orderedSessions("), "iOS session rows must use stable explicit ordering")
    try assert(macStore.contains("func reorderSession("), "Mac app must expose manual session reorder")
    try assert(mobileStore.contains("func reorderSession("), "iOS app must expose manual session reorder")
    try assert(macSidebar.contains("Move Up"), "Mac sidebar must expose move-up reorder control")
    try assert(mobileSidebar.contains("Move Up"), "iOS sidebar must expose move-up reorder control")
    try assert(macDigest.contains("store.digestTargetSessions(excluding: sourceSession.id)"), "Mac digest sheet must exclude archived target chats")
    try assert(mobileDigest.contains("store.digestTargetSessions(excluding: sourceSession.id)"), "iOS digest sheet must exclude archived target chats")
    try assert(server.contains("archived: bool | None = None"), "Server session update API must accept archived state")
    try assert(server.contains("\"archived\", \"archived_at\", \"sort_order\""), "Server public sessions must expose archived state and stable order")
    try assert(server.contains("def sorted_sessions("), "Server session list must use explicit sort_order instead of updated_at recency")
    try assert(server.contains("@app.post(\"/api/sessions/{session_id}/order\")"), "Server must expose manual session reorder endpoint")
}

func checkMobileDoesNotAutoSelectFirstChat() throws {
    let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
    let mobileStore = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDockIOS/State/MobileAppStore.swift"), encoding: .utf8)

    try assert(!mobileStore.contains("selectedSessionID = sessions.first?.id"), "iOS refresh must not auto-open the first chat")
    try assert(!mobileStore.contains("if let next = sessions.first"), "iOS delete flow must not auto-open the next first chat")
    try assert(mobileStore.contains("private func clearSelection()"), "iOS store must have an explicit clear-selection path")
    try assert(mobileStore.contains("if let selectedSessionID, !sessions.contains"), "iOS refresh should only clear a stale selection")
}

func checkTimelineRevealWaitsForLatestSnapshot() throws {
    let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
    let macStore = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/State/AppStore.swift"), encoding: .utf8)
    let mobileStore = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDockIOS/State/MobileAppStore.swift"), encoding: .utf8)
    let timeline = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/Views/TimelineView.swift"), encoding: .utf8)
    let sidebar = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/Views/SidebarView.swift"), encoding: .utf8)
    let root = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/Views/RootView.swift"), encoding: .utf8)
    let mobileTimeline = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDockIOS/Views/MobileTimelineView.swift"), encoding: .utf8)

    try assert(macStore.contains("@Published var isSelectingSession = false"), "Mac store must publish session selection/loading state")
    try assert(macStore.contains("isSelectingSession = true"), "Mac session select must mark the latest snapshot as loading")
    try assert(macStore.contains("private let maxMemoryCachedChats = 32"), "Mac store must keep enough warm chats to avoid recent-chat spinner regressions")
    try assert(macStore.contains("rememberSelectedChatInMemory()"), "Mac store must snapshot the current chat before switching away")
    guard let warmCacheRange = macStore.range(of: "let warmCachedChat = memoryCachedChat(sessionID)"),
          let selectedRange = macStore.range(of: "selectedSessionID = sessionID", range: warmCacheRange.upperBound..<macStore.endIndex) else {
        throw GuardrailFailure.failed("Mac session select must prepare warm cache before publishing selectedSessionID")
    }
    try assert(warmCacheRange.lowerBound < selectedRange.lowerBound, "Mac session select must apply warm cache before publishing selectedSessionID")
    try assert(timeline.contains("hasWarmSelectedTimeline"), "Mac timeline must reveal warm selected-chat cache while the latest snapshot refreshes")
    try assert(timeline.contains("isInitialTimelineMasked = store.selectedSessionID != nil && !hasWarmSelectedTimeline"), "Mac timeline must not show the opening mask for warm selected-chat cache")
    try assert(timeline.contains("if hasWarmSelectedTimeline {"), "Mac timeline must drop the opening mask immediately when warm cache becomes available")
    try assert(timeline.contains("guard !store.isSelectingSession || hasWarmSelectedTimeline else { return }"), "Mac timeline must not keep the opening mask up when selected-chat cache is already renderable")
    try assert(sidebar.contains("List(selection: sessionSelection)"), "Mac sidebar selection must route through store.select so warm cache can apply before publishing selection")
    try assert(!sidebar.contains("List(selection: $store.selectedSessionID)"), "Mac sidebar must not publish selectedSessionID directly before warm cache is applied")
    try assert(!root.contains(".onChange(of: store.selectedSessionID)"), "Mac root must not run a second store.select after sidebar/store selection already started")
    try assert(timeline.contains(".onChange(of: store.isSelectingSession)"), "Timeline must retry reveal when the latest snapshot load finishes")
    try assert(timeline.contains("let timelineRowsSuspended = isInitialTimelineMasked && !hasWarmSelectedTimeline"), "Mac timeline should only mask when no selected-chat cache can be rendered")
    try assert(timeline.contains("timelineRowsSuspended ? [] : store.displayEvents"), "Mac timeline must structurally suspend row rendering only for cold opens")
    try assert(mobileTimeline.contains("store.isLoading && store.selectedSessionID != nil && store.displayEvents.isEmpty"), "iOS timeline must reveal cached selected-chat rows while refreshing")
    try assert(mobileTimeline.contains("timelineRowsSuspended ? [] : store.displayEvents"), "iOS timeline must structurally suspend row rendering only for cold opens")
    try assert(!macStore.contains("requestAfter"), "Mac chat open must not stream forward from cached history; it must fetch the latest tail snapshot")
    try assert(!mobileStore.contains("requestAfter"), "iOS chat open must not stream forward from cached history; it must fetch the latest tail snapshot")
    try assert(!macStore.contains("URLQueryItem(name: \"tail\", value: \"false\")"), "Mac chat open must not request a non-tail catch-up page")
    try assert(!mobileStore.contains("URLQueryItem(name: \"tail\", value: \"false\")"), "iOS chat open must not request a non-tail catch-up page")
}

func checkConnectionFailuresDoNotModal() throws {
    let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
    let macStore = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/State/AppStore.swift"), encoding: .utf8)

    try assert(macStore.contains("@Published var connectionProblemText: String?"), "Mac store must keep connection failures as inline state")
    try assert(macStore.contains("if isConnectionError(error)"), "Mac network failures must be separated from blocking alerts")
    try assert(macStore.contains("connectionProblemText = message"), "Mac connection failure should populate inline connection text")
    try assert(macStore.contains("} else {\n            return\n        }"), "Mac refresh should not keep loading sessions/jobs after health is offline")
}

func checkVideoMetadataIsNotHiddenByMixedFilePaging() throws {
    let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
    let macStore = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/State/AppStore.swift"), encoding: .utf8)
    let inspector = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/Views/InspectorView.swift"), encoding: .utf8)
    let server = try String(contentsOf: cwd.appendingPathComponent("server/agent_server.py"), encoding: .utf8)

    try assert(server.contains("content_prefix: str | None = Query(default=None)"), "Server files API must support content-type prefix filtering")
    try assert(server.contains("str(rec.get(\"content_type\") or \"\").lower().startswith(prefix)"), "Server files API must filter records before paging")
    try assert(macStore.contains("@Published var sessionVideoFiles: [ZFile] = []"), "Mac store must keep video metadata separate from mixed file pages")
    try assert(macStore.contains("URLQueryItem(name: \"content_prefix\", value: \"video/\")"), "Mac store must fetch videos independently of mixed file paging")
    try assert(inspector.contains("sortedLatestFirst(store.sessionVideos)"), "Mac files inspector must render the independent video list")
}

func checkRuntimeAutosavesAndBackendIcons() throws {
    let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
    let macTheme = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/Design/Theme.swift"), encoding: .utf8)
    let mobileTheme = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDockIOS/Design/MobileTheme.swift"), encoding: .utf8)
    let macInspector = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/Views/InspectorView.swift"), encoding: .utf8)
    let mobileOptions = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDockIOS/Views/MobileChatOptionsView.swift"), encoding: .utf8)
    let macSidebar = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/Views/SidebarView.swift"), encoding: .utf8)
    let mobileSidebar = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDockIOS/Views/MobileSidebarView.swift"), encoding: .utf8)
    let assets = cwd.appendingPathComponent("Sources/ZenithDockIOS/Resources/Assets.xcassets")

    try assert(macTheme.contains("struct BackendLogo"), "Mac theme must define backend logo views")
    try assert(mobileTheme.contains("struct MobileBackendLogo"), "iOS theme must define backend logo views")
    try assert(macTheme.contains("\"ClaudeBackendLogo\""), "Mac backend logos must use the supplied Claude asset")
    try assert(macTheme.contains("\"CodexBackendLogo\""), "Mac backend logos must use the supplied Codex asset")
    try assert(macTheme.contains("var size: CGFloat = 16"), "Mac backend logo view must own an explicit icon size")
    try assert(macTheme.contains(".clipped()"), "Mac backend logo image must be clipped to its icon frame")
    try assert(mobileTheme.contains("\"ClaudeBackendLogo\""), "iOS backend logos must use the supplied Claude asset")
    try assert(mobileTheme.contains("\"CodexBackendLogo\""), "iOS backend logos must use the supplied Codex asset")
    try assert(mobileTheme.contains("var size: CGFloat = 16"), "iOS backend logo view must own an explicit icon size")
    try assert(mobileTheme.contains(".clipped()"), "iOS backend logo image must be clipped to its icon frame")
    try assert(
        FileManager.default.fileExists(atPath: assets.appendingPathComponent("ClaudeBackendLogo.imageset/ClaudeBackendLogo.png").path),
        "Claude backend image asset must exist"
    )
    try assert(
        FileManager.default.fileExists(atPath: assets.appendingPathComponent("ClaudeBackendLogo.imageset/ClaudeBackendLogo@2x.png").path),
        "Claude backend image asset must include a 2x small rendition"
    )
    try assert(
        FileManager.default.fileExists(atPath: assets.appendingPathComponent("CodexBackendLogo.imageset/CodexBackendLogo.png").path),
        "Codex backend image asset must exist"
    )
    try assert(
        FileManager.default.fileExists(atPath: assets.appendingPathComponent("CodexBackendLogo.imageset/CodexBackendLogo@2x.png").path),
        "Codex backend image asset must include a 2x small rendition"
    )
    try assert(macSidebar.contains("SessionRowBackendIcon"), "Mac sidebar must keep provider icons in chat rows")
    try assert(mobileSidebar.contains("MobileSessionRowBackendIcon"), "iOS sidebar must keep provider icons in chat rows")
    try assert(macSidebar.contains("BackendLogo(backend: backend)"), "Mac sidebar rows must show the backend logo")
    try assert(mobileSidebar.contains("MobileBackendLogo(backend: backend)"), "iOS sidebar rows must show the backend logo")
    try assert(macSidebar.contains("badgeColor: Color?"), "Mac sidebar row status must be a single optional badge on the icon")
    try assert(mobileSidebar.contains("badgeColor: Color?"), "iOS sidebar row status must be a single optional badge on the icon")
    try assert(!macTheme.contains("\"terminal\""), "Codex must not fall back to the terminal SF Symbol")
    try assert(!mobileTheme.contains("\"terminal\""), "iOS Codex must not fall back to the terminal SF Symbol")
    try assert(!macSidebar.contains("sparkle.magnifyingglass"), "Codex sidebar icon must not be the search glyph")
    try assert(!mobileSidebar.contains("sparkle.magnifyingglass"), "iOS Codex sidebar icon must not be the search glyph")
    try assert(!macSidebar.contains("circle.hexagongrid"), "Claude sidebar icon must not be the old generic grid glyph")
    try assert(macInspector.contains("scheduleRuntimeSave()"), "Mac inspector runtime changes must autosave")
    try assert(!macInspector.contains("\"Save Runtime\""), "Mac inspector must not show a Save Runtime button")
    try assert(mobileOptions.contains("scheduleRuntimeSave()"), "iOS chat options runtime changes must autosave")
    try assert(!mobileOptions.contains("Save Runtime & Session"), "iOS options must not imply runtime requires a manual save")
}

func checkTimelineCombinesRunTraces() throws {
    let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
    let macTimeline = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/Views/TimelineView.swift"), encoding: .utf8)
    let mobileTimeline = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDockIOS/Views/MobileTimelineView.swift"), encoding: .utf8)

    try assert(macTimeline.contains("activeAssistantEvents: [ZEvent]"), "Mac timeline must collect assistant chunks per run")
    try assert(macTimeline.contains("activeTrace: [ZEvent]"), "Mac timeline must collect trace events per run")
    try assert(macTimeline.contains("trace-run-\\(activeRunID"), "Mac timeline trace rows must be run-scoped")
    try assert(macTimeline.contains("joined(separator: \"\\n\\n\")"), "Mac timeline must merge assistant chunks into one message")
    try assert(mobileTimeline.contains("activeAssistantEvents: [ZEvent]"), "iOS timeline must collect assistant chunks per run")
    try assert(mobileTimeline.contains("activeTrace: [ZEvent]"), "iOS timeline must collect trace events per run")
    try assert(mobileTimeline.contains("trace-run-\\(activeRunID"), "iOS timeline trace rows must be run-scoped")
}

func checkInlineVideoPlayAutoplays() throws {
    let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
    let inlineVideo = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/Views/Components/InlineVideoView.swift"), encoding: .utf8)

    try assert(inlineVideo.contains("@State private var autoplayOnLoad = false"), "Inline video should track autoplay intent from the placeholder")
    try assert(inlineVideo.contains("InlineVideoPlayerView(url: url, autoplay: autoplayOnLoad)"), "Inline video must pass autoplay intent to the player")
    try assert(inlineVideo.contains("playerView.player?.play()"), "Mac inline video player must start playback after the user presses Play")
    try assert(inlineVideo.contains("videoHTML(for: url, autoplay: autoplay)"), "iOS inline video web player must receive autoplay intent")
    try assert(inlineVideo.contains("video.play().catch"), "iOS inline video web player should attempt playback after loading")
}

func checkCodeReviewSurfaceIsStructured() throws {
    let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
    let review = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/Views/TraceChangeSetView.swift"), encoding: .utf8)

    try assert(review.contains("@State private var selectedFileID"), "Code review sheet must keep a selected file")
    try assert(review.contains("TraceReviewDiffPane"), "Code review sheet must render a structured diff pane")
    try assert(review.contains("TraceDiffLineView"), "Code review sheet must render per-line diff rows")
    try assert(review.contains("oldNumber"), "Code review diff rows should include old/new line numbers")
    try assert(review.contains("!path.hasPrefix(\"+\")"), "Code change extraction must reject diff body lines as fake paths")
}

func checkUnreadMessageMarker() throws {
    let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
    let core = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithCore/ZenithCore.swift"), encoding: .utf8)
    let macStore = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/State/AppStore.swift"), encoding: .utf8)
    let mobileStore = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDockIOS/State/MobileAppStore.swift"), encoding: .utf8)
    let mobileSidebar = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDockIOS/Views/MobileSidebarView.swift"), encoding: .utf8)
    let macSidebar = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/Views/SidebarView.swift"), encoding: .utf8)
    let server = try String(contentsOf: cwd.appendingPathComponent("server/agent_server.py"), encoding: .utf8)
    let timeline = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/Views/TimelineView.swift"), encoding: .utf8)

    try assert(core.contains("latest_agent_event_seq"), "Shared session model must decode latest visible agent event seq")
    try assert(server.contains("latest_agent_event_seq"), "Server public sessions must expose latest visible agent event seq")
    try assert(server.contains("\"job_ran\", \"job_error\""), "Server must treat scheduled-job output as visible agent output")
    try assert(server.contains("update_session_event_metadata(session_id, event)"), "Server must update session event metadata as events are appended")
    try assert(macStore.contains("firstUnreadAgentSeqBySessionID"), "Mac store must remember the first unread agent event seq")
    try assert(macStore.contains("selectedTimelineAtBottom"), "Mac store must track whether the selected timeline is actually at bottom")
    try assert(macStore.contains("lastReadAgentSeqBySessionID"), "Mac unread state must compare server latest seq against local last-read seq")
    try assert(macStore.contains("manuallyUnreadSessionIDs"), "Mac store must preserve manual unread marks while the selected chat is open")
    try assert(macStore.contains("markSessionUnread"), "Mac store must support manually marking a chat unread")
    try assert(macStore.contains("allowDecrease: true"), "Manual unread must be able to move the local read cursor backward")
    try assert(macStore.contains("reconcileUnreadFromSessions()"), "Mac session refresh must reconcile unread state for non-selected scheduled-job output")
    try assert(macStore.contains("selectedSessionFirstUnreadSeq"), "Mac store must expose selected chat's first unread seq")
    try assert(macStore.contains("markAgentUnread(sessionID: String, firstSeq: Int? = nil)"), "Unread marking must accept a first event seq")
    try assert(macStore.contains("case \"job_ran\""), "Scheduled job responses must count as visible agent messages")
    try assert(macStore.contains("case \"job_ran\", \"job_error\""), "Scheduled job failures must count as visible agent messages")
    try assert(macStore.contains("else if !selectedTimelineAtBottom"), "Selected-chat live agent messages must mark unread when the user is away from bottom")
    try assert(mobileStore.contains("unreadAgentSessionIDs"), "iOS must keep unread state for session rows")
    try assert(mobileStore.contains("lastReadAgentSeqBySessionID"), "iOS unread state must compare server latest seq against local last-read seq")
    try assert(mobileStore.contains("manuallyUnreadSessionIDs"), "iOS store must preserve manual unread marks while the selected chat is open")
    try assert(mobileStore.contains("markSessionUnread"), "iOS store must support manually marking a chat unread")
    try assert(mobileStore.contains("reconcileUnreadFromSessions()"), "iOS session refresh must reconcile unread state for non-selected scheduled-job output")
    try assert(macSidebar.contains("Mark as Unread"), "Mac sidebar must expose a mark-as-unread chat action")
    try assert(macSidebar.contains("Mark as Read"), "Mac sidebar must expose a mark-as-read chat action")
    try assert(mobileSidebar.contains("Mark as Unread"), "iOS sidebar must expose a mark-as-unread chat action")
    try assert(mobileSidebar.contains("Mark as Read"), "iOS sidebar must expose a mark-as-read chat action")
    try assert(mobileSidebar.contains("Unread agent message"), "iOS sidebar must show unread agent messages")
    try assert(timeline.contains("TimelineUnreadMarker"), "Mac timeline must render an inline new-message marker")
    try assert(timeline.contains("firstUnreadRowID(in: rows, unreadSeq: store.selectedSessionFirstUnreadSeq)"), "Timeline must anchor the marker to the first unread row")
    try assert(timeline.contains("(!isNearBottom || store.selectedSessionHasUnread)"), "Bottom button must still show when there are unread messages near the bottom")
    try assert(timeline.contains("metrics.distanceFromBottom <= 28"), "Read clearing must use a strict bottom threshold")
    try assert(timeline.contains("trailingReportWorkItem"), "Scroll observer must deliver a trailing scroll-position report")
    try assert(timeline.contains("store.setSelectedTimelineAtBottom(nextAtBottom)"), "Timeline must publish strict bottom state to the store")
    try assert(!timeline.contains("TimelineHistoryTopReader"), "Mac timeline must not use a SwiftUI geometry preference reader during normal scrolling")
    try assert(timeline.contains("distanceFromTop"), "Mac scroll observer must report top distance for older-history loading")
    try assert(timeline.contains("bottomBucket(lhs.distanceFromBottom) == bottomBucket(rhs.distanceFromBottom)"), "Mac scroll observer must bucket bottom distance instead of publishing every pixel")
    try assert(timeline.contains("topBucket(lhs.distanceFromTop) == topBucket(rhs.distanceFromTop)"), "Mac scroll observer must bucket top distance instead of publishing every pixel")
}

func checkTimelineHistoryPaging() throws {
    let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
    let macStore = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/State/AppStore.swift"), encoding: .utf8)
    let timeline = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/Views/TimelineView.swift"), encoding: .utf8)

    try assert(macStore.contains("private let initialSessionEventLimit = 480"), "Mac chat selection must load a three-page recent window")
    try assert(macStore.contains("private let maxCachedTimelineEvents = 1_440"), "Mac chat cache must retain more than the initial recent window")
    try assert(macStore.contains("preservedEvents = events.filter { $0.session_id == sessionID }"), "Fresh session snapshots must preserve cached pages for the same chat")
    try assert(macStore.contains("preservedBeforeSnapshot"), "Merged snapshots must reduce the older-hidden count by locally preserved events")
    try assert(timeline.contains("TimelineScrollAnchor"), "History paging must capture a stable scroll anchor")
    try assert(timeline.contains("anchorEventID"), "History paging must keep an event-id fallback for regrouped rows")
    try assert(timeline.contains("row(containingEventID: eventID, in: rows)"), "History paging must restore through the event-id fallback when row IDs change")
}

func checkLiveTimelineAutoFollow() throws {
    let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
    let macTimeline = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/Views/TimelineView.swift"), encoding: .utf8)
    let mobileTimeline = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDockIOS/Views/MobileTimelineView.swift"), encoding: .utf8)

    try assert(macTimeline.contains("shouldFollowBottomRequest"), "Mac timeline must centralize live-follow decisions")
    try assert(macTimeline.contains("shouldAutoFollowLiveEvent(after:"), "Mac timeline must auto-follow newer selected-chat events")
    try assert(macTimeline.contains("store.isRunning"), "Mac live-follow must keep active selected chats pinned to the newest stream")
    try assert(macTimeline.contains("cappedLiveVisibleRowLimit(rowCount: rowCount, oldCount: oldCount, newCount: newCount)"), "Mac live-follow must not expand the rendered window to the full chat history")
    try assert(macTimeline.contains("historyLoadSuppressedUntil = Date().addingTimeInterval(0.35)"), "Mac programmatic bottom scrolls must suppress older-history autoload")
    try assert(macTimeline.contains("store.markSelectedSessionRead(force: true)"), "Mac auto-follow must clear selected unread state intentionally")
    try assert(mobileTimeline.contains("shouldAutoFollowLiveEvent(after:"), "iOS timeline must auto-follow newer selected-chat events")
    try assert(mobileTimeline.contains("isAtBottom || store.isRunning"), "iOS live-follow must keep active selected chats pinned to the newest stream")
    try assert(mobileTimeline.contains("lastObservedEventSeq"), "iOS timeline must distinguish new streamed events from older history prepends")
    try assert(mobileTimeline.contains("cappedLiveVisibleRowLimit(rowCount: rowCount, oldCount: oldCount, newCount: newCount)"), "iOS live-follow must not expand the rendered window to the full chat history")
}

func checkQueuedRemovalDisappears() throws {
    let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
    let macStore = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/State/AppStore.swift"), encoding: .utf8)
    let mobileStore = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDockIOS/State/MobileAppStore.swift"), encoding: .utf8)

    try assert(macStore.contains("let cancelledQueuedTurnIDs"), "Mac timeline must track cancelled queued turns")
    try assert(macStore.contains("return !cancelledQueuedTurnIDs.contains(queuedID)"), "Mac timeline must hide queued turns after they are removed")
    try assert(macStore.contains("events.removeAll { $0.type == \"turn_queued\" && $0.queued_id == queuedID }"), "Mac unqueue should remove the queued row locally after server success")
    try assert(mobileStore.contains("events.removeAll { $0.type == \"turn_queued\" && $0.queued_id == queuedID }"), "iOS unqueue should remove queued rows locally after server success")
}

func checkPromptImageAttachments() throws {
    let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
    let macStore = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/State/AppStore.swift"), encoding: .utf8)
    let mobileStore = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDockIOS/State/MobileAppStore.swift"), encoding: .utf8)
    let macTimeline = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/Views/TimelineView.swift"), encoding: .utf8)
    let macEvents = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/Views/EventViews.swift"), encoding: .utf8)
    let mobileEvents = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDockIOS/Views/MobileEventViews.swift"), encoding: .utf8)
    let composer = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/Views/ComposerView.swift"), encoding: .utf8)

    try assert(macStore.contains("func promptFiles(for event: ZEvent)"), "Mac store must resolve turn file_ids into prompt attachments")
    try assert(mobileStore.contains("func promptFiles(for event: ZEvent)"), "iOS store must resolve turn file_ids into prompt attachments")
    try assert(macTimeline.contains("MessageAttachment(file: $0, url: store.fileURL($0))"), "Mac timeline must pass prompt attachments into user bubbles")
    try assert(macEvents.contains("MessageAttachmentStrip"), "Mac user bubbles must render prompt attachments")
    try assert(macEvents.contains("attachment.file.content_type?.hasPrefix(\"image/\") == true"), "Mac prompt attachments must render image thumbnails")
    try assert(mobileEvents.contains("MobileMessageAttachmentStrip"), "iOS user bubbles must render prompt attachments")
    try assert(mobileEvents.contains("attachment.file.content_type?.hasPrefix(\"image/\") == true"), "iOS prompt attachments must render image thumbnails")
    try assert(composer.contains("override func paste"), "Mac composer must intercept pasteboard images")
    try assert(composer.contains("NSImage(pasteboard: pasteboard)"), "Mac composer must read raw image data from the pasteboard")
    try assert(composer.contains("ZenithDockPasteboardImages"), "Mac composer must persist pasted images before upload")
}

func checkTmuxSubmitterVisualizer() throws {
    let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
    let core = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithCore/ZenithCore.swift"), encoding: .utf8)
    let macStore = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/State/AppStore.swift"), encoding: .utf8)
    let inspector = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/Views/InspectorView.swift"), encoding: .utf8)
    let server = try String(contentsOf: cwd.appendingPathComponent("server/agent_server.py"), encoding: .utf8)

    try assert(core.contains("struct ZTmuxPane"), "Core must model tmux pane rows")
    try assert(core.contains("struct ZTmuxCapture"), "Core must model captured tmux pane output")
    try assert(server.contains("@app.get(\"/api/sessions/{session_id}/tmux\")"), "Server must expose a tmux pane listing endpoint")
    try assert(server.contains("@app.get(\"/api/sessions/{session_id}/tmux/capture\")"), "Server must expose a tmux pane capture endpoint")
    try assert(server.contains("TMUX_SUBMITTER_KEYWORDS"), "Server tmux listing must identify likely submitter panes")
    try assert(server.contains("meaningful_chat_cwd"), "Server tmux listing must ignore broad home/default cwd matches")
    try assert(server.contains("TMUX_CHAT_MATCH_LABELS"), "Server tmux listing must distinguish chat-linked panes from machine-wide panes")
    try assert(server.contains("TMUX_CHAT_MATCH_LABELS = {\"chat tmux\", \"chat target\"}"), "Default tmux listing must not treat shared cwd as a chat link")
    try assert(server.contains("tmux_explicit_chat_targets"), "Server tmux listing must derive default matches from explicit tmux targets")
    try assert(!server.contains("TMUX_CONTEXT_TOKEN_RE"), "Default tmux listing must not mine broad chat text tokens")
    try assert(server.contains("if not include_all and not chat_linked"), "Default tmux listing must not include unrelated submitters")
    try assert(macStore.contains("refreshSelectedTmuxPanes"), "Mac store must load tmux panes on demand")
    try assert(macStore.contains("captureTmuxPane"), "Mac store must capture tmux pane output on demand")
    try assert(inspector.contains("TmuxSubmitterInspector"), "Mac inspector must render the tmux submitter visualizer")
    try assert(inspector.contains("Inspect Tmux Submitters"), "Mac inspector must keep tmux inspection explicit/on demand")
    try assert(inspector.contains("not just panes linked to this chat"), "Mac tmux inspector must label the All toggle as machine-wide")
}

func checkExportCompliancePlists() throws {
    let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
    let iosPlist = try String(contentsOf: cwd.appendingPathComponent("Apps/ZenithDockIOS/Info.plist"), encoding: .utf8)
    let macPlist = try String(contentsOf: cwd.appendingPathComponent("Apps/ZenithDockMac/Info.plist"), encoding: .utf8)
    let key = "<key>ITSAppUsesNonExemptEncryption</key>"
    let value = "<false/>"

    try assert(iosPlist.contains(key), "iOS Info.plist must declare TestFlight encryption compliance")
    try assert(iosPlist.contains(value), "iOS Info.plist must mark non-exempt encryption as false")
    try assert(macPlist.contains(key), "macOS Info.plist must declare TestFlight encryption compliance")
    try assert(macPlist.contains(value), "macOS Info.plist must mark non-exempt encryption as false")
}

do {
    try checkTextPresenceGateBehavior()
    try checkComposerUsesPresenceGate()
    try checkEndpointCacheKeysAreServerScoped()
    try checkRuntimeDefaultLabels()
    try checkBackendLocksAfterProviderStart()
    try checkServerURLNormalization()
    try checkShellCopyNormalization()
    try checkCodeBlockCopyUsesFullText()
    try checkMessageFoldingThresholds()
    try checkArchiveSessionBehavior()
    try checkMobileDoesNotAutoSelectFirstChat()
    try checkTimelineRevealWaitsForLatestSnapshot()
    try checkConnectionFailuresDoNotModal()
    try checkVideoMetadataIsNotHiddenByMixedFilePaging()
    try checkRuntimeAutosavesAndBackendIcons()
    try checkTimelineCombinesRunTraces()
    try checkInlineVideoPlayAutoplays()
    try checkCodeReviewSurfaceIsStructured()
    try checkUnreadMessageMarker()
    try checkTimelineHistoryPaging()
    try checkLiveTimelineAutoFollow()
    try checkQueuedRemovalDisappears()
    try checkPromptImageAttachments()
    try checkTmuxSubmitterVisualizer()
    try checkExportCompliancePlists()
    print("ZenithGuardrails passed")
} catch {
    fputs("ZenithGuardrails failed: \(error)\n", stderr)
    exit(1)
}
