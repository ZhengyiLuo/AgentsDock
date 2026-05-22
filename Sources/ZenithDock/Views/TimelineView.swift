@preconcurrency import AppKit
import SwiftUI
import UniformTypeIdentifiers
import ZenithCore

struct TimelineView: View {
    @EnvironmentObject private var store: AppStore
    @Binding var importerOpen: Bool
    @Binding var resumeOpen: Bool
    @Binding var serverSettingsOpen: Bool
    @State private var isAtBottom = true
    @State private var isTimelineScrollable = false
    @State private var olderHistoryLoadArmed = true
    @State private var suppressScrollHistoryLoadUntilTopLeaves = false
    @State private var visibleRowLimit = 100
    @State private var isFileDropTargeted = false
    @State private var isNearBottom = true
    @State private var historyLoadSuppressedUntil = Date.distantPast
    @State private var lastObservedEventSeq = 0
    @State private var isInitialTimelineMasked = false
    @State private var maskedSessionID: String?
    @State private var initialTimelineRevealRevision = 0
    private let bottomID = "timeline-bottom"
    private let coordinateSpaceName = "timelineScroll"
    private let defaultVisibleRowLimit = 100
    private let rowPageSize = 40
    private let bottomButtonHideDistance: CGFloat = 180

    private struct TimelineScrollAnchor {
        let rowID: String
        let eventID: String?
    }

    var body: some View {
        let timelineRowsSuspended = isInitialTimelineMasked && (
            store.isSelectingSession ||
            store.loadedSessionID != store.selectedSessionID
        )
        let displayEvents = timelineRowsSuspended ? [] : store.displayEvents
        let projection = TimelineRows.project(from: displayEvents)
        let allRows = projection.rows
        let jobsByRunID = projection.jobsByRunID
        let hiddenRenderedRowCount = max(0, allRows.count - visibleRowLimit)
        let rows = Array(allRows.suffix(visibleRowLimit))
        let firstUnreadRowID = firstUnreadRowID(in: rows, unreadSeq: store.selectedSessionFirstUnreadSeq)
        let linkContext = store.selectedSessionID.map { store.markdownLinkContext(sessionID: $0) }
        let displaySignature = "\(displayEvents.count):\(displayEvents.last?.id ?? "")"

        VStack(spacing: 0) {
            HeaderView(
                importerOpen: $importerOpen,
                resumeOpen: $resumeOpen,
                serverSettingsOpen: $serverSettingsOpen
            )
            Divider()
            ScrollViewReader { proxy in
                ZStack(alignment: .bottomTrailing) {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 14) {
                            if store.selectedSession == nil {
                                EmptyStateView()
                            } else {
                                if !timelineRowsSuspended && (store.hiddenDisplayEventCount > 0 || hiddenRenderedRowCount > 0) {
                                    TimelineHistoryLoader(hiddenRenderedRowCount: hiddenRenderedRowCount) {
                                        revealOlderRows(preservingPositionWith: proxy)
                                    } onLoadOlder: {
                                        loadOlderHistoryFromIntent(proxy)
                                    }
                                    .background(TimelineHistoryTopReader(coordinateSpaceName: coordinateSpaceName))
                                    .onDisappear {
                                        olderHistoryLoadArmed = true
                                        suppressScrollHistoryLoadUntilTopLeaves = false
                                    }
                                }
                                ForEach(rows) { row in
                                    if row.id == firstUnreadRowID {
                                        TimelineUnreadMarker()
                                            .id("unread-marker-\(row.id)")
                                    }
                                    switch row.kind {
                                    case .event(let event):
                                        EventCard(
                                            event: event,
                                            showDebugEvents: store.showDebugEvents,
                                            queueStatus: queueStatus(for: event),
                                            attachments: store.promptFiles(for: event).map {
                                                MessageAttachment(file: $0, url: store.fileURL($0))
                                            },
                                            artifactURL: event.artifact.map { store.fileURL($0) },
                                            fileURL: event.file.map { store.fileURL($0) },
                                            linkContext: linkContext,
                                            job: event.run_id.flatMap { jobsByRunID[$0] },
                                            onUnqueue: { event in
                                                Task { await store.unqueue(event) }
                                            }
                                        )
                                        .equatable()
                                            .id(row.id)
                                    case .job(let jobRun):
                                        JobRunBubble(jobRun: jobRun, linkContext: linkContext)
                                            .id(row.id)
                                    case .jobGroup(let group):
                                        JobRunGroupBubble(group: group, linkContext: linkContext)
                                            .id(row.id)
                                    case .trace(let events):
                                        TraceGroupCard(
                                            events: events,
                                            linkContext: linkContext
                                        )
                                            .equatable()
                                            .id(row.id)
                                    }
                                }
                                Color.clear
                                    .frame(height: 1)
                                    .id(bottomID)
                            }
                        }
                        .padding(20)
                        .padding(.bottom, 56)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(
                            TimelineScrollObserver { metrics in
                                updateBottomVisibility(metrics)
                            }
                        )
                    }
                    .opacity(isInitialTimelineMasked ? 0 : 1)
                    .coordinateSpace(name: coordinateSpaceName)
                    if isInitialTimelineMasked, store.selectedSession != nil {
                        TimelinePositioningOverlay()
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                            .allowsHitTesting(false)
                    }
                    if !isInitialTimelineMasked && isTimelineScrollable && (!isNearBottom || store.selectedSessionHasUnread) && !displayEvents.isEmpty {
                        Button {
                            scrollToBottom(proxy, animated: true)
                            store.markSelectedSessionRead(force: true)
                        } label: {
                            HStack(spacing: store.selectedSessionHasUnread ? 6 : 0) {
                                Image(systemName: "arrow.down.to.line.compact")
                                    .font(.system(size: 12, weight: .semibold))
                                if store.selectedSessionHasUnread {
                                    Text("New")
                                        .font(.caption2.weight(.bold))
                                }
                            }
                            .frame(minWidth: 24, minHeight: 24)
                            .padding(.horizontal, store.selectedSessionHasUnread ? 7 : 0)
                        }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.mini)
                        .padding(12)
                        .help(store.selectedSessionHasUnread ? "Jump to unread agent message" : "Jump to latest message")
                        .accessibilityLabel("Jump to bottom")
                    }
                    if isFileDropTargeted {
                        TimelineFileDropOverlay()
                            .padding(18)
                            .allowsHitTesting(false)
                    }
                }
                .onDrop(of: TimelineFileDrop.supportedTypes, isTargeted: $isFileDropTargeted) { providers in
                    acceptTimelineFileDrop(providers)
                }
                .onChange(of: store.scrollToBottomRevision) {
                    if shouldFollowBottomRequest {
                        scrollToBottom(proxy)
                    }
                    settleInitialTimelinePosition(proxy)
                }
                .onChange(of: store.scrollToEventRevision) {
                    scrollToRequestedEvent(proxy)
                }
                .onChange(of: store.selectedSessionID) {
                    beginInitialTimelineMask()
                    isAtBottom = true
                    isNearBottom = true
                    store.setSelectedTimelineAtBottom(true)
                    isTimelineScrollable = false
                    olderHistoryLoadArmed = true
                    suppressScrollHistoryLoadUntilTopLeaves = false
                    historyLoadSuppressedUntil = Date.distantPast
                    visibleRowLimit = defaultVisibleRowLimit
                    lastObservedEventSeq = maxEventSeq(displayEvents)
                    store.markSelectedSessionRead()
                    scrollToBottom(proxy)
                    settleInitialTimelinePosition(proxy)
                }
                .onChange(of: displayEvents.count) { oldCount, newCount in
                    let previousObservedSeq = lastObservedEventSeq
                    let shouldFollowLiveEvent = shouldAutoFollowLiveEvent(after: previousObservedSeq)
                    let rowCount = TimelineRows.build(from: displayEvents).count
                    if newCount == 0 {
                        isAtBottom = true
                        isNearBottom = true
                        store.setSelectedTimelineAtBottom(true)
                        isTimelineScrollable = false
                        setVisibleRowLimit(defaultVisibleRowLimit)
                    } else if isAtBottom {
                        setVisibleRowLimit(cappedLiveVisibleRowLimit(rowCount: rowCount, oldCount: oldCount, newCount: newCount))
                    } else if newCount > oldCount {
                        setVisibleRowLimit(min(rowCount, visibleRowLimit + min(rowPageSize, max(1, newCount - oldCount))))
                    }
                    updateUnreadState(after: previousObservedSeq)
                    lastObservedEventSeq = maxEventSeq(displayEvents)
                    if shouldFollowLiveEvent {
                        scrollToBottom(proxy)
                        store.markSelectedSessionRead(force: true)
                    } else {
                        settleInitialTimelinePosition(proxy)
                    }
                }
                .onChange(of: displaySignature) {
                    settleInitialTimelinePosition(proxy)
                }
                .onChange(of: store.loadedSessionID) {
                    settleInitialTimelinePosition(proxy)
                }
                .onChange(of: store.isSelectingSession) {
                    if !store.isSelectingSession {
                        settleInitialTimelinePosition(proxy)
                    }
                }
                .onChange(of: store.hiddenDisplayEventCount) {
                    if store.hiddenDisplayEventCount <= 0 {
                        olderHistoryLoadArmed = false
                        suppressScrollHistoryLoadUntilTopLeaves = false
                    }
                }
                .onPreferenceChange(TimelineHistoryTopPreferenceKey.self) { topY in
                    handleHistoryTopChange(topY, proxy: proxy)
                }
            }
            Divider()
            ComposerView(importerOpen: $importerOpen)
        }
        .background(Theme.window)
        .fileImporter(isPresented: $importerOpen, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            if case .success(let urls) = result {
                Task { await store.upload(urls: urls) }
            }
        }
        .onAppear {
            lastObservedEventSeq = maxEventSeq(store.displayEvents)
            if isAtBottom {
                store.markSelectedSessionRead()
            }
            if isInitialTimelineMasked && !store.isSelectingSession {
                isInitialTimelineMasked = false
            }
        }
    }

    private func beginInitialTimelineMask() {
        initialTimelineRevealRevision += 1
        maskedSessionID = store.selectedSessionID
        isInitialTimelineMasked = store.selectedSessionID != nil
    }

    private func settleInitialTimelinePosition(_ proxy: ScrollViewProxy) {
        guard isInitialTimelineMasked,
              let sessionID = maskedSessionID,
              sessionID == store.selectedSessionID else {
            return
        }
        guard !store.isSelectingSession else { return }
        let canSettle = !store.displayEvents.isEmpty || store.loadedSessionID == sessionID
        guard canSettle else { return }
        initialTimelineRevealRevision += 1
        let revision = initialTimelineRevealRevision
        DispatchQueue.main.async {
            guard initialTimelineMaskIsCurrent(revision: revision, sessionID: sessionID) else { return }
            if !store.displayEvents.isEmpty {
                withTransaction(noAnimationTransaction) {
                    proxy.scrollTo(bottomID, anchor: .bottom)
                    isAtBottom = true
                    isNearBottom = true
                    store.setSelectedTimelineAtBottom(true)
                }
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.12) {
                guard initialTimelineMaskIsCurrent(revision: revision, sessionID: sessionID) else { return }
                withTransaction(noAnimationTransaction) {
                    isInitialTimelineMasked = false
                }
            }
        }
    }

    private func initialTimelineMaskIsCurrent(revision: Int, sessionID: String) -> Bool {
        isInitialTimelineMasked &&
            initialTimelineRevealRevision == revision &&
            maskedSessionID == sessionID &&
            store.selectedSessionID == sessionID
    }

    private func scrollToBottom(_ proxy: ScrollViewProxy, animated: Bool = false) {
        guard !store.displayEvents.isEmpty else { return }
        historyLoadSuppressedUntil = Date().addingTimeInterval(0.35)
        let action = {
            proxy.scrollTo(bottomID, anchor: .bottom)
            isAtBottom = true
            isNearBottom = true
            store.setSelectedTimelineAtBottom(true)
        }
        if animated {
            withAnimation(.snappy) {
                action()
            }
        } else {
            action()
        }
    }

    private var shouldFollowBottomRequest: Bool {
        isAtBottom || isNearBottom || store.selectedTimelineAtBottom || store.isRunning
    }

    private func shouldAutoFollowLiveEvent(after previousSeq: Int) -> Bool {
        guard store.selectedSessionID != nil else { return false }
        let hasNewerVisibleEvent = store.displayEvents.contains { event in
            event.seq > previousSeq
        }
        guard hasNewerVisibleEvent else { return false }
        return shouldFollowBottomRequest
    }

    private func cappedLiveVisibleRowLimit(rowCount: Int, oldCount: Int, newCount: Int) -> Int {
        let incomingCount = max(0, newCount - oldCount)
        let currentLimit = max(visibleRowLimit, defaultVisibleRowLimit)
        guard incomingCount > 0 else {
            return min(rowCount, currentLimit)
        }
        return min(rowCount, currentLimit + min(rowPageSize, incomingCount))
    }

    private func scrollToRequestedEvent(_ proxy: ScrollViewProxy) {
        guard let eventID = store.scrollToEventID else { return }
        let rows = TimelineRows.build(from: store.displayEvents)
        guard let target = row(containingEventID: eventID, in: rows) else { return }
        let rowsNeeded = rows.count - target.index
        if visibleRowLimit < rowsNeeded {
            visibleRowLimit = min(rows.count, rowsNeeded + 8)
        }
        DispatchQueue.main.async {
            withAnimation(.snappy) {
                proxy.scrollTo(target.id, anchor: .center)
            }
            isAtBottom = false
            isNearBottom = false
            store.setSelectedTimelineAtBottom(false)
        }
    }

    private func row(containingEventID eventID: String, in rows: [TimelineRow]) -> (id: String, index: Int)? {
        for (index, row) in rows.enumerated() {
            switch row.kind {
            case .event(let event):
                if event.id == eventID {
                    return (row.id, index)
                }
            case .job(let jobRun):
                if jobRun.runEvent.id == eventID {
                    return (row.id, index)
                }
            case .jobGroup(let group):
                if group.runs.contains(where: { $0.runEvent.id == eventID }) {
                    return (row.id, index)
                }
            case .trace(let events):
                if events.contains(where: { $0.id == eventID }) {
                    return (row.id, index)
                }
            }
        }
        return nil
    }

    private func updateBottomVisibility(_ metrics: TimelineScrollMetrics) {
        guard metrics.viewportHeight > 1, !store.displayEvents.isEmpty else {
            if !isAtBottom { isAtBottom = true }
            store.setSelectedTimelineAtBottom(true)
            if isTimelineScrollable { isTimelineScrollable = false }
            return
        }
        if isTimelineScrollable != metrics.isScrollable {
            isTimelineScrollable = metrics.isScrollable
        }
        let nextAtBottom = !metrics.isScrollable || metrics.distanceFromBottom <= 28
        let nextNearBottom = !metrics.isScrollable || metrics.distanceFromBottom <= bottomButtonHideDistance
        if isAtBottom != nextAtBottom {
            isAtBottom = nextAtBottom
        }
        store.setSelectedTimelineAtBottom(nextAtBottom)
        if isNearBottom != nextNearBottom {
            isNearBottom = nextNearBottom
        }
    }

    private func handleHistoryTopChange(_ topY: CGFloat?, proxy: ScrollViewProxy) {
        guard let topY else { return }
        let topIsVisible = topY >= -24 && topY <= 96
        let topHasLeftViewport = topY < -64 || topY > 160

        if topHasLeftViewport {
            olderHistoryLoadArmed = true
            suppressScrollHistoryLoadUntilTopLeaves = false
            return
        }

        guard topIsVisible,
              !isAtBottom,
              olderHistoryLoadArmed,
              !suppressScrollHistoryLoadUntilTopLeaves,
              Date() >= historyLoadSuppressedUntil else {
            return
        }
        if revealOlderRows(preservingPositionWith: proxy) {
            olderHistoryLoadArmed = false
            suppressScrollHistoryLoadUntilTopLeaves = true
            return
        }
        guard store.canLoadOlderHistory else { return }
        olderHistoryLoadArmed = false
        suppressScrollHistoryLoadUntilTopLeaves = true
        loadOlderHistoryPreservingPosition(proxy)
    }

    private func loadOlderHistoryFromIntent(_ proxy: ScrollViewProxy) {
        if revealOlderRows(preservingPositionWith: proxy) {
            olderHistoryLoadArmed = false
            suppressScrollHistoryLoadUntilTopLeaves = true
            return
        }
        guard store.canLoadOlderHistory else { return }
        olderHistoryLoadArmed = false
        suppressScrollHistoryLoadUntilTopLeaves = true
        loadOlderHistoryPreservingPosition(proxy)
    }

    @discardableResult
    private func revealOlderRows(preservingPositionWith proxy: ScrollViewProxy) -> Bool {
        let anchor = firstRenderedAnchor()
        let rowCount = TimelineRows.build(from: store.displayEvents).count
        guard visibleRowLimit < rowCount else { return false }
        setVisibleRowLimit(min(rowCount, visibleRowLimit + rowPageSize))
        restoreScrollPosition(to: anchor, proxy: proxy)
        return true
    }

    private func loadOlderHistoryPreservingPosition(_ proxy: ScrollViewProxy) {
        let anchor = firstRenderedAnchor()
        let beforeRowCount = TimelineRows.build(from: store.displayEvents).count
        Task {
            let addedEvents = await store.loadOlderHistory()
            if addedEvents > 0 {
                let afterRowCount = TimelineRows.build(from: store.displayEvents).count
                let addedRows = max(0, afterRowCount - beforeRowCount)
                if addedRows > 0 {
                    setVisibleRowLimit(min(afterRowCount, visibleRowLimit + min(rowPageSize, addedRows)))
                }
            }
            restoreScrollPosition(to: anchor, proxy: proxy)
        }
    }

    private func firstRenderedAnchor() -> TimelineScrollAnchor? {
        let rows = TimelineRows.build(from: store.displayEvents)
        guard let row = Array(rows.suffix(visibleRowLimit)).first else { return nil }
        return TimelineScrollAnchor(rowID: row.id, eventID: row.anchorEventID)
    }

    private func restoreScrollPosition(to anchor: TimelineScrollAnchor?, proxy: ScrollViewProxy) {
        guard let anchor else { return }
        let rowID = restoredRowID(for: anchor)
        historyLoadSuppressedUntil = Date().addingTimeInterval(0.45)
        withTransaction(noAnimationTransaction) {
            proxy.scrollTo(rowID, anchor: .top)
            isAtBottom = false
            isNearBottom = false
            store.setSelectedTimelineAtBottom(false)
        }
        DispatchQueue.main.async {
            withTransaction(noAnimationTransaction) {
                proxy.scrollTo(rowID, anchor: .top)
            }
            isAtBottom = false
            isNearBottom = false
            store.setSelectedTimelineAtBottom(false)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) {
                olderHistoryLoadArmed = true
                suppressScrollHistoryLoadUntilTopLeaves = false
            }
        }
    }

    private func restoredRowID(for anchor: TimelineScrollAnchor) -> String {
        let rows = TimelineRows.build(from: store.displayEvents)
        if rows.contains(where: { $0.id == anchor.rowID }) {
            return anchor.rowID
        }
        if let eventID = anchor.eventID,
           let row = row(containingEventID: eventID, in: rows) {
            return row.id
        }
        return anchor.rowID
    }

    private func setVisibleRowLimit(_ nextLimit: Int) {
        withTransaction(noAnimationTransaction) {
            visibleRowLimit = nextLimit
        }
    }

    private var noAnimationTransaction: Transaction {
        var transaction = Transaction(animation: nil)
        transaction.disablesAnimations = true
        return transaction
    }

    private func queueStatus(for event: ZEvent) -> QueuedEventStatus {
        guard event.type == "turn_queued", event.queued_id != nil else { return .none }
        if store.hasCancelledQueuedEvent(event) {
            return .cancelled
        }
        if store.hasStartedQueuedEvent(event) {
            return .started
        }
        return .pending(position: event.position)
    }

    private func updateUnreadState(after previousSeq: Int) {
        guard let sessionID = store.selectedSessionID else { return }
        let hasNewAgentMessage = store.displayEvents.contains { event in
            event.seq > previousSeq && store.isAgentVisibleMessage(event)
        }
        guard hasNewAgentMessage else { return }
        if isAtBottom {
            store.setSelectedTimelineAtBottom(true)
        } else {
            let firstSeq = store.displayEvents
                .filter { $0.seq > previousSeq && store.isAgentVisibleMessage($0) }
                .map(\.seq)
                .min()
            store.markAgentUnread(sessionID: sessionID, firstSeq: firstSeq)
        }
    }

    private func firstUnreadRowID(in rows: [TimelineRow], unreadSeq: Int?) -> String? {
        guard store.selectedSessionHasUnread, let unreadSeq else { return nil }
        return rows.first { $0.maxSeq >= unreadSeq }?.id
    }

    private func maxEventSeq(_ events: [ZEvent]) -> Int {
        events.map(\.seq).max() ?? 0
    }

    private func acceptTimelineFileDrop(_ providers: [NSItemProvider]) -> Bool {
        guard store.selectedSessionID != nil else { return false }
        Task {
            let urls = await TimelineFileDrop.urls(from: providers)
            guard !urls.isEmpty else { return }
            await store.upload(urls: urls)
        }
        return true
    }
}

private struct TimelineFileDropOverlay: View {
    var body: some View {
        RoundedRectangle(cornerRadius: 12)
            .fill(Color.accentColor.opacity(0.14))
            .overlay(
                RoundedRectangle(cornerRadius: 12)
                    .strokeBorder(Color.accentColor.opacity(0.75), style: StrokeStyle(lineWidth: 2, dash: [7, 5]))
            )
            .overlay {
                Label("Drop files to attach", systemImage: "paperclip")
                    .font(.headline.weight(.semibold))
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .background(.regularMaterial, in: Capsule())
            }
            .transition(.opacity.combined(with: .scale(scale: 0.98)))
    }
}

private struct TimelinePositioningOverlay: View {
    var body: some View {
        VStack(spacing: 10) {
            ProgressView()
                .controlSize(.small)
            Text("Opening latest messages")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.softLine))
    }
}

enum TimelineFileDrop {
    static let supportedTypes: [UTType] = [.fileURL, .url, .item]

    @MainActor
    static func urls(from providers: [NSItemProvider]) async -> [URL] {
        var urls: [URL] = []
        var seen = Set<String>()

        for provider in providers {
            guard let url = await url(from: provider), url.isFileURL else { continue }
            let key = url.standardizedFileURL.path
            guard !seen.contains(key) else { continue }
            seen.insert(key)
            urls.append(url)
        }
        return urls
    }

    @MainActor
    private static func url(from provider: NSItemProvider) async -> URL? {
        for type in [UTType.fileURL.identifier, UTType.url.identifier] {
            guard provider.hasItemConformingToTypeIdentifier(type),
                  let item = try? await provider.loadItem(forTypeIdentifier: type) else {
                continue
            }
            if let url = decodeURL(item) {
                return url
            }
        }

        for type in provider.registeredTypeIdentifiers {
            guard let url = await loadInPlaceFileURL(from: provider, typeIdentifier: type) else { continue }
            return url
        }
        return nil
    }

    private static func decodeURL(_ item: NSSecureCoding) -> URL? {
        if let url = item as? URL {
            return url
        }
        if let url = item as? NSURL {
            return url as URL
        }
        if let data = item as? Data {
            return URL(dataRepresentation: data, relativeTo: nil)
        }
        if let string = item as? String {
            return URL(string: string)
        }
        if let string = item as? NSString {
            return URL(string: string as String)
        }
        return nil
    }

    @MainActor
    private static func loadInPlaceFileURL(from provider: NSItemProvider, typeIdentifier: String) async -> URL? {
        await withCheckedContinuation { continuation in
            provider.loadInPlaceFileRepresentation(forTypeIdentifier: typeIdentifier) { url, _, _ in
                continuation.resume(returning: url)
            }
        }
    }
}

private struct TimelineHistoryTopReader: View {
    let coordinateSpaceName: String

    var body: some View {
        GeometryReader { proxy in
            Color.clear.preference(
                key: TimelineHistoryTopPreferenceKey.self,
                value: proxy.frame(in: .named(coordinateSpaceName)).minY
            )
        }
    }
}

private struct TimelineHistoryTopPreferenceKey: PreferenceKey {
    static let defaultValue: CGFloat? = nil

    static func reduce(value: inout CGFloat?, nextValue: () -> CGFloat?) {
        value = nextValue() ?? value
    }
}

private struct TimelineScrollMetrics: Equatable {
    var viewportHeight: CGFloat
    var contentHeight: CGFloat
    var distanceFromBottom: CGFloat

    var isScrollable: Bool {
        contentHeight > viewportHeight + 8
    }

    static func == (lhs: TimelineScrollMetrics, rhs: TimelineScrollMetrics) -> Bool {
        abs(lhs.viewportHeight - rhs.viewportHeight) < 0.5 &&
            abs(lhs.contentHeight - rhs.contentHeight) < 0.5 &&
            abs(lhs.distanceFromBottom - rhs.distanceFromBottom) < 0.5
    }
}

private struct TimelineScrollObserver: NSViewRepresentable {
    var onChange: (TimelineScrollMetrics) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onChange: onChange)
    }

    func makeNSView(context: Context) -> NSView {
        let view = NSView(frame: .zero)
        context.coordinator.scheduleAttach(from: view)
        return view
    }

    func updateNSView(_ view: NSView, context: Context) {
        context.coordinator.onChange = onChange
        context.coordinator.scheduleAttach(from: view)
    }

    @MainActor
    final class Coordinator {
        var onChange: (TimelineScrollMetrics) -> Void
        private weak var scrollView: NSScrollView?
        private weak var documentView: NSView?
        private var lastMetrics: TimelineScrollMetrics?
        private var lastReportTime: TimeInterval = 0
        private var attachScheduled = false
        private var reportScheduled = false
        private var trailingReportWorkItem: DispatchWorkItem?
        private var deliveryScheduled = false
        private var pendingDelivery: TimelineScrollMetrics?
        private var boundsObserver: NSObjectProtocol?
        private var documentFrameObserver: NSObjectProtocol?
        private var scrollFrameObserver: NSObjectProtocol?

        init(onChange: @escaping (TimelineScrollMetrics) -> Void) {
            self.onChange = onChange
        }

        deinit {
            let center = NotificationCenter.default
            if let boundsObserver { center.removeObserver(boundsObserver) }
            if let documentFrameObserver { center.removeObserver(documentFrameObserver) }
            if let scrollFrameObserver { center.removeObserver(scrollFrameObserver) }
            trailingReportWorkItem?.cancel()
        }

        func scheduleAttach(from view: NSView) {
            guard !attachScheduled else { return }
            attachScheduled = true
            DispatchQueue.main.async { [weak self, weak view] in
                guard let self, let view else { return }
                self.attachScheduled = false
                self.attach(from: view)
            }
        }

        private func attach(from view: NSView) {
            guard let nextScrollView = view.enclosingScrollView else { return }
            let nextDocumentView = nextScrollView.documentView
            if scrollView !== nextScrollView || documentView !== nextDocumentView {
                detach()
                scrollView = nextScrollView
                documentView = nextDocumentView
                observe(nextScrollView, documentView: nextDocumentView)
            }
            scheduleReport()
        }

        private func observe(_ scrollView: NSScrollView, documentView: NSView?) {
            let center = NotificationCenter.default
            scrollView.contentView.postsBoundsChangedNotifications = true
            boundsObserver = center.addObserver(
                forName: NSView.boundsDidChangeNotification,
                object: scrollView.contentView,
                queue: .main
            ) { [weak self] _ in
                MainActor.assumeIsolated {
                    self?.scheduleReport()
                }
            }

            scrollView.postsFrameChangedNotifications = true
            scrollFrameObserver = center.addObserver(
                forName: NSView.frameDidChangeNotification,
                object: scrollView,
                queue: .main
            ) { [weak self] _ in
                MainActor.assumeIsolated {
                    self?.scheduleReport()
                }
            }

            documentView?.postsFrameChangedNotifications = true
            if let documentView {
                documentFrameObserver = center.addObserver(
                    forName: NSView.frameDidChangeNotification,
                    object: documentView,
                    queue: .main
                ) { [weak self] _ in
                    MainActor.assumeIsolated {
                        self?.scheduleReport()
                    }
                }
            }
        }

        private func detach() {
            let center = NotificationCenter.default
            if let boundsObserver { center.removeObserver(boundsObserver) }
            if let documentFrameObserver { center.removeObserver(documentFrameObserver) }
            if let scrollFrameObserver { center.removeObserver(scrollFrameObserver) }
            boundsObserver = nil
            documentFrameObserver = nil
            scrollFrameObserver = nil
            scrollView = nil
            documentView = nil
            lastMetrics = nil
            lastReportTime = 0
            trailingReportWorkItem?.cancel()
            trailingReportWorkItem = nil
        }

        private func scheduleReport() {
            let now = Date().timeIntervalSinceReferenceDate
            let minimumInterval = 0.08
            let elapsed = now - lastReportTime
            if elapsed < minimumInterval {
                trailingReportWorkItem?.cancel()
                let delay = minimumInterval - elapsed
                let item = DispatchWorkItem { [weak self] in
                    guard let self else { return }
                    MainActor.assumeIsolated {
                        self.trailingReportWorkItem = nil
                        self.lastReportTime = Date().timeIntervalSinceReferenceDate
                        self.report()
                    }
                }
                trailingReportWorkItem = item
                DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: item)
                return
            }
            trailingReportWorkItem?.cancel()
            trailingReportWorkItem = nil
            lastReportTime = now
            guard !reportScheduled else { return }
            reportScheduled = true
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.reportScheduled = false
                self.report()
            }
        }

        private func report() {
            guard let scrollView, let documentView = scrollView.documentView else { return }
            let visibleRect = scrollView.documentVisibleRect
            let documentBounds = documentView.bounds
            let viewportHeight = max(scrollView.contentView.bounds.height, 0)
            let contentHeight = max(documentBounds.height, 0)
            let rawDistance: CGFloat
            if documentView.isFlipped {
                rawDistance = documentBounds.maxY - visibleRect.maxY
            } else {
                rawDistance = visibleRect.minY - documentBounds.minY
            }
            let metrics = TimelineScrollMetrics(
                viewportHeight: viewportHeight,
                contentHeight: contentHeight,
                distanceFromBottom: max(rawDistance, 0)
            )
            guard metrics != lastMetrics else { return }
            lastMetrics = metrics
            deliver(metrics)
        }

        private func deliver(_ metrics: TimelineScrollMetrics) {
            pendingDelivery = metrics
            guard !deliveryScheduled else { return }
            deliveryScheduled = true
            DispatchQueue.main.async { [weak self] in
                guard let self, let metrics = self.pendingDelivery else { return }
                self.pendingDelivery = nil
                self.deliveryScheduled = false
                self.onChange(metrics)
            }
        }
    }
}

private final class TimelineRow: Identifiable {
    enum Kind {
        case event(ZEvent)
        case job(JobRunRow)
        case jobGroup(JobRunGroupRow)
        case trace([ZEvent])
    }

    let id: String
    let kind: Kind

    init(id: String, kind: Kind) {
        self.id = id
        self.kind = kind
    }

    var maxSeq: Int {
        switch kind {
        case .event(let event):
            event.seq
        case .job(let jobRun):
            jobRun.lastSeq
        case .jobGroup(let group):
            group.runs.map(\.lastSeq).max() ?? 0
        case .trace(let events):
            events.map(\.seq).max() ?? 0
        }
    }

    var anchorEventID: String? {
        switch kind {
        case .event(let event):
            event.id
        case .job(let jobRun):
            jobRun.runEvent.id
        case .jobGroup(let group):
            group.runs.first?.runEvent.id
        case .trace(let events):
            events.first?.id ?? events.last?.id
        }
    }
}

private struct TimelineUnreadMarker: View {
    var body: some View {
        HStack(spacing: 10) {
            Rectangle()
                .fill(Color.accentColor.opacity(0.75))
                .frame(height: 1)
            Text("New messages")
                .font(.caption2.weight(.bold))
                .foregroundStyle(Color.accentColor)
                .lineLimit(1)
            Rectangle()
                .fill(Color.accentColor.opacity(0.75))
                .frame(height: 1)
        }
        .padding(.vertical, 2)
        .accessibilityLabel("New messages")
    }
}

private struct TimelineProjection {
    let rows: [TimelineRow]
    let jobsByRunID: [String: ZJob]
}

private enum TimelineRows {
    private final class Entry: NSObject {
        let projection: TimelineProjection

        init(_ projection: TimelineProjection) {
            self.projection = projection
        }
    }

    nonisolated(unsafe) private static let cache: NSCache<NSString, Entry> = {
        let cache = NSCache<NSString, Entry>()
        cache.countLimit = 80
        return cache
    }()

    private static let traceTypes: Set<String> = [
        "reasoning_summary",
        "tool_started",
        "tool_finished",
        "idle_warning",
        "raw_event",
        "process_started",
        "provider_session",
        "cwd_fallback",
        "history_imported",
        "backend_changed",
        "artifact_error",
        "session_created"
    ]

    static func project(from events: [ZEvent]) -> TimelineProjection {
        let key = cacheKey(for: events)
        if let cached = cache.object(forKey: key) {
            return cached.projection
        }

        let jobRuns = jobRunsByRunID(events)
        let rows = buildRows(from: events, jobRuns: jobRuns)
        let projection = TimelineProjection(rows: rows, jobsByRunID: jobRuns.mapValues(\.job))
        cache.setObject(Entry(projection), forKey: key)
        return projection
    }

    static func build(from events: [ZEvent]) -> [TimelineRow] {
        project(from: events).rows
    }

    private static func buildRows(from events: [ZEvent], jobRuns: [String: JobRunRow]) -> [TimelineRow] {
        let jobRunIDs = Set(jobRuns.keys)
        var rows: [TimelineRow] = []
        var orphanTrace: [ZEvent] = []
        var activeRunID: String?
        var activeAssistantEvents: [ZEvent] = []
        var activeFinishedEvent: ZEvent?
        var activeTrace: [ZEvent] = []
        var pendingJobRuns: [JobRunRow] = []

        func appendTrace(_ events: [ZEvent], prefix: String = "trace") {
            guard let first = events.first, let last = events.last else { return }
            rows.append(TimelineRow(id: "\(prefix)-\(first.seq)-\(last.seq)", kind: .trace(events)))
        }

        func flushOrphanTrace() {
            appendTrace(orphanTrace)
            orphanTrace.removeAll(keepingCapacity: true)
        }

        func mergedAssistantEvent() -> ZEvent? {
            guard var merged = activeAssistantEvents.last else { return activeFinishedEvent }
            let text = activeAssistantEvents
                .compactMap { $0.text?.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty }
                .joined(separator: "\n\n")
            merged.text = text
            return merged
        }

        func flushAgentRun() {
            if let assistant = mergedAssistantEvent() {
                rows.append(TimelineRow(id: "assistant-run-\(activeRunID ?? assistant.id)-\(assistant.seq)", kind: .event(assistant)))
            }
            appendTrace(activeTrace, prefix: "trace-run-\(activeRunID ?? "unknown")")
            activeRunID = nil
            activeAssistantEvents.removeAll(keepingCapacity: true)
            activeFinishedEvent = nil
            activeTrace.removeAll(keepingCapacity: true)
        }

        func flushJobRuns() {
            guard !pendingJobRuns.isEmpty else { return }
            if pendingJobRuns.count == 1, let run = pendingJobRuns.first {
                rows.append(TimelineRow(id: "job-\(run.id)-\(run.lastSeq)", kind: .job(run)))
            } else {
                let group = JobRunGroupRow(runs: pendingJobRuns)
                rows.append(TimelineRow(id: "job-group-\(group.id)", kind: .jobGroup(group)))
            }
            pendingJobRuns.removeAll(keepingCapacity: true)
        }

        func appendJobRun(_ run: JobRunRow) {
            if let previous = pendingJobRuns.last, previous.job.id != run.job.id {
                flushJobRuns()
            }
            pendingJobRuns.append(run)
        }

        func beginAgentRunIfNeeded(for event: ZEvent) {
            guard let runID = event.run_id else { return }
            if activeRunID == nil {
                activeRunID = runID
            } else if activeRunID != runID {
                flushAgentRun()
                activeRunID = runID
            }
        }

        for event in events {
            if event.type == "job_ran", let runID = event.run_id, let jobRun = jobRuns[runID] {
                flushAgentRun()
                flushOrphanTrace()
                appendJobRun(jobRun)
                continue
            }
            if shouldFoldIntoJobResponse(event, jobRunIDs: jobRunIDs) {
                flushAgentRun()
                flushOrphanTrace()
                continue
            }
            flushJobRuns()

            if event.type == "turn_started" {
                flushAgentRun()
                flushOrphanTrace()
                rows.append(TimelineRow(id: event.id, kind: .event(event)))
                activeRunID = event.run_id
                continue
            }

            if event.type == "assistant_text", event.run_id != nil {
                beginAgentRunIfNeeded(for: event)
                if event.text?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false {
                    activeAssistantEvents.append(event)
                }
                continue
            }

            if traceTypes.contains(event.type), event.run_id != nil {
                beginAgentRunIfNeeded(for: event)
                activeTrace.append(event)
                continue
            }

            if event.type == "turn_finished", event.run_id != nil {
                beginAgentRunIfNeeded(for: event)
                if activeAssistantEvents.isEmpty,
                   event.result_text?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false {
                    activeFinishedEvent = event
                }
                flushAgentRun()
                continue
            }

            if event.run_id != nil {
                flushAgentRun()
            }

            if traceTypes.contains(event.type) {
                orphanTrace.append(event)
            } else {
                flushOrphanTrace()
                rows.append(TimelineRow(id: event.id, kind: .event(event)))
            }
        }
        flushJobRuns()
        flushAgentRun()
        flushOrphanTrace()
        return rows
    }

    static func jobsByRunID(_ events: [ZEvent]) -> [String: ZJob] {
        project(from: events).jobsByRunID
    }

    static func jobRunsByRunID(_ events: [ZEvent]) -> [String: JobRunRow] {
        var rows: [String: JobRunRow] = [:]
        var assistantText: [String: [String]] = [:]
        var errors: [String: [String]] = [:]
        var startedAt: [String: String] = [:]
        var finishedAt: [String: String] = [:]
        var lastEventAt: [String: String] = [:]

        for event in events {
            guard let runID = event.run_id else { continue }
            lastEventAt[runID] = event.ts
            switch event.type {
            case "turn_started":
                startedAt[runID] = event.ts
            case "process_started":
                if startedAt[runID] == nil {
                    startedAt[runID] = event.ts
                }
            case "job_ran":
                if let job = event.job {
                    rows[runID] = JobRunRow(
                        id: runID,
                        runEvent: event,
                        job: job,
                        resultText: nil,
                        errorText: nil,
                        isFinished: false,
                        startedAt: startedAt[runID] ?? event.ts,
                        finishedAt: nil,
                        lastEventAt: event.ts,
                        lastSeq: event.seq
                    )
                }
            case "assistant_text":
                if let text = event.text?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty {
                    assistantText[runID, default: []].append(text)
                }
            case "turn_finished":
                finishedAt[runID] = event.ts
                if var existing = rows[runID] {
                    let result = event.result_text?.trimmingCharacters(in: .whitespacesAndNewlines)
                    existing.resultText = result?.isEmpty == false ? result : assistantText[runID]?.joined(separator: "\n\n")
                    existing.isFinished = true
                    existing.finishedAt = event.ts
                    existing.lastEventAt = event.ts
                    existing.lastSeq = max(existing.lastSeq, event.seq)
                    rows[runID] = existing
                }
            case "error":
                let message = (event.message ?? event.error ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                if !message.isEmpty {
                    errors[runID, default: []].append(message)
                }
            default:
                break
            }
        }

        for (runID, textParts) in assistantText {
            guard var row = rows[runID], row.resultText?.isEmpty != false else { continue }
            let text = textParts.joined(separator: "\n\n").trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty {
                row.resultText = text
                rows[runID] = row
            }
        }

        for (runID, errorParts) in errors {
            guard var row = rows[runID] else { continue }
            row.errorText = errorParts.joined(separator: "\n\n")
            rows[runID] = row
        }

        for runID in rows.keys {
            guard var row = rows[runID] else { continue }
            row.startedAt = startedAt[runID] ?? row.startedAt ?? row.runEvent.ts
            row.finishedAt = finishedAt[runID] ?? row.finishedAt
            row.lastEventAt = lastEventAt[runID] ?? row.lastEventAt ?? row.finishedAt ?? row.runEvent.ts
            rows[runID] = row
        }

        return rows
    }

    private static func shouldFoldIntoJobResponse(_ event: ZEvent, jobRunIDs: Set<String>) -> Bool {
        guard let runID = event.run_id, jobRunIDs.contains(runID) else { return false }
        switch event.type {
        case "turn_started",
             "assistant_text",
             "process_started",
             "provider_session",
             "reasoning_summary",
             "tool_started",
             "tool_finished",
             "raw_event",
             "idle_warning",
             "cwd_fallback",
             "turn_finished",
             "error":
            return true
        default:
            return false
        }
    }

    private static func cacheKey(for events: [ZEvent]) -> NSString {
        guard let first = events.first, let last = events.last else {
            return "empty" as NSString
        }
        let middle = events.count > 2 ? events[events.count / 2] : last
        return "\(events.count):\(first.seq):\(first.id):\(middle.seq):\(middle.id):\(last.seq):\(last.id)" as NSString
    }
}

struct JobRunRow: Identifiable, Hashable {
    let id: String
    let runEvent: ZEvent
    let job: ZJob
    var resultText: String?
    var errorText: String?
    var isFinished: Bool
    var startedAt: String?
    var finishedAt: String?
    var lastEventAt: String?
    var lastSeq: Int
}

struct JobRunGroupRow: Identifiable, Hashable {
    let id: String
    let runs: [JobRunRow]

    init(runs: [JobRunRow]) {
        self.runs = runs
        let first = runs.first
        let last = runs.last
        self.id = "\(last?.job.id ?? "job")-\(first?.runEvent.seq ?? 0)-\(last?.lastSeq ?? 0)-\(runs.count)"
    }

    var latest: JobRunRow {
        runs[runs.count - 1]
    }

    var olderNewestFirst: [JobRunRow] {
        Array(runs.dropLast().reversed())
    }
}

private struct TimelineHistoryLoader: View {
    @EnvironmentObject private var store: AppStore
    let hiddenRenderedRowCount: Int
    let onShowOlderRows: () -> Void
    let onLoadOlder: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "clock.arrow.circlepath")
            Text("Showing latest messages")
            Text("\(totalOlderCount) older hidden")
                .foregroundStyle(.secondary)
            Spacer()
            if hiddenRenderedRowCount > 0 {
                Button {
                    onShowOlderRows()
                } label: {
                    Label("Show Older", systemImage: "arrow.up.circle")
                }
                .buttonStyle(.bordered)
                .help("Show the previous rendered page")
            } else if store.loadedHistoryLimitReached {
                Text("Loaded window limit")
                    .foregroundStyle(.secondary)
            } else if store.isLoadingOlderHistory {
                ProgressView()
                    .controlSize(.small)
                Text("Loading")
                    .foregroundStyle(.secondary)
            } else {
                Button {
                    onLoadOlder()
                } label: {
                    Label("Load Older", systemImage: "arrow.up.circle")
                }
                .buttonStyle(.bordered)
                .disabled(!store.canLoadOlderHistory)
                .help("Load the previous page of chat history")
            }
        }
        .font(.caption)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Theme.card)
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.softLine))
    }

    private var totalOlderCount: Int {
        store.hiddenDisplayEventCount + hiddenRenderedRowCount
    }
}

struct HeaderView: View {
    @EnvironmentObject private var store: AppStore
    @Binding var importerOpen: Bool
    @Binding var resumeOpen: Bool
    @Binding var serverSettingsOpen: Bool
    @State private var draftTitle = ""
    @AppStorage("chatFontSize") private var chatFontSize = 14.0
    @AppStorage("chatFontDesign") private var chatFontDesign = "default"

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(alignment: .center, spacing: 12) {
                titleBlock
                    .frame(minWidth: 0, maxWidth: .infinity, alignment: .leading)
                    .layoutPriority(1)

                ServerConnectionToolbarButton(isPresented: $serverSettingsOpen)
                    .layoutPriority(3)
            }

            HStack(spacing: 10) {
                ViewThatFits(in: .horizontal) {
                    headerControls
                    headerActionsMenu
                }
                .layoutPriority(2)
                Spacer(minLength: 0)
            }
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 10)
        .frame(minHeight: 94)
        .background(Theme.panel)
        .onAppear { syncTitle() }
        .onChange(of: store.selectedSessionID) { syncTitle() }
        .onChange(of: store.selectedSession?.title) { syncTitle() }
    }

    private var titleBlock: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Image(systemName: "pencil")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                TextField("Chat title", text: $draftTitle)
                    .textFieldStyle(.plain)
                    .font(.title3.weight(.semibold))
                    .lineLimit(1)
                    .onSubmit { saveTitle() }
                Button {
                    saveTitle()
                } label: {
                    Label("Save Name", systemImage: "checkmark.circle.fill")
                }
                .buttonStyle(.borderless)
                .labelStyle(.iconOnly)
                .disabled(store.selectedSession == nil || draftTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .help("Save the chat title")
            }
            .padding(.horizontal, 9)
            .padding(.vertical, 6)
            .background(Theme.card)
            .clipShape(RoundedRectangle(cornerRadius: 7))
            .overlay(RoundedRectangle(cornerRadius: 7).stroke(Theme.softLine))
            Text(sessionSubtitle)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
        }
    }

    private var headerControls: some View {
        HStack(spacing: 8) {
            refreshButton
            resumeButton
            attachButton
            forkButton
            stopButton
            Divider()
                .frame(height: 18)
            pinButton
            traceToggle
            fontMenu
        }
        .lineLimit(1)
        .controlSize(.small)
        .labelStyle(.iconOnly)
    }

    private var headerActionsMenu: some View {
        Menu {
            refreshButton
            resumeButton
            attachButton
            forkButton
            stopButton
            pinButton
            traceToggle
            fontMenu
        } label: {
            Label("Actions", systemImage: "ellipsis.circle")
        }
        .controlSize(.small)
        .fixedSize()
        .help("Chat actions")
    }

    private var refreshButton: some View {
        Button {
            Task { await store.refresh() }
        } label: {
            Label("Refresh", systemImage: "arrow.clockwise")
        }
        .help("Refresh server status, chats, and jobs")
    }

    private var resumeButton: some View {
        Button {
            resumeOpen = true
        } label: {
            Label("Resume by ID", systemImage: "arrow.uturn.forward.circle")
        }
        .help("Create a chat from an existing Claude or Codex session ID")
    }

    private var attachButton: some View {
        Button {
            importerOpen = true
        } label: {
            Label("Attach Files", systemImage: "paperclip")
        }
        .disabled(store.selectedSession == nil)
        .help("Attach files to the selected chat")
    }

    private var forkButton: some View {
        Button {
            Task { await store.forkSelected() }
        } label: {
            Label("Fork Chat", systemImage: "arrow.triangle.branch")
        }
        .disabled(store.selectedSession == nil)
        .help("Create a new chat from the selected chat")
    }

    private var stopButton: some View {
        Button(role: .destructive) {
            Task { await store.stop() }
        } label: {
            Label("Stop Agent", systemImage: "stop.circle")
        }
        .disabled(!store.isRunning)
        .help("Stop the currently running Claude or Codex turn")
    }

    @ViewBuilder
    private var pinButton: some View {
        if let session = store.selectedSession {
            Button {
                Task { await store.togglePin(session) }
            } label: {
                Label(session.pinned == true ? "Unpin" : "Pin", systemImage: session.pinned == true ? "pin.fill" : "pin")
            }
            .buttonStyle(.borderless)
            .help(session.pinned == true ? "Unpin chat" : "Pin chat")
        }
    }

    private var traceToggle: some View {
        Toggle(isOn: $store.showDebugEvents) {
            Label("Trace", systemImage: "waveform.path.ecg")
        }
        .toggleStyle(.button)
        .help("Show or hide raw process events")
    }

    private var fontMenu: some View {
        Menu {
            Picker("Typeface", selection: $chatFontDesign) {
                Text("System").tag("default")
                Text("Rounded").tag("rounded")
                Text("Serif").tag("serif")
                Text("Mono").tag("monospaced")
            }
            Divider()
            Picker("Text Size", selection: $chatFontSize) {
                Text("Small").tag(13.0)
                Text("Default").tag(14.0)
                Text("Large").tag(16.0)
                Text("Huge").tag(18.0)
            }
        } label: {
            Label("Font", systemImage: "textformat.size")
        }
        .help("Change chat font")
    }

    private var sessionSubtitle: String {
        guard let session = store.selectedSession else { return "No chat selected" }
        if let provider = session.session_id, !provider.isEmpty {
            return "\(store.runtimeCatalog.compactSummary(for: session)) · session \(String(provider.prefix(12)))"
        }
        return "\(store.runtimeCatalog.compactSummary(for: session)) · \(session.folder ?? "General") · \(session.cwd ?? store.defaultCwd)"
    }

    private func syncTitle() {
        draftTitle = store.selectedSession?.title ?? ""
    }

    private func saveTitle() {
        let title = draftTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty else { return }
        Task { await store.updateSelected(title: title) }
    }
}
