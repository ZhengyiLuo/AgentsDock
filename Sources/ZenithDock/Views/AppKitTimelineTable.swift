#if AGENTSDOCK_APPKIT_TIMELINE
import AppKit
import SwiftUI

enum AppKitTimelineAnchor: Equatable {
    case top
    case center
    case bottom
}

struct AppKitTimelineScrollCommand: Equatable {
    enum Destination: Equatable {
        case none
        case bottom
        case row(String, AppKitTimelineAnchor)
    }

    var revision = 0
    var destination: Destination = .none
}

struct AppKitTimelineItem: Identifiable {
    let id: String
    let version: Int
    let content: AnyView
}

@MainActor
private enum AppKitTimelineDiagnostics {
    static var coordinatorCount = 0
    static var updateCount = 0
    static var sameSessionFallbackReloadCount = 0
    static var bottomRequestCount = 0
    static var deferredAnchorRequestCount = 0
    static var deferredAnchorApplyCount = 0
    static var lastAnchorID: String?
    static var lastAnchorTargetY: CGFloat?
    static var lastAnchorVisibleY: CGFloat?
}

struct AppKitTimelineTable: NSViewRepresentable {
    let sessionID: String?
    let items: [AppKitTimelineItem]
    let scrollCommand: AppKitTimelineScrollCommand
    let forcedBottomRevision: Int
    let onMetrics: (TimelineScrollMetrics) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onMetrics: onMetrics)
    }

    func makeNSView(context: Context) -> NSScrollView {
        context.coordinator.makeScrollView()
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        context.coordinator.onMetrics = onMetrics
        context.coordinator.update(
            sessionID: sessionID,
            items: items,
            scrollCommand: scrollCommand,
            forcedBottomRevision: forcedBottomRevision
        )
    }

    static func dismantleNSView(_ scrollView: NSScrollView, coordinator: Coordinator) {
        coordinator.stopObserving()
    }

    @MainActor
    final class Coordinator: NSObject, NSTableViewDataSource, NSTableViewDelegate {
        var onMetrics: (TimelineScrollMetrics) -> Void

        private var items: [AppKitTimelineItem] = []
        private var sessionID: String?
        private var hasReceivedUpdate = false
        private var lastScrollCommandRevision = 0
        private var lastForcedBottomRevision = 0
        private weak var scrollView: NSScrollView?
        private weak var tableView: NSTableView?
        private var boundsObserver: NSObjectProtocol?
        private var tableFrameObserver: NSObjectProtocol?
        private var liveScrollObserver: NSObjectProtocol?
        private var reportWorkItem: DispatchWorkItem?
        private var lastMetrics: TimelineScrollMetrics?
        private var bottomSettleGeneration = 0
        private var anchorRestoreGeneration = 0

        private(set) var fullReloadCount = 0
        private(set) var structuralUpdateCount = 0
        private(set) var cellConfigurationCount = 0

        private let cellIdentifier = NSUserInterfaceItemIdentifier("AgentsDockTimelineHostingCell")

        init(onMetrics: @escaping (TimelineScrollMetrics) -> Void) {
            self.onMetrics = onMetrics
        }

        func makeScrollView() -> NSScrollView {
            AppKitTimelineDiagnostics.coordinatorCount += 1
            let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("timeline"))
            column.resizingMask = .autoresizingMask

            let tableView = NSTableView(frame: .zero)
            tableView.addTableColumn(column)
            tableView.headerView = nil
            tableView.delegate = self
            tableView.dataSource = self
            tableView.backgroundColor = .clear
            tableView.gridStyleMask = []
            tableView.intercellSpacing = .zero
            tableView.rowHeight = 120
            tableView.usesAutomaticRowHeights = true
            tableView.columnAutoresizingStyle = .uniformColumnAutoresizingStyle
            tableView.allowsColumnReordering = false
            tableView.allowsColumnResizing = false
            tableView.allowsMultipleSelection = false
            tableView.allowsEmptySelection = true
            tableView.focusRingType = .none

            let scrollView = NSScrollView(frame: .zero)
            scrollView.documentView = tableView
            scrollView.hasVerticalScroller = true
            scrollView.hasHorizontalScroller = false
            scrollView.autohidesScrollers = true
            scrollView.drawsBackground = false
            scrollView.automaticallyAdjustsContentInsets = false
            // A programmatic NSScrollView defaults to a 10-point wheel step,
            // which is far too small for tall chat cards. This affects discrete
            // mouse-wheel events only; precise trackpad deltas remain native.
            scrollView.verticalLineScroll = 48
            let zeroInsets = NSEdgeInsets(top: 0, left: 0, bottom: 0, right: 0)
            scrollView.contentInsets = zeroInsets
            scrollView.scrollerInsets = zeroInsets
            scrollView.verticalScrollElasticity = .none
            scrollView.horizontalScrollElasticity = .none

            self.scrollView = scrollView
            self.tableView = tableView
            observe(scrollView: scrollView, tableView: tableView)
            return scrollView
        }

        func numberOfRows(in tableView: NSTableView) -> Int {
            items.count
        }

        func tableView(
            _ tableView: NSTableView,
            viewFor tableColumn: NSTableColumn?,
            row: Int
        ) -> NSView? {
            guard items.indices.contains(row) else { return nil }
            let cell = tableView.makeView(withIdentifier: cellIdentifier, owner: self) as? TimelineHostingCellView
                ?? TimelineHostingCellView(identifier: cellIdentifier)
            cell.configure(with: items[row])
            cellConfigurationCount += 1
            return cell
        }

        func tableView(_ tableView: NSTableView, shouldSelectRow row: Int) -> Bool {
            false
        }

        func update(
            sessionID nextSessionID: String?,
            items nextItems: [AppKitTimelineItem],
            scrollCommand: AppKitTimelineScrollCommand,
            forcedBottomRevision: Int = 0
        ) {
            guard tableView != nil else { return }
            AppKitTimelineDiagnostics.updateCount += 1
            cancelDeferredAnchorRestore()

            let previousItems = items
            let sessionChanged = sessionID != nextSessionID
            if sessionChanged {
                cancelBottomSettles()
            }
            let anchor = sessionChanged ? nil : captureAnchor()
            let commandChanged = hasReceivedUpdate && scrollCommand.revision != lastScrollCommandRevision
            let forcedBottomChanged = hasReceivedUpdate && forcedBottomRevision != lastForcedBottomRevision

            sessionID = nextSessionID
            let itemsChanged = applyItems(
                nextItems,
                previousItems: previousItems,
                sessionChanged: sessionChanged
            )
            let anchorMovedByPrepend: Bool = {
                guard let anchor,
                      let previousIndex = previousItems.firstIndex(where: { $0.id == anchor.itemID }),
                      let nextIndex = nextItems.firstIndex(where: { $0.id == anchor.itemID }) else {
                    return false
                }
                return nextIndex > previousIndex
            }()

            if commandChanged {
                lastScrollCommandRevision = scrollCommand.revision
            }
            if forcedBottomChanged {
                lastForcedBottomRevision = forcedBottomRevision
            }
            if !hasReceivedUpdate {
                hasReceivedUpdate = true
                lastScrollCommandRevision = scrollCommand.revision
                lastForcedBottomRevision = forcedBottomRevision
            }

            guard itemsChanged || commandChanged || forcedBottomChanged else {
                scheduleMetricsReport()
                return
            }

            // Position in the same update transaction as the row mutation. An
            // async restore allows AppKit to display one frame at its temporary
            // position, which is the visible "jump" seen on chat open/prepend.
            if commandChanged {
                apply(scrollCommand.destination)
            } else if forcedBottomChanged {
                scrollToBottom()
            } else if sessionChanged || (previousItems.isEmpty && !nextItems.isEmpty) {
                scrollToBottom()
            } else if let anchor {
                restore(anchor)
                if anchorMovedByPrepend {
                    deferAnchorRestore(anchor, expectedSessionID: nextSessionID)
                }
            }
            scheduleMetricsReport()
        }

        private func applyItems(
            _ nextItems: [AppKitTimelineItem],
            previousItems: [AppKitTimelineItem],
            sessionChanged: Bool
        ) -> Bool {
            guard let tableView else { return false }
            let oldIDs = previousItems.map(\.id)
            let newIDs = nextItems.map(\.id)

            if sessionChanged || previousItems.isEmpty || nextItems.isEmpty {
                items = nextItems
                fullReloadCount += 1
                tableView.reloadData()
                return true
            }

            if oldIDs == newIDs {
                items = nextItems
                let changed = IndexSet(nextItems.indices.filter {
                    previousItems[$0].version != nextItems[$0].version
                })
                refreshVisibleCells(in: tableView, limitingTo: changed)
                if !changed.isEmpty {
                    tableView.noteHeightOfRows(withIndexesChanged: changed)
                }
                return !changed.isEmpty
            }

            if newIDs.starts(with: oldIDs) {
                items = nextItems
                let inserted = IndexSet(oldIDs.count..<newIDs.count)
                structuralUpdateCount += 1
                tableView.insertRows(at: inserted, withAnimation: [])
                return true
            }

            if newIDs.suffix(oldIDs.count).elementsEqual(oldIDs) {
                items = nextItems
                let inserted = IndexSet(0..<(newIDs.count - oldIDs.count))
                structuralUpdateCount += 1
                tableView.insertRows(at: inserted, withAnimation: [])
                return true
            }

            if oldIDs.starts(with: newIDs) {
                items = nextItems
                let removed = IndexSet(newIDs.count..<oldIDs.count)
                structuralUpdateCount += 1
                tableView.removeRows(at: removed, withAnimation: [])
                return true
            }

            if oldIDs.suffix(newIDs.count).elementsEqual(newIDs) {
                items = nextItems
                let removed = IndexSet(0..<(oldIDs.count - newIDs.count))
                structuralUpdateCount += 1
                tableView.removeRows(at: removed, withAnimation: [])
                return true
            }

            let maximumOverlap = min(oldIDs.count, newIDs.count)
            if maximumOverlap > 0,
               let overlap = stride(from: maximumOverlap, through: 1, by: -1).first(where: {
                   oldIDs.suffix($0).elementsEqual(newIDs.prefix($0))
               }),
               overlap >= min(8, maximumOverlap) {
                let removedCount = oldIDs.count - overlap
                let insertedCount = newIDs.count - overlap
                items = nextItems
                structuralUpdateCount += 1
                tableView.beginUpdates()
                if removedCount > 0 {
                    tableView.removeRows(at: IndexSet(0..<removedCount), withAnimation: [])
                }
                if insertedCount > 0 {
                    tableView.insertRows(
                        at: IndexSet(overlap..<newIDs.count),
                        withAnimation: []
                    )
                }
                tableView.endUpdates()
                return true
            }

            if oldIDs.count == newIDs.count,
               let shift = (1...min(64, oldIDs.count)).first(where: {
                   oldIDs.dropFirst($0).elementsEqual(newIDs.dropLast($0))
               }) {
                items = nextItems
                structuralUpdateCount += 1
                tableView.beginUpdates()
                tableView.removeRows(at: IndexSet(0..<shift), withAnimation: [])
                tableView.insertRows(
                    at: IndexSet((newIDs.count - shift)..<newIDs.count),
                    withAnimation: []
                )
                tableView.endUpdates()
                return true
            }

            let difference = newIDs.difference(from: oldIDs)
            var removals = IndexSet()
            var insertions = IndexSet()
            for change in difference {
                switch change {
                case .remove(let offset, _, _):
                    removals.insert(offset)
                case .insert(let offset, _, _):
                    insertions.insert(offset)
                }
            }

            guard !removals.isEmpty || !insertions.isEmpty else {
                items = nextItems
                fullReloadCount += 1
                AppKitTimelineDiagnostics.sameSessionFallbackReloadCount += 1
                tableView.reloadData()
                return true
            }

            var previousVersionsByID: [String: Int] = [:]
            previousVersionsByID.reserveCapacity(previousItems.count)
            for item in previousItems {
                previousVersionsByID[item.id] = item.version
            }

            items = nextItems
            structuralUpdateCount += 1
            tableView.beginUpdates()
            if !removals.isEmpty {
                tableView.removeRows(at: removals, withAnimation: [])
            }
            if !insertions.isEmpty {
                tableView.insertRows(at: insertions, withAnimation: [])
            }
            tableView.endUpdates()

            let retainedChanges = IndexSet(nextItems.indices.filter { index in
                !insertions.contains(index) &&
                    previousVersionsByID[nextItems[index].id] != nextItems[index].version
            })
            refreshVisibleCells(in: tableView, limitingTo: retainedChanges)
            if !retainedChanges.isEmpty {
                tableView.noteHeightOfRows(withIndexesChanged: retainedChanges)
            }
            return true
        }

        private func refreshVisibleCells(in tableView: NSTableView, limitingTo limit: IndexSet? = nil) {
            let visibleRange = tableView.rows(in: tableView.visibleRect)
            guard visibleRange.location != NSNotFound, visibleRange.length > 0 else { return }
            let upperBound = min(items.count, visibleRange.location + visibleRange.length)
            guard visibleRange.location < upperBound else { return }

            for row in visibleRange.location..<upperBound {
                if let limit, !limit.contains(row) { continue }
                guard let cell = tableView.view(atColumn: 0, row: row, makeIfNecessary: false)
                    as? TimelineHostingCellView else { continue }
                cell.configure(with: items[row])
                cellConfigurationCount += 1
            }
        }

        private struct VisibleAnchor {
            let itemID: String
            let offset: CGFloat
        }

        private func captureAnchor() -> VisibleAnchor? {
            guard let scrollView, let tableView, !items.isEmpty else { return nil }
            let visibleRect = scrollView.documentVisibleRect
            let probe = NSPoint(x: max(1, visibleRect.midX), y: visibleRect.minY + 1)
            var row = tableView.row(at: probe)
            // The loader is a control, not timeline content. When an older page
            // is inserted after it, pin the first real row so the newly revealed
            // messages land above the viewport and upward scrolling can continue.
            if items.indices.contains(row),
               items[row].id == "history-loader",
               items.indices.contains(row + 1) {
                row += 1
            }
            guard items.indices.contains(row) else { return nil }
            AppKitTimelineDiagnostics.lastAnchorID = items[row].id
            return VisibleAnchor(
                itemID: items[row].id,
                offset: visibleRect.minY - tableView.rect(ofRow: row).minY
            )
        }

        private func restore(_ anchor: VisibleAnchor) {
            guard let row = items.firstIndex(where: { $0.id == anchor.itemID }),
                  let scrollView,
                  let tableView else { return }
            tableView.scrollRowToVisible(row)
            tableView.layoutSubtreeIfNeeded()
            let rowRect = tableView.rect(ofRow: row)
            let targetY = rowRect.minY + anchor.offset
            AppKitTimelineDiagnostics.lastAnchorTargetY = targetY
            scroll(toY: targetY, in: scrollView, tableView: tableView)
            AppKitTimelineDiagnostics.lastAnchorVisibleY = scrollView.documentVisibleRect.minY
        }

        private func deferAnchorRestore(_ anchor: VisibleAnchor, expectedSessionID: String?) {
            AppKitTimelineDiagnostics.deferredAnchorRequestCount += 1
            anchorRestoreGeneration &+= 1
            let generation = anchorRestoreGeneration
            DispatchQueue.main.async { [weak self] in
                guard let self,
                      self.anchorRestoreGeneration == generation,
                      self.sessionID == expectedSessionID else { return }
                AppKitTimelineDiagnostics.deferredAnchorApplyCount += 1
                self.restore(anchor)
                self.scheduleMetricsReport()
            }
        }

        private func cancelDeferredAnchorRestore() {
            anchorRestoreGeneration &+= 1
        }

        private func apply(_ destination: AppKitTimelineScrollCommand.Destination) {
            switch destination {
            case .none:
                break
            case .bottom:
                scrollToBottom()
            case .row(let id, let anchor):
                cancelBottomSettles()
                scroll(to: id, anchor: anchor)
            }
        }

        private func scrollToBottom() {
            guard !items.isEmpty else { return }
            AppKitTimelineDiagnostics.bottomRequestCount += 1
            bottomSettleGeneration &+= 1
            let generation = bottomSettleGeneration
            let expectedSessionID = sessionID
            performBottomScroll(generation: generation, expectedSessionID: expectedSessionID)
        }

        private func performBottomScroll(generation: Int, expectedSessionID: String?) {
            guard let scrollView, let tableView, !items.isEmpty else { return }
            guard bottomSettleGeneration == generation,
                  sessionID == expectedSessionID else { return }
            tableView.scrollRowToVisible(items.count - 1)
            tableView.layoutSubtreeIfNeeded()
            for _ in 0..<2 {
                let targetY = max(0, tableView.bounds.maxY - scrollView.contentView.bounds.height)
                scroll(toY: targetY, in: scrollView, tableView: tableView)
                tableView.layoutSubtreeIfNeeded()
            }
            scheduleMetricsReport()
        }

        private func cancelBottomSettles() {
            bottomSettleGeneration &+= 1
        }

        private func scroll(to itemID: String, anchor: AppKitTimelineAnchor) {
            guard let row = items.firstIndex(where: { $0.id == itemID }),
                  let scrollView,
                  let tableView else { return }
            tableView.scrollRowToVisible(row)
            tableView.layoutSubtreeIfNeeded()
            let rowRect = tableView.rect(ofRow: row)
            let viewportHeight = scrollView.contentView.bounds.height
            let targetY: CGFloat
            switch anchor {
            case .top:
                targetY = rowRect.minY
            case .center:
                targetY = rowRect.midY - viewportHeight / 2
            case .bottom:
                targetY = rowRect.maxY - viewportHeight
            }
            scroll(toY: targetY, in: scrollView, tableView: tableView)
            scheduleMetricsReport()
        }

        private func scroll(toY proposedY: CGFloat, in scrollView: NSScrollView, tableView: NSTableView) {
            let maxY = max(0, tableView.bounds.maxY - scrollView.contentView.bounds.height)
            let point = NSPoint(x: scrollView.contentView.bounds.minX, y: min(max(0, proposedY), maxY))
            scrollView.contentView.scroll(to: point)
            scrollView.reflectScrolledClipView(scrollView.contentView)
        }

        private func observe(scrollView: NSScrollView, tableView: NSTableView) {
            let center = NotificationCenter.default
            scrollView.contentView.postsBoundsChangedNotifications = true
            boundsObserver = center.addObserver(
                forName: NSView.boundsDidChangeNotification,
                object: scrollView.contentView,
                queue: .main
            ) { [weak self] _ in
                MainActor.assumeIsolated {
                    self?.scheduleMetricsReport()
                }
            }

            tableView.postsFrameChangedNotifications = true
            tableFrameObserver = center.addObserver(
                forName: NSView.frameDidChangeNotification,
                object: tableView,
                queue: .main
            ) { [weak self] _ in
                MainActor.assumeIsolated {
                    self?.scheduleMetricsReport()
                }
            }
            liveScrollObserver = center.addObserver(
                forName: NSScrollView.willStartLiveScrollNotification,
                object: scrollView,
                queue: .main
            ) { [weak self] _ in
                MainActor.assumeIsolated {
                    self?.cancelBottomSettles()
                    self?.cancelDeferredAnchorRestore()
                }
            }
        }

        func stopObserving() {
            let center = NotificationCenter.default
            if let boundsObserver { center.removeObserver(boundsObserver) }
            if let tableFrameObserver { center.removeObserver(tableFrameObserver) }
            if let liveScrollObserver { center.removeObserver(liveScrollObserver) }
            boundsObserver = nil
            tableFrameObserver = nil
            liveScrollObserver = nil
            reportWorkItem?.cancel()
            reportWorkItem = nil
            cancelDeferredAnchorRestore()
        }

        private func scheduleMetricsReport() {
            reportWorkItem?.cancel()
            let item = DispatchWorkItem { [weak self] in
                MainActor.assumeIsolated {
                    self?.reportMetrics()
                }
            }
            reportWorkItem = item
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.08, execute: item)
        }

        private func reportMetrics() {
            guard let scrollView, let tableView else { return }
            let viewportHeight = max(0, scrollView.contentView.bounds.height)
            let contentHeight = max(0, tableView.bounds.height)
            let visibleRect = scrollView.documentVisibleRect
            let metrics = TimelineScrollMetrics(
                viewportHeight: viewportHeight,
                contentHeight: contentHeight,
                distanceFromBottom: max(0, contentHeight - visibleRect.maxY),
                distanceFromTop: max(0, visibleRect.minY)
            )
            guard metrics != lastMetrics else { return }
            lastMetrics = metrics
            onMetrics(metrics)
        }
    }
}

@MainActor
enum AppKitTimelineHarness {
    static func run() -> Bool {
        var latestMetrics: TimelineScrollMetrics?
        let coordinator = AppKitTimelineTable.Coordinator { metrics in
            latestMetrics = metrics
        }
        let scrollView = coordinator.makeScrollView()
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 920, height: 720),
            styleMask: .borderless,
            backing: .buffered,
            defer: false
        )
        window.contentView = scrollView
        window.orderOut(nil)

        var items = (0..<320).map { item(index: $0, version: 0) }
        coordinator.update(
            sessionID: "harness",
            items: items,
            scrollCommand: AppKitTimelineScrollCommand(revision: 1, destination: .bottom)
        )
        settleLayout(window: window)

        guard let tableView = scrollView.documentView as? NSTableView,
              tableView.numberOfRows == items.count else {
            fputs("AppKitTimelineHarness: initial row load failed\n", stderr)
            return false
        }

        let initialVisibleCells = instantiatedCellCount(in: tableView)
        guard initialVisibleCells > 0, initialVisibleCells < 80 else {
            fputs("AppKitTimelineHarness: row recycling failed cells=\(initialVisibleCells)\n", stderr)
            return false
        }

        for revision in 1...120 {
            let index = items.count - 1
            items[index] = item(index: index, version: revision)
            coordinator.update(
                sessionID: "harness",
                items: items,
                scrollCommand: AppKitTimelineScrollCommand(revision: 1, destination: .bottom)
            )
        }
        settleLayout(window: window)

        items.insert(historyLoaderItem(), at: 0)
        coordinator.update(
            sessionID: "harness",
            items: items,
            scrollCommand: AppKitTimelineScrollCommand(revision: 1, destination: .bottom)
        )
        settleLayout(window: window)
        scrollView.contentView.scroll(to: .zero)
        scrollView.reflectScrolledClipView(scrollView.contentView)
        settleLayout(window: window)
        let anchoredItemID = items[1].id
        let anchoredRowBefore = items.firstIndex(where: { $0.id == anchoredItemID }) ?? 1
        let anchorOffsetBefore = tableView.rect(ofRow: anchoredRowBefore).minY - scrollView.documentVisibleRect.minY

        let prepended = (0..<24).map { item(index: -24 + $0, version: 0) }
        items.insert(contentsOf: prepended, at: 1)
        coordinator.update(
            sessionID: "harness",
            items: items,
            scrollCommand: AppKitTimelineScrollCommand(revision: 1, destination: .bottom)
        )
        settleLayout(window: window)
        let anchoredRowAfter = items.firstIndex(where: { $0.id == anchoredItemID }) ?? 25
        let anchorOffsetAfter = tableView.rect(ofRow: anchoredRowAfter).minY - scrollView.documentVisibleRect.minY
        guard abs(anchorOffsetAfter - anchorOffsetBefore) < 12 else {
            fputs(
                "AppKitTimelineHarness: prepend anchor moved before=\(anchorOffsetBefore) after=\(anchorOffsetAfter)\n",
                stderr
            )
            fputs(
                "anchor_id=\(AppKitTimelineDiagnostics.lastAnchorID ?? "-") " +
                "requests=\(AppKitTimelineDiagnostics.deferredAnchorRequestCount) " +
                "applies=\(AppKitTimelineDiagnostics.deferredAnchorApplyCount) " +
                "target_y=\(AppKitTimelineDiagnostics.lastAnchorTargetY ?? -1) " +
                "visible_y=\(AppKitTimelineDiagnostics.lastAnchorVisibleY ?? -1)\n",
                stderr
            )
            return false
        }

        items = Array(items.suffix(320)) + (320..<324).map { item(index: $0, version: 0) }
        items = Array(items.suffix(320))
        coordinator.update(
            sessionID: "harness",
            items: items,
            scrollCommand: AppKitTimelineScrollCommand(revision: 2, destination: .bottom)
        )
        settleLayout(window: window)

        // Exercise the generic ID diff used when compaction changes a row in the
        // middle of an otherwise stable timeline. This must not reload the table.
        items[items.count / 2] = item(index: 10_000, version: 0)
        coordinator.update(
            sessionID: "harness",
            items: items,
            scrollCommand: AppKitTimelineScrollCommand(revision: 2, destination: .bottom)
        )
        settleLayout(window: window)

        let finalVisibleCells = instantiatedCellCount(in: tableView)
        guard tableView.numberOfRows == items.count,
              finalVisibleCells > 0,
              finalVisibleCells < 80,
              coordinator.fullReloadCount == 1,
              coordinator.structuralUpdateCount >= 3,
              latestMetrics?.distanceFromBottom ?? .greatestFiniteMagnitude < 4 else {
            fputs(
                "AppKitTimelineHarness: invariant failed rows=\(tableView.numberOfRows) " +
                "cells=\(finalVisibleCells) reloads=\(coordinator.fullReloadCount) " +
                "structural=\(coordinator.structuralUpdateCount) " +
                "bottom=\(latestMetrics?.distanceFromBottom ?? -1)\n",
                stderr
            )
            return false
        }

        coordinator.stopObserving()
        window.contentView = nil
        print(
            "AppKitTimelineHarness passed rows=\(items.count) " +
            "visible_cells=\(finalVisibleCells) reloads=\(coordinator.fullReloadCount) " +
            "structural=\(coordinator.structuralUpdateCount)"
        )
        return true
    }

    private static func item(index: Int, version: Int) -> AppKitTimelineItem {
        let paragraphCount = 1 + abs(index % 7)
        let text = Array(repeating: "Row \(index) keeps a stable identity while its variable-height content is recycled.", count: paragraphCount)
            .joined(separator: "\n")
        let content = AnyView(
            VStack(alignment: .leading, spacing: 6) {
                Text("Assistant")
                    .font(.caption.bold())
                Text(text)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 20)
            .padding(.vertical, 7)
        )
        return AppKitTimelineItem(id: "row-\(index)", version: version, content: content)
    }

    private static func historyLoaderItem() -> AppKitTimelineItem {
        AppKitTimelineItem(
            id: "history-loader",
            version: 0,
            content: AnyView(
                Text("Showing latest messages - load older")
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(12)
            )
        )
    }

    private static func settleLayout(window: NSWindow) {
        for _ in 0..<12 {
            window.contentView?.layoutSubtreeIfNeeded()
            RunLoop.main.run(until: Date().addingTimeInterval(0.03))
        }
    }

    private static func instantiatedCellCount(in tableView: NSTableView) -> Int {
        (0..<tableView.numberOfRows).reduce(into: 0) { count, row in
            if tableView.view(atColumn: 0, row: row, makeIfNecessary: false) != nil {
                count += 1
            }
        }
    }
}

@MainActor
enum AppKitTimelineIntegrationHarness {
    static func run(store: AppStore) async {
        let hostingView = NSHostingView(
            rootView: RootView()
                .environmentObject(store)
                .frame(width: 1440, height: 900)
        )
        let window = NSWindow(
            contentRect: NSRect(x: -20_000, y: -20_000, width: 1440, height: 900),
            styleMask: .borderless,
            backing: .buffered,
            defer: false
        )
        window.alphaValue = 0
        window.ignoresMouseEvents = true
        window.contentView = hostingView
        window.orderOut(nil)
        hostingView.layoutSubtreeIfNeeded()

        let deadline = Date().addingTimeInterval(12)
        while store.sessions.isEmpty, Date() < deadline {
            try? await Task.sleep(for: .milliseconds(100))
        }

        let sessions = Array(store.sidebarNavigationSessions.prefix(10))
        guard sessions.count >= 3 else {
            AppLogger.error("AppKit integration harness could not load enough sessions")
            exit(EXIT_FAILURE)
        }

        let clock = ContinuousClock()
        let started = clock.now
        var slowest: Duration = .zero
        for _ in 0..<4 {
            for session in sessions {
                let selectionStarted = clock.now
                await store.select(sessionID: session.id)
                hostingView.layoutSubtreeIfNeeded()
                let elapsed = selectionStarted.duration(to: clock.now)
                slowest = max(slowest, elapsed)
                try? await Task.sleep(for: .milliseconds(90))
            }
        }
        try? await Task.sleep(for: .milliseconds(500))

        guard AppKitTimelineDiagnostics.coordinatorCount > 0,
              AppKitTimelineDiagnostics.updateCount >= sessions.count,
              AppKitTimelineDiagnostics.sameSessionFallbackReloadCount == 0,
              AppKitTimelineDiagnostics.bottomRequestCount <= sessions.count * 4 + 5 else {
            AppLogger.error(
                "AppKit integration harness recycler invariant failed " +
                "coordinators=\(AppKitTimelineDiagnostics.coordinatorCount) " +
                "updates=\(AppKitTimelineDiagnostics.updateCount) " +
                "fallback_reloads=\(AppKitTimelineDiagnostics.sameSessionFallbackReloadCount) " +
                "bottom_requests=\(AppKitTimelineDiagnostics.bottomRequestCount)"
            )
            exit(EXIT_FAILURE)
        }

        AppLogger.info(
            "AppKit integration harness passed switches=\(sessions.count * 4) " +
            "elapsed=\(started.duration(to: clock.now)) slowest=\(slowest) " +
            "recycler_updates=\(AppKitTimelineDiagnostics.updateCount) " +
            "fallback_reloads=\(AppKitTimelineDiagnostics.sameSessionFallbackReloadCount) " +
            "bottom_requests=\(AppKitTimelineDiagnostics.bottomRequestCount)"
        )
        window.contentView = nil
        fflush(stdout)
        fflush(stderr)
        exit(EXIT_SUCCESS)
    }
}

private final class TimelineHostingCellView: NSTableCellView {
    private let hostingView = NSHostingView(rootView: AnyView(EmptyView()))
    private var renderedItemID: String?
    private var renderedVersion: Int?

    init(identifier: NSUserInterfaceItemIdentifier) {
        super.init(frame: .zero)
        self.identifier = identifier
        hostingView.translatesAutoresizingMaskIntoConstraints = false
        hostingView.setContentHuggingPriority(.defaultLow, for: .horizontal)
        hostingView.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        addSubview(hostingView)
        NSLayoutConstraint.activate([
            hostingView.leadingAnchor.constraint(equalTo: leadingAnchor),
            hostingView.trailingAnchor.constraint(equalTo: trailingAnchor),
            hostingView.topAnchor.constraint(equalTo: topAnchor),
            hostingView.bottomAnchor.constraint(equalTo: bottomAnchor)
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func configure(with item: AppKitTimelineItem) {
        guard renderedItemID != item.id || renderedVersion != item.version else { return }
        renderedItemID = item.id
        renderedVersion = item.version
        hostingView.rootView = item.content
        hostingView.invalidateIntrinsicContentSize()
    }
}
#endif
