import SwiftUI

#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

enum MobileTheme {
    #if canImport(UIKit)
    static let panel = Color(.secondarySystemGroupedBackground)
    static let card = Color(.secondarySystemBackground)
    static let softLine = Color(.separator).opacity(0.22)
    #elseif canImport(AppKit)
    static let panel = Color(nsColor: .controlBackgroundColor)
    static let card = Color(nsColor: .textBackgroundColor)
    static let softLine = Color(nsColor: .separatorColor).opacity(0.22)
    #endif
    static let userBubble = Color.accentColor.opacity(0.16)
}
