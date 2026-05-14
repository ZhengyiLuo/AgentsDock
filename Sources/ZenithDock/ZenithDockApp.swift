import AppKit
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
        }
    }
}

private struct ShowZenithDockWindowCommand: View {
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Button("Show ZenithDock") {
            AppLogger.info("show window command")
            openWindow(id: "main")
            NSApp.activate(ignoringOtherApps: true)
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

    func applicationWillTerminate(_ notification: Notification) {
        singleInstanceGuard.releaseLock()
    }

    func applicationDidBecomeActive(_ notification: Notification) {
        AppLogger.info("app did become active windows=\(NSApp.windows.count)")
    }
}

private final class ZenithDockSingleInstanceGuard {
    private var lockFileDescriptor: CInt = -1

    func shouldTerminateDuplicateLaunch() -> Bool {
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
