import SwiftUI

struct EmptyStateView: View {
    var body: some View {
        ContentUnavailableView {
            Label("Zenith Dock", systemImage: "sparkles")
        } description: {
            Text("A native cockpit for Claude and Codex running on your agent server.")
        }
        .frame(maxWidth: .infinity, minHeight: 420)
    }
}
