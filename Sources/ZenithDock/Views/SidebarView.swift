import SwiftUI
import UniformTypeIdentifiers
import ZenithCore

struct SidebarView: View {
    @EnvironmentObject private var store: AppStore
    @State private var newFolderOpen = false
    @State private var resumeOpen = false
    @State private var deleteCandidate: ZSession?
    @State private var reorderMode = false

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
                    Button {
                        withAnimation(.snappy(duration: 0.18)) {
                            reorderMode.toggle()
                        }
                    } label: {
                        Label(reorderMode ? "Done" : "Reorder", systemImage: reorderMode ? "checkmark.circle.fill" : "line.3.horizontal")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    .tint(reorderMode ? .accentColor : .secondary)
                    .help(reorderMode ? "Finish reordering chats and folders" : "Drag chats and folders to reorder")
                }
                ConnectionStatusCard()
            }
            .padding(14)

            List(selection: sessionSelection) {
                if !store.pinnedSessions.isEmpty {
                    Section("Pinned") {
                        ForEach(store.pinnedSessions) { session in
                            sessionRow(session)
                        }
                        .onMove { source, destination in
                            moveSessions(store.pinnedSessions, from: source, to: destination)
                        }
                    }
                }
                ForEach(store.folderNames, id: \.self) { folder in
                    Section {
                        if !store.isFolderCollapsed(folder) {
                            ForEach(store.folders[folder] ?? []) { session in
                                sessionRow(session)
                            }
                            .onMove { source, destination in
                                moveSessions(store.folders[folder] ?? [], from: source, to: destination)
                            }
                        }
                    } header: {
                        FolderSectionHeader(
                            folder: folder,
                            reorderMode: reorderMode,
                            dragProvider: dragProvider,
                            onDropFolder: { providers, target in
                                handleFolderDrop(providers, targetFolder: target)
                            }
                        )
                    }
                }
                .onMove { source, destination in
                    store.reorderFolders(from: source, to: destination)
                }
                if !store.archivedSessions.isEmpty {
                    Section {
                        if !store.archivedSectionCollapsed {
                            ForEach(store.archivedSessions) { session in
                                sessionRow(session)
                            }
                            .onMove { source, destination in
                                moveSessions(store.archivedSessions, from: source, to: destination)
                            }
                        }
                    } header: {
                        ArchivedSectionHeader()
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

    private var sessionSelection: Binding<String?> {
        Binding(
            get: { store.selectedSessionID },
            set: { newValue in
                guard let sessionID = newValue,
                      sessionID != store.selectedSessionID else {
                    return
                }
                Task { await store.select(sessionID: sessionID) }
            }
        )
    }

    @ViewBuilder
    private func sessionRow(_ session: ZSession) -> some View {
        SessionRow(session: session)
            .tag(session.id)
            .opacity(reorderMode ? 0.94 : 1)
            .onDrag {
                dragProvider("session:\(session.id)")
            }
            .onDrop(of: [.text], isTargeted: nil) { providers in
                handleSessionDrop(providers, target: session)
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
                Divider()
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

    private func dragProvider(_ payload: String) -> NSItemProvider {
        NSItemProvider(object: payload as NSString)
    }

    private func handleSessionDrop(_ providers: [NSItemProvider], target: ZSession) -> Bool {
        guard reorderMode, let provider = providers.first(where: { $0.canLoadObject(ofClass: NSString.self) }) else {
            return false
        }
        provider.loadObject(ofClass: NSString.self) { object, _ in
            guard let string = object as? String, string.hasPrefix("session:") else { return }
            let sourceID = String(string.dropFirst("session:".count))
            Task { @MainActor in
                await moveSession(sourceID: sourceID, toward: target.id)
            }
        }
        return true
    }

    private func handleFolderDrop(_ providers: [NSItemProvider], targetFolder: String) -> Bool {
        guard reorderMode, let provider = providers.first(where: { $0.canLoadObject(ofClass: NSString.self) }) else {
            return false
        }
        provider.loadObject(ofClass: NSString.self) { object, _ in
            guard let string = object as? String, string.hasPrefix("folder:") else { return }
            let sourceFolder = String(string.dropFirst("folder:".count))
            Task { @MainActor in
                moveFolder(sourceFolder, toward: targetFolder)
            }
        }
        return true
    }

    private func moveFolder(_ source: String, toward target: String) {
        let names = store.folderNames
        guard let sourceIndex = names.firstIndex(of: source),
              let targetIndex = names.firstIndex(of: target),
              sourceIndex != targetIndex else {
            return
        }
        let direction = targetIndex < sourceIndex ? "up" : "down"
        for _ in 0..<abs(targetIndex - sourceIndex) {
            store.moveFolder(source, direction: direction)
        }
    }

    private func moveSession(sourceID: String, toward targetID: String) async {
        guard sourceID != targetID,
              let group = sessionGroup(containing: sourceID, and: targetID),
              let sourceIndex = group.firstIndex(where: { $0.id == sourceID }),
              let targetIndex = group.firstIndex(where: { $0.id == targetID }) else {
            return
        }
        let moving = group[sourceIndex]
        let direction = targetIndex < sourceIndex ? "up" : "down"
        for _ in 0..<abs(targetIndex - sourceIndex) {
            await store.reorderSession(moving, direction: direction)
        }
    }

    private func sessionGroup(containing sourceID: String, and targetID: String) -> [ZSession]? {
        let groups = [store.pinnedSessions, store.archivedSessions] + store.folderNames.map { store.folders[$0] ?? [] }
        return groups.first { group in
            group.contains { $0.id == sourceID } && group.contains { $0.id == targetID }
        }
    }

    private func moveSessions(_ visibleSessions: [ZSession], from source: IndexSet, to destination: Int) {
        guard reorderMode,
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
}

private struct ArchivedSectionHeader: View {
    @EnvironmentObject private var store: AppStore

    var body: some View {
        HStack(spacing: 6) {
            Button {
                store.toggleArchivedSectionCollapsed()
            } label: {
                Image(systemName: store.archivedSectionCollapsed ? "chevron.right" : "chevron.down")
                    .frame(width: 12)
            }
            .buttonStyle(.plain)
            .help(store.archivedSectionCollapsed ? "Expand archived chats" : "Collapse archived chats")

            Text("Archived")
                .font(.caption.weight(.semibold))
            Spacer(minLength: 4)
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

private struct FolderSectionHeader: View {
    @EnvironmentObject private var store: AppStore
    let folder: String
    let reorderMode: Bool
    let dragProvider: (String) -> NSItemProvider
    let onDropFolder: ([NSItemProvider], String) -> Bool

    var body: some View {
        HStack(spacing: 6) {
            if reorderMode {
                Image(systemName: "line.3.horizontal")
                    .foregroundStyle(.secondary)
                    .frame(width: 12)
            }
            Button {
                store.toggleFolderCollapsed(folder)
            } label: {
                Image(systemName: store.isFolderCollapsed(folder) ? "chevron.right" : "chevron.down")
                    .frame(width: 12)
            }
            .buttonStyle(.plain)
            .help(store.isFolderCollapsed(folder) ? "Expand folder" : "Collapse folder")

            Text(folder)
                .font(.caption.weight(.semibold))
            Spacer(minLength: 4)
            if !reorderMode {
                Image(systemName: "line.3.horizontal")
                    .foregroundStyle(.tertiary)
            }
        }
        .textCase(nil)
        .onDrag {
            dragProvider("folder:\(folder)")
        }
        .onDrop(of: [.text], isTargeted: nil) { providers in
            onDropFolder(providers, folder)
        }
        .contextMenu {
            Button {
                store.toggleFolderCollapsed(folder)
            } label: {
                Label(store.isFolderCollapsed(folder) ? "Expand Folder" : "Collapse Folder", systemImage: store.isFolderCollapsed(folder) ? "chevron.right" : "chevron.down")
            }
            Divider()
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
            SessionRowBackendIcon(
                backend: session.backend,
                badgeColor: statusBadgeColor,
                badgeLabel: statusBadgeLabel
            )
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
                }
                Text(rowSubtitle)
                    .font(.caption2)
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

private struct SessionRowBackendIcon: View {
    let backend: String
    let badgeColor: Color?
    let badgeLabel: String

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            BackendLogo(backend: backend)
            if let badgeColor {
                Circle()
                    .fill(badgeColor)
                    .frame(width: 7, height: 7)
                    .overlay(Circle().stroke(Theme.panel, lineWidth: 1.5))
                    .offset(x: 2, y: 1)
                    .accessibilityLabel(badgeLabel)
            }
        }
        .accessibilityLabel(badgeLabel)
    }
}
