import SwiftUI
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
    @State private var olderHistoryLoadArmed = true
    @State private var suppressScrollHistoryLoadUntilTopLeaves = false
    @State private var visibleRowLimit = 90
    private let bottomID = "mobile-timeline-bottom"
    private let rowPageSize = 70

    var body: some View {
        let displayEvents = store.displayEvents
        let allRows = MobileTimelineRows.build(from: displayEvents)
        let hiddenRenderedRowCount = max(0, allRows.count - visibleRowLimit)
        let rows = Array(allRows.suffix(visibleRowLimit))

        VStack(spacing: 0) {
            MobileChatHeader(
                resumeOpen: $resumeOpen,
                optionsOpen: $optionsOpen
            )
            Divider()
            ScrollViewReader { proxy in
                ZStack(alignment: .bottomTrailing) {
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 14) {
                            if store.isLoading {
                                ProgressView()
                                    .frame(maxWidth: .infinity)
                                    .padding(.top, 40)
                            }
                            if store.hiddenDisplayEventCount > 0 || hiddenRenderedRowCount > 0 {
                                MobileTimelineHistoryLoader(hiddenRenderedRowCount: hiddenRenderedRowCount) {
                                    revealOlderRows()
                                } onLoadOlder: {
                                    loadOlderHistoryFromIntent()
                                }
                                    .background(MobileHistoryTopReader())
                                    .onAppear {
                                        if !isAtBottom {
                                            handleHistoryTopChange(0)
                                        }
                                    }
                                    .onDisappear {
                                        olderHistoryLoadArmed = true
                                        suppressScrollHistoryLoadUntilTopLeaves = false
                                    }
                            }
                            ForEach(rows) { row in
                                switch row {
                                case .event(let event):
                                    MobileEventCard(event: event)
                                        .id(row.id)
                                case .trace(_, let events):
                                    MobileTraceCard(events: events)
                                        .id(row.id)
                                }
                            }
                            Color.clear
                                .frame(height: 1)
                                .id(bottomID)
                                .onAppear { isAtBottom = true }
                                .onDisappear { isAtBottom = false }
                        }
                        .padding(.horizontal, 16)
                        .padding(.vertical, 14)
                    }
                    .coordinateSpace(name: "mobileTimelineScroll")
                    .refreshable {
                        await loadOlderHistoryFromPull()
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
                    if !isAtBottom && !displayEvents.isEmpty {
                        Button {
                            scrollToBottom(proxy)
                        } label: {
                            Image(systemName: "arrow.down.to.line.compact")
                                .font(.headline)
                        }
                        .buttonStyle(.borderedProminent)
                        .clipShape(Circle())
                        .padding(16)
                    }
                }
                .onChange(of: store.scrollRevision) {
                    if isAtBottom {
                        scrollToBottom(proxy)
                    }
                }
                .onChange(of: store.selectedSessionID) {
                    isAtBottom = true
                    olderHistoryLoadArmed = true
                    suppressScrollHistoryLoadUntilTopLeaves = false
                    visibleRowLimit = 90
                    scrollToBottom(proxy)
                }
                .onChange(of: displayEvents.count) {
                    if displayEvents.isEmpty {
                        visibleRowLimit = 90
                    } else if isAtBottom {
                        visibleRowLimit = min(max(visibleRowLimit, 90), max(MobileTimelineRows.build(from: displayEvents).count, 90))
                    }
                }
                .onChange(of: store.hiddenDisplayEventCount) {
                    if store.hiddenDisplayEventCount <= 0 {
                        olderHistoryLoadArmed = false
                        suppressScrollHistoryLoadUntilTopLeaves = false
                    }
                }
                .onPreferenceChange(MobileHistoryTopPreferenceKey.self) { topY in
                    handleHistoryTopChange(topY)
                }
            }
        }
        .safeAreaInset(edge: .bottom) {
            MobileComposerView(importerOpen: $importerOpen)
        }
        .sheet(isPresented: $optionsOpen) {
            MobileChatOptionsView(isPresented: $optionsOpen, resumeOpen: $resumeOpen)
                .environmentObject(store)
        }
    }

    private func scrollToBottom(_ proxy: ScrollViewProxy) {
        withAnimation(.snappy) {
            proxy.scrollTo(bottomID, anchor: .bottom)
            isAtBottom = true
        }
    }

    private func handleHistoryTopChange(_ topY: CGFloat?) {
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
              !suppressScrollHistoryLoadUntilTopLeaves else {
            return
        }
        if revealOlderRows() {
            olderHistoryLoadArmed = false
            suppressScrollHistoryLoadUntilTopLeaves = true
            return
        }
        guard store.canLoadOlderHistory else { return }
        olderHistoryLoadArmed = false
        suppressScrollHistoryLoadUntilTopLeaves = true
        Task { await store.loadOlderHistory() }
    }

    private func loadOlderHistoryFromIntent() {
        if revealOlderRows() {
            olderHistoryLoadArmed = false
            suppressScrollHistoryLoadUntilTopLeaves = true
            return
        }
        guard store.canLoadOlderHistory else { return }
        olderHistoryLoadArmed = false
        suppressScrollHistoryLoadUntilTopLeaves = true
        Task { await store.loadOlderHistory() }
    }

    private func loadOlderHistoryFromPull() async {
        if revealOlderRows() {
            olderHistoryLoadArmed = false
            suppressScrollHistoryLoadUntilTopLeaves = true
            return
        }
        if store.canLoadOlderHistory {
            olderHistoryLoadArmed = false
            suppressScrollHistoryLoadUntilTopLeaves = true
            await store.loadOlderHistory()
            return
        }
        await store.refreshTimelineFromPull()
    }

    @discardableResult
    private func revealOlderRows() -> Bool {
        let rowCount = MobileTimelineRows.build(from: store.displayEvents).count
        guard visibleRowLimit < rowCount else { return false }
        visibleRowLimit = min(rowCount, visibleRowLimit + rowPageSize)
        return true
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

    var body: some View {
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
            if store.isRunning {
                HStack(spacing: 6) {
                    ProgressView()
                        .controlSize(.small)
                    Text("\((store.selectedSession?.backend ?? "agent").capitalized)")
                        .font(.caption.weight(.semibold))
                    Button {
                        Task { await store.stop() }
                    } label: {
                        Image(systemName: "stop.circle")
                    }
                    .buttonStyle(.borderless)
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 5)
                .background(.quaternary)
                .clipShape(RoundedRectangle(cornerRadius: 8))
            }
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
                Picker("Backend", selection: Binding(
                    get: { store.selectedSession?.backend ?? "claude" },
                    set: { newValue in Task { await store.updateSelected(backend: newValue) } }
                )) {
                    Text("Claude").tag("claude")
                    Text("Codex").tag("codex")
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
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(.bar)
    }

    private var subtitle: String {
        guard let session = store.selectedSession else { return store.status }
        if let provider = compactProviderID(session.session_id) {
            return "\(session.backend) session \(provider)"
        }
        return "\(session.backend) · \(session.folder ?? "General")"
    }
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

private struct MobileHistoryTopPreferenceKey: PreferenceKey {
    static let defaultValue: CGFloat? = nil

    static func reduce(value: inout CGFloat?, nextValue: () -> CGFloat?) {
        value = nextValue() ?? value
    }
}

private enum MobileTimelineRow: Identifiable {
    case event(ZEvent)
    case trace(String, [ZEvent])

    var id: String {
        switch self {
        case .event(let event): return "event-\(event.id)"
        case .trace(let id, _): return id
        }
    }
}

private enum MobileTimelineRows {
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
        "job_ran",
        "job_error",
        "artifact_error",
        "session_created"
    ]

    static func build(from events: [ZEvent]) -> [MobileTimelineRow] {
        var rows: [MobileTimelineRow] = []
        var trace: [ZEvent] = []

        func flushTrace() {
            guard let first = trace.first, let last = trace.last else { return }
            rows.append(.trace("trace-\(first.seq)-\(last.seq)", trace))
            trace.removeAll(keepingCapacity: true)
        }

        for event in events {
            if traceTypes.contains(event.type) {
                trace.append(event)
            } else {
                flushTrace()
                rows.append(.event(event))
            }
        }
        flushTrace()
        return rows
    }
}
