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
    static let queuedBubble = Color.yellow.opacity(0.16)
    static let queuedBubbleStroke = Color.yellow.opacity(0.48)
    static let jobBubble = Color.orange.opacity(0.08)
    static let jobBubbleStroke = Color.orange.opacity(0.34)

    static func backendTint(_ backend: String) -> Color {
        backend.lowercased() == "codex" ? Color(red: 0.10, green: 0.72, blue: 0.96) : Color(red: 0.96, green: 0.56, blue: 0.18)
    }
}

struct BackendLogo: View {
    let backend: String
    var size: CGFloat = 16

    var body: some View {
        ZStack {
            if let assetName {
                Image(assetName)
                    .resizable()
                    .renderingMode(.original)
                    .interpolation(.high)
                    .scaledToFit()
                    .padding(backend.lowercased() == "claude" ? 1 : 0)
                    .frame(width: size, height: size)
                    .clipShape(RoundedRectangle(cornerRadius: backend.lowercased() == "codex" ? 4 : 0))
            } else {
                GenericBackendLogoMark(tint: Theme.backendTint(backend))
                    .frame(width: size, height: size)
            }
        }
        .frame(width: size, height: size)
        .clipped()
        .accessibilityLabel("\(backend.capitalized) logo")
    }

    private var assetName: String? {
        switch backend.lowercased() {
        case "claude": return "ClaudeBackendLogo"
        case "codex": return "CodexBackendLogo"
        default: return nil
        }
    }
}

private struct GenericBackendLogoMark: View {
    let tint: Color

    var body: some View {
        Image(systemName: "cpu")
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(tint)
    }
}
