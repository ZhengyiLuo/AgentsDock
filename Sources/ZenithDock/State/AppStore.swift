import Combine
import Foundation
import ZenithCore

private let defaultAgentServerURLString = "http://10.112.215.37:7850"

@MainActor
final class AppStore: ObservableObject {
    @Published var serverURLString = UserDefaults.standard.string(forKey: "serverURL") ?? defaultAgentServerURLString
    @Published var accessToken = ZenithTokenStore.load()
    @Published var sessions: [ZSession] = []
    @Published var selectedSessionID: String?
    @Published var events: [ZEvent] = []
    @Published var uploads: [ZFile] = []
    @Published var prompt = ""
    @Published var isRunning = false
    @Published var status = "Disconnected"
    @Published var errorText: String?
    @Published var jobs: [ZJob] = []
    @Published var showDebugEvents = false {
        didSet { rebuildDisplayEvents() }
    }
    @Published private(set) var displayEvents: [ZEvent] = []
    @Published var loadedSessionID: String?
    @Published var serverReachable = false
    @Published var socketLive = false
    @Published var activeSessionIDs: Set<String> = []
    @Published var lastHealthAt: Date?
    @Published var lastLoadedAt: Date?
    @Published var lastSocketError: String?
    @Published var omittedHistoryEventCount = 0
    @Published var isLoadingOlderHistory = false
    @Published var scrollToBottomRevision = 0

    private let initialSessionEventLimit = 80
    private let olderHistoryPageLimit = 100
    private let maxLoadedTimelineEvents = 260
    private let maxCachedTimelineEvents = 160
    private let maxCachedStringCharacters = 12_000
    private var webSocket: URLSessionWebSocketTask?
    private var loadingSessionID: String?
    private var liveTrackingStarted = false
    private var latestSeenSeq = 0
    private var pendingCacheWrite: Task<Void, Never>?
    private var lastSeq: Int { max(latestSeenSeq, events.map(\.seq).max() ?? 0) }

    private struct CachedChat: Codable, Sendable {
        var session: ZSession
        var events: [ZEvent]
        var omittedHistoryEventCount: Int
        var cachedAt: String
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

    var pinnedSessions: [ZSession] {
        sessions.filter { $0.pinned == true }
    }

    var folders: [String: [ZSession]] {
        Dictionary(grouping: sessions.filter { $0.pinned != true }) { $0.folder ?? "General" }
    }

    var folderNames: [String] {
        Array(Set(sessions.map { $0.folder ?? "General" })).sorted()
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
        return "\(loaded) · \(active) · \(stream)"
    }

    var hiddenDisplayEventCount: Int {
        omittedHistoryEventCount
    }

    var canLoadOlderHistory: Bool {
        omittedHistoryEventCount > 0 && !isLoadingOlderHistory && events.count < maxLoadedTimelineEvents
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
        cleanServerURL()
        UserDefaults.standard.set(serverURLString, forKey: "serverURL")
    }

    func rememberAccessToken() {
        ZenithTokenStore.save(accessToken)
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
            if tick % 6 == 0 {
                await refreshSessions(showErrors: false)
                await refreshJobs(showErrors: false)
            }
            if let sid = selectedSessionID, serverReachable, !socketLive {
                connectEvents(sessionID: sid, after: lastSeq)
            }
        }
    }

    func refresh(showErrors: Bool = true) async {
        cleanServerURL()
        rememberServerURL()
        await refreshHealth(showErrors: showErrors)
        await refreshSessions(showErrors: showErrors)
        await refreshJobs(showErrors: showErrors)
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
            activeSessionIDs = Set(res.active)
            lastHealthAt = Date()
            syncSelectedRunningState()
            status = socketLive ? "Live" : "Server connected"
        } catch {
            serverReachable = false
            socketLive = false
            activeSessionIDs = []
            syncSelectedRunningState()
            status = "Server offline"
            AppLogger.warning("health failed \(serverErrorMessage(error) ?? "\(error)")")
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
                var cwd = "/home/zen"
                var backend = "claude"
            }
            struct Response: Codable { let session: ZSession }
            let cleanFolder = folder.trimmingCharacters(in: .whitespacesAndNewlines)
            let res: Response = try await api.post("/api/sessions", body: Body(
                title: title,
                folder: cleanFolder.isEmpty ? "General" : cleanFolder
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
                cwd: cleanCwd.isEmpty ? "/home/zen" : cleanCwd,
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
            syncSelectedRunningState()
            return
        }
        loadingSessionID = sessionID
        defer {
            if loadingSessionID == sessionID {
                loadingSessionID = nil
            }
        }
        selectedSessionID = sessionID
        syncSelectedRunningState()
        webSocket?.cancel(with: .goingAway, reason: nil)
        socketLive = false
        status = serverReachable ? "Loading chat" : "Server offline"
        AppLogger.info("select session=\(sessionID)")
        var loadedFromCache = false
        if let cached = loadCachedChat(sessionID) {
            applyCachedChat(cached)
            loadedFromCache = true
            status = "Loaded cached chat"
            AppLogger.info("loaded cache session=\(sessionID) events=\(cached.events.count) omitted_before=\(cached.omittedHistoryEventCount)")
            scrollToBottomRevision += 1
        } else {
            events = []
            rebuildDisplayEvents()
            uploads = []
            omittedHistoryEventCount = 0
            loadedSessionID = nil
            latestSeenSeq = 0
        }
        do {
            struct Response: Codable {
                let session: ZSession
                let events: [ZEvent]
                let events_omitted_before: Int?
            }
            let requestAfter = loadedFromCache ? lastSeq : 0
            let res: Response = try await api.get(
                "/api/sessions/\(sessionID)",
                queryItems: loadedFromCache && requestAfter > 0 ? [
                    URLQueryItem(name: "after", value: "\(requestAfter)"),
                    URLQueryItem(name: "limit", value: "\(initialSessionEventLimit)"),
                    URLQueryItem(name: "tail", value: "false")
                ] : [
                    URLQueryItem(name: "limit", value: "\(initialSessionEventLimit)"),
                    URLQueryItem(name: "tail", value: "true")
                ]
            )
            if let idx = sessions.firstIndex(where: { $0.id == sessionID }) {
                sessions[idx] = res.session
            }
            guard selectedSessionID == sessionID else {
                AppLogger.info("drop stale selection response session=\(sessionID)")
                return
            }
            if loadedFromCache {
                mergeEvents(res.events)
            } else {
                events = timelineEvents(from: res.events)
                omittedHistoryEventCount = res.events_omitted_before ?? 0
                latestSeenSeq = events.map(\.seq).max() ?? 0
                rebuildDisplayEvents()
            }
            uploads = events.compactMap(\.file)
            loadedSessionID = sessionID
            AppLogger.info("selected session=\(sessionID) events=\(events.count) omitted_before=\(omittedHistoryEventCount)")
            saveSelectedChatCache()
            connectEvents(sessionID: sessionID, after: lastSeq)
            syncSelectedRunningState()
            scrollToBottomRevision += 1
        } catch {
            AppLogger.error("select failed session=\(sessionID) \(serverErrorMessage(error) ?? "\(error)")")
            if !loadedFromCache {
                reportServerError(error)
            }
        }
    }

    func loadOlderHistory() async {
        guard let sid = selectedSessionID,
              omittedHistoryEventCount > 0,
              !isLoadingOlderHistory,
              let before = events.map(\.seq).min(),
              events.count < maxLoadedTimelineEvents else {
            return
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
            uploads = events.compactMap(\.file)
            latestSeenSeq = max(latestSeenSeq, events.map(\.seq).max() ?? 0)
            rebuildDisplayEvents()
            saveSelectedChatCache()
            AppLogger.info("loaded older session=\(sid) added=\(older.count) loaded=\(events.count) omitted_before=\(omittedHistoryEventCount)")
        } catch {
            AppLogger.error("load older failed session=\(sid) \(serverErrorMessage(error) ?? "\(error)")")
            reportServerError(error)
        }
    }

    func updateSelected(backend: String? = nil, folder: String? = nil, title: String? = nil, cwd: String? = nil, pinned: Bool? = nil) async {
        guard let sid = selectedSessionID else { return }
        struct Body: Codable {
            var title: String?
            var folder: String?
            var cwd: String?
            var backend: String?
            var pinned: Bool?
        }
        do {
            struct Response: Codable { let session: ZSession }
            let body = Body(title: title, folder: folder, cwd: cwd, backend: backend, pinned: pinned)
            let res: Response = try await api.patch("/api/sessions/\(sid)", body: body)
            if let idx = sessions.firstIndex(where: { $0.id == sid }) {
                sessions[idx] = res.session
            }
        } catch {
            reportServerError(error)
        }
    }

    func togglePin(_ session: ZSession) async {
        await updateSession(session.id, pinned: !(session.pinned ?? false))
    }

    func moveSession(_ session: ZSession, to folder: String) async {
        let cleanFolder = folder.trimmingCharacters(in: .whitespacesAndNewlines)
        await updateSession(session.id, folder: cleanFolder.isEmpty ? "General" : cleanFolder)
    }

    func updateSession(_ sessionID: String, folder: String? = nil, title: String? = nil, cwd: String? = nil, backend: String? = nil, pinned: Bool? = nil) async {
        struct Body: Codable {
            var title: String?
            var folder: String?
            var cwd: String?
            var backend: String?
            var pinned: Bool?
        }
        do {
            struct Response: Codable { let session: ZSession }
            let res: Response = try await api.patch("/api/sessions/\(sessionID)", body: Body(
                title: title,
                folder: folder,
                cwd: cwd,
                backend: backend,
                pinned: pinned
            ))
            if let idx = sessions.firstIndex(where: { $0.id == sessionID }) {
                sessions[idx] = res.session
            }
        } catch {
            reportServerError(error)
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
                events = []
                displayEvents = []
                latestSeenSeq = 0
                omittedHistoryEventCount = 0
                syncSelectedRunningState()
                scrollToBottomRevision += 1
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

    func upload(urls: [URL]) async {
        guard let sid = selectedSessionID else { return }
        for url in urls {
            let ok = url.startAccessingSecurityScopedResource()
            defer { if ok { url.stopAccessingSecurityScopedResource() } }
            do {
                let file = try await api.upload(sessionID: sid, fileURL: url)
                uploads.append(file)
            } catch {
                reportServerError(error)
            }
        }
    }

    func sendPrompt() async {
        guard let sid = selectedSessionID else { return }
        let trimmed = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let wasRunning = isRunning
        struct Body: Codable {
            let prompt: String
            let file_ids: [String]
        }
        do {
            isRunning = true
            activeSessionIDs.insert(sid)
            prompt = ""
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
        } catch {
            if prompt.isEmpty {
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
            let body = Body(
                session_id: sid,
                title: title,
                prompt: prompt,
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

    func fileURL(_ file: ZFile) -> URL {
        api.authenticatedURL("/api/files/\(file.id)")
    }

    private func connectEvents(sessionID: String, after: Int) {
        let task = URLSession.shared.webSocketTask(with: api.wsRequest(sessionID: sessionID, after: after))
        webSocket = task
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
                    guard self.webSocket === task, self.selectedSessionID == sessionID else { return }
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
        }
        if let file = event.file {
            uploads.append(file)
        }
        if event.type != "raw_event" {
            saveSelectedChatCache()
        }
        scrollToBottomRevision += 1
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
        rebuildDisplayEvents()
    }

    private func applyCachedChat(_ cached: CachedChat) {
        if let idx = sessions.firstIndex(where: { $0.id == cached.session.id }) {
            sessions[idx] = cached.session
        }
        events = timelineEvents(from: cached.events)
        omittedHistoryEventCount = cached.omittedHistoryEventCount
        uploads = events.compactMap(\.file)
        loadedSessionID = cached.session.id
        latestSeenSeq = events.map(\.seq).max() ?? 0
        rebuildDisplayEvents()
    }

    private var chatCacheDirectory: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support", isDirectory: true)
        return base
            .appendingPathComponent("ZenithDock", isDirectory: true)
            .appendingPathComponent("ChatCache", isDirectory: true)
    }

    private func chatCacheURL(_ sessionID: String) -> URL {
        chatCacheDirectory.appendingPathComponent("\(sessionID).json")
    }

    private func loadCachedChat(_ sessionID: String) -> CachedChat? {
        let url = chatCacheURL(sessionID)
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(CachedChat.self, from: data)
    }

    private func saveSelectedChatCache() {
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
            omittedHistoryEventCount: omittedHistoryEventCount,
            cachedAt: ISO8601DateFormatter().string(from: Date())
        )
        pendingCacheWrite?.cancel()
        pendingCacheWrite = Task.detached(priority: .utility) {
            try? await Task.sleep(nanoseconds: 350_000_000)
            guard !Task.isCancelled else { return }
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
                      self.webSocket === failedTask,
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
        errorText = message
    }

    private func serverErrorMessage(_ error: Error) -> String? {
        let ns = error as NSError
        if ns.domain == NSURLErrorDomain && ns.code == NSURLErrorCancelled {
            return nil
        }
        if ns.domain == NSURLErrorDomain {
            return "Cannot reach the Zenithbot agent server at \(serverURLString). The Mac internet may be fine; this means the app cannot reach Zen-nv or port 7850 right now."
        }
        if ns.domain == "ZenithDock.API", ns.code == 401 || ns.code == 403 {
            return "Agent server rejected the access token. Check ZENITHDOCK_AGENT_TOKEN on Zen-nv and the token field in the app."
        }
        return error.localizedDescription
    }

    private func cleanServerURL() {
        let raw = ZenithServerURL.normalized(serverURLString, default: defaultAgentServerURLString)
        if serverURLString != raw {
            serverURLString = raw
        }
        UserDefaults.standard.set(raw, forKey: "serverURL")
    }
}
