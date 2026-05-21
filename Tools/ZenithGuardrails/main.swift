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
    guard let guardRange = source.range(of: "guard presenceGate.shouldPublish(value) else { return }"),
          let callbackRange = source.range(of: "parent.onTextPresenceChange(!value.isEmpty)") else {
        throw GuardrailFailure.failed("Composer publishPresence must gate SwiftUI callbacks")
    }
    try assert(guardRange.lowerBound < callbackRange.lowerBound, "Composer must gate text presence before calling SwiftUI")
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

    try assert(catalog.modelLabel(nil, backend: "codex") == "Server default (GPT-5.5)", "model default label should show actual server default")
    try assert(catalog.effortLabel(nil, backend: "codex") == "Server default (XHigh)", "effort default label should show actual server default")
    try assert(catalog.compactSummary(for: session) == "Codex · Server default (GPT-5.5) · Server default (XHigh)", "runtime summary should include resolved defaults")

    let fallbackCatalog = ZRuntimeCatalogSnapshot.fallback
    try assert(fallbackCatalog.models(for: "codex").contains { $0.value == "gpt-5.5" }, "Codex fallback catalog must include GPT-5.5 while server discovery is unavailable")
    try assert(fallbackCatalog.efforts(for: "codex").contains { $0.value == "xhigh" }, "Codex fallback catalog must include XHigh effort while server discovery is unavailable")
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

func checkArchiveSessionBehavior() throws {
    let sessionData = Data(#"{"id":"sess","title":"Archived","backend":"codex","archived":true}"#.utf8)
    let session = try JSONDecoder().decode(ZSession.self, from: sessionData)
    try assert(session.archived == true, "ZSession must decode archived session state")

    let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
    let macStore = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/State/AppStore.swift"), encoding: .utf8)
    let mobileStore = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDockIOS/State/MobileAppStore.swift"), encoding: .utf8)
    let macDigest = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/Views/SessionManagementSheets.swift"), encoding: .utf8)
    let mobileDigest = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDockIOS/Views/MobileChatOptionsView.swift"), encoding: .utf8)
    let server = try String(contentsOf: cwd.appendingPathComponent("server/agent_server.py"), encoding: .utf8)

    try assert(macStore.contains("sessions.filter { $0.archived != true }"), "Mac active session lists must filter archived chats")
    try assert(mobileStore.contains("sessions.filter { $0.archived != true }"), "iOS active session lists must filter archived chats")
    try assert(macDigest.contains("store.digestTargetSessions(excluding: sourceSession.id)"), "Mac digest sheet must exclude archived target chats")
    try assert(mobileDigest.contains("store.digestTargetSessions(excluding: sourceSession.id)"), "iOS digest sheet must exclude archived target chats")
    try assert(server.contains("archived: bool | None = None"), "Server session update API must accept archived state")
    try assert(server.contains("\"archived\", \"archived_at\""), "Server public sessions must expose archived state")
}

func checkTimelineRevealWaitsForLatestSnapshot() throws {
    let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
    let macStore = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/State/AppStore.swift"), encoding: .utf8)
    let mobileStore = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDockIOS/State/MobileAppStore.swift"), encoding: .utf8)
    let timeline = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/Views/TimelineView.swift"), encoding: .utf8)
    let mobileTimeline = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDockIOS/Views/MobileTimelineView.swift"), encoding: .utf8)

    try assert(macStore.contains("@Published var isSelectingSession = false"), "Mac store must publish session selection/loading state")
    try assert(macStore.contains("isSelectingSession = true"), "Mac session select must mark the latest snapshot as loading")
    try assert(timeline.contains("guard !store.isSelectingSession else { return }"), "Timeline must not reveal cached/intermediate history while latest snapshot is still loading")
    try assert(timeline.contains(".onChange(of: store.isSelectingSession)"), "Timeline must retry reveal when the latest snapshot load finishes")
    try assert(timeline.contains("let timelineRowsSuspended = isInitialTimelineMasked"), "Mac timeline must structurally suspend row rendering while opening a chat")
    try assert(timeline.contains("timelineRowsSuspended ? [] : store.displayEvents"), "Mac timeline must not project/render cached rows while opening")
    try assert(mobileTimeline.contains("let timelineRowsSuspended = store.isLoading"), "iOS timeline must structurally suspend row rendering while loading a chat")
    try assert(mobileTimeline.contains("timelineRowsSuspended ? [] : store.displayEvents"), "iOS timeline must not project/render cached rows while loading")
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

    try assert(macTheme.contains("struct BackendLogo"), "Mac theme must define vector backend logos")
    try assert(mobileTheme.contains("struct MobileBackendLogo"), "iOS theme must define vector backend logos")
    try assert(macSidebar.contains("BackendLogo(backend: session.backend)"), "Mac sidebar must use backend-specific logo views")
    try assert(mobileSidebar.contains("MobileBackendLogo(backend: session.backend)"), "iOS sidebar must use backend-specific logo views")
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

do {
    try checkTextPresenceGateBehavior()
    try checkComposerUsesPresenceGate()
    try checkEndpointCacheKeysAreServerScoped()
    try checkRuntimeDefaultLabels()
    try checkServerURLNormalization()
    try checkShellCopyNormalization()
    try checkArchiveSessionBehavior()
    try checkTimelineRevealWaitsForLatestSnapshot()
    try checkConnectionFailuresDoNotModal()
    try checkVideoMetadataIsNotHiddenByMixedFilePaging()
    try checkRuntimeAutosavesAndBackendIcons()
    try checkTimelineCombinesRunTraces()
    try checkInlineVideoPlayAutoplays()
    try checkCodeReviewSurfaceIsStructured()
    print("ZenithGuardrails passed")
} catch {
    fputs("ZenithGuardrails failed: \(error)\n", stderr)
    exit(1)
}
