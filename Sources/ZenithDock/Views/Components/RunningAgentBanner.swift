import SwiftUI

struct RunningAgentBanner: View {
    @EnvironmentObject private var store: AppStore

    var backend: String

    var body: some View {
        HStack(spacing: 6) {
            RunningAgentIcon(backend: backend)
            Text("\(backend.capitalized) running")
                .font(.caption.weight(.semibold))
                .lineLimit(1)
            Button(role: .destructive) {
                Task { await store.stop() }
            } label: {
                Image(systemName: "stop.circle")
            }
            .buttonStyle(.borderless)
            .controlSize(.small)
            .help("Stop current turn")
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 5)
        .background(.quaternary)
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.softLine))
        .help(store.socketLive ? "Live trace connected. New messages will queue." : "Server connected. Trace is reconnecting.")
    }
}

struct RunningAgentIcon: View {
    var backend: String

    var body: some View {
        HStack(spacing: 4) {
            ProgressView()
                .controlSize(.small)
                .frame(width: 12, height: 12)
            Image(systemName: backend == "codex" ? "sparkle.magnifyingglass" : "circle.hexagongrid")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(backend == "codex" ? .orange : .blue)
        }
        .accessibilityLabel("\(backend.capitalized) running")
    }
}
