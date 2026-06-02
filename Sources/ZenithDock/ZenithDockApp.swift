import AppKit
import SwiftUI

@main
struct ZenithDockApp: App {
    @NSApplicationDelegateAdaptor(ZenithDockAppDelegate.self) private var appDelegate
    @StateObject private var store = AppStore()
    @AppStorage("rightInspectorVisible") private var inspectorVisible = true

    init() {
        AppLogger.install()
        AppLogger.info("ZenithDock launch")
    }

    var body: some Scene {
        Window("Zenith Dock", id: "main") {
            RootView()
                .environmentObject(store)
                .frame(minWidth: 1180, minHeight: 760)
        }
        .windowStyle(.titleBar)
        .commands {
            CommandGroup(replacing: .newItem) {
                ShowZenithDockWindowCommand()
            }
            CommandMenu("Chat") {
                Button("Next Chat") {
                    Task { @MainActor in
                        await store.selectAdjacentSession(direction: 1)
                    }
                }
                .keyboardShortcut(.tab, modifiers: [.control])
                Button("Previous Chat") {
                    Task { @MainActor in
                        await store.selectAdjacentSession(direction: -1)
                    }
                }
                .keyboardShortcut(.tab, modifiers: [.control, .shift])

                Divider()

                Button(inspectorVisible ? "Hide Right Panel" : "Show Right Panel") {
                    inspectorVisible.toggle()
                }
                .keyboardShortcut("l", modifiers: .command)
            }
        }
    }
}

private struct ShowZenithDockWindowCommand: View {
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Button("Show ZenithDock") {
            AppLogger.info("show window command")
            if !ZenithDockWindowController.activateExistingMainWindow() {
                openWindow(id: "main")
            }
            NSApp.activate()
            ZenithDockWindowController.cullDuplicateMainWindowsSoon()
        }
        .keyboardShortcut("0", modifiers: .command)
    }
}

final class ZenithDockAppDelegate: NSObject, NSApplicationDelegate {
    private let singleInstanceGuard = ZenithDockSingleInstanceGuard()

    func applicationWillFinishLaunching(_ notification: Notification) {
        if singleInstanceGuard.shouldTerminateDuplicateLaunch() {
            NSApp.terminate(nil)
        }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        ZenithDockWindowController.cullDuplicateMainWindowsSoon()
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        AppLogger.info("app reopen visible_windows=\(flag)")
        ZenithDockWindowController.cullDuplicateMainWindows()
        if !ZenithDockWindowController.activateExistingMainWindow() && !flag {
            sender.sendAction(Selector(("showNewWindow:")), to: nil, from: nil)
        }
        sender.activate()
        ZenithDockWindowController.cullDuplicateMainWindowsSoon()
        return true
    }

    func applicationWillTerminate(_ notification: Notification) {
        singleInstanceGuard.releaseLock()
    }

    func applicationDidBecomeActive(_ notification: Notification) {
        AppLogger.info("app did become active \(ZenithDockWindowController.windowSummary())")
        ZenithDockWindowController.cullDuplicateMainWindowsSoon()
    }
}

private final class ZenithDockSingleInstanceGuard {
    private var lockFileDescriptor: CInt = -1

    func shouldTerminateDuplicateLaunch() -> Bool {
        if let existing = existingRunningApplication() {
            if shouldReplace(existing) {
                AppLogger.warning("replacing stale existing app pid=\(existing.processIdentifier) path=\(existing.bundleURL?.path ?? "-")")
                existing.terminate()
                waitForTermination(existing)
            } else {
                activate(existing)
                AppLogger.info("duplicate launch detected existing_pid=\(existing.processIdentifier)")
                return true
            }
        }

        if let existing = existingRunningApplication() {
            activate(existing)
            AppLogger.info("duplicate launch detected existing_pid=\(existing.processIdentifier)")
            return true
        }

        if acquireLock() {
            return false
        }

        if let existing = existingRunningApplication() {
            activate(existing)
        }
        AppLogger.info("duplicate launch detected by lock")
        return true
    }

    private func shouldReplace(_ existing: NSRunningApplication) -> Bool {
        guard let existingPath = existing.bundleURL?.standardizedFileURL.path else { return false }
        let currentPath = Bundle.main.bundleURL.standardizedFileURL.path
        guard existingPath != currentPath else { return false }
        return existingPath.contains("/DerivedData/") || currentPath.contains("/DerivedData/")
    }

    private func waitForTermination(_ app: NSRunningApplication) {
        let deadline = Date().addingTimeInterval(1.2)
        while !app.isTerminated && Date() < deadline {
            RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.05))
        }
        if !app.isTerminated {
            AppLogger.warning("force terminating stale app pid=\(app.processIdentifier)")
            app.forceTerminate()
        }
    }

    func releaseLock() {
        guard lockFileDescriptor >= 0 else { return }
        flock(lockFileDescriptor, LOCK_UN)
        close(lockFileDescriptor)
        lockFileDescriptor = -1
    }

    private func acquireLock() -> Bool {
        do {
            let directory = try lockDirectory()
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let url = directory.appendingPathComponent("ZenithDock.lock")
            let fd = open(url.path, O_CREAT | O_RDWR, S_IRUSR | S_IWUSR)
            guard fd >= 0 else {
                AppLogger.error("single instance lock open failed errno=\(errno)")
                return true
            }
            guard flock(fd, LOCK_EX | LOCK_NB) == 0 else {
                close(fd)
                return false
            }
            lockFileDescriptor = fd
            return true
        } catch {
            AppLogger.error("single instance lock setup failed \(error.localizedDescription)")
            return true
        }
    }

    private func lockDirectory() throws -> URL {
        let appSupport = try FileManager.default.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )
        return appSupport.appendingPathComponent("ZenithDock", isDirectory: true)
    }

    private func existingRunningApplication() -> NSRunningApplication? {
        let currentPID = ProcessInfo.processInfo.processIdentifier
        let bundleIdentifier = Bundle.main.bundleIdentifier
        let bundleName = Bundle.main.object(forInfoDictionaryKey: "CFBundleName") as? String ?? "ZenithDock"

        return NSWorkspace.shared.runningApplications
            .filter { app in
                guard app.processIdentifier != currentPID else { return false }
                if let bundleIdentifier, app.bundleIdentifier == bundleIdentifier {
                    return true
                }
                return app.localizedName == bundleName
            }
            .sorted { lhs, rhs in
                if lhs.activationPolicy == .regular, rhs.activationPolicy != .regular {
                    return true
                }
                if lhs.activationPolicy != .regular, rhs.activationPolicy == .regular {
                    return false
                }
                return lhs.processIdentifier < rhs.processIdentifier
            }
            .first
    }

    private func activate(_ app: NSRunningApplication) {
        app.activate(options: [.activateAllWindows])
    }
}

@MainActor
private enum ZenithDockWindowController {
    private static let mainWindowTitle = "Zenith Dock"

    static func activateExistingMainWindow() -> Bool {
        cullDuplicateMainWindows()
        guard let window = mainWindows().first else { return false }
        if window.isMiniaturized {
            window.deminiaturize(nil)
        }
        window.makeKeyAndOrderFront(nil)
        return true
    }

    static func cullDuplicateMainWindowsSoon() {
        DispatchQueue.main.async {
            cullDuplicateMainWindows()
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
            cullDuplicateMainWindows()
        }
    }

    static func cullDuplicateMainWindows() {
        let windows = mainWindows()
        guard windows.count > 1 else { return }
        let keeper = windows.first(where: \.isKeyWindow)
            ?? windows.first(where: \.isMainWindow)
            ?? windows.first(where: \.isVisible)
            ?? windows[0]
        for window in windows where window !== keeper {
            window.close()
        }
        AppLogger.warning("closed duplicate main windows kept=\(ObjectIdentifier(keeper).hashValue) closed=\(windows.count - 1)")
    }

    static func windowSummary() -> String {
        let visibleWindows = NSApp.windows.filter(\.isVisible)
        let titles = visibleWindows
            .map { window in
                let title = window.title.isEmpty ? String(describing: type(of: window)) : window.title
                return title.replacingOccurrences(of: " ", with: "_")
            }
            .prefix(6)
            .joined(separator: ",")
        return "app_windows=\(NSApp.windows.count) visible_windows=\(visibleWindows.count) main_windows=\(mainWindows().count) titles=[\(titles)]"
    }

    private static func mainWindows() -> [NSWindow] {
        NSApp.windows
            .filter { $0.title == mainWindowTitle && !$0.isReleasedWhenClosed }
            .sorted { lhs, rhs in
                if lhs.isKeyWindow != rhs.isKeyWindow { return lhs.isKeyWindow }
                if lhs.isMainWindow != rhs.isMainWindow { return lhs.isMainWindow }
                return lhs.windowNumber < rhs.windowNumber
            }
    }
}
