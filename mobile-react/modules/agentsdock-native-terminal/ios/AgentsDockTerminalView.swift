import ExpoModulesCore
import Foundation
import UIKit

private let defaultTerminalFontSize: CGFloat = 13
private let minimumTerminalFontSize: Double = 8
private let maximumTerminalFontSize: Double = 24

public final class AgentsDockTerminalView: ExpoView {
  private let terminalView = TerminalView(
    frame: .zero,
    font: UIFont.monospacedSystemFont(ofSize: defaultTerminalFontSize, weight: .regular)
  )
  private let onStatus = EventDispatcher()
  private var socket: URLSessionWebSocketTask?
  private var socketURL: URL?
  private var reconnectWorkItem: DispatchWorkItem?
  private var intentionallyDisconnected = false
  private var socketSuspended = true
  private var reconnectAttempt = 0
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
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(applicationWillResignActive),
      name: UIApplication.willResignActiveNotification,
      object: nil
    )
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(applicationDidBecomeActive),
      name: UIApplication.didBecomeActiveNotification,
      object: nil
    )
  }

  deinit {
    NotificationCenter.default.removeObserver(self)
    _ = blurTerminal()
    intentionallyDisconnected = true
    reconnectWorkItem?.cancel()
    let activeSocket = socket
    socket = nil
    activeSocket?.cancel(with: .goingAway, reason: nil)
    terminalView.terminalDelegate = nil
    terminalView.updateUiClosed()
  }

  public override func layoutSubviews() {
    super.layoutSubviews()
    terminalView.frame = bounds
  }

  public override func willMove(toWindow newWindow: UIWindow?) {
    if newWindow == nil {
      _ = blurTerminal()
      suspendSocket()
    }
    super.willMove(toWindow: newWindow)
  }

  public override func didMoveToWindow() {
    super.didMoveToWindow()
    if window != nil { resumeSocketIfPossible() }
  }

  public func setSocketURL(_ value: String) {
    guard let nextURL = URL(string: value) else {
      emitStatus("Error", message: "Invalid terminal URL")
      return
    }
    guard nextURL != socketURL else { return }
    socketURL = nextURL
    intentionallyDisconnected = false
    reconnectWorkItem?.cancel()
    reconnectWorkItem = nil
    let activeSocket = socket
    socket = nil
    activeSocket?.cancel(with: .goingAway, reason: nil)
    receivedReady = false
    reconnectAttempt = 0
    resumeSocketIfPossible()
  }

  public func setBackgroundColor(_ value: String?) {
    let color = UIColor(hex: value) ?? .black
    backgroundColor = color
    terminalView.nativeBackgroundColor = color
  }

  public func setForegroundColor(_ value: String?) {
    terminalView.nativeForegroundColor = UIColor(hex: value) ?? UIColor(white: 0.92, alpha: 1)
  }

  public func setFontSize(_ value: Double?) {
    let size: Double
    if let value, value.isFinite {
      size = min(max(value, minimumTerminalFontSize), maximumTerminalFontSize)
    } else {
      size = Double(defaultTerminalFontSize)
    }
    let pointSize = CGFloat(size)
    guard abs(terminalView.font.pointSize - pointSize) > 0.01 else { return }
    terminalView.font = UIFont.monospacedSystemFont(ofSize: pointSize, weight: .regular)
  }

  @discardableResult
  public func focusTerminal() -> Bool {
    guard window != nil,
          !isHidden,
          alpha > 0,
          UIApplication.shared.applicationState == .active else { return false }
    return terminalView.becomeFirstResponder()
  }

  @discardableResult
  public func blurTerminal() -> Bool {
    terminalView.resignFirstResponder()
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

  private func openSocket(reconnecting: Bool) {
    guard let socketURL, canUseSocket else {
      if !intentionallyDisconnected { emitStatus("Paused") }
      return
    }
    reconnectWorkItem?.cancel()
    reconnectWorkItem = nil
    let previousSocket = socket
    socket = nil
    previousSocket?.cancel(with: .goingAway, reason: nil)
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
      reconnectAttempt = 0
      emitStatus("Connected", name: payload["name"] as? String)
    case "error":
      emitStatus("Error", message: payload["message"] as? String ?? "Terminal connection failed")
    default:
      break
    }
    return true
  }

  private func handleSocketFailure(_ error: Error) {
    guard !intentionallyDisconnected else { return }
    guard canUseSocket else {
      suspendSocket()
      return
    }
    emitStatus(receivedReady ? "Reconnecting" : "Error", message: error.localizedDescription)
    scheduleReconnect()
  }

  private func scheduleReconnect() {
    guard reconnectWorkItem == nil, canUseSocket else { return }
    let delay = min(30, 1.2 * pow(2, Double(min(reconnectAttempt, 5))))
    reconnectAttempt += 1
    let workItem = DispatchWorkItem { [weak self] in
      guard let self else { return }
      self.reconnectWorkItem = nil
      guard self.canUseSocket else { return }
      self.openSocket(reconnecting: true)
    }
    reconnectWorkItem = workItem
    DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: workItem)
  }

  private func send(_ message: URLSessionWebSocketTask.Message) {
    guard let socket, socket.state == .running else { return }
    socket.send(message) { [weak self] error in
      guard let error else { return }
      DispatchQueue.main.async {
        guard let self, self.socket === socket else { return }
        self.handleSocketFailure(error)
      }
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

  @objc private func applicationWillResignActive(_ notification: Notification) {
    _ = blurTerminal()
    suspendSocket()
  }

  @objc private func applicationDidBecomeActive(_ notification: Notification) {
    resumeSocketIfPossible()
  }

  private var canUseSocket: Bool {
    !intentionallyDisconnected
      && !socketSuspended
      && window != nil
      && !isHidden
      && alpha > 0
      && UIApplication.shared.applicationState == .active
  }

  private func suspendSocket() {
    socketSuspended = true
    reconnectWorkItem?.cancel()
    reconnectWorkItem = nil
    let activeSocket = socket
    socket = nil
    activeSocket?.cancel(with: .goingAway, reason: nil)
    receivedReady = false
    reconnectAttempt = 0
    if socketURL != nil && !intentionallyDisconnected { emitStatus("Paused") }
  }

  private func resumeSocketIfPossible() {
    guard !intentionallyDisconnected,
          socketURL != nil,
          window != nil,
          !isHidden,
          alpha > 0,
          UIApplication.shared.applicationState == .active else { return }
    socketSuspended = false
    if socket == nil { openSocket(reconnecting: false) }
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
