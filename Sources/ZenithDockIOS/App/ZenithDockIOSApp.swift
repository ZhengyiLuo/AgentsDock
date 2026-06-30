import SwiftUI

@main
struct ZenithDockIOSApp: App {
    @StateObject private var store = MobileAppStore()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            MobileRootView()
                .environmentObject(store)
                .onChange(of: scenePhase, initial: true) { _, phase in
                    store.setApplicationActive(phase == .active)
                }
        }
    }
}
