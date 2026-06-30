import Foundation

private let nativeScrollingRegressionScenarios = [
    (name: "stream-below-viewport", entryPoint: "checkStreamingBelowViewport"),
    (name: "height-change-above-viewport", entryPoint: "checkHeightChangeAboveViewport"),
    (name: "variable-height-containment", entryPoint: "checkVariableHeightContainment"),
    (name: "prepend-single-page", entryPoint: "checkPrependSinglePage"),
    (name: "active-momentum-priority", entryPoint: "checkActiveMomentumPriority"),
    (name: "chat-switch-isolation", entryPoint: "checkChatSwitchIsolation"),
]

private func sourceBlock(
    in source: String,
    from start: String,
    to end: String,
    failure: String
) throws -> Substring {
    guard let startRange = source.range(of: start),
          let endRange = source.range(
              of: end,
              range: startRange.upperBound..<source.endIndex
          ) else {
        throw GuardrailFailure.failed(failure)
    }
    return source[startRange.lowerBound..<endRange.lowerBound]
}

func checkAgentsDockScrollingRegressions() throws {
    let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
    let appKitTimeline = try String(
        contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/Views/AppKitTimelineTable.swift"),
        encoding: .utf8
    )
    let timeline = try String(
        contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/Views/TimelineView.swift"),
        encoding: .utf8
    )
    let macStore = try String(
        contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/State/AppStore.swift"),
        encoding: .utf8
    )

    let coordinatorUpdate = try sourceBlock(
        in: appKitTimeline,
        from: "        func update(\n            sessionID nextSessionID:",
        to: "        private func applyItems(",
        failure: "AppKit timeline coordinator update block not found"
    )
    try assert(
        coordinatorUpdate.contains("!sessionChanged") &&
            coordinatorUpdate.contains("? captureAnchor()") &&
            coordinatorUpdate.contains(": nil"),
        "Same-chat updates must capture the visible anchor, while chat switches must discard it"
    )
    try assert(
        coordinatorUpdate.contains("geometryChangesAffectAnchor") &&
            coordinatorUpdate.contains("else if shouldRestoreAnchor, let anchor"),
        "Passive updates must restore only when changed geometry can move the visible anchor"
    )

    try assert(
        appKitTimeline.contains("NSScrollView.willStartLiveScrollNotification") &&
            appKitTimeline.contains("NSScrollView.didEndLiveScrollNotification"),
        "Native scrolling must track the full live/momentum interval before honoring forced positioning"
    )

    let appKitPaging = try sourceBlock(
        in: timeline,
        from: "    private func loadOneOlderAppKitPage()",
        to: "#endif",
        failure: "AppKit older-history paging block not found"
    )
    try assert(
        appKitPaging.contains("appKitHistoryLoadInFlight = true"),
        "AppKit older-history paging must latch an in-flight load before starting work"
    )
    try assert(
        appKitPaging.contains("loadRevision == appKitHistoryLoadRevision") &&
            appKitPaging.contains("sessionID == store.selectedSessionID"),
        "Older-page completions must be scoped to both their load revision and chat"
    )
    try assert(
        !appKitPaging.contains("scrollToOlderPageTarget"),
        "Native prepends must preserve the table anchor instead of issuing a second scroll command"
    )
    try assert(
        appKitPaging.contains("guard !appKitHistoryLoadInFlight,"),
        "Repeated top-edge callbacks must not start a second older-page load"
    )

    let appKitReset = try sourceBlock(
        in: timeline,
        from: "    private func resetAppKitTimelineForSelectedSession()",
        to: "    private func initialTimelineMaskIsCurrent",
        failure: "AppKit chat-switch reset block not found"
    )
    try assert(
        appKitReset.contains("appKitHistoryLoadRevision &+= 1"),
        "Rapid chat switches must invalidate stale page completions"
    )
    try assert(
        appKitReset.contains("isInitialTimelineMasked = false") &&
            appKitReset.contains("maskedSessionID = nil") &&
            appKitReset.contains("hideTimelinePositioningOverlay()"),
        "The native timeline must clear SwiftUI mask ownership instead of starting a second loading cycle"
    )
    try assert(
        timeline.contains("let timelineRowsStructurallySuspended = false"),
        "The AppKit timeline must remain the sole owner of chat-switch positioning"
    )

    let olderHistoryLoad = try sourceBlock(
        in: macStore,
        from: "    func loadOlderHistory() async -> OlderHistoryLoadResult",
        to: "    func refreshSelectedFiles() async",
        failure: "Mac older-history load block not found"
    )
    let trimsOldestOverflow = olderHistoryLoad.contains("mergedEvents.removeFirst(overflow)")
    let admitsOnlyAvailableOlderEvents =
        olderHistoryLoad.contains("let acceptedOlder = Array(sortedOlder.suffix(availableCapacity))") &&
        olderHistoryLoad.contains("let previousTailSeq = events.map(\\.seq).max()") &&
        olderHistoryLoad.contains("let mergedEvents = (acceptedOlder + events).sorted")
    try assert(
        trimsOldestOverflow || admitsOnlyAvailableOlderEvents,
        "A bounded older-history merge must retain the existing newest tail"
    )
    try assert(
        !olderHistoryLoad.contains("mergedEvents.removeLast(overflow)"),
        "Loading older history must never evict the newest tail"
    )
    try assert(
        timeline.contains("return Array(source.suffix(budget))"),
        "Bounded timeline projection must render the newest event suffix"
    )
    try assert(
        macStore.contains("private let maxLoadedTimelineEvents") &&
            macStore.contains("private let maxCachedTimelineEvents"),
        "Loaded and cached timeline storage must remain explicitly bounded"
    )
    try assert(
        macStore.contains("events = Array(cachedEvents.suffix("),
        "Bounded chat-cache restoration must retain the newest event suffix"
    )

    let nativeHarness = try sourceBlock(
        in: appKitTimeline,
        from: "enum AppKitTimelineHarness",
        to: "enum AppKitTimelineIntegrationHarness",
        failure: "AppKit timeline native harness block not found"
    )
    for scenario in nativeScrollingRegressionScenarios {
        try assert(
            nativeHarness.contains("\"\(scenario.name)\""),
            "AppKitTimelineHarness must execute the \(scenario.name) scrolling regression"
        )
        try assert(
            nativeHarness.contains("private static func \(scenario.entryPoint)("),
            "AppKitTimelineHarness must expose \(scenario.entryPoint) for the \(scenario.name) regression"
        )
    }
    try assert(
        nativeHarness.contains("AppKitTimelineHarness passed scenario="),
        "Native scrolling regressions must emit machine-checkable per-scenario pass records"
    )
}
