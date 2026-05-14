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
