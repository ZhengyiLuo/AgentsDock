import Foundation
@preconcurrency import UserNotifications

@MainActor
final class UnreadNotificationController: NSObject {
    static let shared = UnreadNotificationController()

    private let center = UNUserNotificationCenter.current()
    private var openSessionHandler: ((String) -> Void)?
    private var pendingSessionID: String?

    private override init() {
        super.init()
        center.delegate = self
    }

    func configure(openSession: @escaping (String) -> Void) {
        openSessionHandler = openSession
        if let pendingSessionID {
            self.pendingSessionID = nil
            openSession(pendingSessionID)
        }
    }

    func requestAuthorizationIfNeeded() {
        let center = center
        center.getNotificationSettings { settings in
            guard settings.authorizationStatus == .notDetermined else { return }
            center.requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
        }
    }

    func updateBadge(unreadCount: Int) {
        center.setBadgeCount(unreadCount) { _ in }
    }

    func notify(
        sessionID: String,
        title: String,
        backend: String,
        eventType: String?,
        eventSeq: Int,
        unreadCount: Int
    ) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = Self.notificationBody(backend: backend, eventType: eventType)
        content.sound = .default
        content.badge = NSNumber(value: unreadCount)
        content.threadIdentifier = sessionID
        content.userInfo = ["session_id": sessionID, "event_seq": eventSeq]

        let identifier = Self.notificationIdentifier(sessionID: sessionID)
        center.removePendingNotificationRequests(withIdentifiers: [identifier])
        center.add(UNNotificationRequest(identifier: identifier, content: content, trigger: nil)) { _ in }
    }

    func clear(sessionID: String) {
        let identifiers = [Self.notificationIdentifier(sessionID: sessionID)]
        center.removePendingNotificationRequests(withIdentifiers: identifiers)
        center.removeDeliveredNotifications(withIdentifiers: identifiers)
    }

    func clearAll() {
        center.removeAllPendingNotificationRequests()
        center.removeAllDeliveredNotifications()
    }

    private func open(sessionID: String) {
        if let openSessionHandler {
            openSessionHandler(sessionID)
        } else {
            pendingSessionID = sessionID
        }
    }

    private static func notificationIdentifier(sessionID: String) -> String {
        "agent-message-\(sessionID)"
    }

    private static func notificationBody(backend: String, eventType: String?) -> String {
        switch eventType {
        case "artifact_created":
            return "A new file or video is ready."
        case "error", "job_error":
            return "The agent reported an error."
        case "job_ran":
            return "A scheduled job posted an update."
        default:
            let name = backend.lowercased() == "claude" ? "Claude" : "Codex"
            return "\(name) posted a new response."
        }
    }
}

extension UnreadNotificationController: UNUserNotificationCenterDelegate {
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([])
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let sessionID = response.notification.request.content.userInfo["session_id"] as? String
        if let sessionID {
            Task { @MainActor in
                UnreadNotificationController.shared.open(sessionID: sessionID)
            }
        }
        completionHandler()
    }
}
