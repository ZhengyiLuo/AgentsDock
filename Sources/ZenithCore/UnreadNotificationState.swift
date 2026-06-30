import Foundation

public struct ZUnreadNotificationCandidate: Equatable, Sendable {
    public let sessionID: String
    public let title: String
    public let backend: String
    public let eventType: String?
    public let eventSeq: Int

    public init(
        sessionID: String,
        title: String,
        backend: String,
        eventType: String?,
        eventSeq: Int
    ) {
        self.sessionID = sessionID
        self.title = title
        self.backend = backend
        self.eventType = eventType
        self.eventSeq = eventSeq
    }
}

public struct ZUnreadNotificationTracker: Sendable {
    public private(set) var hasBaseline = false
    private var observedAgentSeqBySessionID: [String: Int] = [:]

    public init() {}

    public mutating func reset() {
        hasBaseline = false
        observedAgentSeqBySessionID = [:]
    }

    public mutating func reconcile(
        sessions: [ZSession],
        previousUnreadSessionIDs: Set<String>,
        unreadSessionIDs: Set<String>
    ) -> [ZUnreadNotificationCandidate] {
        let knownSessionIDs = Set(sessions.map(\.id))
        var nextObserved = observedAgentSeqBySessionID.filter { knownSessionIDs.contains($0.key) }

        guard hasBaseline else {
            for session in sessions {
                if let seq = session.latest_agent_event_seq {
                    nextObserved[session.id] = seq
                }
            }
            observedAgentSeqBySessionID = nextObserved
            hasBaseline = true
            return []
        }

        let newlyUnread = unreadSessionIDs.subtracting(previousUnreadSessionIDs)
        var candidates: [ZUnreadNotificationCandidate] = []
        for session in sessions {
            guard let seq = session.latest_agent_event_seq else { continue }
            let previousSeq = observedAgentSeqBySessionID[session.id] ?? 0
            nextObserved[session.id] = max(previousSeq, seq)
            guard newlyUnread.contains(session.id), seq > previousSeq else { continue }
            candidates.append(Self.candidate(session: session, eventType: session.latest_agent_event_type, seq: seq))
        }
        observedAgentSeqBySessionID = nextObserved
        return candidates
    }

    public mutating func observeLiveEvent(
        _ event: ZEvent,
        session: ZSession?,
        wasUnread: Bool
    ) -> ZUnreadNotificationCandidate? {
        let previousSeq = observedAgentSeqBySessionID[event.session_id] ?? 0
        observedAgentSeqBySessionID[event.session_id] = max(previousSeq, event.seq)
        guard hasBaseline, !wasUnread, event.seq > previousSeq else { return nil }

        return ZUnreadNotificationCandidate(
            sessionID: event.session_id,
            title: session?.title ?? "AgentsDock",
            backend: session?.backend ?? "codex",
            eventType: event.type,
            eventSeq: event.seq
        )
    }

    private static func candidate(session: ZSession, eventType: String?, seq: Int) -> ZUnreadNotificationCandidate {
        ZUnreadNotificationCandidate(
            sessionID: session.id,
            title: session.title,
            backend: session.backend,
            eventType: eventType,
            eventSeq: seq
        )
    }
}
