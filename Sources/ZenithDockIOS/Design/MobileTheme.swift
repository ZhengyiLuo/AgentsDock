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

    static func backendTint(_ backend: String) -> Color {
        backend.lowercased() == "codex" ? Color(red: 0.10, green: 0.72, blue: 0.96) : Color(red: 0.96, green: 0.56, blue: 0.18)
    }
}

struct MobileBackendLogo: View {
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
                MobileGenericBackendLogoMark(tint: MobileTheme.backendTint(backend))
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

private struct MobileGenericBackendLogoMark: View {
    let tint: Color

    var body: some View {
        Image(systemName: "cpu")
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(tint)
    }
}
