import SwiftUI
import AppKit

// AppKit NSTableView-backed timeline — the production "snappy AND stable" tier.
// Behind the ZD_TimelineUseTable flag. Reuses the existing SwiftUI row views
// (timelineCard) inside reused NSHostingViews, with a per-row HEIGHT CACHE so
// heights are known before scroll/switch (no measure-on-scroll, no measure-on-
// reload). This is what makes Ctrl+Tab switching and fast scrolling snappy while
// being structurally immune to the LazyVStack layout spiral.
//
// STEP 1 (this file): render rows, cached heights, stick-to-bottom + an explicit
// scroll-to-bottom tick. Jump-button/paging/scroll-to-event are layered in later
// increments; the goal of step 1 is the gate — snappy switch + no spiral.
struct TimelineTableView: NSViewRepresentable {
    let rows: [TimelineRow]
    // Stable content signature per row — height cache key. Changes when the row's
    // rendered content changes (so a growing streaming row re-measures, others don't).
    let signature: (TimelineRow) -> String
    // Builds the SwiftUI view for a row (captures store/context in the caller).
    let makeRow: (TimelineRow) -> AnyView
    let fontSize: Double
    let scrollToBottomTick: Int
    let forceBottomTick: Int
    // Older-history auto-loading: true if the server has more before the first
    // loaded event; called (throttled) when the user scrolls near the top.
    let hasOlder: Bool
    let onNeedOlder: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator() }

    static func dismantleNSView(_ nsView: NSScrollView, coordinator: Coordinator) {
        if let obs = coordinator.boundsObserver {
            NotificationCenter.default.removeObserver(obs)
        }
        coordinator.boundsObserver = nil
    }

    func makeNSView(context: Context) -> NSScrollView {
        let table = NSTableView()
        table.headerView = nil
        table.backgroundColor = .clear
        table.style = .plain
        table.selectionHighlightStyle = .none
        table.gridStyleMask = []
        table.intercellSpacing = NSSize(width: 0, height: 14)
        table.usesAutomaticRowHeights = false
        table.rowSizeStyle = .custom
        table.allowsColumnReordering = false
        table.allowsColumnResizing = false
        let col = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("timeline"))
        col.resizingMask = .autoresizingMask
        table.addTableColumn(col)
        table.dataSource = context.coordinator
        table.delegate = context.coordinator

        let scroll = NSScrollView()
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.hasHorizontalScroller = false
        scroll.autohidesScrollers = true
        scroll.verticalScrollElasticity = .allowed
        scroll.documentView = table

        context.coordinator.table = table
        context.coordinator.scroll = scroll
        context.coordinator.parent = self
        // Observe scrolling so we can auto-fetch older history near the top.
        scroll.contentView.postsBoundsChangedNotifications = true
        context.coordinator.boundsObserver = NotificationCenter.default.addObserver(
            forName: NSView.boundsDidChangeNotification,
            object: scroll.contentView,
            queue: .main
        ) { [weak coord = context.coordinator] _ in
            MainActor.assumeIsolated { coord?.didScroll() }
        }
        context.coordinator.apply(rows: rows, animated: false)
        return scroll
    }

    func updateNSView(_ nsView: NSScrollView, context: Context) {
        let coord = context.coordinator
        coord.parent = self
        // Width change invalidates cached heights (text re-wraps).
        let width = nsView.contentView.bounds.width
        if abs(width - coord.lastWidth) > 1 {
            coord.lastWidth = width
            coord.heightCache.removeAll()
        }
        coord.apply(rows: rows, animated: false)
        if coord.lastScrollToBottomTick != scrollToBottomTick || coord.lastForceBottomTick != forceBottomTick {
            coord.lastScrollToBottomTick = scrollToBottomTick
            coord.lastForceBottomTick = forceBottomTick
            coord.scrollToBottom()
        }
    }

    @MainActor
    final class Coordinator: NSObject, NSTableViewDataSource, NSTableViewDelegate {
        var parent: TimelineTableView?
        weak var table: NSTableView?
        weak var scroll: NSScrollView?
        var rows: [TimelineRow] = []
        var heightCache: [String: CGFloat] = [:]
        var lastWidth: CGFloat = 0
        var lastScrollToBottomTick = Int.min
        var lastForceBottomTick = Int.min
        var boundsObserver: NSObjectProtocol?
        private var lastOlderRequest = Date.distantPast
        // Arm/disarm so older-history loads ONCE per approach to the top, not
        // continuously (a naive "near top" check fired ~10x in a row, sliding the
        // window backward and dropping recent messages). Re-arms only after the
        // user scrolls well away from the top.
        private var armedForOlder = true
        // Reused off-screen hosting view for height measurement (keeps SwiftUI /
        // AttributedString caches warm; never added to the view tree).
        private let sizer = NSHostingView(rootView: AnyView(EmptyView()))

        func apply(rows newRows: [TimelineRow], animated: Bool) {
            guard let table, let scroll else { rows = newRows; return }
            let wasAtBottom = isAtBottom()
            let oldIDs = rows.map(\.id)
            let newIDs = newRows.map(\.id)

            // Detect a PREPEND (older history loaded at the front): the old id list
            // is a suffix of the new one. Preserve the viewport by adding the
            // prepended content height to the scroll offset, so the row the user
            // was looking at stays put instead of jumping.
            var prependedHeight: CGFloat = 0
            if !oldIDs.isEmpty && newIDs.count > oldIDs.count && Array(newIDs.suffix(oldIDs.count)) == oldIDs {
                let prependedCount = newIDs.count - oldIDs.count
                for i in 0..<prependedCount {
                    prependedHeight += tableView(table, heightOfRow: i, in: newRows) + table.intercellSpacing.height
                }
            }

            rows = newRows
            table.reloadData()

            if prependedHeight > 0 {
                let cv = scroll.contentView
                var origin = cv.bounds.origin
                origin.y += prependedHeight
                cv.scroll(to: origin)
                scroll.reflectScrolledClipView(cv)
            } else if wasAtBottom {
                DispatchQueue.main.async { [weak self] in self?.scrollToBottom() }
            }
        }

        // Height for a row in an explicit array (used during prepend measurement
        // before `rows` is swapped).
        private func tableView(_ tableView: NSTableView, heightOfRow row: Int, in arr: [TimelineRow]) -> CGFloat {
            guard row >= 0, row < arr.count else { return 1 }
            let r = arr[row]
            let key = parent?.signature(r) ?? r.id
            if let h = heightCache[key] { return h }
            let h = measureHeight(r)
            heightCache[key] = h
            return h
        }

        func didScroll() {
            guard let scroll else { return }
            let y = scroll.contentView.bounds.origin.y
            // Re-arm once the user has scrolled well away from the top.
            if y > 1400 { armedForOlder = true }
            guard let parent, parent.hasOlder, armedForOlder, y < 400 else { return }
            // Fire exactly once per approach to the top.
            armedForOlder = false
            let now = Date()
            guard now.timeIntervalSince(lastOlderRequest) > 0.5 else { return }
            lastOlderRequest = now
            parent.onNeedOlder()
        }

        // MARK: NSTableViewDataSource
        func numberOfRows(in tableView: NSTableView) -> Int { rows.count }

        // MARK: NSTableViewDelegate
        func tableView(_ tableView: NSTableView, heightOfRow row: Int) -> CGFloat {
            guard row >= 0, row < rows.count else { return 1 }
            let r = rows[row]
            let key = parent?.signature(r) ?? r.id
            if let h = heightCache[key] { return h }
            let h = measureHeight(r)
            heightCache[key] = h
            return h
        }

        func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
            guard row >= 0, row < rows.count, let parent else { return nil }
            let r = rows[row]
            let id = NSUserInterfaceItemIdentifier(kindIdentifier(r))
            let cell: HostingRowCell
            if let reused = tableView.makeView(withIdentifier: id, owner: self) as? HostingRowCell {
                cell = reused
            } else {
                cell = HostingRowCell()
                cell.identifier = id
            }
            cell.host.rootView = parent.makeRow(r)
            return cell
        }

        private func measureHeight(_ r: TimelineRow) -> CGFloat {
            guard let parent else { return 1 }
            let width = lastWidth > 1 ? lastWidth : (scroll?.contentView.bounds.width ?? 700)
            // Constrain the row to the column width so fittingSize returns the
            // wrapped height (text height depends on width). Reuses warm
            // AttributedString caches, so this is cheap.
            sizer.rootView = AnyView(parent.makeRow(r).frame(width: width))
            return max(1, sizer.fittingSize.height)
        }

        private func kindIdentifier(_ r: TimelineRow) -> String {
            switch r.kind {
            case .event: return "event"
            case .artifacts: return "artifacts"
            case .job: return "job"
            case .jobGroup: return "jobGroup"
            case .trace: return "trace"
            }
        }

        func isAtBottom() -> Bool {
            guard let scroll, let doc = scroll.documentView else { return true }
            let visibleMaxY = scroll.contentView.bounds.maxY
            return doc.bounds.height - visibleMaxY <= 28
        }

        func scrollToBottom() {
            guard let table, rows.count > 0 else { return }
            table.scrollRowToVisible(rows.count - 1)
        }
    }
}

// Reused table cell: one persistent NSHostingView (swapping rootView on reuse,
// never re-adding subviews — the documented perf-correct pattern).
final class HostingRowCell: NSTableCellView {
    let host = NSHostingView(rootView: AnyView(EmptyView()))

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        host.translatesAutoresizingMaskIntoConstraints = false
        addSubview(host)
        NSLayoutConstraint.activate([
            host.leadingAnchor.constraint(equalTo: leadingAnchor),
            host.trailingAnchor.constraint(equalTo: trailingAnchor),
            host.topAnchor.constraint(equalTo: topAnchor),
            host.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }
}
