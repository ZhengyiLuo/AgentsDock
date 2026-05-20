import SwiftUI
import ZenithCore

struct SidebarView: View {
    @EnvironmentObject private var store: AppStore
    @State private var newFolderOpen = false
    @State private var resumeOpen = false
    @State private var deleteCandidate: ZSession?

    var body: some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Zenith Dock")
                            .font(.headline)
                        Text(store.serverURLString)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    Spacer()
                }
                HStack(spacing: 8) {
                    Button {
                        Task { await store.createSession() }
                    } label: {
                        Label("New Chat", systemImage: "plus")
                            .frame(maxWidth: .infinity)
                    }
                    .help("Start a new empty chat")

                    Button {
                        resumeOpen = true
                    } label: {
                        Label("Resume ID", systemImage: "arrow.uturn.forward.circle")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .help("Resume Claude or Codex by ID")
                }
                HStack {
                    Button {
                        newFolderOpen = true
                    } label: {
                        Label("Create Folder", systemImage: "folder.badge.plus")
                            .frame(maxWidth: .infinity)
                    }
                    .help("Create a folder")
                }
                ConnectionStatusCard()
            }
            .padding(14)

            List(selection: $store.selectedSessionID) {
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
            .listStyle(.sidebar)
            .scrollContentBackground(.hidden)
            .background(Theme.panel)

            HStack(spacing: 8) {
                Label("\(store.sessions.count) loaded", systemImage: "bubble.left.and.bubble.right")
                Spacer()
                Label("\(store.activeSessionIDs.count) active", systemImage: "dot.radiowaves.left.and.right")
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            .padding(.horizontal)
            .padding(.vertical, 10)
            .background(Theme.panel)
        }
        .background(Theme.panel)
        .sheet(isPresented: $newFolderOpen) {
            NewFolderSheet(isPresented: $newFolderOpen)
                .environmentObject(store)
        }
        .sheet(isPresented: $resumeOpen) {
            ResumeSessionSheet(isPresented: $resumeOpen)
                .environmentObject(store)
        }
        .confirmationDialog(
            "Delete chat?",
            isPresented: Binding(
                get: { deleteCandidate != nil },
                set: { if !$0 { deleteCandidate = nil } }
            )
        ) {
            Button("Delete", role: .destructive) {
                guard let deleteCandidate else { return }
                Task { await store.deleteSession(deleteCandidate) }
                self.deleteCandidate = nil
            }
            Button("Cancel", role: .cancel) {
                deleteCandidate = nil
            }
        } message: {
            Text(deleteCandidate?.title ?? "This chat will be removed from Zenith Dock.")
        }
    }

    @ViewBuilder
    private func sessionRow(_ session: ZSession) -> some View {
        SessionRow(session: session)
            .tag(session.id)
            .contextMenu {
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
                Divider()
                Button(role: .destructive) {
                    deleteCandidate = session
                } label: {
                    Label("Delete Chat", systemImage: "trash")
                }
            }
    }
}

struct ConnectionStatusCard: View {
    @EnvironmentObject private var store: AppStore

    var body: some View {
        HStack(alignment: .center, spacing: 10) {
            Circle()
                .fill(store.serverReachable ? Color.green : Color.red)
                .frame(width: 10, height: 10)
                .shadow(color: (store.serverReachable ? Color.green : Color.red).opacity(0.45), radius: 5)
            VStack(alignment: .leading, spacing: 2) {
                Text(store.serverReachable ? "Server online" : "Server offline")
                    .font(.caption.weight(.semibold))
                Text(store.connectionSubtitle)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            Spacer(minLength: 0)
        }
        .padding(10)
        .background(Theme.card)
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.softLine))
    }
}

struct SessionRow: View {
    @EnvironmentObject private var store: AppStore
    let session: ZSession

    var body: some View {
        let hasUnread = store.unreadAgentSessionIDs.contains(session.id)
        HStack(spacing: 10) {
            ZStack(alignment: .bottomTrailing) {
                Image(systemName: Theme.backendIconName(session.backend))
                    .foregroundStyle(Theme.backendTint(session.backend))
                    .fontWeight(hasUnread ? .bold : .regular)
                if store.activeSessionIDs.contains(session.id) {
                    Circle()
                        .fill(Color.green)
                        .frame(width: 7, height: 7)
                        .offset(x: 3, y: 2)
                }
                if hasUnread {
                    Circle()
                        .fill(Color.accentColor)
                        .frame(width: 8, height: 8)
                        .overlay(Circle().stroke(Theme.panel, lineWidth: 1.5))
                        .offset(x: 4, y: -11)
                }
            }
            VStack(alignment: .leading, spacing: 2) {
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
                Text(rowSubtitle)
                    .font(.caption2)
                    .foregroundStyle(hasUnread ? Color.accentColor : .secondary)
                    .lineLimit(1)
            }
        }
        .padding(.vertical, 2)
    }

    private var rowSubtitle: String {
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
