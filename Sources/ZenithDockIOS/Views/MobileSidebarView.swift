import SwiftUI
import ZenithCore

struct MobileSidebarView: View {
    @EnvironmentObject private var store: MobileAppStore
    @Binding var resumeOpen: Bool

    var body: some View {
        List(selection: $store.selectedSessionID) {
            Section {
                MobileServerStatusView()
            }

            Section("Chats") {
                ForEach(store.sessions) { session in
                    MobileSessionRow(session: session)
                        .tag(session.id)
                }
            }
        }
        .navigationTitle("ZenithDock")
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                Button {
                    Task { await store.refresh() }
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                Button {
                    resumeOpen = true
                } label: {
                    Image(systemName: "arrow.uturn.forward.circle")
                }
                Button {
                    Task { await store.createSession() }
                } label: {
                    Image(systemName: "square.and.pencil")
                }
            }
        }
    }
}

private struct MobileServerStatusView: View {
    @EnvironmentObject private var store: MobileAppStore

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                Circle()
                    .fill(store.serverReachable ? .green : .red)
                    .frame(width: 10, height: 10)
                Text(store.serverReachable ? "Server online" : "Server offline")
                    .font(.subheadline.weight(.semibold))
                Spacer()
                if !store.activeSessionIDs.isEmpty {
                    Label("\(store.activeSessionIDs.count)", systemImage: "dot.radiowaves.left.and.right")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                }
            }
            TextField("Server URL", text: $store.serverURLString)
                .font(.caption.monospaced())
                .onChange(of: store.serverURLString) {
                    store.rememberServerURL()
                }
                .onSubmit { Task { await store.refresh() } }
        }
        .padding(.vertical, 4)
    }
}

private struct MobileSessionRow: View {
    @EnvironmentObject private var store: MobileAppStore
    let session: ZSession

    var body: some View {
        HStack(spacing: 10) {
            ZStack(alignment: .bottomTrailing) {
                Image(systemName: session.backend == "codex" ? "sparkle.magnifyingglass" : "circle.hexagongrid")
                    .foregroundStyle(session.backend == "codex" ? .orange : .blue)
                if store.activeSessionIDs.contains(session.id) {
                    Circle()
                        .fill(.green)
                        .frame(width: 7, height: 7)
                        .offset(x: 3, y: 2)
                }
            }
            VStack(alignment: .leading, spacing: 3) {
                Text(session.title)
                    .lineLimit(1)
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .padding(.vertical, 2)
    }

    private var subtitle: String {
        var pieces = [session.backend.capitalized]
        if store.activeSessionIDs.contains(session.id) {
            pieces.append("running")
        } else if let folder = session.folder, !folder.isEmpty {
            pieces.append(folder)
        }
        return pieces.joined(separator: " · ")
    }
}
