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
    @State private var pendingOpenBottomSessionID: String?
    @State private var initialTimelineRevealRevision = 0
    @State private var showTimelinePositioningOverlay = false
    @State private var timelinePositioningOverlayRevision = 0
    @State private var timelinePositioningOverlayTask: Task<Void, Never>?
    private let bottomID = "timeline-bottom"
    private let coordinateSpaceName = "timelineScroll"
    private let defaultVisibleRowLimit = 100
    private let rowPageSize = 40
    private let bottomButtonHideDistance: CGFloat = 180
    private let timelinePositioningOverlayDelayNanos: UInt64 = 180_000_000

    private struct TimelineScrollAnchor {
        let rowID: String
        let eventID: String?
    }

    var body: some View {
        let hasWarmSelectedTimeline = store.loadedSessionID == store.selectedSessionID && !store.displayEvents.isEmpty
        let timelineRowsSuspended = isInitialTimelineMasked && !hasWarmSelectedTimeline && (
            store.isSelectingSession ||
            store.loadedSessionID != store.selectedSessionID
        )
        let shouldHideLargeTimelineBatch = store.isApplyingLargeTimelineBatch && !(store.isRefreshingCachedDelta && hasWarmSelectedTimeline)
        let timelineRowsStructurallySuspended = timelineRowsSuspended || shouldHideLargeTimelineBatch
        let shouldMaskTimeline = timelineRowsStructurallySuspended
        let displayEvents = timelineRowsStructurallySuspended ? [] : store.displayEvents
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
                                if !timelineRowsStructurallySuspended && (store.hiddenDisplayEventCount > 0 || hiddenRenderedRowCount > 0) {
                                    TimelineHistoryLoader(hiddenRenderedRowCount: hiddenRenderedRowCount) {
                                        revealOlderRowsShowingNewPage(proxy)
                                    } onLoadOlder: {
                                        loadOlderHistoryFromIntent(proxy)
                                    }
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
                                    case .artifacts(let events):
                                        ArtifactGridCard(
                                            artifacts: events.compactMap { event in
                                                event.artifact.map { ArtifactGridItem(file: $0, url: store.fileURL($0)) }
                                            },
                                            linkContext: linkContext
                                        )
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
                            TimelineScrollObserver(
                                forceBottomRevision: store.forcedScrollToBottomRevision
                            ) { metrics in
                                updateBottomVisibility(metrics)
                                handleHistoryTopDistance(
                                    metrics.distanceFromTop,
                                    hasHiddenRenderedRows: hiddenRenderedRowCount > 0,
                                    proxy: proxy
                                )
                            }
                        )
                    }
                    .opacity(shouldMaskTimeline ? 0 : 1)
                    .coordinateSpace(name: coordinateSpaceName)
                    if shouldMaskTimeline, store.selectedSession != nil, showTimelinePositioningOverlay {
                        TimelinePositioningOverlay()
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                            .allowsHitTesting(false)
                    }
                    if !shouldMaskTimeline && isTimelineScrollable && (!isNearBottom || store.selectedSessionHasUnread) && !displayEvents.isEmpty {
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
                    let sessionID = store.selectedSessionID
                    if shouldFollowBottomRequest {
                        scrollToBottom(proxy)
                        settleBottomAfterLayout(proxy, sessionID: sessionID)
                    }
                    settleInitialTimelinePosition(proxy)
                }
                .onChange(of: store.forcedScrollToBottomRevision) {
                    forceOpenThreadToLatest(proxy)
                }
                .onChange(of: store.scrollToEventRevision) {
                    scrollToRequestedEvent(proxy)
                }
                .onChange(of: store.selectedSessionID) {
                    beginInitialTimelineMask()
                    pendingOpenBottomSessionID = store.selectedSessionID
                    isAtBottom = true
                    isNearBottom = true
                    store.setSelectedTimelineAtBottom(true)
                    isTimelineScrollable = false
                    disarmAutomaticOlderHistoryLoad()
                    suppressHistoryLoading(for: 1.4)
                    visibleRowLimit = defaultVisibleRowLimit
                    lastObservedEventSeq = maxEventSeq(displayEvents)
                    store.markSelectedSessionRead()
                    settleOpenThreadAtLatest(proxy)
                    settleInitialTimelinePosition(proxy)
                }
                .onChange(of: shouldMaskTimeline) { _, masked in
                    updateTimelinePositioningOverlay(masked: masked)
                }
                .onChange(of: displayEvents.count) { oldCount, newCount in
                    let previousObservedSeq = lastObservedEventSeq
                    let shouldFollowLiveEvent = shouldAutoFollowLiveEvent(after: previousObservedSeq)
                    let rowCount = max(allRows.count, min(displayEvents.count, visibleRowLimit))
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
                    if settleOpenThreadAtLatest(proxy) {
                        return
                    } else if shouldFollowLiveEvent {
                        scrollToBottom(proxy)
                        settleBottomAfterLayout(proxy, sessionID: store.selectedSessionID)
                        store.markSelectedSessionRead(force: true)
                    } else {
                        settleInitialTimelinePosition(proxy)
                    }
                }
                .onChange(of: displaySignature) {
                    _ = settleOpenThreadAtLatest(proxy)
                    settleInitialTimelinePosition(proxy)
                }
                .onChange(of: store.loadedSessionID) {
                    _ = settleOpenThreadAtLatest(proxy)
                    settleInitialTimelinePosition(proxy)
                }
                .onChange(of: store.isSelectingSession) {
                    if !store.isSelectingSession {
                        _ = settleOpenThreadAtLatest(proxy)
                        settleInitialTimelinePosition(proxy)
                    }
                }
                .onChange(of: store.isRefreshingCachedDelta) {
                    if !store.isRefreshingCachedDelta {
                        _ = settleOpenThreadAtLatest(proxy)
                        settleInitialTimelinePosition(proxy)
                    }
                }
                .onChange(of: store.isApplyingLargeTimelineBatch) {
                    if !store.isApplyingLargeTimelineBatch {
                        _ = settleOpenThreadAtLatest(proxy)
                        settleInitialTimelinePosition(proxy)
                    }
                }
                .onChange(of: store.hiddenDisplayEventCount) {
                    if store.hiddenDisplayEventCount <= 0 {
                        olderHistoryLoadArmed = false
                        suppressScrollHistoryLoadUntilTopLeaves = false
                    }
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
            updateTimelinePositioningOverlay(masked: shouldMaskTimeline)
        }
        .onDisappear {
            timelinePositioningOverlayTask?.cancel()
            timelinePositioningOverlayTask = nil
        }
    }

    private func beginInitialTimelineMask() {
        initialTimelineRevealRevision += 1
        maskedSessionID = store.selectedSessionID
        hideTimelinePositioningOverlay()
        isInitialTimelineMasked = store.selectedSessionID != nil && !hasWarmSelectedTimeline
        updateTimelinePositioningOverlay(masked: isInitialTimelineMasked)
    }

    private func settleInitialTimelinePosition(_ proxy: ScrollViewProxy) {
        guard isInitialTimelineMasked,
              let sessionID = maskedSessionID,
              sessionID == store.selectedSessionID else {
            return
        }
        let hasWarmSelectedTimeline = store.loadedSessionID == sessionID && !store.displayEvents.isEmpty
        if hasWarmSelectedTimeline {
            scrollToBottom(proxy)
            settleBottomAfterLayout(proxy, sessionID: sessionID)
            withTransaction(noAnimationTransaction) {
                isInitialTimelineMasked = false
            }
            return
        }
        guard !store.isSelectingSession || hasWarmSelectedTimeline else { return }
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

    @discardableResult
    private func settleOpenThreadAtLatest(_ proxy: ScrollViewProxy) -> Bool {
        guard let pendingSessionID = pendingOpenBottomSessionID,
              pendingSessionID == store.selectedSessionID,
              canSettleOpenThreadRows else {
            return false
        }
        pendingOpenBottomSessionID = nil
        suppressHistoryLoading(for: 2.4)
        disarmAutomaticOlderHistoryLoad()
        store.markSelectedSessionRead(force: true)
        if isInitialTimelineMasked {
            withTransaction(noAnimationTransaction) {
                isInitialTimelineMasked = false
            }
        }
        scrollToBottom(proxy)
        settleBottomAfterLayout(proxy, sessionID: pendingSessionID)
        AppLogger.info("open latest settled session=\(pendingSessionID) events=\(store.displayEvents.count) visible_limit=\(visibleRowLimit)")
        return true
    }

    private func forceOpenThreadToLatest(_ proxy: ScrollViewProxy) {
        guard let sessionID = store.selectedSessionID else {
            return
        }
        pendingOpenBottomSessionID = sessionID
        suppressHistoryLoading(for: 2.4)
        disarmAutomaticOlderHistoryLoad()
        visibleRowLimit = defaultVisibleRowLimit
        guard canSettleOpenThreadRows else {
            AppLogger.info("force latest deferred session=\(sessionID) events=\(store.displayEvents.count) applying_batch=\(store.isApplyingLargeTimelineBatch) masked=\(isInitialTimelineMasked)")
            return
        }
        store.markSelectedSessionRead(force: true)
        if isInitialTimelineMasked {
            withTransaction(noAnimationTransaction) {
                isInitialTimelineMasked = false
            }
        }
        scrollToBottom(proxy)
        settleBottomAfterLayout(proxy, sessionID: sessionID)
        AppLogger.info("force latest settled session=\(sessionID) events=\(store.displayEvents.count) visible_limit=\(visibleRowLimit)")
    }

    private func initialTimelineMaskIsCurrent(revision: Int, sessionID: String) -> Bool {
        isInitialTimelineMasked &&
            initialTimelineRevealRevision == revision &&
            maskedSessionID == sessionID &&
            store.selectedSessionID == sessionID
    }

    private func scrollToBottom(_ proxy: ScrollViewProxy, animated: Bool = false) {
        guard !store.displayEvents.isEmpty else { return }
        suppressHistoryLoading(for: 0.45)
        disarmAutomaticOlderHistoryLoad()
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

    private func suppressHistoryLoading(for interval: TimeInterval) {
        let until = Date().addingTimeInterval(interval)
        if until > historyLoadSuppressedUntil {
            historyLoadSuppressedUntil = until
        }
    }

    private func settleBottomAfterLayout(_ proxy: ScrollViewProxy, sessionID: String?) {
        guard let sessionID else { return }
        for delay in [0.04, 0.16, 0.36, 0.75, 1.25] {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
                guard store.selectedSessionID == sessionID else { return }
                withTransaction(noAnimationTransaction) {
                    scrollToBottom(proxy)
                }
            }
        }
    }

    private var shouldFollowBottomRequest: Bool {
        isAtBottom || isNearBottom || store.selectedTimelineAtBottom || store.isRunning
    }

    private var hasWarmSelectedTimeline: Bool {
        store.loadedSessionID == store.selectedSessionID && !store.displayEvents.isEmpty
    }

    private var canSettleOpenThreadRows: Bool {
        guard !store.displayEvents.isEmpty else { return false }
        guard !store.isApplyingLargeTimelineBatch else { return false }
        guard !(isInitialTimelineMasked && !hasWarmSelectedTimeline) else { return false }
        return true
    }

    private func shouldAutoFollowLiveEvent(after previousSeq: Int) -> Bool {
        false
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
            if row.containsEventID(eventID) {
                return (row.id, index)
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

    private func handleHistoryTopDistance(_ distanceFromTop: CGFloat, hasHiddenRenderedRows: Bool, proxy: ScrollViewProxy) {
        guard store.hiddenDisplayEventCount > 0 || hasHiddenRenderedRows else {
            olderHistoryLoadArmed = false
            suppressScrollHistoryLoadUntilTopLeaves = false
            return
        }
        let topIsVisible = distanceFromTop <= 96
        let topHasLeftViewport = distanceFromTop > 160

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
        if revealOlderRowsShowingNewPage(proxy) {
            olderHistoryLoadArmed = false
            suppressScrollHistoryLoadUntilTopLeaves = true
            return
        }
        guard store.canLoadOlderHistory else { return }
        olderHistoryLoadArmed = false
        suppressScrollHistoryLoadUntilTopLeaves = true
        loadOlderHistoryPreservingPosition(proxy)
    }

    private func disarmAutomaticOlderHistoryLoad() {
        olderHistoryLoadArmed = false
        suppressScrollHistoryLoadUntilTopLeaves = true
    }

    private func loadOlderHistoryFromIntent(_ proxy: ScrollViewProxy) {
        if revealOlderRowsShowingNewPage(proxy) {
            olderHistoryLoadArmed = false
            suppressScrollHistoryLoadUntilTopLeaves = true
            return
        }
        guard store.canLoadOlderHistory else { return }
        olderHistoryLoadArmed = false
        suppressScrollHistoryLoadUntilTopLeaves = true
        loadOlderHistoryShowingNewPage(proxy)
    }

    @discardableResult
    private func revealOlderRows(preservingPositionWith proxy: ScrollViewProxy) -> Bool {
        let anchor = firstRenderedAnchor()
        let rowCount = renderedRows(visibleLimit: visibleRowLimit + rowPageSize).count
        guard visibleRowLimit < rowCount else { return false }
        setVisibleRowLimit(min(rowCount, visibleRowLimit + rowPageSize))
        restoreScrollPosition(to: anchor, proxy: proxy)
        return true
    }

    @discardableResult
    private func revealOlderRowsShowingNewPage(_ proxy: ScrollViewProxy) -> Bool {
        let oldLimit = visibleRowLimit
        let rows = renderedRows(visibleLimit: visibleRowLimit + rowPageSize)
        guard visibleRowLimit < rows.count else { return false }
        let nextLimit = min(rows.count, visibleRowLimit + rowPageSize)
        let target = Array(rows.suffix(nextLimit)).first
        setVisibleRowLimit(nextLimit)
        AppLogger.info("show older rows old_limit=\(oldLimit) new_limit=\(nextLimit) rendered_rows=\(rows.count) target=\(target?.id ?? "-") hidden_before=\(store.hiddenDisplayEventCount)")
        scrollToOlderPageTarget(target?.id, proxy: proxy)
        return true
    }

    private func scrollToOlderPageTarget(_ rowID: String?, proxy: ScrollViewProxy) {
        guard let rowID else { return }
        historyLoadSuppressedUntil = Date().addingTimeInterval(0.45)
        for delay in [0.0, 0.06, 0.18] {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
                withTransaction(noAnimationTransaction) {
                    proxy.scrollTo(rowID, anchor: .top)
                }
                isAtBottom = false
                isNearBottom = false
                store.setSelectedTimelineAtBottom(false)
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) {
            olderHistoryLoadArmed = true
            suppressScrollHistoryLoadUntilTopLeaves = false
        }
    }

    private func loadOlderHistoryPreservingPosition(_ proxy: ScrollViewProxy) {
        let anchor = firstRenderedAnchor()
        let oldLimit = visibleRowLimit
        let beforeRowCount = renderedRows().count
        Task {
            let result = await store.loadOlderHistory()
            if result.addedCount > 0 {
                let allRows = renderedRows()
                let target = olderHistoryTarget(
                    firstAddedEventID: result.firstAddedEventID,
                    anchor: anchor,
                    rows: allRows,
                    preferredLimit: max(visibleRowLimit, oldLimit) + rowPageSize
                )
                let afterRowCount = allRows.count
                let nextLimit = olderHistoryVisibleLimit(
                    for: target,
                    rows: allRows,
                    preferredLimit: max(visibleRowLimit, oldLimit) + rowPageSize
                )
                if nextLimit > visibleRowLimit {
                    setVisibleRowLimit(nextLimit)
                }
                AppLogger.info("auto older loaded added_events=\(result.addedCount) first_added=\(result.firstAddedEventID ?? "-") old_limit=\(oldLimit) new_limit=\(nextLimit) old_rows=\(beforeRowCount) rendered_rows=\(afterRowCount) target=\(target?.id ?? "-") anchor=\(anchor?.rowID ?? "-") hidden_before=\(store.hiddenDisplayEventCount)")
                scrollToOlderPageTarget(target?.id, proxy: proxy)
                return
            }
            restoreScrollPosition(to: anchor, proxy: proxy)
        }
    }

    private func loadOlderHistoryShowingNewPage(_ proxy: ScrollViewProxy) {
        let beforeRowCount = renderedRows().count
        Task {
            let result = await store.loadOlderHistory()
            let allRows = renderedRows()
            let target = olderHistoryTarget(
                firstAddedEventID: result.firstAddedEventID,
                anchor: nil,
                rows: allRows,
                preferredLimit: visibleRowLimit + rowPageSize
            )
            var nextLimit = visibleRowLimit
            let addedRows = max(0, allRows.count - beforeRowCount)
            guard !allRows.isEmpty else { return }
            if result.addedCount > 0 {
                let revealCount = max(rowPageSize, addedRows)
                nextLimit = olderHistoryVisibleLimit(
                    for: target,
                    rows: allRows,
                    preferredLimit: visibleRowLimit + revealCount
                )
                setVisibleRowLimit(nextLimit)
            }
            AppLogger.info("load older intent added_events=\(result.addedCount) first_added=\(result.firstAddedEventID ?? "-") added_rows=\(addedRows) old_rows=\(beforeRowCount) rendered_rows=\(allRows.count) next_limit=\(nextLimit) target=\(target?.id ?? "-")")
            scrollToOlderPageTarget(target?.id, proxy: proxy)
        }
    }

    private func olderHistoryTarget(
        firstAddedEventID: String?,
        anchor: TimelineScrollAnchor?,
        rows: [TimelineRow],
        preferredLimit: Int
    ) -> (id: String, index: Int)? {
        if let firstAddedEventID,
           let target = row(containingEventID: firstAddedEventID, in: rows) {
            return target
        }
        if let fallback = firstNewOlderRow(before: anchor, in: rows),
           let index = rows.firstIndex(where: { $0.id == fallback.id }) {
            return (fallback.id, index)
        }
        let visibleRows = Array(rows.suffix(preferredLimit))
        guard let row = visibleRows.first,
              let index = rows.firstIndex(where: { $0.id == row.id }) else {
            return nil
        }
        return (row.id, index)
    }

    private func olderHistoryVisibleLimit(
        for target: (id: String, index: Int)?,
        rows: [TimelineRow],
        preferredLimit: Int
    ) -> Int {
        guard !rows.isEmpty else { return 0 }
        guard let target else {
            return min(rows.count, preferredLimit)
        }
        let rowsNeeded = rows.count - target.index
        return min(rows.count, max(preferredLimit, rowsNeeded + 2))
    }

    private func firstRenderedAnchor() -> TimelineScrollAnchor? {
        let rows = renderedRows()
        guard let row = Array(rows.suffix(visibleRowLimit)).first else { return nil }
        return TimelineScrollAnchor(rowID: row.id, eventID: row.anchorEventID)
    }

    private func firstNewOlderRow(before anchor: TimelineScrollAnchor?, in rows: [TimelineRow]) -> TimelineRow? {
        guard let anchor else { return rows.first }
        let anchorIndex: Int?
        if let index = rows.firstIndex(where: { $0.id == anchor.rowID }) {
            anchorIndex = index
        } else if let eventID = anchor.eventID,
                  let row = row(containingEventID: eventID, in: rows) {
            anchorIndex = row.index
        } else {
            anchorIndex = nil
        }
        guard let anchorIndex, anchorIndex > 0 else { return rows.first }
        return rows[max(0, anchorIndex - rowPageSize)]
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
        for delay in [0.0, 0.06, 0.18] {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
                withTransaction(noAnimationTransaction) {
                    proxy.scrollTo(rowID, anchor: .top)
                }
                isAtBottom = false
                isNearBottom = false
                store.setSelectedTimelineAtBottom(false)
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) {
            olderHistoryLoadArmed = true
            suppressScrollHistoryLoadUntilTopLeaves = false
        }
    }

    private func restoredRowID(for anchor: TimelineScrollAnchor) -> String {
        let rows = renderedRows()
        if rows.contains(where: { $0.id == anchor.rowID }) {
            return anchor.rowID
        }
        if let eventID = anchor.eventID,
           let row = row(containingEventID: eventID, in: rows) {
            return row.id
        }
        return anchor.rowID
    }

    private func renderedRows(visibleLimit: Int? = nil) -> [TimelineRow] {
        TimelineRows.build(from: store.displayEvents)
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

    private func updateTimelinePositioningOverlay(masked: Bool) {
        timelinePositioningOverlayRevision += 1
        let revision = timelinePositioningOverlayRevision
        timelinePositioningOverlayTask?.cancel()
        guard masked else {
            timelinePositioningOverlayTask = nil
            hideTimelinePositioningOverlay()
            return
        }
        guard !showTimelinePositioningOverlay else { return }
        let delay = timelinePositioningOverlayDelayNanos
        timelinePositioningOverlayTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: delay)
            guard !Task.isCancelled,
                  revision == timelinePositioningOverlayRevision else {
                return
            }
            withTransaction(noAnimationTransaction) {
                showTimelinePositioningOverlay = true
            }
        }
    }

    private func hideTimelinePositioningOverlay() {
        timelinePositioningOverlayTask?.cancel()
        timelinePositioningOverlayTask = nil
        guard showTimelinePositioningOverlay else { return }
        withTransaction(noAnimationTransaction) {
            showTimelinePositioningOverlay = false
        }
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
        guard pendingOpenBottomSessionID == nil else { return }
        let hasNewAgentMessage = store.displayEvents.contains { event in
            event.seq > previousSeq && store.isAgentVisibleMessage(event)
        }
        guard hasNewAgentMessage else { return }
        let firstSeq = store.displayEvents
            .filter { $0.seq > previousSeq && store.isAgentVisibleMessage($0) }
            .map(\.seq)
            .min()
        store.markAgentUnread(sessionID: sessionID, firstSeq: firstSeq)
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

private struct TimelineScrollMetrics: Equatable {
    var viewportHeight: CGFloat
    var contentHeight: CGFloat
    var distanceFromBottom: CGFloat
    var distanceFromTop: CGFloat

    var isScrollable: Bool {
        contentHeight > viewportHeight + 8
    }

    static func == (lhs: TimelineScrollMetrics, rhs: TimelineScrollMetrics) -> Bool {
        abs(lhs.viewportHeight - rhs.viewportHeight) < 0.5 &&
            abs(lhs.contentHeight - rhs.contentHeight) < 0.5 &&
            bottomBucket(lhs.distanceFromBottom) == bottomBucket(rhs.distanceFromBottom) &&
            topBucket(lhs.distanceFromTop) == topBucket(rhs.distanceFromTop)
    }

    private static func bottomBucket(_ distance: CGFloat) -> Int {
        if distance <= 28 { return 0 }
        if distance <= 180 { return 1 }
        return 2
    }

    private static func topBucket(_ distance: CGFloat) -> Int {
        if distance <= 96 { return 0 }
        if distance <= 160 { return 1 }
        return 2
    }
}

private struct TimelineScrollObserver: NSViewRepresentable {
    var forceBottomRevision: Int
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
        context.coordinator.handleForceBottomRevision(forceBottomRevision)
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
        private var lastForceBottomRevision = 0
        private var forceBottomUntil: Date?
        private var forceBottomScrollScheduled = false
        private var lastForceBottomScrollAt: TimeInterval = 0
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
            configureScrollView(nextScrollView)
            let nextDocumentView = nextScrollView.documentView
            if scrollView !== nextScrollView || documentView !== nextDocumentView {
                detach()
                scrollView = nextScrollView
                documentView = nextDocumentView
                observe(nextScrollView, documentView: nextDocumentView)
            }
            scheduleReport()
        }

        private func configureScrollView(_ scrollView: NSScrollView) {
            scrollView.verticalScrollElasticity = .none
            scrollView.horizontalScrollElasticity = .none
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
            forceBottomUntil = nil
            forceBottomScrollScheduled = false
            lastForceBottomScrollAt = 0
        }

        func handleForceBottomRevision(_ revision: Int) {
            guard revision != lastForceBottomRevision else { return }
            lastForceBottomRevision = revision
            forceBottomUntil = Date().addingTimeInterval(2.0)
            scheduleDocumentBottomScroll()
        }

        private func scheduleReport() {
            if shouldForceBottom {
                scheduleDocumentBottomScroll()
            }
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
            clampDocumentOriginIfNeeded(scrollView, documentView: documentView)
            let visibleRect = scrollView.documentVisibleRect
            let documentBounds = documentView.bounds
            let viewportHeight = max(scrollView.contentView.bounds.height, 0)
            let contentHeight = max(documentBounds.height, 0)
            let rawDistance: CGFloat
            let rawDistanceFromTop: CGFloat
            if documentView.isFlipped {
                rawDistance = documentBounds.maxY - visibleRect.maxY
                rawDistanceFromTop = visibleRect.minY - documentBounds.minY
            } else {
                rawDistance = visibleRect.minY - documentBounds.minY
                rawDistanceFromTop = documentBounds.maxY - visibleRect.maxY
            }
            let metrics = TimelineScrollMetrics(
                viewportHeight: viewportHeight,
                contentHeight: contentHeight,
                distanceFromBottom: max(rawDistance, 0),
                distanceFromTop: max(rawDistanceFromTop, 0)
            )
            if metrics.isScrollable && metrics.distanceFromBottom <= 28 {
                forceBottomUntil = nil
            } else if shouldForceBottom {
                scheduleDocumentBottomScroll()
            }
            guard metrics != lastMetrics else { return }
            lastMetrics = metrics
            deliver(metrics)
        }

        private func clampDocumentOriginIfNeeded(_ scrollView: NSScrollView, documentView: NSView) {
            let clipView = scrollView.contentView
            let documentBounds = documentView.bounds
            let viewportSize = clipView.bounds.size
            let minX = documentBounds.minX
            let minY = documentBounds.minY
            let maxX = max(minX, documentBounds.maxX - viewportSize.width)
            let maxY = max(minY, documentBounds.maxY - viewportSize.height)
            let origin = clipView.bounds.origin
            let clamped = NSPoint(
                x: min(max(origin.x, minX), maxX),
                y: min(max(origin.y, minY), maxY)
            )
            guard abs(clamped.x - origin.x) > 0.5 || abs(clamped.y - origin.y) > 0.5 else { return }
            clipView.scroll(to: clamped)
            scrollView.reflectScrolledClipView(clipView)
        }

        private var shouldForceBottom: Bool {
            guard let forceBottomUntil else { return false }
            return Date() < forceBottomUntil
        }

        private func scheduleDocumentBottomScroll() {
            guard !forceBottomScrollScheduled else { return }
            forceBottomScrollScheduled = true
            let now = Date().timeIntervalSinceReferenceDate
            let delay = max(0, 0.08 - (now - lastForceBottomScrollAt))
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                guard let self else { return }
                self.forceBottomScrollScheduled = false
                guard self.shouldForceBottom else { return }
                self.lastForceBottomScrollAt = Date().timeIntervalSinceReferenceDate
                self.scrollDocumentToBottom()
            }
        }

        private func scrollDocumentToBottom() {
            guard let scrollView,
                  let documentView = scrollView.documentView else {
                return
            }
            documentView.layoutSubtreeIfNeeded()
            scrollView.layoutSubtreeIfNeeded()

            let clipView = scrollView.contentView
            let documentBounds = documentView.bounds
            let viewportHeight = clipView.bounds.height
            let targetY: CGFloat
            if documentView.isFlipped {
                targetY = max(documentBounds.minY, documentBounds.maxY - viewportHeight)
            } else {
                targetY = documentBounds.minY
            }
            let target = NSPoint(x: clipView.bounds.minX, y: targetY)
            clipView.scroll(to: target)
            scrollView.reflectScrolledClipView(clipView)
            scheduleReport()
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
        case artifacts([ZEvent])
        case job(JobRunRow)
        case jobGroup(JobRunGroupRow)
        case trace([ZEvent])
    }

    let id: String
    let kind: Kind
    let eventIDs: [String]

    init(id: String, kind: Kind, eventIDs: [String] = []) {
        self.id = id
        self.kind = kind
        self.eventIDs = eventIDs
    }

    var maxSeq: Int {
        switch kind {
        case .event(let event):
            event.seq
        case .artifacts(let events):
            events.map(\.seq).max() ?? 0
        case .job(let jobRun):
            jobRun.lastSeq
        case .jobGroup(let group):
            group.runs.map(\.lastSeq).max() ?? 0
        case .trace(let events):
            events.map(\.seq).max() ?? 0
        }
    }

    var anchorEventID: String? {
        if let eventID = eventIDs.first {
            return eventID
        }
        return switch kind {
        case .event(let event):
            event.id
        case .artifacts(let events):
            events.first?.id ?? events.last?.id
        case .job(let jobRun):
            jobRun.runEvent.id
        case .jobGroup(let group):
            group.runs.first?.runEvent.id
        case .trace(let events):
            events.first?.id ?? events.last?.id
        }
    }

    func containsEventID(_ eventID: String) -> Bool {
        if eventIDs.contains(eventID) {
            return true
        }
        switch kind {
        case .event(let event):
            return event.id == eventID
        case .artifacts(let events):
            return events.contains(where: { $0.id == eventID })
        case .job(let jobRun):
            return jobRun.runEvent.id == eventID
        case .jobGroup(let group):
            return group.runs.contains(where: { $0.runEvent.id == eventID })
        case .trace(let events):
            return events.contains(where: { $0.id == eventID })
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
    private static let assistantRowChunkSize = 8
    private static let traceRowChunkSize = 16
    private static let compactedTraceEventLimit = 96

    static func project(from events: [ZEvent]) -> TimelineProjection {
        let key = cacheKey(for: events)
        if let cached = cache.object(forKey: key) {
            return cached.projection
        }

        let jobRuns = jobRunsByRunID(events)
        let rows = compactAdjacentTraceRows(buildRows(from: events, jobRuns: jobRuns))
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
        var activeArtifactEvents: [ZEvent] = []
        var activeTrace: [ZEvent] = []
        var pendingJobRuns: [JobRunRow] = []

        func appendTrace(_ events: [ZEvent], prefix: String = "trace") {
            var start = events.startIndex
            while start < events.endIndex {
                let end = min(events.endIndex, start + traceRowChunkSize)
                let chunk = Array(events[start..<end])
                if let first = chunk.first, let last = chunk.last {
                    rows.append(TimelineRow(
                        id: "\(prefix)-\(first.seq)-\(last.seq)",
                        kind: .trace(chunk),
                        eventIDs: chunk.map(\.id)
                    ))
                }
                start = end
            }
        }

        func flushOrphanTrace() {
            appendTrace(orphanTrace)
            orphanTrace.removeAll(keepingCapacity: true)
        }

        func mergedAssistantEvent(from events: [ZEvent]) -> ZEvent? {
            guard var merged = events.last else { return nil }
            let text = events
                .compactMap { visibleText($0.text) }
                .joined(separator: "\n\n")
            merged.text = text
            return merged
        }

        func appendAssistantRows() {
            var start = activeAssistantEvents.startIndex
            while start < activeAssistantEvents.endIndex {
                let end = min(activeAssistantEvents.endIndex, start + assistantRowChunkSize)
                let chunk = Array(activeAssistantEvents[start..<end])
                if let assistant = mergedAssistantEvent(from: chunk),
                   let first = chunk.first,
                   let last = chunk.last {
                    rows.append(TimelineRow(
                        id: "assistant-run-\(activeRunID ?? assistant.id)-\(first.seq)-\(last.seq)",
                        kind: .event(assistant),
                        eventIDs: chunk.map(\.id)
                    ))
                }
                start = end
            }
            if activeAssistantEvents.isEmpty, let finished = activeFinishedEvent {
                rows.append(TimelineRow(
                    id: "assistant-run-\(activeRunID ?? finished.id)-\(finished.seq)",
                    kind: .event(finished),
                    eventIDs: [finished.id]
                ))
            }
        }

        func flushAgentRun() {
            appendAssistantRows()
            if let firstArtifact = activeArtifactEvents.first,
               let lastArtifact = activeArtifactEvents.last {
                rows.append(TimelineRow(
                    id: "artifacts-run-\(activeRunID ?? "unknown")-\(firstArtifact.seq)-\(lastArtifact.seq)",
                    kind: .artifacts(activeArtifactEvents),
                    eventIDs: activeArtifactEvents.map(\.id)
                ))
            }
            appendTrace(activeTrace, prefix: "trace-run-\(activeRunID ?? "unknown")")
            activeRunID = nil
            activeAssistantEvents.removeAll(keepingCapacity: true)
            activeFinishedEvent = nil
            activeArtifactEvents.removeAll(keepingCapacity: true)
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
                if hasVisibleText(event.text) {
                    activeAssistantEvents.append(event)
                }
                continue
            }

            if traceTypes.contains(event.type), event.run_id != nil {
                beginAgentRunIfNeeded(for: event)
                activeTrace.append(event)
                continue
            }

            if event.type == "artifact_created" {
                if event.run_id != nil {
                    beginAgentRunIfNeeded(for: event)
                }
                if activeRunID != nil {
                    activeArtifactEvents.append(event)
                    continue
                }
                flushOrphanTrace()
                rows.append(TimelineRow(id: event.id, kind: .event(event)))
                continue
            }

            if event.type == "turn_finished", event.run_id != nil {
                beginAgentRunIfNeeded(for: event)
                if activeAssistantEvents.isEmpty,
                   hasVisibleText(event.result_text) {
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

    private static func compactAdjacentTraceRows(_ rows: [TimelineRow]) -> [TimelineRow] {
        var compacted: [TimelineRow] = []
        var pendingEvents: [ZEvent] = []
        var pendingEventIDs: [String] = []

        func flushPendingTrace() {
            guard !pendingEvents.isEmpty else { return }
            var start = pendingEvents.startIndex
            while start < pendingEvents.endIndex {
                let end = min(pendingEvents.endIndex, start + compactedTraceEventLimit)
                let chunk = Array(pendingEvents[start..<end])
                let chunkIDs = Array(pendingEventIDs[start..<end])
                if let first = chunk.first, let last = chunk.last {
                    compacted.append(TimelineRow(
                        id: "trace-compact-\(first.seq)-\(last.seq)",
                        kind: .trace(chunk),
                        eventIDs: chunkIDs
                    ))
                }
                start = end
            }
            pendingEvents.removeAll(keepingCapacity: true)
            pendingEventIDs.removeAll(keepingCapacity: true)
        }

        for row in rows {
            if case .trace(let events) = row.kind {
                pendingEvents.append(contentsOf: events)
                pendingEventIDs.append(contentsOf: row.eventIDs.isEmpty ? events.map(\.id) : row.eventIDs)
            } else {
                flushPendingTrace()
                compacted.append(row)
            }
        }
        flushPendingTrace()
        return compacted
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
                if let text = visibleText(event.text) {
                    assistantText[runID, default: []].append(text)
                }
            case "turn_finished":
                finishedAt[runID] = event.ts
                if var existing = rows[runID] {
                    let result = visibleText(event.result_text)
                    existing.resultText = result ?? assistantText[runID]?.joined(separator: "\n\n")
                    existing.isFinished = true
                    existing.finishedAt = event.ts
                    existing.lastEventAt = event.ts
                    existing.lastSeq = max(existing.lastSeq, event.seq)
                    rows[runID] = existing
                }
            case "error":
                if let message = visibleText(event.message ?? event.error) {
                    errors[runID, default: []].append(message)
                }
            default:
                break
            }
        }

        for (runID, textParts) in assistantText {
            guard var row = rows[runID], row.resultText?.isEmpty != false else { continue }
            let text = textParts.joined(separator: "\n\n")
            if hasVisibleText(text) {
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

    private static func visibleText(_ value: String?) -> String? {
        guard let value, hasVisibleText(value) else { return nil }
        return value
    }

    private static func hasVisibleText(_ value: String?) -> Bool {
        guard let value else { return false }
        return hasVisibleText(value)
    }

    private static func hasVisibleText(_ value: String) -> Bool {
        value.unicodeScalars.contains { scalar in
            !CharacterSet.whitespacesAndNewlines.contains(scalar)
        }
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

            if let launchDeferredText = store.launchDeferredText {
                Label(cleanLaunchDeferredText(launchDeferredText), systemImage: "hourglass")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.orange)
                    .lineLimit(2)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.orange.opacity(0.12))
                    .clipShape(RoundedRectangle(cornerRadius: 7))
                    .overlay(RoundedRectangle(cornerRadius: 7).stroke(Color.orange.opacity(0.35)))
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

    private func cleanLaunchDeferredText(_ text: String) -> String {
        text
            .replacingOccurrences(of: #"{"detail":""#, with: "")
            .replacingOccurrences(of: #""}"#, with: "")
            .replacingOccurrences(of: "agent launch deferred: ", with: "Launch deferred: ")
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
