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
    try assert(source.contains("private var promptHeight: CGFloat {\n        store.pendingQueuedEvents.isEmpty ? 58 : 44\n    }"), "Mac composer must use fixed editor heights instead of resizing while typing")
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
    let identity = ZEndpointCache.namespace(serverIdentity: "abc123")

    try assert(first != second, "cloned servers with the same session ID must not share chat cache keys")
    try assert(first.hasSuffix("|\(sessionID)"), "cache key should preserve session ID suffix")
    try assert(second == "http___100_73_184_23_7850|\(sessionID)", "cache key should normalize host and strip health path")
    try assert(identity == "server_abc123", "server identity namespaces must be stable and URL independent")

    let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
    let server = try String(contentsOf: cwd.appendingPathComponent("server/agent_server.py"), encoding: .utf8)
    let macStore = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/State/AppStore.swift"), encoding: .utf8)
    let mobileStore = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDockIOS/State/MobileAppStore.swift"), encoding: .utf8)
    try assert(server.contains("\"server_identity\": server_identity()"), "Health endpoint must expose a stable opaque server identity")
    try assert(macStore.contains("adoptServerIdentity(res.server_identity)"), "Mac app must adopt server identity from health")
    try assert(macStore.contains("migrateLocalServerState(from: oldNamespace, to: newNamespace)"), "Mac app must migrate URL-scoped local state to server-identity scoped state")
    try assert(mobileStore.contains("adoptServerIdentity(res.server_identity)"), "iOS app must adopt server identity from health")
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
    try assert(fallbackCatalog.models(for: "claude").contains { $0.value == "claude-opus-4-8" && $0.label == "Opus 4.8" }, "Claude fallback catalog must include Opus 4.8")

    let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
    let server = try String(contentsOf: cwd.appendingPathComponent("server/agent_server.py"), encoding: .utf8)
    try assert(server.contains("runtime_option(\"claude-opus-4-8\", \"Opus 4.8\")"), "Server runtime catalog must advertise Claude Opus 4.8")
    try assert(server.contains("cmd.extend([\"--model\", str(sess[\"model\"])])"), "Claude launcher must pass selected models with --model")
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
    let macMarkdown = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/Views/Components/MarkdownView.swift"), encoding: .utf8)
    let mobileEvents = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDockIOS/Views/MobileEventViews.swift"), encoding: .utf8)

    try assert(macEvents.contains("isContextDigest ? 1_800 : 4_200"), "Mac message folding character limits should allow 1.5x more text before folding")
    try assert(macEvents.contains("isContextDigest ? 18 : 48"), "Mac message folding line limits should allow 1.5x more lines before folding")
    try assert(mobileEvents.contains("isContextDigest ? 1_350 : 1_800"), "iOS message folding character limits should allow 1.5x more text before folding")
    try assert(mobileEvents.contains("isContextDigest ? 15 : 18"), "iOS message folding line limits should allow 1.5x more lines before folding")
    try assert(macEvents.contains("@State private var fullTextExpanded"), "Mac folded messages must expand full text inline")
    try assert(mobileEvents.contains("@State private var fullTextExpanded"), "iOS folded messages must expand full text inline")
    try assert(macEvents.contains("Button(fullTextExpanded ? \"Collapse\" : \"Open full text\")"), "Mac Open full text action must toggle inline expansion")
    try assert(mobileEvents.contains("Button(fullTextExpanded ? \"Collapse\" : \"Full text\")"), "iOS Full text action must toggle inline expansion")
    try assert(macEvents.contains("allowTruncation: !fullTextExpanded"), "Mac expanded messages must bypass MarkdownView UI truncation")
    try assert(macMarkdown.contains("var allowTruncation = true"), "Mac MarkdownView must expose an explicit truncation toggle")
    try assert(macMarkdown.contains("guard allowTruncation else { return text }"), "Mac MarkdownView must render complete expanded text without the trim marker")
    try assert(!macEvents.contains("@State private var fullTextOpen"), "Mac folded messages must not open full text in a sheet")
    try assert(!mobileEvents.contains("@State private var fullTextOpen"), "iOS folded messages must not open full text in a sheet")
}

func checkTimelineMessageTimestamps() throws {
    let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
    let macEvents = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/Views/EventViews.swift"), encoding: .utf8)
    let mobileEvents = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDockIOS/Views/MobileEventViews.swift"), encoding: .utf8)

    try assert(macEvents.contains("lhs.event.ts == rhs.event.ts"), "Mac event card equality must include timestamp updates")
    try assert(macEvents.contains("private var messageTimestamp: String?"), "Mac event cards must derive a message timestamp")
    try assert(macEvents.contains("localTimestampString(event.ts)"), "Mac event timestamps must use local time formatting")
    try assert(macEvents.contains("var timestamp: String?"), "Mac message bubbles must accept a timestamp")
    try assert(macEvents.contains("Text(timestamp)\n                        .font(.caption.monospacedDigit())"), "Mac message bubbles must render timestamps in the header")
    try assert(macEvents.contains("localTimestampString(jobRun.finishedAt ?? jobRun.lastEventAt ?? jobRun.runEvent.ts)"), "Mac job run bubbles must show the latest update time")
    try assert(mobileEvents.contains("private var messageTimestamp: String?"), "iOS event cards must derive a message timestamp")
    try assert(mobileEvents.contains("mobileMessageTimestampString(event.ts)"), "iOS event timestamps must use local time formatting")
    try assert(mobileEvents.contains("var timestamp: String?"), "iOS message bubbles must accept a timestamp")
    try assert(mobileEvents.contains("MobileSystemCard(\n                icon: \"clock.badge.checkmark\""), "iOS job system cards must pass timestamps through")
    try assert(mobileEvents.contains("mobileMessageTimestampString(jobRun.finishedAt ?? jobRun.lastEventAt ?? jobRun.runEvent.ts)"), "iOS job run bubbles must show the latest update time")
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
    try assert(macSidebar.contains("@State private var reorderMode"), "Mac sidebar must expose explicit reorder mode")
    try assert(mobileSidebar.contains("@State private var reorderMode"), "iOS sidebar must expose explicit reorder mode")
    try assert(macSidebar.contains("guard !reorderMode else { return }"), "Mac sidebar must suppress chat selection while reordering")
    try assert(macSidebar.contains(".onDrag"), "Mac sidebar reorder mode must make chats and folders draggable")
    try assert(macSidebar.contains(".onDrop"), "Mac sidebar reorder mode must expose drop targets")
    try assert(macSidebar.contains("handleSessionDrop"), "Mac sidebar must reorder chats by drag/drop in reorder mode")
    try assert(macSidebar.contains("handleFolderDrop"), "Mac sidebar must reorder folders by drag/drop in reorder mode")
    try assert(macSidebar.contains("SidebarInsertionRule"), "Mac sidebar drag reorder must show an insertion indicator")
    try assert(macSidebar.contains("SidebarDropPlacement"), "Mac sidebar drag reorder must distinguish before/after placement")
    try assert(macSidebar.contains("sidebarDragPayload"), "Mac sidebar drag reorder must track the active drag payload")
    try assert(macSidebar.contains("clearSidebarDragState"), "Mac sidebar drag reorder must explicitly clear drag state")
    try assert(macSidebar.contains("guard let sidebarDragPayload else { return false }"), "Mac sidebar insertion indicators must be gated by active drag state")
    try assert(mobileSidebar.contains(".onMove"), "iOS sidebar must support drag reorder")
    try assert(macDigest.contains("store.digestTargetSessions(excluding: sourceSession.id)"), "Mac digest sheet must exclude archived target chats")
    try assert(mobileDigest.contains("store.digestTargetSessions(excluding: sourceSession.id)"), "iOS digest sheet must exclude archived target chats")
    try assert(server.contains("archived: bool | None = None"), "Server session update API must accept archived state")
    try assert(server.contains("\"archived\", \"archived_at\", \"sort_order\""), "Server public sessions must expose archived state and stable order")
    try assert(server.contains("def sorted_sessions("), "Server session list must use explicit sort_order instead of updated_at recency")
    try assert(server.contains("@app.post(\"/api/sessions/{session_id}/order\")"), "Server must expose manual session reorder endpoint")
}

func checkFolderSectionControls() throws {
    let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
    let macStore = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/State/AppStore.swift"), encoding: .utf8)
    let mobileStore = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDockIOS/State/MobileAppStore.swift"), encoding: .utf8)
    let macSidebar = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/Views/SidebarView.swift"), encoding: .utf8)
    let mobileSidebar = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDockIOS/Views/MobileSidebarView.swift"), encoding: .utf8)

    try assert(macStore.contains("folderOrder"), "Mac store must persist manual folder order")
    try assert(macStore.contains("collapsedFolders"), "Mac store must persist collapsed folder state")
    try assert(macStore.contains("archivedSectionCollapsed"), "Mac store must persist archived section collapse state")
    try assert(macStore.contains("func moveFolder("), "Mac store must expose folder move controls")
    try assert(macStore.contains("func reorderFolders("), "Mac store must expose drag folder reorder")
    try assert(macStore.contains("func toggleFolderCollapsed"), "Mac store must expose folder collapse controls")
    try assert(macStore.contains("func toggleArchivedSectionCollapsed"), "Mac store must expose archived section collapse controls")
    try assert(mobileStore.contains("folderOrder"), "iOS store must persist manual folder order")
    try assert(mobileStore.contains("collapsedFolders"), "iOS store must persist collapsed folder state")
    try assert(mobileStore.contains("archivedSectionCollapsed"), "iOS store must persist archived section collapse state")
    try assert(mobileStore.contains("func moveFolder("), "iOS store must expose folder move controls")
    try assert(mobileStore.contains("func reorderFolders("), "iOS store must expose drag folder reorder")
    try assert(mobileStore.contains("func toggleArchivedSectionCollapsed"), "iOS store must expose archived section collapse controls")
    try assert(macSidebar.contains("FolderSectionHeader"), "Mac sidebar must render custom folder section headers")
    try assert(macSidebar.contains("ArchivedSectionHeader"), "Mac sidebar must render a collapsible archived section header")
    try assert(macSidebar.contains("Label(reorderMode ? \"Done\" : \"Reorder\""), "Mac sidebar must expose a reorder toggle")
    try assert(macSidebar.contains("Collapse Folder"), "Mac folder header must expose collapse")
    try assert(mobileSidebar.contains("MobileFolderSectionHeader"), "iOS sidebar must render custom folder section headers")
    try assert(mobileSidebar.contains("MobileArchivedSectionHeader"), "iOS sidebar must render a collapsible archived section header")
    try assert(mobileSidebar.contains("Button(reorderMode ? \"Done\" : \"Reorder\")"), "iOS sidebar must expose a reorder toggle")
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
    try assert(macStore.contains("@Published var isRefreshingCachedDelta = false"), "Mac store must publish warm-cache delta refresh state")
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
    try assert(timeline.contains("settleBottomAfterLayout(proxy, sessionID: store.selectedSessionID)"), "Timeline thread switches must settle bottom position after SwiftUI lays out new rows")
    try assert(timeline.contains("guard store.selectedSessionID == sessionID else { return }"), "Delayed timeline bottom settles must be scoped to the selected session")
    try assert(timeline.contains("@State private var pendingOpenBottomSessionID"), "Mac timeline must remember that newly opened chats should land at the latest message")
    try assert(timeline.contains("pendingOpenBottomSessionID = store.selectedSessionID"), "Mac timeline must arm latest-message positioning on thread open")
    try assert(timeline.contains("private func settleOpenThreadAtLatest"), "Mac timeline must centralize newly opened thread latest-position settling")
    try assert(timeline.contains("pendingOpenBottomSessionID = nil\n        suppressHistoryLoading(for: 2.4)"), "Mac timeline must consume the open-position request once rows are actually renderable")
    try assert(macStore.contains("@Published var forcedScrollToBottomRevision"), "Mac store must separate forced open/reopen bottom scrolls from ordinary live scroll requests")
    try assert(timeline.contains(".onChange(of: store.forcedScrollToBottomRevision)"), "Mac timeline must always honor forced open/reopen bottom scroll requests")
    try assert(timeline.contains("private func forceOpenThreadToLatest"), "Mac timeline must force open/reopen positioning independent of near-bottom state")
    try assert(timeline.contains("pendingOpenBottomSessionID = sessionID\n        suppressHistoryLoading(for: 2.4)\n        disarmAutomaticOlderHistoryLoad()\n        visibleRowLimit = defaultVisibleRowLimit\n        guard canSettleOpenThreadRows else"), "Forced latest-position requests must stay pending while large timeline batches are masked")
    try assert(timeline.contains("forceBottomRevision: store.forcedScrollToBottomRevision"), "Mac timeline must pass forced open/reopen bottom requests into the NSScrollView observer")
    try assert(timeline.contains("clipView.scroll(to: target)"), "Forced open/reopen bottom positioning must use the underlying NSScrollView document geometry")
    try assert(timeline.contains("forceBottomUntil = Date().addingTimeInterval"), "Forced open/reopen bottom positioning must persist only during layout settling")
    try assert(timeline.contains("let timelineRowsSuspended = isInitialTimelineMasked && !hasWarmSelectedTimeline"), "Mac timeline should structurally suspend cold opens when no selected-chat cache can be rendered")
    try assert(macStore.contains("@Published var isApplyingLargeTimelineBatch = false"), "Mac store must publish a large-batch timeline mask")
    try assert(macStore.contains("private let largeTimelineBatchEventThreshold = 80"), "Mac store must define a threshold for large timeline batch masking")
    try assert(macStore.contains("beginLargeTimelineBatchMask()"), "Mac store must mask large session snapshots and stream bursts before applying them")
    try assert(macStore.contains("if !hasRenderableSelectedTimeline {\n            status = \"Opening latest messages\""), "Mac cached-chat tail refreshes must not show the opening spinner when a renderable timeline is already visible")
    try assert(macStore.contains("scheduleLargeTimelineBatchReveal()"), "Mac store must reveal large timeline batches after layout settles")
    try assert(timeline.contains("let shouldHideLargeTimelineBatch = store.isApplyingLargeTimelineBatch && !(store.isRefreshingCachedDelta && hasWarmSelectedTimeline)"), "Mac timeline must keep warm cached rows visible while the latest tail refreshes")
    try assert(timeline.contains("let timelineRowsStructurallySuspended = timelineRowsSuspended || shouldHideLargeTimelineBatch"), "Mac timeline must structurally suspend cold rows for large sync batches")
    try assert(timeline.contains("let shouldMaskTimeline = timelineRowsStructurallySuspended"), "Mac cached refresh state must not mask an already-rendered timeline")
    try assert(timeline.contains(".onChange(of: store.isApplyingLargeTimelineBatch)"), "Mac timeline must retry latest-position settling after the large-batch mask drops")
    try assert(timeline.contains("timelineRowsStructurallySuspended ? [] : store.displayEvents"), "Mac timeline must not build rows while a large sync batch is masked")
    try assert(!timeline.contains("suffix(projectionEventLimit)"), "Mac timeline must not hide loaded older events behind a latest-only projection")
    try assert(macStore.contains("private let maxWarmCachedTimelineEvents = 480"), "Mac warm-cache chat switches must render only the recent tail")
    try assert(macStore.contains("let cachedLastSeq = lastSeq"), "Mac warm-cache chat switches must capture cached lastSeq before catch-up")
    try assert(!macStore.contains("connectEvents(sessionID: sessionID, after: cachedLastSeq)"), "Mac warm-cache chat switches must not replay the whole websocket gap before refreshing the latest tail")
    try assert(macStore.contains("refreshCachedSessionLatestTail"), "Mac warm-cache chat switches must refresh the server latest tail")
    try assert(!macStore.contains("Refreshing latest chat"), "Mac warm-cache chat switches must not present background tail refresh as foreground loading")
    try assert(macStore.contains("URLQueryItem(name: \"tail\", value: \"true\")"), "Mac cached chat refresh must request the latest tail window")
    try assert(macStore.contains("applySessionEventSnapshot(res, sessionID: sessionID, preserveExisting: true)"), "Mac cached chat refresh must merge the server latest tail without dropping loaded older pages")
    try assert(macStore.contains("connectEvents(sessionID: sessionID, after: lastSeq)"), "Mac warm-cache chat switches must connect live streaming only after the latest tail is applied")
    try assert(macStore.contains("isRefreshingCachedDelta = true"), "Mac cached chat refresh must still mark its background refresh state")
    try assert(macStore.contains("let newSnapshotEventCount = preserveExisting"), "Mac cached tail refresh must count only actually new events for large-batch masking")
    try assert(macStore.contains("incomingCount: newSnapshotEventCount"), "Mac no-op latest-tail refreshes must not trigger large-batch timeline masking")
    try assert(macStore.contains("guard !newEvents.isEmpty else"), "Mac event merge must skip timeline rebuilds when catch-up returns duplicate/no-op events")
    guard let memorySnapshotRange = macStore.range(of: "private func rememberSelectedChatInMemory()"),
          let diskSnapshotRange = macStore.range(of: "private func saveSelectedChatCache()", range: memorySnapshotRange.upperBound..<macStore.endIndex) else {
        throw GuardrailFailure.failed("Mac store must keep memory and disk chat-cache paths separate")
    }
    try assert(!macStore[memorySnapshotRange.lowerBound..<diskSnapshotRange.lowerBound].contains("sanitizedForCache"), "Mac memory cache snapshot must not sanitize/copy large text while switching chats")
    try assert(macStore.contains("Task.detached(priority: .utility)"), "Mac disk cache sanitization must run off the main actor")
    try assert(macStore.contains("Self.sanitizedForCache($0, maxCharacters: maxCharacters)"), "Mac disk cache writes must sanitize large text inside the detached task")
    guard let applyCacheRange = macStore.range(of: "private func applyCachedChat"),
          let refreshFilesRange = macStore.range(of: "private func refreshSessionFilesFromLoadedEvents", range: applyCacheRange.upperBound..<macStore.endIndex) else {
        throw GuardrailFailure.failed("Mac store must keep applyCachedChat isolated for sidebar-order checks")
    }
    try assert(!macStore[applyCacheRange.lowerBound..<refreshFilesRange.lowerBound].contains("sessions[idx] = cached.session"), "Mac cached chat application must not replace existing sidebar metadata")
    try assert(mobileTimeline.contains("store.isLoading && store.selectedSessionID != nil && store.displayEvents.isEmpty"), "iOS timeline must reveal cached selected-chat rows while refreshing")
    try assert(mobileTimeline.contains("timelineRowsSuspended ? [] : store.displayEvents"), "iOS timeline must structurally suspend row rendering only for cold opens")
    try assert(mobileTimeline.contains("@State private var pendingOpenBottomSessionID"), "iOS timeline must remember that newly opened chats should land at the latest message")
    try assert(!macStore.contains("URLQueryItem(name: \"tail\", value: \"false\")"), "Mac chat open must not request a non-tail catch-up page")
    try assert(!mobileStore.contains("URLQueryItem(name: \"tail\", value: \"false\")"), "iOS chat open must not request a non-tail catch-up page")
}

func checkConnectionFailuresDoNotModal() throws {
    let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
    let server = try String(contentsOf: cwd.appendingPathComponent("server/agent_server.py"), encoding: .utf8)
    let macStore = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/State/AppStore.swift"), encoding: .utf8)
    let mobileStore = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDockIOS/State/MobileAppStore.swift"), encoding: .utf8)

    try assert(macStore.contains("@Published var connectionProblemText: String?"), "Mac store must keep connection failures as inline state")
    try assert(macStore.contains("if isConnectionError(error)"), "Mac network failures must be separated from blocking alerts")
    try assert(macStore.contains("connectionProblemText = message"), "Mac connection failure should populate inline connection text")
    try assert(macStore.contains("} else {\n            return\n        }"), "Mac refresh should not keep loading sessions/jobs after health is offline")
    try assert(server.contains("\"api_contract_version\": API_CONTRACT_VERSION"), "Server health must expose API contract version")
    try assert(macStore.contains("minimumAgentAPIContractVersion"), "Mac app must define a minimum server API contract")
    try assert(macStore.contains("markServerUpgradeRequired(version:"), "Mac app must show server-upgrade-required state")
    try assert(mobileStore.contains("minimumAgentAPIContractVersion"), "iOS app must define a minimum server API contract")
    try assert(mobileStore.contains("markServerUpgradeRequired(version:"), "iOS app must show server-upgrade-required state")
}

func checkLaunchDeferredIsInline() throws {
    let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
    let server = try String(contentsOf: cwd.appendingPathComponent("server/agent_server.py"), encoding: .utf8)
    let macStore = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/State/AppStore.swift"), encoding: .utf8)
    let mobileStore = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDockIOS/State/MobileAppStore.swift"), encoding: .utf8)
    let macTimeline = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/Views/TimelineView.swift"), encoding: .utf8)
    let mobileTimeline = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDockIOS/Views/MobileTimelineView.swift"), encoding: .utf8)

    try assert(server.contains("ZENITHBOT_MAX_ACTIVE_AGENT_RUNS\", \"10\""), "Server default manual-agent concurrency cap should be 10")
    try assert(macStore.contains("@Published var launchDeferredText: String?"), "Mac store must keep launch-deferred state separate from modal errors")
    try assert(macStore.contains("isAgentLaunchDeferred(error, message: message)"), "Mac store must classify launch-deferred API responses")
    try assert(macStore.contains("launchDeferredText = message"), "Mac launch-deferred responses must become inline status")
    try assert(macStore.contains("status = \"Launch deferred\""), "Mac launch-deferred responses must update run status")
    try assert(macStore.contains("apiErrorDetail"), "Mac API errors should unwrap JSON detail strings")
    try assert(macTimeline.contains("store.launchDeferredText"), "Mac timeline header must render launch-deferred state inline")
    try assert(mobileStore.contains("@Published var launchDeferredText: String?"), "iOS store must keep launch-deferred state separate from modal errors")
    try assert(mobileStore.contains("isAgentLaunchDeferred(error, message: message)"), "iOS store must classify launch-deferred API responses")
    try assert(mobileStore.contains("setStatus(\"Launch deferred\")"), "iOS launch-deferred responses must update run status")
    try assert(mobileTimeline.contains("store.launchDeferredText"), "iOS timeline header must render launch-deferred state inline")
}

func checkVideoMetadataIsNotHiddenByMixedFilePaging() throws {
    let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
    let macStore = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/State/AppStore.swift"), encoding: .utf8)
    let inspector = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/Views/InspectorView.swift"), encoding: .utf8)
    let eventViews = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/Views/EventViews.swift"), encoding: .utf8)
    let server = try String(contentsOf: cwd.appendingPathComponent("server/agent_server.py"), encoding: .utf8)

    try assert(server.contains("content_prefix: str | None = Query(default=None)"), "Server files API must support content-type prefix filtering")
    try assert(server.contains("str(rec.get(\"content_type\") or \"\").lower().startswith(prefix)"), "Server files API must filter records before paging")
    try assert(macStore.contains("@Published var sessionVideoFiles: [ZFile] = []"), "Mac store must keep video metadata separate from mixed file pages")
    try assert(macStore.contains("URLQueryItem(name: \"content_prefix\", value: \"video/\")"), "Mac store must fetch videos independently of mixed file paging")
    try assert(inspector.contains("sortedLatestFirst(store.sessionVideos)"), "Mac files inspector must render the independent video list")
    try assert(inspector.contains("@State private var visibleVideoCount = 4"), "Mac files inspector must start video grids at four previews")
    try assert(inspector.contains("private let videoPageSize = 4"), "Mac files inspector must page video grids four at a time")
    try assert(eventViews.contains("private let initialArtifactLimit = 4"), "Mac timeline artifact grids must start at four previews")
    try assert(eventViews.contains("ForEach(visibleArtifacts)"), "Mac timeline artifact grids must render the capped preview set by default")
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

func checkJobIntervalPresets() throws {
    let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
    let inspector = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/Views/InspectorView.swift"), encoding: .utf8)
    let mobileOptions = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDockIOS/Views/MobileChatOptionsView.swift"), encoding: .utf8)
    let macStore = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/State/AppStore.swift"), encoding: .utf8)
    let mobileStore = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDockIOS/State/MobileAppStore.swift"), encoding: .utf8)
    let server = try String(contentsOf: cwd.appendingPathComponent("server/agent_server.py"), encoding: .utf8)

    try assert(inspector.contains("private struct JobIntervalControl"), "Mac job scheduling must use the reusable interval preset control")
    try assert(inspector.contains("private let jobIntervalPresets"), "Mac job scheduling must define interval presets")
    try assert(inspector.contains("JobIntervalPreset(seconds: 30"), "Job interval presets must include short status-check timing")
    try assert(inspector.contains("JobIntervalPreset(seconds: 86_400"), "Job interval presets must include daily timing")
    try assert(inspector.contains("Text(\"Custom\").tag(customJobIntervalTag)"), "Job interval picker must keep a custom option")
    try assert(inspector.contains("JobIntervalControl(intervalText: $intervalText)"), "Both new and edit job sheets should use the preset interval control")
    try assert(inspector.contains("private struct JobStartControl"), "Mac job scheduling must expose first-run/next-run timing")
    try assert(inspector.contains("DatePicker("), "Mac custom job start time must use a DatePicker")
    try assert(inspector.contains("firstRunAt: jobFirstRunAt"), "New jobs must pass the requested first-run time")
    try assert(inspector.contains("nextRunAt: nextRunAt"), "Edited jobs must pass the requested next-run time")
    try assert(mobileOptions.contains("private struct MobileJobIntervalControl"), "iOS job scheduling must use an interval preset control")
    try assert(mobileOptions.contains("private struct MobileJobStartControl"), "iOS job scheduling must expose first-run/next-run timing")
    try assert(mobileOptions.contains("DatePicker(\"Start time\""), "iOS custom job start time must use a DatePicker")
    try assert(mobileOptions.contains("firstRunAt: jobFirstRunAt"), "iOS new jobs must pass the requested first-run time")
    try assert(mobileOptions.contains("nextRunAt: nextRunAt"), "iOS edited jobs must pass the requested next-run time")
    try assert(macStore.contains("first_run_at: String?"), "Mac job create payload must support first_run_at")
    try assert(macStore.contains("next_run_at: String?"), "Mac job update payload must support next_run_at")
    try assert(macStore.contains("max_runs: Int?"), "Mac job payloads must support fixed run counts")
    try assert(inspector.contains("maxRunsText"), "Mac job sheets must expose fixed run-count controls")
    try assert(inspector.contains("jobRunModeDescription(loop:"), "Mac job rows must describe finite run counts")
    try assert(mobileStore.contains("first_run_at: String?"), "iOS job create payload must stay compatible with first_run_at")
    try assert(mobileStore.contains("max_runs: Int?"), "iOS job payloads must support fixed run counts")
    try assert(mobileOptions.contains("maxRunsText"), "iOS job sheets must expose fixed run-count controls")
    try assert(server.contains("first_run_at: str | None = None"), "Server job create model must accept first_run_at")
    try assert(server.contains("next_run_at: str | None = None"), "Server job update model must accept next_run_at")
    try assert(server.contains("max_runs: int | None = None"), "Server job models must accept max_runs")
    try assert(server.contains("finite_has_more"), "Server scheduler must keep finite jobs running until max_runs is reached")
    try assert(server.contains("parse_job_timestamp"), "Server must parse explicit job timestamps")
}

func checkTimelineCombinesRunTraces() throws {
    let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
    let macTimeline = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/Views/TimelineView.swift"), encoding: .utf8)
    let mobileTimeline = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDockIOS/Views/MobileTimelineView.swift"), encoding: .utf8)
    let server = try String(contentsOf: cwd.appendingPathComponent("server/agent_server.py"), encoding: .utf8)

    try assert(macTimeline.contains("activeAssistantEvents: [ZEvent]"), "Mac timeline must collect assistant chunks per run")
    try assert(macTimeline.contains("activeArtifactEvents: [ZEvent]"), "Mac timeline must collect run artifacts so videos render after assistant text")
    try assert(macTimeline.contains("activeTrace: [ZEvent]"), "Mac timeline must collect trace events per run")
    try assert(macTimeline.contains("if event.type == \"artifact_created\""), "Mac timeline must special-case artifacts before the generic row path")
    try assert(macTimeline.contains("if activeRunID != nil {\n                    activeArtifactEvents.append(event)"), "Mac timeline must group old nil-run manifest artifacts with the active run")
    try assert(macTimeline.contains("trace-run-\\(activeRunID"), "Mac timeline trace rows must be run-scoped")
    try assert(macTimeline.contains("joined(separator: \"\\n\\n\")"), "Mac timeline must merge assistant chunks into one message")
    try assert(mobileTimeline.contains("activeAssistantEvents: [ZEvent]"), "iOS timeline must collect assistant chunks per run")
    try assert(mobileTimeline.contains("activeArtifactEvents: [ZEvent]"), "iOS timeline must collect run artifacts so videos render after assistant text")
    try assert(mobileTimeline.contains("activeTrace: [ZEvent]"), "iOS timeline must collect trace events per run")
    try assert(mobileTimeline.contains("if event.type == \"artifact_created\""), "iOS timeline must special-case artifacts before the generic row path")
    try assert(mobileTimeline.contains("if activeRunID != nil {\n                    activeArtifactEvents.append(event)"), "iOS timeline must group old nil-run manifest artifacts with the active run")
    try assert(mobileTimeline.contains("trace-run-\\(activeRunID"), "iOS timeline trace rows must be run-scoped")
    try assert(server.contains("async def collect_manifest(session_id: str, run_id: str, manifest_path: Path)"), "Server manifest collection must know the active run id")
    try assert(server.contains("\"artifact_created\", {\"run_id\": run_id, \"artifact\": rec}"), "Server artifact_created events must include run_id so videos render after assistant text")
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

    try assert(review.contains("TraceReviewDiffPane"), "Code review sheet must render a structured diff pane")
    try assert(review.contains("TraceReviewDiffPane(sections: sections)"), "Code review sheet should render all file hunks together like Codex review")
    try assert(review.contains("TraceDiffLineView"), "Code review sheet must render per-line diff rows")
    try assert(review.contains("oldNumber"), "Code review diff rows should include old/new line numbers")
    try assert(review.contains("!path.hasPrefix(\"+\")"), "Code change extraction must reject diff body lines as fake paths")
    try assert(!review.contains("event.tool?.traceCommandText,\n            event.tool?.input?.pretty"), "Code review extraction must not treat command text as diff content")
    try assert(!review.contains("lower.contains(\"git status\")"), "Code review extraction must not treat git status commands as review hunks")
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
    try assert(core.contains("last_read_agent_event_seq"), "Shared session model must decode server-backed read cursor")
    try assert(core.contains("manual_unread"), "Shared session model must decode server-backed manual unread state")
    try assert(server.contains("latest_agent_event_seq"), "Server public sessions must expose latest visible agent event seq")
    try assert(server.contains("last_read_agent_event_seq"), "Server public sessions must expose server-backed read cursor")
    try assert(server.contains("manual_unread"), "Server public sessions must expose manual unread state")
    try assert(server.contains("sess[\"latest_agent_event_seq\"] = requested"), "Server read marks must repair stale latest agent seq metadata")
    try assert(server.contains("@app.post(\"/api/sessions/{session_id}/read\")"), "Server must expose a read-state endpoint for cross-device unread sync")
    try assert(server.contains("@app.post(\"/api/sessions/{session_id}/unread\")"), "Server must expose a manual unread endpoint for cross-device unread sync")
    try assert(server.contains("\"job_ran\", \"job_error\""), "Server must treat scheduled-job output as visible agent output")
    try assert(server.contains("update_session_event_metadata(session_id, event)"), "Server must update session event metadata as events are appended")
    try assert(macStore.contains("firstUnreadAgentSeqBySessionID"), "Mac store must remember the first unread agent event seq")
    try assert(macStore.contains("selectedTimelineAtBottom"), "Mac store must track whether the selected timeline is actually at bottom")
    try assert(macStore.contains("lastReadAgentSeqBySessionID"), "Mac unread state must compare server latest seq against local last-read seq")
    try assert(macStore.contains("manuallyUnreadSessionIDs"), "Mac store must preserve manual unread marks while the selected chat is open")
    try assert(macStore.contains("markSessionUnread"), "Mac store must support manually marking a chat unread")
    try assert(macStore.contains("allowDecrease: true"), "Manual unread must be able to move the local read cursor backward")
    try assert(macStore.contains("reconcileUnreadFromSessions()"), "Mac session refresh must reconcile unread state for non-selected scheduled-job output")
    try assert(macStore.contains("/api/sessions/\\(sessionID)/read"), "Mac read marks must sync to the server")
    try assert(macStore.contains("/api/sessions/\\(sessionID)/unread"), "Mac manual unread marks must sync to the server")
    try assert(macStore.contains("[sessionSeq, eventSeq].compactMap"), "Mac read marks must use the max of server metadata and loaded visible events")
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
    try assert(mobileStore.contains("/api/sessions/\\(sessionID)/read"), "iOS read marks must sync to the server")
    try assert(mobileStore.contains("/api/sessions/\\(sessionID)/unread"), "iOS manual unread marks must sync to the server")
    try assert(mobileStore.contains("[sessionSeq, eventSeq].compactMap"), "iOS read marks must use the max of server metadata and loaded visible events")
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
    try assert(macStore.contains("events = Array(cachedEvents.suffix(maxCachedTimelineEvents))"), "Mac cached chat restores must keep previously loaded older pages")
    try assert(macStore.contains(".suffix(maxCachedTimelineEvents)"), "Mac memory/disk chat cache must retain expanded older-page windows")
    try assert(macStore.contains("drop stale older history session="), "Older-history responses must not mutate the timeline after switching chats")
    try assert(macStore.contains("preserveExisting ? events.filter { $0.session_id == sessionID } : []"), "Fresh session snapshots must support preserving cached pages for same-chat full refreshes")
    try assert(macStore.contains("preservedBeforeSnapshot"), "Merged snapshots must reduce the older-hidden count by locally preserved events")
    try assert(macStore.contains("omittedHistoryEventCount > 0 && !isLoadingOlderHistory"), "Older-history loading must not stop just because the local timeline window is full")
    try assert(macStore.contains("URLQueryItem(name: \"limit\", value: \"\\(olderHistoryPageLimit)\")"), "Older-history paging must request a fixed page instead of remaining local capacity")
    try assert(macStore.contains("mergedEvents.removeLast(overflow)"), "Older-history paging must slide the local window by dropping the newest overflow")
    try assert(macStore.contains("for _ in 0..<8"), "Older-history paging must skip over invisible/raw-only server pages")
    try assert(macStore.contains("skipped_invisible_pages"), "Older-history logs must report invisible pages skipped while seeking visible rows")
    try assert(timeline.contains("TimelineScrollAnchor"), "History paging must capture a stable scroll anchor")
    try assert(timeline.contains("anchorEventID"), "History paging must keep an event-id fallback for regrouped rows")
    try assert(timeline.contains("row(containingEventID: eventID, in: rows)"), "History paging must restore through the event-id fallback when row IDs change")
    try assert(timeline.contains("for delay in [0.0, 0.06, 0.18]"), "History paging must restore the scroll anchor across multiple layout passes")
    try assert(timeline.contains("loadOlderHistoryShowingNewPage"), "Explicit Load Older button must visibly move to the newly revealed older page")
    try assert(timeline.contains("revealOlderRowsShowingNewPage"), "Explicit Show Older button must visibly move to the newly revealed rendered page")
    try assert(timeline.contains("scrollToOlderPageTarget"), "Explicit older-page navigation must share delayed scroll settling")
    try assert(timeline.contains("private func renderedRows(visibleLimit:"), "Older-page navigation must use the same rows the UI actually renders")
    try assert(timeline.contains("AppLogger.info(\"auto older loaded"), "Automatic older-history loading must log rendered row expansion diagnostics")
    try assert(timeline.contains("firstNewOlderRow(before:"), "Automatic older-history loading must reveal the newly loaded page instead of pinning the old top row")
    try assert(macStore.contains("firstAddedEventID"), "Older-history loading must return the first newly loaded event for deterministic scroll targeting")
    try assert(timeline.contains("row(containingEventID: firstAddedEventID, in: rows)"), "Older-history navigation must scroll to the row containing the first newly loaded event")
    try assert(timeline.contains("olderHistoryVisibleLimit"), "Older-history reveal must expand the rendered suffix far enough to include its scroll target")
    try assert(timeline.contains("rowsNeeded + 2"), "Older-history target rows must be inside the rendered suffix before scrolling")
    try assert(timeline.contains("target=\\(target?.id ?? \"-\")"), "Older-history logs must include the actual target row")
    try assert(timeline.contains("func containsEventID(_ eventID: String)"), "Grouped timeline rows must retain source event IDs for deterministic scroll targeting")
    try assert(timeline.contains("private static let assistantRowChunkSize"), "Assistant runs must be split into bounded rows so older pages create visible targets")
    try assert(timeline.contains("private static let traceRowChunkSize"), "Trace runs must be split into bounded rows so older pages create visible targets")
    try assert(timeline.contains("private static let compactedTraceEventLimit"), "Adjacent trace-only rows must be compacted so history pages do not become trace walls")
    try assert(timeline.contains("compactAdjacentTraceRows(buildRows"), "Mac timeline projection must compact adjacent trace cards after preserving row targets")
    try assert(timeline.contains("trace-compact-"), "Compacted trace rows must retain deterministic scroll IDs")
    try assert(timeline.contains("eventIDs: chunk.map(\\.id)"), "Chunked timeline rows must preserve the source event IDs they represent")
    try assert(timeline.contains("AppLogger.info(\"show older rows"), "Show Older must log target rows for paging diagnostics")
    try assert(timeline.contains("AppLogger.info(\"load older intent"), "Load Older must log target rows for paging diagnostics")
    try assert(timeline.contains("private func disarmAutomaticOlderHistoryLoad()"), "Timeline must centralize the guard that prevents open-bottom from accidentally auto-loading older history")
    try assert(timeline.contains("disarmAutomaticOlderHistoryLoad()\n                    suppressHistoryLoading(for: 1.4)"), "Opening a chat must disarm auto older-history loading until the latest-message scroll settles")
    try assert(timeline.contains("disarmAutomaticOlderHistoryLoad()\n        let action = {"), "Programmatic bottom scrolls must disarm older-history autoload before layout metrics arrive")
    try assert(timeline.contains("if topHasLeftViewport {\n            olderHistoryLoadArmed = true"), "Older-history autoload should rearm only after the rendered top has left the viewport")
    try assert(timeline.contains("if revealOlderRowsShowingNewPage(proxy) {\n            olderHistoryLoadArmed = false"), "Automatic older-history loading must reveal the new page instead of preserving the old top anchor")
    try assert(timeline.contains("private func suppressHistoryLoading(for interval: TimeInterval)"), "Open-to-latest must use monotonic history-load suppression instead of shortening the suppression window")
    try assert(timeline.contains("suppressHistoryLoading(for: 2.4)"), "Opening a chat must suppress top-edge history loading while bottom scrolling settles")
    try assert(timeline.contains("for delay in [0.04, 0.16, 0.36, 0.75, 1.25]"), "Opening a chat must keep settling bottom position across SwiftUI layout passes")
    try assert(timeline.contains("metrics.isScrollable && metrics.distanceFromBottom <= 28"), "Forced bottom scrolling must not declare success while only a placeholder/non-scrollable timeline is rendered")
    try assert(!timeline.contains("disarmAutomaticOlderHistoryLoad()\n                    historyLoadSuppressedUntil = Date.distantPast"), "Opening a chat must not immediately re-enable top-edge history loading")
    try assert(!timeline.contains("Loaded window limit"), "Mac history banner must keep offering Load Older while the server has older events")
}

func checkLiveTimelineAutoFollow() throws {
    let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
    let macStore = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/State/AppStore.swift"), encoding: .utf8)
    let macTimeline = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/Views/TimelineView.swift"), encoding: .utf8)
    let mobileTimeline = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDockIOS/Views/MobileTimelineView.swift"), encoding: .utf8)

    try assert(macTimeline.contains("private func shouldAutoFollowLiveEvent(after previousSeq: Int) -> Bool {\n        false\n    }"), "Mac timeline must not auto-scroll downward when new selected-chat messages arrive")
    try assert(macTimeline.contains("store.markAgentUnread(sessionID: sessionID, firstSeq: firstSeq)"), "Mac timeline must mark selected-chat agent output unread instead of auto-following")
    try assert(macTimeline.contains("cappedLiveVisibleRowLimit(rowCount: rowCount, oldCount: oldCount, newCount: newCount)"), "Mac live-follow must not expand the rendered window to the full chat history")
    try assert(macTimeline.contains("suppressHistoryLoading(for: 0.45)"), "Mac programmatic bottom scrolls must suppress older-history autoload")
    try assert(macTimeline.contains("store.markSelectedSessionRead(force: true)"), "Mac auto-follow must clear selected unread state intentionally")
    try assert(macStore.contains("pendingStreamEvents"), "Mac streaming catch-up must buffer burst events instead of publishing one-by-one flyby")
    try assert(macStore.contains("streamBackfillMaskThreshold"), "Mac streaming catch-up must mask large event bursts")
    try assert(macStore.contains("applyStreamEvents(buffered)"), "Mac streaming catch-up must apply buffered events as one batch")
    try assert(mobileTimeline.contains("private func shouldAutoFollowLiveEvent(after previousSeq: Int) -> Bool {\n        false\n    }"), "iOS timeline must not auto-scroll downward when new selected-chat messages arrive")
    try assert(mobileTimeline.contains("store.markSessionUnread(sessionID)"), "iOS timeline must mark selected-chat agent output unread instead of auto-following")
    try assert(mobileTimeline.contains("lastObservedEventSeq"), "iOS timeline must distinguish new streamed events from older history prepends")
    try assert(mobileTimeline.contains("cappedLiveVisibleRowLimit(rowCount: rowCount, oldCount: oldCount, newCount: newCount)"), "iOS live-follow must not expand the rendered window to the full chat history")
}

func checkQueuedRemovalDisappears() throws {
    let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
    let macStore = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/State/AppStore.swift"), encoding: .utf8)
    let mobileStore = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDockIOS/State/MobileAppStore.swift"), encoding: .utf8)
    let server = try String(contentsOf: cwd.appendingPathComponent("server/agent_server.py"), encoding: .utf8)

    try assert(macStore.contains("var pendingQueuedEvents: [ZEvent]"), "Mac store must expose pending queued turns outside the timeline")
    try assert(macStore.contains("case \"turn_queued\":\n                return false"), "Mac timeline must keep pending queued turns out of the timeline")
    try assert(macStore.contains("\"turn_queue_updated\""), "Mac timeline must hide queue metadata events")
    try assert(macStore.contains("\"turn_stopped\""), "Mac timeline must hide stop events from Send Now interruptions")
    try assert(!macStore.contains("queuedTurnIDs.contains(queuedID)"), "Mac timeline must render queued turn_started prompts as user messages")
    try assert(macStore.contains("events.removeAll { $0.type == \"turn_queued\" && $0.queued_id == queuedID }"), "Mac unqueue should remove the queued row locally after server success")
    try assert(macStore.contains("func runQueuedNow"), "Mac store must support interrupting the current run for a queued turn")
    try assert(macStore.contains("func moveQueued"), "Mac store must support queue reordering")
    try assert(macStore.contains("func updateQueued"), "Mac store must support editing queued prompts")
    try assert(macStore.contains("func handleStaleQueuedTurn"), "Mac store must silently reconcile stale queued rows")
    try assert(macStore.contains("isQueuedTurnNotFound(error)"), "Mac stale queued rows must be detected without showing a modal")
    try assert(macStore.contains("clearSubmittedPromptIfCurrent(submittedPrompt: submittedPrompt, trimmed: trimmed)"), "Mac send success must clear a stale submitted draft after queued sends")
    try assert(macStore.contains("prompt.trimmingCharacters(in: .whitespacesAndNewlines) == trimmed"), "Mac draft clearing must not wipe a newer prompt typed during submit")
    try assert(mobileStore.contains("events.removeAll { $0.type == \"turn_queued\" && $0.queued_id == queuedID }"), "iOS unqueue should remove queued rows locally after server success")
    try assert(mobileStore.contains("func runQueuedNow"), "iOS store must support interrupting the current run for a queued turn")
    try assert(mobileStore.contains("func moveQueued"), "iOS store must support queue reordering")
    try assert(mobileStore.contains("func updateQueued"), "iOS store must support editing queued prompts")
    try assert(mobileStore.contains("func handleStaleQueuedTurn"), "iOS store must silently reconcile stale queued rows")
    try assert(mobileStore.contains("isQueuedTurnNotFound(error)"), "iOS stale queued rows must be detected without showing an alert")
    try assert(mobileStore.contains("clearSubmittedPromptIfCurrent(submittedPrompt: submittedPrompt, trimmed: trimmed)"), "iOS send success must clear a stale submitted draft after queued sends")
    try assert(server.contains("RUN_NOW_TURNS"), "Server Send Now must reserve the exact queued item instead of relying on queue order")
    try assert(server.contains("stop_turn(session_id, emit_event=False, schedule_queue=False)"), "Server Send Now must silently interrupt without appending visible stop cards")
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
    try assert(composer.contains("override func validateUserInterfaceItem"), "Mac composer must keep Paste enabled for image-only clipboards")
    try assert(composer.contains("override func performKeyEquivalent"), "Mac composer must catch Command-V for image-only clipboards")
    try assert(composer.contains("NSImage(pasteboard: pasteboard)"), "Mac composer must read raw image data from the pasteboard")
    try assert(composer.contains("UTType(type.rawValue)"), "Mac composer must accept typed image pasteboard data, not only NSImage pasteboard decoding")
    try assert(composer.contains("utType.conforms(to: .image)"), "Mac composer must detect PNG/JPEG/TIFF/HEIC-style clipboard images")
    try assert(composer.contains("item.data(forType: type)"), "Mac composer must inspect per-item pasteboard image data")
    try assert(composer.contains("ZenithDockPasteboardImages"), "Mac composer must persist pasted images before upload")
}

func checkMobileVideoDownloads() throws {
    let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
    let mobileEvents = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDockIOS/Views/MobileEventViews.swift"), encoding: .utf8)
    let mobileOptions = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDockIOS/Views/MobileChatOptionsView.swift"), encoding: .utf8)

    try assert(mobileEvents.contains("struct MobileArtifactShareButton"), "iOS must expose a native artifact download/share button")
    try assert(mobileEvents.contains("MobileActivityView(activityItems: [item.url])"), "iOS download button must open the native activity sheet with a local file")
    try assert(mobileEvents.contains("MobileArtifactDragFileCache.shared.localFile"), "iOS download must cache remote videos/files locally before sharing")
    try assert(mobileEvents.contains("struct MobileActivityView: UIViewControllerRepresentable"), "iOS download must use UIActivityViewController")
    try assert(mobileOptions.contains("MobileArtifactShareButton(file: file, url: url"), "iOS files/videos panel must expose download/share controls")
    try assert(mobileEvents.contains(".aspectRatio(16.0 / 9.0, contentMode: .fit)"), "iOS timeline videos must use a stable letterboxed wide-video frame")
    try assert(mobileOptions.contains(".aspectRatio(16.0 / 9.0, contentMode: .fit)"), "iOS video grid thumbnails must use a stable letterboxed wide-video frame")
    try assert(mobileEvents.contains(".scaledToFit()"), "iOS timeline video thumbnails must not crop ultra-wide videos")
    try assert(mobileOptions.contains(".scaledToFit()"), "iOS video grid thumbnails must not crop ultra-wide videos")
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
    try checkTimelineMessageTimestamps()
    try checkArchiveSessionBehavior()
    try checkFolderSectionControls()
    try checkMobileDoesNotAutoSelectFirstChat()
    try checkTimelineRevealWaitsForLatestSnapshot()
    try checkConnectionFailuresDoNotModal()
    try checkLaunchDeferredIsInline()
    try checkVideoMetadataIsNotHiddenByMixedFilePaging()
    try checkRuntimeAutosavesAndBackendIcons()
    try checkJobIntervalPresets()
    try checkTimelineCombinesRunTraces()
    try checkInlineVideoPlayAutoplays()
    try checkCodeReviewSurfaceIsStructured()
    try checkUnreadMessageMarker()
    try checkTimelineHistoryPaging()
    try checkLiveTimelineAutoFollow()
    try checkQueuedRemovalDisappears()
    try checkPromptImageAttachments()
    try checkMobileVideoDownloads()
    try checkTmuxSubmitterVisualizer()
    try checkExportCompliancePlists()
    print("ZenithGuardrails passed")
} catch {
    fputs("ZenithGuardrails failed: \(error)\n", stderr)
    exit(1)
}
