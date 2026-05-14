import SwiftUI
import UniformTypeIdentifiers

struct MobileRootView: View {
    @EnvironmentObject private var store: MobileAppStore
    @State private var resumeOpen = false
    @State private var importerOpen = false

    var body: some View {
        NavigationSplitView {
            MobileSidebarView(resumeOpen: $resumeOpen)
        } detail: {
            if store.selectedSession == nil {
                ContentUnavailableView("No Chat Selected", systemImage: "bubble.left.and.bubble.right", description: Text("Create or select a chat to start."))
            } else {
                MobileTimelineView(importerOpen: $importerOpen, resumeOpen: $resumeOpen)
            }
        }
        .task { await store.startLiveTracking() }
        .onChange(of: store.selectedSessionID) {
            guard let sessionID = store.selectedSessionID else { return }
            Task { await store.select(sessionID: sessionID) }
        }
        .sheet(isPresented: $resumeOpen) {
            MobileResumeView(isPresented: $resumeOpen)
                .environmentObject(store)
        }
        .fileImporter(isPresented: $importerOpen, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            if case .success(let urls) = result {
                Task { await store.upload(urls: urls) }
            }
        }
        .alert("ZenithDock", isPresented: Binding(
            get: { store.errorText != nil },
            set: { if !$0 { store.errorText = nil } }
        )) {
            Button("OK") { store.errorText = nil }
        } message: {
            Text(store.errorText ?? "")
        }
    }
}
