import AppKit
import SwiftUI

enum Theme {
    static let window = Color(nsColor: .windowBackgroundColor)
    static let panel = Color(nsColor: .controlBackgroundColor)
    static let card = Color(nsColor: .textBackgroundColor)
    static let line = Color(nsColor: .separatorColor).opacity(0.35)
    static let softLine = Color(nsColor: .separatorColor).opacity(0.18)
}
