import SwiftUI
import ZenithCore

struct MobileSidebarView: View {
    @EnvironmentObject private var store: MobileAppStore
    @EnvironmentObject private var features: MobileFeatureStore
    @Binding var resumeOpen: Bool
    @Binding var settingsOpen: Bool
    @State private var deleteCandidate: ZSession?
    @State private var reorderMode = false
    @State private var searchText = ""

    var body: some View {
        List(selection: sessionSelection) {
            Section {
                MobileServerStatusView()
            }

            if !filteredPinnedSessions.isEmpty {
                Section("Pinned") {
                    ForEach(filteredPinnedSessions) { session in
                        sessionRow(session)
                    }
                    .onMove { source, destination in
                        moveSessions(filteredPinnedSessions, from: source, to: destination)
                    }
                }
            }

            ForEach(filteredFolderNames, id: \.self) { folder in
                Section {
                    if isSearching || !store.isFolderCollapsed(folder) {
                        ForEach(filteredSessions(in: folder)) { session in
                            sessionRow(session)
                        }
                        .onMove { source, destination in
                            moveSessions(filteredSessions(in: folder), from: source, to: destination)
                        }
                    }
                } header: {
                    MobileFolderSectionHeader(folder: folder, reorderMode: reorderMode)
                }
            }
            .onMove { source, destination in
                guard !isSearching else { return }
                store.reorderFolders(from: source, to: destination)
            }
            if !filteredArchivedSessions.isEmpty {
                Section {
                    if isSearching || !store.archivedSectionCollapsed {
                        ForEach(filteredArchivedSessions) { session in
                            sessionRow(session)
                        }
                        .onMove { source, destination in
                            moveSessions(filteredArchivedSessions, from: source, to: destination)
                        }
                    }
                } header: {
                    MobileArchivedSectionHeader()
                }
            }
            if isSearching && (features.isSearchingHistory || !features.historyResults.isEmpty || features.historySearchError != nil) {
                Section("Message History") {
                    if features.isSearchingHistory {
                        HStack(spacing: 8) {
                            ProgressView()
                                .controlSize(.small)
                            Text("Searching every chat…")
                                .foregroundStyle(.secondary)
                        }
                    }
                    ForEach(features.historyResults) { result in
                        Button {
                            Task { await store.navigate(to: result) }
                        } label: {
                            MobileHistorySearchResultRow(
                                result: result,
                                sessionTitle: store.sessions.first(where: { $0.id == result.session_id })?.title ?? "Chat"
                            )
                        }
                        .buttonStyle(.plain)
                    }
                    if let error = features.historySearchError {
                        Label(error, systemImage: "exclamationmark.triangle")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            if isSearching && filteredPinnedSessions.isEmpty && filteredFolderNames.isEmpty && filteredArchivedSessions.isEmpty && features.historyResults.isEmpty && !features.isSearchingHistory {
                Text("No chats match “\(normalizedSearchText)”")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .environment(\.editMode, .constant(reorderMode ? .active : .inactive))
        .navigationTitle("AgentsDock")
        .searchable(text: $searchText, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search chats")
        .onChange(of: searchText) { _, _ in
            if isSearching && reorderMode {
                reorderMode = false
            }
            features.scheduleHistorySearch(normalizedSearchText, api: store.api)
        }
        .toolbar {
            ToolbarItem(placement: .navigationBarLeading) {
                Button(reorderMode ? "Done" : "Reorder") {
                    withAnimation(.snappy(duration: 0.18)) {
                        reorderMode.toggle()
                    }
                }
                .disabled(isSearching)
            }
            ToolbarItemGroup(placement: .primaryAction) {
                Button {
                    settingsOpen = true
                } label: {
                    Image(systemName: "gearshape")
                }
                .accessibilityLabel("Settings")
                Button {
                    Task { await store.refresh() }
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                Button {
                    resumeOpen = true
                } label: {
                    Image(systemName: "arrow.uturn.forward.circle")
                }
                Button {
                    Task { await store.createSession() }
                } label: {
                    Image(systemName: "square.and.pencil")
                }
            }
        }
        .alert("Delete Chat?", isPresented: Binding(
            get: { deleteCandidate != nil },
            set: { if !$0 { deleteCandidate = nil } }
        )) {
            Button("Delete Chat", role: .destructive) {
                guard let deleteCandidate else { return }
                Task { await store.deleteSession(deleteCandidate) }
                self.deleteCandidate = nil
            }
            Button("Cancel", role: .cancel) {
                deleteCandidate = nil
            }
        } message: {
            Text(deleteMessage)
        }
    }

    private func moveSessions(_ visibleSessions: [ZSession], from source: IndexSet, to destination: Int) {
        guard reorderMode,
              !isSearching,
              let sourceIndex = source.first,
              source.count == 1,
              visibleSessions.indices.contains(sourceIndex) else {
            return
        }
        let adjustedDestination = destination > sourceIndex ? destination - 1 : destination
        guard visibleSessions.indices.contains(adjustedDestination), adjustedDestination != sourceIndex else {
            return
        }
        let moving = visibleSessions[sourceIndex]
        let direction = adjustedDestination < sourceIndex ? "up" : "down"
        let steps = abs(adjustedDestination - sourceIndex)
        Task {
            for _ in 0..<steps {
                await store.reorderSession(moving, direction: direction)
            }
        }
    }

    private var deleteMessage: String {
        guard let title = deleteCandidate?.title else {
            return "This chat will be removed from ZenithDock."
        }
        return "Delete \"\(title)\" from ZenithDock? This cannot be undone."
    }

    private var sessionSelection: Binding<String?> {
        Binding(
            get: { store.selectedSessionID },
            set: { newValue in
                guard !reorderMode else { return }
                guard let sessionID = newValue,
                      sessionID != store.selectedSessionID else {
                    return
                }
                Task { await store.select(sessionID: sessionID) }
            }
        )
    }

    private var normalizedSearchText: String {
        searchText.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var isSearching: Bool {
        !normalizedSearchText.isEmpty
    }

    private func matchesSearch(_ session: ZSession) -> Bool {
        guard isSearching else { return true }
        let query = normalizedSearchText
        if session.title.localizedCaseInsensitiveContains(query) {
            return true
        }
        if let folder = session.folder, folder.localizedCaseInsensitiveContains(query) {
            return true
        }
        let searchableParts = [
            session.backend,
            session.model,
            session.effort,
            session.cwd,
            session.session_id,
            session.claude_session_id,
            session.codex_thread_id
        ].compactMap { $0 }
        return searchableParts.contains { $0.localizedCaseInsensitiveContains(query) }
    }

    private var filteredPinnedSessions: [ZSession] {
        store.pinnedSessions.filter(matchesSearch)
    }

    private var filteredArchivedSessions: [ZSession] {
        store.archivedSessions.filter(matchesSearch)
    }

    private func filteredSessions(in folder: String) -> [ZSession] {
        let sessions = store.folders[folder] ?? []
        guard isSearching else {
            return sessions
        }
        return sessions.filter(matchesSearch)
    }

    private var filteredFolderNames: [String] {
        store.folderNames.filter { folder in
            if !isSearching {
                return true
            }
            if folder.localizedCaseInsensitiveContains(normalizedSearchText) {
                return true
            }
            return !filteredSessions(in: folder).isEmpty
        }
    }

    private func sessionRow(_ session: ZSession) -> some View {
        MobileSessionRow(session: session)
            .tag(session.id)
            .swipeActions(edge: .leading, allowsFullSwipe: true) {
                if session.archived == true {
                    Button {
                        Task { await store.toggleArchive(session) }
                    } label: {
                        Label("Unarchive", systemImage: "archivebox")
                    }
                    .tint(.gray)
                } else {
                    Button {
                        Task { await store.togglePin(session) }
                    } label: {
                        Label(session.pinned == true ? "Unpin" : "Pin", systemImage: session.pinned == true ? "pin.slash" : "pin")
                    }
                    .tint(.blue)
                }
            }
            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                if session.archived != true {
                    Button {
                        Task { await store.toggleArchive(session) }
                    } label: {
                        Label("Archive", systemImage: "archivebox")
                    }
                    .tint(.gray)
                }
                Button(role: .destructive) {
                    deleteCandidate = session
                } label: {
                    Label("Delete", systemImage: "trash")
                }
            }
            .contextMenu {
                Button {
                    store.toggleSessionUnread(session)
                } label: {
                    Label(
                        store.unreadAgentSessionIDs.contains(session.id) ? "Mark as Read" : "Mark as Unread",
                        systemImage: store.unreadAgentSessionIDs.contains(session.id) ? "envelope.open" : "envelope.badge"
                    )
                }
                .disabled(!store.unreadAgentSessionIDs.contains(session.id) && !store.canMarkSessionUnread(session))
                Divider()
                Button {
                    Task { await store.fork(session) }
                } label: {
                    Label("Fork Chat", systemImage: "arrow.triangle.branch")
                }
                Divider()
                Button {
                    Task { await store.reorderSession(session, direction: "up") }
                } label: {
                    Label("Move Up", systemImage: "arrow.up")
                }
                Button {
                    Task { await store.reorderSession(session, direction: "down") }
                } label: {
                    Label("Move Down", systemImage: "arrow.down")
                }
                if session.archived == true {
                    Button {
                        Task { await store.toggleArchive(session) }
                    } label: {
                        Label("Unarchive Chat", systemImage: "archivebox")
                    }
                } else {
                    Button {
                        Task { await store.togglePin(session) }
                    } label: {
                        Label(session.pinned == true ? "Unpin Chat" : "Pin Chat", systemImage: session.pinned == true ? "pin.slash" : "pin")
                    }
                    Menu("Move to Folder") {
                        ForEach(store.folderNames, id: \.self) { folder in
                            Button(folder) {
                                Task { await store.moveSession(session, to: folder) }
                            }
                        }
                    }
                    Button {
                        Task { await store.toggleArchive(session) }
                    } label: {
                        Label("Archive Chat", systemImage: "archivebox")
                    }
                }
                Button(role: .destructive) {
                    deleteCandidate = session
                } label: {
                    Label("Delete Chat", systemImage: "trash")
                }
            }
    }
}

private struct MobileHistorySearchResultRow: View {
    let result: ZTimelineSearchResult
    let sessionTitle: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 7) {
                Image(systemName: roleIcon)
                    .foregroundStyle(roleTint)
                    .frame(width: 16)
                Text(sessionTitle)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                Spacer(minLength: 4)
                if let count = result.match_count, count > 1 {
                    Text("\(count) matches")
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(.tertiary)
                }
            }
            Text(result.snippet)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(3)
            if let timestamp = result.ts {
                Text(searchTimestamp(timestamp))
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(.vertical, 4)
        .contentShape(Rectangle())
        .accessibilityLabel("\(sessionTitle), \(result.snippet)")
    }

    private var roleIcon: String {
        switch result.role {
        case "user": return "person.fill"
        case "assistant": return "sparkles"
        case "file": return "paperclip"
        case "job": return "clock"
        case "error": return "exclamationmark.triangle"
        case "trace": return "chevron.left.forwardslash.chevron.right"
        default: return "text.bubble"
        }
    }

    private var roleTint: Color {
        result.role == "error" ? .red : .accentColor
    }

    private func searchTimestamp(_ value: String) -> String {
        guard let date = parseMobileServerDate(value) else { return value }
        return date.formatted(date: .abbreviated, time: .shortened)
    }
}

private struct MobileArchivedSectionHeader: View {
    @EnvironmentObject private var store: MobileAppStore

    var body: some View {
        HStack(spacing: 8) {
            Button {
                store.toggleArchivedSectionCollapsed()
            } label: {
                Image(systemName: store.archivedSectionCollapsed ? "chevron.right" : "chevron.down")
            }
            .buttonStyle(.plain)

            Text("Archived")
                .font(.caption.weight(.semibold))
            Spacer()
        }
        .textCase(nil)
        .contextMenu {
            Button {
                store.toggleArchivedSectionCollapsed()
            } label: {
                Label(
                    store.archivedSectionCollapsed ? "Expand Archived" : "Collapse Archived",
                    systemImage: store.archivedSectionCollapsed ? "chevron.right" : "chevron.down"
                )
            }
        }
    }
}

private struct MobileFolderSectionHeader: View {
    @EnvironmentObject private var store: MobileAppStore
    let folder: String
    let reorderMode: Bool

    var body: some View {
        HStack(spacing: 8) {
            if reorderMode {
                Image(systemName: "line.3.horizontal")
                    .foregroundStyle(.secondary)
            }
            Button {
                store.toggleFolderCollapsed(folder)
            } label: {
                Image(systemName: store.isFolderCollapsed(folder) ? "chevron.right" : "chevron.down")
            }
            .buttonStyle(.plain)

            Text(folder)
                .font(.caption.weight(.semibold))
            Spacer()
            if !reorderMode {
                Menu {
                    Button {
                        store.moveFolder(folder, direction: "up")
                    } label: {
                        Label("Move Folder Up", systemImage: "arrow.up")
                    }
                    Button {
                        store.moveFolder(folder, direction: "down")
                    } label: {
                        Label("Move Folder Down", systemImage: "arrow.down")
                    }
                    Divider()
                    Button {
                        store.toggleFolderCollapsed(folder)
                    } label: {
                        Label(store.isFolderCollapsed(folder) ? "Expand Folder" : "Collapse Folder", systemImage: store.isFolderCollapsed(folder) ? "chevron.right" : "chevron.down")
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
                .buttonStyle(.plain)
            }
        }
        .textCase(nil)
    }
}

private struct MobileServerStatusView: View {
    @EnvironmentObject private var store: MobileAppStore
    @State private var draftHost = ""
    @State private var draftPort = ""
    @State private var draftToken = ""
    @FocusState private var focusedField: FocusedField?

    private enum FocusedField: Hashable {
        case host
        case port
        case token
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                Circle()
                    .fill(store.serverReachable ? .green : .red)
                    .frame(width: 10, height: 10)
                Text(store.serverReachable ? "Server online" : "Server offline")
                    .font(.subheadline.weight(.semibold))
                Spacer()
                if !store.activeSessionIDs.isEmpty {
                    Label("\(store.activeSessionIDs.count)", systemImage: "dot.radiowaves.left.and.right")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                }
            }
            HStack(spacing: 8) {
                TextField("Host", text: $draftHost)
                    .font(.caption.monospaced())
                    .mobileURLInputStyle()
                    .focused($focusedField, equals: .host)
                    .onSubmit { commitAndReconnect() }
                TextField("Port", text: $draftPort)
                    .font(.caption.monospaced())
                    .frame(width: 68)
                    .mobilePortInputStyle()
                    .focused($focusedField, equals: .port)
                    .onSubmit { commitAndReconnect() }
            }
            Text(store.connectionDetail)
                .font(.caption2.monospaced())
                .foregroundStyle(.secondary)
                .lineLimit(3)
                .textSelection(.enabled)
            SecureField("Access token", text: $draftToken)
                .font(.caption.monospaced())
                .mobileTokenInputStyle()
                .focused($focusedField, equals: .token)
                .onSubmit { commitAndReconnect() }
            Button {
                commitAndReconnect()
            } label: {
                Label("Reconnect", systemImage: "arrow.clockwise")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
        }
        .padding(.vertical, 4)
        .onAppear { syncDraftsFromStore() }
        .onChange(of: focusedField) { oldValue, newValue in
            if oldValue != nil, newValue == nil {
                commitDrafts()
            }
        }
        .onChange(of: store.serverHost) { _, newValue in
            if focusedField != .host {
                draftHost = newValue
            }
        }
        .onChange(of: store.serverPort) { _, newValue in
            if focusedField != .port {
                draftPort = newValue
            }
        }
        .onChange(of: store.accessToken) { _, newValue in
            if focusedField != .token {
                draftToken = newValue
            }
        }
    }

    private func commitDrafts() {
        store.updateServerAddress(host: draftHost, port: draftPort)
        if store.accessToken != draftToken {
            store.accessToken = draftToken
            store.rememberAccessToken()
        }
        if focusedField != .host {
            draftHost = store.serverHost
        }
        if focusedField != .port {
            draftPort = store.serverPort
        }
    }

    private func commitAndReconnect() {
        focusedField = nil
        commitDrafts()
        Task { await store.reconnect() }
    }

    private func syncDraftsFromStore() {
        draftHost = store.serverHost
        draftPort = store.serverPort
        draftToken = store.accessToken
    }
}

private extension View {
    @ViewBuilder
    func mobileURLInputStyle() -> some View {
        #if os(iOS)
        self
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .keyboardType(.URL)
        #else
        self
        #endif
    }

    @ViewBuilder
    func mobileTokenInputStyle() -> some View {
        #if os(iOS)
        self
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
        #else
        self
        #endif
    }


    
    func mobilePortInputStyle() -> some View {
        #if os(iOS)
        self
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .keyboardType(.numbersAndPunctuation)
        #else
        self
        #endif
    }
}

private struct MobileSessionRow: View {
    @EnvironmentObject private var store: MobileAppStore
    let session: ZSession

    var body: some View {
        let hasUnread = store.unreadAgentSessionIDs.contains(session.id)
        HStack(spacing: 10) {
            MobileSessionRowBackendIcon(
                backend: session.backend,
                badgeColor: statusBadgeColor,
                badgeLabel: statusBadgeLabel
            )
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 5) {
                    Text(session.title)
                        .fontWeight(hasUnread ? .semibold : .regular)
                        .lineLimit(1)
                    if session.archived == true {
                        Image(systemName: "archivebox")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(.tertiary)
                            .accessibilityLabel("Archived")
                    }
                }
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(hasUnread ? Color.accentColor : .secondary)
                    .lineLimit(1)
            }
        }
        .padding(.vertical, 2)
    }

    private var statusBadgeColor: Color? {
        if store.unreadAgentSessionIDs.contains(session.id) {
            return Color.accentColor
        }
        if store.activeSessionIDs.contains(session.id) {
            return .green
        }
        return nil
    }

    private var statusBadgeLabel: String {
        if store.unreadAgentSessionIDs.contains(session.id) {
            return "Unread agent message"
        }
        if store.activeSessionIDs.contains(session.id) {
            return "Running"
        }
        return session.backend.capitalized
    }

    private var subtitle: String {
        var pieces = [
            session.backend.capitalized,
            store.runtimeCatalog.modelLabel(session.model, backend: session.backend)
        ]
        if store.activeSessionIDs.contains(session.id) {
            pieces.append("running")
        } else if store.unreadAgentSessionIDs.contains(session.id) {
            pieces.append("new agent message")
        } else if let effort = session.effort, !effort.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            pieces.append(store.runtimeCatalog.effortLabel(effort, backend: session.backend))
        }
        return pieces.joined(separator: " · ")
    }
}

private struct MobileSessionRowBackendIcon: View {
    let backend: String
    let badgeColor: Color?
    let badgeLabel: String

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            MobileBackendLogo(backend: backend)
            if let badgeColor {
                Circle()
                    .fill(badgeColor)
                    .frame(width: 7, height: 7)
                    .overlay(Circle().stroke(.background, lineWidth: 1.5))
                    .offset(x: 2, y: 1)
                    .accessibilityLabel(badgeLabel)
            }
        }
        .accessibilityLabel(badgeLabel)
    }
}
