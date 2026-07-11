import SwiftUI
import ZenithCore

struct MobileHistoryNavigatorView: View {
    @EnvironmentObject private var store: MobileAppStore
    @EnvironmentObject private var features: MobileFeatureStore
    @Environment(\.dismiss) private var dismiss
    @State private var mode: Mode = .search
    @State private var query = ""
    @State private var results: [ZTimelineSearchResult] = []
    @State private var isSearching = false
    @State private var searchTask: Task<Void, Never>?
    @State private var searchError: String?

    private enum Mode: String, CaseIterable, Identifiable {
        case search = "Search"
        case outline = "Outline"
        var id: String { rawValue }
    }

    var body: some View {
        NavigationStack {
            Group {
                if mode == .search {
                    searchResults
                } else {
                    outline
                }
            }
            .navigationTitle(store.selectedSession?.title ?? "Chat History")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    Picker("History view", selection: $mode) {
                        ForEach(Mode.allCases) { option in
                            Text(option.rawValue).tag(option)
                        }
                    }
                    .pickerStyle(.segmented)
                    .frame(maxWidth: 260)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .searchable(text: $query, isPresented: .constant(mode == .search), prompt: "Search this chat")
        .onChange(of: query) { _, newValue in
            scheduleSearch(newValue)
        }
        .onChange(of: mode) { _, newValue in
            if newValue == .outline, let sessionID = store.selectedSessionID {
                features.loadTimelineIndex(sessionID: sessionID, api: store.api)
            }
        }
        .task(id: store.selectedSessionID) {
            guard let sessionID = store.selectedSessionID else { return }
            features.loadTimelineIndex(sessionID: sessionID, api: store.api)
        }
        .onDisappear {
            searchTask?.cancel()
        }
    }

    private var searchResults: some View {
        List {
            if query.trimmingCharacters(in: .whitespacesAndNewlines).count < 2 {
                ContentUnavailableView(
                    "Search This Chat",
                    systemImage: "magnifyingglass",
                    description: Text("Find messages, job reports, errors, and file names across the complete server history.")
                )
                .listRowBackground(Color.clear)
            } else if isSearching {
                HStack(spacing: 9) {
                    ProgressView()
                    Text("Searching complete history…")
                        .foregroundStyle(.secondary)
                }
            } else if let searchError {
                ContentUnavailableView("Search Failed", systemImage: "exclamationmark.triangle", description: Text(searchError))
                    .listRowBackground(Color.clear)
            } else if results.isEmpty {
                ContentUnavailableView.search(text: query)
                    .listRowBackground(Color.clear)
            } else {
                ForEach(results) { result in
                    Button {
                        Task {
                            await store.navigate(to: result)
                            dismiss()
                        }
                    } label: {
                        VStack(alignment: .leading, spacing: 5) {
                            HStack(spacing: 7) {
                                Image(systemName: resultRoleIcon(result.role))
                                    .foregroundStyle(result.role == "error" ? Color.red : Color.accentColor)
                                Text(result.role.capitalized)
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(.secondary)
                                Spacer()
                                Text("#\(result.seq)")
                                    .font(.caption2.monospacedDigit())
                                    .foregroundStyle(.tertiary)
                            }
                            Text(result.snippet)
                                .font(.body)
                                .foregroundStyle(.primary)
                                .lineLimit(5)
                        }
                        .padding(.vertical, 4)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .listStyle(.plain)
    }

    private var outline: some View {
        List {
            if features.isLoadingTimelineIndex {
                HStack(spacing: 9) {
                    ProgressView()
                    Text("Building chat outline…")
                        .foregroundStyle(.secondary)
                }
            } else if let index = features.timelineIndex, !index.landmarks.isEmpty {
                Section {
                    ForEach(index.landmarks) { landmark in
                        Button {
                            Task {
                                await store.navigate(sessionID: landmarkSessionID(index), sequence: landmark.start_seq)
                                dismiss()
                            }
                        } label: {
                            MobileTimelineLandmarkRow(landmark: landmark)
                        }
                        .buttonStyle(.plain)
                    }
                } header: {
                    Text("\(index.landmarks.count) turns · \(index.event_count) events")
                }
            } else {
                ContentUnavailableView("No Timeline Yet", systemImage: "list.bullet.rectangle")
                    .listRowBackground(Color.clear)
            }
        }
        .listStyle(.plain)
        .refreshable {
            guard let sessionID = store.selectedSessionID else { return }
            features.loadTimelineIndex(sessionID: sessionID, api: store.api, force: true)
        }
    }

    private func scheduleSearch(_ rawQuery: String) {
        searchTask?.cancel()
        let trimmed = rawQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count >= 2, let sessionID = store.selectedSessionID else {
            results = []
            searchError = nil
            isSearching = false
            return
        }
        isSearching = true
        searchError = nil
        let api = store.api
        searchTask = Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(220))
            guard !Task.isCancelled else { return }
            do {
                let response: ZTimelineSearchResponse = try await api.get(
                    "/api/sessions/\(sessionID)/search",
                    queryItems: [
                        URLQueryItem(name: "q", value: trimmed),
                        URLQueryItem(name: "limit", value: "100")
                    ]
                )
                guard !Task.isCancelled, store.selectedSessionID == sessionID else { return }
                results = response.results
                isSearching = false
            } catch {
                guard !Task.isCancelled else { return }
                results = []
                searchError = error.localizedDescription
                isSearching = false
            }
        }
    }

    private func landmarkSessionID(_ index: ZTimelineIndex) -> String {
        index.session_id
    }

    private func resultRoleIcon(_ role: String) -> String {
        switch role {
        case "user": return "person.fill"
        case "assistant": return "sparkles"
        case "job": return "clock"
        case "file": return "paperclip"
        case "trace": return "chevron.left.forwardslash.chevron.right"
        case "error": return "exclamationmark.triangle"
        default: return "text.bubble"
        }
    }
}

private struct MobileTimelineLandmarkRow: View {
    let landmark: ZTimelineLandmark

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: icon)
                .foregroundStyle(tint)
                .frame(width: 22)
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: 4) {
                Text(landmark.title)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(2)
                if !landmark.preview.isEmpty, landmark.preview != landmark.title {
                    Text(landmark.preview)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(3)
                }
                HStack(spacing: 7) {
                    if let meta = landmark.meta, !meta.isEmpty {
                        Text(meta)
                    }
                    Text("#\(landmark.start_seq)")
                }
                .font(.caption2.monospacedDigit())
                .foregroundStyle(.tertiary)
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 4)
        .contentShape(Rectangle())
    }

    private var icon: String {
        switch landmark.kind {
        case "user": return "person.fill"
        case "assistant": return "sparkles"
        case "job": return "clock"
        case "media": return "photo.on.rectangle"
        case "error": return "exclamationmark.triangle"
        case "digest": return "arrowshape.turn.up.right"
        case "trace": return "chevron.left.forwardslash.chevron.right"
        default: return "circle"
        }
    }

    private var tint: Color {
        landmark.kind == "error" ? .red : .accentColor
    }
}
