import Foundation
import SwiftTerm
import UIKit
import ZenithCore

@MainActor
final class MobileTerminalController: NSObject, ObservableObject {
    enum ConnectionState: Equatable {
        case disconnected
        case connecting
        case connected
        case reconnecting
        case failed(String)
    }

    @Published private(set) var state: ConnectionState = .disconnected
    @Published private(set) var connectionName: String?
    @Published private(set) var windows: [ZTerminalWindow] = []
    @Published private(set) var mouseEnabled = false
    @Published private(set) var actionBusy = false

    private weak var terminalView: TerminalView?
    private var socket: URLSessionWebSocketTask?
    private var receiveTask: Task<Void, Never>?
    private var reconnectTask: Task<Void, Never>?
    private var windowRefreshTask: Task<Void, Never>?
    private var activeSession: ZSession?
    private var api: APIClient?
    private var intentionallyDisconnected = true

    func attach(_ view: TerminalView) {
        terminalView = view
    }

    func detach(_ view: TerminalView) {
        if terminalView === view {
            terminalView = nil
        }
    }

    func connect(session: ZSession, api: APIClient) {
        let sameSession = activeSession?.id == session.id
        activeSession = session
        self.api = api
        intentionallyDisconnected = false
        if sameSession, socket?.state == .running { return }
        openSocket(reconnecting: false)
    }

    func disconnect() {
        intentionallyDisconnected = true
        reconnectTask?.cancel()
        reconnectTask = nil
        windowRefreshTask?.cancel()
        windowRefreshTask = nil
        receiveTask?.cancel()
        receiveTask = nil
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
        state = .disconnected
    }

    func reconnect() {
        intentionallyDisconnected = false
        openSocket(reconnecting: true)
    }

    func sendBytes(_ data: Data) {
        guard let socket, socket.state == .running else { return }
        Task {
            do {
                try await socket.send(.data(data))
            } catch {
                await MainActor.run { self.handleSocketFailure(error) }
            }
        }
    }

    func refreshWindows() async {
        guard let api, let sessionID = activeSession?.id else { return }
        do {
            let snapshot: ZTerminalWindowsSnapshot = try await api.get("/api/sessions/\(sessionID)/terminal/windows")
            guard activeSession?.id == sessionID else { return }
            apply(snapshot)
        } catch {
            guard activeSession?.id == sessionID else { return }
            if case .connected = state {
                state = .failed(error.localizedDescription)
            }
        }
    }

    func runAction(_ action: ZTerminalAction, target: String? = nil) async {
        guard !actionBusy, let api, let sessionID = activeSession?.id else { return }
        actionBusy = true
        defer { actionBusy = false }
        struct Body: Codable {
            let action: String
            let target: String?
        }
        do {
            let snapshot: ZTerminalWindowsSnapshot = try await api.post(
                "/api/sessions/\(sessionID)/terminal/action",
                body: Body(action: action.rawValue, target: target)
            )
            guard activeSession?.id == sessionID else { return }
            apply(snapshot)
        } catch {
            state = .failed(error.localizedDescription)
        }
    }

    func killSession() async {
        guard let api, let sessionID = activeSession?.id else { return }
        struct Response: Codable {
            let killed: Bool?
        }
        do {
            let _: Response = try await api.delete("/api/sessions/\(sessionID)/terminal")
            disconnect()
            windows = []
            connectionName = nil
            terminalView?.feed(text: "\r\n[terminal session ended]\r\n")
        } catch {
            state = .failed(error.localizedDescription)
        }
    }

    private func openSocket(reconnecting: Bool) {
        guard let session = activeSession, let api else { return }
        reconnectTask?.cancel()
        reconnectTask = nil
        receiveTask?.cancel()
        receiveTask = nil
        socket?.cancel(with: .goingAway, reason: nil)

        state = reconnecting ? .reconnecting : .connecting
        let url = api.webSocketURL(
            "/api/sessions/\(session.id)/terminal/ws",
            queryItems: [
                URLQueryItem(name: "columns", value: "100"),
                URLQueryItem(name: "rows", value: "32"),
                URLQueryItem(name: "cwd", value: session.cwd)
            ]
        )
        let nextSocket = URLSession.shared.webSocketTask(with: url)
        socket = nextSocket
        nextSocket.resume()
        receiveTask = Task { @MainActor [weak self, weak nextSocket] in
            guard let self, let nextSocket else { return }
            await self.receiveLoop(socket: nextSocket, sessionID: session.id)
        }
    }

    private func receiveLoop(socket: URLSessionWebSocketTask, sessionID: String) async {
        do {
            while !Task.isCancelled, activeSession?.id == sessionID, self.socket === socket {
                let message = try await socket.receive()
                switch message {
                case .data(let data):
                    let bytes = [UInt8](data)
                    terminalView?.feed(byteArray: bytes[...])
                case .string(let text):
                    handleControlMessage(text)
                @unknown default:
                    break
                }
            }
        } catch {
            guard !Task.isCancelled, activeSession?.id == sessionID, self.socket === socket else { return }
            handleSocketFailure(error)
        }
    }

    private func handleControlMessage(_ text: String) {
        struct Control: Codable {
            let type: String
            let name: String?
            let message: String?
        }
        guard let data = text.data(using: .utf8),
              let control = try? JSONDecoder().decode(Control.self, from: data) else { return }
        switch control.type {
        case "ready":
            connectionName = control.name
            state = .connected
            startWindowRefresh()
            Task { await refreshWindows() }
        case "error":
            state = .failed(control.message ?? "Terminal connection failed")
        default:
            break
        }
    }

    private func handleSocketFailure(_ error: Error) {
        guard !intentionallyDisconnected else { return }
        state = .failed(error.localizedDescription)
        scheduleReconnect()
    }

    private func scheduleReconnect() {
        guard reconnectTask == nil, !intentionallyDisconnected else { return }
        reconnectTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(1.4))
            guard !Task.isCancelled, let self, !self.intentionallyDisconnected else { return }
            self.reconnectTask = nil
            self.openSocket(reconnecting: true)
        }
    }

    private func startWindowRefresh() {
        windowRefreshTask?.cancel()
        windowRefreshTask = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(2))
                guard !Task.isCancelled, let self else { return }
                await self.refreshWindows()
            }
        }
    }

    private func apply(_ snapshot: ZTerminalWindowsSnapshot) {
        connectionName = snapshot.name
        windows = snapshot.windows.sorted { $0.index < $1.index }
        mouseEnabled = snapshot.mouse_enabled ?? false
    }

    private func sendResize(columns: Int, rows: Int) {
        guard let socket, socket.state == .running else { return }
        struct Resize: Encodable {
            let type: String
            let columns: Int
            let rows: Int
        }
        guard let data = try? JSONEncoder().encode(Resize(type: "resize", columns: columns, rows: rows)),
              let text = String(data: data, encoding: .utf8) else { return }
        Task { try? await socket.send(.string(text)) }
    }
}

extension MobileTerminalController: TerminalViewDelegate {
    nonisolated func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) {
        Task { @MainActor [weak self] in
            self?.sendResize(columns: newCols, rows: newRows)
        }
    }

    nonisolated func setTerminalTitle(source: TerminalView, title: String) {}
    nonisolated func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}

    nonisolated func send(source: TerminalView, data: ArraySlice<UInt8>) {
        let payload = Data(data)
        Task { @MainActor [weak self] in
            self?.sendBytes(payload)
        }
    }

    nonisolated func scrolled(source: TerminalView, position: Double) {}

    nonisolated func requestOpenLink(source: TerminalView, link: String, params: [String: String]) {
        guard let url = URL(string: link) else { return }
        Task { @MainActor in
            await UIApplication.shared.open(url)
        }
    }

    nonisolated func bell(source: TerminalView) {}

    nonisolated func clipboardCopy(source: TerminalView, content: Data) {
        guard let text = String(data: content, encoding: .utf8) else { return }
        Task { @MainActor in
            UIPasteboard.general.string = text
        }
    }

    nonisolated func clipboardRead(source: TerminalView) -> Data? { nil }
    nonisolated func iTermContent(source: TerminalView, content: ArraySlice<UInt8>) {}
    nonisolated func rangeChanged(source: TerminalView, startY: Int, endY: Int) {}
}
