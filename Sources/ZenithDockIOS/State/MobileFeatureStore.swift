import Foundation
import SwiftUI
import ZenithCore

struct MobileTimelineNavigationTarget: Identifiable, Equatable, Sendable {
    let sessionID: String
    let eventID: String
    let seq: Int

    var id: String { "\(sessionID):\(eventID):\(seq)" }

    init(sessionID: String, eventID: String, seq: Int) {
        self.sessionID = sessionID
        self.eventID = eventID
        self.seq = seq
    }

    init(searchResult: ZTimelineSearchResult) {
        self.init(
            sessionID: searchResult.session_id,
            eventID: searchResult.event_id,
            seq: searchResult.seq
        )
    }
}

@MainActor
final class MobileFeatureStore: ObservableObject {
    @Published private(set) var historyResults: [ZTimelineSearchResult] = []
    @Published private(set) var isSearchingHistory = false
    @Published private(set) var historySearchError: String?
    @Published private(set) var timelineIndex: ZTimelineIndex?
    @Published private(set) var isLoadingTimelineIndex = false
    @Published private(set) var pinnedItems: [ZPinnedItem] = []

    private var namespace = "default"
    private var searchGeneration = 0
    private var searchTask: Task<Void, Never>?
    private var timelineIndexTask: Task<Void, Never>?

    func configure(namespace newNamespace: String) {
        guard namespace != newNamespace else { return }
        namespace = newNamespace
        loadPins()
        clearHistorySearch()
        timelineIndex = nil
    }

    func scheduleHistorySearch(_ rawQuery: String, api: APIClient) {
        searchTask?.cancel()
        searchGeneration += 1
        let generation = searchGeneration
        let query = rawQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        guard query.count >= 2 else {
            historyResults = []
            historySearchError = nil
            isSearchingHistory = false
            return
        }
        isSearchingHistory = true
        historySearchError = nil
        searchTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(260))
            guard !Task.isCancelled, let self, generation == self.searchGeneration else { return }
            do {
                let response: ZTimelineSearchResponse = try await api.get(
                    "/api/search",
                    queryItems: [
                        URLQueryItem(name: "q", value: query),
                        URLQueryItem(name: "limit", value: "60")
                    ]
                )
                guard !Task.isCancelled, generation == self.searchGeneration else { return }
                self.historyResults = response.results
                self.isSearchingHistory = false
            } catch {
                guard !Task.isCancelled, generation == self.searchGeneration else { return }
                self.historyResults = []
                self.historySearchError = error.localizedDescription
                self.isSearchingHistory = false
            }
        }
    }

    func clearHistorySearch() {
        searchTask?.cancel()
        searchTask = nil
        searchGeneration += 1
        historyResults = []
        historySearchError = nil
        isSearchingHistory = false
    }

    func loadTimelineIndex(sessionID: String, api: APIClient, force: Bool = false) {
        if !force, timelineIndex?.session_id == sessionID { return }
        timelineIndexTask?.cancel()
        isLoadingTimelineIndex = true
        timelineIndexTask = Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                let index: ZTimelineIndex = try await api.get(
                    "/api/sessions/\(sessionID)/timeline-index"
                )
                guard !Task.isCancelled else { return }
                self.timelineIndex = index
                self.isLoadingTimelineIndex = false
            } catch {
                guard !Task.isCancelled else { return }
                self.timelineIndex = nil
                self.isLoadingTimelineIndex = false
            }
        }
    }

    func resetTimelineIndex() {
        timelineIndexTask?.cancel()
        timelineIndexTask = nil
        timelineIndex = nil
        isLoadingTimelineIndex = false
    }

    func pins(for sessionID: String) -> [ZPinnedItem] {
        pinnedItems
            .filter { $0.sessionID == sessionID }
            .sorted { $0.createdAt > $1.createdAt }
    }

    func isMessagePinned(_ eventID: String) -> Bool {
        pinnedItems.contains { $0.id == "message:\(eventID)" }
    }

    func isFilePinned(_ fileID: String) -> Bool {
        pinnedItems.contains { $0.id == "file:\(fileID)" }
    }

    func toggleMessagePin(event: ZEvent, title: String, body: String) {
        let id = "message:\(event.id)"
        if pinnedItems.contains(where: { $0.id == id }) {
            removePin(id)
            return
        }
        pinnedItems.append(ZPinnedItem(
            id: id,
            sessionID: event.session_id,
            kind: .message,
            eventID: event.id,
            eventSeq: event.seq,
            title: title,
            subtitle: mobilePinTimestamp(event.ts),
            body: body
        ))
        savePins()
    }

    func toggleFilePin(_ file: ZFile, fallbackSessionID: String) {
        let id = "file:\(file.id)"
        if pinnedItems.contains(where: { $0.id == id }) {
            removePin(id)
            return
        }
        pinnedItems.append(ZPinnedItem(
            id: id,
            sessionID: file.session_id ?? fallbackSessionID,
            kind: .file,
            eventID: file.event_id,
            eventSeq: file.event_seq,
            fileID: file.id,
            title: file.title ?? file.filename,
            subtitle: file.content_type,
            body: file.text
        ))
        savePins()
    }

    func removePin(_ id: String) {
        guard pinnedItems.contains(where: { $0.id == id }) else { return }
        pinnedItems.removeAll { $0.id == id }
        savePins()
    }

    private func loadPins() {
        guard let data = UserDefaults.standard.data(forKey: pinsKey(namespace)),
              let decoded = try? JSONDecoder().decode([ZPinnedItem].self, from: data) else {
            pinnedItems = []
            return
        }
        pinnedItems = decoded
    }

    private func savePins() {
        guard let data = try? JSONEncoder().encode(pinnedItems) else { return }
        UserDefaults.standard.set(data, forKey: pinsKey(namespace))
    }

    private func pinsKey(_ namespace: String) -> String {
        "AgentsDock.mobilePins.\(namespace)"
    }

    private func mobilePinTimestamp(_ value: String?) -> String? {
        guard let value, !value.isEmpty else { return nil }
        return value
    }
}
