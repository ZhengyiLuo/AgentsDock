import SwiftTerm
import SwiftUI
import UIKit
import ZenithCore

struct MobileTerminalView: View {
    @EnvironmentObject private var store: MobileAppStore
    @Environment(\.dismiss) private var dismiss
    let session: ZSession
    @StateObject private var controller = MobileTerminalController()
    @State private var confirmKillSession = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                windowBar
                Divider()
                MobileTerminalEmulator(controller: controller)
                    .background(SwiftUI.Color.black)
                    .ignoresSafeArea(.keyboard, edges: .bottom)
                statusBar
            }
            .background(SwiftUI.Color.black)
            .navigationTitle(session.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
                ToolbarItemGroup(placement: .primaryAction) {
                    Button {
                        controller.reconnect()
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                    .accessibilityLabel("Reconnect terminal")
                    terminalActions
                }
            }
        }
        .preferredColorScheme(.dark)
        .task(id: session.id) {
            controller.connect(session: session, api: store.api)
        }
        .onDisappear {
            controller.disconnect()
        }
        .alert("End Terminal Session?", isPresented: $confirmKillSession) {
            Button("End Session", role: .destructive) {
                Task { await controller.killSession() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This kills the persistent tmux session and every shell running inside it.")
        }
    }

    private var windowBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(controller.windows) { window in
                    Button {
                        Task { await controller.runAction(.selectWindow, target: "\(window.index)") }
                    } label: {
                        HStack(spacing: 6) {
                            Image(systemName: "terminal")
                            Text(window.name)
                                .lineLimit(1)
                            if window.panes > 1 {
                                Text("\(window.panes)")
                                    .font(.caption2.monospacedDigit())
                                    .padding(.horizontal, 5)
                                    .padding(.vertical, 2)
                                    .background(.white.opacity(0.10), in: Capsule())
                            }
                        }
                        .font(.caption.weight(.semibold))
                        .padding(.horizontal, 10)
                        .frame(height: 34)
                        .background(window.active ? SwiftUI.Color.accentColor.opacity(0.24) : SwiftUI.Color.white.opacity(0.06))
                        .clipShape(RoundedRectangle(cornerRadius: 7))
                        .overlay(alignment: .bottom) {
                            if window.active {
                                Rectangle()
                                    .fill(SwiftUI.Color.accentColor)
                                    .frame(height: 2)
                            }
                        }
                    }
                    .buttonStyle(.plain)
                    .contextMenu {
                        Button(role: .destructive) {
                            Task { await controller.runAction(.killWindow, target: "\(window.index)") }
                        } label: {
                            Label("Close Window", systemImage: "xmark")
                        }
                        .disabled(controller.windows.count <= 1)
                    }
                }
                Button {
                    Task { await controller.runAction(.newWindow) }
                } label: {
                    Image(systemName: "plus")
                        .frame(width: 32, height: 32)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("New terminal window")
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
        }
        .background(SwiftUI.Color.white.opacity(0.035))
    }

    @ViewBuilder
    private var statusBar: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(connectionColor)
                .frame(width: 7, height: 7)
            Text(connectionLabel)
                .lineLimit(1)
            if let name = controller.connectionName {
                Text(name)
                    .lineLimit(1)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            if controller.mouseEnabled {
                Label("Mouse", systemImage: "cursorarrow.motionlines")
            }
        }
        .font(.caption2.monospaced())
        .foregroundStyle(.secondary)
        .padding(.horizontal, 10)
        .frame(height: 28)
        .background(SwiftUI.Color.white.opacity(0.035))
    }

    private var terminalActions: some View {
        Menu {
            Button {
                Task { await controller.runAction(.newWindow) }
            } label: {
                Label("New Window", systemImage: "plus.rectangle")
            }
            Button {
                Task { await controller.runAction(.splitRight) }
            } label: {
                Label("Split Right", systemImage: "rectangle.split.2x1")
            }
            Button {
                Task { await controller.runAction(.splitDown) }
            } label: {
                Label("Split Down", systemImage: "rectangle.split.1x2")
            }
            Button {
                Task { await controller.runAction(.killPane) }
            } label: {
                Label("Close Active Pane", systemImage: "xmark.rectangle")
            }
            Divider()
            Button {
                Task { await controller.runAction(.toggleMouse) }
            } label: {
                Label(controller.mouseEnabled ? "Disable tmux Mouse" : "Enable tmux Mouse", systemImage: "cursorarrow.motionlines")
            }
            Button(role: .destructive) {
                confirmKillSession = true
            } label: {
                Label("End Terminal Session", systemImage: "trash")
            }
        } label: {
            Image(systemName: "ellipsis.circle")
        }
        .disabled(controller.actionBusy)
    }

    private var connectionLabel: String {
        switch controller.state {
        case .disconnected: return "Disconnected"
        case .connecting: return "Connecting"
        case .connected: return "Attached"
        case .reconnecting: return "Reconnecting"
        case .failed(let message): return message
        }
    }

    private var connectionColor: SwiftUI.Color {
        switch controller.state {
        case .connected: return .green
        case .connecting, .reconnecting: return .yellow
        case .disconnected, .failed: return .red
        }
    }
}

private struct MobileTerminalEmulator: UIViewRepresentable {
    @ObservedObject var controller: MobileTerminalController

    func makeUIView(context: Context) -> TerminalView {
        let view = TerminalView(
            frame: .zero,
            font: UIFont.monospacedSystemFont(ofSize: 13, weight: .regular)
        )
        view.terminalDelegate = controller
        view.nativeBackgroundColor = .black
        view.nativeForegroundColor = UIColor(white: 0.90, alpha: 1)
        view.indicatorStyle = .white
        view.keyboardDismissMode = .none
        controller.attach(view)
        return view
    }

    func updateUIView(_ view: TerminalView, context: Context) {
        view.terminalDelegate = controller
        controller.attach(view)
    }

    static func dismantleUIView(_ view: TerminalView, coordinator: Void) {
        if let controller = view.terminalDelegate as? MobileTerminalController {
            controller.detach(view)
        }
        view.terminalDelegate = nil
    }
}
