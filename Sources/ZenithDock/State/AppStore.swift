import Combine
import Foundation
import ZenithCore

private let defaultAgentServerURLString = "http://127.0.0.1:7850"
private let fallbackServerCwd = "~"

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
    @Published var jobs: [ZJob] = []
    @Published var runtimeCatalog = ZRuntimeCatalogSnapshot.fallback
    @Published var showDebugEvents = false {
        didSet { rebuildDisplayEvents() }
    }
    @Published private(set) var displayEvents: [ZEvent] = []
    @Published var loadedSessionID: String?
    @Published var isSelectingSession = false
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
    @Published private(set) var unreadAgentSessionIDs: Set<String> = []
    @Published private(set) var firstUnreadAgentSeqBySessionID: [String: Int] = [:]
    @Published private(set) var selectedTimelineAtBottom = true

    private let initialSessionEventLimit = 480
    private let olderHistoryPageLimit = 160
    private let maxLoadedTimelineEvents = 2_000
    private let maxCachedTimelineEvents = 1_440
    private let maxCachedStringCharacters = 12_000
    private let sessionFilesPageLimit = 48
    private var webSocket: URLSessionWebSocketTask?
    private var webSocketSessionID: String?
    private var loadingSessionID: String?
    private var liveTrackingStarted = false
    private var latestSeenSeq = 0
    private var pendingCacheWrite: Task<Void, Never>?
    private var pendingScrollRequest: Task<Void, Never>?
    private var selectionGeneration = 0
    private var memoryChatCache: [String: CachedChat] = [:]
    private var memoryChatCacheOrder: [String] = []
    private var lastReadAgentSeqBySessionID: [String: Int] = [:]
    private var lastScrollRequestAt = Date.distantPast
    private var sessionFilesNextOffset = 0
    private var lastSeq: Int { max(latestSeenSeq, events.map(\.seq).max() ?? 0) }
    private let maxMemoryCachedChats = 8

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
        Array(Set(activeSessions.map { $0.folder ?? "General" })).sorted()
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
        omittedHistoryEventCount > 0 && !isLoadingOlderHistory && events.count < maxLoadedTimelineEvents
    }

    var sessionVideos: [ZFile] {
        mergedFiles(sessionFiles + sessionVideoFiles)
            .filter { ($0.content_type ?? "").hasPrefix("video/") }
    }

    var loadedHistoryLimitReached: Bool {
        omittedHistoryEventCount > 0 && events.count >= maxLoadedTimelineEvents
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
                  event.text?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false else {
                return nil
            }
            return event.run_id
        })
        let queuedTurnIDs = Set(source.compactMap { event -> String? in
            event.type == "turn_queued" ? event.queued_id : nil
        })
        return source.filter { event in
            switch event.type {
            case "session_created", "process_started", "provider_session", "raw_event", "cwd_fallback", "turn_unqueued":
                return false
            case "turn_started":
                if let queuedID = event.queued_id, queuedTurnIDs.contains(queuedID) {
                    return false
                }
                return true
            case "turn_finished":
                guard event.result_text?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false else {
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

    func rememberServerURL() {
        UserDefaults.standard.set(serverURLString, forKey: "serverURL")
    }

    func rememberAccessToken() {
        ZenithTokenStore.save(accessToken)
    }

    func markSelectedSessionRead() {
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
        }
        unreadAgentSessionIDs.remove(sessionID)
        firstUnreadAgentSeqBySessionID.removeValue(forKey: sessionID)
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
        "ZenithDock.lastReadAgentSeq.\(serverCacheNamespace)"
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

    private func setLastReadAgentSeq(_ seq: Int, for sessionID: String) {
        guard seq > (lastReadAgentSeqBySessionID[sessionID] ?? 0) else { return }
        lastReadAgentSeqBySessionID[sessionID] = seq
        saveReadState()
    }

    private func latestAgentEventSeq(for sessionID: String) -> Int? {
        if let sessionSeq = sessions.first(where: { $0.id == sessionID })?.latest_agent_event_seq {
            return sessionSeq
        }
        let eventSeq = events
            .filter { $0.session_id == sessionID && isAgentVisibleMessage($0) }
            .map(\.seq)
            .max()
        return eventSeq
    }

    private func reconcileUnreadFromSessions() {
        let knownSessionIDs = Set(sessions.map(\.id))
        unreadAgentSessionIDs = unreadAgentSessionIDs.intersection(knownSessionIDs)
        firstUnreadAgentSeqBySessionID = firstUnreadAgentSeqBySessionID.filter { knownSessionIDs.contains($0.key) }

        for session in sessions {
            guard let latestSeq = session.latest_agent_event_seq else { continue }
            if session.id == selectedSessionID, selectedTimelineAtBottom {
                markSessionRead(session.id)
                continue
            }
            let lastReadSeq = lastReadAgentSeqBySessionID[session.id] ?? 0
            if latestSeq > lastReadSeq {
                markAgentUnread(sessionID: session.id, firstSeq: lastReadSeq + 1)
            } else {
                unreadAgentSessionIDs.remove(session.id)
                firstUnreadAgentSeqBySessionID.removeValue(forKey: session.id)
            }
        }
    }

    func isAgentVisibleMessage(_ event: ZEvent) -> Bool {
        switch event.type {
        case "assistant_text":
            return event.text?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
        case "turn_finished":
            return event.result_text?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
        case "error", "artifact_created":
            return true
        case "job_ran", "job_error":
            return event.job != nil
        default:
            return false
        }
    }

    func applyServerSettings(serverURL: String, accessToken: String) async {
        let cleanURL = serverURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanURL.isEmpty else { return }
        let oldEndpoint = ZenithServerURL.normalized(serverURLString, default: defaultAgentServerURLString)
        let newEndpoint = ZenithServerURL.normalized(cleanURL, default: defaultAgentServerURLString)
        serverURLString = cleanURL
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
        selectedTimelineAtBottom = true
        connectionProblemText = nil
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
                let default_cwd: String?
                let active: [String]
                let jobs: Int?
            }
            let res: Response = try await api.get("/api/health")
            serverReachable = res.ok
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
        if loadingSessionID == sessionID {
            selectedSessionID = sessionID
            markSessionRead(sessionID)
            syncSelectedRunningState()
            return
        }
        selectionGeneration += 1
        let generation = selectionGeneration
        loadingSessionID = sessionID
        isSelectingSession = true
        defer {
            if loadingSessionID == sessionID {
                loadingSessionID = nil
            }
            if selectedSessionID == sessionID, selectionGeneration == generation {
                isSelectingSession = false
            }
        }
        selectedSessionID = sessionID
        syncSelectedRunningState()
        webSocket?.cancel(with: .goingAway, reason: nil)
        webSocket = nil
        webSocketSessionID = nil
        socketLive = false
        status = serverReachable ? "Loading chat" : "Server offline"
        processSnapshot = nil
        processLogTail = nil
        markSessionRead(sessionID)
        AppLogger.info("select session=\(sessionID)")
        var loadedFromCache = false
        if let cached = memoryCachedChat(sessionID) {
            applyCachedChat(cached)
            loadedFromCache = true
            status = "Loaded memory chat"
            AppLogger.info("loaded memory cache session=\(sessionID) events=\(cached.events.count) omitted_before=\(cached.omittedHistoryEventCount)")
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
            Task { await loadSessionFiles(sessionID: sessionID, generation: generation) }
            Task { await loadSessionVideoFiles(sessionID: sessionID, generation: generation) }
            connectEvents(sessionID: sessionID, after: lastSeq)
            syncSelectedRunningState()
            requestScrollToBottom(immediate: true)
        } catch {
            AppLogger.error("select failed session=\(sessionID) \(serverErrorMessage(error) ?? "\(error)")")
            if !loadedFromCache {
                reportServerError(error)
            }
        }
    }

    @discardableResult
    func loadOlderHistory() async -> Int {
        guard let sid = selectedSessionID,
              omittedHistoryEventCount > 0,
              !isLoadingOlderHistory,
              let before = events.map(\.seq).min(),
              events.count < maxLoadedTimelineEvents else {
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
            let capacity = max(1, min(olderHistoryPageLimit, maxLoadedTimelineEvents - events.count))
            let res: Response = try await api.get(
                "/api/sessions/\(sid)",
                queryItems: [
                    URLQueryItem(name: "before", value: "\(before)"),
                    URLQueryItem(name: "limit", value: "\(capacity)"),
                    URLQueryItem(name: "tail", value: "true")
                ]
            )
            if let idx = sessions.firstIndex(where: { $0.id == sid }) {
                sessions[idx] = res.session
            }
            let existingIDs = Set(events.map(\.id))
            let older = timelineEvents(from: res.events).filter { !existingIDs.contains($0.id) }
            events = (older + events).sorted { $0.seq < $1.seq }
            omittedHistoryEventCount = res.events_omitted_before ?? 0
            refreshSessionFilesFromLoadedEvents()
            latestSeenSeq = max(latestSeenSeq, events.map(\.seq).max() ?? 0)
            rebuildDisplayEvents()
            saveSelectedChatCache()
            AppLogger.info("loaded older session=\(sid) added=\(older.count) loaded=\(events.count) omitted_before=\(omittedHistoryEventCount)")
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
            uploads = []
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
            AppLogger.info("unqueued session=\(event.session_id) queued=\(queuedID)")
        } catch {
            AppLogger.error("unqueue failed session=\(event.session_id) queued=\(queuedID) \(serverErrorMessage(error) ?? "\(error)")")
            reportServerError(error)
        }
    }

    func createJob(title: String, prompt: String, intervalSeconds: Int, loop: Bool) async {
        guard let sid = selectedSessionID else { return }
        let cleanPrompt = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanPrompt.isEmpty else { return }
        struct Body: Codable {
            let session_id: String
            let title: String
            let prompt: String
            let interval_seconds: Int
            let loop: Bool
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
                loop: loop,
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
        enabled: Bool? = nil,
        backend: String? = nil
    ) async {
        struct Body: Codable {
            var title: String?
            var prompt: String?
            var enabled: Bool?
            var interval_seconds: Int?
            var loop: Bool?
            var backend: String?
        }
        do {
            struct Response: Codable { let job: ZJob }
            let res: Response = try await api.patch("/api/jobs/\(job.id)", body: Body(
                title: title,
                prompt: prompt,
                enabled: enabled,
                interval_seconds: intervalSeconds.map { max(10, $0) },
                loop: loop,
                backend: backend
            ))
            if let idx = jobs.firstIndex(where: { $0.id == job.id }) {
                jobs[idx] = res.job
            }
        } catch {
            reportServerError(error)
        }
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
                            self.ingest(event)
                        }
                    } else if case .data(let data) = message {
                        if let event = try? JSONDecoder().decode(ZEvent.self, from: data) {
                            self.ingest(event)
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
        events.append(contentsOf: incomingEvents.filter { !existingIDs.contains($0.id) })
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

    private func applySessionEventSnapshot(_ response: SessionEventsResponse, sessionID: String) {
        if let idx = sessions.firstIndex(where: { $0.id == sessionID }) {
            sessions[idx] = response.session
        }
        let snapshotEvents = timelineEvents(from: response.events)
        let preservedEvents = events.filter { $0.session_id == sessionID }
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
        if let idx = sessions.firstIndex(where: { $0.id == cached.session.id }) {
            sessions[idx] = cached.session
        }
        events = timelineEvents(from: cached.events)
        omittedHistoryEventCount = cached.omittedHistoryEventCount
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
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support", isDirectory: true)
        return base
            .appendingPathComponent("ZenithDock", isDirectory: true)
            .appendingPathComponent("ChatCache", isDirectory: true)
            .appendingPathComponent(serverCacheNamespace, isDirectory: true)
    }

    private var serverCacheNamespace: String {
        ZEndpointCache.namespace(serverURL: serverURLString, default: defaultAgentServerURLString)
    }

    private func chatCacheKey(_ sessionID: String) -> String {
        ZEndpointCache.key(serverURL: serverURLString, sessionID: sessionID, default: defaultAgentServerURLString)
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
        let eventsToCache = events
            .filter { $0.type != "raw_event" }
            .suffix(maxCachedTimelineEvents)
            .map(sanitizedForCache)
        let cached = CachedChat(
            session: session,
            events: Array(eventsToCache),
            sessionFiles: sessionFiles.isEmpty ? files(from: events) : sessionFiles,
            omittedHistoryEventCount: omittedHistoryEventCount,
            cachedAt: ISO8601DateFormatter().string(from: Date())
        )
        rememberChatCache(cached)
        Task.detached(priority: .utility) {
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

    private func timelineEvents(from source: [ZEvent]) -> [ZEvent] {
        showDebugEvents ? source : source.filter { $0.type != "raw_event" }
    }

    private func sanitizedForCache(_ event: ZEvent) -> ZEvent {
        var copy = event
        copy.raw = nil
        copy.output = trimmedForCache(copy.output)
        copy.text = trimmedForCache(copy.text)
        copy.result_text = trimmedForCache(copy.result_text)
        copy.message = trimmedForCache(copy.message)
        copy.prompt = trimmedForCache(copy.prompt)
        if var tool = copy.tool {
            tool.input = trimmedJSONForCache(tool.input)
            copy.tool = tool
        }
        return copy
    }

    private func trimmedForCache(_ value: String?) -> String? {
        guard let value, value.count > maxCachedStringCharacters else { return value }
        return String(value.prefix(maxCachedStringCharacters)).trimmingCharacters(in: .whitespacesAndNewlines) + "\n\n[trimmed in local cache]"
    }

    private func trimmedJSONForCache(_ value: JSONValue?) -> JSONValue? {
        guard let value else { return nil }
        switch value {
        case .string(let string):
            return .string(trimmedForCache(string) ?? string)
        case .array(let array):
            return .array(array.prefix(40).map { trimmedJSONForCache($0) ?? .null })
        case .object(let object):
            return .object(object.mapValues { trimmedJSONForCache($0) ?? .null })
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
            return "Cannot reach the ZenithDock agent server at \(serverURLString). The Mac internet may be fine; this means the app cannot reach the configured host or port 7850 right now."
        }
        if ns.domain == "ZenithDock.API", ns.code == 401 || ns.code == 403 {
            return "Agent server rejected the access token. Check ZENITHDOCK_AGENT_TOKEN on the server and the token field in the app."
        }
        return error.localizedDescription
    }

    private func isConnectionError(_ error: Error) -> Bool {
        let ns = error as NSError
        return ns.domain == NSURLErrorDomain && ns.code != NSURLErrorCancelled
    }

    private func cleanServerURL() {
        UserDefaults.standard.set(serverURLString, forKey: "serverURL")
    }
}
