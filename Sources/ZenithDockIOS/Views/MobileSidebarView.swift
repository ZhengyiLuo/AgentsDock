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
        .confirmationDialog("Delete chat?", isPresented: Binding(
            get: { deleteCandidate != nil },
            set: { if !$0 { deleteCandidate = nil } }
        )) {
            Button("Delete", role: .destructive) {
                guard let deleteCandidate else { return }
                Task { await store.deleteSession(deleteCandidate) }
                self.deleteCandidate = nil
            }
            Button("Cancel", role: .cancel) {
                deleteCandidate = nil
            }
        } message: {
            Text(deleteCandidate?.title ?? "This chat will be removed from ZenithDock.")
        }
    }

    private func sessionRow(_ session: ZSession) -> some View {
        MobileSessionRow(session: session)
            .tag(session.id)
            .swipeActions(edge: .leading, allowsFullSwipe: true) {
                Button {
                    Task { await store.togglePin(session) }
                } label: {
                    Label(session.pinned == true ? "Unpin" : "Pin", systemImage: session.pinned == true ? "pin.slash" : "pin")
                }
                .tint(.blue)
            }
            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                Button(role: .destructive) {
                    deleteCandidate = session
                } label: {
                    Label("Delete", systemImage: "trash")
                }
            }
            .contextMenu {
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
                TextField("Host", text: $store.serverHost)
                    .font(.caption.monospaced())
                    .mobileURLInputStyle()
                    .onChange(of: store.serverHost) {
                        store.rememberServerURL()
                    }
                    .onSubmit { Task { await store.reconnect() } }
                TextField("Port", text: $store.serverPort)
                    .font(.caption.monospaced())
                    .frame(width: 68)
                    .mobilePortInputStyle()
                    .onChange(of: store.serverPort) {
                        store.rememberServerURL()
                    }
                    .onSubmit { Task { await store.reconnect() } }
            }
            Text(store.connectionDetail)
                .font(.caption2.monospaced())
                .foregroundStyle(.secondary)
                .lineLimit(3)
                .textSelection(.enabled)
            SecureField("Access token", text: $store.accessToken)
                .font(.caption.monospaced())
                .mobileTokenInputStyle()
                .onChange(of: store.accessToken) {
                    store.rememberAccessToken()
                }
                .onSubmit { Task { await store.reconnect() } }
            Button {
                Task { await store.reconnect() }
            } label: {
                Label("Reconnect", systemImage: "arrow.clockwise")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
        }
        .padding(.vertical, 4)
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
        HStack(spacing: 10) {
            ZStack(alignment: .bottomTrailing) {
                Image(systemName: session.backend == "codex" ? "sparkle.magnifyingglass" : "circle.hexagongrid")
                    .foregroundStyle(session.backend == "codex" ? .orange : .blue)
                if store.activeSessionIDs.contains(session.id) {
                    Circle()
                        .fill(.green)
                        .frame(width: 7, height: 7)
                        .offset(x: 3, y: 2)
                }
            }
            VStack(alignment: .leading, spacing: 3) {
                Text(session.title)
                    .lineLimit(1)
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .padding(.vertical, 2)
    }

    private var subtitle: String {
        var pieces = [session.backend.capitalized]
        if store.activeSessionIDs.contains(session.id) {
            pieces.append("running")
        } else if let folder = session.folder, !folder.isEmpty {
            pieces.append(folder)
        }
        return pieces.joined(separator: " · ")
    }
}
