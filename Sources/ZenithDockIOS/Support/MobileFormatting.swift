import Foundation

func mobileByteString(_ bytes: Int) -> String {
    let units = ["B", "KB", "MB", "GB"]
    var value = Double(bytes)
    var idx = 0
    while value > 1024, idx < units.count - 1 {
        value /= 1024
        idx += 1
    }
    return idx == 0 ? "\(bytes) B" : String(format: "%.1f %@", value, units[idx])
}

func compactProviderID(_ value: String?) -> String? {
    guard let value, !value.isEmpty else { return nil }
    return String(value.prefix(12))
}

// `DateFormatter`/`ISO8601DateFormatter` are expensive to allocate (ICU
// spin-up). Created once, reused read-only (thread-safe per Apple). Mirrors the
// Mac `DateFormatters` enum (which is private to the Mac target and not in
// ZenithCore, so the iOS module needs its own copy). Declared `internal` (not
// `private`, which in Swift is file-scoped) so MobileEventViews /
// MobileChatOptionsView / MobileAppStore can all reach it.
enum MobileDateFormatters {
    // Free functions below call these from non-isolated view bodies, so the
    // ISO8601 statics need `nonisolated(unsafe)` under strict concurrency.
    nonisolated(unsafe) static let iso8601Fractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    nonisolated(unsafe) static let iso8601Plain: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()
    // Separate from iso8601Plain: forced UTC for the store's serialize path.
    nonisolated(unsafe) static let iso8601UTC: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        f.timeZone = TimeZone(secondsFromGMT: 0)
        return f
    }()
    static let timeOnly: DateFormatter = {
        let f = DateFormatter()
        f.locale = .autoupdatingCurrent
        f.timeZone = .autoupdatingCurrent
        f.timeStyle = .short
        f.dateStyle = .none
        return f
    }()
    static let monthDayTime: DateFormatter = {
        let f = DateFormatter()
        f.locale = .autoupdatingCurrent
        f.timeZone = .autoupdatingCurrent
        f.setLocalizedDateFormatFromTemplate("MMM d, h:mm a")
        return f
    }()
    static let mediumDateTime: DateFormatter = {
        let f = DateFormatter()
        f.locale = .autoupdatingCurrent
        f.timeZone = .autoupdatingCurrent
        f.dateStyle = .medium
        f.timeStyle = .short
        return f
    }()
}

// Shared replacement for the three byte-identical parse helpers
// (mobileJobRunDate, mobileMessageDate, mobileParseServerDate).
func parseMobileServerDate(_ value: String?) -> Date? {
    guard let value, !value.isEmpty else { return nil }
    if let d = MobileDateFormatters.iso8601Fractional.date(from: value) { return d }
    return MobileDateFormatters.iso8601Plain.date(from: value)
}
