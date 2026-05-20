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

    var body: some View {
        Group {
            switch backend.lowercased() {
            case "claude":
                ClaudeLogoMark()
            case "codex":
                CodexLogoMark()
            default:
                GenericBackendLogoMark(tint: Theme.backendTint(backend))
            }
        }
        .frame(width: 16, height: 16)
        .accessibilityLabel("\(backend.capitalized) logo")
    }
}

private struct ClaudeLogoMark: View {
    var body: some View {
        Canvas { context, size in
            let center = CGPoint(x: size.width / 2, y: size.height / 2)
            let outer = min(size.width, size.height) * 0.43
            let inner = min(size.width, size.height) * 0.13
            let color = Color(red: 0.96, green: 0.56, blue: 0.18)

            for index in 0..<8 {
                let angle = (Double(index) * .pi / 4) - (.pi / 2)
                var ray = Path()
                ray.move(to: CGPoint(
                    x: center.x + cos(angle) * inner,
                    y: center.y + sin(angle) * inner
                ))
                ray.addLine(to: CGPoint(
                    x: center.x + cos(angle) * outer,
                    y: center.y + sin(angle) * outer
                ))
                context.stroke(ray, with: .color(color), style: StrokeStyle(lineWidth: 2.0, lineCap: .round))
            }

            context.fill(
                Path(ellipseIn: CGRect(x: center.x - 1.8, y: center.y - 1.8, width: 3.6, height: 3.6)),
                with: .color(color)
            )
        }
    }
}

private struct CodexLogoMark: View {
    private let palette: [Color] = [
        Color(red: 0.10, green: 0.72, blue: 0.96),
        Color(red: 0.04, green: 0.82, blue: 0.72),
        Color(red: 0.14, green: 0.78, blue: 0.42),
        Color(red: 0.43, green: 0.78, blue: 0.20),
        Color(red: 0.12, green: 0.68, blue: 0.86),
        Color(red: 0.08, green: 0.58, blue: 0.92)
    ]

    var body: some View {
        Canvas { context, size in
            let center = CGPoint(x: size.width / 2, y: size.height / 2)
            let radius = min(size.width, size.height) * 0.34
            let width = min(size.width, size.height) * 0.18

            for index in 0..<6 {
                let start = -Double.pi / 2 + Double(index) * Double.pi / 3 + 0.16
                let end = start + Double.pi / 3 * 0.72
                var segment = Path()
                segment.addArc(
                    center: center,
                    radius: radius,
                    startAngle: .radians(start),
                    endAngle: .radians(end),
                    clockwise: false
                )
                context.stroke(segment, with: .color(palette[index]), style: StrokeStyle(lineWidth: width, lineCap: .round))
            }

            context.fill(
                Path(ellipseIn: CGRect(x: center.x - 1.2, y: center.y - 1.2, width: 2.4, height: 2.4)),
                with: .color(Color.primary.opacity(0.35))
            )
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
