import SwiftUI
import ZenithCore

struct MobileTimelineView: View {
    @EnvironmentObject private var store: MobileAppStore
    @Binding var importerOpen: Bool
    @Binding var resumeOpen: Bool
    @State private var isAtBottom = true
    @State private var optionsOpen = false
    private let bottomID = "mobile-timeline-bottom"

    var body: some View {
        let rows = MobileTimelineRows.build(from: store.displayEvents)

        VStack(spacing: 0) {
            MobileChatHeader(
                importerOpen: $importerOpen,
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
                            if store.hiddenDisplayEventCount > 0 {
                                MobileTimelineHistoryLoader()
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
                    .refreshable {
                        await store.refreshTimelineFromPull()
                    }
                    if !isAtBottom && !store.displayEvents.isEmpty {
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
                    scrollToBottom(proxy)
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
}

private struct MobileChatHeader: View {
    @EnvironmentObject private var store: MobileAppStore
    @Binding var importerOpen: Bool
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
            Button {
                importerOpen = true
            } label: {
                Image(systemName: "paperclip")
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

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "clock.arrow.circlepath")
            VStack(alignment: .leading, spacing: 2) {
                Text("Older history")
                    .font(.caption.weight(.semibold))
                Text("\(store.hiddenDisplayEventCount) older events not loaded")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            if store.isLoadingOlderHistory {
                ProgressView()
                    .controlSize(.small)
            } else {
                Text("Scroll or pull")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(10)
        .background(MobileTheme.card)
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(MobileTheme.softLine))
        .onAppear {
            guard store.canLoadOlderHistory else { return }
            Task { await store.loadOlderHistory() }
        }
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
