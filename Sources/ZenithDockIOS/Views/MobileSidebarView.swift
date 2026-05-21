import SwiftUI
import ZenithCore

struct MobileSidebarView: View {
    @EnvironmentObject private var store: MobileAppStore
    @Binding var resumeOpen: Bool
    @State private var deleteCandidate: ZSession?

    var body: some View {
        List(selection: $store.selectedSessionID) {
            Section {
                MobileServerStatusView()
            }

            if !store.pinnedSessions.isEmpty {
                Section("Pinned") {
                    ForEach(store.pinnedSessions) { session in
                        sessionRow(session)
                    }
                }
            }

            ForEach(store.folders.keys.sorted(), id: \.self) { folder in
                Section(folder) {
                    ForEach(store.folders[folder] ?? []) { session in
                        sessionRow(session)
                    }
                }
            }
            if !store.archivedSessions.isEmpty {
                Section("Archived") {
                    ForEach(store.archivedSessions) { session in
                        sessionRow(session)
                    }
                }
            }
        }
        .navigationTitle("ZenithDock")
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
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

    private var deleteMessage: String {
        guard let title = deleteCandidate?.title else {
            return "This chat will be removed from ZenithDock."
        }
        return "Delete \"\(title)\" from ZenithDock? This cannot be undone."
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
            ZStack(alignment: .bottomTrailing) {
                MobileBackendLogo(backend: session.backend)
                    .scaleEffect(hasUnread ? 1.08 : 1)
                if store.activeSessionIDs.contains(session.id) {
                    Circle()
                        .fill(.green)
                        .frame(width: 7, height: 7)
                        .offset(x: 3, y: 2)
                }
                if hasUnread {
                    Circle()
                        .fill(Color.accentColor)
                        .frame(width: 8, height: 8)
                        .overlay(Circle().stroke(.background, lineWidth: 1.5))
                        .offset(x: 4, y: -11)
                }
            }
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
                    if hasUnread {
                        Image(systemName: "circle.fill")
                            .font(.system(size: 6, weight: .bold))
                            .foregroundStyle(Color.accentColor)
                            .accessibilityLabel("Unread agent message")
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

    private var subtitle: String {
        var pieces = [
            session.backend.capitalized,
            store.runtimeCatalog.modelLabel(session.model, backend: session.backend)
        ]
        if store.activeSessionIDs.contains(session.id) {
            pieces.append("running")
        } else if session.archived == true {
            pieces.append("archived")
        } else if store.unreadAgentSessionIDs.contains(session.id) {
            pieces.append("new agent message")
        } else if let effort = session.effort, !effort.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            pieces.append(store.runtimeCatalog.effortLabel(effort, backend: session.backend))
        }
        return pieces.joined(separator: " · ")
    }
}
