import SwiftUI
import UniformTypeIdentifiers

struct MobileRootView: View {
    @EnvironmentObject private var store: MobileAppStore
    @StateObject private var features = MobileFeatureStore()
    @AppStorage("AgentsDock.appearanceMode") private var appearanceMode = MobileAppearanceMode.system.rawValue
    @State private var resumeOpen = false
    @State private var importerOpen = false
    @State private var settingsOpen = false

    var body: some View {
        NavigationSplitView {
            MobileSidebarView(resumeOpen: $resumeOpen, settingsOpen: $settingsOpen)
        } detail: {
            if store.selectedSession == nil {
                ContentUnavailableView("No Chat Selected", systemImage: "bubble.left.and.bubble.right", description: Text("Create or select a chat to start."))
            } else {
                MobileTimelineView(importerOpen: $importerOpen, resumeOpen: $resumeOpen)
            }
        }
        .environmentObject(features)
        .preferredColorScheme(MobileAppearanceMode(rawValue: appearanceMode)?.colorScheme)
        .task {
            features.configure(namespace: store.featureStateNamespace)
            await store.startLiveTracking()
        }
        .onChange(of: store.featureStateNamespace) { _, newValue in
            features.configure(namespace: newValue)
        }
        .sheet(isPresented: $resumeOpen) {
            MobileResumeView(isPresented: $resumeOpen)
                .environmentObject(store)
        }
        .sheet(isPresented: $settingsOpen) {
            MobileSettingsView()
                .environmentObject(store)
        }
        .fileImporter(isPresented: $importerOpen, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            if case .success(let urls) = result {
                Task { await store.upload(urls: urls) }
            }
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
