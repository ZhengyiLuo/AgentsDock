import SwiftUI
import ZenithCore

struct RootView: View {
    @EnvironmentObject private var store: AppStore
    @State private var importerOpen = false
    @State private var resumeOpen = false
    @State private var serverSettingsOpen = false
    @AppStorage("rightInspectorVisible") private var inspectorVisible = true
    @State private var columnVisibility: NavigationSplitViewVisibility = .all

    var body: some View {
        NavigationSplitView(columnVisibility: $columnVisibility) {
            SidebarView()
                .navigationSplitViewColumnWidth(min: 240, ideal: 280, max: 340)
        } content: {
            TimelineView(
                importerOpen: $importerOpen,
                resumeOpen: $resumeOpen,
                serverSettingsOpen: $serverSettingsOpen
            )
            .navigationSplitViewColumnWidth(min: 560, ideal: 720)
        } detail: {
            if inspectorVisible {
                InspectorView()
                    .navigationSplitViewColumnWidth(min: 340, ideal: 380, max: 480)
            } else {
                Color.clear
                    .frame(width: 0)
                    .navigationSplitViewColumnWidth(min: 0, ideal: 0, max: 0)
            }
        }
        .background(Theme.window)
        .overlay {
            if store.chatSearchPaletteOpen {
                ChatSearchPalette()
                    .transition(.opacity)
            }
        }
        .animation(.easeOut(duration: 0.12), value: store.chatSearchPaletteOpen)
        .task { await store.startLiveTracking() }
        .sheet(isPresented: $resumeOpen) {
            ResumeSessionSheet(isPresented: $resumeOpen)
                .environmentObject(store)
        }
        .sheet(isPresented: $serverSettingsOpen) {
            ServerSettingsSheet(isPresented: $serverSettingsOpen)
                .environmentObject(store)
        }
        .alert("AgentsDock", isPresented: Binding(
            get: { store.errorText != nil },
            set: { if !$0 { store.errorText = nil } }
        )) {
            Button("OK") { store.errorText = nil }
        } message: {
            Text(store.errorText ?? "")
        }
    }
}

struct ServerConnectionToolbarButton: View {
    @EnvironmentObject private var store: AppStore
    @Binding var isPresented: Bool

    var body: some View {
        Button {
            isPresented.toggle()
        } label: {
            HStack(spacing: 6) {
                Image(systemName: store.serverReachable ? "checkmark.circle.fill" : "xmark.octagon.fill")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(store.serverReachable ? Color.green : Color.red)
                Text(store.serverReachable ? "Online" : "Offline")
                    .font(.caption.weight(.semibold))
                Image(systemName: "chevron.down")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 6)
            .frame(minWidth: 86)
        }
        .buttonStyle(.bordered)
        .controlSize(.small)
        .fixedSize(horizontal: true, vertical: true)
        .help("Server settings")
    }
}

struct ServerSettingsSheet: View {
    @EnvironmentObject private var store: AppStore
    @Binding var isPresented: Bool
    @State private var draftServerURL = ""
    @State private var draftAccessToken = ""
    @State private var isApplying = false
    @FocusState private var focusedField: Field?

    private enum Field {
        case serverURL
        case accessToken
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 10) {
                Circle()
                    .fill(store.serverReachable ? Color.green : Color.red)
                    .frame(width: 10, height: 10)
                VStack(alignment: .leading, spacing: 2) {
                    Text(store.serverReachable ? "Server online" : "Server offline")
                        .font(.headline)
                    Text(store.connectionSubtitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                Spacer(minLength: 0)
            }

            VStack(alignment: .leading, spacing: 8) {
                TextField("Server URL or host:port", text: $draftServerURL)
                    .textFieldStyle(.roundedBorder)
                    .focused($focusedField, equals: .serverURL)
                    .textSelection(.enabled)
                    .onSubmit { applyAndReconnect() }
                Text("Example: host:7850 or http://host:7850")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                SecureField("Access token", text: $draftAccessToken)
                    .textFieldStyle(.roundedBorder)
                    .focused($focusedField, equals: .accessToken)
                    .onSubmit { applyAndReconnect() }
            }

            HStack {
                Button {
                    applyAndReconnect()
                } label: {
                    if isApplying {
                        Label("Connecting", systemImage: "bolt.horizontal.circle")
                    } else {
                        Label("Apply & Reconnect", systemImage: "bolt.horizontal.circle")
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(!canApply || isApplying)
                Spacer()
                Button("Done") {
                    isPresented = false
                }
            }
        }
        .padding(20)
        .frame(minWidth: 520, idealWidth: 560)
        .onAppear { syncDrafts() }
        .onChange(of: isPresented) {
            if isPresented {
                syncDrafts()
            }
        }
    }

    private var canApply: Bool {
        !draftServerURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func syncDrafts() {
        draftServerURL = store.serverURLString
        draftAccessToken = store.accessToken
    }

    private func applyAndReconnect() {
        let cleanServerURL = draftServerURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanServerURL.isEmpty else { return }
        isApplying = true
        focusedField = nil
        Task {
            await store.applyServerSettings(serverURL: cleanServerURL, accessToken: draftAccessToken)
            await MainActor.run {
                isApplying = false
            }
        }
    }
}

// Notion-style ⌘P quick-find: a floating, centered overlay that fuzzy-searches
// every loaded chat. Arrow keys move the selection, Return opens it, Esc / click
// outside dismisses.
private struct ChatSearchPalette: View {
    @EnvironmentObject private var store: AppStore
    @State private var query = ""
    @State private var selection = 0
    @FocusState private var fieldFocused: Bool

    private var results: [ZSession] {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else { return Array(store.sessions.prefix(50)) }
        return Array(store.sessions.filter { matches($0, q) }.prefix(50))
    }

    var body: some View {
        ZStack(alignment: .top) {
            Rectangle()
                .fill(.black.opacity(0.32))
                .ignoresSafeArea()
                .contentShape(Rectangle())
                .onTapGesture { close() }

            VStack(spacing: 0) {
                HStack(spacing: 10) {
                    Image(systemName: "magnifyingglass")
                        .foregroundStyle(.secondary)
                    TextField("Search chats…", text: $query)
                        .textFieldStyle(.plain)
                        .font(.title3)
                        .focused($fieldFocused)
                        .onKeyPress(.downArrow) { move(1); return .handled }
                        .onKeyPress(.upArrow) { move(-1); return .handled }
                        .onKeyPress(.return) { openSelected(); return .handled }
                        .onKeyPress(.escape) { close(); return .handled }
                    if !query.isEmpty {
                        Button {
                            query = ""
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                                .foregroundStyle(.secondary)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 13)

                Divider()

                if results.isEmpty {
                    Text(query.isEmpty ? "Type to search your chats" : "No chats match “\(query)”")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(16)
                } else {
                    ScrollViewReader { proxy in
                        ScrollView {
                            LazyVStack(spacing: 2) {
                                ForEach(Array(results.enumerated()), id: \.element.id) { index, session in
                                    PaletteRow(session: session, selected: index == selection)
                                        .id(index)
                                        .contentShape(Rectangle())
                                        .onTapGesture {
                                            selection = index
                                            openSelected()
                                        }
                                }
                            }
                            .padding(6)
                        }
                        .frame(maxHeight: 340)
                        .onChange(of: selection) {
                            withAnimation(.linear(duration: 0.08)) {
                                proxy.scrollTo(selection, anchor: .center)
                            }
                        }
                    }
                }
            }
            .frame(width: 600)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(Theme.softLine))
            .shadow(color: .black.opacity(0.35), radius: 30, y: 14)
            .padding(.top, 110)
        }
        .onAppear {
            selection = 0
            DispatchQueue.main.async { fieldFocused = true }
        }
        .onChange(of: query) { selection = 0 }
    }

    private func move(_ delta: Int) {
        guard !results.isEmpty else { return }
        selection = max(0, min(results.count - 1, selection + delta))
    }

    private func openSelected() {
        guard results.indices.contains(selection) else { return }
        let id = results[selection].id
        close()
        Task { await store.select(sessionID: id) }
    }

    private func close() {
        store.chatSearchPaletteOpen = false
    }

    private func matches(_ session: ZSession, _ query: String) -> Bool {
        if session.title.localizedCaseInsensitiveContains(query) { return true }
        if let folder = session.folder, folder.localizedCaseInsensitiveContains(query) { return true }
        let parts = [
            session.backend,
            session.model,
            session.effort,
            session.cwd,
            session.session_id,
            session.claude_session_id,
            session.codex_thread_id
        ].compactMap { $0 }
        return parts.contains { $0.localizedCaseInsensitiveContains(query) }
    }
}

private struct PaletteRow: View {
    let session: ZSession
    let selected: Bool

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "bubble.left")
                .font(.callout)
                .foregroundStyle(selected ? Color.white : Color.secondary)
                .frame(width: 18)
            VStack(alignment: .leading, spacing: 1) {
                Text(session.title.isEmpty ? "Untitled chat" : session.title)
                    .font(.body)
                    .lineLimit(1)
                    .foregroundStyle(selected ? Color.white : Color.primary)
                if let subtitle {
                    Text(subtitle)
                        .font(.caption2)
                        .lineLimit(1)
                        .foregroundStyle(selected ? Color.white.opacity(0.82) : Color.secondary)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(selected ? Color.accentColor : Color.clear, in: RoundedRectangle(cornerRadius: 7))
    }

    private var subtitle: String? {
        var parts: [String] = []
        if let folder = session.folder, !folder.isEmpty { parts.append(folder) }
        if let model = session.model, !model.isEmpty {
            parts.append(model)
        } else if !session.backend.isEmpty {
            parts.append(session.backend)
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}
