import Foundation

#if os(macOS)
import AppKit
#elseif canImport(UIKit)
import UIKit
#endif

enum AppLogger {
    private static let lock = NSLock()
    private static let runID = UUID().uuidString
    nonisolated(unsafe) private static var installed = false

    static let logURL: URL = {
        let root = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library", isDirectory: true)
            .appendingPathComponent("Logs", isDirectory: true)
            .appendingPathComponent("ZenithDock", isDirectory: true)
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return root.appendingPathComponent("ZenithDock.log")
    }()

    private static var markerURL: URL {
        logURL.deletingLastPathComponent().appendingPathComponent("CurrentRun.marker")
    }

    static func install() {
        guard !installed else { return }
        installed = true
        recordPreviousRunIfNeeded()
        markCurrentRun(clean: false)
        NSSetUncaughtExceptionHandler { exception in
            AppLogger.error("uncaught exception \(exception.name.rawValue): \(exception.reason ?? "no reason")")
        }
        registerTerminationObserver()
        info("app logger ready path=\(logURL.path)")
    }

    static func info(_ message: String) {
        write("INFO", message)
    }

    static func warning(_ message: String) {
        write("WARN", message)
    }

    static func error(_ message: String) {
        write("ERROR", message)
    }

    private static func write(_ level: String, _ message: String) {
        lock.lock()
        defer { lock.unlock() }

        let line = "\(Self.timestamp()) [\(level)] \(message)\n"
        guard let data = line.data(using: .utf8) else { return }

        if !FileManager.default.fileExists(atPath: logURL.path) {
            FileManager.default.createFile(atPath: logURL.path, contents: nil)
        }

        guard let handle = try? FileHandle(forWritingTo: logURL) else { return }
        defer { try? handle.close() }
        do {
            try handle.seekToEnd()
            try handle.write(contentsOf: data)
        } catch {
            // Last-resort logger; avoid surfacing logging failures into the UI.
        }
    }

    private static func timestamp() -> String {
        ISO8601DateFormatter().string(from: Date())
    }

    private static func recordPreviousRunIfNeeded() {
        guard let text = try? String(contentsOf: markerURL, encoding: .utf8),
              text.contains("clean=false") else {
            return
        }
        let summary = text
            .split(separator: "\n")
            .prefix(3)
            .joined(separator: " ")
        warning("previous run did not terminate cleanly \(summary)")
    }

    private static func markCurrentRun(clean: Bool) {
        let marker = [
            "run_id=\(runID)",
            "started_at=\(timestamp())",
            "clean=\(clean)"
        ].joined(separator: "\n") + "\n"
        try? marker.write(to: markerURL, atomically: true, encoding: .utf8)
    }

    private static func registerTerminationObserver() {
        #if os(macOS)
        NotificationCenter.default.addObserver(
            forName: NSApplication.willTerminateNotification,
            object: nil,
            queue: nil
        ) { _ in
            AppLogger.info("app will terminate")
            AppLogger.markCurrentRun(clean: true)
        }
        #elseif canImport(UIKit)
        NotificationCenter.default.addObserver(
            forName: UIApplication.willTerminateNotification,
            object: nil,
            queue: nil
        ) { _ in
            AppLogger.info("app will terminate")
            AppLogger.markCurrentRun(clean: true)
        }
        #endif
    }
}
