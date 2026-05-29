import Combine
import Foundation
import ZenithCore

private let defaultAgentServerURLString = "http://127.0.0.1:7850"
private let fallbackServerCwd = "~"
private let minimumAgentAPIContractVersion = 3

@MainActor
final class AppStore: ObservableObject {
    @Published var serverURLString = UserDefaults.standard.string(forKey: "serverURL") ?? defaultAgentServerURLString
    @Published var accessToken = ZenithTokenStore.load()
    @Published var sessions: [ZSession] = []
    @Published var selectedSessionID: String?
    @Published var events: [ZEvent] = []
    @Published var uploads: [ZFile] = []
    @Published var sessionFiles: [ZFile] = []
    @Published var sessionVideoFiles: [ZFile] = []
    @Published var sessionFilesTotal: Int?
    @Published var sessionFilesHasMore = false
    @Published var isLoadingSessionFiles = false
    @Published var isLoadingSessionVideos = false
    @Published var prompt = ""
    @Published var isRunning = false
    @Published var status = "Disconnected"
    @Published var errorText: String?
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
    @Published var lastHealthAt: Date?
    @Published var lastLoadedAt: Date?
    @Published var lastSocketError: String?
    @Published var omittedHistoryEventCount = 0
    @Published var isLoadingOlderHistory = false
    @Published var scrollToBottomRevision = 0
    @Published var scrollToEventID: String?
    @Published var scrollToEventRevision = 0
    @Published var processSnapshot: ZProcessSnapshot?
    @Published var processLogTail: ZProcessLogTail?
    @Published var isLoadingProcesses = false
    @Published var tmuxSnapshot: ZTmuxSnapshot?
    @Published var tmuxCapture: ZTmuxCapture?
    @Published var isLoadingTmux = false
    @Published private(set) var unreadAgentSessionIDs: Set<String> = []
    @Published private(set) var firstUnreadAgentSeqBySessionID: [String: Int] = [:]
    @Published private(set) var selectedTimelineAtBottom = true
    @Published private(set) var folderOrder: [String] = UserDefaults.standard.stringArray(forKey: "folderOrder") ?? []
    @Published private(set) var collapsedFolders: Set<String> = Set(UserDefaults.standard.stringArray(forKey: "collapsedFolders") ?? [])
    @Published private(set) var archivedSectionCollapsed = UserDefaults.standard.bool(forKey: "archivedSectionCollapsed")

    private let initialSessionEventLimit = 480
    private let olderHistoryPageLimit = 160
    private let maxLoadedTimelineEvents = 2_000
    private let maxCachedTimelineEvents = 1_440
    private let maxWarmCachedTimelineEvents = 480
    private let maxCachedStringCharacters = 12_000
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
    private var lastReadAgentSeqBySessionID: [String: Int] = [:]
    private var manuallyUnreadSessionIDs: Set<String> = []
    private var pendingReadSyncBySessionID: [String: Int] = [:]
    private var serverIdentity: String?
    private var lastScrollRequestAt = Date.distantPast
    private var sessionFilesNextOffset = 0
    private var lastSeq: Int { max(latestSeenSeq, events.map(\.seq).max() ?? 0) }
    private let maxMemoryCachedChats = 32
    private let streamBackfillMaskThreshold = 18
    private let largeTimelineBatchEventThreshold = 80

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
    }

    init() {
        serverIdentity = Self.loadServerIdentity(for: serverURLString)
        lastReadAgentSeqBySessionID = loadReadState()
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

    var activeSessions: [ZSession] {
        orderedSessions(sessions.filter { $0.archived != true })
    }

    var archivedSessions: [ZSession] {
        orderedSessions(sessions.filter { $0.archived == true })
    }

    var pinnedSessions: [ZSession] {
        activeSessions.filter { $0.pinned == true }
    }

    var folders: [String: [ZSession]] {
        Dictionary(grouping: activeSessions.filter { $0.pinned != true }) { $0.folder ?? "General" }
    }

    var folderNames: [String] {
        orderedFolderNames(Array(Set(activeSessions.map { $0.folder ?? "General" })))
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

    func digestTargetSessions(excluding sourceSessionID: String) -> [ZSession] {
        activeSessions.filter { $0.id != sourceSessionID }
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
        let loaded = sessions.isEmpty ? "no chats loaded" : "\(sessions.count) chats loaded"
        let active = activeSessionIDs.isEmpty ? "no active runs" : "\(activeSessionIDs.count) active"
        let stream = selectedSessionID == nil ? "no chat selected" : (socketLive ? "streaming selected chat" : "stream reconnecting")
        if !serverReachable, let connectionProblemText, !connectionProblemText.isEmpty {
            return connectionProblemText
        }
        return "\(loaded) · \(active) · \(stream)"
    }

    var hiddenDisplayEventCount: Int {
        omittedHistoryEventCount
    }

    var canLoadOlderHistory: Bool {
        omittedHistoryEventCount > 0 && !isLoadingOlderHistory
    }

    var sessionVideos: [ZFile] {
        mergedFiles(sessionFiles + sessionVideoFiles)
            .filter { ($0.content_type ?? "").hasPrefix("video/") }
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
        let assistantRuns = Set(source.compactMap { event -> String? in
            guard event.type == "assistant_text",
                  hasVisibleText(event.text) else {
                return nil
            }
            return event.run_id
        })
        return source.filter { event in
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

    private func rebuildDisplayEvents() {
        displayEvents = makeDisplayEvents(from: events)
    }

    private func shouldMaskTimelineBatch(oldCount: Int, newCount: Int, incomingCount: Int) -> Bool {
        incomingCount >= largeTimelineBatchEventThreshold ||
            abs(newCount - oldCount) >= largeTimelineBatchEventThreshold
    }

    private func beginLargeTimelineBatchMask() {
        timelineBatchRevealTask?.cancel()
        timelineBatchRevealTask = nil
        if !isApplyingLargeTimelineBatch {
            isApplyingLargeTimelineBatch = true
        }
        status = "Opening latest messages"
    }

    private func scheduleLargeTimelineBatchReveal() {
        timelineBatchRevealTask?.cancel()
        timelineBatchRevealTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: 320_000_000)
            guard !Task.isCancelled else { return }
            self.isApplyingLargeTimelineBatch = false
            if !self.isRefreshingCachedDelta {
                self.status = self.socketLive ? "Live" : "Server connected"
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
        guard selectedTimelineAtBottom != atBottom else {
            if atBottom {
                markSelectedSessionRead()
            }
            return
        }
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
        unreadAgentSessionIDs.remove(sessionID)
        firstUnreadAgentSeqBySessionID.removeValue(forKey: sessionID)
        manuallyUnreadSessionIDs.remove(sessionID)
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
        latestAgentEventSeq(for: session.id) != nil
    }

    func markAgentUnread(sessionID: String, firstSeq: Int? = nil) {
        if let firstSeq {
            let existing = firstUnreadAgentSeqBySessionID[sessionID]
            firstUnreadAgentSeqBySessionID[sessionID] = existing.map { min($0, firstSeq) } ?? firstSeq
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

    private func setLastReadAgentSeq(_ seq: Int, for sessionID: String, allowDecrease: Bool = false) {
        guard allowDecrease || seq > (lastReadAgentSeqBySessionID[sessionID] ?? 0) else { return }
        lastReadAgentSeqBySessionID[sessionID] = seq
        saveReadState()
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
        if let idx = sessions.firstIndex(where: { $0.id == session.id }) {
            sessions[idx] = session
        }
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
        let eventSeq = events
            .filter { $0.session_id == sessionID && isAgentVisibleMessage($0) }
            .map(\.seq)
            .max()
        return [sessionSeq, eventSeq].compactMap { $0 }.max()
    }

    private func reconcileUnreadFromSessions() {
        let knownSessionIDs = Set(sessions.map(\.id))
        unreadAgentSessionIDs = unreadAgentSessionIDs.intersection(knownSessionIDs)
        firstUnreadAgentSeqBySessionID = firstUnreadAgentSeqBySessionID.filter { knownSessionIDs.contains($0.key) }

        for session in sessions {
            guard let latestSeq = session.latest_agent_event_seq else { continue }
            let serverManualUnread = session.manual_unread == true
            if let serverReadSeq = session.last_read_agent_event_seq,
               serverReadSeq > (lastReadAgentSeqBySessionID[session.id] ?? 0) {
                setLastReadAgentSeq(serverReadSeq, for: session.id)
            }
            if serverManualUnread, session.id != selectedSessionID {
                manuallyUnreadSessionIDs.insert(session.id)
            }
            if session.id == selectedSessionID, selectedTimelineAtBottom {
                markSessionRead(session.id)
                continue
            }
            let lastReadSeq = lastReadAgentSeqBySessionID[session.id] ?? 0
            if serverManualUnread || latestSeq > lastReadSeq {
                markAgentUnread(sessionID: session.id, firstSeq: lastReadSeq + 1)
            } else {
                unreadAgentSessionIDs.remove(session.id)
                firstUnreadAgentSeqBySessionID.removeValue(forKey: session.id)
                manuallyUnreadSessionIDs.remove(session.id)
            }
        }
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
        timelineBatchRevealTask?.cancel()
        timelineBatchRevealTask = nil
        webSocket?.cancel(with: .goingAway, reason: nil)
        webSocket = nil
        webSocketSessionID = nil
        socketLive = false
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
        lastReadAgentSeqBySessionID = loadReadState()
        unreadAgentSessionIDs = []
        firstUnreadAgentSeqBySessionID = [:]
        manuallyUnreadSessionIDs = []
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
            serverReachable = res.ok
            adoptServerIdentity(res.server_identity)
            if let cleanCwd = res.default_cwd?.trimmingCharacters(in: .whitespacesAndNewlines), !cleanCwd.isEmpty {
                defaultCwd = cleanCwd
            }
            activeSessionIDs = Set(res.active)
            lastHealthAt = Date()
            connectionProblemText = nil
            syncSelectedRunningState()
            status = socketLive ? "Live" : "Server connected"
            if let sid = selectedSessionID, !activeSessionIDs.contains(sid), processSnapshot?.active == true {
                processSnapshot = nil
                processLogTail = nil
            }
        } catch {
            serverReachable = false
            socketLive = false
            activeSessionIDs = []
            syncSelectedRunningState()
            status = "Server offline"
            let message = serverErrorMessage(error) ?? "\(error)"
            connectionProblemText = message
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
        serverReachable = false
        socketLive = false
        activeSessionIDs = []
        syncSelectedRunningState()
        status = "Server upgrade required"
        connectionProblemText = "Server upgrade required: app build needs agent API v\(minimumAgentAPIContractVersion), but this server reports v\(version ?? 0). Redeploy/restart the ZenithDock server."
        AppLogger.warning("server upgrade required contract=\(version ?? 0) required=\(minimumAgentAPIContractVersion)")
    }

    func refreshSessions(showErrors: Bool = true) async {
        do {
            struct Response: Codable { let sessions: [ZSession] }
            let res: Response = try await api.get("/api/sessions")
            serverReachable = true
            if !socketLive {
                status = "Server connected"
            }
            if sessions != res.sessions {
                sessions = res.sessions
                AppLogger.info("loaded sessions count=\(sessions.count)")
            }
            reconcileUnreadFromSessions()
            lastLoadedAt = Date()
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
            serverReachable = true
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

    func select(sessionID: String) async {
        timelineBatchRevealTask?.cancel()
        timelineBatchRevealTask = nil
        isApplyingLargeTimelineBatch = false
        if loadingSessionID == sessionID {
            if loadedSessionID != sessionID, let cached = memoryCachedChat(sessionID) {
                applyCachedChat(cached)
                status = "Loaded memory chat"
            }
            selectedSessionID = sessionID
            requestScrollToBottom(immediate: true)
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
            applyCachedChat(warmCachedChat)
            loadedFromCache = true
            status = "Loaded memory chat"
            AppLogger.info("loaded memory cache before selection session=\(sessionID) events=\(warmCachedChat.events.count) omitted_before=\(warmCachedChat.omittedHistoryEventCount)")
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
        socketLive = false
        status = loadedFromCache ? "Refreshing latest chat" : (serverReachable ? "Loading chat" : "Server offline")
        processSnapshot = nil
        processLogTail = nil
        tmuxSnapshot = nil
        tmuxCapture = nil
        markSessionRead(sessionID)
        AppLogger.info("select session=\(sessionID)")
        if loadedFromCache {
            requestScrollToBottom(immediate: true)
        } else {
            events = []
            rebuildDisplayEvents()
            uploads = []
            sessionFiles = []
            sessionVideoFiles = []
            sessionFilesTotal = nil
            sessionFilesHasMore = false
            sessionFilesNextOffset = 0
            omittedHistoryEventCount = 0
            loadedSessionID = nil
            latestSeenSeq = 0
            let cacheURL = chatCacheURL(sessionID)
            if let cached = await Self.loadCachedChat(from: cacheURL) {
                guard selectedSessionID == sessionID, selectionGeneration == generation else {
                    AppLogger.info("drop stale cache response session=\(sessionID)")
                    return
                }
                rememberChatCache(cached)
                applyCachedChat(cached)
                loadedFromCache = true
                status = "Loaded cached chat"
                AppLogger.info("loaded disk cache session=\(sessionID) events=\(cached.events.count) omitted_before=\(cached.omittedHistoryEventCount)")
                requestScrollToBottom(immediate: true)
            }
        }
        if loadedFromCache {
            let cachedLastSeq = lastSeq
            syncSelectedRunningState()
            Task {
                await refreshCachedSessionLatestTail(
                    sessionID: sessionID,
                    generation: generation,
                    cachedLastSeq: cachedLastSeq
                )
            }
            return
        }
        await refreshLatestSessionSnapshot(
            sessionID: sessionID,
            generation: generation,
            reportErrors: true,
            refreshFiles: true,
            connectStream: true
        )
    }

    private func refreshCachedSessionLatestTail(sessionID: String, generation: Int, cachedLastSeq: Int) async {
        guard selectedSessionID == sessionID,
              selectionGeneration == generation else {
            return
        }
        isRefreshingCachedDelta = true
        status = "Opening latest messages"
        defer {
            if selectedSessionID == sessionID, selectionGeneration == generation {
                isRefreshingCachedDelta = false
                status = socketLive ? "Live" : "Server connected"
            }
        }
        do {
            let res: SessionEventsResponse = try await api.get(
                "/api/sessions/\(sessionID)",
                queryItems: [
                    URLQueryItem(name: "limit", value: "\(initialSessionEventLimit)"),
                    URLQueryItem(name: "tail", value: "true")
                ]
            )
            guard selectedSessionID == sessionID, selectionGeneration == generation else {
                AppLogger.info("drop stale cached tail session=\(sessionID)")
                return
            }
            let previousSeq = lastSeq
            applySessionEventSnapshot(res, sessionID: sessionID, preserveExisting: false)
            markSessionRead(sessionID)
            loadedSessionID = sessionID
            saveSelectedChatCache()
            if selectedTimelineAtBottom || lastSeq > cachedLastSeq {
                requestScrollToBottom(immediate: true)
            }
            connectEvents(sessionID: sessionID, after: lastSeq)
            syncSelectedRunningState()
            AppLogger.info("loaded cached latest tail session=\(sessionID) previous=\(previousSeq) cached=\(cachedLastSeq) latest=\(lastSeq) events=\(events.count) omitted_before=\(omittedHistoryEventCount)")
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
            let res: SessionEventsResponse = try await api.get(
                "/api/sessions/\(sessionID)",
                queryItems: [
                    URLQueryItem(name: "limit", value: "\(initialSessionEventLimit)"),
                    URLQueryItem(name: "tail", value: "true")
                ]
            )
            if let idx = sessions.firstIndex(where: { $0.id == sessionID }) {
                sessions[idx] = res.session
            }
            guard selectedSessionID == sessionID, selectionGeneration == generation else {
                AppLogger.info("drop stale selection response session=\(sessionID)")
                return
            }
            applySessionEventSnapshot(res, sessionID: sessionID)
            markSessionRead(sessionID)
            status = "Loaded latest chat"
            refreshSessionFilesFromLoadedEvents()
            loadedSessionID = sessionID
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
            requestScrollToBottom(immediate: true)
        } catch {
            AppLogger.error("select failed session=\(sessionID) \(serverErrorMessage(error) ?? "\(error)")")
            if reportErrors {
                reportServerError(error)
            }
        }
    }

    @discardableResult
    func loadOlderHistory() async -> Int {
        guard let sid = selectedSessionID,
              omittedHistoryEventCount > 0,
              !isLoadingOlderHistory,
              let before = events.map(\.seq).min() else {
            return 0
        }

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
            var knownIDs = Set(events.map(\.id))
            var older: [ZEvent] = []

            for _ in 0..<8 {
                let res: Response = try await api.get(
                    "/api/sessions/\(sid)",
                    queryItems: [
                        URLQueryItem(name: "before", value: "\(cursorBefore)"),
                        URLQueryItem(name: "limit", value: "\(olderHistoryPageLimit)"),
                        URLQueryItem(name: "tail", value: "true")
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
                if !visibleOlder.isEmpty || res.events.isEmpty || remainingOmitted <= 0 {
                    break
                }

                guard let nextBefore = res.events.map(\.seq).min(),
                      nextBefore < cursorBefore else {
                    break
                }
                skippedInvisiblePages += 1
                cursorBefore = nextBefore
            }

            if let latestSession, let idx = sessions.firstIndex(where: { $0.id == sid }) {
                sessions[idx] = latestSession
            }
            var mergedEvents = (older + events).sorted { $0.seq < $1.seq }
            if mergedEvents.count > maxLoadedTimelineEvents {
                let overflow = mergedEvents.count - maxLoadedTimelineEvents
                mergedEvents.removeLast(overflow)
            }
            events = mergedEvents
            omittedHistoryEventCount = remainingOmitted
            refreshSessionFilesFromLoadedEvents()
            latestSeenSeq = max(latestSeenSeq, events.map(\.seq).max() ?? 0)
            rebuildDisplayEvents()
            saveSelectedChatCache()
            AppLogger.info("loaded older session=\(sid) before=\(before) received=\(receivedCount) added=\(older.count) skipped_invisible_pages=\(skippedInvisiblePages) loaded=\(events.count) omitted_before=\(omittedHistoryEventCount)")
            return older.count
        } catch {
            AppLogger.error("load older failed session=\(sid) \(serverErrorMessage(error) ?? "\(error)")")
            reportServerError(error)
            return 0
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
            status = "Found file in chat"
        } catch {
            AppLogger.warning("find file event failed file=\(file.id) \(serverErrorMessage(error) ?? "\(error)")")
            errorText = "I could not find that file in this chat history."
        }
    }

    @discardableResult
    func updateSelected(backend: String? = nil, model: String? = nil, effort: String? = nil, folder: String? = nil, title: String? = nil, cwd: String? = nil, pinned: Bool? = nil, archived: Bool? = nil) async -> Bool {
        guard let sid = selectedSessionID else { return false }
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
            if let idx = sessions.firstIndex(where: { $0.id == sid }) {
                sessions[idx] = res.session
            }
            return true
        } catch {
            reportServerError(error)
            return false
        }
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
            sessions = res.sessions
            reconcileUnreadFromSessions()
        } catch {
            reportServerError(error)
        }
    }

    @discardableResult
    func updateSession(_ sessionID: String, folder: String? = nil, title: String? = nil, cwd: String? = nil, backend: String? = nil, model: String? = nil, effort: String? = nil, pinned: Bool? = nil, archived: Bool? = nil) async -> Bool {
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
            if let idx = sessions.firstIndex(where: { $0.id == sessionID }) {
                sessions[idx] = res.session
            }
            return true
        } catch {
            reportServerError(error)
            return false
        }
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
        guard let sid = selectedSessionID else { return }
        struct Body: Codable { var title: String? }
        do {
            struct Response: Codable { let session: ZSession }
            let title = "Fork of \(selectedSession?.title ?? "Chat")"
            let res: Response = try await api.post("/api/sessions/\(sid)/fork", body: Body(title: title))
            sessions.insert(res.session, at: 0)
            AppLogger.info("forked parent=\(sid) child=\(res.session.id) backend=\(res.session.backend)")
            await select(sessionID: res.session.id)
        } catch {
            AppLogger.error("fork failed session=\(sid) \(serverErrorMessage(error) ?? "\(error)")")
            reportServerError(error)
        }
    }

    func createHandoffDigest(sourceSessionID: String, detail: String, userPrompt: String) async -> String? {
        struct Body: Codable {
            let detail: String
            let user_prompt: String?
        }
        struct Response: Codable {
            let digest: String
            let source_session: ZSession?
            let event_count: Int?
            let file_count: Int?
            let detail: String?
        }
        let cleanPrompt = userPrompt.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            let res: Response = try await api.post(
                "/api/sessions/\(sourceSessionID)/digest",
                body: Body(
                    detail: detail,
                    user_prompt: cleanPrompt.isEmpty ? nil : cleanPrompt
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
        struct Body: Codable {
            let prompt: String
            let file_ids: [String]
        }
        struct Response: Codable {
            let run_id: String?
            let queued: Bool?
            let queued_id: String?
            let position: Int?
            let session: ZSession
        }
        do {
            activeSessionIDs.insert(sessionID)
            if sessionID == selectedSessionID {
                isRunning = true
            }
            let res: Response = try await api.post(
                "/api/sessions/\(sessionID)/turns",
                body: Body(prompt: trimmed, file_ids: fileIDs)
            )
            if let idx = sessions.firstIndex(where: { $0.id == sessionID }) {
                sessions[idx] = res.session
            }
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
        guard let digest = await createHandoffDigest(
            sourceSessionID: sourceSessionID,
            detail: detail,
            userPrompt: userPrompt
        ) else {
            return false
        }
        return await sendPrompt(to: targetSessionID, prompt: digest)
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

    @discardableResult
    func sendPrompt(_ submittedPrompt: String? = nil) async -> Bool {
        guard let sid = selectedSessionID else { return false }
        let sourcePrompt = submittedPrompt ?? prompt
        let trimmed = sourcePrompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        let wasRunning = isRunning
        struct Body: Codable {
            let prompt: String
            let file_ids: [String]
        }
        do {
            isRunning = true
            activeSessionIDs.insert(sid)
            if submittedPrompt == nil {
                prompt = ""
            }
            AppLogger.info("send prompt session=\(sid) chars=\(trimmed.count) files=\(uploads.count)")
            if let session = selectedSession {
                let currentTitle = session.title.trimmingCharacters(in: .whitespacesAndNewlines)
                if currentTitle.isEmpty || currentTitle == "New chat" {
                    let firstLine = trimmed.split(whereSeparator: \.isNewline).first.map(String.init) ?? trimmed
                    await updateSelected(title: String(firstLine.prefix(72)))
                }
            }
            let body = Body(prompt: trimmed, file_ids: uploads.map(\.id))
            struct Response: Codable {
                let run_id: String?
                let queued: Bool?
                let queued_id: String?
                let position: Int?
                let session: ZSession
            }
            let res: Response = try await api.post("/api/sessions/\(sid)/turns", body: body)
            if let idx = sessions.firstIndex(where: { $0.id == sid }) {
                sessions[idx] = res.session
            }
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
        guard let queuedID = event.queued_id, isQueuedEventPending(event) else { return }
        struct Response: Codable {
            let ok: Bool
            let unqueued: Bool?
            let queued_id: String?
            let remaining: Int?
        }
        do {
            let _: Response = try await api.delete("/api/sessions/\(event.session_id)/queue/\(queuedID)")
            events.removeAll { $0.type == "turn_queued" && $0.queued_id == queuedID }
            rebuildDisplayEvents()
            saveSelectedChatCache()
            AppLogger.info("unqueued session=\(event.session_id) queued=\(queuedID)")
        } catch {
            AppLogger.error("unqueue failed session=\(event.session_id) queued=\(queuedID) \(serverErrorMessage(error) ?? "\(error)")")
            reportServerError(error)
        }
    }

    func updateQueued(_ event: ZEvent, prompt: String) async {
        guard let queuedID = event.queued_id, isQueuedEventPending(event) else { return }
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
            let _: Response = try await api.patch("/api/sessions/\(event.session_id)/queue/\(queuedID)", body: Body(prompt: cleanPrompt))
            if let idx = events.firstIndex(where: { $0.type == "turn_queued" && $0.queued_id == queuedID }) {
                events[idx].prompt = cleanPrompt
            }
            rebuildDisplayEvents()
            saveSelectedChatCache()
            AppLogger.info("queued prompt updated session=\(event.session_id) queued=\(queuedID)")
        } catch {
            AppLogger.error("queued update failed session=\(event.session_id) queued=\(queuedID) \(serverErrorMessage(error) ?? "\(error)")")
            reportServerError(error)
        }
    }

    func moveQueued(_ event: ZEvent, direction: String) async {
        guard let queuedID = event.queued_id, isQueuedEventPending(event) else { return }
        struct Body: Codable {
            let direction: String
        }
        struct Response: Codable {
            let ok: Bool
            let queued_id: String
            let positions: [ZQueuePosition]?
        }
        do {
            let res: Response = try await api.post("/api/sessions/\(event.session_id)/queue/\(queuedID)/move", body: Body(direction: direction))
            if let positions = res.positions {
                for position in positions {
                    if let idx = events.firstIndex(where: { $0.type == "turn_queued" && $0.queued_id == position.queued_id }) {
                        events[idx].position = position.position
                    }
                }
            }
            rebuildDisplayEvents()
            saveSelectedChatCache()
            AppLogger.info("queued moved session=\(event.session_id) queued=\(queuedID) direction=\(direction)")
        } catch {
            AppLogger.error("queued move failed session=\(event.session_id) queued=\(queuedID) \(serverErrorMessage(error) ?? "\(error)")")
            reportServerError(error)
        }
    }

    func runQueuedNow(_ event: ZEvent) async {
        guard let queuedID = event.queued_id, isQueuedEventPending(event) else { return }
        struct Empty: Codable {}
        struct Response: Codable {
            let ok: Bool
            let queued_id: String
            let interrupted: Bool?
        }
        do {
            let _: Response = try await api.post("/api/sessions/\(event.session_id)/queue/\(queuedID)/run-now", body: Empty())
            if let idx = events.firstIndex(where: { $0.type == "turn_queued" && $0.queued_id == queuedID }) {
                events[idx].position = 1
            }
            AppLogger.info("queued run-now session=\(event.session_id) queued=\(queuedID)")
        } catch {
            AppLogger.error("queued run-now failed session=\(event.session_id) queued=\(queuedID) \(serverErrorMessage(error) ?? "\(error)")")
            reportServerError(error)
        }
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
        socketLive = true
        status = "Live"
        lastSocketError = nil
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
                    self.socketLive = false
                    self.webSocket = nil
                    self.webSocketSessionID = nil
                    self.status = self.serverReachable ? "Stream reconnecting" : "Server offline"
                    self.lastSocketError = self.serverErrorMessage(error)
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
            status = "Opening latest messages"
        }
        guard pendingStreamFlushTask == nil else { return }
        pendingStreamFlushTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: 180_000_000)
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
                status = socketLive ? "Live" : "Server connected"
            }
            return
        }
        let buffered = pendingStreamEvents.sorted { $0.seq < $1.seq }
        pendingStreamEvents.removeAll()
        pendingStreamSessionID = nil
        if buffered.count >= streamBackfillMaskThreshold {
            beginLargeTimelineBatchMask()
        }
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
                self.status = self.socketLive ? "Live" : "Server connected"
            }
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
        events.sort { $0.seq < $1.seq }
        if events.count > maxLoadedTimelineEvents {
            let overflow = events.count - maxLoadedTimelineEvents
            events.removeFirst(overflow)
            omittedHistoryEventCount += overflow
        }
        latestSeenSeq = max(latestSeenSeq, incoming.map(\.seq).max() ?? 0)
        var shouldSaveCache = false
        var shouldScrollToBottom = false
        for event in newEvents {
            if isAgentVisibleMessage(event) {
                if event.session_id != selectedSessionID {
                    markAgentUnread(sessionID: event.session_id, firstSeq: event.seq)
                } else if !selectedTimelineAtBottom {
                    markAgentUnread(sessionID: event.session_id, firstSeq: event.seq)
                } else {
                    setLastReadAgentSeq(event.seq, for: event.session_id)
                    syncServerReadState(sessionID: event.session_id, seq: event.seq)
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
            shouldScrollToBottom = true
        }
        rebuildDisplayEvents()
        if shouldSaveCache {
            saveSelectedChatCache()
        }
        if shouldScrollToBottom {
            requestScrollToBottom()
        }
    }

    private func syncSelectedRunningState() {
        guard let selectedSessionID else {
            isRunning = false
            return
        }
        isRunning = activeSessionIDs.contains(selectedSessionID)
    }

    private func ingest(_ event: ZEvent) {
        latestSeenSeq = max(latestSeenSeq, event.seq)
        if event.type == "raw_event", !showDebugEvents {
            return
        }
        guard !events.contains(where: { $0.id == event.id }) else { return }
        events.append(event)
        if events.count > maxLoadedTimelineEvents {
            let overflow = events.count - maxLoadedTimelineEvents
            events.removeFirst(overflow)
            omittedHistoryEventCount += overflow
        }
        rebuildDisplayEvents()
        if isAgentVisibleMessage(event) {
            if event.session_id != selectedSessionID {
                markAgentUnread(sessionID: event.session_id, firstSeq: event.seq)
            } else if !selectedTimelineAtBottom {
                markAgentUnread(sessionID: event.session_id, firstSeq: event.seq)
            } else {
                setLastReadAgentSeq(event.seq, for: event.session_id)
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
        requestScrollToBottom()
    }

    private func requestScrollToBottom(immediate: Bool = false) {
        let now = Date()
        if immediate || now.timeIntervalSince(lastScrollRequestAt) >= 0.22 {
            pendingScrollRequest?.cancel()
            pendingScrollRequest = nil
            lastScrollRequestAt = now
            scrollToBottomRevision += 1
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

    private func mergeEvents(_ incoming: [ZEvent]) {
        guard !incoming.isEmpty else { return }
        let existingIDs = Set(events.map(\.id))
        let incomingEvents = timelineEvents(from: incoming)
        let newEvents = incomingEvents.filter { !existingIDs.contains($0.id) }
        guard !newEvents.isEmpty else {
            latestSeenSeq = max(latestSeenSeq, incoming.map(\.seq).max() ?? 0)
            return
        }
        events.append(contentsOf: newEvents)
        events.sort { $0.seq < $1.seq }
        if events.count > maxLoadedTimelineEvents {
            let overflow = events.count - maxLoadedTimelineEvents
            events.removeFirst(overflow)
            omittedHistoryEventCount += overflow
        }
        latestSeenSeq = max(latestSeenSeq, incoming.map(\.seq).max() ?? 0)
        refreshSessionFilesFromLoadedEvents()
        rebuildDisplayEvents()
    }

    private func mergeEventsKeeping(_ incoming: ZEvent) {
        let incomingEvents = timelineEvents(from: [incoming])
        guard !incomingEvents.isEmpty else { return }
        let existingIDs = Set(events.map(\.id))
        let newEvents = incomingEvents.filter { !existingIDs.contains($0.id) }
        if !newEvents.isEmpty {
            events.append(contentsOf: newEvents)
            events.sort { $0.seq < $1.seq }
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
        rebuildDisplayEvents()
        saveSelectedChatCache()
    }

    private func eventContaining(fileID: String, in source: [ZEvent]) -> ZEvent? {
        source.first { event in
            event.file?.id == fileID || event.artifact?.id == fileID
        }
    }

    private func applySessionEventSnapshot(
        _ response: SessionEventsResponse,
        sessionID: String,
        preserveExisting: Bool = true
    ) {
        if let idx = sessions.firstIndex(where: { $0.id == sessionID }) {
            sessions[idx] = response.session
        }
        let snapshotEvents = timelineEvents(from: response.events)
        let oldCount = events.count
        let preservedEvents = preserveExisting ? events.filter { $0.session_id == sessionID } : []
        let projectedCount = preservedEvents.isEmpty
            ? snapshotEvents.count
            : Set((preservedEvents + snapshotEvents).map(\.id)).count
        let shouldMaskLargeBatch = shouldMaskTimelineBatch(
            oldCount: oldCount,
            newCount: projectedCount,
            incomingCount: snapshotEvents.count
        )
        if shouldMaskLargeBatch {
            beginLargeTimelineBatchMask()
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
        if !sessions.contains(where: { $0.id == cached.session.id }) {
            sessions.append(cached.session)
        }
        let cachedEvents = timelineEvents(from: cached.events)
        events = Array(cachedEvents.suffix(maxWarmCachedTimelineEvents))
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

    private func refreshSessionFilesFromLoadedEvents() {
        let known = files(from: events)
        guard !known.isEmpty || sessionFiles.isEmpty else { return }
        sessionFiles = mergedFiles(sessionFiles + known)
        let videos = known.filter { ($0.content_type ?? "").hasPrefix("video/") }
        if !videos.isEmpty {
            sessionVideoFiles = mergedFiles(sessionVideoFiles + videos)
        }
    }

    private func files(from source: [ZEvent]) -> [ZFile] {
        source.flatMap { event -> [ZFile] in
            [event.file, event.artifact].compactMap { $0 }
        }
    }

    private func upsertSessionFile(_ file: ZFile) {
        sessionFiles = mergedFiles(sessionFiles + [file])
        if (file.content_type ?? "").hasPrefix("video/") {
            sessionVideoFiles = mergedFiles(sessionVideoFiles + [file])
        }
        if let total = sessionFilesTotal {
            sessionFilesTotal = max(total, sessionFiles.count)
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
            if reset {
                sessionFiles = mergedFiles(res.files + timelineFiles + sessionVideoFiles)
            } else {
                sessionFiles = mergedFiles(sessionFiles + res.files + timelineFiles)
            }
            sessionFilesTotal = res.total ?? max(sessionFilesTotal ?? 0, sessionFiles.count)
            sessionFilesNextOffset = (res.offset ?? offset) + res.files.count
            sessionFilesHasMore = res.has_more ?? false
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
                    URLQueryItem(name: "content_prefix", value: "video/")
                ]
            )
            guard selectedSessionID == sessionID, selectionGeneration == generation else { return }
            let videos = mergedFiles(res.files + files(from: events).filter { ($0.content_type ?? "").hasPrefix("video/") })
            sessionVideoFiles = videos
            sessionFiles = mergedFiles(sessionFiles + videos)
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
        let eventsToCache = Array(events
            .filter { $0.type != "raw_event" }
            .suffix(maxWarmCachedTimelineEvents))
        guard !eventsToCache.isEmpty else { return }
        let cached = CachedChat(
            session: session,
            events: eventsToCache,
            sessionFiles: sessionFiles.isEmpty ? files(from: events) : sessionFiles,
            omittedHistoryEventCount: omittedHistoryEventCount,
            cachedAt: ISO8601DateFormatter().string(from: Date())
        )
        rememberChatCache(cached)
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
        let eventsToCache = Array(events
            .filter { $0.type != "raw_event" }
            .suffix(maxCachedTimelineEvents))
        let warmEvents = Array(eventsToCache.suffix(maxWarmCachedTimelineEvents))
        let cachedAt = ISO8601DateFormatter().string(from: Date())
        let cachedFiles = sessionFiles.isEmpty ? files(from: events) : sessionFiles
        let warmCached = CachedChat(
            session: session,
            events: warmEvents,
            sessionFiles: cachedFiles,
            omittedHistoryEventCount: omittedHistoryEventCount,
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
            launchDeferredText = message
            status = "Launch deferred"
            return
        }
        if isConnectionError(error) {
            connectionProblemText = message
            status = "Server offline"
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
