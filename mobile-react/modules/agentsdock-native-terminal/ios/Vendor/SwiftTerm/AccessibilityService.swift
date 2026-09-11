import Foundation

// SwiftTerm's package target compiles this no-op accessibility shim on iOS
// from its Mac source folder. Keep the shim in the iOS vendor target while
// excluding the rest of the AppKit-only sources.
final class AccessibilityService {
  func invalidate() {}
}
