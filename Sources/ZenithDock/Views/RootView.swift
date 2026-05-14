import SwiftUI

struct RootView: View {
    @EnvironmentObject private var store: AppStore
    @State private var importerOpen = false
    @State private var resumeOpen = false

    var body: some View {
        NavigationSplitView {
            SidebarView()
                .navigationSplitViewColumnWidth(min: 240, ideal: 280, max: 340)
        } content: {
            TimelineView(importerOpen: $importerOpen)
                .navigationSplitViewColumnWidth(min: 560, ideal: 720)
        } detail: {
            InspectorView()
                .navigationSplitViewColumnWidth(min: 340, ideal: 380, max: 480)
        }
        .background(Theme.window)
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                TextField("Server", text: $store.serverURLString)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 240)
                    .onChange(of: store.serverURLString) {
                        store.rememberServerURL()
                    }
                    .onSubmit { Task { await store.refresh() } }
                SecureField("Token", text: $store.accessToken)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 150)
                    .onChange(of: store.accessToken) {
                        store.rememberAccessToken()
                    }
                    .onSubmit { Task { await store.refresh() } }
                    .help("Shared token for ZENITHDOCK_AGENT_TOKEN")
                Button {
                    Task { await store.refresh() }
                } label: {
                    Label("Check Server", systemImage: "bolt.horizontal.circle")
                }
                .labelStyle(.titleAndIcon)
                .help("Refresh server status, chats, and jobs")
                Button {
                    resumeOpen = true
                } label: {
                    Label("Resume by ID", systemImage: "arrow.uturn.forward.circle")
                }
                .labelStyle(.titleAndIcon)
                .help("Create a chat from an existing Claude or Codex session ID")
                Button {
                    importerOpen = true
                } label: {
                    Label("Attach Files", systemImage: "paperclip")
                }
                .labelStyle(.titleAndIcon)
                .disabled(store.selectedSession == nil)
                .help("Attach files to the selected chat")
                Button {
                    Task { await store.forkSelected() }
                } label: {
                    Label("Fork Chat", systemImage: "arrow.triangle.branch")
                }
                .labelStyle(.titleAndIcon)
                .disabled(store.selectedSession == nil)
                .help("Create a new chat from the selected chat")
                Button(role: .destructive) {
                    Task { await store.stop() }
                } label: {
                    Label("Stop Agent", systemImage: "stop.circle")
                }
                .labelStyle(.titleAndIcon)
                .disabled(!store.isRunning)
                .help("Stop the currently running Claude or Codex turn")
            }
        }
        .task { await store.startLiveTracking() }
        .sheet(isPresented: $resumeOpen) {
            ResumeSessionSheet(isPresented: $resumeOpen)
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
