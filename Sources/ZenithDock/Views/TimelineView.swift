import SwiftUI
import UniformTypeIdentifiers
import ZenithCore

struct TimelineView: View {
    @EnvironmentObject private var store: AppStore
    @Binding var importerOpen: Bool
    @State private var isAtBottom = true
    private let bottomID = "timeline-bottom"

    var body: some View {
        let displayEvents = store.displayEvents
        let rows = TimelineRows.build(from: displayEvents)

        VStack(spacing: 0) {
            HeaderView()
            Divider()
            ScrollViewReader { proxy in
                GeometryReader { geometry in
                    ZStack(alignment: .bottomTrailing) {
                        ScrollView {
                            LazyVStack(alignment: .leading, spacing: 14) {
                                if store.selectedSession == nil {
                                    EmptyStateView()
                                } else {
                                    if store.hiddenDisplayEventCount > 0 {
                                        TimelineHistoryLoader()
                                    }
                                    ForEach(rows) { row in
                                        switch row {
                                        case .event(let event):
                                            EventCard(event: event)
                                                .id(row.id)
                                        case .trace(let id, let events):
                                            TraceGroupCard(events: events)
                                                .id(id)
                                        }
                                    }
                                    Color.clear
                                        .frame(height: 1)
                                        .id(bottomID)
                                }
                            }
                            .padding(20)
                            .padding(.bottom, 56)
                            .frame(maxWidth: 980, alignment: .leading)
                            .frame(maxWidth: .infinity, alignment: .center)
                            .background(
                                GeometryReader { content in
                                    Color.clear.preference(
                                        key: TimelineBottomOffsetKey.self,
                                        value: content.frame(in: .named("timeline-scroll")).maxY
                                    )
                                }
                            )
                        }
                        .coordinateSpace(name: "timeline-scroll")
                        if !isAtBottom && !displayEvents.isEmpty {
                            Button {
                                scrollToBottom(proxy)
                            } label: {
                                Label("Bottom", systemImage: "arrow.down.to.line.compact")
                            }
                            .buttonStyle(.borderedProminent)
                            .controlSize(.regular)
                            .padding(18)
                            .help("Jump to latest message")
                        }
                    }
                    .onPreferenceChange(TimelineBottomOffsetKey.self) { bottomY in
                        updateBottomVisibility(bottomY: bottomY, viewportHeight: geometry.size.height)
                    }
                    .onChange(of: store.scrollToBottomRevision) {
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
            Divider()
            ComposerView(importerOpen: $importerOpen)
        }
        .background(Theme.window)
        .animation(.snappy(duration: 0.22), value: store.isRunning)
        .fileImporter(isPresented: $importerOpen, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            if case .success(let urls) = result {
                Task { await store.upload(urls: urls) }
            }
        }
        .onDrop(of: [.fileURL], isTargeted: nil) { providers in
            Task {
                var urls: [URL] = []
                for provider in providers {
                    if let item = try? await provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier),
                       let data = item as? Data,
                       let url = URL(dataRepresentation: data, relativeTo: nil) {
                        urls.append(url)
                    }
                }
                await store.upload(urls: urls)
            }
            return true
        }
    }

    private func scrollToBottom(_ proxy: ScrollViewProxy) {
        guard !store.displayEvents.isEmpty else { return }
        withAnimation(.snappy) {
            proxy.scrollTo(bottomID, anchor: .bottom)
            isAtBottom = true
        }
    }

    private func updateBottomVisibility(bottomY: CGFloat, viewportHeight: CGFloat) {
        guard viewportHeight > 1, !store.displayEvents.isEmpty else {
            if !isAtBottom { isAtBottom = true }
            return
        }
        let next = bottomY <= viewportHeight + 72
        if isAtBottom != next {
            isAtBottom = next
        }
    }
}

private struct TimelineBottomOffsetKey: PreferenceKey {
    static let defaultValue: CGFloat = .zero

    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = nextValue()
    }
}

private enum TimelineRow: Identifiable {
    case event(ZEvent)
    case trace(String, [ZEvent])

    var id: String {
        switch self {
        case .event(let event):
            return "event-\(event.id)"
        case .trace(let id, _):
            return id
        }
    }
}

private enum TimelineRows {
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

    static func build(from events: [ZEvent]) -> [TimelineRow] {
        var rows: [TimelineRow] = []
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

private struct TimelineHistoryLoader: View {
    @EnvironmentObject private var store: AppStore

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "clock.arrow.circlepath")
            Text("Showing latest messages")
            Text("\(store.hiddenDisplayEventCount) older events not loaded")
                .foregroundStyle(.secondary)
            Spacer()
            if store.loadedHistoryLimitReached {
                Text("Loaded window limit")
                    .foregroundStyle(.secondary)
            } else if store.isLoadingOlderHistory {
                ProgressView()
                    .controlSize(.small)
                Text("Loading")
                    .foregroundStyle(.secondary)
            } else {
                Button {
                    Task { await store.loadOlderHistory() }
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
}

struct HeaderView: View {
    @EnvironmentObject private var store: AppStore
    @State private var draftTitle = ""
    @AppStorage("chatFontSize") private var chatFontSize = 14.0
    @AppStorage("chatFontDesign") private var chatFontDesign = "default"

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 8) {
                    TextField("Chat title", text: $draftTitle)
                        .textFieldStyle(.plain)
                        .font(.title3.weight(.semibold))
                        .onSubmit { saveTitle() }
                    Button {
                        saveTitle()
                    } label: {
                        Label("Save Name", systemImage: "checkmark.circle")
                    }
                    .buttonStyle(.borderless)
                    .labelStyle(.titleAndIcon)
                    .disabled(store.selectedSession == nil || draftTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .help("Save the chat title")
                }
                Text(sessionSubtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            if store.isRunning {
                RunningAgentBanner(backend: store.selectedSession?.backend ?? "agent")
            }
            if let session = store.selectedSession {
                Button {
                    Task { await store.togglePin(session) }
                } label: {
                    Label(session.pinned == true ? "Unpin" : "Pin", systemImage: session.pinned == true ? "pin.fill" : "pin")
                }
                .buttonStyle(.borderless)
                .labelStyle(.titleAndIcon)
                .help(session.pinned == true ? "Unpin chat" : "Pin chat")
            }
            Toggle(isOn: $store.showDebugEvents) {
                Label("Debug Trace", systemImage: "waveform.path.ecg")
            }
            .toggleStyle(.button)
            .help("Show or hide raw process events")
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
            .labelStyle(.titleAndIcon)
            .help("Change chat font")
            Picker("Backend", selection: Binding(
                get: { store.selectedSession?.backend ?? "claude" },
                set: { newValue in Task { await store.updateSelected(backend: newValue) } }
            )) {
                Text("Claude").tag("claude")
                Text("Codex").tag("codex")
            }
            .pickerStyle(.segmented)
            .frame(width: 180)
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 14)
        .background(Theme.panel)
        .onAppear { syncTitle() }
        .onChange(of: store.selectedSessionID) { syncTitle() }
        .onChange(of: store.selectedSession?.title) { syncTitle() }
    }

    private var sessionSubtitle: String {
        guard let session = store.selectedSession else { return "No chat selected" }
        if let provider = session.session_id, !provider.isEmpty {
            return "\(session.backend) session \(String(provider.prefix(12)))"
        }
        return "\(session.backend) · \(session.folder ?? "General") · \(session.cwd ?? "/home/zen")"
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
