import Foundation
import ZenithCore

private let defaultAgentServerURLString = "http://127.0.0.1:7850"
private let defaultAgentServerHost = "127.0.0.1"
private let defaultAgentServerPort = "7850"
private let fallbackServerCwd = "~"

@MainActor
final class MobileAppStore: ObservableObject {
    @Published var serverURLString = UserDefaults.standard.string(forKey: "serverURL") ?? defaultAgentServerURLString
    @Published var serverHost = UserDefaults.standard.string(forKey: "serverHost") ?? defaultAgentServerHost
    @Published var serverPort = UserDefaults.standard.string(forKey: "serverPort") ?? defaultAgentServerPort
    @Published var accessToken = ZenithTokenStore.load()
    @Published var sessions: [ZSession] = []
    @Published var selectedSessionID: String?
    @Published var events: [ZEvent] = []
    @Published var uploads: [ZFile] = []
    @Published var sessionFiles: [ZFile] = []
    @Published var jobs: [ZJob] = []
    @Published var runtimeCatalog = ZRuntimeCatalogSnapshot.fallback
    @Published var prompt = ""
    @Published var isRunning = false
    @Published var isLoading = false
    @Published var isLoadingOlderHistory = false
    @Published var serverReachable = false
    @Published var socketLive = false
    @Published var status = "Disconnected"
    @Published var connectionDetail = "No connection test yet"
    @Published var activeSessionIDs: Set<String> = []
    @Published var defaultCwd = fallbackServerCwd
    @Published var errorText: String?
    @Published var omittedHistoryEventCount = 0
    @Published var scrollRevision = 0
    @Published var processSnapshot: ZProcessSnapshot?
    @Published var processLogTail: ZProcessLogTail?
    @Published var isLoadingProcesses = false
    @Published private(set) var unreadAgentSessionIDs: Set<String> = []

    private let initialEventLimit = 160
    private let olderHistoryPageLimit = 160
    private let maxMemoryCachedChats = 8
    private let maxMemoryCachedEvents = 360
    private var webSocket: URLSessionWebSocketTask?
    private var loadingSessionID: String?
    private var liveTrackingStarted = false
    private var latestSeenSeq = 0
    private var selectionGeneration = 0
    private var memoryChatCache: [String: CachedChat] = [:]
    private var memoryChatCacheOrder: [String] = []
    private var lastReadAgentSeqBySessionID: [String: Int] = [:]
    private var lastSeq: Int { max(latestSeenSeq, events.map(\.seq).max() ?? 0) }

    private struct CachedChat {
        var session: ZSession
        var events: [ZEvent]
        var sessionFiles: [ZFile]
        var omittedHistoryEventCount: Int
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
        let savedURL = UserDefaults.standard.string(forKey: "serverURL") ?? defaultAgentServerURLString
        let parts = Self.serverParts(from: savedURL)
        serverURLString = savedURL
        if UserDefaults.standard.string(forKey: "serverHost") == nil {
            serverHost = parts.host
        }
        if UserDefaults.standard.string(forKey: "serverPort") == nil {
            serverPort = parts.port
        }
        serverURLString = effectiveServerAddress
        lastReadAgentSeqBySessionID = loadReadState()
    }

    var api: APIClient {
        APIClient(
            baseURL: ZenithServerURL.url(effectiveServerAddress, default: defaultAgentServerURLString),
            accessToken: accessToken
        )
    }

    var resolvedServerURLString: String {
        ZenithServerURL.normalized(effectiveServerAddress, default: defaultAgentServerURLString)
    }

    var effectiveServerAddress: String {
        let parts = Self.serverParts(host: serverHost, port: serverPort)
        if parts.port.isEmpty {
            return "http://\(parts.host)"
        }
        return "http://\(parts.host):\(parts.port)"
    }

    var selectedSession: ZSession? {
        sessions.first { $0.id == selectedSessionID }
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

    var hiddenDisplayEventCount: Int {
        omittedHistoryEventCount
    }

    var canLoadOlderHistory: Bool {
        omittedHistoryEventCount > 0 && !isLoadingOlderHistory
    }

    var sessionVideos: [ZFile] {
        sessionFiles.filter { ($0.content_type ?? "").hasPrefix("video/") }
    }

    var pendingQueuedEvents: [ZEvent] {
        events
            .filter { isQueuedEventPending($0) }
            .sorted { $0.seq < $1.seq }
    }

    var displayEvents: [ZEvent] {
        let assistantRuns = Set(events.compactMap { event -> String? in
            guard event.type == "assistant_text",
                  event.text?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false else {
                return nil
            }
            return event.run_id
        })
        return events.filter { event in
            switch event.type {
            case "session_created", "process_started", "provider_session", "raw_event", "cwd_fallback", "turn_queued", "turn_unqueued":
                return false
            case "turn_started":
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

    func startLiveTracking() async {
        guard !liveTrackingStarted else { return }
        liveTrackingStarted = true
        defer { liveTrackingStarted = false }
        await refresh(showErrors: false)
        var tick = 0
        while !Task.isCancelled {
            try? await Task.sleep(for: .seconds(5))
            tick += 1
            await refreshHealth(showErrors: false)
            if serverReachable {
                await refreshSessions(showErrors: false)
            }
            if tick % 6 == 0 {
                await refreshJobs(showErrors: false)
            }
            if let sid = selectedSessionID, serverReachable, !socketLive {
                connectEvents(sessionID: sid, after: lastSeq)
            }
        }
    }

    func rememberServerURL() {
        let nextURL = effectiveServerAddress
        if serverURLString != nextURL {
            serverURLString = nextURL
        }
        if UserDefaults.standard.string(forKey: "serverHost") != serverHost {
            UserDefaults.standard.set(serverHost, forKey: "serverHost")
        }
        if UserDefaults.standard.string(forKey: "serverPort") != serverPort {
            UserDefaults.standard.set(serverPort, forKey: "serverPort")
        }
        if UserDefaults.standard.string(forKey: "serverURL") != serverURLString {
            UserDefaults.standard.set(serverURLString, forKey: "serverURL")
        }
    }

    func updateServerAddress(host rawHost: String, port rawPort: String) {
        let parts = Self.serverParts(host: rawHost, port: rawPort)
        if serverHost != parts.host {
            serverHost = parts.host
        }
        if serverPort != parts.port {
            serverPort = parts.port
        }
        rememberServerURL()
    }

    func rememberAccessToken() {
        ZenithTokenStore.save(accessToken)
    }

    func markSessionRead(_ sessionID: String?) {
        guard let sessionID else { return }
        if let latestSeq = latestAgentEventSeq(for: sessionID) {
            setLastReadAgentSeq(latestSeq, for: sessionID)
        }
        unreadAgentSessionIDs.remove(sessionID)
    }

    private var readStateDefaultsKey: String {
        "ZenithDock.lastReadAgentSeq.\(ZEndpointCache.namespace(serverURL: effectiveServerAddress, default: defaultAgentServerURLString))"
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
        return events
            .filter { $0.session_id == sessionID && isAgentVisibleMessage($0) }
            .map(\.seq)
            .max()
    }

    private func reconcileUnreadFromSessions() {
        let knownSessionIDs = Set(sessions.map(\.id))
        unreadAgentSessionIDs = unreadAgentSessionIDs.intersection(knownSessionIDs)

        for session in sessions {
            guard let latestSeq = session.latest_agent_event_seq else { continue }
            if session.id == selectedSessionID {
                markSessionRead(session.id)
                continue
            }
            let lastReadSeq = lastReadAgentSeqBySessionID[session.id] ?? 0
            if latestSeq > lastReadSeq {
                unreadAgentSessionIDs.insert(session.id)
            } else {
                unreadAgentSessionIDs.remove(session.id)
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

    func reconnect() async {
        cleanServerURL()
        webSocket?.cancel(with: .goingAway, reason: nil)
        webSocket = nil
        socketLive = false
        serverReachable = false
        status = "Connecting"
        selectedSessionID = nil
        events = []
        uploads = []
        sessions = []
        jobs = []
        omittedHistoryEventCount = 0
        latestSeenSeq = 0
        memoryChatCache = [:]
        memoryChatCacheOrder = []
        lastReadAgentSeqBySessionID = loadReadState()
        unreadAgentSessionIDs = []
        await refresh(showErrors: true)
    }

    func refresh(showErrors: Bool = true) async {
        cleanServerURL()
        rememberServerURL()
        await refreshHealth(showErrors: showErrors)
        if serverReachable {
            await refreshRuntimeCatalog(showErrors: false)
        }
        await refreshSessions(showErrors: showErrors)
        await refreshJobs(showErrors: showErrors)
    }

    func refreshRuntimeCatalog(showErrors: Bool = false) async {
        do {
            let res: ZRuntimeCatalogSnapshot = try await api.get("/api/runtime/catalog")
            if runtimeCatalog != res {
                runtimeCatalog = res
            }
        } catch {
            if showErrors {
                report(error)
            }
        }
    }

    func refreshHealth(showErrors: Bool = true) async {
        let target = api.url("/api/health").absoluteString
        if showErrors || !serverReachable {
            setConnectionDetail("Testing \(target)")
        }
        do {
            struct Response: Codable {
                let ok: Bool
                let default_cwd: String?
                let active: [String]
            }
            let res: Response = try await api.get("/api/health")
            if serverReachable != res.ok {
                serverReachable = res.ok
            }
            if let cleanCwd = res.default_cwd?.trimmingCharacters(in: .whitespacesAndNewlines), !cleanCwd.isEmpty {
                defaultCwd = cleanCwd
            }
            let nextActive = Set(res.active)
            if activeSessionIDs != nextActive {
                activeSessionIDs = nextActive
            }
            syncSelectedRunningState()
            setStatus(socketLive ? "Live" : "Server connected")
            setConnectionDetail("Connected to \(resolvedServerURLString)")
            if let sid = selectedSessionID, !activeSessionIDs.contains(sid), processSnapshot?.active == true {
                processSnapshot = nil
                processLogTail = nil
            }
        } catch {
            guard !isCancelledNetworkError(error) else { return }
            if serverReachable {
                serverReachable = false
            }
            if socketLive {
                socketLive = false
            }
            if !activeSessionIDs.isEmpty {
                activeSessionIDs = []
            }
            syncSelectedRunningState()
            setStatus("Server offline")
            setConnectionDetail(connectionFailureSummary(error))
            if showErrors { report(error) }
        }
    }

    func refreshSessions(showErrors: Bool = true) async {
        do {
            struct Response: Codable { let sessions: [ZSession] }
            let res: Response = try await api.get("/api/sessions")
            if sessions != res.sessions {
                sessions = res.sessions
            }
            reconcileUnreadFromSessions()
            if selectedSessionID == nil || !sessions.contains(where: { $0.id == selectedSessionID }) {
                selectedSessionID = sessions.first?.id
                if let selectedSessionID {
                    await select(sessionID: selectedSessionID)
                }
            }
        } catch {
            guard !isCancelledNetworkError(error) else { return }
            if showErrors { report(error) }
        }
    }

    func refreshJobs(showErrors: Bool = true) async {
        do {
            struct Response: Codable { let jobs: [ZJob] }
            let res: Response = try await api.get("/api/jobs")
            if jobs != res.jobs {
                jobs = res.jobs
            }
        } catch {
            guard !isCancelledNetworkError(error) else { return }
            if showErrors { report(error) }
        }
    }

    func createSession() async {
        struct Body: Codable {
            var title = "New chat"
            var folder = "General"
            var cwd: String
            var backend = "claude"
        }
        do {
            struct Response: Codable { let session: ZSession }
            let res: Response = try await api.post("/api/sessions", body: Body(cwd: defaultCwd))
            sessions.insert(res.session, at: 0)
            await select(sessionID: res.session.id)
        } catch {
            report(error)
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
            let res: Response = try await api.post("/api/sessions", body: Body(
                title: title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : title,
                folder: folder.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "General" : folder,
                cwd: cwd.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? defaultCwd : cwd,
                backend: backend,
                provider_session_id: cleanID
            ))
            sessions.insert(res.session, at: 0)
            await select(sessionID: res.session.id)
        } catch {
            report(error)
        }
    }

    @discardableResult
    func updateSelected(backend: String? = nil, model: String? = nil, effort: String? = nil, folder: String? = nil, title: String? = nil, cwd: String? = nil, pinned: Bool? = nil, archived: Bool? = nil) async -> Bool {
        guard let sid = selectedSessionID else { return false }
        return await updateSession(sid, folder: folder, title: title, cwd: cwd, backend: backend, model: model, effort: effort, pinned: pinned, archived: archived)
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
            report(error)
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
            report(error)
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
            sessions.removeAll { $0.id == session.id }
            jobs.removeAll { $0.session_id == session.id }
            activeSessionIDs.remove(session.id)
            forgetMemoryChatCache(session.id)
            if selectedSessionID == session.id {
                webSocket?.cancel(with: .goingAway, reason: nil)
                webSocket = nil
                selectedSessionID = nil
                events = []
                uploads = []
                omittedHistoryEventCount = 0
                latestSeenSeq = 0
                socketLive = false
                syncSelectedRunningState()
                if let next = sessions.first {
                    await select(sessionID: next.id)
                }
            }
        } catch {
            report(error)
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
            await select(sessionID: res.session.id)
        } catch {
            report(error)
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
            report(error)
            return nil
        }
    }

    @discardableResult
    func sendPrompt(to sessionID: String, prompt submittedPrompt: String, fileIDs: [String] = []) async -> Bool {
        let trimmed = submittedPrompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        struct Body: Codable {
            let prompt: String
            let file_ids: [String]
        }
        struct Response: Codable {
            let run_id: String?
            let queued: Bool?
            let session: ZSession
        }
        activeSessionIDs.insert(sessionID)
        if sessionID == selectedSessionID {
            syncSelectedRunningState()
        }
        do {
            let res: Response = try await api.post(
                "/api/sessions/\(sessionID)/turns",
                body: Body(prompt: trimmed, file_ids: fileIDs)
            )
            if let idx = sessions.firstIndex(where: { $0.id == sessionID }) {
                sessions[idx] = res.session
            }
            syncSelectedRunningState()
            return true
        } catch {
            activeSessionIDs.remove(sessionID)
            syncSelectedRunningState()
            report(error)
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
        defer {
            if loadingSessionID == sessionID {
                loadingSessionID = nil
            }
        }

        selectedSessionID = sessionID
        markSessionRead(sessionID)
        syncSelectedRunningState()
        webSocket?.cancel(with: .goingAway, reason: nil)
        socketLive = false
        isLoading = true
        processSnapshot = nil
        processLogTail = nil
        status = serverReachable ? "Loading chat" : "Server offline"

        if let cached = memoryCachedChat(sessionID) {
            applyCachedChat(cached)
        } else {
            events = []
            uploads = []
            sessionFiles = []
            omittedHistoryEventCount = 0
            latestSeenSeq = 0
        }

        guard selectedSessionID == sessionID, selectionGeneration == generation else { return }

        do {
            let res: SessionEventsResponse = try await api.get(
                "/api/sessions/\(sessionID)",
                queryItems: [
                    URLQueryItem(name: "limit", value: "\(initialEventLimit)"),
                    URLQueryItem(name: "tail", value: "true")
                ]
            )
            guard selectedSessionID == sessionID, selectionGeneration == generation else { return }
            if let idx = sessions.firstIndex(where: { $0.id == sessionID }) {
                sessions[idx] = res.session
            }
            applySessionEventSnapshot(res, sessionID: sessionID)
            markSessionRead(sessionID)
            refreshSessionFilesFromLoadedEvents()
            isLoading = false
            rememberSelectedChat()
            Task { await loadSessionFiles(sessionID: sessionID, generation: generation) }
            connectEvents(sessionID: sessionID, after: lastSeq)
            scrollRevision += 1
        } catch {
            guard selectedSessionID == sessionID, selectionGeneration == generation else { return }
            isLoading = false
            report(error)
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
            let res: Response = try await api.get(
                "/api/sessions/\(sid)",
                queryItems: [
                    URLQueryItem(name: "before", value: "\(before)"),
                    URLQueryItem(name: "limit", value: "\(olderHistoryPageLimit)"),
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
            latestSeenSeq = max(latestSeenSeq, events.map(\.seq).max() ?? 0)
            refreshSessionFilesFromLoadedEvents()
            rememberSelectedChat()
            return older.count
        } catch {
            report(error)
            return 0
        }
    }

    func refreshSelectedFiles() async {
        guard let sid = selectedSessionID else { return }
        await loadSessionFiles(sessionID: sid, generation: selectionGeneration)
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
            if showErrors {
                report(error)
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
                    URLQueryItem(name: "lines", value: "220")
                ]
            )
            guard selectedSessionID == sid else { return }
            processLogTail = res
        } catch {
            report(error)
        }
    }

    func refreshTimelineFromPull() async {
        if canLoadOlderHistory {
            await loadOlderHistory()
            return
        }
        await refreshHealth(showErrors: true)
        if let sid = selectedSessionID, serverReachable, !socketLive {
            connectEvents(sessionID: sid, after: lastSeq)
        }
    }

    @discardableResult
    func sendPrompt(_ submittedPrompt: String? = nil) async -> Bool {
        guard let sid = selectedSessionID else { return false }
        let sourcePrompt = submittedPrompt ?? prompt
        let trimmed = sourcePrompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        struct Body: Codable {
            let prompt: String
            let file_ids: [String]
        }
        if submittedPrompt == nil {
            prompt = ""
        }
        activeSessionIDs.insert(sid)
        syncSelectedRunningState()
        do {
            struct Response: Codable {
                let run_id: String?
                let queued: Bool?
                let session: ZSession
            }
            let body = Body(prompt: trimmed, file_ids: uploads.map(\.id))
            let res: Response = try await api.post("/api/sessions/\(sid)/turns", body: body)
            if let idx = sessions.firstIndex(where: { $0.id == sid }) {
                sessions[idx] = res.session
            }
            uploads = []
            return true
        } catch {
            if submittedPrompt == nil {
                prompt = trimmed
            }
            activeSessionIDs.remove(sid)
            syncSelectedRunningState()
            report(error)
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
        } catch {
            report(error)
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
        } catch {
            report(error)
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
            let res: Response = try await api.post("/api/jobs", body: Body(
                session_id: sid,
                title: cleanTitle.isEmpty ? "\(loop ? "Loop" : "Job"): \(selectedSession?.title ?? "Chat")" : cleanTitle,
                prompt: cleanPrompt,
                interval_seconds: max(10, intervalSeconds),
                loop: loop,
                enabled: true,
                backend: selectedSession?.backend
            ))
            jobs.insert(res.job, at: 0)
        } catch {
            report(error)
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
            report(error)
        }
    }

    func runJobNow(_ job: ZJob) async {
        struct Empty: Codable {}
        do {
            let _: JSONValue = try await api.post("/api/jobs/\(job.id)/run", body: Empty())
            await refreshJobs(showErrors: false)
        } catch {
            report(error)
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
            report(error)
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
                report(error)
            }
        }
    }

    func removeUpload(_ file: ZFile) {
        uploads.removeAll { $0.id == file.id }
    }

    func fileURL(_ file: ZFile) -> URL {
        api.authenticatedURL("/api/files/\(file.id)")
    }

    func markdownLinkContext(sessionID: String) -> ZMarkdownLinkContext {
        ZMarkdownLinkContext(sessionID: sessionID, baseURL: api.baseURL, accessToken: accessToken)
    }

    private func cleanServerURL() {
        rememberServerURL()
    }

    private func setStatus(_ next: String) {
        if status != next {
            status = next
        }
    }

    private func setConnectionDetail(_ next: String) {
        if connectionDetail != next {
            connectionDetail = next
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

    private func connectEvents(sessionID: String, after: Int) {
        let task = URLSession.shared.webSocketTask(with: api.wsRequest(sessionID: sessionID, after: after))
        webSocket = task
        task.resume()
        if !socketLive {
            socketLive = true
        }
        setStatus("Live")
        receiveNext(task: task, sessionID: sessionID)
    }

    private func receiveNext(task: URLSessionWebSocketTask, sessionID: String) {
        task.receive { [weak self] result in
            Task { @MainActor in
                guard let self else { return }
                switch result {
                case .success(let message):
                    guard self.webSocket === task, self.selectedSessionID == sessionID else { return }
                    if case .string(let text) = message, let data = text.data(using: .utf8),
                       let event = try? JSONDecoder().decode(ZEvent.self, from: data) {
                        self.ingest(event)
                    } else if case .data(let data) = message,
                              let event = try? JSONDecoder().decode(ZEvent.self, from: data) {
                        self.ingest(event)
                    }
                    self.receiveNext(task: task, sessionID: sessionID)
                case .failure:
                    guard self.webSocket === task, self.selectedSessionID == sessionID else { return }
                    if self.socketLive {
                        self.socketLive = false
                    }
                    self.setStatus(self.serverReachable ? "Stream reconnecting" : "Server offline")
                }
            }
        }
    }

    private func ingest(_ event: ZEvent) {
        latestSeenSeq = max(latestSeenSeq, event.seq)
        if event.type == "raw_event" {
            return
        }
        guard event.session_id == selectedSessionID else {
            updateRunningState(from: event)
            if isAgentVisibleMessage(event) {
                unreadAgentSessionIDs.insert(event.session_id)
            }
            return
        }
        guard !events.contains(where: { $0.id == event.id }) else { return }
        events.append(event)
        updateRunningState(from: event)
        if isAgentVisibleMessage(event) {
            setLastReadAgentSeq(event.seq, for: event.session_id)
            unreadAgentSessionIDs.remove(event.session_id)
        }
        if let file = event.file {
            addPendingUpload(file)
            upsertSessionFile(file)
        }
        if let artifact = event.artifact {
            upsertSessionFile(artifact)
        }
        if event.type != "raw_event" {
            rememberSelectedChat()
        }
        scrollRevision += 1
    }

    private func updateRunningState(from event: ZEvent) {
        if event.type == "turn_started" {
            activeSessionIDs.insert(event.session_id)
        }
        if event.type == "turn_finished" || event.type == "error" || event.type == "turn_stopped" {
            activeSessionIDs.remove(event.session_id)
            if event.session_id == selectedSessionID {
                processSnapshot = nil
                processLogTail = nil
            }
        }
        syncSelectedRunningState()
    }

    private func timelineEvents(from source: [ZEvent]) -> [ZEvent] {
        source.filter { $0.type != "raw_event" }
    }

    private func mergeEvents(_ incoming: [ZEvent]) {
        guard !incoming.isEmpty else { return }
        let existingIDs = Set(events.map(\.id))
        let incomingEvents = timelineEvents(from: incoming)
        events.append(contentsOf: incomingEvents.filter { !existingIDs.contains($0.id) })
        events.sort { $0.seq < $1.seq }
        latestSeenSeq = max(latestSeenSeq, incomingEvents.map(\.seq).max() ?? 0)
        refreshSessionFilesFromLoadedEvents()
    }

    private func applySessionEventSnapshot(_ response: SessionEventsResponse, sessionID: String) {
        if let idx = sessions.firstIndex(where: { $0.id == sessionID }) {
            sessions[idx] = response.session
        }
        events = timelineEvents(from: response.events)
        omittedHistoryEventCount = response.events_omitted_before ?? 0
        latestSeenSeq = max(response.latest_seq ?? 0, events.map(\.seq).max() ?? 0)
        refreshSessionFilesFromLoadedEvents()
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
        sessionFiles = mergedFiles(cached.sessionFiles + files(from: events))
        refreshSessionFilesFromLoadedEvents()
        latestSeenSeq = events.map(\.seq).max() ?? 0
    }

    private func refreshSessionFilesFromLoadedEvents() {
        let known = files(from: events)
        guard !known.isEmpty || sessionFiles.isEmpty else { return }
        sessionFiles = mergedFiles(sessionFiles + known)
    }

    private func files(from source: [ZEvent]) -> [ZFile] {
        source.flatMap { event -> [ZFile] in
            [event.file, event.artifact].compactMap { $0 }
        }
    }

    private func upsertSessionFile(_ file: ZFile) {
        sessionFiles = mergedFiles(sessionFiles + [file])
    }

    private func loadSessionFiles(sessionID: String, generation: Int) async {
        do {
            struct Response: Codable { let files: [ZFile] }
            let res: Response = try await api.get("/api/sessions/\(sessionID)/files")
            guard selectedSessionID == sessionID, selectionGeneration == generation else { return }
            sessionFiles = mergedFiles(res.files + files(from: events))
        } catch {
            guard !isCancelledNetworkError(error) else { return }
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

    private func rememberSelectedChat() {
        guard let session = selectedSession else { return }
        let overflow = max(events.count - maxMemoryCachedEvents, 0)
        let cachedEvents = Array(events.suffix(maxMemoryCachedEvents))
        let cached = CachedChat(
            session: session,
            events: cachedEvents,
            sessionFiles: sessionFiles.isEmpty ? files(from: events) : sessionFiles,
            omittedHistoryEventCount: omittedHistoryEventCount + overflow
        )
        rememberChatCache(cached)
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

    private func forgetMemoryChatCache(_ sessionID: String) {
        let key = chatCacheKey(sessionID)
        memoryChatCache.removeValue(forKey: key)
        memoryChatCacheOrder.removeAll { $0 == key }
    }

    private func chatCacheKey(_ sessionID: String) -> String {
        ZEndpointCache.key(serverURL: resolvedServerURLString, sessionID: sessionID, default: defaultAgentServerURLString)
    }

    private func syncSelectedRunningState() {
        guard let selectedSessionID else {
            if isRunning {
                isRunning = false
            }
            return
        }
        let next = activeSessionIDs.contains(selectedSessionID)
        if isRunning != next {
            isRunning = next
        }
    }

    private func report(_ error: Error) {
        guard !isCancelledNetworkError(error) else { return }
        let ns = error as NSError
        if ns.domain == "ZenithDock.API", ns.code == 401 || ns.code == 403 {
            errorText = "Agent server rejected the access token for \(resolvedServerURLString). Check the token on the server and in this app."
        } else if ns.domain == NSURLErrorDomain {
            errorText = "\(connectionFailureSummary(error)). If Safari works but server logs do not show an app request, enable Local Network for ZenithDock in iOS Settings and make sure Tailscale is active."
        } else {
            errorText = error.localizedDescription
        }
    }

    private func isCancelledNetworkError(_ error: Error) -> Bool {
        let ns = error as NSError
        return ns.domain == NSURLErrorDomain && ns.code == NSURLErrorCancelled
    }

    private func connectionFailureSummary(_ error: Error) -> String {
        let ns = error as NSError
        if ns.domain == NSURLErrorDomain {
            if ns.code == NSURLErrorAppTransportSecurityRequiresSecureConnection {
                return "iOS App Transport Security blocked HTTP to \(resolvedServerURLString) (-1022). Install the latest build with the ZenithDock ATS exception."
            }
            return "Cannot reach \(resolvedServerURLString). \(ns.localizedDescription) (\(ns.code))"
        }
        if ns.domain == "ZenithDock.API" {
            return "Server replied \(ns.code) from \(resolvedServerURLString): \(ns.localizedDescription)"
        }
        return error.localizedDescription
    }

    private static func serverParts(from value: String) -> (host: String, port: String) {
        let url = ZenithServerURL.url(value, default: defaultAgentServerURLString)
        let host = url.host?.isEmpty == false ? url.host! : defaultAgentServerHost
        let port = url.port.map(String.init) ?? defaultAgentServerPort
        return (host, port)
    }

    private static func serverParts(host rawHost: String, port rawPort: String) -> (host: String, port: String) {
        var host = rawHost.trimmingCharacters(in: .whitespacesAndNewlines)
        var port = rawPort.trimmingCharacters(in: .whitespacesAndNewlines)
        if host.isEmpty {
            host = defaultAgentServerHost
        }

        let candidate = host.contains("://") ? host : "http://\(host)"
        if let comps = URLComponents(string: candidate), let parsedHost = comps.host, !parsedHost.isEmpty {
            host = parsedHost
            if port.isEmpty, let parsedPort = comps.port {
                port = String(parsedPort)
            }
        }

        if port.isEmpty {
            port = defaultAgentServerPort
        }
        return (host, port)
    }
}
