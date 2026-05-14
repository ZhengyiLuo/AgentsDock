import SwiftUI

@main
struct ZenithDockIOSApp: App {
    @StateObject private var store = MobileAppStore()

    var body: some Scene {
        WindowGroup {
            MobileRootView()
                .environmentObject(store)
        }
    }
}
