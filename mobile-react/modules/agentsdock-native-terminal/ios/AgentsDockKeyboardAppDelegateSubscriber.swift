import ExpoModulesCore
import UIKit

public final class AgentsDockKeyboardAppDelegateSubscriber: ExpoAppDelegateSubscriber {
  private var needsForegroundCleanup = false

  public func applicationWillResignActive(_ application: UIApplication) {
    // Run before scenes become inactive, while every modal/root window is
    // still discoverable. This covers both React Native inputs and SwiftTerm.
    needsForegroundCleanup = true
    endEditing(in: application)
  }

  public func applicationDidBecomeActive(_ application: UIApplication) {
    // UIKit can restore the previous first responder after activation. Only
    // repair real background/foreground transitions so cold-launch focus and
    // intentional modal focus remain untouched.
    guard needsForegroundCleanup else { return }
    needsForegroundCleanup = false
    endEditing(in: application)
    DispatchQueue.main.async { [weak self] in
      guard let self,
            application.applicationState == .active,
            !self.needsForegroundCleanup else { return }
      self.endEditing(in: application)
    }
  }

  private func endEditing(in application: UIApplication) {
    var windows = application.windows
    for case let windowScene as UIWindowScene in application.connectedScenes {
      for window in windowScene.windows {
        if !windows.contains(where: { $0 === window }) { windows.append(window) }
      }
    }
    for window in windows { _ = window.endEditing(true) }
  }
}
