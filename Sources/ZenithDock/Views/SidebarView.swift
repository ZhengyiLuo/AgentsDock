import SwiftUI
import UniformTypeIdentifiers
import ZenithCore

#if os(macOS)
import AppKit
#endif

struct SidebarView: View {
    @EnvironmentObject private var store: AppStore
    @State private var newFolderOpen = false
    @State private var resumeOpen = false
    @State private var deleteCandidate: ZSession?
    @State private var reorderMode = false
    @State private var sidebarDragPayload: SidebarDragPayload?
    @State private var sidebarDropTarget: SidebarDropTarget?

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
                        withoutSidebarAnimation {
                            reorderMode.toggle()
                            clearSidebarDragState()
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
                    }
                }
                ForEach(store.folderNames, id: \.self) { folder in
                    Section {
                        if !store.isFolderCollapsed(folder) {
                            ForEach(store.folders[folder] ?? []) { session in
                                sessionRow(session)
                            }
                        }
                    } header: {
                        FolderSectionHeader(
                            folder: folder,
                            reorderMode: reorderMode,
                            activeDragPayload: $sidebarDragPayload,
                            dropTarget: $sidebarDropTarget,
                            beginDrag: beginSidebarDrag,
                            onDropFolder: { payload, target, placement in
                                handleFolderDrop(payload, targetFolder: target, placement: placement)
                            }
                        )
                    }
                }
                if !store.archivedSessions.isEmpty {
                    Section {
                        if !store.archivedSectionCollapsed {
                            ForEach(store.archivedSessions) { session in
                                sessionRow(session)
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
            .transaction { transaction in
                if reorderMode {
                    transaction.animation = nil
                    transaction.disablesAnimations = true
                }
            }

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
        .onChange(of: reorderMode) { _, isReordering in
            if !isReordering {
                clearSidebarDragState()
            }
        }
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
                guard !reorderMode else { return }
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
        let row = SessionRow(session: session, reorderMode: reorderMode)
            .tag(session.id)
            .opacity(reorderMode ? 0.9 : 1)

        if reorderMode {
            row
                .overlay(alignment: .top) {
                    SidebarInsertionRule(isVisible: shouldShowSessionDropTarget(session, placement: .before))
                }
                .overlay(alignment: .bottom) {
                    SidebarInsertionRule(isVisible: shouldShowSessionDropTarget(session, placement: .after))
                }
                .onDrag {
                    beginSidebarDrag(.session(session.id))
                    return NSItemProvider(object: SidebarDragPayload.session(session.id).rawValue as NSString)
                }
                .onDrop(
                    of: [.text],
                    delegate: SidebarSessionDropDelegate(
                        targetSession: session,
                        activePayload: $sidebarDragPayload,
                        dropTarget: $sidebarDropTarget,
                        clearDragState: clearSidebarDragState,
                        canDropSession: canDropSession,
                        performMove: { sourceID, targetSession, placement in
                            handleSessionDrop(sourceID, targetSession: targetSession, placement: placement)
                        }
                    )
                )
        } else {
            row.contextMenu {
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
    }

    private func shouldShowSessionDropTarget(_ session: ZSession, placement: SidebarDropPlacement) -> Bool {
        guard case let .session(sourceID)? = sidebarDragPayload,
              sourceID != session.id,
              sidebarDropTarget == .session(session.id, placement),
              let source = store.sessions.first(where: { $0.id == sourceID }) else {
            return false
        }
        return store.canReorderSession(source, relativeTo: session)
    }

    private func beginSidebarDrag(_ payload: SidebarDragPayload) {
        withoutSidebarAnimation {
            sidebarDragPayload = payload
            sidebarDropTarget = nil
        }
    }

    private func clearSidebarDragState() {
        withoutSidebarAnimation {
            sidebarDragPayload = nil
            sidebarDropTarget = nil
        }
    }

    private func handleFolderDrop(_ payload: SidebarDragPayload, targetFolder: String, placement: SidebarDropPlacement) -> Bool {
        guard reorderMode,
              case let .folder(sourceFolder) = payload,
              sourceFolder != targetFolder else {
            return false
        }
        return moveFolder(sourceFolder, relativeTo: targetFolder, placement: placement)
    }

    private func canDropSession(sourceID: String, targetSession: ZSession) -> Bool {
        guard reorderMode,
              let source = store.sessions.first(where: { $0.id == sourceID }) else {
            return false
        }
        return store.canReorderSession(source, relativeTo: targetSession)
    }

    private func handleSessionDrop(_ sourceID: String, targetSession: ZSession, placement: SidebarDropPlacement) -> Bool {
        guard reorderMode,
              let source = store.sessions.first(where: { $0.id == sourceID }),
              store.canReorderSession(source, relativeTo: targetSession) else {
            return false
        }
        Task {
            await store.reorderSession(source, relativeTo: targetSession, placement: placement.rawValue)
        }
        return true
    }

    private func moveFolder(_ source: String, relativeTo target: String, placement: SidebarDropPlacement) -> Bool {
        let names = store.folderNames
        guard let sourceIndex = names.firstIndex(of: source),
              let targetIndex = names.firstIndex(of: target),
              sourceIndex != targetIndex else {
            return false
        }
        let destination: Int
        switch placement {
        case .before:
            destination = targetIndex
        case .after:
            destination = targetIndex + 1
        }
        guard destination != sourceIndex, destination != sourceIndex + 1 else {
            return false
        }
        withoutSidebarAnimation {
            store.reorderFolders(from: IndexSet(integer: sourceIndex), to: destination)
        }
        return true
    }
}

private enum SidebarDropPlacement: Equatable {
    case before
    case after

    var rawValue: String {
        switch self {
        case .before: "before"
        case .after: "after"
        }
    }
}

private enum SidebarDragPayload: Equatable {
    case folder(String)
    case session(String)

    var rawValue: String {
        switch self {
        case .folder(let name):
            return "folder:\(name)"
        case .session(let id):
            return "session:\(id)"
        }
    }
}

private enum SidebarDropTarget: Equatable {
    case folder(String, SidebarDropPlacement)
    case session(String, SidebarDropPlacement)
}

private func withoutSidebarAnimation(_ body: () -> Void) {
    var transaction = Transaction(animation: nil)
    transaction.disablesAnimations = true
    withTransaction(transaction) {
        body()
    }
}

private func sidebarPlacement(for info: DropInfo) -> SidebarDropPlacement {
    info.location.y < 15 ? .before : .after
}

private struct SidebarInsertionRule: View {
    let isVisible: Bool

    var body: some View {
        Capsule()
            .fill(Color.accentColor)
            .frame(height: 3)
            .padding(.horizontal, 8)
            .opacity(isVisible ? 1 : 0)
            .shadow(color: Color.accentColor.opacity(isVisible ? 0.35 : 0), radius: 4)
            .allowsHitTesting(false)
    }
}

private struct SidebarFolderDropDelegate: DropDelegate {
    let targetFolder: String
    @Binding var activePayload: SidebarDragPayload?
    @Binding var dropTarget: SidebarDropTarget?
    let clearDragState: () -> Void
    let performMove: (SidebarDragPayload, SidebarDropPlacement) -> Bool

    func dropUpdated(info: DropInfo) -> DropProposal? {
        updateTarget(info: info)
        return DropProposal(operation: .move)
    }

    func dropEntered(info: DropInfo) {
        updateTarget(info: info)
    }

    func dropExited(info: DropInfo) {
        withoutSidebarAnimation {
            dropTarget = nil
        }
    }

    func performDrop(info: DropInfo) -> Bool {
        defer {
            DispatchQueue.main.async {
                clearDragState()
            }
        }
        guard case let .folder(sourceFolder)? = activePayload,
              sourceFolder != targetFolder else {
            return false
        }
        return performMove(.folder(sourceFolder), sidebarPlacement(for: info))
    }

    private func updateTarget(info: DropInfo) {
        guard case let .folder(sourceFolder)? = activePayload,
              sourceFolder != targetFolder else {
            withoutSidebarAnimation {
                dropTarget = nil
            }
            return
        }
        let placement = sidebarPlacement(for: info)
        if dropTarget != .folder(targetFolder, placement) {
            withoutSidebarAnimation {
                dropTarget = .folder(targetFolder, placement)
            }
        }
    }
}

private struct SidebarSessionDropDelegate: DropDelegate {
    let targetSession: ZSession
    @Binding var activePayload: SidebarDragPayload?
    @Binding var dropTarget: SidebarDropTarget?
    let clearDragState: () -> Void
    let canDropSession: (String, ZSession) -> Bool
    let performMove: (String, ZSession, SidebarDropPlacement) -> Bool

    func dropUpdated(info: DropInfo) -> DropProposal? {
        updateTarget(info: info)
        return DropProposal(operation: .move)
    }

    func dropEntered(info: DropInfo) {
        updateTarget(info: info)
    }

    func dropExited(info: DropInfo) {
        withoutSidebarAnimation {
            dropTarget = nil
        }
    }

    func performDrop(info: DropInfo) -> Bool {
        defer {
            DispatchQueue.main.async {
                clearDragState()
            }
        }
        guard case let .session(sourceID)? = activePayload,
              canDropSession(sourceID, targetSession) else {
            return false
        }
        return performMove(sourceID, targetSession, sidebarPlacement(for: info))
    }

    private func updateTarget(info: DropInfo) {
        guard case let .session(sourceID)? = activePayload,
              canDropSession(sourceID, targetSession) else {
            withoutSidebarAnimation {
                dropTarget = nil
            }
            return
        }
        let placement = sidebarPlacement(for: info)
        if dropTarget != .session(targetSession.id, placement) {
            withoutSidebarAnimation {
                dropTarget = .session(targetSession.id, placement)
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
    @Binding var activeDragPayload: SidebarDragPayload?
    @Binding var dropTarget: SidebarDropTarget?
    let beginDrag: (SidebarDragPayload) -> Void
    let onDropFolder: (SidebarDragPayload, String, SidebarDropPlacement) -> Bool

    @ViewBuilder
    var body: some View {
        let header = HStack(spacing: 6) {
            if reorderMode {
                SidebarFolderDragHandle(
                    folder: folder,
                    beginDrag: beginDrag
                )
            } else {
                Button {
                    store.toggleFolderCollapsed(folder)
                } label: {
                    Image(systemName: store.isFolderCollapsed(folder) ? "chevron.right" : "chevron.down")
                        .frame(width: 12)
                }
                .buttonStyle(.plain)
                .help(store.isFolderCollapsed(folder) ? "Expand folder" : "Collapse folder")
            }

            Text(folder)
                .font(.caption.weight(.semibold))
            Spacer(minLength: 4)
            if !reorderMode {
                Image(systemName: "line.3.horizontal")
                    .foregroundStyle(.tertiary)
            }
        }
        .textCase(nil)
        .overlay(alignment: .top) {
            SidebarInsertionRule(isVisible: shouldShowDropTarget(.folder(folder, .before)))
        }
        .overlay(alignment: .bottom) {
            SidebarInsertionRule(isVisible: shouldShowDropTarget(.folder(folder, .after)))
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

        if reorderMode {
            header
                .onDrop(
                    of: [.text],
                    delegate: SidebarFolderDropDelegate(
                        targetFolder: folder,
                        activePayload: $activeDragPayload,
                        dropTarget: $dropTarget,
                        clearDragState: {
                            activeDragPayload = nil
                            dropTarget = nil
                        },
                        performMove: { providers, placement in
                            onDropFolder(providers, folder, placement)
                        }
                    )
                )
        } else {
            header
        }
    }

    private func shouldShowDropTarget(_ target: SidebarDropTarget) -> Bool {
        guard let activeDragPayload else { return false }
        let sourceFolder: String
        switch activeDragPayload {
        case .folder(let folder):
            sourceFolder = folder
        case .session:
            return false
        }
        let targetFolder: String
        switch target {
        case .folder(let folder, _):
            targetFolder = folder
        case .session:
            return false
        }
        return sourceFolder != targetFolder && dropTarget == target
    }
}

private struct SidebarFolderDragHandle: View {
    let folder: String
    let beginDrag: (SidebarDragPayload) -> Void

    var body: some View {
        SidebarFolderDragHandleView(
            folder: folder,
            payloadText: SidebarDragPayload.folder(folder).rawValue,
            beginDrag: { beginDrag(.folder(folder)) }
        )
        .frame(width: 18, height: 18)
        .help("Drag to reorder \(folder)")
    }
}

#if os(macOS)
private struct SidebarFolderDragHandleView: NSViewRepresentable {
    let folder: String
    let payloadText: String
    let beginDrag: () -> Void

    func makeNSView(context: Context) -> SidebarFolderDragHandleNSView {
        let view = SidebarFolderDragHandleNSView()
        view.folder = folder
        view.payloadText = payloadText
        view.beginDrag = beginDrag
        return view
    }

    func updateNSView(_ nsView: SidebarFolderDragHandleNSView, context: Context) {
        nsView.folder = folder
        nsView.payloadText = payloadText
        nsView.beginDrag = beginDrag
    }
}

private final class SidebarFolderDragHandleNSView: NSView, NSDraggingSource {
    var folder = "" {
        didSet {
            toolTip = "Drag to reorder \(folder)"
        }
    }
    var payloadText = ""
    var beginDrag: (() -> Void)?

    private let imageView = NSImageView()

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        imageView.image = NSImage(systemSymbolName: "line.3.horizontal", accessibilityDescription: "Reorder folder")
        imageView.symbolConfiguration = .init(pointSize: 11, weight: .semibold)
        imageView.contentTintColor = .secondaryLabelColor
        imageView.imageScaling = .scaleProportionallyDown
        addSubview(imageView)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override var intrinsicContentSize: NSSize {
        NSSize(width: 18, height: 18)
    }

    override func layout() {
        super.layout()
        imageView.frame = bounds.insetBy(dx: 2, dy: 2)
    }

    override func mouseDragged(with event: NSEvent) {
        beginDrag?()
        let item = NSPasteboardItem()
        item.setString(payloadText, forType: .string)
        let draggingItem = NSDraggingItem(pasteboardWriter: item)
        draggingItem.setDraggingFrame(bounds, contents: imageView.image)
        beginDraggingSession(with: [draggingItem], event: event, source: self)
    }

    func draggingSession(_ session: NSDraggingSession, sourceOperationMaskFor context: NSDraggingContext) -> NSDragOperation {
        .move
    }

    func ignoreModifierKeys(for session: NSDraggingSession) -> Bool {
        true
    }
}
#endif

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
    var reorderMode = false

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
            if reorderMode {
                Spacer(minLength: 4)
                Image(systemName: "line.3.horizontal")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .frame(width: 14)
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
