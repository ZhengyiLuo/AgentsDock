import Combine
import AppKit
import Foundation
import ZenithCore

private let defaultAgentServerURLString = "http://127.0.0.1:7850"
private let fallbackServerCwd = "~"
private let minimumAgentAPIContractVersion = 4
private let pendingRuntimePatchTimeout: TimeInterval = 12
private let pinnedMessageBodyLimit = 20_000

struct PinnedTimelineItem: Codable, Identifiable, Hashable, Sendable {
    enum Kind: String, Codable, Sendable {
        case message
        case file
    }

    var id: String
    var sessionID: String
    var kind: Kind
    var eventID: String?
    var file: ZFile?
    var title: String
    var subtitle: String?
    var body: String?
    var createdAt: String?
    var pinnedAt: String
}

@MainActor
final class AppStore: ObservableObject {
    @Published var serverURLString = UserDefaults.standard.string(forKey: "serverURL") ?? defaultAgentServerURLString
    @Published var accessToken = ZenithTokenStore.load()
    @Published var sessions: [ZSession] = [] {
        didSet { invalidateSidebarDerived() }
    }
    @Published var selectedSessionID: String?
    private(set) var events: [ZEvent] = []
    @Published var uploads: [ZFile] = []
    @Published var sessionFiles: [ZFile] = [] {
        didSet { scheduleSessionMediaCacheRebuild() }
    }
    @Published var sessionVideoFiles: [ZFile] = [] {
        didSet { scheduleSessionMediaCacheRebuild() }
    }
    @Published private(set) var sessionVideos: [ZFile] = []
    @Published var sessionFilesTotal: Int?
    @Published var sessionFilesHasMore = false
    @Published var isLoadingSessionFiles = false
    @Published var isLoadingSessionVideos = false
    @Published var prompt = ""
    @Published var isRunning = false
    @Published var status = "Disconnected"
    @Published var errorText: String?
    /// Cmd+P opens the Notion-style chat quick-find palette overlay.
    @Published var chatSearchPaletteOpen = false
    @Published var connectionProblemText: String?
    @Published var launchDeferredText: String?
    @Published var jobs: [ZJob] = []
    @Published var runtimeCatalog = ZRuntimeCatalogSnapshot.fallback
    @Published var showDebugEvents = false {
        didSet { rebuildDisplayEvents() }
    }
    @Published private(set) var displayEvents: [ZEvent] = []
    @Published var loadedSessionID: String?
    @Published var isSelectingSession = false
    @Published var isRefreshingCachedDelta = false
    @Published var isApplyingLargeTimelineBatch = false
    @Published var serverReachable = false
    @Published var socketLive = false
    @Published var activeSessionIDs: Set<String> = []
    @Published var defaultCwd = fallbackServerCwd
    // Internal freshness bookkeeping only — never read by the view layer, so
    // these are intentionally NOT @Published. Publishing them forced a
    // whole-tree re-render on every 5s poll (lastLoadedAt was reassigned
    // unconditionally each refresh).
    private var lastHealthAt: Date?
    private var lastLoadedAt: Date?
    @Published var lastSocketError: String?
    @Published var omittedHistoryEventCount = 0
    @Published var isLoadingOlderHistory = false
    @Published var scrollToBottomRevision = 0
    @Published var forcedScrollToBottomRevision = 0
    @Published var preserveTimelineScrollRevision = 0
    @Published var scrollToEventID: String?
    @Published var scrollToEventRevision = 0
    @Published var processSnapshot: ZProcessSnapshot?
    @Published var processLogTail: ZProcessLogTail?
    @Published var isLoadingProcesses = false
    @Published var tmuxSnapshot: ZTmuxSnapshot?
    @Published var tmuxCapture: ZTmuxCapture?
    @Published var isLoadingTmux = false
    @Published private(set) var unreadAgentSessionIDs: Set<String> = [] {
        didSet {
            UnreadNotificationController.shared.updateBadge(unreadCount: unreadAgentSessionIDs.count)
        }
    }
    @Published private(set) var firstUnreadAgentSeqBySessionID: [String: Int] = [:]
    @Published private(set) var selectedTimelineAtBottom = true
    @Published private(set) var folderOrder: [String] = UserDefaults.standard.stringArray(forKey: "folderOrder") ?? [] {
        didSet { invalidateSidebarDerived() }
    }
    @Published private(set) var collapsedFolders: Set<String> = Set(UserDefaults.standard.stringArray(forKey: "collapsedFolders") ?? [])
    @Published private(set) var archivedSectionCollapsed = UserDefaults.standard.bool(forKey: "archivedSectionCollapsed")
    @Published private(set) var pinnedItemsBySessionID: [String: [PinnedTimelineItem]] = [:]
    @Published private(set) var queuedTurnsBySessionID: [String: [ZQueuedTurn]] = [:]

    private let initialSessionEventLimit = 240
    private let olderHistoryPageLimit = 400
    private let maxLoadedTimelineEvents = 2_000
    private let maxCachedTimelineEvents = 720
    private let cachedTailFreshnessWindow: TimeInterval = 45
    private let maxCachedStringCharacters = 6_000
    private let sessionFilesPageLimit = 48
    private var webSocket: URLSessionWebSocketTask?
    private var webSocketSessionID: String?
    private var loadingSessionID: String?
    private var liveTrackingStarted = false
    private var latestSeenSeq = 0
    private var pendingCacheWrite: Task<Void, Never>?
    private var pendingScrollRequest: Task<Void, Never>?
    private var pendingStreamEvents: [ZEvent] = []
    private var pendingStreamSessionID: String?
    private var pendingStreamFlushTask: Task<Void, Never>?
    private var timelineBatchRevealTask: Task<Void, Never>?
    private var selectionGeneration = 0
    private var memoryChatCache: [String: CachedChat] = [:]
    private var memoryChatCacheOrder: [String] = []
    private struct VerifiedTimelineTail {
        let latestSeq: Int
        let eventIDs: [String]
        let verifiedAt: Date
    }
    private var verifiedTimelineTailsBySessionID: [String: VerifiedTimelineTail] = [:]
    private var lastReadAgentSeqBySessionID: [String: Int] = [:]
    private var manuallyUnreadSessionIDs: Set<String> = []
    private var unreadNotificationTracker = ZUnreadNotificationTracker()
    private var unreadNotificationsConfigured = false
    private var pendingReadSyncBySessionID: [String: Int] = [:]
    private var pendingRuntimeBySessionID: [String: PendingRuntimePatch] = [:]
    private var draftPromptsBySessionID: [String: String] = [:]
    private var pendingDraftSave: Task<Void, Never>?
    private var serverIdentity: String?
    private var lastScrollRequestAt = Date.distantPast
    private var sessionFilesNextOffset = 0
    private var sessionMediaCacheRebuildScheduled = false
    private var lastSeq: Int { max(latestSeenSeq, events.map(\.seq).max() ?? 0) }
    private let maxMemoryCachedChats = 32
    private let streamBackfillMaskThreshold = 18
    private let streamFlushDelayNanos: UInt64 = 320_000_000
    private let largeTimelineBatchEventThreshold = 80
    private let largeTimelineBatchCharacterThreshold = 14_000

    private struct CachedChat: Codable, Sendable {
        var session: ZSession
        var events: [ZEvent]
        var sessionFiles: [ZFile]?
        var omittedHistoryEventCount: Int
        var cachedAt: String
    }

    private struct SessionEventsResponse: Codable, Sendable {
        let session: ZSession
        let events: [ZEvent]
        let events_omitted_before: Int?
        let events_omitted_after: Int?
        let latest_seq: Int?
        let event_count: Int?
        let queued_turns: [ZQueuedTurn]?
    }

    private struct PendingRuntimePatch {
        var backend: String?
        var modelSet = false
        var model: String?
        var effortSet = false
        var effort: String?
        var updatedAt = Date()

        var isEmpty: Bool {
            backend == nil && !modelSet && !effortSet
        }

        func isExpired(now: Date = Date()) -> Bool {
            now.timeIntervalSince(updatedAt) > pendingRuntimePatchTimeout
        }

        mutating func touch() {
            updatedAt = Date()
        }

        mutating func clearConfirmed(by session: ZSession) {
            if let backend, session.backend == backend {
                self.backend = nil
            }
            if modelSet && Self.runtimeValue(session.model) == model {
                modelSet = false
                model = nil
            }
            if effortSet && Self.runtimeValue(session.effort) == effort {
                effortSet = false
                effort = nil
            }
        }

        func applying(to session: ZSession) -> ZSession {
            var merged = session
            if let backend {
                merged.backend = backend
            }
            if modelSet {
                merged.model = model
            }
            if effortSet {
                merged.effort = effort
            }
            return merged
        }

        private static func runtimeValue(_ value: String?) -> String? {
            let clean = ZRuntimeCatalog.cleaned(value)
            return clean.isEmpty ? nil : clean
        }
    }

    struct OlderHistoryLoadResult: Sendable {
        let addedCount: Int
        let firstAddedEventID: String?
    }

    init() {
        serverIdentity = Self.loadServerIdentity(for: serverURLString)
        lastReadAgentSeqBySessionID = loadReadState()
        draftPromptsBySessionID = loadDraftPrompts()
        pinnedItemsBySessionID = loadPinnedItems()
    }

    var api: APIClient {
        APIClient(
            baseURL: ZenithServerURL.url(serverURLString, default: defaultAgentServerURLString),
            accessToken: accessToken
        )
    }

    var selectedSession: ZSession? {
        sessions.first { $0.id == selectedSessionID }
    }

    var selectedSessionHasUnread: Bool {
        guard let selectedSessionID else { return false }
        return unreadAgentSessionIDs.contains(selectedSessionID)
    }

    var selectedSessionFirstUnreadSeq: Int? {
        guard let selectedSessionID else { return nil }
        return firstUnreadAgentSeqBySessionID[selectedSessionID]
    }

    // Sidebar collections are derived from `sessions` + `folderOrder` via sorts
    // and groupings. They were previously recomputed on every access — and the
    // sidebar body calls them once per folder, on every store change (including
    // every 320ms streaming flush). Memoize a single snapshot, invalidated only
    // when the inputs change (see the didSet on `sessions`/`folderOrder`).
    private struct SidebarDerived {
        var active: [ZSession]
        var archived: [ZSession]
        var pinned: [ZSession]
        var folders: [String: [ZSession]]
        var folderNames: [String]
    }
    private var sidebarDerivedCache: SidebarDerived?

    private func invalidateSidebarDerived() {
        sidebarDerivedCache = nil
    }

    private var sidebarDerived: SidebarDerived {
        if let cached = sidebarDerivedCache {
            return cached
        }
        let active = orderedSessions(sessions.filter { $0.archived != true })
        let archived = orderedSessions(sessions.filter { $0.archived == true })
        let pinned = active.filter { $0.pinned == true }
        let foldersDict = Dictionary(grouping: active.filter { $0.pinned != true }) { $0.folder ?? "General" }
        let names = orderedFolderNames(Array(Set(active.map { $0.folder ?? "General" })))
        let derived = SidebarDerived(
            active: active,
            archived: archived,
            pinned: pinned,
            folders: foldersDict,
            folderNames: names
        )
        sidebarDerivedCache = derived
        return derived
    }

    var activeSessions: [ZSession] {
        sidebarDerived.active
    }

    var archivedSessions: [ZSession] {
        sidebarDerived.archived
    }

    var pinnedSessions: [ZSession] {
        sidebarDerived.pinned
    }

    var sidebarNavigationSessions: [ZSession] {
        let derived = sidebarDerived
        var ordered: [ZSession] = derived.pinned
        for folder in derived.folderNames where !isFolderCollapsed(folder) {
            ordered.append(contentsOf: derived.folders[folder] ?? [])
        }
        if !archivedSectionCollapsed {
            ordered.append(contentsOf: derived.archived)
        }
        return ordered
    }

    var folders: [String: [ZSession]] {
        sidebarDerived.folders
    }

    var folderNames: [String] {
        sidebarDerived.folderNames
    }

    func isFolderCollapsed(_ folder: String) -> Bool {
        collapsedFolders.contains(folder)
    }

    func toggleFolderCollapsed(_ folder: String) {
        let clean = normalizedFolderName(folder)
        if collapsedFolders.contains(clean) {
            collapsedFolders.remove(clean)
        } else {
            collapsedFolders.insert(clean)
        }
        UserDefaults.standard.set(Array(collapsedFolders).sorted(), forKey: "collapsedFolders")
    }

    func toggleArchivedSectionCollapsed() {
        archivedSectionCollapsed.toggle()
        UserDefaults.standard.set(archivedSectionCollapsed, forKey: "archivedSectionCollapsed")
    }

    func moveFolder(_ folder: String, direction: String) {
        let clean = normalizedFolderName(folder)
        var names = orderedFolderNames(Array(Set(activeSessions.map { $0.folder ?? "General" })))
        guard let index = names.firstIndex(of: clean) else { return }
        let target = direction == "up" ? index - 1 : index + 1
        guard names.indices.contains(target) else { return }
        names.swapAt(index, target)
        folderOrder = names
        UserDefaults.standard.set(folderOrder, forKey: "folderOrder")
    }

    func reorderFolders(from source: IndexSet, to destination: Int) {
        var names = orderedFolderNames(Array(Set(activeSessions.map { $0.folder ?? "General" })))
        names.move(fromOffsets: source, toOffset: destination)
        folderOrder = names
        UserDefaults.standard.set(folderOrder, forKey: "folderOrder")
    }

    private func orderedFolderNames(_ names: [String]) -> [String] {
        let normalized = Array(Set(names.map(normalizedFolderName)))
        let orderIndex = Dictionary(uniqueKeysWithValues: folderOrder.enumerated().map { ($0.element, $0.offset) })
        return normalized.sorted { lhs, rhs in
            let left = orderIndex[lhs] ?? Int.max
            let right = orderIndex[rhs] ?? Int.max
            if left != right {
                return left < right
            }
            return lhs.localizedCaseInsensitiveCompare(rhs) == .orderedAscending
        }
    }

    private func normalizedFolderName(_ folder: String) -> String {
        let clean = folder.trimmingCharacters(in: .whitespacesAndNewlines)
        return clean.isEmpty ? "General" : clean
    }

    func selectAdjacentSession(direction: Int) async {
        let visibleSessions = sidebarNavigationSessions
        guard !visibleSessions.isEmpty else { return }
        let step = direction >= 0 ? 1 : -1
        let currentIndex = selectedSessionID.flatMap { selectedID in
            visibleSessions.firstIndex { $0.id == selectedID }
        }
        let nextIndex: Int
        if let currentIndex {
            nextIndex = (currentIndex + step + visibleSessions.count) % visibleSessions.count
        } else {
            nextIndex = step > 0 ? 0 : visibleSessions.count - 1
        }
        await select(sessionID: visibleSessions[nextIndex].id)
    }

    func digestTargetSessions(excluding sourceSessionID: String) -> [ZSession] {
        digestTargetSections(excluding: sourceSessionID).flatMap(\.sessions)
    }

    func digestTargetSections(excluding sourceSessionID: String) -> [DigestTargetSection] {
        var sections: [DigestTargetSection] = []
        let pinned = pinnedSessions.filter { $0.id != sourceSessionID }
        if !pinned.isEmpty {
            sections.append(DigestTargetSection(id: "pinned", title: "Pinned", sessions: pinned))
        }
        for folder in folderNames {
            let sessions = (folders[folder] ?? []).filter { $0.id != sourceSessionID }
            if !sessions.isEmpty {
                sections.append(DigestTargetSection(id: "folder:\(folder)", title: folder, sessions: sessions))
            }
        }
        return sections
    }

    private func orderedSessions(_ source: [ZSession]) -> [ZSession] {
        source.sorted { lhs, rhs in
            let leftOrder = lhs.sort_order ?? 0
            let rightOrder = rhs.sort_order ?? 0
            if leftOrder != rightOrder {
                return leftOrder < rightOrder
            }
            let leftCreated = lhs.created_at ?? ""
            let rightCreated = rhs.created_at ?? ""
            if leftCreated != rightCreated {
                return leftCreated < rightCreated
            }
            return lhs.id < rhs.id
        }
    }

    var connectionTitle: String {
        if !serverReachable {
            return "Agent server offline"
        }
        if selectedSessionID == nil {
            return "Agent server connected"
        }
        return socketLive ? "Selected chat live" : "Server connected"
    }

    var connectionSubtitle: String {
        if !serverReachable, let connectionProblemText, !connectionProblemText.isEmpty {
            return connectionProblemText
        }
        let loaded = sessions.isEmpty ? "no chats loaded" : "\(sessions.count) chats loaded"
        let active = activeSessionIDs.isEmpty ? "no active runs" : "\(activeSessionIDs.count) active"
        // Intentionally omit live socket state here. It flips on every chat
        // switch (socket drops + reconnects) and was making the sidebar text
        // reflow/jump constantly. Keep only the stable counts.
        return "\(loaded) · \(active)"
    }

    var hiddenDisplayEventCount: Int {
        omittedHistoryEventCount
    }

    var canLoadOlderHistory: Bool {
        omittedHistoryEventCount > 0 &&
            events.count < maxLoadedTimelineEvents &&
            !isLoadingOlderHistory
    }

    var selectedPinnedItems: [PinnedTimelineItem] {
        guard let selectedSessionID else { return [] }
        return (pinnedItemsBySessionID[selectedSessionID] ?? []).sorted { lhs, rhs in
            if lhs.pinnedAt != rhs.pinnedAt {
                return lhs.pinnedAt > rhs.pinnedAt
            }
            return lhs.title.localizedStandardCompare(rhs.title) == .orderedAscending
        }
    }

    func isPinned(_ event: ZEvent) -> Bool {
        if let file = event.artifact ?? event.file {
            return isPinned(file)
        }
        return pinnedItemsBySessionID[event.session_id]?.contains { item in
            item.kind == .message && item.eventID == event.id
        } == true
    }

    func isPinned(_ file: ZFile) -> Bool {
        let sessionID = file.session_id ?? selectedSessionID
        guard let sessionID else { return false }
        return pinnedItemsBySessionID[sessionID]?.contains { item in
            item.kind == .file && item.file?.id == file.id
        } == true
    }

    func togglePin(_ event: ZEvent) {
        if let file = event.artifact ?? event.file {
            togglePin(file, eventID: event.id)
            return
        }
        let itemID = pinnedMessageItemID(eventID: event.id)
        if removePinnedItem(id: itemID, sessionID: event.session_id) {
            return
        }
        guard let body = pinnableText(for: event) else { return }
        let item = PinnedTimelineItem(
            id: itemID,
            sessionID: event.session_id,
            kind: .message,
            eventID: event.id,
            file: nil,
            title: pinnedMessageTitle(for: event),
            subtitle: localTimestampString(event.ts),
            body: trimmedPinnedBody(body),
            createdAt: event.ts,
            pinnedAt: ISO8601DateFormatter().string(from: Date())
        )
        addPinnedItem(item)
    }

    func togglePin(_ file: ZFile, eventID: String? = nil) {
        let sessionID = file.session_id ?? selectedSessionID
        guard let sessionID else { return }
        let itemID = pinnedFileItemID(fileID: file.id)
        if removePinnedItem(id: itemID, sessionID: sessionID) {
            return
        }
        let item = PinnedTimelineItem(
            id: itemID,
            sessionID: sessionID,
            kind: .file,
            eventID: eventID ?? file.event_id,
            file: file,
            title: file.title ?? file.filename,
            subtitle: pinnedFileSubtitle(file),
            body: file.text,
            createdAt: file.created_at,
            pinnedAt: ISO8601DateFormatter().string(from: Date())
        )
        addPinnedItem(item)
    }

    func removePinnedItem(_ item: PinnedTimelineItem) {
        _ = removePinnedItem(id: item.id, sessionID: item.sessionID)
    }

    func revealPinnedItem(_ item: PinnedTimelineItem) {
        if let file = item.file {
            Task { await findFileInChat(file) }
            return
        }
        guard let eventID = item.eventID else { return }
        requestScrollToEvent(eventID)
    }

    var pendingQueuedEvents: [ZEvent] {
        events
            .filter { isQueuedEventPending($0) }
            .sorted {
                let left = queuedPosition($0) ?? $0.position ?? $0.seq
                let right = queuedPosition($1) ?? $1.position ?? $1.seq
                if left != right {
                    return left < right
                }
                return $0.seq < $1.seq
            }
    }

    var pendingQueuedTurns: [ZQueuedTurn] {
        guard let selectedSessionID else { return [] }
        if let turns = queuedTurnsBySessionID[selectedSessionID] {
            return sortedQueuedTurns(turns)
        }
        return pendingQueuedEvents.compactMap(queuedTurn(from:))
    }

    func hasStartedQueuedEvent(_ event: ZEvent) -> Bool {
        guard event.type == "turn_queued", let queuedID = event.queued_id else { return false }
        return events.contains { $0.type == "turn_started" && $0.queued_id == queuedID }
    }

    func hasCancelledQueuedEvent(_ event: ZEvent) -> Bool {
        guard event.type == "turn_queued", let queuedID = event.queued_id else { return false }
        return events.contains { $0.type == "turn_unqueued" && $0.queued_id == queuedID }
    }

    func isQueuedEventPending(_ event: ZEvent) -> Bool {
        event.type == "turn_queued" && !hasStartedQueuedEvent(event) && !hasCancelledQueuedEvent(event)
    }

    private func makeDisplayEvents(from source: [ZEvent]) -> [ZEvent] {
        if showDebugEvents {
            return source
        }
        var latestDigestStatusIDByJob: [String: String] = [:]
        for event in source where isHandoffDigestStatus(event) {
            if let jobID = event.digest_job_id {
                latestDigestStatusIDByJob[jobID] = event.id
            }
        }
        let assistantRuns = Set(source.compactMap { event -> String? in
            guard event.type == "assistant_text",
                  hasVisibleText(event.text) else {
                return nil
            }
            return event.run_id
        })
        return source.filter { event in
            if isHandoffDigestStatus(event), let jobID = event.digest_job_id {
                return latestDigestStatusIDByJob[jobID] == event.id
            }
            switch event.type {
            case "session_created", "process_started", "provider_session", "raw_event", "cwd_fallback", "turn_unqueued", "turn_queue_updated", "turn_queue_reordered", "turn_queue_run_now", "turn_stopped":
                return false
            case "turn_queued":
                return false
            case "turn_started":
                return true
            case "turn_finished":
                guard hasVisibleText(event.result_text) else {
                    return false
                }
                if let runID = event.run_id, assistantRuns.contains(runID) {
                    return false
                }
                return true
            default:
                return true
            }
        }
    }

    private func shouldRebuildDisplayEvents(for source: [ZEvent]) -> Bool {
        showDebugEvents || source.contains { !isDisplayHiddenMetadataEvent($0) }
    }

    private func isDisplayHiddenMetadataEvent(_ event: ZEvent) -> Bool {
        switch event.type {
        case "session_created", "process_started", "provider_session", "raw_event", "cwd_fallback",
            "turn_queued", "turn_unqueued", "turn_queue_updated", "turn_queue_reordered", "turn_queue_run_now", "turn_stopped":
            return true
        default:
            return false
        }
    }

    private func isHandoffDigestStatus(_ event: ZEvent) -> Bool {
        switch event.type {
        case "handoff_digest_started", "handoff_digest_ready", "handoff_digest_sent", "handoff_digest_error":
            return true
        default:
            return false
        }
    }

    private func rebuildDisplayEvents() {
        // Inlined begin/end (rather than the closure-based AppSignpost.interval)
        // to avoid passing a MainActor-isolated closure into a nonisolated helper
        // under Swift 6 strict concurrency.
        let signpostState = AppSignpost.signposter.beginInterval("timeline.displayEvents")
        let perfStart = DispatchTime.now()
        let next = makeDisplayEvents(from: events)
        let ms = Double(DispatchTime.now().uptimeNanoseconds - perfStart.uptimeNanoseconds) / 1_000_000
        AppSignpost.signposter.endInterval("timeline.displayEvents", signpostState)
        if ms > 2 {
            AppLogger.info("PERF displayEvents in=\(events.count) out=\(next.count) ms=\(String(format: "%.1f", ms))")
        }
        if displayEvents != next {
            displayEvents = next
        }
    }

    private func setStatus(_ next: String) {
        if status != next {
            status = next
        }
    }

    private func setServerReachable(_ reachable: Bool) {
        if serverReachable != reachable {
            serverReachable = reachable
        }
    }

    private func setSocketLive(_ live: Bool) {
        if socketLive != live {
            socketLive = live
        }
    }

    private func shouldMaskTimelineBatch(
        oldCount: Int,
        newCount: Int,
        incomingCount: Int,
        oldTextWeight: Int = 0,
        newTextWeight: Int = 0
    ) -> Bool {
        incomingCount >= largeTimelineBatchEventThreshold ||
            abs(newCount - oldCount) >= largeTimelineBatchEventThreshold ||
            abs(newTextWeight - oldTextWeight) >= largeTimelineBatchCharacterThreshold
    }

    private var shouldPreserveRenderableTimelineDuringBackgroundRefresh: Bool {
        isRefreshingCachedDelta && hasRenderableSelectedTimeline
    }

    private func beginLargeTimelineBatchMask() {
        timelineBatchRevealTask?.cancel()
        timelineBatchRevealTask = nil
        if !isApplyingLargeTimelineBatch {
            isApplyingLargeTimelineBatch = true
        }
        if !hasRenderableSelectedTimeline {
            setStatus("Opening latest messages")
        }
    }

    private func scheduleLargeTimelineBatchReveal() {
        timelineBatchRevealTask?.cancel()
        timelineBatchRevealTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: 320_000_000)
            guard !Task.isCancelled else { return }
            self.isApplyingLargeTimelineBatch = false
            if !self.isRefreshingCachedDelta {
                self.setStatus(self.socketLive ? "Live" : "Server connected")
            }
        }
    }

    func queuedPrompt(for event: ZEvent) -> String {
        guard let queuedID = event.queued_id else {
            return event.prompt ?? "Queued message"
        }
        return events
            .filter { $0.queued_id == queuedID && ($0.type == "turn_queue_updated" || $0.type == "turn_queue_run_now" || $0.type == "turn_queued") }
            .sorted { $0.seq < $1.seq }
            .last?.prompt ?? event.prompt ?? "Queued message"
    }

    func queuedPrompt(for turn: ZQueuedTurn) -> String {
        let clean = turn.display_prompt?.trimmingCharacters(in: .whitespacesAndNewlines)
        if clean?.isEmpty == false {
            return clean ?? "Queued message"
        }
        let prompt = turn.prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        return prompt.isEmpty ? "Queued message" : prompt
    }

    func queuedPosition(_ event: ZEvent) -> Int? {
        guard let queuedID = event.queued_id else { return event.position }
        var position = event.position
        for item in events where item.seq >= event.seq {
            if item.queued_id == queuedID, let updated = item.position {
                position = updated
            }
            if let found = item.positions?.first(where: { $0.queued_id == queuedID }) {
                position = found.position
            }
        }
        return position
    }

    private func sortedQueuedTurns(_ turns: [ZQueuedTurn]) -> [ZQueuedTurn] {
        turns.sorted { lhs, rhs in
            let left = lhs.position ?? Int.max
            let right = rhs.position ?? Int.max
            if left != right {
                return left < right
            }
            let leftCreated = lhs.created_at ?? ""
            let rightCreated = rhs.created_at ?? ""
            if leftCreated != rightCreated {
                return leftCreated < rightCreated
            }
            return lhs.queued_id < rhs.queued_id
        }
    }

    private func queuedTurn(from event: ZEvent) -> ZQueuedTurn? {
        guard event.type == "turn_queued",
              let queuedID = event.queued_id else {
            return nil
        }
        return ZQueuedTurn(
            queued_id: queuedID,
            session_id: event.session_id,
            prompt: queuedPrompt(for: event),
            file_ids: event.file_ids ?? [],
            backend: event.backend,
            purpose: event.purpose,
            digest_job_id: event.digest_job_id,
            target_session_id: event.target_session_id,
            created_at: event.ts,
            position: queuedPosition(event) ?? event.position
        )
    }

    private func sessionID(for turn: ZQueuedTurn) -> String? {
        turn.session_id ?? selectedSessionID
    }

    @discardableResult
    private func applyAuthoritativeQueuedTurns(_ turns: [ZQueuedTurn]?, sessionID: String) -> Bool {
        guard let turns else { return false }
        let sortedTurns = sortedQueuedTurns(turns.map { turn in
            var next = turn
            if next.session_id == nil {
                next.session_id = sessionID
            }
            return next
        })
        var changed = false
        if queuedTurnsBySessionID[sessionID] != sortedTurns {
            queuedTurnsBySessionID[sessionID] = sortedTurns
            changed = true
        }

        let pendingIDs = Set(sortedTurns.map(\.queued_id))
        let oldEventCount = events.count
        events.removeAll { event in
            guard event.session_id == sessionID,
                  event.type == "turn_queued",
                  let queuedID = event.queued_id else {
                return false
            }
            return !pendingIDs.contains(queuedID)
        }
        if events.count != oldEventCount {
            changed = true
            if showDebugEvents {
                rebuildDisplayEvents()
            }
        }
        return changed
    }

    private func applyQueuedTurnState(from event: ZEvent) {
        guard let queuedID = event.queued_id else { return }
        switch event.type {
        case "turn_queued":
            guard var turn = queuedTurn(from: event) else { return }
            turn.session_id = event.session_id
            upsertQueuedTurn(turn, sessionID: event.session_id)
        case "turn_queue_updated":
            updateLocalQueuedTurn(sessionID: event.session_id, queuedID: queuedID) { turn in
                if let prompt = event.prompt {
                    turn.prompt = prompt
                    turn.display_prompt = prompt
                }
                if let fileIDs = event.file_ids {
                    turn.file_ids = fileIDs
                }
                if let position = event.position {
                    turn.position = position
                }
            }
        case "turn_queue_reordered":
            guard let positions = event.positions else { return }
            for position in positions {
                updateLocalQueuedTurn(sessionID: event.session_id, queuedID: position.queued_id) { turn in
                    turn.position = position.position
                }
            }
        case "turn_queue_run_now", "turn_started", "turn_unqueued":
            removeLocalQueuedTurn(sessionID: event.session_id, queuedID: queuedID)
        default:
            return
        }
    }

    private func applyQueuedTurnState(from events: [ZEvent]) {
        for event in events {
            applyQueuedTurnState(from: event)
        }
    }

    private func upsertQueuedTurn(_ turn: ZQueuedTurn, sessionID: String) {
        var turns = queuedTurnsBySessionID[sessionID] ?? []
        if let idx = turns.firstIndex(where: { $0.queued_id == turn.queued_id }) {
            turns[idx] = turn
        } else {
            turns.append(turn)
        }
        queuedTurnsBySessionID[sessionID] = sortedQueuedTurns(turns)
    }

    private func updateLocalQueuedTurn(sessionID: String, queuedID: String, mutate: (inout ZQueuedTurn) -> Void) {
        guard var turns = queuedTurnsBySessionID[sessionID],
              let idx = turns.firstIndex(where: { $0.queued_id == queuedID }) else {
            return
        }
        mutate(&turns[idx])
        queuedTurnsBySessionID[sessionID] = sortedQueuedTurns(turns)
    }

    private func removeLocalQueuedTurn(sessionID: String, queuedID: String) {
        if var turns = queuedTurnsBySessionID[sessionID] {
            let oldCount = turns.count
            turns.removeAll { $0.queued_id == queuedID }
            if turns.count != oldCount {
                queuedTurnsBySessionID[sessionID] = sortedQueuedTurns(turns)
            }
        }
        events.removeAll { $0.type == "turn_queued" && $0.queued_id == queuedID }
    }

    func rememberServerURL() {
        UserDefaults.standard.set(serverURLString, forKey: "serverURL")
    }

    func rememberAccessToken() {
        ZenithTokenStore.save(accessToken)
    }

    func markSelectedSessionRead(force: Bool = false) {
        if !force, let selectedSessionID, manuallyUnreadSessionIDs.contains(selectedSessionID) {
            return
        }
        markSessionRead(selectedSessionID)
    }

    func setSelectedTimelineAtBottom(_ atBottom: Bool) {
        guard selectedTimelineAtBottom != atBottom else { return }
        selectedTimelineAtBottom = atBottom
        if atBottom {
            markSelectedSessionRead()
        }
    }

    func markSessionRead(_ sessionID: String?) {
        guard let sessionID else { return }
        if let latestSeq = latestAgentEventSeq(for: sessionID) {
            setLastReadAgentSeq(latestSeq, for: sessionID)
            syncServerReadState(sessionID: sessionID, seq: latestSeq)
        }
        if unreadAgentSessionIDs.contains(sessionID) {
            unreadAgentSessionIDs.remove(sessionID)
        }
        if firstUnreadAgentSeqBySessionID[sessionID] != nil {
            firstUnreadAgentSeqBySessionID.removeValue(forKey: sessionID)
        }
        manuallyUnreadSessionIDs.remove(sessionID)
        UnreadNotificationController.shared.clear(sessionID: sessionID)
    }

    func markSessionUnread(_ sessionID: String?) {
        guard let sessionID, let latestSeq = latestAgentEventSeq(for: sessionID) else { return }
        setLastReadAgentSeq(max(0, latestSeq - 1), for: sessionID, allowDecrease: true)
        syncServerUnreadState(sessionID: sessionID)
        firstUnreadAgentSeqBySessionID[sessionID] = latestSeq
        unreadAgentSessionIDs.insert(sessionID)
        manuallyUnreadSessionIDs.insert(sessionID)
        if selectedSessionID == sessionID {
            selectedTimelineAtBottom = false
        }
    }

    func toggleSessionUnread(_ session: ZSession) {
        if unreadAgentSessionIDs.contains(session.id) {
            markSessionRead(session.id)
        } else {
            markSessionUnread(session.id)
        }
    }

    func canMarkSessionUnread(_ session: ZSession) -> Bool {
        if session.latest_agent_event_seq != nil {
            return true
        }
        guard session.id == selectedSessionID else { return false }
        return events.reversed().contains {
            $0.session_id == session.id && isAgentVisibleMessage($0)
        }
    }

    func markAgentUnread(sessionID: String, firstSeq: Int? = nil) {
        if let firstSeq {
            let existing = firstUnreadAgentSeqBySessionID[sessionID]
            let next = existing.map { min($0, firstSeq) } ?? firstSeq
            if existing != next {
                firstUnreadAgentSeqBySessionID[sessionID] = next
            }
        }
        guard !unreadAgentSessionIDs.contains(sessionID) else { return }
        unreadAgentSessionIDs.insert(sessionID)
    }

    private var readStateDefaultsKey: String {
        readStateDefaultsKey(namespace: serverCacheNamespace)
    }

    private func readStateDefaultsKey(namespace: String) -> String {
        "ZenithDock.lastReadAgentSeq.\(namespace)"
    }

    private var pinnedItemsDefaultsKey: String {
        pinnedItemsDefaultsKey(namespace: serverCacheNamespace)
    }

    private func pinnedItemsDefaultsKey(namespace: String) -> String {
        "ZenithDock.pinnedTimelineItems.\(namespace)"
    }

    private var draftPromptsDefaultsKey: String {
        draftPromptsDefaultsKey(namespace: serverCacheNamespace)
    }

    private func draftPromptsDefaultsKey(namespace: String) -> String {
        "ZenithDock.composerDrafts.\(namespace)"
    }

    private func loadReadState() -> [String: Int] {
        guard let data = UserDefaults.standard.data(forKey: readStateDefaultsKey),
              let decoded = try? JSONDecoder().decode([String: Int].self, from: data) else {
            return [:]
        }
        return decoded
    }

    private func saveReadState() {
        guard let data = try? JSONEncoder().encode(lastReadAgentSeqBySessionID) else { return }
        UserDefaults.standard.set(data, forKey: readStateDefaultsKey)
    }

    private func loadDraftPrompts() -> [String: String] {
        guard let data = UserDefaults.standard.data(forKey: draftPromptsDefaultsKey),
              let decoded = try? JSONDecoder().decode([String: String].self, from: data) else {
            return [:]
        }
        return decoded
    }

    private func scheduleDraftPromptsSave() {
        pendingDraftSave?.cancel()
        pendingDraftSave = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 450_000_000)
            guard let self, !Task.isCancelled else { return }
            if let data = try? JSONEncoder().encode(self.draftPromptsBySessionID) {
                UserDefaults.standard.set(data, forKey: self.draftPromptsDefaultsKey)
            }
        }
    }

    private func saveDraftPromptsNow() {
        pendingDraftSave?.cancel()
        pendingDraftSave = nil
        guard let data = try? JSONEncoder().encode(draftPromptsBySessionID) else { return }
        UserDefaults.standard.set(data, forKey: draftPromptsDefaultsKey)
    }

    func draftPrompt(for sessionID: String?) -> String {
        guard let sessionID else { return "" }
        return draftPromptsBySessionID[sessionID] ?? ""
    }

    func rememberDraftPrompt(_ text: String, for sessionID: String?) {
        guard let sessionID else { return }
        guard (draftPromptsBySessionID[sessionID] ?? "") != text else { return }
        if text.isEmpty {
            draftPromptsBySessionID.removeValue(forKey: sessionID)
        } else {
            draftPromptsBySessionID[sessionID] = text
        }
        scheduleDraftPromptsSave()
    }

    func clearDraftPrompt(for sessionID: String?) {
        guard let sessionID else { return }
        guard draftPromptsBySessionID.removeValue(forKey: sessionID) != nil else { return }
        saveDraftPromptsNow()
    }

    private func loadPinnedItems() -> [String: [PinnedTimelineItem]] {
        guard let data = UserDefaults.standard.data(forKey: pinnedItemsDefaultsKey),
              let decoded = try? JSONDecoder().decode([String: [PinnedTimelineItem]].self, from: data) else {
            return [:]
        }
        return decoded
    }

    private func savePinnedItems() {
        guard let data = try? JSONEncoder().encode(pinnedItemsBySessionID) else { return }
        UserDefaults.standard.set(data, forKey: pinnedItemsDefaultsKey)
    }

    private func addPinnedItem(_ item: PinnedTimelineItem) {
        var items = pinnedItemsBySessionID[item.sessionID] ?? []
        items.removeAll { $0.id == item.id }
        items.insert(item, at: 0)
        pinnedItemsBySessionID[item.sessionID] = items
        savePinnedItems()
    }

    @discardableResult
    private func removePinnedItem(id: String, sessionID: String) -> Bool {
        guard var items = pinnedItemsBySessionID[sessionID] else { return false }
        let oldCount = items.count
        items.removeAll { $0.id == id }
        guard items.count != oldCount else { return false }
        if items.isEmpty {
            pinnedItemsBySessionID.removeValue(forKey: sessionID)
        } else {
            pinnedItemsBySessionID[sessionID] = items
        }
        savePinnedItems()
        return true
    }

    private func pinnableText(for event: ZEvent) -> String? {
        let value = event.prompt ?? event.text ?? event.result_text ?? event.message ?? event.output ?? event.error
        let clean = value?.trimmingCharacters(in: .whitespacesAndNewlines)
        return clean?.isEmpty == false ? clean : nil
    }

    private func pinnedMessageTitle(for event: ZEvent) -> String {
        switch event.type {
        case "turn_started":
            return "User message"
        case "turn_finished":
            return "Assistant response"
        case "assistant_text":
            return "Assistant message"
        case "reasoning_summary":
            return "Reasoning note"
        case "tool_started", "tool_finished":
            if let toolName = event.tool?.name, !toolName.isEmpty {
                return "Tool: \(toolName)"
            }
            return "Tool output"
        default:
            return event.type.replacingOccurrences(of: "_", with: " ").capitalized
        }
    }

    private func pinnedFileSubtitle(_ file: ZFile) -> String {
        var parts: [String] = []
        if let contentType = file.content_type, !contentType.isEmpty {
            parts.append(contentType)
        }
        if let size = file.size {
            parts.append(byteString(size))
        }
        return parts.joined(separator: " · ")
    }

    private func trimmedPinnedBody(_ body: String) -> String {
        if body.count <= pinnedMessageBodyLimit {
            return body
        }
        return String(body.prefix(pinnedMessageBodyLimit)) + "\n\n[message trimmed in pinned shelf; use Find for the full timeline message]"
    }

    private func pinnedMessageItemID(eventID: String) -> String {
        "message:\(eventID)"
    }

    private func pinnedFileItemID(fileID: String) -> String {
        "file:\(fileID)"
    }

    private func setLastReadAgentSeq(_ seq: Int, for sessionID: String, allowDecrease: Bool = false) {
        let current = lastReadAgentSeqBySessionID[sessionID] ?? 0
        if allowDecrease {
            guard seq != current else { return }
        } else {
            guard seq > current else { return }
        }
        lastReadAgentSeqBySessionID[sessionID] = seq
        saveReadState()
    }

    private func adoptServerReadCursor(_ seq: Int, for sessionID: String, allowDecrease: Bool = false) {
        if let pending = pendingReadSyncBySessionID[sessionID], pending > seq {
            return
        }
        setLastReadAgentSeq(seq, for: sessionID, allowDecrease: allowDecrease)
    }

    private struct ReadSessionResponse: Codable {
        let session: ZSession
    }

    private struct ReadSessionBody: Codable {
        let last_read_agent_event_seq: Int
    }

    private struct EmptyReadSessionBody: Codable {}

    private func syncServerReadState(sessionID: String, seq: Int) {
        guard serverReachable else { return }
        if let serverSeq = sessions.first(where: { $0.id == sessionID })?.last_read_agent_event_seq,
           serverSeq >= seq {
            return
        }
        if let pending = pendingReadSyncBySessionID[sessionID], pending >= seq { return }
        pendingReadSyncBySessionID[sessionID] = seq
        Task {
            do {
                let response: ReadSessionResponse = try await api.post(
                    "/api/sessions/\(sessionID)/read",
                    body: ReadSessionBody(last_read_agent_event_seq: seq)
                )
                await MainActor.run {
                    self.pendingReadSyncBySessionID.removeValue(forKey: sessionID)
                    self.applyServerReadSession(response.session, allowReadCursorDecrease: false)
                }
            } catch {
                await MainActor.run {
                    self.pendingReadSyncBySessionID.removeValue(forKey: sessionID)
                    AppLogger.warning("sync read failed session=\(sessionID) \(self.serverErrorMessage(error) ?? "\(error)")")
                }
            }
        }
    }

    private func syncServerUnreadState(sessionID: String) {
        guard serverReachable else { return }
        Task {
            do {
                let response: ReadSessionResponse = try await api.post(
                    "/api/sessions/\(sessionID)/unread",
                    body: EmptyReadSessionBody()
                )
                await MainActor.run {
                    self.applyServerReadSession(response.session, allowReadCursorDecrease: true)
                }
            } catch {
                await MainActor.run {
                    AppLogger.warning("sync unread failed session=\(sessionID) \(self.serverErrorMessage(error) ?? "\(error)")")
                }
            }
        }
    }

    private func applyServerReadSession(_ session: ZSession, allowReadCursorDecrease: Bool) {
        replaceSessionFromServer(session)
        if let readSeq = session.last_read_agent_event_seq {
            setLastReadAgentSeq(readSeq, for: session.id, allowDecrease: allowReadCursorDecrease)
            if let latestSeq = session.latest_agent_event_seq, readSeq >= latestSeq {
                manuallyUnreadSessionIDs.remove(session.id)
                unreadAgentSessionIDs.remove(session.id)
                firstUnreadAgentSeqBySessionID.removeValue(forKey: session.id)
            }
        }
        reconcileUnreadFromSessions()
    }

    private func latestAgentEventSeq(for sessionID: String) -> Int? {
        let sessionSeq = sessions.first(where: { $0.id == sessionID })?.latest_agent_event_seq
        let eventSeq = sessionID == selectedSessionID
            ? events.reversed().first {
                $0.session_id == sessionID && isAgentVisibleMessage($0)
            }?.seq
            : nil
        return [sessionSeq, eventSeq].compactMap { $0 }.max()
    }

    private func reconcileUnreadFromSessions() {
        let knownSessionIDs = Set(sessions.map(\.id))
        var nextUnread = unreadAgentSessionIDs.intersection(knownSessionIDs)
        var nextFirstUnread = firstUnreadAgentSeqBySessionID.filter { knownSessionIDs.contains($0.key) }
        var nextManualUnread = manuallyUnreadSessionIDs.intersection(knownSessionIDs)

        for session in sessions {
            guard let latestSeq = session.latest_agent_event_seq else { continue }
            let serverManualUnread = session.manual_unread == true
            if let serverReadSeq = session.last_read_agent_event_seq {
                adoptServerReadCursor(
                    serverReadSeq,
                    for: session.id,
                    allowDecrease: serverManualUnread
                )
            }
            if serverManualUnread, session.id != selectedSessionID {
                nextManualUnread.insert(session.id)
            }
            if session.id == selectedSessionID, selectedTimelineAtBottom, NSApp.isActive {
                markSessionRead(session.id)
                nextUnread.remove(session.id)
                nextFirstUnread.removeValue(forKey: session.id)
                nextManualUnread.remove(session.id)
                continue
            }
            let lastReadSeq = lastReadAgentSeqBySessionID[session.id] ?? 0
            if serverManualUnread || latestSeq > lastReadSeq {
                nextUnread.insert(session.id)
                let nextSeq = lastReadSeq + 1
                if let existing = nextFirstUnread[session.id] {
                    nextFirstUnread[session.id] = min(existing, nextSeq)
                } else {
                    nextFirstUnread[session.id] = nextSeq
                }
            } else {
                nextUnread.remove(session.id)
                nextFirstUnread.removeValue(forKey: session.id)
                nextManualUnread.remove(session.id)
            }
        }
        if unreadAgentSessionIDs != nextUnread {
            unreadAgentSessionIDs = nextUnread
        }
        if firstUnreadAgentSeqBySessionID != nextFirstUnread {
            firstUnreadAgentSeqBySessionID = nextFirstUnread
        }
        manuallyUnreadSessionIDs = nextManualUnread
    }

    private func reconcileUnreadNotifications(previousUnreadSessionIDs: Set<String>) {
        let candidates = unreadNotificationTracker.reconcile(
            sessions: sessions,
            previousUnreadSessionIDs: previousUnreadSessionIDs,
            unreadSessionIDs: unreadAgentSessionIDs
        )
        guard !NSApp.isActive else { return }
        for candidate in candidates {
            deliverUnreadNotification(candidate)
        }
    }

    private func notificationCandidate(for event: ZEvent) -> ZUnreadNotificationCandidate? {
        unreadNotificationTracker.observeLiveEvent(
            event,
            session: sessions.first { $0.id == event.session_id },
            wasUnread: unreadAgentSessionIDs.contains(event.session_id)
        )
    }

    private func deliverUnreadNotification(_ candidate: ZUnreadNotificationCandidate) {
        guard !NSApp.isActive else { return }
        UnreadNotificationController.shared.notify(
            sessionID: candidate.sessionID,
            title: candidate.title,
            backend: candidate.backend,
            eventType: candidate.eventType,
            eventSeq: candidate.eventSeq,
            unreadCount: unreadAgentSessionIDs.count
        )
    }

    func isAgentVisibleMessage(_ event: ZEvent) -> Bool {
        switch event.type {
        case "assistant_text":
            return hasVisibleText(event.text)
        case "turn_finished":
            return hasVisibleText(event.result_text)
        case "error", "artifact_created":
            return true
        case "job_ran", "job_error":
            return event.job != nil
        default:
            return false
        }
    }

    private func hasVisibleText(_ value: String?) -> Bool {
        guard let value else { return false }
        return value.unicodeScalars.contains { scalar in
            !CharacterSet.whitespacesAndNewlines.contains(scalar)
        }
    }

    func applyServerSettings(serverURL: String, accessToken: String) async {
        let cleanURL = serverURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanURL.isEmpty else { return }
        let oldEndpoint = ZenithServerURL.normalized(serverURLString, default: defaultAgentServerURLString)
        let newEndpoint = ZenithServerURL.normalized(cleanURL, default: defaultAgentServerURLString)
        serverURLString = cleanURL
        serverIdentity = Self.loadServerIdentity(for: cleanURL)
        self.accessToken = accessToken
        rememberServerURL()
        rememberAccessToken()
        if oldEndpoint != newEndpoint {
            resetEndpointState()
        }
        await refresh()
    }

    private func resetEndpointState() {
        pendingCacheWrite?.cancel()
        pendingDraftSave?.cancel()
        pendingDraftSave = nil
        timelineBatchRevealTask?.cancel()
        timelineBatchRevealTask = nil
        webSocket?.cancel(with: .goingAway, reason: nil)
        webSocket = nil
        webSocketSessionID = nil
        setSocketLive(false)
        selectedSessionID = nil
        loadedSessionID = nil
        isSelectingSession = false
        sessions = []
        events = []
        displayEvents = []
        isApplyingLargeTimelineBatch = false
        launchDeferredText = nil
        uploads = []
        sessionFiles = []
        sessionVideoFiles = []
        sessionFilesTotal = nil
        sessionFilesHasMore = false
        sessionFilesNextOffset = 0
        jobs = []
        activeSessionIDs = []
        latestSeenSeq = 0
        omittedHistoryEventCount = 0
        memoryChatCache = [:]
        memoryChatCacheOrder = []
        verifiedTimelineTailsBySessionID = [:]
        lastReadAgentSeqBySessionID = loadReadState()
        draftPromptsBySessionID = loadDraftPrompts()
        pinnedItemsBySessionID = loadPinnedItems()
        unreadAgentSessionIDs = []
        firstUnreadAgentSeqBySessionID = [:]
        manuallyUnreadSessionIDs = []
        unreadNotificationTracker.reset()
        UnreadNotificationController.shared.clearAll()
        selectedTimelineAtBottom = true
        connectionProblemText = nil
    }

    private func adoptServerIdentity(_ value: String?) {
        guard let clean = value?.trimmingCharacters(in: .whitespacesAndNewlines),
              !clean.isEmpty else { return }
        let oldNamespace = serverCacheNamespace
        guard serverIdentity != clean else {
            saveServerIdentity(clean, for: serverURLString)
            return
        }
        serverIdentity = clean
        saveServerIdentity(clean, for: serverURLString)
        let newNamespace = serverCacheNamespace
        guard oldNamespace != newNamespace else { return }
        migrateLocalServerState(from: oldNamespace, to: newNamespace)
        resetEndpointState()
        AppLogger.info("adopted server identity namespace=\(newNamespace)")
    }

    private func migrateLocalServerState(from oldNamespace: String, to newNamespace: String) {
        guard oldNamespace != newNamespace else { return }
        let oldReadKey = readStateDefaultsKey(namespace: oldNamespace)
        let newReadKey = readStateDefaultsKey(namespace: newNamespace)
        if UserDefaults.standard.data(forKey: newReadKey) == nil,
           let oldData = UserDefaults.standard.data(forKey: oldReadKey) {
            UserDefaults.standard.set(oldData, forKey: newReadKey)
        }
        let oldPinnedKey = pinnedItemsDefaultsKey(namespace: oldNamespace)
        let newPinnedKey = pinnedItemsDefaultsKey(namespace: newNamespace)
        if UserDefaults.standard.data(forKey: newPinnedKey) == nil,
           let oldData = UserDefaults.standard.data(forKey: oldPinnedKey) {
            UserDefaults.standard.set(oldData, forKey: newPinnedKey)
        }
        let oldDraftKey = draftPromptsDefaultsKey(namespace: oldNamespace)
        let newDraftKey = draftPromptsDefaultsKey(namespace: newNamespace)
        if UserDefaults.standard.data(forKey: newDraftKey) == nil,
           let oldData = UserDefaults.standard.data(forKey: oldDraftKey) {
            UserDefaults.standard.set(oldData, forKey: newDraftKey)
        }
        let oldDirectory = chatCacheDirectory(namespace: oldNamespace)
        let newDirectory = chatCacheDirectory(namespace: newNamespace)
        guard FileManager.default.fileExists(atPath: oldDirectory.path),
              !FileManager.default.fileExists(atPath: newDirectory.path) else {
            return
        }
        do {
            try FileManager.default.createDirectory(at: newDirectory.deletingLastPathComponent(), withIntermediateDirectories: true)
            try FileManager.default.copyItem(at: oldDirectory, to: newDirectory)
        } catch {
            AppLogger.warning("server identity cache migration failed \(error)")
        }
    }

    func startLiveTracking() async {
        configureUnreadNotificationsIfNeeded()
        guard !liveTrackingStarted else {
            AppLogger.info("start live tracking skipped existing loop")
            return
        }
        liveTrackingStarted = true
        defer {
            liveTrackingStarted = false
            AppLogger.info("stop live tracking")
        }
        AppLogger.info("start live tracking")
        await refresh(showErrors: false)
        var tick = 0
        while !Task.isCancelled {
            try? await Task.sleep(nanoseconds: 5_000_000_000)
            tick += 1
            await refreshHealth(showErrors: false)
            if serverReachable {
                await refreshSessions(showErrors: false)
            }
            if tick % 6 == 0 {
                await refreshJobs(showErrors: false)
            }
            if let sid = selectedSessionID, serverReachable, !socketLive, loadingSessionID == nil {
                connectEvents(sessionID: sid, after: lastSeq)
            }
        }
    }

    private func configureUnreadNotificationsIfNeeded() {
        guard !unreadNotificationsConfigured else { return }
        unreadNotificationsConfigured = true
        UnreadNotificationController.shared.configure { [weak self] sessionID in
            Task { @MainActor [weak self] in
                await self?.select(sessionID: sessionID)
            }
        }
        UnreadNotificationController.shared.requestAuthorizationIfNeeded()
        UnreadNotificationController.shared.updateBadge(unreadCount: unreadAgentSessionIDs.count)
    }

    func refresh(showErrors: Bool = true) async {
        cleanServerURL()
        rememberServerURL()
        await refreshHealth(showErrors: showErrors)
        if serverReachable {
            await refreshRuntimeCatalog(showErrors: false)
        } else {
            return
        }
        await refreshSessions(showErrors: showErrors)
        await refreshJobs(showErrors: showErrors)
    }

    func refreshRuntimeCatalog(showErrors: Bool = false) async {
        do {
            let res: ZRuntimeCatalogSnapshot = try await api.get("/api/runtime/catalog")
            if runtimeCatalog != res {
                runtimeCatalog = res
                AppLogger.info("loaded runtime catalog backends=\(res.backends.keys.sorted().joined(separator: ","))")
            }
        } catch {
            AppLogger.warning("runtime catalog failed \(serverErrorMessage(error) ?? "\(error)")")
            if showErrors {
                reportServerError(error)
            }
        }
    }

    func refreshHealth(showErrors: Bool = true) async {
        do {
            struct Response: Codable {
                let ok: Bool
                let api_contract_version: Int?
                let server_identity: String?
                let default_cwd: String?
                let active: [String]
                let jobs: Int?
            }
            let res: Response = try await api.get("/api/health")
            guard isCompatibleAgentAPIContract(res.api_contract_version) else {
                markServerUpgradeRequired(version: res.api_contract_version)
                return
            }
            setServerReachable(res.ok)
            adoptServerIdentity(res.server_identity)
            if let cleanCwd = res.default_cwd?.trimmingCharacters(in: .whitespacesAndNewlines), !cleanCwd.isEmpty {
                if defaultCwd != cleanCwd {
                    defaultCwd = cleanCwd
                }
            }
            let activeIDs = Set(res.active)
            if activeSessionIDs != activeIDs {
                activeSessionIDs = activeIDs
            }
            if lastHealthAt == nil || Date().timeIntervalSince(lastHealthAt ?? .distantPast) > 60 {
                lastHealthAt = Date()
            }
            if connectionProblemText != nil {
                connectionProblemText = nil
            }
            syncSelectedRunningState()
            setStatus(socketLive ? "Live" : "Server connected")
            if let sid = selectedSessionID, !activeSessionIDs.contains(sid), processSnapshot?.active == true {
                processSnapshot = nil
                processLogTail = nil
            }
        } catch {
            setServerReachable(false)
            setSocketLive(false)
            if !activeSessionIDs.isEmpty {
                activeSessionIDs = []
            }
            syncSelectedRunningState()
            setStatus("Server offline")
            let message = serverErrorMessage(error) ?? "\(error)"
            if connectionProblemText != message {
                connectionProblemText = message
            }
            AppLogger.warning("health failed \(message)")
            if showErrors {
                reportServerError(error)
            }
        }
    }

    private func isCompatibleAgentAPIContract(_ version: Int?) -> Bool {
        (version ?? 0) >= minimumAgentAPIContractVersion
    }

    private func markServerUpgradeRequired(version: Int?) {
        setServerReachable(false)
        setSocketLive(false)
        if !activeSessionIDs.isEmpty {
            activeSessionIDs = []
        }
        syncSelectedRunningState()
        setStatus("Server upgrade required")
        connectionProblemText = "Server upgrade required: app build needs agent API v\(minimumAgentAPIContractVersion), but this server reports v\(version ?? 0). Redeploy/restart the ZenithDock server."
        AppLogger.warning("server upgrade required contract=\(version ?? 0) required=\(minimumAgentAPIContractVersion)")
    }

    func refreshSessions(showErrors: Bool = true) async {
        do {
            struct Response: Codable { let sessions: [ZSession] }
            let res: Response = try await api.get("/api/sessions")
            let previousUnreadSessionIDs = unreadAgentSessionIDs
            setServerReachable(true)
            if !socketLive {
                setStatus("Server connected")
            }
            let loadedAt = Date()
            let resolvedSessions = sessionsWithPendingRuntime(res.sessions)
            lastLoadedAt = loadedAt
            if sessions != resolvedSessions {
                sessions = resolvedSessions
                AppLogger.info("loaded sessions count=\(sessions.count)")
            }
            reconcileUnreadFromSessions()
            reconcileUnreadNotifications(previousUnreadSessionIDs: previousUnreadSessionIDs)
            if selectedSessionID == nil || !sessions.contains(where: { $0.id == selectedSessionID }) {
                selectedSessionID = sessions.first?.id
                if let selectedSessionID {
                    await select(sessionID: selectedSessionID)
                }
            }
        } catch {
            AppLogger.warning("load sessions failed \(serverErrorMessage(error) ?? "\(error)")")
            if showErrors {
                reportServerError(error)
            }
        }
    }

    func refreshJobs(showErrors: Bool = true) async {
        do {
            struct Response: Codable { let jobs: [ZJob] }
            let res: Response = try await api.get("/api/jobs")
            setServerReachable(true)
            if jobs != res.jobs {
                jobs = res.jobs
            }
        } catch {
            if showErrors {
                reportServerError(error)
            }
        }
    }

    func createSession(folder: String = "General", title: String = "New chat") async {
        do {
            struct Body: Codable {
                var title: String
                var folder: String
                var cwd: String
                var backend = "claude"
            }
            struct Response: Codable { let session: ZSession }
            let cleanFolder = folder.trimmingCharacters(in: .whitespacesAndNewlines)
            let res: Response = try await api.post("/api/sessions", body: Body(
                title: title,
                folder: cleanFolder.isEmpty ? "General" : cleanFolder,
                cwd: defaultCwd
            ))
            sessions.insert(res.session, at: 0)
            await select(sessionID: res.session.id)
        } catch {
            reportServerError(error)
        }
    }

    func resumeSession(backend: String, providerID: String, title: String, folder: String, cwd: String) async {
        let cleanID = providerID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanID.isEmpty else { return }
        struct Body: Codable {
            let title: String?
            let folder: String?
            let cwd: String?
            let backend: String
            let provider_session_id: String
        }
        do {
            struct Response: Codable { let session: ZSession }
            let cleanTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
            let cleanFolder = folder.trimmingCharacters(in: .whitespacesAndNewlines)
            let cleanCwd = cwd.trimmingCharacters(in: .whitespacesAndNewlines)
            let res: Response = try await api.post("/api/sessions", body: Body(
                title: cleanTitle.isEmpty ? nil : cleanTitle,
                folder: cleanFolder.isEmpty ? "General" : cleanFolder,
                cwd: cleanCwd.isEmpty ? defaultCwd : cleanCwd,
                backend: backend,
                provider_session_id: cleanID
            ))
            sessions.insert(res.session, at: 0)
            await select(sessionID: res.session.id)
        } catch {
            reportServerError(error)
        }
    }

    // End-to-end switch instrumentation: timestamp the click and the load path,
    // then TimelineView reports when the new chat actually appears on screen.
    private var pendingSwitch: (sessionID: String, at: DispatchTime, path: String)?

    private func noteSwitchStart(_ sessionID: String) {
        pendingSwitch = (sessionID, DispatchTime.now(), "pending")
    }

    private func noteSwitchPath(_ sessionID: String, _ path: String) {
        guard var p = pendingSwitch, p.sessionID == sessionID else { return }
        p.path = path
        pendingSwitch = p
    }

    func noteSwitchRevealed(_ sessionID: String) {
        guard let p = pendingSwitch, p.sessionID == sessionID else { return }
        let ms = Double(DispatchTime.now().uptimeNanoseconds - p.at.uptimeNanoseconds) / 1_000_000
        pendingSwitch = nil
        AppLogger.info("PERF switchReveal session=\(sessionID) path=\(p.path) ms=\(String(format: "%.0f", ms))")
    }

    func select(sessionID: String) async {
        if sessionID != loadedSessionID {
            noteSwitchStart(sessionID)
        }
        timelineBatchRevealTask?.cancel()
        timelineBatchRevealTask = nil
        isApplyingLargeTimelineBatch = false
        if loadingSessionID == sessionID {
            if loadedSessionID != sessionID, let cached = memoryCachedChat(sessionID) {
                applyCachedChat(cached)
                setStatus("Loaded memory chat")
            }
            selectedSessionID = sessionID
            markSessionRead(sessionID)
            syncSelectedRunningState()
            return
        }
        if selectedSessionID != sessionID {
            rememberSelectedChatInMemory()
        }
        let warmCachedChat = memoryCachedChat(sessionID)
        selectionGeneration += 1
        let generation = selectionGeneration
        loadingSessionID = sessionID
        isSelectingSession = true
        isRefreshingCachedDelta = false
        defer {
            if loadingSessionID == sessionID {
                loadingSessionID = nil
            }
            if selectedSessionID == sessionID, selectionGeneration == generation {
                isSelectingSession = false
            }
        }
        var loadedFromCache = false
        if let warmCachedChat {
            noteSwitchPath(sessionID, "memory")
            applyCachedChat(warmCachedChat)
            loadedFromCache = true
            setStatus("Loaded memory chat")
            AppLogger.info("loaded memory cache before selection session=\(sessionID) cached_events=\(warmCachedChat.events.count) rendered_events=\(events.count) omitted_before=\(omittedHistoryEventCount)")
        }
        selectedSessionID = sessionID
        syncSelectedRunningState()
        webSocket?.cancel(with: .goingAway, reason: nil)
        webSocket = nil
        webSocketSessionID = nil
        pendingStreamFlushTask?.cancel()
        pendingStreamFlushTask = nil
        pendingStreamEvents.removeAll()
        pendingStreamSessionID = nil
        setSocketLive(false)
        setStatus(loadedFromCache ? (serverReachable ? "Server connected" : "Server offline") : (serverReachable ? "Loading chat" : "Server offline"))
        if processSnapshot != nil { processSnapshot = nil }
        if processLogTail != nil { processLogTail = nil }
        if tmuxSnapshot != nil { tmuxSnapshot = nil }
        if tmuxCapture != nil { tmuxCapture = nil }
        markSessionRead(sessionID)
        AppLogger.info("select session=\(sessionID)")
        if !loadedFromCache {
            events = []
            rebuildDisplayEvents()
            if !uploads.isEmpty { uploads = [] }
            if !sessionFiles.isEmpty { sessionFiles = [] }
            if !sessionVideoFiles.isEmpty { sessionVideoFiles = [] }
            if sessionFilesTotal != nil { sessionFilesTotal = nil }
            if sessionFilesHasMore { sessionFilesHasMore = false }
            if sessionFilesNextOffset != 0 { sessionFilesNextOffset = 0 }
            if omittedHistoryEventCount != 0 { omittedHistoryEventCount = 0 }
            loadedSessionID = nil
            latestSeenSeq = 0
            let cacheURL = chatCacheURL(sessionID)
            if let cached = await Self.loadCachedChat(from: cacheURL) {
                guard selectedSessionID == sessionID, selectionGeneration == generation else {
                    AppLogger.info("drop stale cache response session=\(sessionID)")
                    return
                }
                noteSwitchPath(sessionID, "disk")
                rememberChatCache(cached)
                applyCachedChat(cached)
                loadedFromCache = true
                setStatus("Loaded cached chat")
                AppLogger.info("loaded disk cache session=\(sessionID) events=\(cached.events.count) omitted_before=\(cached.omittedHistoryEventCount)")
            }
        }
        if loadedFromCache {
            let cachedLastSeq = lastSeq
            syncSelectedRunningState()
            if cachedTailIsKnownFresh(sessionID: sessionID, cachedLastSeq: cachedLastSeq),
               queuedTurnsBySessionID[sessionID] != nil {
                loadedSessionID = sessionID
                connectEvents(sessionID: sessionID, after: lastSeq)
                AppLogger.info("skip cached latest tail session=\(sessionID) cached_latest=\(cachedLastSeq)")
                return
            }
            Task {
                await refreshCachedSessionLatestTail(
                    sessionID: sessionID,
                    generation: generation,
                    cachedLastSeq: cachedLastSeq
                )
            }
            return
        }
        noteSwitchPath(sessionID, "network")
        await refreshLatestSessionSnapshot(
            sessionID: sessionID,
            generation: generation,
            reportErrors: true,
            refreshFiles: true,
            connectStream: true
        )
    }

    private func cachedTailIsKnownFresh(sessionID: String, cachedLastSeq: Int) -> Bool {
        guard serverReachable, cachedLastSeq > 0 else { return false }
        guard let sessionListLoadedAt = lastLoadedAt,
              Date().timeIntervalSince(sessionListLoadedAt) <= cachedTailFreshnessWindow,
              let knownLatestSeq = sessions.first(where: { $0.id == sessionID })?.latest_event_seq else {
            return false
        }
        guard knownLatestSeq <= cachedLastSeq,
              let verified = verifiedTimelineTailsBySessionID[sessionID],
              verified.latestSeq == cachedLastSeq,
              Date().timeIntervalSince(verified.verifiedAt) <= cachedTailFreshnessWindow else {
            return false
        }
        return verified.eventIDs == timelineTailEventIDs(sessionID: sessionID)
    }

    private func markTimelineTailVerified(sessionID: String) {
        verifiedTimelineTailsBySessionID[sessionID] = VerifiedTimelineTail(
            latestSeq: lastSeq,
            eventIDs: timelineTailEventIDs(sessionID: sessionID),
            verifiedAt: Date()
        )
    }

    private func timelineTailEventIDs(sessionID: String) -> [String] {
        events
            .lazy
            .filter { $0.session_id == sessionID }
            .suffix(maxCachedTimelineEvents)
            .map(\.id)
    }

    private func refreshCachedSessionLatestTail(sessionID: String, generation: Int, cachedLastSeq: Int) async {
        guard selectedSessionID == sessionID,
              selectionGeneration == generation else {
            return
        }
        isRefreshingCachedDelta = true
        defer {
            if selectedSessionID == sessionID, selectionGeneration == generation {
                isRefreshingCachedDelta = false
            }
        }
        do {
            let res: SessionEventsResponse = try await api.get(
                "/api/sessions/\(sessionID)",
                queryItems: [
                    URLQueryItem(name: "limit", value: "\(maxCachedTimelineEvents)"),
                    URLQueryItem(name: "tail", value: "true"),
                    URLQueryItem(name: "visible", value: "true")
                ]
            )
            guard selectedSessionID == sessionID, selectionGeneration == generation else {
                AppLogger.info("drop stale cached tail session=\(sessionID)")
                return
            }
            let previousSeq = lastSeq
            let changedTimeline = applySessionEventSnapshot(res, sessionID: sessionID, preserveExisting: true)
            markSessionRead(sessionID)
            loadedSessionID = sessionID
            markTimelineTailVerified(sessionID: sessionID)
            saveSelectedChatCache()
            connectEvents(sessionID: sessionID, after: lastSeq)
            syncSelectedRunningState()
            AppLogger.info("loaded cached latest tail session=\(sessionID) previous=\(previousSeq) cached=\(cachedLastSeq) latest=\(lastSeq) events=\(events.count) changed=\(changedTimeline) omitted_before=\(omittedHistoryEventCount)")
        } catch {
            AppLogger.warning("cached tail refresh failed session=\(sessionID) \(serverErrorMessage(error) ?? "\(error)")")
        }
    }

    private func refreshLatestSessionSnapshot(
        sessionID: String,
        generation: Int,
        reportErrors: Bool,
        refreshFiles: Bool,
        connectStream: Bool
    ) async {
        guard selectedSessionID == sessionID, selectionGeneration == generation else {
            AppLogger.info("drop stale selection before network session=\(sessionID)")
            return
        }
        do {
            let netStart = DispatchTime.now()
            let res: SessionEventsResponse = try await api.get(
                "/api/sessions/\(sessionID)",
                queryItems: [
                    URLQueryItem(name: "limit", value: "\(initialSessionEventLimit)"),
                    URLQueryItem(name: "tail", value: "true"),
                    URLQueryItem(name: "visible", value: "true")
                ]
            )
            let netMs = Double(DispatchTime.now().uptimeNanoseconds - netStart.uptimeNanoseconds) / 1_000_000
            AppLogger.info("PERF snapshotFetch session=\(sessionID) events=\(res.events.count) ms=\(String(format: "%.0f", netMs))")
            if let idx = sessions.firstIndex(where: { $0.id == sessionID }) {
                replaceSessionFromServer(res.session, at: idx)
            }
            guard selectedSessionID == sessionID, selectionGeneration == generation else {
                AppLogger.info("drop stale selection response session=\(sessionID)")
                return
            }
            applySessionEventSnapshot(res, sessionID: sessionID)
            markSessionRead(sessionID)
            setStatus("Loaded latest chat")
            refreshSessionFilesFromLoadedEvents()
            loadedSessionID = sessionID
            markTimelineTailVerified(sessionID: sessionID)
            AppLogger.info("selected session=\(sessionID) events=\(events.count) omitted_before=\(omittedHistoryEventCount)")
            saveSelectedChatCache()
            if refreshFiles {
                Task { await loadSessionFiles(sessionID: sessionID, generation: generation) }
                Task { await loadSessionVideoFiles(sessionID: sessionID, generation: generation) }
            }
            if connectStream {
                connectEvents(sessionID: sessionID, after: lastSeq)
            }
            syncSelectedRunningState()
        } catch {
            AppLogger.error("select failed session=\(sessionID) \(serverErrorMessage(error) ?? "\(error)")")
            if reportErrors {
                reportServerError(error)
            }
        }
    }

    @discardableResult
    func loadOlderHistory() async -> OlderHistoryLoadResult {
        guard let sid = selectedSessionID,
              omittedHistoryEventCount > 0,
              !isLoadingOlderHistory,
              events.count < maxLoadedTimelineEvents,
              let before = events.map(\.seq).min() else {
            return OlderHistoryLoadResult(addedCount: 0, firstAddedEventID: nil)
        }
        let generation = selectionGeneration
        let requestedCapacity = maxLoadedTimelineEvents - events.count

        isLoadingOlderHistory = true
        defer { isLoadingOlderHistory = false }

        do {
            struct Response: Codable {
                let session: ZSession
                let events: [ZEvent]
                let events_omitted_before: Int?
            }
            var cursorBefore = before
            var remainingOmitted = omittedHistoryEventCount
            var latestSession: ZSession?
            var receivedCount = 0
            var skippedInvisiblePages = 0
            var skippedNonPrimaryPages = 0
            var knownIDs = Set(events.map(\.id))
            var older: [ZEvent] = []

            for _ in 0..<8 {
                let remainingCapacity = requestedCapacity - older.count
                guard remainingCapacity > 0 else { break }
                let res: Response = try await api.get(
                    "/api/sessions/\(sid)",
                    queryItems: [
                        URLQueryItem(name: "before", value: "\(cursorBefore)"),
                        URLQueryItem(name: "limit", value: "\(min(olderHistoryPageLimit, remainingCapacity))"),
                        URLQueryItem(name: "tail", value: "true"),
                        URLQueryItem(name: "visible", value: "true")
                    ]
                )
                latestSession = res.session
                receivedCount += res.events.count
                remainingOmitted = res.events_omitted_before ?? 0

                let visibleOlder = timelineEvents(from: res.events).filter { event in
                    guard !knownIDs.contains(event.id) else { return false }
                    knownIDs.insert(event.id)
                    return true
                }
                older.append(contentsOf: visibleOlder)
                if visibleOlder.contains(where: isPrimaryTimelinePageEvent) ||
                    res.events.isEmpty ||
                    remainingOmitted <= 0 ||
                    older.count >= requestedCapacity {
                    break
                }

                guard let nextBefore = res.events.map(\.seq).min(),
                      nextBefore < cursorBefore else {
                    break
                }
                if visibleOlder.isEmpty {
                    skippedInvisiblePages += 1
                } else {
                    skippedNonPrimaryPages += 1
                }
                cursorBefore = nextBefore
            }

            guard selectedSessionID == sid, selectionGeneration == generation else {
                AppLogger.info("drop stale older history session=\(sid)")
                return OlderHistoryLoadResult(addedCount: 0, firstAddedEventID: nil)
            }

            // `events` intentionally represents one bounded ordered window with no
            // omitted middle segment. Its high end is the websocket resume tail, so
            // older paging must never evict it or splice history across a hidden gap.
            // If that window moved while this request was suspended, discard the page.
            let currentBefore = events.map(\.seq).min()
            guard currentBefore == before else {
                AppLogger.info("drop stale older history boundary session=\(sid) before=\(before) current_before=\(currentBefore ?? 0)")
                return OlderHistoryLoadResult(addedCount: 0, firstAddedEventID: nil)
            }

            let currentIDs = Set(events.map(\.id))
            let sortedOlder = older
                .filter { $0.seq < before && !currentIDs.contains($0.id) }
                .sorted { $0.seq < $1.seq }
            let availableCapacity = max(0, maxLoadedTimelineEvents - events.count)
            let acceptedOlder = Array(sortedOlder.suffix(availableCapacity))
            let droppedFetchedCount = sortedOlder.count - acceptedOlder.count
            let nextOmittedHistoryEventCount = remainingOmitted + droppedFetchedCount
            let firstAddedEventID = acceptedOlder.first(where: isPrimaryTimelinePageEvent)?.id ?? acceptedOlder.first?.id
            let previousTailSeq = events.map(\.seq).max() ?? 0
            let mergedEvents = (acceptedOlder + events).sorted { $0.seq < $1.seq }

            assert(
                mergedEvents.count <= maxLoadedTimelineEvents,
                "Older history merge exceeded the bounded timeline window"
            )
            assert(
                (mergedEvents.map(\.seq).max() ?? 0) == previousTailSeq,
                "Older history merge replaced the live timeline tail"
            )

            if !acceptedOlder.isEmpty {
                events = mergedEvents
                latestSeenSeq = max(latestSeenSeq, previousTailSeq)
            }
            if let latestSession, let idx = sessions.firstIndex(where: { $0.id == sid }) {
                replaceSessionFromServer(latestSession, at: idx)
            }
            let omittedCountChanged = omittedHistoryEventCount != nextOmittedHistoryEventCount
            if omittedCountChanged {
                omittedHistoryEventCount = nextOmittedHistoryEventCount
            }
            if !acceptedOlder.isEmpty {
                refreshSessionFilesFromLoadedEvents()
                rebuildDisplayEvents()
            }
            if !acceptedOlder.isEmpty || omittedCountChanged {
                saveSelectedChatCache()
            }
            AppLogger.info("loaded older session=\(sid) before=\(before) received=\(receivedCount) fetched_visible=\(older.count) added=\(acceptedOlder.count) dropped_for_capacity=\(droppedFetchedCount) first_added=\(firstAddedEventID ?? "-") skipped_invisible_pages=\(skippedInvisiblePages) skipped_non_primary_pages=\(skippedNonPrimaryPages) loaded=\(events.count) omitted_before=\(omittedHistoryEventCount)")
            return OlderHistoryLoadResult(addedCount: acceptedOlder.count, firstAddedEventID: firstAddedEventID)
        } catch {
            AppLogger.error("load older failed session=\(sid) \(serverErrorMessage(error) ?? "\(error)")")
            reportServerError(error)
            return OlderHistoryLoadResult(addedCount: 0, firstAddedEventID: nil)
        }
    }

    func refreshSelectedFiles() async {
        guard let sid = selectedSessionID else { return }
        await loadSessionFiles(sessionID: sid, generation: selectionGeneration, reset: true)
        await loadSessionVideoFiles(sessionID: sid, generation: selectionGeneration)
    }

    func loadMoreSelectedFiles() async {
        guard let sid = selectedSessionID, sessionFilesHasMore, !isLoadingSessionFiles else { return }
        await loadSessionFiles(sessionID: sid, generation: selectionGeneration, reset: false)
    }

    func refreshSelectedProcesses(showErrors: Bool = true) async {
        guard let sid = selectedSessionID else { return }
        isLoadingProcesses = true
        defer { isLoadingProcesses = false }
        do {
            let res: ZProcessSnapshot = try await api.get("/api/sessions/\(sid)/processes")
            guard selectedSessionID == sid else { return }
            processSnapshot = res.active ? res : nil
            if res.active == false {
                processLogTail = nil
            }
        } catch {
            AppLogger.warning("process refresh failed \(serverErrorMessage(error) ?? "\(error)")")
            if showErrors {
                reportServerError(error)
            }
        }
    }

    func tailProcessLog(_ hint: ZProcessLogHint) async {
        guard let sid = selectedSessionID else { return }
        do {
            let res: ZProcessLogTail = try await api.get(
                "/api/sessions/\(sid)/processes/log",
                queryItems: [
                    URLQueryItem(name: "path", value: hint.path),
                    URLQueryItem(name: "lines", value: "240")
                ]
            )
            guard selectedSessionID == sid else { return }
            processLogTail = res
        } catch {
            AppLogger.warning("process log tail failed \(serverErrorMessage(error) ?? "\(error)")")
            reportServerError(error)
        }
    }

    func refreshSelectedTmuxPanes(includeAll: Bool = false, showErrors: Bool = true) async {
        guard let sid = selectedSessionID else { return }
        isLoadingTmux = true
        defer { isLoadingTmux = false }
        do {
            let res: ZTmuxSnapshot = try await api.get(
                "/api/sessions/\(sid)/tmux",
                queryItems: [URLQueryItem(name: "include_all", value: includeAll ? "true" : "false")]
            )
            guard selectedSessionID == sid else { return }
            tmuxSnapshot = res
            if let capture = tmuxCapture, !res.panes.contains(where: { $0.pane_id == capture.pane_id }) {
                tmuxCapture = nil
            }
        } catch {
            AppLogger.warning("tmux refresh failed \(serverErrorMessage(error) ?? "\(error)")")
            if showErrors {
                reportServerError(error)
            }
        }
    }

    func captureTmuxPane(_ pane: ZTmuxPane) async {
        guard let sid = selectedSessionID else { return }
        isLoadingTmux = true
        defer { isLoadingTmux = false }
        do {
            let res: ZTmuxCapture = try await api.get(
                "/api/sessions/\(sid)/tmux/capture",
                queryItems: [
                    URLQueryItem(name: "pane_id", value: pane.pane_id),
                    URLQueryItem(name: "lines", value: "500")
                ]
            )
            guard selectedSessionID == sid else { return }
            tmuxCapture = res
        } catch {
            AppLogger.warning("tmux capture failed \(serverErrorMessage(error) ?? "\(error)")")
            reportServerError(error)
        }
    }

    func findFileInChat(_ file: ZFile) async {
        guard let sid = selectedSessionID else { return }
        if let event = eventContaining(fileID: file.id, in: events) {
            requestScrollToEvent(event.id)
            return
        }
        do {
            struct Response: Codable { let event: ZEvent }
            let res: Response = try await api.get("/api/sessions/\(sid)/files/\(file.id)/event")
            mergeEventsKeeping(res.event)
            requestScrollToEvent(res.event.id)
            setStatus("Found file in chat")
        } catch {
            AppLogger.warning("find file event failed file=\(file.id) \(serverErrorMessage(error) ?? "\(error)")")
            errorText = "I could not find that file in this chat history."
        }
    }

    @discardableResult
    func updateSelected(backend: String? = nil, model: String? = nil, effort: String? = nil, folder: String? = nil, title: String? = nil, cwd: String? = nil, pinned: Bool? = nil, archived: Bool? = nil, applyOptimistic: Bool = true) async -> Bool {
        guard let sid = selectedSessionID else { return false }
        markPendingRuntime(sessionID: sid, backend: backend, model: model, effort: effort)
        let previousSession = applyOptimistic ? sessions.first { $0.id == sid } : nil
        if applyOptimistic {
            applyOptimisticSessionPatch(sessionID: sid, folder: folder, title: title, cwd: cwd, backend: backend, model: model, effort: effort, pinned: pinned, archived: archived)
        }
        struct Body: Codable {
            var title: String?
            var folder: String?
            var cwd: String?
            var backend: String?
            var model: String?
            var effort: String?
            var pinned: Bool?
            var archived: Bool?
        }
        do {
            struct Response: Codable { let session: ZSession }
            let body = Body(
                title: title,
                folder: folder,
                cwd: cwd,
                backend: backend,
                model: model,
                effort: effort,
                pinned: pinned,
                archived: archived
            )
            let res: Response = try await api.patch("/api/sessions/\(sid)", body: body)
            clearConfirmedPendingRuntime(sessionID: sid, confirmed: res.session, backend: backend, model: model, effort: effort)
            replaceSessionFromServer(res.session)
            return true
        } catch {
            discardPendingRuntime(sessionID: sid, backend: backend, model: model, effort: effort)
            if applyOptimistic, let previousSession, let idx = sessions.firstIndex(where: { $0.id == sid }) {
                sessions[idx] = previousSession
            }
            reportServerError(error)
            return false
        }
    }

    func stageSelectedRuntime(backend: String? = nil, model: String? = nil, effort: String? = nil) {
        guard let sid = selectedSessionID else { return }
        markPendingRuntime(sessionID: sid, backend: backend, model: model, effort: effort)
        applyOptimisticSessionPatch(sessionID: sid, backend: backend, model: model, effort: effort)
    }

    func togglePin(_ session: ZSession) async {
        await updateSession(session.id, pinned: !(session.pinned ?? false))
    }

    func toggleArchive(_ session: ZSession) async {
        let shouldArchive = !(session.archived ?? false)
        await updateSession(
            session.id,
            pinned: shouldArchive ? false : nil,
            archived: shouldArchive
        )
    }

    func moveSession(_ session: ZSession, to folder: String) async {
        let cleanFolder = folder.trimmingCharacters(in: .whitespacesAndNewlines)
        await updateSession(session.id, folder: cleanFolder.isEmpty ? "General" : cleanFolder)
    }

    func reorderSession(_ session: ZSession, direction: String) async {
        struct Body: Codable {
            let direction: String
        }
        do {
            struct Response: Codable { let sessions: [ZSession] }
            let res: Response = try await api.post("/api/sessions/\(session.id)/order", body: Body(direction: direction))
            sessions = sessionsWithPendingRuntime(res.sessions)
            reconcileUnreadFromSessions()
        } catch {
            reportServerError(error)
        }
    }

    func reorderSession(_ session: ZSession, relativeTo target: ZSession, placement: String) async {
        guard session.id != target.id,
              sessionSidebarSectionKey(session) == sessionSidebarSectionKey(target) else {
            return
        }
        struct Body: Codable {
            let target_id: String
            let placement: String
        }
        do {
            struct Response: Codable { let sessions: [ZSession] }
            let res: Response = try await api.post(
                "/api/sessions/\(session.id)/order",
                body: Body(target_id: target.id, placement: placement)
            )
            sessions = sessionsWithPendingRuntime(res.sessions)
            reconcileUnreadFromSessions()
        } catch {
            reportServerError(error)
        }
    }

    func canReorderSession(_ session: ZSession, relativeTo target: ZSession) -> Bool {
        session.id != target.id &&
            sessionSidebarSectionKey(session) == sessionSidebarSectionKey(target)
    }

    private func sessionSidebarSectionKey(_ session: ZSession) -> String {
        if session.archived == true {
            return "archived"
        }
        if session.pinned == true {
            return "pinned"
        }
        let folder = session.folder?.trimmingCharacters(in: .whitespacesAndNewlines)
        return "folder:\(folder?.isEmpty == false ? folder! : "General")"
    }

    @discardableResult
    func updateSession(_ sessionID: String, folder: String? = nil, title: String? = nil, cwd: String? = nil, backend: String? = nil, model: String? = nil, effort: String? = nil, pinned: Bool? = nil, archived: Bool? = nil, applyOptimistic: Bool = true) async -> Bool {
        let previousSession = applyOptimistic ? sessions.first { $0.id == sessionID } : nil
        markPendingRuntime(sessionID: sessionID, backend: backend, model: model, effort: effort)
        if applyOptimistic {
            applyOptimisticSessionPatch(sessionID: sessionID, folder: folder, title: title, cwd: cwd, backend: backend, model: model, effort: effort, pinned: pinned, archived: archived)
        }
        struct Body: Codable {
            var title: String?
            var folder: String?
            var cwd: String?
            var backend: String?
            var model: String?
            var effort: String?
            var pinned: Bool?
            var archived: Bool?
        }
        do {
            struct Response: Codable { let session: ZSession }
            let res: Response = try await api.patch("/api/sessions/\(sessionID)", body: Body(
                title: title,
                folder: folder,
                cwd: cwd,
                backend: backend,
                model: model,
                effort: effort,
                pinned: pinned,
                archived: archived
            ))
            clearConfirmedPendingRuntime(sessionID: sessionID, confirmed: res.session, backend: backend, model: model, effort: effort)
            replaceSessionFromServer(res.session)
            return true
        } catch {
            discardPendingRuntime(sessionID: sessionID, backend: backend, model: model, effort: effort)
            if applyOptimistic, let previousSession, let idx = sessions.firstIndex(where: { $0.id == sessionID }) {
                sessions[idx] = previousSession
            }
            reportServerError(error)
            return false
        }
    }

    private func applyOptimisticSessionPatch(sessionID: String, folder: String? = nil, title: String? = nil, cwd: String? = nil, backend: String? = nil, model: String? = nil, effort: String? = nil, pinned: Bool? = nil, archived: Bool? = nil) {
        guard let idx = sessions.firstIndex(where: { $0.id == sessionID }) else { return }
        if let title {
            sessions[idx].title = title
        }
        if let folder {
            sessions[idx].folder = folder
        }
        if let cwd {
            sessions[idx].cwd = cwd
        }
        if let backend {
            sessions[idx].backend = backend.lowercased()
        }
        if let model {
            let clean = ZRuntimeCatalog.cleaned(model)
            sessions[idx].model = clean.isEmpty ? nil : clean
        }
        if let effort {
            let clean = ZRuntimeCatalog.cleaned(effort)
            sessions[idx].effort = clean.isEmpty ? nil : clean
        }
        if let pinned {
            sessions[idx].pinned = pinned
        }
        if let archived {
            sessions[idx].archived = archived
        }
    }

    private func replaceSessionFromServer(_ session: ZSession, at existingIndex: Int? = nil) {
        guard let idx = existingIndex ?? sessions.firstIndex(where: { $0.id == session.id }) else { return }
        let nextSession = sessionWithPendingRuntime(session)
        guard sessions[idx] != nextSession else { return }
        sessions[idx] = nextSession
    }

    private func insertForkedSession(_ session: ZSession, after parentID: String) {
        let prepared = sessionWithPendingRuntime(session)
        sessions.removeAll { $0.id == prepared.id }
        if let parentIndex = sessions.firstIndex(where: { $0.id == parentID }) {
            sessions.insert(prepared, at: min(parentIndex + 1, sessions.count))
        } else {
            sessions.insert(prepared, at: 0)
        }
    }

    private func sessionsWithPendingRuntime(_ incoming: [ZSession]) -> [ZSession] {
        incoming.map(sessionWithPendingRuntime)
    }

    private func sessionWithPendingRuntime(_ session: ZSession) -> ZSession {
        guard var pending = pendingRuntimeBySessionID[session.id] else { return session }
        if pending.isExpired() {
            pendingRuntimeBySessionID[session.id] = nil
            AppLogger.warning("expired pending runtime session=\(session.id) server_backend=\(session.backend) server_model=\(session.model ?? "-") server_effort=\(session.effort ?? "-")")
            return session
        }
        pending.clearConfirmed(by: session)
        if pending.isEmpty {
            pendingRuntimeBySessionID[session.id] = nil
            return session
        }
        pendingRuntimeBySessionID[session.id] = pending
        return pending.applying(to: session)
    }

    private func markPendingRuntime(sessionID: String, backend: String? = nil, model: String? = nil, effort: String? = nil) {
        guard backend != nil || model != nil || effort != nil else { return }
        var pending = pendingRuntimeBySessionID[sessionID] ?? PendingRuntimePatch()
        if let backend {
            pending.backend = backend.lowercased()
        }
        if let model {
            pending.modelSet = true
            pending.model = runtimeSessionValue(model)
        }
        if let effort {
            pending.effortSet = true
            pending.effort = runtimeSessionValue(effort)
        }
        pending.touch()
        pendingRuntimeBySessionID[sessionID] = pending.isEmpty ? nil : pending
    }

    private func clearConfirmedPendingRuntime(sessionID: String, confirmed: ZSession, backend: String? = nil, model: String? = nil, effort: String? = nil) {
        guard var pending = pendingRuntimeBySessionID[sessionID] else { return }
        if let backend {
            let clean = backend.lowercased()
            if pending.backend == clean && confirmed.backend == clean {
                pending.backend = nil
            }
        }
        if let model {
            let clean = runtimeSessionValue(model)
            if pending.modelSet && pending.model == clean && runtimeSessionValue(confirmed.model) == clean {
                pending.modelSet = false
                pending.model = nil
            }
        }
        if let effort {
            let clean = runtimeSessionValue(effort)
            if pending.effortSet && pending.effort == clean && runtimeSessionValue(confirmed.effort) == clean {
                pending.effortSet = false
                pending.effort = nil
            }
        }
        pendingRuntimeBySessionID[sessionID] = pending.isEmpty ? nil : pending
    }

    private func discardPendingRuntime(sessionID: String, backend: String? = nil, model: String? = nil, effort: String? = nil) {
        guard var pending = pendingRuntimeBySessionID[sessionID] else { return }
        if backend != nil {
            pending.backend = nil
        }
        if model != nil {
            pending.modelSet = false
            pending.model = nil
        }
        if effort != nil {
            pending.effortSet = false
            pending.effort = nil
        }
        pendingRuntimeBySessionID[sessionID] = pending.isEmpty ? nil : pending
    }

    private func runtimeSessionValue(_ value: String?) -> String? {
        let clean = ZRuntimeCatalog.cleaned(value)
        return clean.isEmpty ? nil : clean
    }

    func deleteSession(_ session: ZSession) async {
        struct Response: Codable {
            let ok: Bool
            let deleted: Bool
            let deleted_jobs: Int?
        }
        do {
            let _: Response = try await api.delete("/api/sessions/\(session.id)")
            deleteCachedChat(session.id)
            clearDraftPrompt(for: session.id)
            sessions.removeAll { $0.id == session.id }
            activeSessionIDs.remove(session.id)
            if selectedSessionID == session.id {
                webSocket?.cancel(with: .goingAway, reason: nil)
                selectedSessionID = nil
                loadedSessionID = nil
                isSelectingSession = false
                events = []
                displayEvents = []
                latestSeenSeq = 0
                omittedHistoryEventCount = 0
                sessionFiles = []
                sessionVideoFiles = []
                sessionFilesTotal = nil
                sessionFilesHasMore = false
                sessionFilesNextOffset = 0
                syncSelectedRunningState()
                requestScrollToBottom(immediate: true)
                uploads = []
                if let next = sessions.first {
                    await select(sessionID: next.id)
                }
            }
        } catch {
            reportServerError(error)
        }
    }

    func forkSelected() async {
        guard let session = selectedSession else { return }
        await fork(session)
    }

    func fork(_ session: ZSession) async {
        let sid = session.id
        struct Body: Codable { var title: String? }
        do {
            struct Response: Codable {
                let session: ZSession
                let sessions: [ZSession]?
            }
            let title = "Fork of \(session.title)"
            let res: Response = try await api.post("/api/sessions/\(sid)/fork", body: Body(title: title))
            if let authoritativeSessions = res.sessions {
                sessions = sessionsWithPendingRuntime(authoritativeSessions)
                reconcileUnreadFromSessions()
            } else {
                insertForkedSession(res.session, after: sid)
            }
            AppLogger.info("forked parent=\(sid) child=\(res.session.id) backend=\(res.session.backend)")
            await select(sessionID: res.session.id)
        } catch {
            AppLogger.error("fork failed session=\(sid) \(serverErrorMessage(error) ?? "\(error)")")
            reportServerError(error)
        }
    }

    func createHandoffDigest(sourceSessionID: String, targetSessionID: String? = nil, detail: String, userPrompt: String) async -> String? {
        struct Body: Codable {
            let detail: String
            let user_prompt: String?
            let target_session_id: String?
        }
        struct Response: Codable {
            let digest: String
            let source_session: ZSession?
            let event_count: Int?
            let file_count: Int?
            let detail: String?
            let summarizer: [String: String]?
        }
        let cleanPrompt = userPrompt.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            let res: Response = try await api.post(
                "/api/sessions/\(sourceSessionID)/digest",
                body: Body(
                    detail: detail,
                    user_prompt: cleanPrompt.isEmpty ? nil : cleanPrompt,
                    target_session_id: targetSessionID
                )
            )
            return res.digest
        } catch {
            AppLogger.error("digest failed source=\(sourceSessionID) \(serverErrorMessage(error) ?? "\(error)")")
            reportServerError(error)
            return nil
        }
    }

    @discardableResult
    func sendPrompt(to sessionID: String, prompt submittedPrompt: String, fileIDs: [String] = []) async -> Bool {
        let trimmed = submittedPrompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        let wasRunning = isRunning
        let runtimeModel = sessions.first { $0.id == sessionID }?.model ?? ""
        let runtimeEffort = sessions.first { $0.id == sessionID }?.effort ?? ""
        struct Body: Codable {
            let prompt: String
            let file_ids: [String]
            let model: String
            let effort: String
        }
        struct Response: Codable {
            let run_id: String?
            let queued: Bool?
            let queued_id: String?
            let position: Int?
            let session: ZSession
            let event: ZEvent?
        }
        do {
            activeSessionIDs.insert(sessionID)
            if sessionID == selectedSessionID {
                isRunning = true
                requestScrollToBottom(immediate: true)
            }
            let res: Response = try await api.post(
                "/api/sessions/\(sessionID)/turns",
                body: Body(
                    prompt: trimmed,
                    file_ids: fileIDs,
                    model: runtimeModel,
                    effort: runtimeEffort
                )
            )
            replaceSessionFromServer(res.session)
            applyAcceptedTurnEvent(res.event, sessionID: sessionID)
            if res.queued == true {
                AppLogger.info("turn queued session=\(sessionID) queued=\(res.queued_id ?? "-") position=\(res.position ?? 0)")
            } else {
                AppLogger.info("turn started session=\(sessionID) run=\(res.run_id ?? "-")")
            }
            launchDeferredText = nil
            syncSelectedRunningState()
            return true
        } catch {
            if sessionID == selectedSessionID {
                isRunning = wasRunning
            }
            if !wasRunning {
                activeSessionIDs.remove(sessionID)
            }
            syncSelectedRunningState()
            AppLogger.error("send failed session=\(sessionID) \(serverErrorMessage(error) ?? "\(error)")")
            reportServerError(error)
            return false
        }
    }

    @discardableResult
    func sendHandoffDigest(sourceSessionID: String, targetSessionID: String, detail: String, userPrompt: String) async -> Bool {
        guard sourceSessionID != targetSessionID else {
            errorText = "Choose a different target chat for the digest."
            return false
        }
        struct Body: Codable {
            let detail: String
            let user_prompt: String?
            let target_session_id: String
        }
        struct Response: Codable {
            let ok: Bool
            let digest_job_id: String?
            let session: ZSession
        }
        let cleanPrompt = userPrompt.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            let res: Response = try await api.post(
                "/api/sessions/\(sourceSessionID)/digest/send",
                body: Body(
                    detail: detail,
                    user_prompt: cleanPrompt.isEmpty ? nil : cleanPrompt,
                    target_session_id: targetSessionID
                )
            )
            replaceSessionFromServer(res.session)
            AppLogger.info("handoff digest started source=\(sourceSessionID) target=\(targetSessionID) job=\(res.digest_job_id ?? "-")")
            return res.ok
        } catch {
            AppLogger.error("handoff digest send failed source=\(sourceSessionID) target=\(targetSessionID) \(serverErrorMessage(error) ?? "\(error)")")
            reportServerError(error)
            return false
        }
    }

    func upload(urls: [URL]) async {
        guard let sid = selectedSessionID else { return }
        for url in urls {
            let ok = url.startAccessingSecurityScopedResource()
            defer { if ok { url.stopAccessingSecurityScopedResource() } }
            do {
                let file = try await api.upload(sessionID: sid, fileURL: url)
                addPendingUpload(file)
            } catch {
                reportServerError(error)
            }
        }
    }

    func removeUpload(_ file: ZFile) {
        uploads.removeAll { $0.id == file.id }
    }

    func clearUploadsIfCurrent(fileIDs: [String], for sessionID: String?) {
        guard selectedSessionID == sessionID else { return }
        guard uploads.map(\.id) == fileIDs else { return }
        uploads = []
    }

    @discardableResult
    func sendPrompt(_ submittedPrompt: String? = nil) async -> Bool {
        guard let sid = selectedSessionID else { return false }
        let sourcePrompt = submittedPrompt ?? prompt
        let trimmed = sourcePrompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        let wasRunning = isRunning
        let runtimeModel = selectedSession?.model ?? ""
        let runtimeEffort = selectedSession?.effort ?? ""
        struct Body: Codable {
            let prompt: String
            let file_ids: [String]
            let model: String
            let effort: String
        }
        do {
            isRunning = true
            activeSessionIDs.insert(sid)
            if submittedPrompt == nil {
                prompt = ""
            }
            requestScrollToBottom(immediate: true)
            AppLogger.info("send prompt session=\(sid) chars=\(trimmed.count) files=\(uploads.count)")
            let body = Body(
                prompt: trimmed,
                file_ids: uploads.map(\.id),
                model: runtimeModel,
                effort: runtimeEffort
            )
            struct Response: Codable {
                let run_id: String?
                let queued: Bool?
                let queued_id: String?
                let position: Int?
                let session: ZSession
                let event: ZEvent?
            }
            let res: Response = try await api.post("/api/sessions/\(sid)/turns", body: body)
            replaceSessionFromServer(res.session)
            applyAcceptedTurnEvent(res.event, sessionID: sid)
            if res.queued == true {
                AppLogger.info("turn queued session=\(sid) queued=\(res.queued_id ?? "-") position=\(res.position ?? 0)")
            } else {
                AppLogger.info("turn started session=\(sid) run=\(res.run_id ?? "-")")
            }
            launchDeferredText = nil
            uploads = []
            clearSubmittedPromptIfCurrent(submittedPrompt: submittedPrompt, trimmed: trimmed)
            return true
        } catch {
            if submittedPrompt == nil && prompt.isEmpty {
                prompt = trimmed
            }
            isRunning = wasRunning
            if wasRunning {
                activeSessionIDs.insert(sid)
            } else {
                activeSessionIDs.remove(sid)
            }
            AppLogger.error("send failed session=\(sid) \(serverErrorMessage(error) ?? "\(error)")")
            reportServerError(error)
            return false
        }
    }

    private func applyAcceptedTurnEvent(_ event: ZEvent?, sessionID: String) {
        guard let event else { return }
        applyQueuedTurnState(from: event)
        if event.type == "turn_started" {
            activeSessionIDs.insert(event.session_id)
            syncSelectedRunningState()
        }
        guard event.session_id == sessionID, event.session_id == selectedSessionID else { return }
        ingest(event)
    }

    private func clearSubmittedPromptIfCurrent(submittedPrompt: String?, trimmed: String) {
        guard submittedPrompt != nil else {
            prompt = ""
            return
        }
        if prompt.trimmingCharacters(in: .whitespacesAndNewlines) == trimmed {
            prompt = ""
        }
    }

    func stop() async {
        guard let sid = selectedSessionID else { return }
        struct Empty: Codable {}
        do {
            let _: JSONValue = try await api.post("/api/sessions/\(sid)/stop", body: Empty())
            activeSessionIDs.remove(sid)
            syncSelectedRunningState()
            AppLogger.info("stop session=\(sid)")
        } catch {
            AppLogger.error("stop failed session=\(sid) \(serverErrorMessage(error) ?? "\(error)")")
            reportServerError(error)
        }
    }

    func unqueue(_ event: ZEvent) async {
        guard let queuedID = event.queued_id else { return }
        await unqueue(sessionID: event.session_id, queuedID: queuedID)
    }

    func unqueue(_ turn: ZQueuedTurn) async {
        guard let sessionID = sessionID(for: turn) else { return }
        await unqueue(sessionID: sessionID, queuedID: turn.queued_id)
    }

    private func unqueue(sessionID: String, queuedID: String) async {
        struct Response: Codable {
            let ok: Bool
            let unqueued: Bool?
            let queued_id: String?
            let remaining: Int?
        }
        do {
            let _: Response = try await api.delete("/api/sessions/\(sessionID)/queue/\(queuedID)")
            removeLocalQueuedTurn(sessionID: sessionID, queuedID: queuedID)
            rebuildDisplayEvents()
            saveSelectedChatCache()
            AppLogger.info("unqueued session=\(sessionID) queued=\(queuedID)")
        } catch {
            AppLogger.error("unqueue failed session=\(sessionID) queued=\(queuedID) \(serverErrorMessage(error) ?? "\(error)")")
            if handleStaleQueuedTurn(queuedID, error: error) { return }
            reportServerError(error)
        }
    }

    func updateQueued(_ event: ZEvent, prompt: String) async {
        guard let queuedID = event.queued_id else { return }
        await updateQueued(sessionID: event.session_id, queuedID: queuedID, prompt: prompt)
    }

    func updateQueued(_ turn: ZQueuedTurn, prompt: String) async {
        guard let sessionID = sessionID(for: turn) else { return }
        await updateQueued(sessionID: sessionID, queuedID: turn.queued_id, prompt: prompt)
    }

    private func updateQueued(sessionID: String, queuedID: String, prompt: String) async {
        let cleanPrompt = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanPrompt.isEmpty else { return }
        struct Body: Codable {
            let prompt: String
        }
        struct Response: Codable {
            let ok: Bool
            let queued_id: String
        }
        do {
            let _: Response = try await api.patch("/api/sessions/\(sessionID)/queue/\(queuedID)", body: Body(prompt: cleanPrompt))
            if let idx = events.firstIndex(where: { $0.type == "turn_queued" && $0.queued_id == queuedID }) {
                events[idx].prompt = cleanPrompt
            }
            updateLocalQueuedTurn(sessionID: sessionID, queuedID: queuedID) { turn in
                turn.prompt = cleanPrompt
                turn.display_prompt = cleanPrompt
            }
            rebuildDisplayEvents()
            saveSelectedChatCache()
            AppLogger.info("queued prompt updated session=\(sessionID) queued=\(queuedID)")
        } catch {
            AppLogger.error("queued update failed session=\(sessionID) queued=\(queuedID) \(serverErrorMessage(error) ?? "\(error)")")
            if handleStaleQueuedTurn(queuedID, error: error) { return }
            reportServerError(error)
        }
    }

    func moveQueued(_ event: ZEvent, direction: String) async {
        guard let queuedID = event.queued_id else { return }
        await moveQueued(sessionID: event.session_id, queuedID: queuedID, direction: direction)
    }

    func moveQueued(_ turn: ZQueuedTurn, direction: String) async {
        guard let sessionID = sessionID(for: turn) else { return }
        await moveQueued(sessionID: sessionID, queuedID: turn.queued_id, direction: direction)
    }

    private func moveQueued(sessionID: String, queuedID: String, direction: String) async {
        struct Body: Codable {
            let direction: String
        }
        struct Response: Codable {
            let ok: Bool
            let queued_id: String
            let positions: [ZQueuePosition]?
        }
        do {
            let res: Response = try await api.post("/api/sessions/\(sessionID)/queue/\(queuedID)/move", body: Body(direction: direction))
            if let positions = res.positions {
                for position in positions {
                    if let idx = events.firstIndex(where: { $0.type == "turn_queued" && $0.queued_id == position.queued_id }) {
                        events[idx].position = position.position
                    }
                    updateLocalQueuedTurn(sessionID: sessionID, queuedID: position.queued_id) { turn in
                        turn.position = position.position
                    }
                }
            }
            rebuildDisplayEvents()
            saveSelectedChatCache()
            AppLogger.info("queued moved session=\(sessionID) queued=\(queuedID) direction=\(direction)")
        } catch {
            AppLogger.error("queued move failed session=\(sessionID) queued=\(queuedID) \(serverErrorMessage(error) ?? "\(error)")")
            if handleStaleQueuedTurn(queuedID, error: error) { return }
            reportServerError(error)
        }
    }

    func runQueuedNow(_ event: ZEvent) async {
        guard let queuedID = event.queued_id else { return }
        await runQueuedNow(sessionID: event.session_id, queuedID: queuedID)
    }

    func runQueuedNow(_ turn: ZQueuedTurn) async {
        guard let sessionID = sessionID(for: turn) else { return }
        await runQueuedNow(sessionID: sessionID, queuedID: turn.queued_id)
    }

    private func runQueuedNow(sessionID: String, queuedID: String) async {
        struct Empty: Codable {}
        struct Response: Codable {
            let ok: Bool
            let queued_id: String
            let interrupted: Bool?
        }
        do {
            let _: Response = try await api.post("/api/sessions/\(sessionID)/queue/\(queuedID)/run-now", body: Empty())
            if let idx = events.firstIndex(where: { $0.type == "turn_queued" && $0.queued_id == queuedID }) {
                events[idx].position = 1
            }
            removeLocalQueuedTurn(sessionID: sessionID, queuedID: queuedID)
            rebuildDisplayEvents()
            saveSelectedChatCache()
            AppLogger.info("queued run-now session=\(sessionID) queued=\(queuedID)")
        } catch {
            AppLogger.error("queued run-now failed session=\(sessionID) queued=\(queuedID) \(serverErrorMessage(error) ?? "\(error)")")
            if handleStaleQueuedTurn(queuedID, error: error) { return }
            reportServerError(error)
        }
    }

    private func handleStaleQueuedTurn(_ queuedID: String, error: Error) -> Bool {
        guard isQueuedTurnNotFound(error) else { return false }
        for sessionID in Array(queuedTurnsBySessionID.keys) {
            removeLocalQueuedTurn(sessionID: sessionID, queuedID: queuedID)
        }
        events.removeAll { $0.type == "turn_queued" && $0.queued_id == queuedID }
        rebuildDisplayEvents()
        saveSelectedChatCache()
        AppLogger.warning("removed stale queued turn queued=\(queuedID)")
        return true
    }

    private func isQueuedTurnNotFound(_ error: Error) -> Bool {
        let ns = error as NSError
        let message = serverErrorMessage(error) ?? ""
        return message.localizedCaseInsensitiveContains("queued turn not found") ||
            (ns.domain == "ZenithDock.API" &&
             ns.code == 404 &&
             message.localizedCaseInsensitiveContains("not found"))
    }

    func createJob(title: String, prompt: String, intervalSeconds: Int, loop: Bool, maxRuns: Int? = nil, firstRunAt: Date? = nil) async {
        guard let sid = selectedSessionID else { return }
        let cleanPrompt = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanPrompt.isEmpty else { return }
        struct Body: Codable {
            let session_id: String
            let title: String
            let prompt: String
            let interval_seconds: Int
            let first_run_at: String?
            let loop: Bool
            let max_runs: Int?
            let enabled: Bool
            let backend: String?
        }
        do {
            struct Response: Codable { let job: ZJob }
            let cleanTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
            let body = Body(
                session_id: sid,
                title: cleanTitle.isEmpty ? "\(loop ? "Loop" : "Job"): \(selectedSession?.title ?? "Chat")" : cleanTitle,
                prompt: cleanPrompt,
                interval_seconds: intervalSeconds,
                first_run_at: firstRunAt.map(serverTimestamp),
                loop: loop,
                max_runs: loop ? nil : max(1, maxRuns ?? 1),
                enabled: true,
                backend: selectedSession?.backend
            )
            let res: Response = try await api.post("/api/jobs", body: body)
            jobs.insert(res.job, at: 0)
        } catch {
            reportServerError(error)
        }
    }

    func updateJob(
        _ job: ZJob,
        title: String? = nil,
        prompt: String? = nil,
        intervalSeconds: Int? = nil,
        loop: Bool? = nil,
        maxRuns: Int? = nil,
        enabled: Bool? = nil,
        backend: String? = nil,
        nextRunAt: Date? = nil
    ) async {
        struct Body: Codable {
            var title: String?
            var prompt: String?
            var enabled: Bool?
            var interval_seconds: Int?
            var next_run_at: String?
            var loop: Bool?
            var max_runs: Int?
            var backend: String?
        }
        do {
            struct Response: Codable { let job: ZJob }
            let res: Response = try await api.patch("/api/jobs/\(job.id)", body: Body(
                title: title,
                prompt: prompt,
                enabled: enabled,
                interval_seconds: intervalSeconds.map { max(10, $0) },
                next_run_at: nextRunAt.map(serverTimestamp),
                loop: loop,
                max_runs: maxRuns.map { max(1, $0) },
                backend: backend
            ))
            if let idx = jobs.firstIndex(where: { $0.id == job.id }) {
                jobs[idx] = res.job
            }
        } catch {
            reportServerError(error)
        }
    }

    private func serverTimestamp(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        return formatter.string(from: date)
    }

    func runJobNow(_ job: ZJob) async {
        struct Empty: Codable {}
        do {
            let _: JSONValue = try await api.post("/api/jobs/\(job.id)/run", body: Empty())
            await refreshJobs(showErrors: false)
        } catch {
            reportServerError(error)
        }
    }

    func deleteJob(_ job: ZJob) async {
        struct Response: Codable {
            let ok: Bool
            let deleted: Bool
        }
        do {
            let _: Response = try await api.delete("/api/jobs/\(job.id)")
            jobs.removeAll { $0.id == job.id }
        } catch {
            reportServerError(error)
        }
    }

    func fileURL(_ file: ZFile) -> URL {
        api.authenticatedURL("/api/files/\(file.id)")
    }

    func promptFiles(for event: ZEvent) -> [ZFile] {
        guard let fileIDs = event.file_ids, !fileIDs.isEmpty else { return [] }
        let knownFiles = mergedFiles(sessionFiles + sessionVideoFiles + uploads + files(from: events))
        let filesByID = Dictionary(uniqueKeysWithValues: knownFiles.map { ($0.id, $0) })
        return fileIDs.compactMap { filesByID[$0] }
    }

    func promptFilesByEventID(for timelineEvents: [ZEvent]) -> [String: [ZFile]] {
        let eventsWithFiles = timelineEvents.filter { $0.file_ids?.isEmpty == false }
        guard !eventsWithFiles.isEmpty else { return [:] }
        let knownFiles = mergedFiles(sessionFiles + sessionVideoFiles + uploads + files(from: events))
        let filesByID = Dictionary(uniqueKeysWithValues: knownFiles.map { ($0.id, $0) })
        return Dictionary(uniqueKeysWithValues: eventsWithFiles.map { event in
            (event.id, (event.file_ids ?? []).compactMap { filesByID[$0] })
        })
    }

    func markdownLinkContext(sessionID: String) -> ZMarkdownLinkContext {
        ZMarkdownLinkContext(sessionID: sessionID, baseURL: api.baseURL, accessToken: accessToken)
    }

    private func connectEvents(sessionID: String, after: Int) {
        if socketLive, webSocketSessionID == sessionID, webSocket != nil {
            return
        }
        if let webSocket {
            webSocket.cancel(with: .goingAway, reason: nil)
        }
        let task = URLSession.shared.webSocketTask(with: api.wsRequest(sessionID: sessionID, after: after))
        webSocket = task
        webSocketSessionID = sessionID
        task.resume()
        setSocketLive(true)
        setStatus("Live")
        if lastSocketError != nil {
            lastSocketError = nil
        }
        AppLogger.info("websocket connect session=\(sessionID) after=\(after)")
        receiveNext(task: task, sessionID: sessionID)
    }

    private func receiveNext(task: URLSessionWebSocketTask, sessionID: String) {
        task.receive { [weak self] result in
            Task { @MainActor in
                guard let self else { return }
                switch result {
                case .success(let message):
                    guard self.webSocket === task, self.selectedSessionID == sessionID else {
                        task.cancel(with: .goingAway, reason: nil)
                        return
                    }
                    if case .string(let text) = message, let data = text.data(using: .utf8) {
                        if let event = try? JSONDecoder().decode(ZEvent.self, from: data) {
                            self.enqueueStreamEvent(event, sessionID: sessionID)
                        }
                    } else if case .data(let data) = message {
                        if let event = try? JSONDecoder().decode(ZEvent.self, from: data) {
                            self.enqueueStreamEvent(event, sessionID: sessionID)
                        }
                    }
                    self.receiveNext(task: task, sessionID: sessionID)
                case .failure(let error):
                    guard self.webSocket === task, self.selectedSessionID == sessionID else { return }
                    self.setSocketLive(false)
                    self.webSocket = nil
                    self.webSocketSessionID = nil
                    self.setStatus(self.serverReachable ? "Stream reconnecting" : "Server offline")
                    let nextSocketError = self.serverErrorMessage(error)
                    if self.lastSocketError != nextSocketError {
                        self.lastSocketError = nextSocketError
                    }
                    AppLogger.warning("websocket failed session=\(sessionID) \(self.lastSocketError ?? "\(error)")")
                    self.scheduleReconnect(sessionID: sessionID, failedTask: task)
                }
            }
        }
    }

    private func enqueueStreamEvent(_ event: ZEvent, sessionID: String) {
        guard selectedSessionID == sessionID else { return }
        if event.type == "raw_event", !showDebugEvents {
            latestSeenSeq = max(latestSeenSeq, event.seq)
            return
        }
        if events.contains(where: { $0.id == event.id }) ||
            pendingStreamEvents.contains(where: { $0.id == event.id }) {
            latestSeenSeq = max(latestSeenSeq, event.seq)
            return
        }
        if pendingStreamSessionID != sessionID {
            pendingStreamEvents.removeAll()
            pendingStreamSessionID = sessionID
            pendingStreamFlushTask?.cancel()
            pendingStreamFlushTask = nil
        }
        pendingStreamEvents.append(event)
        latestSeenSeq = max(latestSeenSeq, event.seq)
        if pendingStreamEvents.count >= streamBackfillMaskThreshold {
            isRefreshingCachedDelta = true
        }
        guard pendingStreamFlushTask == nil else { return }
        pendingStreamFlushTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: streamFlushDelayNanos)
            guard !Task.isCancelled else { return }
            self.flushPendingStreamEvents(sessionID: sessionID)
        }
    }

    private func flushPendingStreamEvents(sessionID: String) {
        pendingStreamFlushTask = nil
        guard pendingStreamSessionID == sessionID,
              !pendingStreamEvents.isEmpty else {
            if isRefreshingCachedDelta {
                isRefreshingCachedDelta = false
                setStatus(socketLive ? "Live" : "Server connected")
            }
            return
        }
        let buffered = pendingStreamEvents.sorted { $0.seq < $1.seq }
        pendingStreamEvents.removeAll()
        pendingStreamSessionID = nil
        if buffered.count >= streamBackfillMaskThreshold,
           !shouldPreserveRenderableTimelineDuringBackgroundRefresh {
            beginLargeTimelineBatchMask()
        }
        preserveSelectedTimelineIfNeeded(for: buffered)
        applyStreamEvents(buffered)
        if isApplyingLargeTimelineBatch {
            scheduleLargeTimelineBatchReveal()
        }
        if isRefreshingCachedDelta {
            timelineBatchRevealTask?.cancel()
            timelineBatchRevealTask = Task { @MainActor in
                try? await Task.sleep(nanoseconds: 320_000_000)
                guard !Task.isCancelled else { return }
                self.isApplyingLargeTimelineBatch = false
                self.isRefreshingCachedDelta = false
                self.setStatus(self.socketLive ? "Live" : "Server connected")
            }
        }
    }

    // `events` is maintained sorted by seq. Streaming/merge appends are almost
    // always already in order, so this O(n) check lets callers skip an
    // O(n log n) re-sort in the common case while staying correct otherwise.
    private func eventsAreSortedBySeq() -> Bool {
        guard events.count > 1 else { return true }
        var previous = events[0].seq
        for index in 1..<events.count {
            let current = events[index].seq
            if current < previous { return false }
            previous = current
        }
        return true
    }

    private func sortEventsBySeqIfNeeded() {
        if !eventsAreSortedBySeq() {
            events.sort { $0.seq < $1.seq }
        }
    }

    private func applyStreamEvents(_ incoming: [ZEvent]) {
        guard !incoming.isEmpty else { return }
        let existingIDs = Set(events.map(\.id))
        let newEvents = incoming.filter { !existingIDs.contains($0.id) }
        guard !newEvents.isEmpty else {
            latestSeenSeq = max(latestSeenSeq, incoming.map(\.seq).max() ?? 0)
            return
        }
        events.append(contentsOf: newEvents)
        sortEventsBySeqIfNeeded()
        if events.count > maxLoadedTimelineEvents {
            let overflow = events.count - maxLoadedTimelineEvents
            events.removeFirst(overflow)
            omittedHistoryEventCount += overflow
        }
        latestSeenSeq = max(latestSeenSeq, incoming.map(\.seq).max() ?? 0)
        var shouldSaveCache = false
        for event in newEvents {
            applyQueuedTurnState(from: event)
            clearLaunchDeferredIfResolved(by: event)
            if isAgentVisibleMessage(event) {
                let notificationCandidate = notificationCandidate(for: event)
                if event.session_id != selectedSessionID {
                    markAgentUnread(sessionID: event.session_id, firstSeq: event.seq)
                } else if !selectedTimelineAtBottom || !NSApp.isActive {
                    markAgentUnread(sessionID: event.session_id, firstSeq: event.seq)
                } else {
                    setLastReadAgentSeq(event.seq, for: event.session_id)
                    syncServerReadState(sessionID: event.session_id, seq: event.seq)
                }
                if let notificationCandidate {
                    deliverUnreadNotification(notificationCandidate)
                }
            }
            if ["turn_started", "turn_queued", "turn_unqueued", "assistant_text", "turn_finished", "error"].contains(event.type) {
                AppLogger.info("event session=\(event.session_id) seq=\(event.seq) type=\(event.type)")
            }
            if event.type == "turn_started" {
                activeSessionIDs.insert(event.session_id)
                syncSelectedRunningState()
            }
            if event.type == "turn_finished" || event.type == "error" || event.type == "turn_stopped" {
                activeSessionIDs.remove(event.session_id)
                syncSelectedRunningState()
                if event.session_id == selectedSessionID {
                    processSnapshot = nil
                    processLogTail = nil
                }
            }
            if let file = event.file {
                addPendingUpload(file)
                upsertSessionFile(file)
            }
            if let artifact = event.artifact {
                upsertSessionFile(artifact)
            }
            if event.type != "raw_event" {
                shouldSaveCache = true
            }
        }
        if shouldRebuildDisplayEvents(for: newEvents) {
            rebuildDisplayEvents()
        }
        if shouldSaveCache {
            saveSelectedChatCache()
        }
    }

    private func syncSelectedRunningState() {
        guard let selectedSessionID else {
            if isRunning {
                isRunning = false
            }
            return
        }
        let running = activeSessionIDs.contains(selectedSessionID)
        if isRunning != running {
            isRunning = running
        }
    }

    private func ingest(_ event: ZEvent) {
        latestSeenSeq = max(latestSeenSeq, event.seq)
        if event.type == "raw_event", !showDebugEvents {
            return
        }
        guard !events.contains(where: { $0.id == event.id }) else { return }
        applyQueuedTurnState(from: event)
        clearLaunchDeferredIfResolved(by: event)
        events.append(event)
        if events.count > maxLoadedTimelineEvents {
            let overflow = events.count - maxLoadedTimelineEvents
            events.removeFirst(overflow)
            omittedHistoryEventCount += overflow
        }
        preserveSelectedTimelineIfNeeded(for: [event])
        if shouldRebuildDisplayEvents(for: [event]) {
            rebuildDisplayEvents()
        }
        if isAgentVisibleMessage(event) {
            let notificationCandidate = notificationCandidate(for: event)
            if event.session_id != selectedSessionID {
                markAgentUnread(sessionID: event.session_id, firstSeq: event.seq)
            } else if !selectedTimelineAtBottom || !NSApp.isActive {
                markAgentUnread(sessionID: event.session_id, firstSeq: event.seq)
            } else {
                setLastReadAgentSeq(event.seq, for: event.session_id)
            }
            if let notificationCandidate {
                deliverUnreadNotification(notificationCandidate)
            }
        }
        if ["turn_started", "turn_queued", "turn_unqueued", "assistant_text", "turn_finished", "error"].contains(event.type) {
            AppLogger.info("event session=\(event.session_id) seq=\(event.seq) type=\(event.type)")
        }
        if event.type == "turn_started" {
            activeSessionIDs.insert(event.session_id)
            syncSelectedRunningState()
        }
        if event.type == "turn_finished" || event.type == "error" || event.type == "turn_stopped" {
            activeSessionIDs.remove(event.session_id)
            syncSelectedRunningState()
            if event.session_id == selectedSessionID {
                processSnapshot = nil
                processLogTail = nil
            }
        }
        if let file = event.file {
            addPendingUpload(file)
            upsertSessionFile(file)
        }
        if let artifact = event.artifact {
            upsertSessionFile(artifact)
        }
        if event.type != "raw_event" {
            saveSelectedChatCache()
        }
    }

    private func clearLaunchDeferredIfResolved(by event: ZEvent) {
        guard event.session_id == selectedSessionID,
              launchDeferredText != nil,
              ["turn_started", "assistant_text", "turn_finished", "error", "turn_stopped"].contains(event.type) else {
            return
        }
        launchDeferredText = nil
    }

    private func requestScrollToBottom(immediate: Bool = false) {
        let now = Date()
        if immediate || now.timeIntervalSince(lastScrollRequestAt) >= 0.22 {
            pendingScrollRequest?.cancel()
            pendingScrollRequest = nil
            lastScrollRequestAt = now
            if immediate {
                forcedScrollToBottomRevision += 1
            } else {
                scrollToBottomRevision += 1
            }
            return
        }

        pendingScrollRequest?.cancel()
        pendingScrollRequest = Task { @MainActor in
            try? await Task.sleep(nanoseconds: 220_000_000)
            guard !Task.isCancelled else { return }
            self.lastScrollRequestAt = Date()
            self.scrollToBottomRevision += 1
        }
    }

    private func preserveSelectedTimelineIfNeeded(for incoming: [ZEvent]) {
        guard !selectedTimelineAtBottom,
              let selectedSessionID,
              incoming.contains(where: { $0.session_id == selectedSessionID && isAgentVisibleMessage($0) }) else {
            return
        }
        preserveTimelineScrollRevision += 1
    }

    private func mergeEvents(_ incoming: [ZEvent]) {
        guard !incoming.isEmpty else { return }
        let existingIDs = Set(events.map(\.id))
        let incomingEvents = timelineEvents(from: incoming)
        let newEvents = incomingEvents.filter { !existingIDs.contains($0.id) }
        guard !newEvents.isEmpty else {
            latestSeenSeq = max(latestSeenSeq, incoming.map(\.seq).max() ?? 0)
            return
        }
        applyQueuedTurnState(from: newEvents)
        events.append(contentsOf: newEvents)
        sortEventsBySeqIfNeeded()
        if events.count > maxLoadedTimelineEvents {
            let overflow = events.count - maxLoadedTimelineEvents
            events.removeFirst(overflow)
            omittedHistoryEventCount += overflow
        }
        latestSeenSeq = max(latestSeenSeq, incoming.map(\.seq).max() ?? 0)
        refreshSessionFilesFromLoadedEvents()
        if shouldRebuildDisplayEvents(for: newEvents) {
            rebuildDisplayEvents()
        }
    }

    private func mergeEventsKeeping(_ incoming: ZEvent) {
        let incomingEvents = timelineEvents(from: [incoming])
        guard !incomingEvents.isEmpty else { return }
        let existingIDs = Set(events.map(\.id))
        let newEvents = incomingEvents.filter { !existingIDs.contains($0.id) }
        if !newEvents.isEmpty {
            applyQueuedTurnState(from: newEvents)
            events.append(contentsOf: newEvents)
            sortEventsBySeqIfNeeded()
        }
        let protectedIDs = Set(incomingEvents.map(\.id))
        while events.count > maxLoadedTimelineEvents {
            guard let index = events.firstIndex(where: { !protectedIDs.contains($0.id) }) else { break }
            if index == 0 {
                omittedHistoryEventCount += 1
            }
            events.remove(at: index)
        }
        latestSeenSeq = max(latestSeenSeq, incoming.seq)
        refreshSessionFilesFromLoadedEvents()
        if shouldRebuildDisplayEvents(for: newEvents) {
            rebuildDisplayEvents()
        }
        saveSelectedChatCache()
    }

    private func eventContaining(fileID: String, in source: [ZEvent]) -> ZEvent? {
        source.first { event in
            event.file?.id == fileID || event.artifact?.id == fileID
        }
    }

    @discardableResult
    private func applySessionEventSnapshot(
        _ response: SessionEventsResponse,
        sessionID: String,
        preserveExisting: Bool = true
    ) -> Bool {
        replaceSessionFromServer(response.session)
        let queueChanged = applyAuthoritativeQueuedTurns(response.queued_turns, sessionID: sessionID)
        let snapshotEvents = timelineEvents(from: response.events)
        if response.queued_turns == nil {
            applyQueuedTurnState(from: snapshotEvents)
        }
        let oldCount = events.count
        let oldTextWeight = timelineDisplayWeight(displayEvents)
        let candidatePreservedEvents = preserveExisting ? events.filter { $0.session_id == sessionID } : []
        let candidatePreservedIDs = Set(candidatePreservedEvents.map(\.id))
        let snapshotIDs = Set(snapshotEvents.map(\.id))
        let disconnectedSnapshot = !candidatePreservedEvents.isEmpty &&
            !snapshotEvents.isEmpty &&
            candidatePreservedIDs.isDisjoint(with: snapshotIDs)
        let preservedEvents = disconnectedSnapshot ? [] : candidatePreservedEvents
        if disconnectedSnapshot {
            AppLogger.warning(
                "replaced disconnected cached timeline session=\(sessionID) " +
                    "cached=\(candidatePreservedEvents.count) authoritative=\(snapshotEvents.count)"
            )
        }
        let preservedIDs = Set(preservedEvents.map(\.id))
        let newSnapshotEventCount = preserveExisting
            ? snapshotEvents.filter { !preservedIDs.contains($0.id) }.count
            : snapshotEvents.count
        let projectedEvents = projectedTimelineEventsAfterSnapshot(
            snapshotEvents: snapshotEvents,
            preservedEvents: preservedEvents
        )
        let shouldMaskLargeBatch = shouldMaskTimelineBatch(
            oldCount: oldCount,
            newCount: projectedEvents.count,
            incomingCount: newSnapshotEventCount,
            oldTextWeight: oldTextWeight,
            newTextWeight: timelineDisplayWeight(makeDisplayEvents(from: projectedEvents))
        )
        if shouldMaskLargeBatch {
            beginLargeTimelineBatchMask()
        }
        if preserveExisting,
           !preservedEvents.isEmpty,
           newSnapshotEventCount == 0 {
            let firstSnapshotSeq = snapshotEvents.map(\.seq).min()
            let preservedBeforeSnapshot = firstSnapshotSeq.map { seq in
                preservedEvents.filter { $0.seq < seq }.count
            } ?? 0
            omittedHistoryEventCount = max(0, (response.events_omitted_before ?? 0) - preservedBeforeSnapshot)
            latestSeenSeq = max(response.latest_seq ?? 0, latestSeenSeq, events.map(\.seq).max() ?? 0)
            if shouldMaskLargeBatch {
                scheduleLargeTimelineBatchReveal()
            }
            return queueChanged
        }
        if preservedEvents.isEmpty {
            events = snapshotEvents
            omittedHistoryEventCount = response.events_omitted_before ?? 0
        } else {
            var byID: [String: ZEvent] = [:]
            for event in preservedEvents {
                byID[event.id] = event
            }
            for event in snapshotEvents {
                byID[event.id] = event
            }
            var mergedEvents = byID.values.sorted { $0.seq < $1.seq }
            let firstSnapshotSeq = snapshotEvents.map(\.seq).min()
            let preservedBeforeSnapshot = firstSnapshotSeq.map { seq in
                mergedEvents.filter { $0.seq < seq }.count
            } ?? 0
            var omittedBefore = max(0, (response.events_omitted_before ?? 0) - preservedBeforeSnapshot)
            if mergedEvents.count > maxLoadedTimelineEvents {
                let overflow = mergedEvents.count - maxLoadedTimelineEvents
                mergedEvents.removeFirst(overflow)
                omittedBefore += overflow
            }
            events = mergedEvents
            omittedHistoryEventCount = omittedBefore
        }
        latestSeenSeq = max(response.latest_seq ?? 0, events.map(\.seq).max() ?? 0)
        refreshSessionFilesFromLoadedEvents()
        rebuildDisplayEvents()
        if shouldMaskLargeBatch {
            scheduleLargeTimelineBatchReveal()
        }
        return true
    }

    private func projectedTimelineEventsAfterSnapshot(snapshotEvents: [ZEvent], preservedEvents: [ZEvent]) -> [ZEvent] {
        guard !preservedEvents.isEmpty else { return snapshotEvents }
        var byID: [String: ZEvent] = [:]
        for event in preservedEvents {
            byID[event.id] = event
        }
        for event in snapshotEvents {
            byID[event.id] = event
        }
        var mergedEvents = byID.values.sorted { $0.seq < $1.seq }
        if mergedEvents.count > maxLoadedTimelineEvents {
            mergedEvents.removeFirst(mergedEvents.count - maxLoadedTimelineEvents)
        }
        return mergedEvents
    }

    private func timelineDisplayWeight(_ source: [ZEvent]) -> Int {
        source.reduce(0) { total, event in
            let eventWeight = [
                event.text,
                event.result_text,
                event.output,
                event.message,
                event.prompt
            ].compactMap { value in
                value.map { min($0.count, largeTimelineBatchCharacterThreshold * 2) }
            }.reduce(0, +)
            return total + eventWeight
        }
    }

    private func requestScrollToEvent(_ eventID: String) {
        scrollToEventID = eventID
        scrollToEventRevision += 1
    }

    private func addPendingUpload(_ file: ZFile) {
        guard !uploads.contains(where: { $0.id == file.id }) else { return }
        uploads.append(file)
    }

    private func applyCachedChat(_ cached: CachedChat) {
        let perfStart = DispatchTime.now()
        defer {
            let ms = Double(DispatchTime.now().uptimeNanoseconds - perfStart.uptimeNanoseconds) / 1_000_000
            AppLogger.info("PERF applyCachedChat events=\(events.count) files=\(sessionFiles.count) ms=\(String(format: "%.1f", ms))")
        }
        if !sessions.contains(where: { $0.id == cached.session.id }) {
            sessions.append(cached.session)
        }
        let cachedEvents = timelineEvents(from: cached.events)
        let limit = maxCachedTimelineEvents
        events = Array(cachedEvents.suffix(limit))
        omittedHistoryEventCount = cached.omittedHistoryEventCount + max(0, cachedEvents.count - events.count)
        sessionFiles = mergedFiles((cached.sessionFiles ?? []) + files(from: events))
        sessionVideoFiles = mergedFiles(sessionFiles.filter { ($0.content_type ?? "").hasPrefix("video/") })
        sessionFilesTotal = sessionFiles.isEmpty ? nil : sessionFiles.count
        sessionFilesHasMore = false
        sessionFilesNextOffset = 0
        refreshSessionFilesFromLoadedEvents()
        loadedSessionID = cached.session.id
        latestSeenSeq = events.map(\.seq).max() ?? 0
        rebuildDisplayEvents()
    }

    private var hasRenderableSelectedTimeline: Bool {
        guard let selectedSessionID else { return false }
        return loadedSessionID == selectedSessionID && !displayEvents.isEmpty
    }

    private func refreshSessionFilesFromLoadedEvents() {
        let known = files(from: events)
        guard !known.isEmpty || sessionFiles.isEmpty else { return }
        let nextFiles = mergedFiles(sessionFiles + known)
        if sessionFiles != nextFiles {
            sessionFiles = nextFiles
        }
        let videos = known.filter { ($0.content_type ?? "").hasPrefix("video/") }
        if !videos.isEmpty {
            let nextVideos = mergedFiles(sessionVideoFiles + videos)
            if sessionVideoFiles != nextVideos {
                sessionVideoFiles = nextVideos
            }
        }
    }

    private func files(from source: [ZEvent]) -> [ZFile] {
        source.flatMap { event -> [ZFile] in
            [event.file, event.artifact].compactMap { $0 }
        }
    }

    private func scheduleSessionMediaCacheRebuild() {
        guard !sessionMediaCacheRebuildScheduled else { return }
        sessionMediaCacheRebuildScheduled = true
        Task { @MainActor [weak self] in
            guard let self else { return }
            self.sessionMediaCacheRebuildScheduled = false
            self.rebuildSessionMediaCaches()
        }
    }

    private func rebuildSessionMediaCaches() {
        let nextVideos = mergedFiles((sessionFiles + sessionVideoFiles).filter { file in
            (file.content_type ?? "").hasPrefix("video/")
        })
        if sessionVideos != nextVideos {
            sessionVideos = nextVideos
        }
    }

    private func upsertSessionFile(_ file: ZFile) {
        let nextFiles = mergedFiles(sessionFiles + [file])
        if sessionFiles != nextFiles {
            sessionFiles = nextFiles
        }
        if (file.content_type ?? "").hasPrefix("video/") {
            let nextVideos = mergedFiles(sessionVideoFiles + [file])
            if sessionVideoFiles != nextVideos {
                sessionVideoFiles = nextVideos
            }
        }
        if let total = sessionFilesTotal {
            let nextTotal = max(total, sessionFiles.count)
            if sessionFilesTotal != nextTotal {
                sessionFilesTotal = nextTotal
            }
        }
    }

    private func loadSessionFiles(sessionID: String, generation: Int, reset: Bool = true) async {
        guard !isLoadingSessionFiles else { return }
        isLoadingSessionFiles = true
        defer { isLoadingSessionFiles = false }
        let offset = reset ? 0 : sessionFilesNextOffset
        do {
            struct Response: Codable {
                let files: [ZFile]
                let total: Int?
                let offset: Int?
                let limit: Int?
                let has_more: Bool?
            }
            let res: Response = try await api.get(
                "/api/sessions/\(sessionID)/files",
                queryItems: [
                    URLQueryItem(name: "limit", value: "\(sessionFilesPageLimit)"),
                    URLQueryItem(name: "offset", value: "\(offset)")
                ]
            )
            guard selectedSessionID == sessionID, selectionGeneration == generation else { return }
            let timelineFiles = files(from: events)
            let nextFiles: [ZFile]
            if reset {
                nextFiles = mergedFiles(res.files + timelineFiles + sessionVideoFiles)
            } else {
                nextFiles = mergedFiles(sessionFiles + res.files + timelineFiles)
            }
            if sessionFiles != nextFiles {
                sessionFiles = nextFiles
            }
            let nextTotal = res.total ?? max(sessionFilesTotal ?? 0, sessionFiles.count)
            if sessionFilesTotal != nextTotal {
                sessionFilesTotal = nextTotal
            }
            let nextOffset = (res.offset ?? offset) + res.files.count
            if sessionFilesNextOffset != nextOffset {
                sessionFilesNextOffset = nextOffset
            }
            let nextHasMore = res.has_more ?? false
            if sessionFilesHasMore != nextHasMore {
                sessionFilesHasMore = nextHasMore
            }
            saveSelectedChatCache()
        } catch {
            AppLogger.error("files failed session=\(sessionID) \(serverErrorMessage(error) ?? "\(error)")")
        }
    }

    private func loadSessionVideoFiles(sessionID: String, generation: Int) async {
        guard !isLoadingSessionVideos else { return }
        isLoadingSessionVideos = true
        defer { isLoadingSessionVideos = false }
        do {
            struct Response: Codable {
                let files: [ZFile]
                let total: Int?
            }
            let res: Response = try await api.get(
                "/api/sessions/\(sessionID)/files",
                queryItems: [
                    URLQueryItem(name: "content_prefix", value: "video/"),
                    URLQueryItem(name: "limit", value: "\(sessionFilesPageLimit)"),
                    URLQueryItem(name: "offset", value: "0")
                ]
            )
            guard selectedSessionID == sessionID, selectionGeneration == generation else { return }
            let videos = mergedFiles(res.files + files(from: events).filter { ($0.content_type ?? "").hasPrefix("video/") })
            if sessionVideoFiles != videos {
                sessionVideoFiles = videos
            }
            let nextFiles = mergedFiles(sessionFiles + videos)
            if sessionFiles != nextFiles {
                sessionFiles = nextFiles
            }
            if let total = res.total, total > videos.count {
                AppLogger.info("video metadata partially loaded session=\(sessionID) loaded=\(videos.count) total=\(total)")
            }
            saveSelectedChatCache()
        } catch {
            AppLogger.error("videos failed session=\(sessionID) \(serverErrorMessage(error) ?? "\(error)")")
        }
    }

    private func mergedFiles(_ files: [ZFile]) -> [ZFile] {
        var byID: [String: ZFile] = [:]
        for file in files {
            byID[file.id] = file
        }
        return byID.values.sorted { lhs, rhs in
            let leftDate = lhs.created_at ?? ""
            let rightDate = rhs.created_at ?? ""
            if leftDate != rightDate {
                return leftDate > rightDate
            }
            return lhs.filename.localizedStandardCompare(rhs.filename) == .orderedAscending
        }
    }

    private var chatCacheDirectory: URL {
        chatCacheDirectory(namespace: serverCacheNamespace)
    }

    private func chatCacheDirectory(namespace: String) -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support", isDirectory: true)
        return base
            .appendingPathComponent("ZenithDock", isDirectory: true)
            .appendingPathComponent("ChatCache", isDirectory: true)
            .appendingPathComponent(namespace, isDirectory: true)
    }

    private var serverCacheNamespace: String {
        if let serverIdentity {
            return ZEndpointCache.namespace(serverIdentity: serverIdentity)
        }
        return ZEndpointCache.namespace(serverURL: serverURLString, default: defaultAgentServerURLString)
    }

    private func chatCacheKey(_ sessionID: String) -> String {
        "\(serverCacheNamespace)|\(sessionID)"
    }

    private func chatCacheURL(_ sessionID: String) -> URL {
        chatCacheDirectory.appendingPathComponent("\(sessionID).json")
    }

    private func memoryCachedChat(_ sessionID: String) -> CachedChat? {
        let key = chatCacheKey(sessionID)
        guard let cached = memoryChatCache[key] else { return nil }
        touchMemoryChatCache(key)
        return cached
    }

    private func rememberChatCache(_ cached: CachedChat) {
        let key = chatCacheKey(cached.session.id)
        memoryChatCache[key] = cached
        touchMemoryChatCache(key)
        while memoryChatCacheOrder.count > maxMemoryCachedChats, let staleID = memoryChatCacheOrder.first {
            memoryChatCacheOrder.removeFirst()
            memoryChatCache.removeValue(forKey: staleID)
        }
    }

    private func touchMemoryChatCache(_ key: String) {
        memoryChatCacheOrder.removeAll { $0 == key }
        memoryChatCacheOrder.append(key)
    }

    private func rememberSelectedChatInMemory() {
        guard let session = selectedSession, !events.isEmpty else { return }
        let cacheWindow = selectedChatCacheWindow()
        guard !cacheWindow.events.isEmpty else { return }
        let cached = CachedChat(
            session: session,
            events: cacheWindow.events,
            sessionFiles: sessionFiles.isEmpty ? files(from: events) : sessionFiles,
            omittedHistoryEventCount: cacheWindow.omittedBefore,
            cachedAt: ISO8601DateFormatter().string(from: Date())
        )
        rememberChatCache(cached)
    }

    private func selectedChatCacheWindow() -> (events: [ZEvent], omittedBefore: Int) {
        // A cached suffix drops a locally loaded prefix; preserve that count so a
        // warm restore can still offer the missing history to older-page loading.
        let cacheableEvents = events.filter { $0.type != "raw_event" }
        let cachedEvents = Array(cacheableEvents.suffix(maxCachedTimelineEvents))
        return (
            events: cachedEvents,
            omittedBefore: omittedHistoryEventCount + max(0, cacheableEvents.count - cachedEvents.count)
        )
    }

    nonisolated private static func loadCachedChat(from url: URL) async -> CachedChat? {
        await Task.detached(priority: .userInitiated) {
            guard let data = try? Data(contentsOf: url) else { return nil }
            return try? JSONDecoder().decode(CachedChat.self, from: data)
        }.value
    }

    private func saveSelectedChatCache() {
        let sessionID = selectedSessionID
        let generation = selectionGeneration
        pendingCacheWrite?.cancel()
        pendingCacheWrite = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 650_000_000)
            guard let self,
                  !Task.isCancelled,
                  self.selectedSessionID == sessionID,
                  self.selectionGeneration == generation else {
                return
            }
            self.writeSelectedChatCacheSnapshot()
        }
    }

    private func writeSelectedChatCacheSnapshot() {
        guard let session = selectedSession else { return }
        let directory = chatCacheDirectory
        let url = chatCacheURL(session.id)
        let cacheWindow = selectedChatCacheWindow()
        let eventsToCache = cacheWindow.events
        let cachedAt = ISO8601DateFormatter().string(from: Date())
        let cachedFiles = sessionFiles.isEmpty ? files(from: events) : sessionFiles
        let warmCached = CachedChat(
            session: session,
            events: eventsToCache,
            sessionFiles: cachedFiles,
            omittedHistoryEventCount: cacheWindow.omittedBefore,
            cachedAt: cachedAt
        )
        rememberChatCache(warmCached)
        let maxCharacters = maxCachedStringCharacters
        Task.detached(priority: .utility) {
            let cached = CachedChat(
                session: session,
                events: eventsToCache.map { Self.sanitizedForCache($0, maxCharacters: maxCharacters) },
                sessionFiles: cachedFiles,
                omittedHistoryEventCount: warmCached.omittedHistoryEventCount,
                cachedAt: cachedAt
            )
            do {
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                let data = try JSONEncoder().encode(cached)
                try data.write(to: url, options: .atomic)
            } catch {
                AppLogger.warning("cache write failed session=\(session.id) \(error)")
            }
        }
    }

    private func deleteCachedChat(_ sessionID: String) {
        pendingCacheWrite?.cancel()
        let key = chatCacheKey(sessionID)
        memoryChatCache.removeValue(forKey: key)
        memoryChatCacheOrder.removeAll { $0 == key }
        try? FileManager.default.removeItem(at: chatCacheURL(sessionID))
    }

    private static func loadServerIdentity(for serverURL: String) -> String? {
        let namespace = ZEndpointCache.namespace(serverURL: serverURL, default: defaultAgentServerURLString)
        return UserDefaults.standard.string(forKey: serverIdentityDefaultsKey(namespace: namespace))
    }

    private func saveServerIdentity(_ identity: String, for serverURL: String) {
        let namespace = ZEndpointCache.namespace(serverURL: serverURL, default: defaultAgentServerURLString)
        UserDefaults.standard.set(identity, forKey: Self.serverIdentityDefaultsKey(namespace: namespace))
    }

    private static func serverIdentityDefaultsKey(namespace: String) -> String {
        "ZenithDock.serverIdentity.\(namespace)"
    }

    private func timelineEvents(from source: [ZEvent]) -> [ZEvent] {
        showDebugEvents ? source : source.filter { $0.type != "raw_event" }
    }

    private func isPrimaryTimelinePageEvent(_ event: ZEvent) -> Bool {
        if Self.nonPrimaryTimelinePageEventTypes.contains(event.type) {
            return false
        }
        if event.type == "assistant_text" {
            return event.text?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
        }
        if event.type == "turn_finished" {
            return event.result_text?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
        }
        return true
    }

    private static let nonPrimaryTimelinePageEventTypes: Set<String> = [
        "reasoning_summary",
        "tool_started",
        "tool_finished",
        "idle_warning",
        "raw_event",
        "process_started",
        "provider_session",
        "cwd_fallback",
        "history_imported",
        "backend_changed",
        "artifact_error",
        "session_created"
    ]

    nonisolated private static func sanitizedForCache(_ event: ZEvent, maxCharacters: Int) -> ZEvent {
        var copy = event
        copy.raw = nil
        copy.output = trimmedForCache(copy.output, maxCharacters: maxCharacters)
        copy.text = trimmedForCache(copy.text, maxCharacters: maxCharacters)
        copy.result_text = trimmedForCache(copy.result_text, maxCharacters: maxCharacters)
        copy.message = trimmedForCache(copy.message, maxCharacters: maxCharacters)
        copy.prompt = trimmedForCache(copy.prompt, maxCharacters: maxCharacters)
        if var tool = copy.tool {
            tool.input = trimmedJSONForCache(tool.input, maxCharacters: maxCharacters)
            copy.tool = tool
        }
        return copy
    }

    nonisolated private static func trimmedForCache(_ value: String?, maxCharacters: Int) -> String? {
        guard let value, value.count > maxCharacters else { return value }
        return String(value.prefix(maxCharacters)).trimmingCharacters(in: .whitespacesAndNewlines) + "\n\n[trimmed in local cache]"
    }

    nonisolated private static func trimmedJSONForCache(_ value: JSONValue?, maxCharacters: Int) -> JSONValue? {
        guard let value else { return nil }
        switch value {
        case .string(let string):
            return .string(trimmedForCache(string, maxCharacters: maxCharacters) ?? string)
        case .array(let array):
            return .array(array.prefix(40).map { trimmedJSONForCache($0, maxCharacters: maxCharacters) ?? .null })
        case .object(let object):
            return .object(object.mapValues { trimmedJSONForCache($0, maxCharacters: maxCharacters) ?? .null })
        case .number, .bool, .null:
            return value
        }
    }

    private func scheduleReconnect(sessionID: String, failedTask: URLSessionWebSocketTask) {
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            await MainActor.run {
                guard let self,
                      self.webSocket == nil || self.webSocket === failedTask,
                      self.selectedSessionID == sessionID,
                      self.serverReachable else {
                    return
                }
                self.connectEvents(sessionID: sessionID, after: self.lastSeq)
            }
        }
    }

    private func reportServerError(_ error: Error) {
        guard let message = serverErrorMessage(error) else { return }
        if isAgentLaunchDeferred(error, message: message) {
            if launchDeferredText != message {
                launchDeferredText = message
            }
            setStatus("Launch deferred")
            return
        }
        if isConnectionError(error) {
            if connectionProblemText != message {
                connectionProblemText = message
            }
            setStatus("Server offline")
            return
        }
        errorText = message
    }

    private func serverErrorMessage(_ error: Error) -> String? {
        let ns = error as NSError
        if ns.domain == NSURLErrorDomain && ns.code == NSURLErrorCancelled {
            return nil
        }
        if ns.domain == NSURLErrorDomain {
            if ns.code == NSURLErrorAppTransportSecurityRequiresSecureConnection {
                return "macOS App Transport Security blocked HTTP to \(serverURLString). Install the latest ZenithDock build with arbitrary user-entered agent HTTP URLs enabled, or use HTTPS."
            }
            if isLocalNetworkPrivacyError(ns) {
                return "macOS blocked ZenithDock from accessing the local network. Open System Settings > Privacy & Security > Local Network and enable ZenithDock, or use a reachable Tailscale endpoint."
            }
            return "Cannot reach the ZenithDock agent server at \(serverURLString). The Mac internet may be fine; this means the app cannot reach the configured host or port 7850 right now."
        }
        if ns.domain == "ZenithDock.API", ns.code == 401 || ns.code == 403 {
            return "Agent server rejected the access token. Check ZENITHDOCK_AGENT_TOKEN on the server and the token field in the app."
        }
        if let detail = apiErrorDetail(error) {
            return detail
        }
        return error.localizedDescription
    }

    private func apiErrorDetail(_ error: Error) -> String? {
        let ns = error as NSError
        guard ns.domain == "ZenithDock.API" else { return nil }
        let raw = ns.localizedDescription
        guard let data = raw.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let detail = object["detail"] as? String,
              !detail.isEmpty
        else {
            return raw
        }
        return detail
    }

    private func isAgentLaunchDeferred(_ error: Error, message: String) -> Bool {
        let ns = error as NSError
        return ns.domain == "ZenithDock.API" &&
            ns.code == 503 &&
            message.localizedCaseInsensitiveContains("agent launch deferred")
    }

    private func isConnectionError(_ error: Error) -> Bool {
        let ns = error as NSError
        return ns.domain == NSURLErrorDomain && ns.code != NSURLErrorCancelled
    }

    private func isLocalNetworkPrivacyError(_ error: NSError) -> Bool {
        guard error.code == NSURLErrorNotConnectedToInternet else { return false }
        if let streamCode = error.userInfo["_kCFStreamErrorCodeKey"] as? Int, streamCode == 50 {
            return true
        }
        if let underlying = error.userInfo[NSUnderlyingErrorKey] as? NSError {
            if let streamCode = underlying.userInfo["_kCFStreamErrorCodeKey"] as? Int, streamCode == 50 {
                return true
            }
            if let nested = underlying.userInfo[NSUnderlyingErrorKey] as? NSError,
               let streamCode = nested.userInfo["_kCFStreamErrorCodeKey"] as? Int,
               streamCode == 50 {
                return true
            }
        }
        return false
    }

    private func cleanServerURL() {
        UserDefaults.standard.set(serverURLString, forKey: "serverURL")
    }
}
