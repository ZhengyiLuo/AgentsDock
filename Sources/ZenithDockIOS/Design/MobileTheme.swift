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
    static let userBubble = Color.green.opacity(0.19)
    static let userBubbleStroke = Color.green.opacity(0.38)
    static let queuedBubble = Color.yellow.opacity(0.16)
    static let queuedBubbleStroke = Color.yellow.opacity(0.48)
    static let jobBubble = Color.orange.opacity(0.08)
    static let jobBubbleStroke = Color.orange.opacity(0.34)
}
