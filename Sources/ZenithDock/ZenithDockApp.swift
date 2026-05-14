import SwiftUI

@main
struct ZenithDockApp: App {
    @StateObject private var store = AppStore()

    init() {
        AppLogger.install()
        AppLogger.info("ZenithDock launch")
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(store)
                .frame(minWidth: 1180, minHeight: 760)
        }
        .windowStyle(.titleBar)
    }
}
