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
    let eventIDs: [String]
    private let contentFactory: () -> AnyView

    init(
        id: String,
        version: Int,
        eventIDs: [String] = [],
        content: @autoclosure @escaping () -> AnyView
    ) {
        self.id = id
        self.version = version
        self.eventIDs = eventIDs
        self.contentFactory = content
    }

    func makeContent() -> AnyView {
        contentFactory()
    }
}

@MainActor
private enum AppKitTimelineDiagnostics {
    static var coordinatorCount = 0
    static var updateCount = 0
    static var sameSessionFallbackReloadCount = 0
    static var bottomRequestCount = 0
    static var lastAnchorID: String?
    static var lastAnchorTargetY: CGFloat?
    static var lastAnchorVisibleY: CGFloat?
}

private final class AppKitTimelineRowHeightKey: NSObject {
    let sessionID: String
    let itemID: String
    let version: Int
    let widthBucket: Int
    private let cachedHash: Int

    init(sessionID: String, itemID: String, version: Int, widthBucket: Int) {
        self.sessionID = sessionID
        self.itemID = itemID
        self.version = version
        self.widthBucket = widthBucket
        var hasher = Hasher()
        hasher.combine(sessionID)
        hasher.combine(itemID)
        hasher.combine(version)
        hasher.combine(widthBucket)
        cachedHash = hasher.finalize()
    }

    override var hash: Int { cachedHash }

    override func isEqual(_ object: Any?) -> Bool {
        guard let other = object as? AppKitTimelineRowHeightKey else { return false }
        return sessionID == other.sessionID &&
            itemID == other.itemID &&
            version == other.version &&
            widthBucket == other.widthBucket
    }
}

@MainActor
private final class AppKitTimelineOwningScrollView: NSScrollView {
    var onVerticalWheel: (() -> Void)?
    private var wheelMonitor: Any?

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        stopRoutingWheelEvents()
        guard window != nil else { return }
        wheelMonitor = NSEvent.addLocalMonitorForEvents(matching: .scrollWheel) { [weak self] event in
            self?.routeWheelEventIfNeeded(event) ?? event
        }
    }

    override func scrollWheel(with event: NSEvent) {
        onVerticalWheel?()
        super.scrollWheel(with: event)
    }

    func stopRoutingWheelEvents() {
        guard let wheelMonitor else { return }
        NSEvent.removeMonitor(wheelMonitor)
        self.wheelMonitor = nil
    }

    private func routeWheelEventIfNeeded(_ event: NSEvent) -> NSEvent? {
        guard let window,
              event.windowNumber == window.windowNumber,
              !isHidden,
              alphaValue > 0 else { return event }

        let verticalDelta = event.hasPreciseScrollingDeltas ? event.scrollingDeltaY : event.deltaY
        let horizontalDelta = event.hasPreciseScrollingDeltas ? event.scrollingDeltaX : event.deltaX
        guard abs(verticalDelta) > 0.01,
              abs(verticalDelta) >= abs(horizontalDelta) else { return event }

        let point = convert(event.locationInWindow, from: nil)
        guard bounds.contains(point),
              let contentView = window.contentView else { return event }
        let contentPoint = contentView.convert(event.locationInWindow, from: nil)
        guard let hitView = contentView.hitTest(contentPoint),
              hitView === self || hitView.isDescendant(of: self) else { return event }

        onVerticalWheel?()
        super.scrollWheel(with: event)
        return nil
    }
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
        private var tableColumnResizeObserver: NSObjectProtocol?
        private var liveScrollStartObserver: NSObjectProtocol?
        private var liveScrollEndObserver: NSObjectProtocol?
        private var reportWorkItem: DispatchWorkItem?
        private var reportWorkGeneration = 0
        private var lastMetricsReportUptime: TimeInterval?
        private var lastMetrics: TimelineScrollMetrics?
        private var lastColumnWidth: CGFloat?
        private var isRefreshingColumnWidth = false
        private var deferredItems: [AppKitTimelineItem]?
        private var deferredColumnWidthRefresh = false
        private let rowHeightCache = NSCache<AppKitTimelineRowHeightKey, NSNumber>()
        private let fallbackRowHeightCache = NSCache<AppKitTimelineRowHeightKey, NSNumber>()
        private var pendingHeightUpdates = Set<PendingHeightUpdate>()
        private var heightUpdateWorkItem: DispatchWorkItem?
        private var heightUpdateGeneration = 0
        private var discreteScrollSettleWorkItem: DispatchWorkItem?
        private var discreteScrollGeneration = 0
        private var isDiscreteScrolling = false
        private var scrollIsolationInstalled = false
        private var geometryMutationDepth = 0
        private var liveScrollStartOriginY: CGFloat?
        private var liveScrollStartUptime: TimeInterval?
        private var liveScrollUnknownHeightCount = 0
        private var liveScrollConfiguredCellCount = 0
        private let metricsThrottleInterval: TimeInterval = 0.08
        private let estimatedRowHeight: CGFloat = 120

        private(set) var fullReloadCount = 0
        private(set) var structuralUpdateCount = 0
        private(set) var cellConfigurationCount = 0
        private(set) var clipOriginWriteCount = 0
        private(set) var heightInvalidationCount = 0
        private(set) var heightMeasurementCount = 0
        private(set) var wheelInputCount = 0
        private(set) var isLiveScrolling = false

        private var isScrollInteractionActive: Bool {
            isLiveScrolling || isDiscreteScrolling
        }

        private let cellIdentifier = NSUserInterfaceItemIdentifier("AgentsDockTimelineHostingCell")

        init(onMetrics: @escaping (TimelineScrollMetrics) -> Void) {
            self.onMetrics = onMetrics
            rowHeightCache.countLimit = 40_000
            fallbackRowHeightCache.countLimit = 40_000
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
            tableView.rowHeight = estimatedRowHeight
            tableView.usesAutomaticRowHeights = false
            tableView.style = .plain
            tableView.columnAutoresizingStyle = .uniformColumnAutoresizingStyle
            tableView.allowsColumnReordering = false
            tableView.allowsColumnResizing = false
            tableView.allowsMultipleSelection = false
            tableView.allowsEmptySelection = true
            // Keep the table visually selection-neutral, but do not reject row
            // selection in the delegate. Rejecting it causes NSTableView to win
            // the mouse gesture before SwiftUI's selectable text can establish
            // a range inside the hosted row.
            tableView.selectionHighlightStyle = .none
            tableView.focusRingType = .none

            let scrollView = AppKitTimelineOwningScrollView(frame: .zero)
            scrollView.identifier = NSUserInterfaceItemIdentifier("AgentsDockTimelineScrollView")
            scrollView.onVerticalWheel = { [weak self] in
                self?.noteWheelInput()
            }
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

        func tableView(_ tableView: NSTableView, heightOfRow row: Int) -> CGFloat {
            guard items.indices.contains(row) else { return estimatedRowHeight }
            let item = items[row]
            let width = actualColumnWidth(nil, in: tableView)
            if let exact = rowHeightCache.object(forKey: heightKey(for: item, width: width)) {
                return max(1, CGFloat(exact.doubleValue))
            }
            if let fallback = fallbackRowHeightCache.object(forKey: fallbackHeightKey(for: item)) {
                return max(1, CGFloat(fallback.doubleValue))
            }
            if isScrollInteractionActive {
                liveScrollUnknownHeightCount += 1
            }
            return estimatedRowHeight
        }

        func tableView(
            _ tableView: NSTableView,
            viewFor tableColumn: NSTableColumn?,
            row: Int
        ) -> NSView? {
            guard items.indices.contains(row) else { return nil }
            let cell = tableView.makeView(withIdentifier: cellIdentifier, owner: self) as? TimelineHostingCellView
                ?? TimelineHostingCellView(identifier: cellIdentifier)
            configure(
                cell,
                with: items[row],
                width: actualColumnWidth(tableColumn, in: tableView)
            )
            queueCachedHeightCorrectionIfNeeded(
                forRow: row,
                item: items[row],
                width: actualColumnWidth(tableColumn, in: tableView)
            )
            if isScrollInteractionActive {
                liveScrollConfiguredCellCount += 1
            }
            cellConfigurationCount += 1
            return cell
        }

        func update(
            sessionID nextSessionID: String?,
            items nextItems: [AppKitTimelineItem],
            scrollCommand: AppKitTimelineScrollCommand,
            forcedBottomRevision: Int = 0
        ) {
            guard tableView != nil else { return }
            AppKitTimelineDiagnostics.updateCount += 1

            let previousItems = items
            let sessionChanged = sessionID != nextSessionID
            if sessionChanged {
                // Momentum belongs to the old document. A chat switch is an
                // explicit navigation and must position the new document once.
                isLiveScrolling = false
                isDiscreteScrolling = false
                scrollIsolationInstalled = false
                cancelDiscreteScrollSettle()
                deferredItems = nil
                deferredColumnWidthRefresh = false
                cancelScheduledHeightUpdate(clearPending: true)
            }
            let commandChanged = hasReceivedUpdate && scrollCommand.revision != lastScrollCommandRevision
            let forcedBottomChanged = hasReceivedUpdate && forcedBottomRevision != lastForcedBottomRevision
            let commandChangesPosition = commandChanged && scrollCommand.destination != .none

            // AppKit's automatic row-height pass mutates the document geometry as
            // rows are inserted or reconfigured. Doing that in the middle of a
            // trackpad gesture fights the clip view's momentum and produces the
            // characteristic up/down tug. Keep only the newest immutable snapshot
            // and apply it once momentum ends. Explicit navigation still wins.
            if isScrollInteractionActive,
               !sessionChanged,
               !commandChangesPosition,
               !forcedBottomChanged {
                deferredItems = nextItems
                return
            }
            deferredItems = nil
            let anchor = !sessionChanged &&
                !isScrollInteractionActive &&
                !commandChangesPosition &&
                !forcedBottomChanged
                ? captureAnchor()
                : nil
            let rowIdentityOrderUnchanged = previousItems.count == nextItems.count &&
                zip(previousItems, nextItems).allSatisfy { $0.id == $1.id }
            let shouldRestoreAnchor = anchor.map {
                !rowIdentityOrderUnchanged &&
                    geometryChangesAffectAnchor($0, previousItems: previousItems, nextItems: nextItems)
            } ?? false

            sessionID = nextSessionID
            let itemsChanged = performGeometryMutation {
                applyItems(
                    nextItems,
                    previousItems: previousItems,
                    sessionChanged: sessionChanged
                )
            }

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

            if commandChangesPosition {
                apply(scrollCommand.destination)
            } else if forcedBottomChanged {
                if !isScrollInteractionActive {
                    scrollToBottom()
                }
            } else if sessionChanged || (previousItems.isEmpty && !nextItems.isEmpty) {
                if !isScrollInteractionActive {
                    scrollToBottom()
                }
            } else if shouldRestoreAnchor, let anchor {
                restore(anchor)
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
                let changed = refreshRetainedRows(
                    in: tableView,
                    previousItems: previousItems,
                    nextItems: nextItems
                )
                return !changed.isEmpty
            }

            if newIDs.starts(with: oldIDs) {
                items = nextItems
                let inserted = IndexSet(oldIDs.count..<newIDs.count)
                structuralUpdateCount += 1
                tableView.insertRows(at: inserted, withAnimation: [])
                refreshRetainedRows(
                    in: tableView,
                    previousItems: previousItems,
                    nextItems: nextItems
                )
                return true
            }

            if newIDs.suffix(oldIDs.count).elementsEqual(oldIDs) {
                items = nextItems
                let inserted = IndexSet(0..<(newIDs.count - oldIDs.count))
                structuralUpdateCount += 1
                tableView.insertRows(at: inserted, withAnimation: [])
                refreshRetainedRows(
                    in: tableView,
                    previousItems: previousItems,
                    nextItems: nextItems
                )
                return true
            }

            if oldIDs.starts(with: newIDs) {
                items = nextItems
                let removed = IndexSet(newIDs.count..<oldIDs.count)
                structuralUpdateCount += 1
                tableView.removeRows(at: removed, withAnimation: [])
                refreshRetainedRows(
                    in: tableView,
                    previousItems: previousItems,
                    nextItems: nextItems
                )
                return true
            }

            if oldIDs.suffix(newIDs.count).elementsEqual(newIDs) {
                items = nextItems
                let removed = IndexSet(0..<(oldIDs.count - newIDs.count))
                structuralUpdateCount += 1
                tableView.removeRows(at: removed, withAnimation: [])
                refreshRetainedRows(
                    in: tableView,
                    previousItems: previousItems,
                    nextItems: nextItems
                )
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
                refreshRetainedRows(
                    in: tableView,
                    previousItems: previousItems,
                    nextItems: nextItems
                )
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
                refreshRetainedRows(
                    in: tableView,
                    previousItems: previousItems,
                    nextItems: nextItems
                )
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
            refreshRetainedRows(
                in: tableView,
                previousItems: previousItems,
                nextItems: nextItems
            )
            return true
        }

        @discardableResult
        private func refreshRetainedRows(
            in tableView: NSTableView,
            previousItems: [AppKitTimelineItem],
            nextItems: [AppKitTimelineItem]
        ) -> IndexSet {
            var previousVersionsByID: [String: Int] = [:]
            previousVersionsByID.reserveCapacity(previousItems.count)
            for item in previousItems {
                previousVersionsByID[item.id] = item.version
            }
            let changed = IndexSet(nextItems.indices.filter { index in
                guard let previousVersion = previousVersionsByID[nextItems[index].id] else {
                    return false
                }
                return previousVersion != nextItems[index].version
            })
            refreshVisibleCells(in: tableView, limitingTo: changed)
            return changed
        }

        private func invalidateHeights(of rows: IndexSet, in tableView: NSTableView) {
            guard !rows.isEmpty else { return }
            heightInvalidationCount += 1
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0
                tableView.noteHeightOfRows(withIndexesChanged: rows)
            }
        }

        private struct PendingHeightUpdate: Hashable {
            let sessionID: String
            let itemID: String
            let version: Int
            let widthBucket: Int
        }

        private static let fallbackWidthBucket = Int.min

        private func cacheSessionID(_ value: String? = nil) -> String {
            value ?? sessionID ?? "<no-session>"
        }

        private func widthBucket(_ width: CGFloat) -> Int {
            Int((max(1, width) * 2).rounded())
        }

        private func heightKey(
            for item: AppKitTimelineItem,
            width: CGFloat,
            sessionID value: String? = nil
        ) -> AppKitTimelineRowHeightKey {
            AppKitTimelineRowHeightKey(
                sessionID: cacheSessionID(value),
                itemID: item.id,
                version: item.version,
                widthBucket: widthBucket(width)
            )
        }

        private func fallbackHeightKey(
            for item: AppKitTimelineItem,
            sessionID value: String? = nil
        ) -> AppKitTimelineRowHeightKey {
            AppKitTimelineRowHeightKey(
                sessionID: cacheSessionID(value),
                itemID: item.id,
                version: item.version,
                widthBucket: Self.fallbackWidthBucket
            )
        }

        private func configure(
            _ cell: TimelineHostingCellView,
            with item: AppKitTimelineItem,
            width: CGFloat
        ) {
            let configuredSessionID = cacheSessionID()
            cell.configure(
                with: item,
                forWidth: width,
                heightReportingEnabled: !isScrollInteractionActive
            ) { [weak self] itemID, version, measuredWidth, measuredHeight in
                self?.recordMeasuredHeight(
                    measuredHeight,
                    itemID: itemID,
                    version: version,
                    width: measuredWidth,
                    sessionID: configuredSessionID
                )
            }
        }

        private func recordMeasuredHeight(
            _ measuredHeight: CGFloat,
            itemID: String,
            version: Int,
            width: CGFloat,
            sessionID measuredSessionID: String
        ) {
            guard measuredHeight.isFinite,
                  measuredHeight > 0,
                  measuredSessionID == cacheSessionID(),
                  let row = items.firstIndex(where: { $0.id == itemID }),
                  items[row].version == version,
                  let tableView else { return }

            let currentWidth = actualColumnWidth(nil, in: tableView)
            let measuredWidthBucket = widthBucket(width)
            guard measuredWidthBucket == widthBucket(currentWidth) else { return }

            let item = items[row]
            let height = ceil(measuredHeight)
            let exactKey = heightKey(for: item, width: width, sessionID: measuredSessionID)
            rowHeightCache.setObject(NSNumber(value: Double(height)), forKey: exactKey)
            fallbackRowHeightCache.setObject(
                NSNumber(value: Double(height)),
                forKey: fallbackHeightKey(for: item, sessionID: measuredSessionID)
            )
            heightMeasurementCount += 1

            guard abs(tableView.rect(ofRow: row).height - height) > 0.5 else { return }
            pendingHeightUpdates.insert(PendingHeightUpdate(
                sessionID: measuredSessionID,
                itemID: itemID,
                version: version,
                widthBucket: measuredWidthBucket
            ))
            guard !isScrollInteractionActive else { return }
            scheduleHeightUpdate()
        }

        private func queueCachedHeightCorrectionIfNeeded(
            forRow row: Int,
            item: AppKitTimelineItem,
            width: CGFloat
        ) {
            guard let tableView,
                  let cached = rowHeightCache.object(forKey: heightKey(for: item, width: width)),
                  abs(tableView.rect(ofRow: row).height - CGFloat(cached.doubleValue)) > 0.5 else {
                return
            }
            pendingHeightUpdates.insert(PendingHeightUpdate(
                sessionID: cacheSessionID(),
                itemID: item.id,
                version: item.version,
                widthBucket: widthBucket(width)
            ))
            guard !isScrollInteractionActive else { return }
            scheduleHeightUpdate()
        }

        private func scheduleHeightUpdate() {
            guard !isScrollInteractionActive,
                  heightUpdateWorkItem == nil,
                  !pendingHeightUpdates.isEmpty else { return }
            heightUpdateGeneration &+= 1
            let generation = heightUpdateGeneration
            let workItem = DispatchWorkItem { [weak self] in
                MainActor.assumeIsolated {
                    guard let self, self.heightUpdateGeneration == generation else { return }
                    self.heightUpdateWorkItem = nil
                    self.flushPendingHeightUpdates()
                }
            }
            heightUpdateWorkItem = workItem
            DispatchQueue.main.async(execute: workItem)
        }

        private func cancelScheduledHeightUpdate(clearPending: Bool) {
            heightUpdateGeneration &+= 1
            heightUpdateWorkItem?.cancel()
            heightUpdateWorkItem = nil
            if clearPending {
                pendingHeightUpdates.removeAll(keepingCapacity: true)
            }
        }

        private func flushPendingHeightUpdates() {
            guard !isScrollInteractionActive,
                  let tableView,
                  let scrollView,
                  !pendingHeightUpdates.isEmpty else { return }

            let currentSessionID = cacheSessionID()
            let currentWidthBucket = widthBucket(actualColumnWidth(nil, in: tableView))
            let visibleTop = scrollView.documentVisibleRect.minY
            let updates = pendingHeightUpdates
            pendingHeightUpdates.removeAll(keepingCapacity: true)
            let rows = IndexSet(updates.compactMap { update in
                guard update.sessionID == currentSessionID,
                      update.widthBucket == currentWidthBucket,
                      let row = items.firstIndex(where: { $0.id == update.itemID }),
                      items[row].version == update.version,
                      tableView.rect(ofRow: row).maxY > visibleTop + 0.5 else { return nil }
                return row
            })
            guard !rows.isEmpty else { return }

            let anchor = captureAnchor()
            let anchorRow = anchor.flatMap { index(of: $0, in: items) }
            let affectsRowsAboveAnchor = anchorRow.map { anchorRow in
                rows.contains(where: { $0 < anchorRow })
            } ?? false
            let originBefore = scrollView.documentVisibleRect.minY
            let startedAt = ProcessInfo.processInfo.systemUptime

            performGeometryMutation {
                invalidateHeights(of: rows, in: tableView)
                tableView.layoutSubtreeIfNeeded()

                if affectsRowsAboveAnchor, let anchor {
                    restoreKnown(anchor, in: scrollView, tableView: tableView)
                }
            }
            let originAfter = scrollView.documentVisibleRect.minY
            AppLogger.info(
                "PERF native height flush rows=\(rows.count) " +
                    "above_anchor=\(affectsRowsAboveAnchor) " +
                    "origin=\(Self.format(originBefore))->\(Self.format(originAfter)) " +
                    "ms=\(Self.format((ProcessInfo.processInfo.systemUptime - startedAt) * 1_000))"
            )
            scheduleMetricsReport()
        }

        private static func format(_ value: CGFloat) -> String {
            String(format: "%.1f", Double(value))
        }

        private static func format(_ value: TimeInterval) -> String {
            String(format: "%.1f", value)
        }

        private func restoreKnown(
            _ anchor: VisibleAnchor,
            in scrollView: NSScrollView,
            tableView: NSTableView
        ) {
            guard let row = index(of: anchor, in: items) else { return }
            let targetY = tableView.rect(ofRow: row).minY + anchor.offset
            scroll(toY: targetY, in: scrollView, tableView: tableView)
        }

        private func refreshVisibleCells(in tableView: NSTableView, limitingTo limit: IndexSet? = nil) {
            let visibleRange = tableView.rows(in: tableView.visibleRect)
            guard visibleRange.location != NSNotFound, visibleRange.length > 0 else { return }
            let upperBound = min(items.count, visibleRange.location + visibleRange.length)
            guard visibleRange.location < upperBound else { return }
            let width = actualColumnWidth(nil, in: tableView)

            for row in visibleRange.location..<upperBound {
                if let limit, !limit.contains(row) { continue }
                guard let cell = tableView.view(atColumn: 0, row: row, makeIfNecessary: false)
                    as? TimelineHostingCellView else { continue }
                configure(cell, with: items[row], width: width)
                queueCachedHeightCorrectionIfNeeded(forRow: row, item: items[row], width: width)
                cellConfigurationCount += 1
            }
        }

        private func setVisibleHeightReporting(_ enabled: Bool, in tableView: NSTableView) {
            let visibleRange = tableView.rows(in: tableView.visibleRect)
            guard visibleRange.location != NSNotFound, visibleRange.length > 0 else { return }
            let upperBound = min(items.count, visibleRange.location + visibleRange.length)
            guard visibleRange.location < upperBound else { return }
            for row in visibleRange.location..<upperBound {
                guard let cell = tableView.view(atColumn: 0, row: row, makeIfNecessary: false)
                    as? TimelineHostingCellView else { continue }
                cell.setHeightReportingEnabled(enabled)
            }
        }

        private func actualColumnWidth(
            _ tableColumn: NSTableColumn?,
            in tableView: NSTableView
        ) -> CGFloat {
            max(1, tableColumn?.width ?? tableView.tableColumns.first?.width ?? tableView.bounds.width)
        }

        private func refreshForColumnWidthChange(in tableView: NSTableView) {
            guard !isRefreshingColumnWidth else { return }
            if isScrollInteractionActive {
                deferredColumnWidthRefresh = true
                return
            }
            let width = actualColumnWidth(nil, in: tableView)
            if let lastColumnWidth, abs(width - lastColumnWidth) <= 0.5 { return }
            deferredColumnWidthRefresh = false
            lastColumnWidth = width
            guard !items.isEmpty else { return }

            let anchor = isScrollInteractionActive ? nil : captureAnchor()
            isRefreshingColumnWidth = true
            defer { isRefreshingColumnWidth = false }

            performGeometryMutation {
                refreshVisibleCells(in: tableView)
                invalidateHeights(
                    of: IndexSet(integersIn: 0..<items.count),
                    in: tableView
                )
                tableView.layoutSubtreeIfNeeded()
                if let anchor {
                    restore(anchor)
                }
            }
        }

        private struct VisibleAnchor {
            let itemID: String
            let eventID: String?
            let offset: CGFloat
        }

        private func captureAnchor() -> VisibleAnchor? {
            guard let scrollView, let tableView, !items.isEmpty else { return nil }
            let visibleRect = scrollView.documentVisibleRect
            let visibleRows = tableView.rows(in: visibleRect)
            guard visibleRows.location != NSNotFound else { return nil }
            var row = visibleRows.location
            // The loader is a control, not timeline content. When an older page
            // is inserted after it, pin the first real row so the newly revealed
            // messages land above the viewport and upward scrolling can continue.
            while items.indices.contains(row),
                  items[row].eventIDs.isEmpty,
                  items.indices.contains(row + 1) {
                row += 1
            }
            guard items.indices.contains(row) else { return nil }
            AppKitTimelineDiagnostics.lastAnchorID = items[row].id
            return VisibleAnchor(
                itemID: items[row].id,
                eventID: items[row].eventIDs.first,
                offset: visibleRect.minY - tableView.rect(ofRow: row).minY
            )
        }

        private func restore(_ anchor: VisibleAnchor) {
            guard let row = index(of: anchor, in: items),
                  let scrollView,
                  let tableView else { return }
            prepareForPositioning(row: row, in: tableView)
            let rowRect = tableView.rect(ofRow: row)
            let targetY = rowRect.minY + anchor.offset
            AppKitTimelineDiagnostics.lastAnchorTargetY = targetY
            scroll(toY: targetY, in: scrollView, tableView: tableView)
            AppKitTimelineDiagnostics.lastAnchorVisibleY = scrollView.documentVisibleRect.minY
        }

        private func index(of anchor: VisibleAnchor, in candidates: [AppKitTimelineItem]) -> Int? {
            if let exact = candidates.firstIndex(where: { $0.id == anchor.itemID }) {
                return exact
            }
            guard let eventID = anchor.eventID else { return nil }
            return candidates.firstIndex(where: { $0.eventIDs.contains(eventID) })
        }

        private func geometryChangesAffectAnchor(
            _ anchor: VisibleAnchor,
            previousItems: [AppKitTimelineItem],
            nextItems: [AppKitTimelineItem]
        ) -> Bool {
            guard let previousAnchorIndex = index(of: anchor, in: previousItems),
                  let nextAnchorIndex = index(of: anchor, in: nextItems) else {
                return false
            }
            guard previousAnchorIndex == nextAnchorIndex else { return true }
            for row in 0...previousAnchorIndex {
                if previousItems[row].id != nextItems[row].id ||
                    previousItems[row].version != nextItems[row].version {
                    return true
                }
            }
            return false
        }

        private func apply(_ destination: AppKitTimelineScrollCommand.Destination) {
            switch destination {
            case .none:
                break
            case .bottom:
                scrollToBottom()
            case .row(let id, let anchor):
                scroll(to: id, anchor: anchor)
            }
        }

        private func scrollToBottom() {
            guard let scrollView, let tableView, !items.isEmpty else { return }
            AppKitTimelineDiagnostics.bottomRequestCount += 1
            prepareForPositioning(row: items.count - 1, in: tableView)
            let targetY = max(0, tableView.bounds.maxY - scrollView.contentView.bounds.height)
            scroll(toY: targetY, in: scrollView, tableView: tableView)
            scheduleMetricsReport()
        }

        private func scroll(to itemID: String, anchor: AppKitTimelineAnchor) {
            guard let row = items.firstIndex(where: { $0.id == itemID }),
                  let scrollView,
                  let tableView else { return }
            prepareForPositioning(row: row, in: tableView)
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

        private func prepareForPositioning(row: Int, in tableView: NSTableView) {
            guard items.indices.contains(row) else { return }
            performGeometryMutation {
                tableView.scrollRowToVisible(row)
                tableView.layoutSubtreeIfNeeded()
                _ = tableView.view(atColumn: 0, row: row, makeIfNecessary: true)
                refreshVisibleCells(in: tableView)

                var rows = IndexSet(integer: row)
                let visibleRows = tableView.rows(in: tableView.visibleRect)
                if visibleRows.location != NSNotFound, visibleRows.length > 0 {
                    let upperBound = min(items.count, visibleRows.location + visibleRows.length)
                    if visibleRows.location < upperBound {
                        rows.insert(integersIn: visibleRows.location..<upperBound)
                    }
                }
                invalidateHeights(of: rows, in: tableView)
                tableView.layoutSubtreeIfNeeded()
            }
        }

        private func scroll(toY proposedY: CGFloat, in scrollView: NSScrollView, tableView: NSTableView) {
            let maxY = max(0, tableView.bounds.maxY - scrollView.contentView.bounds.height)
            let point = NSPoint(x: scrollView.contentView.bounds.minX, y: min(max(0, proposedY), maxY))
            guard scrollView.contentView.bounds.origin != point else { return }
            performGeometryMutation {
                NSAnimationContext.runAnimationGroup { context in
                    context.duration = 0
                    scrollView.contentView.scroll(to: point)
                }
                scrollView.reflectScrolledClipView(scrollView.contentView)
            }
            clipOriginWriteCount += 1
        }

        private func performGeometryMutation<T>(_ body: () -> T) -> T {
            geometryMutationDepth += 1
            defer { geometryMutationDepth -= 1 }
            return body()
        }

        private func beginScrollIsolationIfNeeded() {
            guard !scrollIsolationInstalled else { return }
            scrollIsolationInstalled = true
            liveScrollStartOriginY = scrollView?.documentVisibleRect.minY
            liveScrollStartUptime = ProcessInfo.processInfo.systemUptime
            liveScrollUnknownHeightCount = 0
            liveScrollConfiguredCellCount = 0
            cancelScheduledHeightUpdate(clearPending: false)
            if let tableView {
                setVisibleHeightReporting(false, in: tableView)
            }
        }

        private func finishScrollIsolationIfIdle() {
            guard scrollIsolationInstalled, !isScrollInteractionActive else { return }
            scrollIsolationInstalled = false
            let originBeforeSettle = scrollView?.documentVisibleRect.minY ?? 0
            let duration = liveScrollStartUptime.map {
                ProcessInfo.processInfo.systemUptime - $0
            } ?? 0
            flushDeferredScrollWork()
            if let tableView {
                setVisibleHeightReporting(true, in: tableView)
            }
            scheduleHeightUpdate()
            AppLogger.info(
                "PERF native scroll settle " +
                    "origin=\(Self.format(liveScrollStartOriginY ?? originBeforeSettle))" +
                    "->\(Self.format(originBeforeSettle)) " +
                    "duration_ms=\(Self.format(duration * 1_000)) " +
                    "unknown_heights=\(liveScrollUnknownHeightCount) " +
                    "configured_cells=\(liveScrollConfiguredCellCount) " +
                    "pending_heights=\(pendingHeightUpdates.count)"
            )
            liveScrollStartOriginY = nil
            liveScrollStartUptime = nil
            scheduleMetricsReport()
        }

        private func noteUserBoundsChange() {
            guard geometryMutationDepth == 0 else { return }
            isDiscreteScrolling = true
            beginScrollIsolationIfNeeded()
            scheduleDiscreteScrollSettle()
        }

        private func noteWheelInput() {
            guard geometryMutationDepth == 0 else { return }
            wheelInputCount += 1
            isDiscreteScrolling = true
            beginScrollIsolationIfNeeded()
            scheduleDiscreteScrollSettle()
        }

        private func scheduleDiscreteScrollSettle() {
            discreteScrollGeneration &+= 1
            let generation = discreteScrollGeneration
            discreteScrollSettleWorkItem?.cancel()
            let workItem = DispatchWorkItem { [weak self] in
                MainActor.assumeIsolated {
                    guard let self, self.discreteScrollGeneration == generation else { return }
                    self.discreteScrollSettleWorkItem = nil
                    self.isDiscreteScrolling = false
                    self.finishScrollIsolationIfIdle()
                }
            }
            discreteScrollSettleWorkItem = workItem
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.18, execute: workItem)
        }

        private func cancelDiscreteScrollSettle() {
            discreteScrollGeneration &+= 1
            discreteScrollSettleWorkItem?.cancel()
            discreteScrollSettleWorkItem = nil
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
                    self?.noteUserBoundsChange()
                    self?.scheduleMetricsReport()
                }
            }

            tableView.postsFrameChangedNotifications = true
            tableFrameObserver = center.addObserver(
                forName: NSView.frameDidChangeNotification,
                object: tableView,
                queue: .main
            ) { [weak self, weak tableView] _ in
                MainActor.assumeIsolated {
                    if let tableView {
                        self?.refreshForColumnWidthChange(in: tableView)
                    }
                    self?.scheduleMetricsReport()
                }
            }
            tableColumnResizeObserver = center.addObserver(
                forName: NSTableView.columnDidResizeNotification,
                object: tableView,
                queue: .main
            ) { [weak self, weak tableView] _ in
                MainActor.assumeIsolated {
                    if let tableView {
                        self?.refreshForColumnWidthChange(in: tableView)
                    }
                }
            }
            liveScrollStartObserver = center.addObserver(
                forName: NSScrollView.willStartLiveScrollNotification,
                object: scrollView,
                queue: .main
            ) { [weak self] _ in
                MainActor.assumeIsolated {
                    guard let self else { return }
                    self.isLiveScrolling = true
                    self.beginScrollIsolationIfNeeded()
                    self.scheduleMetricsReport()
                }
            }
            liveScrollEndObserver = center.addObserver(
                forName: NSScrollView.didEndLiveScrollNotification,
                object: scrollView,
                queue: .main
            ) { [weak self] _ in
                MainActor.assumeIsolated {
                    guard let self else { return }
                    self.isLiveScrolling = false
                    self.finishScrollIsolationIfIdle()
                }
            }
        }

        private func flushDeferredScrollWork() {
            guard let tableView else { return }
            if let deferredItems {
                self.deferredItems = nil
                let previousItems = items
                let anchor = captureAnchor()
                let shouldRestoreAnchor = anchor.map {
                    geometryChangesAffectAnchor(
                        $0,
                        previousItems: previousItems,
                        nextItems: deferredItems
                    )
                } ?? false
                _ = performGeometryMutation {
                    applyItems(
                        deferredItems,
                        previousItems: previousItems,
                        sessionChanged: false
                    )
                }
                if shouldRestoreAnchor, let anchor {
                    restore(anchor)
                }
            }
            if deferredColumnWidthRefresh {
                refreshForColumnWidthChange(in: tableView)
            }
        }

        func stopObserving() {
            let center = NotificationCenter.default
            (scrollView as? AppKitTimelineOwningScrollView)?.stopRoutingWheelEvents()
            if let boundsObserver { center.removeObserver(boundsObserver) }
            if let tableFrameObserver { center.removeObserver(tableFrameObserver) }
            if let tableColumnResizeObserver { center.removeObserver(tableColumnResizeObserver) }
            if let liveScrollStartObserver { center.removeObserver(liveScrollStartObserver) }
            if let liveScrollEndObserver { center.removeObserver(liveScrollEndObserver) }
            boundsObserver = nil
            tableFrameObserver = nil
            tableColumnResizeObserver = nil
            liveScrollStartObserver = nil
            liveScrollEndObserver = nil
            isLiveScrolling = false
            isDiscreteScrolling = false
            scrollIsolationInstalled = false
            deferredItems = nil
            deferredColumnWidthRefresh = false
            cancelDiscreteScrollSettle()
            cancelScheduledHeightUpdate(clearPending: true)
            cancelScheduledMetricsReport()
        }

        private func scheduleMetricsReport() {
            let now = ProcessInfo.processInfo.systemUptime
            let nextAllowedUptime = (lastMetricsReportUptime ?? now - metricsThrottleInterval) + metricsThrottleInterval
            let delay = max(0, nextAllowedUptime - now)
            guard reportWorkItem == nil else { return }

            reportWorkGeneration &+= 1
            let generation = reportWorkGeneration
            let item = DispatchWorkItem { [weak self] in
                MainActor.assumeIsolated {
                    guard let self, self.reportWorkGeneration == generation else { return }
                    self.reportWorkItem = nil
                    self.reportMetrics(at: ProcessInfo.processInfo.systemUptime)
                }
            }
            reportWorkItem = item
            DispatchQueue.main.asyncAfter(
                deadline: .now() + delay,
                execute: item
            )
        }

        private func cancelScheduledMetricsReport() {
            reportWorkGeneration &+= 1
            reportWorkItem?.cancel()
            reportWorkItem = nil
        }

        private func reportMetrics(at uptime: TimeInterval) {
            lastMetricsReportUptime = uptime
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
        let scenarios: [(String, () -> Bool)] = [
            ("stream-below-viewport", checkStreamingBelowViewport),
            ("height-change-above-viewport", checkHeightChangeAboveViewport),
            ("prepend-single-page", checkPrependSinglePage),
            ("active-momentum-priority", checkActiveMomentumPriority),
            ("discrete-scroll-isolation", checkDiscreteScrollIsolation),
            ("coalesced-live-updates", checkCoalescedLiveUpdates),
            ("chat-switch-isolation", checkChatSwitchIsolation),
            ("explicit-height-cache", checkExplicitHeightCache),
            ("variable-height-containment", checkVariableHeightContainment),
            ("selectable-message-content", checkSelectableMessageContent),
            ("native-wheel-ownership", checkNativeWheelOwnership),
        ]
        for (name, check) in scenarios {
            guard check() else { return false }
            print("AppKitTimelineHarness passed scenario=\(name)")
        }
        return true
    }

    private static func checkStreamingBelowViewport() -> Bool {
        let fixture = Fixture()
        defer { fixture.stop() }
        let initialVisibleCells = instantiatedCellCount(in: fixture.tableView)
        guard fixture.tableView.style == NSTableView.Style.plain,
              fixture.tableView.usesAutomaticRowHeights == false,
              fixture.scrollView.verticalScrollElasticity == NSScrollView.Elasticity.none,
              initialVisibleCells > 0,
              initialVisibleCells < 80,
              fixture.metrics.contentBuildCount > 0,
              fixture.metrics.contentBuildCount < 80 else {
            return fail(
                "stream-below-viewport",
                "lazy recycling/style invariant failed cells=\(initialVisibleCells) " +
                    "builds=\(fixture.metrics.contentBuildCount)"
            )
        }

        let retainedTailIndex = fixture.items.count - 1
        let appendWrites = fixture.coordinator.clipOriginWriteCount
        fixture.items[retainedTailIndex] = item(index: retainedTailIndex, version: 1)
        fixture.items.append(item(index: 320, version: 0))
        fixture.update()
        fixture.settle()
        guard fixture.coordinator.clipOriginWriteCount == appendWrites,
              let retainedTailCell = fixture.tableView.view(
                  atColumn: 0,
                  row: retainedTailIndex,
                  makeIfNecessary: false
              ) as? TimelineHostingCellView,
              retainedTailCell.renderedVersion == 1 else {
            return fail("stream-below-viewport", "append fast path missed the retained tail")
        }

        fixture.update(command: AppKitTimelineScrollCommand(
            revision: 2,
            destination: .row("row-160", .top)
        ))
        fixture.settle()
        let origin = fixture.scrollView.contentView.bounds.origin
        let writes = fixture.coordinator.clipOriginWriteCount
        fixture.items[fixture.items.count - 1] = item(
            index: 320,
            version: 2,
            paragraphCount: 18
        )
        fixture.update()
        fixture.settle()
        guard originsMatch(origin, fixture.scrollView.contentView.bounds.origin),
              fixture.coordinator.clipOriginWriteCount == writes else {
            return fail("stream-below-viewport", "offscreen streaming changed the origin")
        }
        return true
    }

    private static func checkExplicitHeightCache() -> Bool {
        let fixture = Fixture()
        defer { fixture.stop() }
        let initialMeasurements = fixture.coordinator.heightMeasurementCount
        let initialInvalidations = fixture.coordinator.heightInvalidationCount
        let initialBuilds = fixture.metrics.contentBuildCount

        NotificationCenter.default.post(
            name: NSScrollView.willStartLiveScrollNotification,
            object: fixture.scrollView
        )
        fixture.tableView.scrollRowToVisible(160)
        fixture.settle()
        guard fixture.coordinator.isLiveScrolling,
              fixture.coordinator.heightInvalidationCount == initialInvalidations else {
            return fail(
                "explicit-height-cache",
                "live scroll performed height invalidation " +
                    "before=\(initialInvalidations) after=\(fixture.coordinator.heightInvalidationCount)"
            )
        }

        NotificationCenter.default.post(
            name: NSScrollView.didEndLiveScrollNotification,
            object: fixture.scrollView
        )
        fixture.settle()
        let addedBuilds = fixture.metrics.contentBuildCount - initialBuilds
        guard !fixture.coordinator.isLiveScrolling,
              fixture.coordinator.heightMeasurementCount > initialMeasurements,
              fixture.coordinator.heightInvalidationCount > initialInvalidations,
              addedBuilds < 80 else {
            return fail(
                "explicit-height-cache",
                "settled measurements=\(fixture.coordinator.heightMeasurementCount - initialMeasurements) " +
                    "invalidations=\(fixture.coordinator.heightInvalidationCount - initialInvalidations) " +
                    "builds=\(addedBuilds)"
            )
        }
        return true
    }

    private static func checkSelectableMessageContent() -> Bool {
        let fixture = Fixture(items: [item(index: 0, version: 0)])
        defer { fixture.stop() }
        guard fixture.tableView.selectionHighlightStyle == .none else {
            return fail("selectable-message-content", "table selection must stay visually neutral")
        }
        let delegateAllowsSelection = fixture.tableView.delegate?.tableView?(
            fixture.tableView,
            shouldSelectRow: 0
        ) ?? true
        guard delegateAllowsSelection else {
            return fail("selectable-message-content", "table delegate swallowed the text-selection gesture")
        }
        guard let cell = fixture.tableView.view(
            atColumn: 0,
            row: 0,
            makeIfNecessary: true
        ) as? TimelineHostingCellView else {
            return fail("selectable-message-content", "selectable hosted row was not materialized")
        }
        cell.layoutSubtreeIfNeeded()
        let pointInTable = cell.convert(
            NSPoint(x: min(120, max(1, cell.bounds.midX)), y: max(1, cell.bounds.midY)),
            to: fixture.tableView
        )
        guard let hit = fixture.tableView.hitTest(pointInTable), hit !== fixture.tableView else {
            return fail("selectable-message-content", "hosted content did not receive pointer hit testing")
        }
        return true
    }

    private static func checkNativeWheelOwnership() -> Bool {
        let fixture = Fixture()
        defer { fixture.stop() }
        fixture.scrollView.contentView.scroll(to: NSPoint(x: 0, y: 4_000))
        fixture.scrollView.reflectScrolledClipView(fixture.scrollView.contentView)
        fixture.settle()
        let originBefore = fixture.scrollView.documentVisibleRect.minY
        let inputCountBefore = fixture.coordinator.wheelInputCount
        guard let event = CGEvent(
            scrollWheelEvent2Source: nil,
            units: .pixel,
            wheelCount: 1,
            wheel1: 120,
            wheel2: 0,
            wheel3: 0
        ).flatMap(NSEvent.init(cgEvent:)) else {
            return fail("native-wheel-ownership", "could not construct a wheel event")
        }
        fixture.scrollView.scrollWheel(with: event)
        fixture.settle()
        guard fixture.coordinator.wheelInputCount == inputCountBefore + 1,
              abs(fixture.scrollView.documentVisibleRect.minY - originBefore) > 0.5 else {
            return fail(
                "native-wheel-ownership",
                "wheel was not owned by the timeline origin=\(originBefore)" +
                    "->\(fixture.scrollView.documentVisibleRect.minY) " +
                    "inputs=\(fixture.coordinator.wheelInputCount - inputCountBefore)"
            )
        }
        return true
    }

    private static func checkHeightChangeAboveViewport() -> Bool {
        let fixture = Fixture()
        defer { fixture.stop() }
        fixture.items.insert(historyLoaderItem(), at: 0)
        fixture.update()
        fixture.settle()
        fixture.scrollView.contentView.scroll(to: NSPoint.zero)
        fixture.scrollView.reflectScrolledClipView(fixture.scrollView.contentView)
        fixture.settle()

        let anchorID = fixture.items[1].id
        guard let offsetBefore = visibleOffset(of: anchorID, in: fixture) else {
            return fail("height-change-above-viewport", "anchor was not found")
        }
        let writes = fixture.coordinator.clipOriginWriteCount
        fixture.items[0] = historyLoaderItem(version: 1, lineCount: 14)
        fixture.update()
        fixture.settle()
        let offsetAfter = visibleOffset(of: anchorID, in: fixture)
        guard let offsetAfter,
              abs(offsetAfter - offsetBefore) < 2,
              fixture.coordinator.clipOriginWriteCount == writes + 1 else {
            return fail(
                "height-change-above-viewport",
                "anchor before=\(offsetBefore) after=\(offsetAfter ?? -1) " +
                    "writes=\(fixture.coordinator.clipOriginWriteCount - writes)"
            )
        }
        return true
    }

    private static func checkPrependSinglePage() -> Bool {
        let fixture = Fixture()
        defer { fixture.stop() }
        let anchorID = "row-80"
        fixture.update(command: AppKitTimelineScrollCommand(
            revision: 2,
            destination: .row(anchorID, .top)
        ))
        fixture.settle()
        guard let offsetBefore = visibleOffset(of: anchorID, in: fixture) else {
            return fail("prepend-single-page", "anchor was not found")
        }
        let writes = fixture.coordinator.clipOriginWriteCount
        fixture.items.insert(
            contentsOf: (0..<24).map { item(index: -24 + $0, version: 0) },
            at: 0
        )
        fixture.update()
        fixture.settle()
        let offsetAfter = visibleOffset(of: anchorID, in: fixture)
        guard let offsetAfter,
              abs(offsetAfter - offsetBefore) < 2,
              fixture.coordinator.clipOriginWriteCount == writes + 1 else {
            return fail(
                "prepend-single-page",
                "anchor before=\(offsetBefore) after=\(offsetAfter ?? -1) " +
                    "writes=\(fixture.coordinator.clipOriginWriteCount - writes)"
            )
        }
        return true
    }

    private static func checkActiveMomentumPriority() -> Bool {
        let fixture = Fixture()
        defer { fixture.stop() }
        fixture.update(command: AppKitTimelineScrollCommand(
            revision: 2,
            destination: .row("row-160", .top)
        ))
        fixture.settle()
        NotificationCenter.default.post(
            name: NSScrollView.willStartLiveScrollNotification,
            object: fixture.scrollView
        )
        guard fixture.coordinator.isLiveScrolling else {
            return fail("active-momentum-priority", "live scroll did not start")
        }
        fixture.scrollView.contentView.scroll(to: NSPoint(
            x: fixture.scrollView.contentView.bounds.minX,
            y: fixture.scrollView.contentView.bounds.minY + 37
        ))
        fixture.scrollView.reflectScrolledClipView(fixture.scrollView.contentView)
        fixture.settle()
        let origin = fixture.scrollView.contentView.bounds.origin
        let writes = fixture.coordinator.clipOriginWriteCount
        let tailIndex = fixture.items.count - 1
        fixture.items[tailIndex] = item(index: tailIndex, version: 1, paragraphCount: 18)
        fixture.update(forcedBottomRevision: 1)
        fixture.settle()
        guard originsMatch(origin, fixture.scrollView.contentView.bounds.origin),
              fixture.coordinator.clipOriginWriteCount == writes else {
            return fail("active-momentum-priority", "forced bottom displaced live scrolling")
        }

        NotificationCenter.default.post(
            name: NSScrollView.didEndLiveScrollNotification,
            object: fixture.scrollView
        )
        fixture.settle()
        guard !fixture.coordinator.isLiveScrolling,
              originsMatch(origin, fixture.scrollView.contentView.bounds.origin),
              fixture.coordinator.clipOriginWriteCount == writes else {
            return fail("active-momentum-priority", "suppressed positioning replayed after momentum")
        }
        return true
    }

    private static func checkCoalescedLiveUpdates() -> Bool {
        let fixture = Fixture()
        defer { fixture.stop() }
        fixture.update(command: AppKitTimelineScrollCommand(
            revision: 2,
            destination: .row("row-160", .top)
        ))
        fixture.settle()

        NotificationCenter.default.post(
            name: NSScrollView.willStartLiveScrollNotification,
            object: fixture.scrollView
        )
        guard fixture.coordinator.isLiveScrolling else {
            return fail("coalesced-live-updates", "live scroll did not start")
        }

        let rowCount = fixture.tableView.numberOfRows
        let structuralUpdates = fixture.coordinator.structuralUpdateCount
        let writes = fixture.coordinator.clipOriginWriteCount
        let origin = fixture.scrollView.contentView.bounds.origin
        fixture.items[160] = item(index: 160, version: 1, paragraphCount: 18)
        fixture.items.append(item(index: 320, version: 0))
        fixture.update()
        fixture.settle()

        guard fixture.tableView.numberOfRows == rowCount,
              fixture.coordinator.structuralUpdateCount == structuralUpdates,
              fixture.coordinator.clipOriginWriteCount == writes,
              originsMatch(origin, fixture.scrollView.contentView.bounds.origin) else {
            return fail("coalesced-live-updates", "snapshot mutated during live scroll")
        }

        NotificationCenter.default.post(
            name: NSScrollView.didEndLiveScrollNotification,
            object: fixture.scrollView
        )
        fixture.settle()
        let settledOrigin = fixture.scrollView.contentView.bounds.origin
        let writeDelta = fixture.coordinator.clipOriginWriteCount - writes
        let retainedVersion = (fixture.tableView.view(
            atColumn: 0,
            row: 160,
            makeIfNecessary: false
        ) as? TimelineHostingCellView)?.renderedVersion
        guard fixture.tableView.numberOfRows == fixture.items.count,
              fixture.coordinator.structuralUpdateCount == structuralUpdates + 1,
              (0...1).contains(writeDelta),
              originsMatch(origin, settledOrigin),
              retainedVersion == 1 else {
            return fail(
                "coalesced-live-updates",
                "rows=\(fixture.tableView.numberOfRows)/\(fixture.items.count) " +
                    "structural=\(fixture.coordinator.structuralUpdateCount - structuralUpdates) " +
                    "writes=\(writeDelta) origin=\(origin.y)->\(settledOrigin.y) " +
                    "version=\(retainedVersion.map(String.init) ?? "nil")"
            )
        }
        return true
    }

    private static func checkDiscreteScrollIsolation() -> Bool {
        let fixture = Fixture()
        defer { fixture.stop() }
        let viewportHeight = fixture.scrollView.contentView.bounds.height
        let bottomY = max(0, fixture.tableView.bounds.maxY - viewportHeight)
        let targetY = max(0, bottomY - 420)
        fixture.scrollView.contentView.scroll(to: NSPoint(x: 0, y: targetY))
        fixture.scrollView.reflectScrolledClipView(fixture.scrollView.contentView)

        let visibleRows = fixture.tableView.rows(in: fixture.tableView.visibleRect)
        guard visibleRows.location != NSNotFound,
              fixture.items.indices.contains(visibleRows.location) else {
            return fail("discrete-scroll-isolation", "no visible row after wheel movement")
        }
        let changedRow = visibleRows.location
        let invalidations = fixture.coordinator.heightInvalidationCount
        fixture.items[changedRow] = item(index: changedRow, version: 1, paragraphCount: 18)
        fixture.update()
        RunLoop.main.run(until: Date().addingTimeInterval(0.06))
        guard fixture.coordinator.heightInvalidationCount == invalidations else {
            return fail("discrete-scroll-isolation", "height changed during wheel activity")
        }

        fixture.settle()
        let settledDistanceFromBottom = max(
            0,
            fixture.tableView.bounds.maxY - fixture.scrollView.documentVisibleRect.maxY
        )
        guard settledDistanceFromBottom > 100 else {
            return fail(
                "discrete-scroll-isolation",
                "height correction snapped back to bottom distance=\(settledDistanceFromBottom)"
            )
        }
        return true
    }

    private static func checkChatSwitchIsolation() -> Bool {
        let fixture = Fixture()
        defer { fixture.stop() }
        fixture.update(command: AppKitTimelineScrollCommand(
            revision: 2,
            destination: .row("row-160", .top)
        ))
        fixture.settle()
        let writes = fixture.coordinator.clipOriginWriteCount
        fixture.items = (1_000..<1_096).map { item(index: $0, version: 0) }
        fixture.update(sessionID: "harness-b")
        fixture.settle()
        let distanceFromBottom = max(
            0,
            fixture.tableView.bounds.height - fixture.scrollView.documentVisibleRect.maxY
        )
        let writeDelta = fixture.coordinator.clipOriginWriteCount - writes
        guard fixture.tableView.numberOfRows == fixture.items.count,
              fixture.coordinator.fullReloadCount == 2,
              (0...1).contains(writeDelta),
              distanceFromBottom < 4 else {
            return fail(
                "chat-switch-isolation",
                "reloads=\(fixture.coordinator.fullReloadCount) " +
                    "writes=\(writeDelta) " +
                    "bottom=\(distanceFromBottom)"
            )
        }
        return true
    }

    private static func checkVariableHeightContainment() -> Bool {
        let wrappingItems = (0..<64).map { wrappingItem(index: $0) }
        let fixture = Fixture(width: 360, items: wrappingItems)
        defer { fixture.stop() }

        fixture.settle()
        if let failure = containmentFailure(in: fixture, phase: "initial-narrow") {
            return fail("variable-height-containment", failure)
        }

        fixture.update(command: AppKitTimelineScrollCommand(
            revision: 2,
            destination: .row("wrapping-row-48", .top)
        ))
        fixture.settle()
        if let failure = containmentFailure(in: fixture, phase: "reused-narrow") {
            return fail("variable-height-containment", failure)
        }

        fixture.resize(width: 760)
        fixture.settle()
        if let failure = containmentFailure(in: fixture, phase: "wide") {
            return fail("variable-height-containment", failure)
        }

        fixture.resize(width: 320)
        fixture.update(command: AppKitTimelineScrollCommand(
            revision: 3,
            destination: .row("wrapping-row-8", .top)
        ))
        fixture.settle()
        if let failure = containmentFailure(in: fixture, phase: "renarrowed") {
            return fail("variable-height-containment", failure)
        }
        return true
    }

    @MainActor
    private final class Fixture {
        final class Metrics {
            var latest: TimelineScrollMetrics?
            var contentBuildCount = 0
        }

        let metrics: Metrics
        let coordinator: AppKitTimelineTable.Coordinator
        let scrollView: NSScrollView
        let tableView: NSTableView
        let window: NSWindow
        var items: [AppKitTimelineItem]
        private var sessionID = "harness"
        private var command = AppKitTimelineScrollCommand(revision: 1, destination: .bottom)
        private var forcedBottomRevision = 0

        init(
            width: CGFloat = 920,
            items initialItems: [AppKitTimelineItem]? = nil
        ) {
            let metrics = Metrics()
            self.metrics = metrics
            coordinator = AppKitTimelineTable.Coordinator { value in
                metrics.latest = value
            }
            scrollView = coordinator.makeScrollView()
            tableView = scrollView.documentView as! NSTableView
            window = NSWindow(
                contentRect: NSRect(x: 0, y: 0, width: width, height: 720),
                styleMask: .borderless,
                backing: .buffered,
                defer: false
            )
            if let initialItems {
                items = initialItems
            } else {
                items = (0..<320).map { index in
                    item(index: index, version: 0) {
                        metrics.contentBuildCount += 1
                    }
                }
            }
            window.contentView = scrollView
            window.orderOut(nil)
            coordinator.update(
                sessionID: sessionID,
                items: items,
                scrollCommand: command,
                forcedBottomRevision: forcedBottomRevision
            )
            settle()
        }

        func update(
            sessionID nextSessionID: String? = nil,
            command nextCommand: AppKitTimelineScrollCommand? = nil,
            forcedBottomRevision nextForcedBottomRevision: Int? = nil
        ) {
            if let nextSessionID {
                sessionID = nextSessionID
            }
            if let nextCommand {
                command = nextCommand
            }
            if let nextForcedBottomRevision {
                forcedBottomRevision = nextForcedBottomRevision
            }
            coordinator.update(
                sessionID: sessionID,
                items: items,
                scrollCommand: command,
                forcedBottomRevision: forcedBottomRevision
            )
        }

        func settle() {
            settleLayout(window: window)
        }

        func resize(width: CGFloat) {
            window.setContentSize(NSSize(width: width, height: window.contentLayoutRect.height))
        }

        func stop() {
            coordinator.stopObserving()
            window.contentView = nil
        }
    }

    private static func item(
        index: Int,
        version: Int,
        paragraphCount: Int? = nil,
        onBuild: @escaping () -> Void = {}
    ) -> AppKitTimelineItem {
        AppKitTimelineItem(
            id: "row-\(index)",
            version: version,
            eventIDs: ["event-\(index)"],
            content: itemContent(
                index: index,
                paragraphCount: paragraphCount ?? (1 + abs(index % 7)),
                onBuild: onBuild
            )
        )
    }

    private static func itemContent(
        index: Int,
        paragraphCount: Int,
        onBuild: () -> Void
    ) -> AnyView {
        onBuild()
        let text = Array(repeating: "Row \(index) keeps a stable identity while its variable-height content is recycled.", count: paragraphCount)
            .joined(separator: "\n")
        return AnyView(
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
    }

    private static func historyLoaderItem(version: Int = 0, lineCount: Int = 1) -> AppKitTimelineItem {
        AppKitTimelineItem(
            id: "history-loader",
            version: version,
            content: historyLoaderContent(lineCount: lineCount)
        )
    }

    private static func historyLoaderContent(lineCount: Int) -> AnyView {
        let text = Array(repeating: "Showing latest messages - load older", count: lineCount)
            .joined(separator: "\n")
        return AnyView(
            Text(text)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(12)
        )
    }

    private static func wrappingItem(index: Int) -> AppKitTimelineItem {
        let sentence = "Width constrained timeline content wraps naturally across many visual lines without explicit line breaks."
        let text = Array(repeating: sentence, count: 28 + index % 5).joined(separator: " ")
        return AppKitTimelineItem(
            id: "wrapping-row-\(index)",
            version: 0,
            eventIDs: ["wrapping-event-\(index)"],
            content: AnyView(
                VStack(alignment: .leading, spacing: 8) {
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
        )
    }

    private static func containmentFailure(in fixture: Fixture, phase: String) -> String? {
        fixture.tableView.layoutSubtreeIfNeeded()
        let columnWidth = fixture.tableView.tableColumns.first?.width ?? fixture.tableView.bounds.width
        var instantiatedCount = 0
        var maximumMeasuredHeight: CGFloat = 0
        var previousRect: NSRect?

        for row in 0..<fixture.tableView.numberOfRows {
            let rowRect = fixture.tableView.rect(ofRow: row)
            if let previousRect, previousRect.maxY > rowRect.minY + 0.5 {
                return "phase=\(phase) rows=\(row - 1),\(row) overlap=\(previousRect.maxY - rowRect.minY)"
            }
            previousRect = rowRect

            guard let cell = fixture.tableView.view(
                atColumn: 0,
                row: row,
                makeIfNecessary: false
            ) as? TimelineHostingCellView else { continue }
            instantiatedCount += 1
            let measuredHeight = cell.exactMeasuredContentHeight
            maximumMeasuredHeight = max(maximumMeasuredHeight, measuredHeight)
            if rowRect.intersects(fixture.tableView.visibleRect),
               abs(cell.renderedWidth - columnWidth) > 0.5 {
                return "phase=\(phase) row=\(row) width=\(cell.renderedWidth) column=\(columnWidth)"
            }
            if rowRect.height < measuredHeight - 1 {
                return "phase=\(phase) row=\(row) rect=\(rowRect.height) measured=\(measuredHeight)"
            }
        }

        guard instantiatedCount > 0, maximumMeasuredHeight > 240 else {
            return "phase=\(phase) cells=\(instantiatedCount) tallest=\(maximumMeasuredHeight)"
        }
        return nil
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

    private static func visibleOffset(
        of itemID: String,
        in fixture: Fixture
    ) -> CGFloat? {
        guard let row = fixture.items.firstIndex(where: { $0.id == itemID }) else { return nil }
        return fixture.tableView.rect(ofRow: row).minY - fixture.scrollView.documentVisibleRect.minY
    }

    private static func originsMatch(_ lhs: NSPoint, _ rhs: NSPoint) -> Bool {
        abs(lhs.x - rhs.x) < 0.5 && abs(lhs.y - rhs.y) < 0.5
    }

    private static func fail(_ scenario: String, _ message: String) -> Bool {
        fputs("AppKitTimelineHarness failed scenario=\(scenario) \(message)\n", stderr)
        return false
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

        guard let timelineScrollView = findTimelineScrollView(in: hostingView),
              let timelineTableView = timelineScrollView.documentView as? NSTableView else {
            AppLogger.error("AppKit integration harness could not locate native timeline")
            exit(EXIT_FAILURE)
        }

        if store.canLoadOlderHistory {
            try? await Task.sleep(for: .milliseconds(550))
            for page in 1...2 {
                let beforeRows = timelineTableView.numberOfRows
                let beforeEvents = store.displayEvents.count
                let beforeHidden = store.hiddenDisplayEventCount
                timelineScrollView.contentView.scroll(to: .zero)
                timelineScrollView.reflectScrolledClipView(timelineScrollView.contentView)

                let pageDeadline = Date().addingTimeInterval(6)
                while Date() < pageDeadline,
                      timelineTableView.numberOfRows <= beforeRows,
                      store.displayEvents.count <= beforeEvents,
                      store.hiddenDisplayEventCount >= beforeHidden {
                    try? await Task.sleep(for: .milliseconds(80))
                }
                let advanced = timelineTableView.numberOfRows > beforeRows ||
                    store.displayEvents.count > beforeEvents ||
                    store.hiddenDisplayEventCount < beforeHidden
                guard advanced else {
                    AppLogger.error(
                        "AppKit integration older page stalled page=\(page) " +
                        "rows=\(beforeRows) events=\(beforeEvents) hidden=\(beforeHidden)"
                    )
                    exit(EXIT_FAILURE)
                }
                try? await Task.sleep(for: .milliseconds(250))
            }
        }

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

    private static func findTimelineScrollView(in view: NSView) -> NSScrollView? {
        if let scrollView = view as? NSScrollView,
           scrollView.identifier?.rawValue == "AgentsDockTimelineScrollView" {
            return scrollView
        }
        for subview in view.subviews {
            if let match = findTimelineScrollView(in: subview) {
                return match
            }
        }
        return nil
    }
}

private final class TimelineHostingCellView: NSTableCellView {
    private let hostingView = NSHostingView(rootView: AnyView(EmptyView()))
    private var renderedContent: AnyView?
    private var renderedItemID: String?
    private(set) var renderedVersion: Int?
    private(set) var renderedWidth: CGFloat = 0
    private var heightReportingEnabled = true
    private var heightMeasurementWorkItem: DispatchWorkItem?
    private var onHeightMeasured: ((String, Int, CGFloat, CGFloat) -> Void)?
    private var lastReportedItemID: String?
    private var lastReportedVersion: Int?
    private var lastReportedWidth: CGFloat?
    private var lastReportedHeight: CGFloat?

    var exactMeasuredContentHeight: CGFloat {
        let intrinsicHeight = hostingView.intrinsicContentSize.height
        return intrinsicHeight > 0 ? intrinsicHeight : hostingView.fittingSize.height
    }

    override func layout() {
        super.layout()
        requestHeightMeasurement()
    }

    init(identifier: NSUserInterfaceItemIdentifier) {
        super.init(frame: .zero)
        self.identifier = identifier
        clipsToBounds = true
        hostingView.clipsToBounds = true
        hostingView.translatesAutoresizingMaskIntoConstraints = false
        hostingView.setContentHuggingPriority(.defaultLow, for: .horizontal)
        hostingView.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        addSubview(hostingView)
        NSLayoutConstraint.activate([
            hostingView.leadingAnchor.constraint(equalTo: leadingAnchor),
            hostingView.trailingAnchor.constraint(equalTo: trailingAnchor),
            hostingView.topAnchor.constraint(equalTo: topAnchor)
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func configure(
        with item: AppKitTimelineItem,
        forWidth width: CGFloat,
        heightReportingEnabled: Bool,
        onHeightMeasured: @escaping (String, Int, CGFloat, CGFloat) -> Void
    ) {
        self.onHeightMeasured = onHeightMeasured
        self.heightReportingEnabled = heightReportingEnabled
        let contentChanged = renderedItemID != item.id || renderedVersion != item.version
        if contentChanged {
            renderedItemID = item.id
            renderedVersion = item.version
            renderedContent = item.makeContent()
        }

        let width = max(1, width)
        let widthChanged = abs(renderedWidth - width) > 0.5
        guard contentChanged || widthChanged, let renderedContent else {
            requestHeightMeasurement()
            return
        }
        renderedWidth = width
        lastReportedItemID = nil
        lastReportedVersion = nil
        lastReportedWidth = nil
        lastReportedHeight = nil
        hostingView.rootView = AnyView(
            renderedContent
                // Each recycled row is an independent SwiftUI hosting root, so
                // text selection must be installed here. Child-level modifiers
                // alone are not sufficient when NSTableView owns the gesture.
                .textSelection(.enabled)
                .frame(width: width, alignment: .topLeading)
        )
        hostingView.invalidateIntrinsicContentSize()
        requestHeightMeasurement()
    }

    func setHeightReportingEnabled(_ enabled: Bool) {
        heightReportingEnabled = enabled
        if enabled {
            requestHeightMeasurement()
        } else {
            heightMeasurementWorkItem?.cancel()
            heightMeasurementWorkItem = nil
        }
    }

    private func requestHeightMeasurement() {
        guard heightReportingEnabled,
              heightMeasurementWorkItem == nil,
              renderedItemID != nil,
              renderedVersion != nil,
              renderedWidth > 0 else { return }
        let workItem = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated {
                self?.measureAndReportHeight()
            }
        }
        heightMeasurementWorkItem = workItem
        DispatchQueue.main.async(execute: workItem)
    }

    private func measureAndReportHeight() {
        heightMeasurementWorkItem = nil
        guard heightReportingEnabled,
              let itemID = renderedItemID,
              let version = renderedVersion,
              renderedWidth > 0 else { return }
        hostingView.layoutSubtreeIfNeeded()
        let measuredHeight = ceil(max(1, exactMeasuredContentHeight))
        guard measuredHeight.isFinite else { return }
        if lastReportedItemID == itemID,
           lastReportedVersion == version,
           let lastReportedWidth,
           let lastReportedHeight,
           abs(lastReportedWidth - renderedWidth) <= 0.5,
           abs(lastReportedHeight - measuredHeight) <= 0.5 {
            return
        }
        lastReportedItemID = itemID
        lastReportedVersion = version
        lastReportedWidth = renderedWidth
        lastReportedHeight = measuredHeight
        onHeightMeasured?(itemID, version, renderedWidth, measuredHeight)
    }
}
#endif
