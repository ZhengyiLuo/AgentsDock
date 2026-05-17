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

func parseServerDate(_ value: String?) -> Date? {
    guard let value, !value.isEmpty else { return nil }

    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = fractional.date(from: value) {
        return date
    }

    let plain = ISO8601DateFormatter()
    plain.formatOptions = [.withInternetDateTime]
    return plain.date(from: value)
}

func localTimestampString(_ value: String?) -> String? {
    guard let date = parseServerDate(value) else { return value }

    let calendar = Calendar.autoupdatingCurrent
    let timeFormatter = DateFormatter()
    timeFormatter.locale = .autoupdatingCurrent
    timeFormatter.timeZone = .autoupdatingCurrent
    timeFormatter.timeStyle = .short
    timeFormatter.dateStyle = .none

    if calendar.isDateInToday(date) {
        return "\(timeFormatter.string(from: date)) today"
    }

    if calendar.isDateInTomorrow(date) {
        return "\(timeFormatter.string(from: date)) tomorrow"
    }

    let formatter = DateFormatter()
    formatter.locale = .autoupdatingCurrent
    formatter.timeZone = .autoupdatingCurrent

    if calendar.component(.year, from: date) == calendar.component(.year, from: Date()) {
        formatter.setLocalizedDateFormatFromTemplate("MMM d, h:mm a")
    } else {
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
    }
    return formatter.string(from: date)
}
