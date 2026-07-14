import SwiftUI
import UniformTypeIdentifiers
import ZenithCore

#if canImport(UIKit)
import UIKit
#endif

struct MobileTimelineView: View {
    @EnvironmentObject private var store: MobileAppStore
    @Binding var importerOpen: Bool
    @Binding var resumeOpen: Bool
    @State private var isAtBottom = true
    @State private var optionsOpen = false
    @State private var historyNavigatorOpen = false
    @State private var terminalOpen = false
    @State private var reviewRoute: MobileCodeReviewRoute?
    @State private var olderHistoryLoadArmed = true
    @State private var suppressScrollHistoryLoadUntilTopLeaves = false
    @State private var visibleRowLimit = 180
    @State private var isFileDropTargeted = false
    @State private var historyLoadSuppressedUntil = Date.distantPast
    @State private var lastObservedEventSeq = 0
    @State private var pendingOpenBottomSessionID: String?
    @State private var isOpeningTimelineMasked = false
    @State private var openingTimelineRevealRevision = 0
    @State private var scrollViewportHeight: CGFloat = 0
    @State private var bottomMarkerMaxY: CGFloat?
    private let bottomID = "mobile-timeline-bottom"
    private let defaultVisibleRowLimit = 180
    private let rowPageSize = 72
    private let bottomVisibilityThreshold: CGFloat = 42

    var body: some View {
        let coldOpenRowsSuspended = store.isLoading && store.selectedSessionID != nil && store.displayEvents.isEmpty
        let timelineRowsSuspended = coldOpenRowsSuspended || (store.isApplyingLargeTimelineBatch && store.selectedSessionID != nil)
        let displayEvents = timelineRowsSuspended ? [] : store.displayEvents
        let projection = MobileTimelineRows.project(from: displayEvents)
        let allRows = projection.rows
        let jobsByRunID = projection.jobsByRunID
        let hiddenRenderedRowCount = max(0, allRows.count - visibleRowLimit)
        let rows = Array(allRows.suffix(visibleRowLimit))
        let linkContext = store.selectedSessionID.map { store.markdownLinkContext(sessionID: $0) }

        VStack(spacing: 0) {
            MobileChatHeader(
                resumeOpen: $resumeOpen,
                optionsOpen: $optionsOpen,
                openHistory: { historyNavigatorOpen = true },
                openTerminal: { terminalOpen = true },
                openReview: { event in
                    guard let runID = event.run_id else { return }
                    reviewRoute = MobileCodeReviewRoute(sessionID: event.session_id, runID: runID)
                }
            )
            Divider()
            ScrollViewReader { proxy in
                ZStack(alignment: .bottomTrailing) {
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 14) {
                            if store.isLoading && store.displayEvents.isEmpty {
                                ProgressView()
                                    .frame(maxWidth: .infinity)
                                    .padding(.top, 40)
                            }
                            if !timelineRowsSuspended && (store.hiddenDisplayEventCount > 0 || hiddenRenderedRowCount > 0) {
                                MobileTimelineHistoryLoader(hiddenRenderedRowCount: hiddenRenderedRowCount) {
                                    revealOlderRowsShowingNewPage(proxy)
                                } onLoadOlder: {
                                    loadOlderHistoryFromIntent(proxy)
                                }
                                    .background(MobileHistoryTopReader())
                                    .onDisappear {
                                        olderHistoryLoadArmed = true
                                        suppressScrollHistoryLoadUntilTopLeaves = false
                                    }
                            }
                            ForEach(rows) { row in
                                switch row {
                                case .event(let event):
                                    MobileEventCard(event: event, job: event.run_id.flatMap { jobsByRunID[$0] })
                                        .id(row.id)
                                case .artifacts(let events):
                                    MobileArtifactGridCard(
                                        artifacts: events.compactMap { event in
                                            event.artifact.map { MobileArtifactGridItem(file: $0, url: store.fileURL($0)) }
                                        },
                                        linkContext: linkContext
                                    )
                                    .id(row.id)
                                case .job(let jobRun):
                                    MobileJobRunBubble(
                                        jobRun: jobRun,
                                        linkContext: linkContext
                                    )
                                        .id(row.id)
                                case .jobGroup(let group):
                                    MobileJobRunGroupBubble(
                                        group: group,
                                        linkContext: linkContext
                                    )
                                        .id(row.id)
                                case .trace(_, let events):
                                    MobileTraceCard(
                                        events: events,
                                        linkContext: linkContext
                                    )
                                        .id(row.id)
                                }
                            }
                            Color.clear
                                .frame(height: 1)
                                .id(bottomID)
                                .background(MobileTimelineBottomReader())
                        }
                        .padding(.horizontal, 16)
                        .padding(.vertical, 14)
                        .opacity(isOpeningTimelineMasked && !displayEvents.isEmpty ? 0 : 1)
                    }
                    .coordinateSpace(name: "mobileTimelineScroll")
                    .background(MobileTimelineViewportReader())
                    .refreshable {
                        await loadOlderHistoryFromPull(proxy)
                    }
                    .scrollDismissesKeyboard(.interactively)
                    .simultaneousGesture(
                        DragGesture(minimumDistance: 8)
                            .onChanged { _ in dismissMobileKeyboard() }
                    )
                    .simultaneousGesture(
                        TapGesture()
                            .onEnded { dismissMobileKeyboard() }
                    )
                    if shouldShowBottomButton(displayEvents: displayEvents) {
                        Button {
                            scrollToBottom(proxy, animated: true)
                        } label: {
                            Image(systemName: "arrow.down.to.line.compact")
                                .font(.headline)
                        }
                        .buttonStyle(.borderedProminent)
                        .clipShape(Circle())
                        .padding(16)
                    }
                    if isFileDropTargeted {
                        MobileTimelineFileDropOverlay()
                            .padding(18)
                            .allowsHitTesting(false)
                    }
                    if isOpeningTimelineMasked || store.isApplyingLargeTimelineBatch {
                        MobileTimelinePositioningOverlay()
                            .padding(18)
                            .allowsHitTesting(false)
                    }
                }
                .onDrop(of: MobileTimelineFileDrop.supportedTypes, isTargeted: $isFileDropTargeted) { providers in
                    acceptTimelineFileDrop(providers)
                }
                .onChange(of: store.scrollRevision) {
                    scrollToBottom(proxy)
                }
                .onChange(of: store.timelineNavigationTarget?.id) {
                    positionTimelineNavigationTarget(allRows, proxy: proxy)
                }
                .onChange(of: store.selectedSessionID) {
                    openingTimelineRevealRevision += 1
                    isOpeningTimelineMasked = store.selectedSessionID != nil
                    pendingOpenBottomSessionID = store.selectedSessionID
                    isAtBottom = true
                    disarmAutomaticOlderHistoryLoad()
                    suppressHistoryLoading(for: 2.0)
                    visibleRowLimit = defaultVisibleRowLimit
                    lastObservedEventSeq = maxEventSeq(displayEvents)
                    settleOpenThreadAtLatest(proxy, displayEvents: displayEvents)
                }
                .onChange(of: displayEvents.count) { oldCount, newCount in
                    let previousObservedSeq = lastObservedEventSeq
                    let shouldFollowLiveEvent = shouldAutoFollowLiveEvent(after: previousObservedSeq)
                    let rowCount = MobileTimelineRows.build(from: displayEvents).count
                    if isOpeningTimelineMasked || store.isApplyingLargeTimelineBatch {
                        setVisibleRowLimit(min(rowCount, defaultVisibleRowLimit))
                        updateUnreadState(after: previousObservedSeq)
                        lastObservedEventSeq = maxEventSeq(displayEvents)
                        _ = settleOpenThreadAtLatest(proxy, displayEvents: displayEvents)
                        return
                    }
                    if newCount == 0 {
                        setVisibleRowLimit(defaultVisibleRowLimit)
                    } else if isAtBottom {
                        setVisibleRowLimit(cappedLiveVisibleRowLimit(rowCount: rowCount, oldCount: oldCount, newCount: newCount))
                    } else if newCount > oldCount {
                        setVisibleRowLimit(min(rowCount, visibleRowLimit + min(rowPageSize, max(1, newCount - oldCount))))
                    }
                    updateUnreadState(after: previousObservedSeq)
                    lastObservedEventSeq = maxEventSeq(displayEvents)
                    if settleOpenThreadAtLatest(proxy, displayEvents: displayEvents) {
                        return
                    } else if shouldFollowLiveEvent {
                        scrollToBottom(proxy)
                    }
                }
                .onChange(of: store.hiddenDisplayEventCount) {
                    if store.hiddenDisplayEventCount <= 0 {
                        olderHistoryLoadArmed = false
                        suppressScrollHistoryLoadUntilTopLeaves = false
                    }
                }
                .onChange(of: store.isApplyingLargeTimelineBatch) {
                    if !store.isApplyingLargeTimelineBatch {
                        settleOpenThreadAtLatest(proxy, displayEvents: store.displayEvents)
                    }
                }
                .onPreferenceChange(MobileHistoryTopPreferenceKey.self) { topY in
                    handleHistoryTopChange(topY, proxy: proxy)
                }
                .onPreferenceChange(MobileTimelineViewportHeightPreferenceKey.self) { height in
                    scrollViewportHeight = height
                    updateBottomStateFromGeometry()
                }
                .onPreferenceChange(MobileTimelineBottomPreferenceKey.self) { maxY in
                    bottomMarkerMaxY = maxY
                    if maxY == nil && !displayEvents.isEmpty && !isOpeningTimelineMasked && !store.isApplyingLargeTimelineBatch {
                        isAtBottom = false
                    } else {
                        updateBottomStateFromGeometry()
                    }
                }
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            MobileComposerView(importerOpen: $importerOpen)
        }
        .sheet(isPresented: $optionsOpen) {
            MobileChatOptionsView(isPresented: $optionsOpen, resumeOpen: $resumeOpen)
                .environmentObject(store)
        }
        .sheet(isPresented: $historyNavigatorOpen) {
            MobileHistoryNavigatorView()
                .environmentObject(store)
        }
        .fullScreenCover(isPresented: $terminalOpen) {
            if let session = store.selectedSession {
                MobileTerminalView(session: session)
                    .environmentObject(store)
            }
        }
        .fullScreenCover(item: $reviewRoute) { route in
            MobileCodeReviewView(sessionID: route.sessionID, runID: route.runID)
                .environmentObject(store)
        }
    }

    private func scrollToBottom(_ proxy: ScrollViewProxy, animated: Bool = false) {
        suppressHistoryLoading(for: 0.55)
        disarmAutomaticOlderHistoryLoad()
        let action = {
            proxy.scrollTo(bottomID, anchor: .bottom)
            isAtBottom = true
        }
        if animated {
            withAnimation(.snappy) {
                action()
            }
            settleBottomAfterExplicitScroll(proxy)
        } else {
            withTransaction(noAnimationTransaction) {
                action()
            }
        }
    }

    private func positionTimelineNavigationTarget(_ allRows: [MobileTimelineRow], proxy: ScrollViewProxy) {
        guard let target = store.timelineNavigationTarget,
              target.sessionID == store.selectedSessionID,
              let rowIndex = allRows.firstIndex(where: { $0.containsEventID(target.eventID) }) else {
            return
        }
        let row = allRows[rowIndex]
        let requiredVisibleRows = max(defaultVisibleRowLimit, allRows.count - rowIndex + 5)
        if visibleRowLimit < requiredVisibleRows {
            setVisibleRowLimit(requiredVisibleRows)
        }
        pendingOpenBottomSessionID = nil
        isOpeningTimelineMasked = false
        suppressHistoryLoading(for: 1.0)
        disarmAutomaticOlderHistoryLoad()
        let targetID = target.id
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.06) {
            guard store.timelineNavigationTarget?.id == targetID,
                  store.selectedSessionID == target.sessionID else { return }
            withTransaction(noAnimationTransaction) {
                proxy.scrollTo(row.id, anchor: .center)
                isAtBottom = false
            }
            store.consumeTimelineNavigationTarget(targetID)
        }
    }

    @discardableResult
    private func settleOpenThreadAtLatest(_ proxy: ScrollViewProxy, displayEvents: [ZEvent]) -> Bool {
        guard let pendingSessionID = pendingOpenBottomSessionID,
              pendingSessionID == store.selectedSessionID,
              !displayEvents.isEmpty,
              !store.isApplyingLargeTimelineBatch else {
            return false
        }
        pendingOpenBottomSessionID = nil
        openingTimelineRevealRevision += 1
        let revision = openingTimelineRevealRevision
        suppressHistoryLoading(for: 2.0)
        disarmAutomaticOlderHistoryLoad()
        scrollToBottom(proxy)
        for delay in [0.04, 0.12, 0.22] {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
                guard store.selectedSessionID == pendingSessionID,
                      openingTimelineRevealRevision == revision else {
                    return
                }
                withTransaction(noAnimationTransaction) {
                    proxy.scrollTo(bottomID, anchor: .bottom)
                    isAtBottom = true
                }
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.26) {
            guard store.selectedSessionID == pendingSessionID,
                  openingTimelineRevealRevision == revision else {
                return
            }
            withTransaction(noAnimationTransaction) {
                isOpeningTimelineMasked = false
            }
        }
        return true
    }

    private func settleBottomAfterExplicitScroll(_ proxy: ScrollViewProxy) {
        let sessionID = store.selectedSessionID
        for delay in [0.08, 0.18] {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
                guard store.selectedSessionID == sessionID else { return }
                suppressHistoryLoading(for: 0.35)
                withTransaction(noAnimationTransaction) {
                    proxy.scrollTo(bottomID, anchor: .bottom)
                    isAtBottom = true
                }
            }
        }
    }

    private func shouldShowBottomButton(displayEvents: [ZEvent]) -> Bool {
        !isAtBottom &&
            !displayEvents.isEmpty &&
            !isOpeningTimelineMasked &&
            !store.isApplyingLargeTimelineBatch
    }

    private func updateBottomStateFromGeometry() {
        guard scrollViewportHeight > 0, let bottomMarkerMaxY else { return }
        let distanceFromBottom = bottomMarkerMaxY - scrollViewportHeight
        let nextAtBottom = distanceFromBottom <= bottomVisibilityThreshold
        if isAtBottom != nextAtBottom {
            isAtBottom = nextAtBottom
        }
    }

    private func suppressHistoryLoading(for interval: TimeInterval) {
        let until = Date().addingTimeInterval(interval)
        if until > historyLoadSuppressedUntil {
            historyLoadSuppressedUntil = until
        }
    }

    private func disarmAutomaticOlderHistoryLoad() {
        olderHistoryLoadArmed = false
        suppressScrollHistoryLoadUntilTopLeaves = true
    }

    private func shouldAutoFollowLiveEvent(after previousSeq: Int) -> Bool {
        false
    }

    private func updateUnreadState(after previousSeq: Int) {
        guard let sessionID = store.selectedSessionID else { return }
        guard store.displayEvents.contains(where: { $0.seq > previousSeq && store.isAgentVisibleMessage($0) }) else { return }
        store.markSessionUnread(sessionID)
    }

    private func cappedLiveVisibleRowLimit(rowCount: Int, oldCount: Int, newCount: Int) -> Int {
        let incomingCount = max(0, newCount - oldCount)
        let currentLimit = max(visibleRowLimit, defaultVisibleRowLimit)
        guard incomingCount > 0 else {
            return min(rowCount, currentLimit)
        }
        return min(rowCount, currentLimit + min(rowPageSize, incomingCount))
    }

    private func handleHistoryTopChange(_ topY: CGFloat?, proxy: ScrollViewProxy) {
        guard let topY else { return }
        guard !isOpeningTimelineMasked,
              !store.isApplyingLargeTimelineBatch,
              !store.isLoading else {
            return
        }
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

    private func loadOlderHistoryFromPull(_ proxy: ScrollViewProxy) async {
        if revealOlderRows(preservingPositionWith: proxy) {
            olderHistoryLoadArmed = false
            suppressScrollHistoryLoadUntilTopLeaves = true
            return
        }
        if store.canLoadOlderHistory {
            let anchorID = firstRenderedRowID()
            let beforeRowCount = MobileTimelineRows.build(from: store.displayEvents).count
            olderHistoryLoadArmed = false
            suppressScrollHistoryLoadUntilTopLeaves = true
            let result = await store.loadOlderHistory()
            if result.addedCount > 0 {
                let afterRowCount = MobileTimelineRows.build(from: store.displayEvents).count
                let addedRows = max(0, afterRowCount - beforeRowCount)
                if addedRows > 0 {
                    setVisibleRowLimit(min(afterRowCount, visibleRowLimit + min(rowPageSize, addedRows)))
                }
            }
            restoreScrollPosition(to: anchorID, proxy: proxy)
            return
        }
        await store.refreshTimelineFromPull()
    }

    @discardableResult
    private func revealOlderRows(preservingPositionWith proxy: ScrollViewProxy) -> Bool {
        let anchorID = firstRenderedRowID()
        guard let nextLimit = olderPageRevealLimit(oldLimit: visibleRowLimit) else { return false }
        setVisibleRowLimit(nextLimit)
        restoreScrollPosition(to: anchorID, proxy: proxy)
        return true
    }

    @discardableResult
    private func revealOlderRowsShowingNewPage(_ proxy: ScrollViewProxy) -> Bool {
        let oldLimit = visibleRowLimit
        let rows = MobileTimelineRows.build(from: store.displayEvents)
        guard let page = olderPageReveal(oldLimit: oldLimit, rows: rows) else { return false }
        setVisibleRowLimit(page.limit)
        scrollToOlderPageTarget(page.target?.id, proxy: proxy)
        return true
    }

    private func olderPageRevealLimit(oldLimit: Int) -> Int? {
        let rows = MobileTimelineRows.build(from: store.displayEvents)
        return olderPageReveal(oldLimit: oldLimit, rows: rows)?.limit
    }

    private func olderPageReveal(oldLimit: Int, rows: [MobileTimelineRow]) -> (limit: Int, target: MobileTimelineRow?)? {
        guard oldLimit < rows.count else { return nil }
        var nextLimit = min(rows.count, oldLimit + rowPageSize)
        let maxLimit = min(rows.count, oldLimit + rowPageSize * 6)

        while !newlyRevealedRows(in: rows, oldLimit: oldLimit, nextLimit: nextLimit).contains(where: { $0.isPrimaryPageRow }) &&
            nextLimit < maxLimit {
            nextLimit = min(rows.count, nextLimit + rowPageSize)
        }
        guard nextLimit > oldLimit else { return nil }
        let target = olderPageTarget(in: rows, oldLimit: oldLimit, nextLimit: nextLimit)
        return (nextLimit, target)
    }

    private func olderPageTarget(in rows: [MobileTimelineRow], oldLimit: Int, nextLimit: Int) -> MobileTimelineRow? {
        let revealed = newlyRevealedRows(in: rows, oldLimit: oldLimit, nextLimit: nextLimit)
        return revealed.first(where: { $0.isPrimaryPageRow }) ?? revealed.first
    }

    private func newlyRevealedRows(in rows: [MobileTimelineRow], oldLimit: Int, nextLimit: Int) -> ArraySlice<MobileTimelineRow> {
        let newStart = max(0, rows.count - nextLimit)
        let oldStart = max(0, rows.count - min(oldLimit, rows.count))
        guard newStart < oldStart else { return [] }
        return rows[newStart..<oldStart]
    }

    private func loadOlderHistoryPreservingPosition(_ proxy: ScrollViewProxy) {
        let anchorID = firstRenderedRowID()
        let beforeRowCount = MobileTimelineRows.build(from: store.displayEvents).count
        Task {
            let result = await store.loadOlderHistory()
            if result.addedCount > 0 {
                let afterRowCount = MobileTimelineRows.build(from: store.displayEvents).count
                let addedRows = max(0, afterRowCount - beforeRowCount)
                if addedRows > 0 {
                    setVisibleRowLimit(min(afterRowCount, visibleRowLimit + min(rowPageSize, addedRows)))
                }
            }
            restoreScrollPosition(to: anchorID, proxy: proxy)
        }
    }

    private func loadOlderHistoryShowingNewPage(_ proxy: ScrollViewProxy) {
        let beforeRowCount = MobileTimelineRows.build(from: store.displayEvents).count
        Task {
            let result = await store.loadOlderHistory()
            let rows = MobileTimelineRows.build(from: store.displayEvents)
            guard !rows.isEmpty else { return }
            if result.addedCount > 0 {
                let addedRows = max(0, rows.count - beforeRowCount)
                let target = olderHistoryTarget(firstAddedEventID: result.firstAddedEventID, rows: rows, preferredLimit: visibleRowLimit + max(rowPageSize, addedRows))
                let nextLimit = olderHistoryVisibleLimit(for: target, rows: rows, preferredLimit: visibleRowLimit + max(rowPageSize, addedRows))
                if nextLimit > visibleRowLimit {
                    setVisibleRowLimit(nextLimit)
                }
                scrollToOlderPageTarget(target?.id, proxy: proxy)
                return
            }
            scrollToOlderPageTarget(Array(rows.suffix(visibleRowLimit)).first?.id, proxy: proxy)
        }
    }

    private func olderHistoryTarget(firstAddedEventID: String?, rows: [MobileTimelineRow], preferredLimit: Int) -> (id: String, index: Int)? {
        if let firstAddedEventID,
           let target = row(containingEventID: firstAddedEventID, in: rows) {
            return target
        }
        let visibleRows = Array(rows.suffix(preferredLimit))
        guard let row = visibleRows.first(where: { $0.isPrimaryPageRow }) ?? visibleRows.first,
              let index = rows.firstIndex(where: { $0.id == row.id }) else {
            return nil
        }
        return (row.id, index)
    }

    private func olderHistoryVisibleLimit(for target: (id: String, index: Int)?, rows: [MobileTimelineRow], preferredLimit: Int) -> Int {
        guard !rows.isEmpty else { return 0 }
        guard let target else {
            return min(rows.count, preferredLimit)
        }
        let rowsNeeded = rows.count - target.index
        return min(rows.count, max(preferredLimit, rowsNeeded + 2))
    }

    private func row(containingEventID eventID: String, in rows: [MobileTimelineRow]) -> (id: String, index: Int)? {
        for (index, row) in rows.enumerated() where row.containsEventID(eventID) {
            return (row.id, index)
        }
        return nil
    }

    private func firstRenderedRowID() -> String? {
        let rows = MobileTimelineRows.build(from: store.displayEvents)
        return Array(rows.suffix(visibleRowLimit)).first?.id
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
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) {
            olderHistoryLoadArmed = true
            suppressScrollHistoryLoadUntilTopLeaves = false
        }
    }

    private func restoreScrollPosition(to rowID: String?, proxy: ScrollViewProxy) {
        guard let rowID else { return }
        historyLoadSuppressedUntil = Date().addingTimeInterval(0.45)
        withTransaction(noAnimationTransaction) {
            proxy.scrollTo(rowID, anchor: .top)
            isAtBottom = false
        }
        DispatchQueue.main.async {
            withTransaction(noAnimationTransaction) {
                proxy.scrollTo(rowID, anchor: .top)
            }
            isAtBottom = false
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) {
                olderHistoryLoadArmed = true
                suppressScrollHistoryLoadUntilTopLeaves = false
            }
        }
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

    private func maxEventSeq(_ events: [ZEvent]) -> Int {
        events.last?.seq ?? 0
    }

    private func acceptTimelineFileDrop(_ providers: [NSItemProvider]) -> Bool {
        guard store.selectedSessionID != nil else { return false }
        Task {
            let urls = await MobileTimelineFileDrop.urls(from: providers)
            guard !urls.isEmpty else { return }
            await store.upload(urls: urls)
        }
        return true
    }
}

private struct MobileTimelineFileDropOverlay: View {
    var body: some View {
        RoundedRectangle(cornerRadius: 16)
            .fill(Color.accentColor.opacity(0.14))
            .overlay(
                RoundedRectangle(cornerRadius: 16)
                    .strokeBorder(Color.accentColor.opacity(0.75), style: StrokeStyle(lineWidth: 2, dash: [7, 5]))
            )
            .overlay {
                Label("Drop files to attach", systemImage: "paperclip")
                    .font(.headline.weight(.semibold))
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .background(.regularMaterial, in: Capsule())
            }
    }
}

private struct MobileTimelinePositioningOverlay: View {
    var body: some View {
        HStack(spacing: 8) {
            ProgressView()
                .controlSize(.small)
            Text("Opening latest")
                .font(.caption.weight(.semibold))
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(.regularMaterial, in: Capsule())
        .overlay(Capsule().stroke(MobileTheme.softLine))
    }
}

enum MobileTimelineFileDrop {
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

@MainActor
private func dismissMobileKeyboard() {
    #if canImport(UIKit)
    UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
    #endif
}

private struct MobileChatHeader: View {
    @EnvironmentObject private var store: MobileAppStore
    @Binding var resumeOpen: Bool
    @Binding var optionsOpen: Bool
    let openHistory: () -> Void
    let openTerminal: () -> Void
    let openReview: (ZEvent) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(store.selectedSession?.title ?? "Chat")
                        .font(.headline)
                        .lineLimit(1)
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer()
                Button(action: openHistory) {
                    Image(systemName: "magnifyingglass")
                }
                .accessibilityLabel("Search chat history")
                if let latestCodeDiff {
                    Button { openReview(latestCodeDiff) } label: {
                        Image(systemName: "doc.text.magnifyingglass")
                    }
                    .accessibilityLabel("Review latest code changes")
                }
                Button(action: openTerminal) {
                    Image(systemName: "terminal")
                }
                .accessibilityLabel("Open persistent terminal")
                Menu {
                    Button {
                        resumeOpen = true
                    } label: {
                        Label("Resume Chat", systemImage: "arrow.uturn.forward.circle")
                    }
                    Button {
                        optionsOpen = true
                    } label: {
                        Label("Chat Options", systemImage: "slider.horizontal.3")
                    }
                    Button(action: openHistory) {
                        Label("Search Chat History", systemImage: "magnifyingglass")
                    }
                    Button(action: openTerminal) {
                        Label("Open Terminal", systemImage: "terminal")
                    }
                    if let latestCodeDiff {
                        Button { openReview(latestCodeDiff) } label: {
                            Label("Review Code Changes", systemImage: "doc.text.magnifyingglass")
                        }
                    }
                    if let session = store.selectedSession {
                        Picker("Backend", selection: Binding(
                            get: { session.backend },
                            set: { newValue in
                                let sessionID = session.id
                                store.stageSelectedRuntime(backend: newValue, model: "")
                                Task { await store.updateSession(sessionID, backend: newValue, model: "", applyOptimistic: false) }
                            }
                        )) {
                            Text("Claude").tag("claude")
                            Text("Codex").tag("codex")
                        }
                        .disabled(session.isBackendLocked)
                        Picker("Model", selection: Binding(
                            get: { normalized(session.model) },
                            set: { newValue in
                                let sessionID = session.id
                                store.stageSelectedRuntime(model: newValue)
                                Task { await store.updateSession(sessionID, model: newValue, applyOptimistic: false) }
                            }
                        )) {
                            ForEach(modelOptions(for: session)) { option in
                                Text(option.label).tag(option.value)
                            }
                        }
                        Picker("Effort", selection: Binding(
                            get: { normalized(session.effort) },
                            set: { newValue in
                                let sessionID = session.id
                                store.stageSelectedRuntime(effort: newValue)
                                Task { await store.updateSession(sessionID, effort: newValue, applyOptimistic: false) }
                            }
                        )) {
                            ForEach(effortOptions(for: session)) { option in
                                Text(option.label).tag(option.value)
                            }
                        }
                    }
                    if let session = store.selectedSession {
                        Button {
                            Task { await store.togglePin(session) }
                        } label: {
                            Label(session.pinned == true ? "Unpin Chat" : "Pin Chat", systemImage: session.pinned == true ? "pin.slash" : "pin")
                        }
                        Button {
                            Task { await store.forkSelected() }
                        } label: {
                            Label("Fork Chat", systemImage: "arrow.triangle.branch")
                        }
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                        .font(.title3)
                }
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
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.orange.opacity(0.35)))
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(.bar)
    }

    private var subtitle: String {
        guard let session = store.selectedSession else { return store.status }
        if let provider = compactProviderID(session.session_id) {
            return "\(store.runtimeCatalog.compactSummary(for: session)) · session \(provider)"
        }
        return "\(store.runtimeCatalog.compactSummary(for: session)) · \(session.folder ?? "General")"
    }

    private var latestCodeDiff: ZEvent? {
        store.displayEvents.last { $0.type == "code_diff" && $0.run_id != nil }
    }

    private func cleanLaunchDeferredText(_ text: String) -> String {
        text.replacingOccurrences(of: "agent launch deferred: ", with: "Launch deferred: ")
    }

    private func modelOptions(for session: ZSession) -> [ZRuntimeOption] {
        optionsWithCurrent(store.runtimeCatalog.models(for: session.backend), current: session.model)
    }

    private func effortOptions(for session: ZSession) -> [ZRuntimeOption] {
        optionsWithCurrent(store.runtimeCatalog.efforts(for: session.backend), current: session.effort)
    }

    private func optionsWithCurrent(_ options: [ZRuntimeOption], current: String?) -> [ZRuntimeOption] {
        let clean = normalized(current)
        guard !clean.isEmpty, !options.contains(where: { $0.value == clean }) else {
            return options
        }
        return options + [ZRuntimeOption(value: clean, label: clean)]
    }

    private func normalized(_ value: String?) -> String {
        value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }
}

private struct MobileCodeReviewRoute: Identifiable {
    let sessionID: String
    let runID: String
    var id: String { "\(sessionID):\(runID)" }
}

private struct MobileTimelineHistoryLoader: View {
    @EnvironmentObject private var store: MobileAppStore
    let hiddenRenderedRowCount: Int
    let onShowOlderRows: () -> Void
    let onLoadOlder: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "clock.arrow.circlepath")
                .foregroundStyle(.secondary)
            Text("\(totalOlderCount) older")
                .font(.caption.weight(.semibold))
            Text("messages")
                .font(.caption)
                .foregroundStyle(.secondary)
            Spacer()
            if hiddenRenderedRowCount > 0 {
                Button {
                    onShowOlderRows()
                } label: {
                    Label("Show", systemImage: "arrow.up")
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
            } else if store.isLoadingOlderHistory {
                ProgressView()
                    .controlSize(.small)
            } else {
                Button {
                    onLoadOlder()
                } label: {
                    Label("Load", systemImage: "arrow.up")
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .disabled(!store.canLoadOlderHistory)
            }
        }
        .font(.caption)
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(.thinMaterial)
        .clipShape(Capsule())
        .overlay(Capsule().stroke(MobileTheme.softLine))
    }

    private var totalOlderCount: Int {
        store.hiddenDisplayEventCount + hiddenRenderedRowCount
    }
}

private struct MobileHistoryTopReader: View {
    var body: some View {
        GeometryReader { proxy in
            Color.clear.preference(
                key: MobileHistoryTopPreferenceKey.self,
                value: proxy.frame(in: .named("mobileTimelineScroll")).minY
            )
        }
    }
}

private struct MobileTimelineViewportReader: View {
    var body: some View {
        GeometryReader { proxy in
            Color.clear.preference(
                key: MobileTimelineViewportHeightPreferenceKey.self,
                value: proxy.size.height
            )
        }
    }
}

private struct MobileTimelineBottomReader: View {
    var body: some View {
        GeometryReader { proxy in
            Color.clear.preference(
                key: MobileTimelineBottomPreferenceKey.self,
                value: proxy.frame(in: .named("mobileTimelineScroll")).maxY
            )
        }
    }
}

private struct MobileHistoryTopPreferenceKey: PreferenceKey {
    static let defaultValue: CGFloat? = nil

    static func reduce(value: inout CGFloat?, nextValue: () -> CGFloat?) {
        value = nextValue() ?? value
    }
}

private struct MobileTimelineViewportHeightPreferenceKey: PreferenceKey {
    static let defaultValue: CGFloat = 0

    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = nextValue()
    }
}

private struct MobileTimelineBottomPreferenceKey: PreferenceKey {
    static let defaultValue: CGFloat? = nil

    static func reduce(value: inout CGFloat?, nextValue: () -> CGFloat?) {
        value = nextValue() ?? value
    }
}

private enum MobileTimelineRow: Identifiable {
    case event(ZEvent)
    case artifacts([ZEvent])
    case job(MobileJobRunRow)
    case jobGroup(MobileJobRunGroupRow)
    case trace(String, [ZEvent])

    var id: String {
        switch self {
        case .event(let event): return "event-\(event.id)"
        case .artifacts(let events):
            let first = events.first?.seq ?? 0
            let last = events.last?.seq ?? first
            return "artifacts-\(first)-\(last)"
        case .job(let jobRun): return "job-\(jobRun.id)-\(jobRun.lastSeq)"
        case .jobGroup(let group): return "job-group-\(group.id)"
        case .trace(let id, _): return id
        }
    }

    var isPrimaryPageRow: Bool {
        switch self {
        case .artifacts, .job, .jobGroup:
            return true
        case .trace:
            return false
        case .event(let event):
            if Self.nonPrimaryPageEventTypes.contains(event.type) {
                return false
            }
            if event.type == "assistant_text" {
                return event.text?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
            }
            if event.type == "turn_finished" {
                return event.result_text?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
            }
            return true
        }
    }

    func containsEventID(_ eventID: String) -> Bool {
        switch self {
        case .event(let event):
            return event.id == eventID
        case .artifacts(let events), .trace(_, let events):
            return events.contains { $0.id == eventID }
        case .job(let jobRun):
            return jobRun.runEvent.id == eventID
        case .jobGroup(let group):
            return group.runs.contains { $0.runEvent.id == eventID }
        }
    }

    private static let nonPrimaryPageEventTypes: Set<String> = [
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
        "code_diff",
        "artifact_error",
        "session_created"
    ]
}

private struct MobileTimelineProjection {
    let rows: [MobileTimelineRow]
    let jobsByRunID: [String: ZJob]
}

private enum MobileTimelineRows {
    private final class Entry: NSObject {
        let projection: MobileTimelineProjection

        init(_ projection: MobileTimelineProjection) {
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
        "code_diff",
        "artifact_error",
        "session_created"
    ]

    static func project(from events: [ZEvent]) -> MobileTimelineProjection {
        let key = cacheKey(for: events)
        if let cached = cache.object(forKey: key) {
            return cached.projection
        }

        let jobRuns = jobRunsByRunID(events)
        let rows = buildRows(from: events, jobRuns: jobRuns)
        let projection = MobileTimelineProjection(rows: rows, jobsByRunID: jobRuns.mapValues(\.job))
        cache.setObject(Entry(projection), forKey: key)
        return projection
    }

    static func build(from events: [ZEvent]) -> [MobileTimelineRow] {
        project(from: events).rows
    }

    private static func buildRows(from events: [ZEvent], jobRuns: [String: MobileJobRunRow]) -> [MobileTimelineRow] {
        let jobRunIDs = Set(jobRuns.keys)
        var rows: [MobileTimelineRow] = []
        var orphanTrace: [ZEvent] = []
        var activeRunID: String?
        var activeAssistantEvents: [ZEvent] = []
        var activeFinishedEvent: ZEvent?
        var activeArtifactEvents: [ZEvent] = []
        var activeTrace: [ZEvent] = []
        var pendingJobRuns: [MobileJobRunRow] = []

        func appendTrace(_ events: [ZEvent], prefix: String = "trace") {
            guard let first = events.first, let last = events.last else { return }
            rows.append(.trace("\(prefix)-\(first.seq)-\(last.seq)", events))
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
                rows.append(.event(assistant))
            }
            if !activeArtifactEvents.isEmpty {
                rows.append(.artifacts(activeArtifactEvents))
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
                rows.append(.job(run))
            } else {
                rows.append(.jobGroup(MobileJobRunGroupRow(runs: pendingJobRuns)))
            }
            pendingJobRuns.removeAll(keepingCapacity: true)
        }

        func appendJobRun(_ run: MobileJobRunRow) {
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
                rows.append(.event(event))
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

            if event.type == "artifact_created" {
                if event.run_id != nil {
                    beginAgentRunIfNeeded(for: event)
                }
                if activeRunID != nil {
                    activeArtifactEvents.append(event)
                    continue
                }
                flushOrphanTrace()
                rows.append(.event(event))
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

            if activeRunID != nil {
                flushAgentRun()
            }

            if traceTypes.contains(event.type) {
                orphanTrace.append(event)
            } else {
                flushOrphanTrace()
                rows.append(.event(event))
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

    static func jobRunsByRunID(_ events: [ZEvent]) -> [String: MobileJobRunRow] {
        var rows: [String: MobileJobRunRow] = [:]
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
                    rows[runID] = MobileJobRunRow(
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
                if var row = rows[runID] {
                    let result = event.result_text?.trimmingCharacters(in: .whitespacesAndNewlines)
                    row.resultText = result?.isEmpty == false ? result : assistantText[runID]?.joined(separator: "\n\n")
                    row.isFinished = true
                    row.finishedAt = event.ts
                    row.lastEventAt = event.ts
                    row.lastSeq = max(row.lastSeq, event.seq)
                    rows[runID] = row
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

struct MobileJobRunRow: Identifiable, Hashable {
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

struct MobileJobRunGroupRow: Identifiable, Hashable {
    let id: String
    let runs: [MobileJobRunRow]

    init(runs: [MobileJobRunRow]) {
        self.runs = runs
        let first = runs.first
        let last = runs.last
        self.id = "\(last?.job.id ?? "job")-\(first?.runEvent.seq ?? 0)-\(last?.lastSeq ?? 0)-\(runs.count)"
    }

    var latest: MobileJobRunRow {
        runs[runs.count - 1]
    }

    var olderNewestFirst: [MobileJobRunRow] {
        Array(runs.dropLast().reversed())
    }
}
