import ExpoModulesCore

public final class AgentsDockNativeVideoModule: Module {
  public func definition() -> ModuleDefinition {
    Name("AgentsDockNativeVideo")

    View(AgentsDockNativeVideoView.self) {
      Events("onStatus")

      Prop("sourceURI") { (view: AgentsDockNativeVideoView, sourceURI: String) in
        view.setSourceURI(sourceURI)
      }

      Prop("autoplay") { (view: AgentsDockNativeVideoView, autoplay: Bool?) in
        view.setAutoplay(autoplay ?? true)
      }

      AsyncFunction("play") { (view: AgentsDockNativeVideoView) in
        view.play()
      }.runOnQueue(.main)

      AsyncFunction("pause") { (view: AgentsDockNativeVideoView) in
        view.pause()
      }.runOnQueue(.main)
    }
  }
}
