import SwiftUI

@main
struct ZenithDockApp: App {
    @NSApplicationDelegateAdaptor(ZenithDockAppDelegate.self) private var appDelegate
    @StateObject private var store = AppStore()

    init() {
        AppLogger.install()
        AppLogger.info("ZenithDock launch")
    }

    var body: some Scene {
        WindowGroup("Zenith Dock", id: "main") {
            RootView()
                .environmentObject(store)
                .frame(minWidth: 1180, minHeight: 760)
        }
        .windowStyle(.titleBar)
        .commands {
            CommandGroup(replacing: .newItem) {
                NewZenithDockWindowCommand()
            }
        }
    }
}

private struct NewZenithDockWindowCommand: View {
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Button("New Window") {
            AppLogger.info("new window command")
            openWindow(id: "main")
            NSApp.activate(ignoringOtherApps: true)
        }
        .keyboardShortcut("n", modifiers: .command)
    }
}

final class ZenithDockAppDelegate: NSObject, NSApplicationDelegate {
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        AppLogger.info("app reopen visible_windows=\(flag)")
        guard !flag else { return true }
        if let window = sender.windows.first {
            window.makeKeyAndOrderFront(nil)
        } else {
            sender.sendAction(Selector(("showNewWindow:")), to: nil, from: nil)
        }
        sender.activate(ignoringOtherApps: true)
        return true
    }

    func applicationDidBecomeActive(_ notification: Notification) {
        AppLogger.info("app did become active windows=\(NSApp.windows.count)")
    }
}
