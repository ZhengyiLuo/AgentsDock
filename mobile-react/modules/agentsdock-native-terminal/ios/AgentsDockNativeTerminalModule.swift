import ExpoModulesCore

public final class AgentsDockNativeTerminalModule: Module {
  public func definition() -> ModuleDefinition {
    Name("AgentsDockNativeTerminal")

    View(AgentsDockTerminalView.self) {
      Events("onStatus")

      Prop("socketURL") { (view: AgentsDockTerminalView, socketURL: String) in
        view.setSocketURL(socketURL)
      }

      Prop("backgroundHex") { (view: AgentsDockTerminalView, value: String?) in
        view.setBackgroundColor(value)
      }

      Prop("foregroundHex") { (view: AgentsDockTerminalView, value: String?) in
        view.setForegroundColor(value)
      }

      Prop("fontSize") { (view: AgentsDockTerminalView, value: Double?) in
        view.setFontSize(value)
      }

      AsyncFunction("focus") { (view: AgentsDockTerminalView) in
        view.focusTerminal()
      }.runOnQueue(.main)

      AsyncFunction("blur") { (view: AgentsDockTerminalView) in
        view.blurTerminal()
      }.runOnQueue(.main)

      AsyncFunction("copy") { (view: AgentsDockTerminalView) in
        view.copySelectionOrBuffer()
      }.runOnQueue(.main)

      AsyncFunction("paste") { (view: AgentsDockTerminalView) in
        view.pasteClipboard()
      }.runOnQueue(.main)
    }
  }
}
