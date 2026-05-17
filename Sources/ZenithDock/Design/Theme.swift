import AppKit
import SwiftUI

enum Theme {
    static let window = Color(nsColor: .windowBackgroundColor)
    static let panel = Color(nsColor: .controlBackgroundColor)
    static let card = Color(nsColor: .textBackgroundColor)
    static let line = Color(nsColor: .separatorColor).opacity(0.35)
    static let softLine = Color(nsColor: .separatorColor).opacity(0.18)
    static let userBubble = Color.green.opacity(0.18)
    static let userBubbleStroke = Color.green.opacity(0.38)
    static let queuedBubble = Color.orange.opacity(0.14)
    static let queuedBubbleStroke = Color.orange.opacity(0.45)
    static let jobBubble = Color.orange.opacity(0.08)
    static let jobBubbleStroke = Color.orange.opacity(0.34)
}
