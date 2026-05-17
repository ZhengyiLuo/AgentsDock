import AppKit
import SwiftTerm
import SwiftUI
import ZenithCore

struct TerminalWorkspaceView: View {
    @EnvironmentObject private var store: AppStore
    @Binding var selectedPane: WorkspacePane
    @Binding var serverSettingsOpen: Bool
    let isActive: Bool
    @AppStorage("terminalSSHUser") private var terminalSSHUser = "zen"
    @State private var confirmKill = false
    @State private var terminalStatus = "Terminal idle"
    @State private var actionSerial = 0
    @State private var pendingAction: TerminalAction?

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            content
        }
        .background(Theme.window)
        .task(id: "\(store.selectedSessionID ?? "none"):\(isActive)") {
            guard isActive, store.selectedSessionID != nil else { return }
            terminalStatus = "Creating or attaching tmux..."
            await store.openSelectedTerminal(showErrors: false)
            await store.refreshSelectedTerminal(showErrors: false)
        }
        .confirmationDialog("Kill tmux session?", isPresented: $confirmKill) {
            Button("Kill Terminal", role: .destructive) {
                Task { await store.killSelectedTerminal() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This kills the tmux session for the selected chat. Running shell work inside it will stop.")
        }
    }

    @ViewBuilder
    private var content: some View {
        if store.selectedSession == nil {
            EmptyStateView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let identity = terminalIdentity {
            SwiftTermTerminalView(
                identity: identity,
                action: pendingAction,
                onStatus: { terminalStatus = $0 }
            )
            .background(Color.black)
        } else {
            VStack(spacing: 12) {
                ProgressView()
                    .controlSize(.small)
                Text(waitingText)
                    .font(.callout.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Color.black.opacity(0.9))
        }
    }

    private var header: some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 5) {
                Text(store.selectedSession?.title ?? "Terminal")
                    .font(.title3.weight(.semibold))
                    .lineLimit(1)
                HStack(spacing: 6) {
                    Circle()
                        .fill(store.terminalSnapshot?.exists == true ? .green : .secondary)
                        .frame(width: 7, height: 7)
                    Text(statusLine)
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }
            .frame(minWidth: 220, maxWidth: .infinity, alignment: .leading)

            ServerConnectionToolbarButton(isPresented: $serverSettingsOpen)
                .layoutPriority(3)

            WorkspaceTabStrip(selection: $selectedPane, isEnabled: store.selectedSession != nil)

            HStack(spacing: 6) {
                Button {
                    Task { await store.openSelectedTerminal() }
                } label: {
                    Label("Reconnect", systemImage: "arrow.clockwise")
                }
                .help("Reconnect the embedded SSH terminal to this chat's tmux session")

                Button {
                    sendTerminalAction(.newWindow)
                } label: {
                    Label("New tmux window", systemImage: "plus.square.on.square")
                }
                .help("Create a new tmux window")

                Button {
                    sendTerminalAction(.splitRight)
                } label: {
                    Label("Split right", systemImage: "rectangle.split.2x1")
                }
                .help("Split the tmux pane to the right")

                Button {
                    sendTerminalAction(.splitDown)
                } label: {
                    Label("Split down", systemImage: "rectangle.split.1x2")
                }
                .help("Split the tmux pane downward")

                Button {
                    sendTerminalAction(.interrupt)
                } label: {
                    Label("Interrupt", systemImage: "stop.circle")
                }
                .help("Send Ctrl-C")

                Button(role: .destructive) {
                    confirmKill = true
                } label: {
                    Label("Kill tmux session", systemImage: "trash")
                }
                .help("Kill this chat's tmux session")
            }
            .labelStyle(.iconOnly)
            .buttonStyle(.bordered)
            .controlSize(.small)
            .disabled(store.selectedSession == nil)
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 12)
        .frame(minHeight: 68)
        .background(Theme.panel)
    }

    private var terminalIdentity: TerminalIdentity? {
        guard let session = store.selectedSession,
              let snapshot = store.terminalSnapshot,
              snapshot.exists,
              let host = store.api.baseURL.host,
              !host.isEmpty else {
            return nil
        }

        return TerminalIdentity(
            sessionID: session.id,
            host: host,
            user: terminalSSHUser.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "zen" : terminalSSHUser,
            tmuxName: snapshot.name,
            cwd: snapshot.cwd ?? session.cwd ?? "/home/zen"
        )
    }

    private var statusLine: String {
        guard store.selectedSession != nil else { return "No chat selected" }
        guard let snapshot = store.terminalSnapshot, snapshot.exists else { return waitingText }
        let host = store.api.baseURL.host ?? "server"
        let cwd = snapshot.cwd?.isEmpty == false ? snapshot.cwd! : "/home/zen"
        return "\(terminalSSHUser)@\(host) -> \(snapshot.name) · \(cwd) · \(terminalStatus)"
    }

    private var waitingText: String {
        if store.serverReachable == false {
            return "Server not reachable"
        }
        if store.terminalSnapshot == nil {
            return "Creating tmux session"
        }
        return "Waiting for tmux metadata"
    }

    private func sendTerminalAction(_ kind: TerminalAction.Kind) {
        actionSerial += 1
        pendingAction = TerminalAction(id: actionSerial, kind: kind)
    }
}

private struct TerminalIdentity: Equatable {
    let sessionID: String
    let host: String
    let user: String
    let tmuxName: String
    let cwd: String
}

private struct TerminalAction: Equatable {
    enum Kind: Equatable {
        case interrupt
        case newWindow
        case splitRight
        case splitDown
    }

    let id: Int
    let kind: Kind

    var bytes: [UInt8] {
        switch kind {
        case .interrupt:
            return [0x03]
        case .newWindow:
            return [0x02, UInt8(ascii: "c")]
        case .splitRight:
            return [0x02, UInt8(ascii: "%")]
        case .splitDown:
            return [0x02, UInt8(ascii: "\"")]
        }
    }
}

private struct SwiftTermTerminalView: NSViewRepresentable {
    let identity: TerminalIdentity
    let action: TerminalAction?
    var onStatus: (String) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onStatus: onStatus)
    }

    func makeNSView(context: Context) -> LocalProcessTerminalView {
        let terminal = LocalProcessTerminalView(frame: .zero)
        terminal.processDelegate = context.coordinator
        terminal.font = NSFont.monospacedSystemFont(ofSize: 13, weight: .regular)
        terminal.nativeBackgroundColor = NSColor(calibratedWhite: 0.045, alpha: 1)
        terminal.nativeForegroundColor = NSColor(calibratedWhite: 0.92, alpha: 1)
        terminal.caretColor = .systemGreen
        terminal.caretTextColor = .black
        terminal.selectedTextBackgroundColor = NSColor.systemBlue.withAlphaComponent(0.45)
        terminal.allowMouseReporting = true
        terminal.backspaceSendsControlH = false
        try? terminal.setUseMetal(true)

        context.coordinator.configure(terminal: terminal, identity: identity)
        return terminal
    }

    func updateNSView(_ terminal: LocalProcessTerminalView, context: Context) {
        context.coordinator.onStatus = onStatus
        context.coordinator.configure(terminal: terminal, identity: identity)
        context.coordinator.perform(action, in: terminal)
    }

    @MainActor
    static func dismantleNSView(_ terminal: LocalProcessTerminalView, coordinator: Coordinator) {
        if terminal.process.running {
            terminal.terminate()
        }
    }

    @MainActor
    final class Coordinator: NSObject, LocalProcessTerminalViewDelegate {
        var onStatus: (String) -> Void
        private var activeIdentity: TerminalIdentity?
        private var lastActionID = 0

        init(onStatus: @escaping (String) -> Void) {
            self.onStatus = onStatus
        }

        func configure(terminal: LocalProcessTerminalView, identity: TerminalIdentity) {
            guard activeIdentity != identity else {
                focus(terminal)
                return
            }

            if terminal.process.running {
                terminal.terminate()
            }

            activeIdentity = identity
            onStatus("Connecting")

            let remoteCommand = [
                "tmux",
                "new-session",
                "-A",
                "-s",
                shellQuote(identity.tmuxName),
                "-c",
                shellQuote(identity.cwd)
            ].joined(separator: " ")
            let args = [
                "-tt",
                "-F", "/dev/null",
                "-o", "ServerAliveInterval=30",
                "-o", "ServerAliveCountMax=2",
                "-o", "StrictHostKeyChecking=accept-new",
                "-o", "UserKnownHostsFile=\(knownHostsPath())",
                "-o", "GlobalKnownHostsFile=/dev/null",
                "-o", "UpdateHostKeys=no",
                "\(identity.user)@\(identity.host)",
                remoteCommand
            ]

            terminal.startProcess(
                executable: "/usr/bin/ssh",
                args: args,
                environment: terminalEnvironment(),
                execName: "ssh",
                currentDirectory: NSHomeDirectory()
            )
            focus(terminal)
        }

        func perform(_ action: TerminalAction?, in terminal: LocalProcessTerminalView) {
            guard let action, action.id != lastActionID else { return }
            lastActionID = action.id
            guard terminal.process.running else { return }
            terminal.send(action.bytes)
        }

        nonisolated func sizeChanged(source: LocalProcessTerminalView, newCols: Int, newRows: Int) {}

        nonisolated func setTerminalTitle(source: LocalProcessTerminalView, title: String) {
            Task { @MainActor [weak self] in
                self?.onStatus(title.isEmpty ? "Connected" : title)
            }
        }

        nonisolated func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {
            guard let directory, !directory.isEmpty else { return }
            Task { @MainActor [weak self] in
                self?.onStatus(directory)
            }
        }

        nonisolated func processTerminated(source: TerminalView, exitCode: Int32?) {
            let message: String
            if let exitCode {
                message = "SSH exited \(exitCode)"
            } else {
                message = "SSH disconnected"
            }
            Task { @MainActor [weak self] in
                self?.onStatus(message)
            }
        }

        private func focus(_ terminal: LocalProcessTerminalView) {
            DispatchQueue.main.async { [weak terminal] in
                guard let terminal else { return }
                terminal.window?.makeFirstResponder(terminal)
            }
        }

        private func shellQuote(_ value: String) -> String {
            "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'"
        }

        private func terminalEnvironment() -> [String] {
            var env = ProcessInfo.processInfo.environment
            env["TERM"] = "xterm-256color"
            env["COLORTERM"] = "truecolor"
            env["LANG"] = env["LANG"] ?? "en_US.UTF-8"
            env["LC_ALL"] = env["LC_ALL"] ?? "en_US.UTF-8"
            env["SSH_ASKPASS_REQUIRE"] = "never"
            return env.map { "\($0.key)=\($0.value)" }
        }

        private func knownHostsPath() -> String {
            let fm = FileManager.default
            let base = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
                ?? URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
            let dir = base.appendingPathComponent("ZenithDock", isDirectory: true)
            try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
            return dir.appendingPathComponent("ssh_known_hosts").path
        }
    }
}
