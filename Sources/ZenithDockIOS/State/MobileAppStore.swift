import Foundation
import ZenithCore

private let defaultAgentServerURLString = "http://10.112.215.37:7850"

@MainActor
final class MobileAppStore: ObservableObject {
    @Published var serverURLString = UserDefaults.standard.string(forKey: "serverURL") ?? defaultAgentServerURLString
    @Published var accessToken = ZenithTokenStore.load()
    @Published var sessions: [ZSession] = []
    @Published var selectedSessionID: String?
    @Published var events: [ZEvent] = []
    @Published var uploads: [ZFile] = []
    @Published var prompt = ""
    @Published var isRunning = false
    @Published var isLoading = false
    @Published var serverReachable = false
    @Published var socketLive = false
    @Published var status = "Disconnected"
    @Published var activeSessionIDs: Set<String> = []
    @Published var errorText: String?
    @Published var scrollRevision = 0

    private let eventLimit = 80
    private var webSocket: URLSessionWebSocketTask?
    private var loadingSessionID: String?
    private var liveTrackingStarted = false
    private var lastSeq: Int { events.map(\.seq).max() ?? 0 }

    var api: APIClient {
        APIClient(
            baseURL: URL(string: serverURLString) ?? URL(string: defaultAgentServerURLString)!,
            accessToken: accessToken
        )
    }

    var selectedSession: ZSession? {
        sessions.first { $0.id == selectedSessionID }
    }

    var displayEvents: [ZEvent] {
        let assistantRuns = Set(events.compactMap { event -> String? in
            guard event.type == "assistant_text",
                  event.text?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false else {
                return nil
            }
            return event.run_id
        })
        let queuedTurnIDs = Set(events.compactMap { event -> String? in
            event.type == "turn_queued" ? event.queued_id : nil
        })
        return events.filter { event in
            switch event.type {
            case "session_created", "process_started", "provider_session", "raw_event", "cwd_fallback":
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
            if tick % 6 == 0 {
                await refreshSessions(showErrors: false)
            }
            if let sid = selectedSessionID, serverReachable, !socketLive {
                connectEvents(sessionID: sid, after: lastSeq)
            }
        }
    }

    func rememberServerURL() {
        cleanServerURL()
        UserDefaults.standard.set(serverURLString, forKey: "serverURL")
    }

    func rememberAccessToken() {
        ZenithTokenStore.save(accessToken)
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
        await refresh(showErrors: true)
    }

    func refresh(showErrors: Bool = true) async {
        cleanServerURL()
        rememberServerURL()
        await refreshHealth(showErrors: showErrors)
        await refreshSessions(showErrors: showErrors)
    }

    func refreshHealth(showErrors: Bool = true) async {
        do {
            struct Response: Codable {
                let ok: Bool
                let active: [String]
            }
            let res: Response = try await api.get("/api/health")
            serverReachable = res.ok
            activeSessionIDs = Set(res.active)
            syncSelectedRunningState()
            status = socketLive ? "Live" : "Server connected"
        } catch {
            serverReachable = false
            socketLive = false
            activeSessionIDs = []
            syncSelectedRunningState()
            status = "Server offline"
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
            if selectedSessionID == nil || !sessions.contains(where: { $0.id == selectedSessionID }) {
                selectedSessionID = sessions.first?.id
                if let selectedSessionID {
                    await select(sessionID: selectedSessionID)
                }
            }
        } catch {
            if showErrors { report(error) }
        }
    }

    func createSession() async {
        struct Body: Codable {
            var title = "New chat"
            var folder = "General"
            var cwd = "/home/zen"
            var backend = "claude"
        }
        do {
            struct Response: Codable { let session: ZSession }
            let res: Response = try await api.post("/api/sessions", body: Body())
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
                cwd: cwd.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "/home/zen" : cwd,
                backend: backend,
                provider_session_id: cleanID
            ))
            sessions.insert(res.session, at: 0)
            await select(sessionID: res.session.id)
        } catch {
            report(error)
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
        isLoading = true
        events = []
        uploads = []
        status = serverReachable ? "Loading chat" : "Server offline"

        do {
            struct Response: Codable {
                let session: ZSession
                let events: [ZEvent]
            }
            let res: Response = try await api.get(
                "/api/sessions/\(sessionID)",
                queryItems: [
                    URLQueryItem(name: "limit", value: "\(eventLimit)"),
                    URLQueryItem(name: "tail", value: "true")
                ]
            )
            guard selectedSessionID == sessionID else { return }
            if let idx = sessions.firstIndex(where: { $0.id == sessionID }) {
                sessions[idx] = res.session
            }
            events = res.events
            uploads = events.compactMap(\.file)
            isLoading = false
            connectEvents(sessionID: sessionID, after: lastSeq)
            scrollRevision += 1
        } catch {
            isLoading = false
            report(error)
        }
    }

    func sendPrompt() async {
        guard let sid = selectedSessionID else { return }
        let trimmed = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        struct Body: Codable {
            let prompt: String
            let file_ids: [String]
        }
        prompt = ""
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
        } catch {
            prompt = trimmed
            activeSessionIDs.remove(sid)
            syncSelectedRunningState()
            report(error)
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

    func upload(urls: [URL]) async {
        guard let sid = selectedSessionID else { return }
        for url in urls {
            let ok = url.startAccessingSecurityScopedResource()
            defer { if ok { url.stopAccessingSecurityScopedResource() } }
            do {
                let file = try await api.upload(sessionID: sid, fileURL: url)
                uploads.append(file)
            } catch {
                report(error)
            }
        }
    }

    func fileURL(_ file: ZFile) -> URL {
        api.authenticatedURL("/api/files/\(file.id)")
    }

    private func cleanServerURL() {
        var raw = serverURLString.trimmingCharacters(in: .whitespacesAndNewlines)
        if raw.isEmpty {
            raw = defaultAgentServerURLString
        }
        while raw.hasSuffix("/") {
            raw.removeLast()
        }
        if serverURLString != raw {
            serverURLString = raw
        }
        UserDefaults.standard.set(raw, forKey: "serverURL")
    }

    func hasStartedQueuedEvent(_ event: ZEvent) -> Bool {
        guard event.type == "turn_queued", let queuedID = event.queued_id else { return false }
        return events.contains { $0.type == "turn_started" && $0.queued_id == queuedID }
    }

    private func connectEvents(sessionID: String, after: Int) {
        let task = URLSession.shared.webSocketTask(with: api.wsRequest(sessionID: sessionID, after: after))
        webSocket = task
        task.resume()
        socketLive = true
        status = "Live"
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
                    self.socketLive = false
                    self.status = self.serverReachable ? "Stream reconnecting" : "Server offline"
                }
            }
        }
    }

    private func ingest(_ event: ZEvent) {
        guard event.session_id == selectedSessionID else {
            updateRunningState(from: event)
            return
        }
        guard !events.contains(where: { $0.id == event.id }) else { return }
        events.append(event)
        updateRunningState(from: event)
        if let file = event.file {
            uploads.append(file)
        }
        scrollRevision += 1
    }

    private func updateRunningState(from event: ZEvent) {
        if event.type == "turn_started" {
            activeSessionIDs.insert(event.session_id)
        }
        if event.type == "turn_finished" || event.type == "error" || event.type == "turn_stopped" {
            activeSessionIDs.remove(event.session_id)
        }
        syncSelectedRunningState()
    }

    private func syncSelectedRunningState() {
        guard let selectedSessionID else {
            isRunning = false
            return
        }
        isRunning = activeSessionIDs.contains(selectedSessionID)
    }

    private func report(_ error: Error) {
        let ns = error as NSError
        if ns.domain == "ZenithDock.API", ns.code == 401 || ns.code == 403 {
            errorText = "Agent server rejected the access token. Check the token on Zen-nv and in this app."
        } else if ns.domain == NSURLErrorDomain {
            errorText = "Cannot reach \(serverURLString). If Safari opens /api/health, tap Reconnect once; otherwise check Tailscale and port 7850. Code \(ns.code)."
        } else {
            errorText = error.localizedDescription
        }
    }
}
