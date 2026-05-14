import SwiftUI
import ZenithCore

struct MobileTimelineView: View {
    @EnvironmentObject private var store: MobileAppStore
    @Binding var importerOpen: Bool
    @State private var isAtBottom = true
    private let bottomID = "mobile-timeline-bottom"

    var body: some View {
        VStack(spacing: 0) {
            MobileChatHeader(importerOpen: $importerOpen)
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
                            ForEach(MobileTimelineRows.build(from: store.displayEvents)) { row in
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
