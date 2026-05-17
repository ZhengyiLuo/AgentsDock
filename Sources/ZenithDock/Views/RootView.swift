import SwiftUI

enum WorkspacePane: String, CaseIterable, Identifiable {
    case chat
    case terminal

    var id: String { rawValue }

    var title: String {
        switch self {
        case .chat: "Chat"
        case .terminal: "Terminal"
        }
    }

    var systemImage: String {
        switch self {
        case .chat: "text.bubble"
        case .terminal: "terminal"
        }
    }
}

struct WorkspaceTabStrip: View {
    @Binding var selection: WorkspacePane
    var isEnabled = true

    var body: some View {
        HStack(spacing: 3) {
            ForEach(WorkspacePane.allCases) { pane in
                Button {
                    selection = pane
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: pane.systemImage)
                            .font(.caption.weight(.semibold))
                        Text(pane.title)
                            .font(.caption.weight(.semibold))
                    }
                    .foregroundStyle(selection == pane ? Color.primary : Color.secondary)
                    .padding(.horizontal, 12)
                    .frame(height: 28)
                    .background(tabBackground(for: pane))
                    .overlay(alignment: .bottom) {
                        Rectangle()
                            .fill(selection == pane ? Color.accentColor : Color.clear)
                            .frame(height: 2)
                            .padding(.horizontal, 8)
                    }
                }
                .buttonStyle(.plain)
                .disabled(!isEnabled)
                .help("Show \(pane.title.lowercased())")
            }
        }
        .padding(.horizontal, 4)
        .padding(.top, 4)
        .background(Theme.window.opacity(0.8))
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.softLine))
    }

    @ViewBuilder
    private func tabBackground(for pane: WorkspacePane) -> some View {
        if selection == pane {
            UnevenRoundedRectangle(topLeadingRadius: 6, bottomLeadingRadius: 2, bottomTrailingRadius: 2, topTrailingRadius: 6)
                .fill(Theme.card)
        } else {
            Color.clear
        }
    }
}

struct RootView: View {
    @EnvironmentObject private var store: AppStore
    @State private var importerOpen = false
    @State private var resumeOpen = false
    @State private var serverSettingsOpen = false
    @State private var selectedPane: WorkspacePane = .chat

    var body: some View {
        NavigationSplitView {
            SidebarView()
                .navigationSplitViewColumnWidth(min: 240, ideal: 280, max: 340)
        } content: {
            ZStack {
                TimelineView(
                    importerOpen: $importerOpen,
                    resumeOpen: $resumeOpen,
                    serverSettingsOpen: $serverSettingsOpen,
                    selectedPane: $selectedPane
                )
                .opacity(selectedPane == .chat ? 1 : 0)
                .allowsHitTesting(selectedPane == .chat)
                .accessibilityHidden(selectedPane != .chat)

                TerminalWorkspaceView(
                    selectedPane: $selectedPane,
                    serverSettingsOpen: $serverSettingsOpen,
                    isActive: selectedPane == .terminal
                )
                .opacity(selectedPane == .terminal ? 1 : 0)
                .allowsHitTesting(selectedPane == .terminal)
                .accessibilityHidden(selectedPane != .terminal)
            }
            .navigationSplitViewColumnWidth(min: 560, ideal: 720)
        } detail: {
            InspectorView(selectedPane: $selectedPane)
                .navigationSplitViewColumnWidth(min: 340, ideal: 380, max: 480)
        }
        .background(Theme.window)
        .task { await store.startLiveTracking() }
        .sheet(isPresented: $resumeOpen) {
            ResumeSessionSheet(isPresented: $resumeOpen)
                .environmentObject(store)
        }
        .sheet(isPresented: $serverSettingsOpen) {
            ServerSettingsSheet(isPresented: $serverSettingsOpen)
                .environmentObject(store)
        }
        .onChange(of: store.selectedSessionID) {
            guard let sessionID = store.selectedSessionID, sessionID != store.loadedSessionID else { return }
            Task { await store.select(sessionID: sessionID) }
        }
        .alert("Zenith Dock", isPresented: Binding(
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
                Text("Example: 10.112.215.37:7850 or http://10.112.215.37:7850")
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
