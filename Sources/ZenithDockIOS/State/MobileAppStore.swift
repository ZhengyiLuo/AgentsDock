import Foundation
import ZenithCore

private let defaultAgentServerURLString = "http://127.0.0.1:7850"
private let defaultAgentServerHost = "127.0.0.1"
private let defaultAgentServerPort = "7850"
private let fallbackServerCwd = "~"
private let minimumAgentAPIContractVersion = 3
private let pendingRuntimePatchTimeout: TimeInterval = 12

@MainActor
final class MobileAppStore: ObservableObject {
    @Published var serverURLString = UserDefaults.standard.string(forKey: "serverURL") ?? defaultAgentServerURLString
    @Published var serverHost = UserDefaults.standard.string(forKey: "serverHost") ?? defaultAgentServerHost
    @Published var serverPort = UserDefaults.standard.string(forKey: "serverPort") ?? defaultAgentServerPort
    @Published var accessToken = ZenithTokenStore.load()
    @Published var sessions: [ZSession] = []
    @Published var selectedSessionID: String?
    private(set) var events: [ZEvent] = []
    @Published private(set) var displayEvents: [ZEvent] = []
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
    @Published var launchDeferredText: String?
    @Published var activeSessionIDs: Set<String> = []
    @Published var defaultCwd = fallbackServerCwd
    @Published var errorText: String?
    @Published var omittedHistoryEventCount = 0
    @Published var scrollRevision = 0
    @Published var processSnapshot: ZProcessSnapshot?
    @Published var processLogTail: ZProcessLogTail?
    @Published var isLoadingProcesses = false
    @Published private(set) var unreadAgentSessionIDs: Set<String> = []
    @Published private(set) var folderOrder: [String] = UserDefaults.standard.stringArray(forKey: "mobileFolderOrder") ?? []
    @Published private(set) var collapsedFolders: Set<String> = Set(UserDefaults.standard.stringArray(forKey: "mobileCollapsedFolders") ?? [])
    @Published private(set) var archivedSectionCollapsed = UserDefaults.standard.bool(forKey: "mobileArchivedSectionCollapsed")

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
    private var manuallyUnreadSessionIDs: Set<String> = []
    private var pendingReadSyncBySessionID: [String: Int] = [:]
    private var pendingRuntimeBySessionID: [String: PendingRuntimePatch] = [:]
    private var draftPromptsBySessionID: [String: String] = [:]
    private var pendingDraftSave: Task<Void, Never>?
    private var serverIdentity: String?
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
        serverIdentity = Self.loadServerIdentity(for: serverURLString)
        lastReadAgentSeqBySessionID = loadReadState()
        draftPromptsBySessionID = loadDraftPrompts()
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
        UserDefaults.standard.set(Array(collapsedFolders).sorted(), forKey: "mobileCollapsedFolders")
    }

    func toggleArchivedSectionCollapsed() {
        archivedSectionCollapsed.toggle()
        UserDefaults.standard.set(archivedSectionCollapsed, forKey: "mobileArchivedSectionCollapsed")
    }

    func moveFolder(_ folder: String, direction: String) {
        let clean = normalizedFolderName(folder)
        var names = orderedFolderNames(Array(Set(activeSessions.map { $0.folder ?? "General" })))
        guard let index = names.firstIndex(of: clean) else { return }
        let target = direction == "up" ? index - 1 : index + 1
        guard names.indices.contains(target) else { return }
        names.swapAt(index, target)
        folderOrder = names
        UserDefaults.standard.set(folderOrder, forKey: "mobileFolderOrder")
    }

    func reorderFolders(from source: IndexSet, to destination: Int) {
        var names = orderedFolderNames(Array(Set(activeSessions.map { $0.folder ?? "General" })))
        names.move(fromOffsets: source, toOffset: destination)
        folderOrder = names
        UserDefaults.standard.set(folderOrder, forKey: "mobileFolderOrder")
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
            .sorted {
                let left = queuedPosition($0) ?? $0.position ?? $0.seq
                let right = queuedPosition($1) ?? $1.position ?? $1.seq
                if left != right {
                    return left < right
                }
                return $0.seq < $1.seq
            }
    }

    private func rebuildDisplayEvents() {
        let next = makeDisplayEvents(from: events)
        if displayEvents != next {
            displayEvents = next
        }
    }

    private func makeDisplayEvents(from source: [ZEvent]) -> [ZEvent] {
        var latestDigestStatusIDByJob: [String: String] = [:]
        for event in source where isHandoffDigestStatus(event) {
            if let jobID = event.digest_job_id {
                latestDigestStatusIDByJob[jobID] = event.id
            }
        }
        let assistantRuns = Set(source.compactMap { event -> String? in
            guard event.type == "assistant_text",
                  event.text?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false else {
                return nil
            }
            return event.run_id
        })
        return source.filter { event in
            if isHandoffDigestStatus(event), let jobID = event.digest_job_id {
                return latestDigestStatusIDByJob[jobID] == event.id
            }
            switch event.type {
            case "session_created", "process_started", "provider_session", "raw_event", "cwd_fallback", "turn_queued", "turn_unqueued", "turn_queue_updated", "turn_queue_reordered", "turn_queue_run_now", "turn_stopped":
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

    private func isHandoffDigestStatus(_ event: ZEvent) -> Bool {
        switch event.type {
        case "handoff_digest_started", "handoff_digest_ready", "handoff_digest_sent", "handoff_digest_error":
            return true
        default:
            return false
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
            syncServerReadState(sessionID: sessionID, seq: latestSeq)
        }
        unreadAgentSessionIDs.remove(sessionID)
        manuallyUnreadSessionIDs.remove(sessionID)
    }

    func markSessionUnread(_ sessionID: String?) {
        guard let sessionID, let latestSeq = latestAgentEventSeq(for: sessionID) else { return }
        setLastReadAgentSeq(max(0, latestSeq - 1), for: sessionID, allowDecrease: true)
        syncServerUnreadState(sessionID: sessionID)
        unreadAgentSessionIDs.insert(sessionID)
        manuallyUnreadSessionIDs.insert(sessionID)
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

    private var readStateDefaultsKey: String {
        "ZenithDock.lastReadAgentSeq.\(serverCacheNamespace)"
    }

    private var draftPromptsDefaultsKey: String {
        "ZenithDock.composerDrafts.\(serverCacheNamespace)"
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
        let key = draftPromptsDefaultsKey
        let snapshot = draftPromptsBySessionID
        pendingDraftSave = Task { @MainActor in
            try? await Task.sleep(nanoseconds: 450_000_000)
            guard !Task.isCancelled else { return }
            if let data = try? JSONEncoder().encode(snapshot) {
                UserDefaults.standard.set(data, forKey: key)
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

    func clearUploadsIfCurrent(fileIDs: [String], for sessionID: String?) {
        guard selectedSessionID == sessionID else { return }
        guard uploads.map(\.id) == fileIDs else { return }
        uploads = []
    }

    private func setLastReadAgentSeq(_ seq: Int, for sessionID: String, allowDecrease: Bool = false) {
        guard allowDecrease || seq > (lastReadAgentSeqBySessionID[sessionID] ?? 0) else { return }
        lastReadAgentSeqBySessionID[sessionID] = seq
        saveReadState()
    }

    private func adoptServerReadCursor(_ seq: Int, for sessionID: String) {
        if let pending = pendingReadSyncBySessionID[sessionID], pending > seq {
            return
        }
        setLastReadAgentSeq(seq, for: sessionID, allowDecrease: true)
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
                    _ = self.pendingReadSyncBySessionID.removeValue(forKey: sessionID)
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
                return
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

        for session in sessions {
            guard let latestSeq = session.latest_agent_event_seq else { continue }
            let serverManualUnread = session.manual_unread == true
            if let serverReadSeq = session.last_read_agent_event_seq {
                adoptServerReadCursor(serverReadSeq, for: session.id)
            }
            if serverManualUnread, session.id != selectedSessionID {
                manuallyUnreadSessionIDs.insert(session.id)
            }
            if session.id == selectedSessionID {
                markSessionRead(session.id)
                continue
            }
            let lastReadSeq = lastReadAgentSeqBySessionID[session.id] ?? 0
            if serverManualUnread || latestSeq > lastReadSeq {
                unreadAgentSessionIDs.insert(session.id)
            } else {
                unreadAgentSessionIDs.remove(session.id)
                manuallyUnreadSessionIDs.remove(session.id)
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
        pendingDraftSave?.cancel()
        pendingDraftSave = nil
        webSocket?.cancel(with: .goingAway, reason: nil)
        webSocket = nil
        socketLive = false
        serverReachable = false
        status = "Connecting"
        selectedSessionID = nil
        events = []
        rebuildDisplayEvents()
        uploads = []
        launchDeferredText = nil
        sessions = []
        jobs = []
        omittedHistoryEventCount = 0
        latestSeenSeq = 0
        memoryChatCache = [:]
        memoryChatCacheOrder = []
        serverIdentity = Self.loadServerIdentity(for: effectiveServerAddress)
        lastReadAgentSeqBySessionID = loadReadState()
        draftPromptsBySessionID = loadDraftPrompts()
        unreadAgentSessionIDs = []
        manuallyUnreadSessionIDs = []
        await refresh(showErrors: true)
    }

    private func adoptServerIdentity(_ value: String?) {
        guard let clean = value?.trimmingCharacters(in: .whitespacesAndNewlines),
              !clean.isEmpty else { return }
        let oldNamespace = serverCacheNamespace
        guard serverIdentity != clean else {
            saveServerIdentity(clean, for: effectiveServerAddress)
            return
        }
        serverIdentity = clean
        saveServerIdentity(clean, for: effectiveServerAddress)
        let newNamespace = serverCacheNamespace
        guard oldNamespace != newNamespace else { return }
        migrateLocalServerState(from: oldNamespace, to: newNamespace)
        memoryChatCache = [:]
        memoryChatCacheOrder = []
        lastReadAgentSeqBySessionID = loadReadState()
        draftPromptsBySessionID = loadDraftPrompts()
        unreadAgentSessionIDs = []
        manuallyUnreadSessionIDs = []
    }

    private func migrateLocalServerState(from oldNamespace: String, to newNamespace: String) {
        guard oldNamespace != newNamespace else { return }
        let oldKey = "ZenithDock.lastReadAgentSeq.\(oldNamespace)"
        let newKey = "ZenithDock.lastReadAgentSeq.\(newNamespace)"
        if UserDefaults.standard.data(forKey: newKey) == nil,
           let oldData = UserDefaults.standard.data(forKey: oldKey) {
            UserDefaults.standard.set(oldData, forKey: newKey)
        }
        let oldDraftKey = "ZenithDock.composerDrafts.\(oldNamespace)"
        let newDraftKey = "ZenithDock.composerDrafts.\(newNamespace)"
        if UserDefaults.standard.data(forKey: newDraftKey) == nil,
           let oldData = UserDefaults.standard.data(forKey: oldDraftKey) {
            UserDefaults.standard.set(oldData, forKey: newDraftKey)
        }
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
                let api_contract_version: Int?
                let server_identity: String?
                let default_cwd: String?
                let active: [String]
            }
            let res: Response = try await api.get("/api/health")
            guard isCompatibleAgentAPIContract(res.api_contract_version) else {
                markServerUpgradeRequired(version: res.api_contract_version)
                return
            }
            if serverReachable != res.ok {
                serverReachable = res.ok
            }
            adoptServerIdentity(res.server_identity)
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

    private func isCompatibleAgentAPIContract(_ version: Int?) -> Bool {
        (version ?? 0) >= minimumAgentAPIContractVersion
    }

    private func markServerUpgradeRequired(version: Int?) {
        if serverReachable {
            serverReachable = false
        }
        if socketLive {
            socketLive = false
        }
        activeSessionIDs = []
        syncSelectedRunningState()
        setStatus("Server upgrade required")
        setConnectionDetail("Server upgrade required: app build needs agent API v\(minimumAgentAPIContractVersion), but this server reports v\(version ?? 0). Redeploy/restart the ZenithDock server.")
    }

    func refreshSessions(showErrors: Bool = true) async {
        do {
            struct Response: Codable { let sessions: [ZSession] }
            let res: Response = try await api.get("/api/sessions")
            if sessions != res.sessions {
                sessions = sessionsWithPendingRuntime(res.sessions)
            }
            reconcileUnreadFromSessions()
            if let selectedSessionID, !sessions.contains(where: { $0.id == selectedSessionID }) {
                clearSelection()
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
    func updateSelected(backend: String? = nil, model: String? = nil, effort: String? = nil, folder: String? = nil, title: String? = nil, cwd: String? = nil, pinned: Bool? = nil, archived: Bool? = nil, applyOptimistic: Bool = true) async -> Bool {
        guard let sid = selectedSessionID else { return false }
        return await updateSession(sid, folder: folder, title: title, cwd: cwd, backend: backend, model: model, effort: effort, pinned: pinned, archived: archived, applyOptimistic: applyOptimistic)
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
            report(error)
            return false
        }
    }

    func stageSelectedRuntime(backend: String? = nil, model: String? = nil, effort: String? = nil) {
        guard let sid = selectedSessionID else { return }
        markPendingRuntime(sessionID: sid, backend: backend, model: model, effort: effort)
        applyOptimisticSessionPatch(sessionID: sid, backend: backend, model: model, effort: effort)
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
        sessions[idx] = sessionWithPendingRuntime(session)
    }

    private func sessionsWithPendingRuntime(_ incoming: [ZSession]) -> [ZSession] {
        incoming.map(sessionWithPendingRuntime)
    }

    private func sessionWithPendingRuntime(_ session: ZSession) -> ZSession {
        guard var pending = pendingRuntimeBySessionID[session.id] else { return session }
        if pending.isExpired() {
            pendingRuntimeBySessionID[session.id] = nil
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
            clearDraftPrompt(for: session.id)
            sessions.removeAll { $0.id == session.id }
            jobs.removeAll { $0.session_id == session.id }
            activeSessionIDs.remove(session.id)
            forgetMemoryChatCache(session.id)
            if selectedSessionID == session.id {
                clearSelection()
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
            report(error)
            return nil
        }
    }

    @discardableResult
    func sendPrompt(to sessionID: String, prompt submittedPrompt: String, fileIDs: [String] = []) async -> Bool {
        let trimmed = submittedPrompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
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
            let session: ZSession
        }
        activeSessionIDs.insert(sessionID)
        if sessionID == selectedSessionID {
            syncSelectedRunningState()
            scrollRevision += 1
        }
        do {
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
            launchDeferredText = nil
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
            return res.ok
        } catch {
            report(error)
            return false
        }
    }

    func select(sessionID: String) async {
        if loadingSessionID == sessionID {
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
            rebuildDisplayEvents()
            uploads = []
            sessionFiles = []
            omittedHistoryEventCount = 0
            latestSeenSeq = 0
        }

        selectedSessionID = sessionID
        markSessionRead(sessionID)
        syncSelectedRunningState()

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
            replaceSessionFromServer(res.session)
            applySessionEventSnapshot(res, sessionID: sessionID)
            markSessionRead(sessionID)
            refreshSessionFilesFromLoadedEvents()
            isLoading = false
            rememberSelectedChat()
            Task { await loadSessionFiles(sessionID: sessionID, generation: generation) }
            connectEvents(sessionID: sessionID, after: lastSeq)
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
            replaceSessionFromServer(res.session)
            let existingIDs = Set(events.map(\.id))
            let older = timelineEvents(from: res.events).filter { !existingIDs.contains($0.id) }
            events = (older + events).sorted { $0.seq < $1.seq }
            omittedHistoryEventCount = res.events_omitted_before ?? 0
            latestSeenSeq = max(latestSeenSeq, events.map(\.seq).max() ?? 0)
            refreshSessionFilesFromLoadedEvents()
            rebuildDisplayEvents()
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
        let runtimeModel = selectedSession?.model ?? ""
        let runtimeEffort = selectedSession?.effort ?? ""
        struct Body: Codable {
            let prompt: String
            let file_ids: [String]
            let model: String
            let effort: String
        }
        if submittedPrompt == nil {
            prompt = ""
        }
        activeSessionIDs.insert(sid)
        syncSelectedRunningState()
        scrollRevision += 1
        do {
            struct Response: Codable {
                let run_id: String?
                let queued: Bool?
                let session: ZSession
            }
            let body = Body(
                prompt: trimmed,
                file_ids: uploads.map(\.id),
                model: runtimeModel,
                effort: runtimeEffort
            )
            let res: Response = try await api.post("/api/sessions/\(sid)/turns", body: body)
            replaceSessionFromServer(res.session)
            launchDeferredText = nil
            uploads = []
            clearSubmittedPromptIfCurrent(submittedPrompt: submittedPrompt, trimmed: trimmed)
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
            events.removeAll { $0.type == "turn_queued" && $0.queued_id == queuedID }
            rebuildDisplayEvents()
            rememberSelectedChat()
        } catch {
            if handleStaleQueuedTurn(queuedID, error: error) { return }
            report(error)
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
            rememberSelectedChat()
        } catch {
            if handleStaleQueuedTurn(queuedID, error: error) { return }
            report(error)
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
            rememberSelectedChat()
        } catch {
            if handleStaleQueuedTurn(queuedID, error: error) { return }
            report(error)
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
            rebuildDisplayEvents()
            activeSessionIDs.insert(event.session_id)
            syncSelectedRunningState()
        } catch {
            if handleStaleQueuedTurn(queuedID, error: error) { return }
            report(error)
        }
    }

    private func handleStaleQueuedTurn(_ queuedID: String, error: Error) -> Bool {
        guard isQueuedTurnNotFound(error) else { return false }
        events.removeAll { $0.type == "turn_queued" && $0.queued_id == queuedID }
        rebuildDisplayEvents()
        rememberSelectedChat()
        return true
    }

    private func isQueuedTurnNotFound(_ error: Error) -> Bool {
        (apiErrorDetail(error) ?? error.localizedDescription).localizedCaseInsensitiveContains("queued turn not found")
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
            let res: Response = try await api.post("/api/jobs", body: Body(
                session_id: sid,
                title: cleanTitle.isEmpty ? "\(loop ? "Loop" : "Job"): \(selectedSession?.title ?? "Chat")" : cleanTitle,
                prompt: cleanPrompt,
                interval_seconds: max(10, intervalSeconds),
                first_run_at: firstRunAt.map(serverTimestamp),
                loop: loop,
                max_runs: loop ? nil : max(1, maxRuns ?? 1),
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
            report(error)
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

    func promptFiles(for event: ZEvent) -> [ZFile] {
        guard let fileIDs = event.file_ids, !fileIDs.isEmpty else { return [] }
        let knownFiles = mergedFiles(sessionFiles + uploads + files(from: events))
        let filesByID = Dictionary(uniqueKeysWithValues: knownFiles.map { ($0.id, $0) })
        return fileIDs.compactMap { filesByID[$0] }
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
        rebuildDisplayEvents()
        updateRunningState(from: event)
        if isAgentVisibleMessage(event) {
            setLastReadAgentSeq(event.seq, for: event.session_id)
            syncServerReadState(sessionID: event.session_id, seq: event.seq)
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

    private func clearSelection() {
        webSocket?.cancel(with: .goingAway, reason: nil)
        webSocket = nil
        selectedSessionID = nil
        events = []
        rebuildDisplayEvents()
        uploads = []
        sessionFiles = []
        omittedHistoryEventCount = 0
        latestSeenSeq = 0
        socketLive = false
        processSnapshot = nil
        processLogTail = nil
        syncSelectedRunningState()
    }

    private func timelineEvents(from source: [ZEvent]) -> [ZEvent] {
        source.filter { $0.type != "raw_event" }
    }

    private func mergeEvents(_ incoming: [ZEvent]) {
        guard !incoming.isEmpty else { return }
        let existingIDs = Set(events.map(\.id))
        let incomingEvents = timelineEvents(from: incoming)
        let newEvents = incomingEvents.filter { !existingIDs.contains($0.id) }
        guard !newEvents.isEmpty else { return }
        events.append(contentsOf: newEvents)
        events.sort { $0.seq < $1.seq }
        latestSeenSeq = max(latestSeenSeq, incomingEvents.map(\.seq).max() ?? 0)
        refreshSessionFilesFromLoadedEvents()
        rebuildDisplayEvents()
    }

    private func applySessionEventSnapshot(_ response: SessionEventsResponse, sessionID: String) {
        replaceSessionFromServer(response.session)
        events = timelineEvents(from: response.events)
        omittedHistoryEventCount = response.events_omitted_before ?? 0
        latestSeenSeq = max(response.latest_seq ?? 0, events.map(\.seq).max() ?? 0)
        refreshSessionFilesFromLoadedEvents()
        rebuildDisplayEvents()
    }

    private func addPendingUpload(_ file: ZFile) {
        guard !uploads.contains(where: { $0.id == file.id }) else { return }
        uploads.append(file)
    }

    private func applyCachedChat(_ cached: CachedChat) {
        replaceSessionFromServer(cached.session)
        events = timelineEvents(from: cached.events)
        omittedHistoryEventCount = cached.omittedHistoryEventCount
        sessionFiles = mergedFiles(cached.sessionFiles + files(from: events))
        refreshSessionFilesFromLoadedEvents()
        latestSeenSeq = events.map(\.seq).max() ?? 0
        rebuildDisplayEvents()
    }

    private func refreshSessionFilesFromLoadedEvents() {
        let known = files(from: events)
        guard !known.isEmpty || sessionFiles.isEmpty else { return }
        let nextFiles = mergedFiles(sessionFiles + known)
        if sessionFiles != nextFiles {
            sessionFiles = nextFiles
        }
    }

    private func files(from source: [ZEvent]) -> [ZFile] {
        source.flatMap { event -> [ZFile] in
            [event.file, event.artifact].compactMap { $0 }
        }
    }

    private func upsertSessionFile(_ file: ZFile) {
        let nextFiles = mergedFiles(sessionFiles + [file])
        if sessionFiles != nextFiles {
            sessionFiles = nextFiles
        }
    }

    private func loadSessionFiles(sessionID: String, generation: Int) async {
        do {
            struct Response: Codable { let files: [ZFile] }
            let res: Response = try await api.get("/api/sessions/\(sessionID)/files")
            guard selectedSessionID == sessionID, selectionGeneration == generation else { return }
            let nextFiles = mergedFiles(res.files + files(from: events))
            if sessionFiles != nextFiles {
                sessionFiles = nextFiles
            }
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

    private var serverCacheNamespace: String {
        if let serverIdentity {
            return ZEndpointCache.namespace(serverIdentity: serverIdentity)
        }
        return ZEndpointCache.namespace(serverURL: effectiveServerAddress, default: defaultAgentServerURLString)
    }

    private func chatCacheKey(_ sessionID: String) -> String {
        "\(serverCacheNamespace)|\(sessionID)"
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
        let message = apiErrorDetail(error) ?? error.localizedDescription
        if isAgentLaunchDeferred(error, message: message) {
            launchDeferredText = message
            setStatus("Launch deferred")
            setConnectionDetail(message)
        } else if ns.domain == "ZenithDock.API", ns.code == 401 || ns.code == 403 {
            errorText = "Agent server rejected the access token for \(resolvedServerURLString). Check the token on the server and in this app."
        } else if ns.domain == NSURLErrorDomain {
            errorText = "\(connectionFailureSummary(error)). If Safari works but server logs do not show an app request, enable Local Network for ZenithDock in iOS Settings and make sure Tailscale is active."
        } else {
            errorText = message
        }
    }

    private func isAgentLaunchDeferred(_ error: Error, message: String) -> Bool {
        let ns = error as NSError
        return ns.domain == "ZenithDock.API" &&
            ns.code == 503 &&
            message.localizedCaseInsensitiveContains("agent launch deferred")
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

    private func isCancelledNetworkError(_ error: Error) -> Bool {
        let ns = error as NSError
        return ns.domain == NSURLErrorDomain && ns.code == NSURLErrorCancelled
    }

    private func connectionFailureSummary(_ error: Error) -> String {
        let ns = error as NSError
        if ns.domain == NSURLErrorDomain {
            if ns.code == NSURLErrorAppTransportSecurityRequiresSecureConnection {
                return "iOS App Transport Security blocked HTTP to \(resolvedServerURLString) (-1022). Install the latest ZenithDock build with arbitrary user-entered agent HTTP URLs enabled, or use HTTPS."
            }
            if isLocalNetworkPrivacyError(ns) {
                return "iOS blocked ZenithDock from accessing the local network. Enable ZenithDock in Settings > Privacy & Security > Local Network, or use a reachable Tailscale endpoint."
            }
            return "Cannot reach \(resolvedServerURLString). \(ns.localizedDescription) (\(ns.code))"
        }
        if ns.domain == "ZenithDock.API" {
            return "Server replied \(ns.code) from \(resolvedServerURLString): \(ns.localizedDescription)"
        }
        return error.localizedDescription
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
