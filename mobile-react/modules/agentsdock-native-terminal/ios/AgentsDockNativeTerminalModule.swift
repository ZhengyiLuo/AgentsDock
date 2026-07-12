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

      AsyncFunction("focus") { (view: AgentsDockTerminalView) in
        view.focusTerminal()
      }

      AsyncFunction("copy") { (view: AgentsDockTerminalView) in
        view.copySelectionOrBuffer()
      }

      AsyncFunction("paste") { (view: AgentsDockTerminalView) in
        view.pasteClipboard()
      }
    }
  }
}
