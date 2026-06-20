import Foundation
import OSLog

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

    /// Measure a synchronous block and log its wall-clock duration in ms.
    /// Used for ad-hoc perf instrumentation readable from the file log.
    @discardableResult
    static func measure<T>(_ label: String, _ body: () -> T) -> T {
        let start = DispatchTime.now()
        let result = body()
        let ms = Double(DispatchTime.now().uptimeNanoseconds - start.uptimeNanoseconds) / 1_000_000
        write("PERF", "\(label) ms=\(String(format: "%.1f", ms))")
        return result
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

    nonisolated(unsafe) private static let timestampFormatter = ISO8601DateFormatter()

    private static func timestamp() -> String {
        timestampFormatter.string(from: Date())
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

/// Lightweight wrapper around `OSSignposter` for measuring the timeline's hot
/// compute paths in Instruments (Points of Interest / os_signpost).
///
/// Signposts are effectively free when no Instruments trace is recording, so
/// these stay compiled in. To measure: profile the app in Instruments with the
/// "os_signpost" / "Points of Interest" instrument and filter by subsystem
/// `com.zenithdock.perf`.
enum AppSignpost {
    static let signposter = OSSignposter(
        subsystem: "com.zenithdock.perf",
        category: "timeline"
    )

    /// Run `body` inside a named signpost interval and return its result.
    @inline(__always)
    static func interval<T>(_ name: StaticString, _ body: () -> T) -> T {
        let state = signposter.beginInterval(name)
        defer { signposter.endInterval(name, state) }
        return body()
    }
}
