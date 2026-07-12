import ExpoModulesCore
import Foundation
import UIKit

public final class AgentsDockTerminalView: ExpoView {
  private let terminalView = TerminalView(
    frame: .zero,
    font: UIFont.monospacedSystemFont(ofSize: 13, weight: .regular)
  )
  private let onStatus = EventDispatcher()
  private var socket: URLSessionWebSocketTask?
  private var socketURL: URL?
  private var reconnectWorkItem: DispatchWorkItem?
  private var intentionallyDisconnected = false
  private var receivedReady = false

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)

    clipsToBounds = true
    terminalView.terminalDelegate = self
    terminalView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    terminalView.nativeBackgroundColor = .black
    terminalView.nativeForegroundColor = UIColor(white: 0.92, alpha: 1)
    terminalView.indicatorStyle = .white
    terminalView.keyboardDismissMode = .none
    addSubview(terminalView)

    let tap = UITapGestureRecognizer(target: self, action: #selector(focusFromTap))
    tap.cancelsTouchesInView = false
    addGestureRecognizer(tap)
  }

  deinit {
    intentionallyDisconnected = true
    reconnectWorkItem?.cancel()
    socket?.cancel(with: .goingAway, reason: nil)
    terminalView.terminalDelegate = nil
    terminalView.updateUiClosed()
  }

  public override func layoutSubviews() {
    super.layoutSubviews()
    terminalView.frame = bounds
  }

  public func setSocketURL(_ value: String) {
    guard let nextURL = URL(string: value) else {
      emitStatus("Error", message: "Invalid terminal URL")
      return
    }
    guard nextURL != socketURL else { return }
    socketURL = nextURL
    intentionallyDisconnected = false
    openSocket(reconnecting: false)
  }

  public func setBackgroundColor(_ value: String?) {
    let color = UIColor(hex: value) ?? .black
    backgroundColor = color
    terminalView.nativeBackgroundColor = color
  }

  public func setForegroundColor(_ value: String?) {
    terminalView.nativeForegroundColor = UIColor(hex: value) ?? UIColor(white: 0.92, alpha: 1)
  }

  @discardableResult
  public func focusTerminal() -> Bool {
    terminalView.becomeFirstResponder()
  }

  @discardableResult
  public func copySelectionOrBuffer() -> Bool {
    if terminalView.selectionActive {
      terminalView.copy(nil)
      return true
    }
    terminalView.selectAll()
    terminalView.copy(nil)
    return true
  }

  @discardableResult
  public func pasteClipboard() -> Bool {
    guard UIPasteboard.general.hasStrings else { return false }
    terminalView.paste(nil)
    return true
  }

  @objc private func focusFromTap() {
    _ = focusTerminal()
  }

  private func openSocket(reconnecting: Bool) {
    guard let socketURL else { return }
    reconnectWorkItem?.cancel()
    reconnectWorkItem = nil
    socket?.cancel(with: .goingAway, reason: nil)
    receivedReady = false
    emitStatus(reconnecting ? "Reconnecting" : "Connecting")

    let nextSocket = URLSession.shared.webSocketTask(with: socketURL)
    socket = nextSocket
    nextSocket.resume()
    receiveNext(from: nextSocket)
  }

  private func receiveNext(from activeSocket: URLSessionWebSocketTask) {
    activeSocket.receive { [weak self, weak activeSocket] result in
      guard let self, let activeSocket else { return }
      DispatchQueue.main.async {
        guard self.socket === activeSocket else { return }
        switch result {
        case .success(let message):
          self.handle(message)
          self.receiveNext(from: activeSocket)
        case .failure(let error):
          self.handleSocketFailure(error)
        }
      }
    }
  }

  private func handle(_ message: URLSessionWebSocketTask.Message) {
    switch message {
    case .data(let data):
      terminalView.feed(byteArray: [UInt8](data)[...])
    case .string(let text):
      if !handleControlMessage(text) {
        terminalView.feed(text: text)
      }
    @unknown default:
      break
    }
  }

  private func handleControlMessage(_ text: String) -> Bool {
    guard let data = text.data(using: .utf8),
          let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let type = payload["type"] as? String else { return false }

    switch type {
    case "ready":
      receivedReady = true
      emitStatus("Connected", name: payload["name"] as? String)
      DispatchQueue.main.async { [weak self] in _ = self?.focusTerminal() }
    case "error":
      emitStatus("Error", message: payload["message"] as? String ?? "Terminal connection failed")
    default:
      break
    }
    return true
  }

  private func handleSocketFailure(_ error: Error) {
    guard !intentionallyDisconnected else { return }
    emitStatus(receivedReady ? "Reconnecting" : "Error", message: error.localizedDescription)
    scheduleReconnect()
  }

  private func scheduleReconnect() {
    guard reconnectWorkItem == nil, !intentionallyDisconnected else { return }
    let workItem = DispatchWorkItem { [weak self] in
      guard let self, !self.intentionallyDisconnected else { return }
      self.reconnectWorkItem = nil
      self.openSocket(reconnecting: true)
    }
    reconnectWorkItem = workItem
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.2, execute: workItem)
  }

  private func send(_ message: URLSessionWebSocketTask.Message) {
    guard let socket, socket.state == .running else { return }
    socket.send(message) { [weak self] error in
      guard let error else { return }
      DispatchQueue.main.async { self?.handleSocketFailure(error) }
    }
  }

  private func sendResize(columns: Int, rows: Int) {
    let payload: [String: Any] = [
      "type": "resize",
      "columns": max(1, columns),
      "rows": max(1, rows),
    ]
    guard let data = try? JSONSerialization.data(withJSONObject: payload),
          let text = String(data: data, encoding: .utf8) else { return }
    send(.string(text))
  }

  private func emitStatus(_ status: String, name: String? = nil, message: String? = nil) {
    var payload: [String: Any] = ["status": status]
    if let name { payload["name"] = name }
    if let message { payload["message"] = message }
    onStatus(payload)
  }
}

extension AgentsDockTerminalView: TerminalViewDelegate {
  public func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) {
    sendResize(columns: newCols, rows: newRows)
  }

  public func setTerminalTitle(source: TerminalView, title: String) {}
  public func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}

  public func send(source: TerminalView, data: ArraySlice<UInt8>) {
    send(.data(Data(data)))
  }

  public func scrolled(source: TerminalView, position: Double) {}

  public func requestOpenLink(source: TerminalView, link: String, params: [String: String]) {
    guard let url = URL(string: link) else { return }
    UIApplication.shared.open(url)
  }

  public func bell(source: TerminalView) {}

  public func clipboardCopy(source: TerminalView, content: Data) {
    UIPasteboard.general.string = String(data: content, encoding: .utf8)
  }

  public func clipboardRead(source: TerminalView) -> Data? {
    UIPasteboard.general.string?.data(using: .utf8)
  }

  public func iTermContent(source: TerminalView, content: ArraySlice<UInt8>) {}
  public func rangeChanged(source: TerminalView, startY: Int, endY: Int) {}
}

private extension UIColor {
  convenience init?(hex: String?) {
    guard var value = hex?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else {
      return nil
    }
    if value.hasPrefix("#") { value.removeFirst() }
    guard value.count == 6, let number = UInt64(value, radix: 16) else { return nil }
    self.init(
      red: CGFloat((number >> 16) & 0xff) / 255,
      green: CGFloat((number >> 8) & 0xff) / 255,
      blue: CGFloat(number & 0xff) / 255,
      alpha: 1
    )
  }
}
