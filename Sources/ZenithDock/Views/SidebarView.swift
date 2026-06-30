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
    @State private var searchText = ""
    @FocusState private var searchFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("AgentsDock")
                            .font(.headline)
                        Text(store.serverURLString)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    Spacer()
                }
                HStack(spacing: 8) {
                    Image(systemName: "magnifyingglass")
                        .foregroundStyle(.secondary)
                    TextField("Search chats", text: $searchText)
                        .textFieldStyle(.plain)
                        .focused($searchFocused)
                        .onSubmit { selectFirstSearchResult() }
                    if !searchText.isEmpty {
                        Button {
                            searchText = ""
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                                .foregroundStyle(.secondary)
                        }
                        .buttonStyle(.plain)
                        .help("Clear chat search")
                    }
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 7)
                .background(Theme.card)
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.softLine))
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
                    .disabled(isSearching)
                    .help(reorderMode ? "Finish reordering chats and folders" : "Drag chats and folders to reorder")
                }
                ConnectionStatusCard()
            }
            .padding(14)

            List(selection: sessionSelection) {
                if !filteredPinnedSessions.isEmpty {
                    Section("Pinned") {
                        ForEach(filteredPinnedSessions) { session in
                            sessionRow(session)
                        }
                    }
                }
                ForEach(filteredFolderNames, id: \.self) { folder in
                    Section {
                        if isSearching || !store.isFolderCollapsed(folder) {
                            ForEach(filteredSessions(in: folder)) { session in
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
                if !filteredArchivedSessions.isEmpty {
                    Section {
                        if isSearching || !store.archivedSectionCollapsed {
                            ForEach(filteredArchivedSessions) { session in
                                sessionRow(session)
                            }
                        }
                    } header: {
                        ArchivedSectionHeader()
                    }
                }
                if isSearching && filteredPinnedSessions.isEmpty && filteredFolderNames.isEmpty && filteredArchivedSessions.isEmpty {
                    Text("No chats match “\(normalizedSearchText)”")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .padding(.vertical, 8)
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
        .onChange(of: searchText) { _, _ in
            if isSearching && reorderMode {
                withoutSidebarAnimation {
                    reorderMode = false
                    clearSidebarDragState()
                }
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
            Text(deleteCandidate?.title ?? "This chat will be removed from AgentsDock.")
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

    // Enter in the search field jumps to the top match (quick-switcher).
    private func selectFirstSearchResult() {
        guard isSearching else { return }
        let first = filteredPinnedSessions.first
            ?? filteredFolderNames.lazy.compactMap { filteredSessions(in: $0).first }.first
            ?? filteredArchivedSessions.first
        guard let session = first else { return }
        searchFocused = false
        Task { await store.select(sessionID: session.id) }
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
        if searchableParts.contains(where: { $0.localizedCaseInsensitiveContains(query) }) {
            return true
        }
        return false
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

    @ViewBuilder
    private func sessionRow(_ session: ZSession) -> some View {
        let isUnread = store.unreadAgentSessionIDs.contains(session.id)
        let canMarkUnread = isUnread || store.canMarkSessionUnread(session)
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
                        isUnread ? "Mark as Read" : "Mark as Unread",
                        systemImage: isUnread ? "envelope.open" : "envelope.badge"
                    )
                }
                .disabled(!canMarkUnread)
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
                Image(systemName: "line.3.horizontal")
                    .foregroundStyle(.secondary)
                    .frame(width: 12)
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
                .contentShape(Rectangle())
                .overlay {
                    SidebarFolderDragSurface(
                        folder: folder,
                        beginDrag: { beginDrag(.folder(folder)) },
                        updateDropTarget: { placement in
                            withoutSidebarAnimation {
                                dropTarget = placement.map { .folder(folder, $0) }
                            }
                        },
                        performDrop: { sourceFolder, placement in
                            onDropFolder(.folder(sourceFolder), folder, placement)
                        },
                        endDrag: {
                            withoutSidebarAnimation {
                                activeDragPayload = nil
                                dropTarget = nil
                            }
                        }
                    )
                }
                .help("Drag \(folder) to reorder folders")
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

#if os(macOS)
private struct SidebarFolderDragSurface: NSViewRepresentable {
    let folder: String
    let beginDrag: () -> Void
    let updateDropTarget: (SidebarDropPlacement?) -> Void
    let performDrop: (String, SidebarDropPlacement) -> Bool
    let endDrag: () -> Void

    func makeNSView(context: Context) -> SidebarFolderDragSurfaceNSView {
        let view = SidebarFolderDragSurfaceNSView(frame: .zero)
        configure(view)
        return view
    }

    func updateNSView(_ nsView: SidebarFolderDragSurfaceNSView, context: Context) {
        configure(nsView)
    }

    private func configure(_ view: SidebarFolderDragSurfaceNSView) {
        view.folder = folder
        view.payloadText = SidebarDragPayload.folder(folder).rawValue
        view.beginDrag = beginDrag
        view.updateDropTarget = updateDropTarget
        view.performDrop = performDrop
        view.endDrag = endDrag
    }
}

private final class SidebarFolderDragSurfaceNSView: NSView, NSDraggingSource {
    var folder = "" {
        didSet {
            toolTip = "Drag to reorder \(folder)"
        }
    }
    var payloadText = ""
    var beginDrag: (() -> Void)?
    var updateDropTarget: ((SidebarDropPlacement?) -> Void)?
    var performDrop: ((String, SidebarDropPlacement) -> Bool)?
    var endDrag: (() -> Void)?
    private var mouseDownPoint: NSPoint?
    private var dragSessionActive = false

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        registerForDraggedTypes([.string])
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override var isFlipped: Bool {
        true
    }

    override func hitTest(_ point: NSPoint) -> NSView? {
        bounds.contains(point) ? self : nil
    }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool {
        true
    }

    override func resetCursorRects() {
        addCursorRect(bounds, cursor: .openHand)
    }

    override func mouseDown(with event: NSEvent) {
        mouseDownPoint = convert(event.locationInWindow, from: nil)
        dragSessionActive = false
    }

    override func mouseDragged(with event: NSEvent) {
        guard !dragSessionActive,
              let mouseDownPoint else { return }
        let currentPoint = convert(event.locationInWindow, from: nil)
        guard hypot(currentPoint.x - mouseDownPoint.x, currentPoint.y - mouseDownPoint.y) >= 3 else {
            return
        }
        dragSessionActive = true
        beginDrag?()
        let item = NSPasteboardItem()
        item.setString(payloadText, forType: .string)
        let draggingItem = NSDraggingItem(pasteboardWriter: item)
        let preview = dragPreviewImage()
        let previewRect = NSRect(
            x: currentPoint.x - 12,
            y: currentPoint.y - preview.size.height / 2,
            width: preview.size.width,
            height: preview.size.height
        )
        draggingItem.setDraggingFrame(previewRect, contents: preview)
        beginDraggingSession(with: [draggingItem], event: event, source: self)
    }

    override func mouseUp(with event: NSEvent) {
        mouseDownPoint = nil
        if !dragSessionActive {
            endDrag?()
        }
    }

    func draggingSession(_ session: NSDraggingSession, sourceOperationMaskFor context: NSDraggingContext) -> NSDragOperation {
        .move
    }

    func draggingSession(_ session: NSDraggingSession, endedAt screenPoint: NSPoint, operation: NSDragOperation) {
        mouseDownPoint = nil
        dragSessionActive = false
        updateDropTarget?(nil)
        endDrag?()
    }

    func ignoreModifierKeys(for session: NSDraggingSession) -> Bool {
        true
    }

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        updateDestination(for: sender)
    }

    override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation {
        updateDestination(for: sender)
    }

    override func draggingExited(_ sender: NSDraggingInfo?) {
        updateDropTarget?(nil)
    }

    override func prepareForDragOperation(_ sender: NSDraggingInfo) -> Bool {
        decodedSourceFolder(from: sender) != nil
    }

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        guard let sourceFolder = decodedSourceFolder(from: sender),
              sourceFolder != folder else { return false }
        return performDrop?(sourceFolder, placement(for: sender)) ?? false
    }

    override func concludeDragOperation(_ sender: NSDraggingInfo?) {
        updateDropTarget?(nil)
    }

    private func updateDestination(for sender: NSDraggingInfo) -> NSDragOperation {
        guard let sourceFolder = decodedSourceFolder(from: sender),
              sourceFolder != folder else {
            updateDropTarget?(nil)
            return []
        }
        updateDropTarget?(placement(for: sender))
        return .move
    }

    private func decodedSourceFolder(from sender: NSDraggingInfo) -> String? {
        guard let payload = sender.draggingPasteboard.string(forType: .string),
              payload.hasPrefix("folder:") else { return nil }
        return String(payload.dropFirst("folder:".count))
    }

    private func placement(for sender: NSDraggingInfo) -> SidebarDropPlacement {
        let point = convert(sender.draggingLocation, from: nil)
        return placementForTesting(localY: point.y)
    }

    fileprivate func placementForTesting(localY: CGFloat) -> SidebarDropPlacement {
        localY < bounds.midY ? .before : .after
    }

    private func dragPreviewImage() -> NSImage {
        let width = min(max(150, CGFloat(folder.count * 7 + 42)), 260)
        let size = NSSize(width: width, height: 28)
        let image = NSImage(size: size)
        image.lockFocus()
        NSColor.windowBackgroundColor.withAlphaComponent(0.96).setFill()
        NSBezierPath(roundedRect: NSRect(origin: .zero, size: size), xRadius: 6, yRadius: 6).fill()
        NSColor.separatorColor.setStroke()
        let border = NSBezierPath(roundedRect: NSRect(x: 0.5, y: 0.5, width: width - 1, height: 27), xRadius: 6, yRadius: 6)
        border.lineWidth = 1
        border.stroke()
        if let icon = NSImage(systemSymbolName: "folder", accessibilityDescription: nil) {
            icon.draw(in: NSRect(x: 9, y: 6, width: 16, height: 16))
        }
        (folder as NSString).draw(
            in: NSRect(x: 32, y: 6, width: width - 40, height: 18),
            withAttributes: [
                .font: NSFont.systemFont(ofSize: 12, weight: .semibold),
                .foregroundColor: NSColor.labelColor
            ]
        )
        image.unlockFocus()
        return image
    }
}

@MainActor
enum SidebarReorderHarness {
    static func run() -> Bool {
        let surface = SidebarFolderDragSurfaceNSView(
            frame: NSRect(x: 0, y: 0, width: 240, height: 24)
        )
        surface.folder = "Harness Folder"
        surface.payloadText = SidebarDragPayload.folder("Harness Folder").rawValue
        guard surface.subviews.isEmpty,
              surface.hitTest(NSPoint(x: 4, y: 12)) === surface,
              surface.hitTest(NSPoint(x: 236, y: 12)) === surface,
              surface.placementForTesting(localY: 2) == .before,
              surface.placementForTesting(localY: 22) == .after else {
            fputs("SidebarReorderHarness failed: folder header is not one native drag surface\n", stderr)
            return false
        }
        print("SidebarReorderHarness passed scenario=full-folder-header-drag-surface")
        return true
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
                    // Reserve two lines so the card height stays fixed as the
                    // subtitle text changes length (streaming/reconnecting,
                    // active-count) — otherwise the card reflows 1<->2 lines on
                    // every poll and the whole sidebar below it jumps.
                    .lineLimit(2, reservesSpace: true)
                    .fixedSize(horizontal: false, vertical: true)
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
