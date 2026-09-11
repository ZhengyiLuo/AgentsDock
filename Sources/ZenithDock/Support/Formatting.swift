import Foundation

func byteString(_ bytes: Int) -> String {
    let units = ["B", "KB", "MB", "GB"]
    var value = Double(bytes)
    var idx = 0
    while value > 1024, idx < units.count - 1 {
        value /= 1024
        idx += 1
    }
    return idx == 0 ? "\(bytes) B" : String(format: "%.1f %@", value, units[idx])
}

// `DateFormatter`/`ISO8601DateFormatter` instances are expensive to allocate
// (they spin up ICU internals), so they are created once and reused. Apple's
// formatting/parsing methods are thread-safe as long as the configured
// properties are not mutated afterwards, which is the case here.
private enum DateFormatters {
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

func parseServerDate(_ value: String?) -> Date? {
    guard let value, !value.isEmpty else { return nil }
    if let date = DateFormatters.iso8601Fractional.date(from: value) {
        return date
    }
    return DateFormatters.iso8601Plain.date(from: value)
}

func localTimestampString(_ value: String?) -> String? {
    guard let date = parseServerDate(value) else { return value }

    let calendar = Calendar.autoupdatingCurrent

    if calendar.isDateInToday(date) {
        return "\(DateFormatters.timeOnly.string(from: date)) today"
    }

    if calendar.isDateInTomorrow(date) {
        return "\(DateFormatters.timeOnly.string(from: date)) tomorrow"
    }

    if calendar.component(.year, from: date) == calendar.component(.year, from: Date()) {
        return DateFormatters.monthDayTime.string(from: date)
    }
    return DateFormatters.mediumDateTime.string(from: date)
}
