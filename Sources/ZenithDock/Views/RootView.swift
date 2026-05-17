import SwiftUI

struct RootView: View {
    @EnvironmentObject private var store: AppStore
    @State private var importerOpen = false
    @State private var resumeOpen = false
    @State private var serverSettingsOpen = false

    var body: some View {
        NavigationSplitView {
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
            InspectorView()
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
                Circle()
                    .fill(store.serverReachable ? Color.green : Color.red)
                    .frame(width: 8, height: 8)
                Text(store.serverReachable ? "Online" : "Offline")
                    .font(.caption.weight(.semibold))
                Image(systemName: "chevron.down")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 4)
        }
        .buttonStyle(.bordered)
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
