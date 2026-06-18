import Foundation
import ZenithCore

enum GuardrailFailure: Error, CustomStringConvertible {
    case failed(String)

    var description: String {
        switch self {
        case .failed(let message): message
        }
    }
}

func assert(_ condition: @autoclosure () -> Bool, _ message: String) throws {
    guard condition() else { throw GuardrailFailure.failed(message) }
}

func checkTextPresenceGateBehavior() throws {
    var gate = ZTextPresenceGate()

    try assert(gate.shouldPublish(""), "initial empty state should publish")
    try assert(!gate.shouldPublish(""), "repeated empty state must not publish")
    try assert(gate.shouldPublish("h"), "first non-empty character should publish")
    try assert(!gate.shouldPublish("he"), "continued typing must not publish")
    try assert(!gate.shouldPublish("hello"), "continued typing must not publish")
    try assert(gate.shouldPublish(""), "transition back to empty should publish")
    try assert(!gate.shouldPublish(""), "repeated empty state must not publish")

    gate.reset()
    try assert(gate.shouldPublish("reset"), "reset should allow initial state to publish again")
    try assert(!gate.shouldPublish("reset again"), "post-reset continued typing must not publish")
}

func checkComposerUsesPresenceGate() throws {
    let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
    let composerURL = cwd.appendingPathComponent("Sources/ZenithDock/Views/ComposerView.swift")
    let source = try String(contentsOf: composerURL, encoding: .utf8)

    try assert(source.contains("private var presenceGate = ZTextPresenceGate()"), "Composer coordinator must keep a ZTextPresenceGate")
    guard let guardRange = source.range(of: "guard presenceGate.shouldPublish(hasText: hasText) else { return }"),
          let callbackRange = source.range(of: "parent.onTextPresenceChange(hasText)") else {
        throw GuardrailFailure.failed("Composer publishPresence must gate SwiftUI callbacks")
    }
    try assert(guardRange.lowerBound < callbackRange.lowerBound, "Composer must gate text presence before calling SwiftUI")
    try assert(source.contains("private var promptHeight: CGFloat {\n        store.pendingQueuedTurns.isEmpty ? 58 : 44\n    }"), "Mac composer must use fixed editor heights instead of resizing while typing")
    try assert(!source.contains("let sendableText = value.trimmingCharacters"), "Composer must not trim the whole draft on every keystroke")
    try assert(!source.contains("hasSendableText(value)"), "Composer must not scan the whole draft for sendable text on every keystroke")
    try assert(!source.contains("value.split(separator: \"\\n\""), "Composer must not split the whole draft on every line-count update")
    try assert(!source.contains("scheduleVisibleLineCount"), "Composer must not schedule line-count work while typing")
    try assert(!source.contains("onVisibleLineCountChange"), "Composer must not publish line-count changes into SwiftUI while typing")
    try assert(!source.contains("pendingLineCount"), "Composer must not keep deferred line-count tasks")
    try assert(source.contains("submitRevision"), "Composer send button must submit native text without syncing draft text per keystroke")
    try assert(source.contains("textView.string = \"\"\n            parent.onDraftChange(\"\", parent.draftSessionID)"), "Composer submit must clear the native text view immediately after accepting a non-empty submit")
    try assert(!source.contains("scheduleSync"), "Composer must not schedule recurring full-draft SwiftUI sync while typing")
    try assert(!source.contains("parent.text ="), "Composer must not publish the full draft binding during normal typing")
    try assert(source.contains("allowsNonContiguousLayout = true"), "Composer text view should allow non-contiguous layout for long drafts")
    try assert(source.contains("pendingDraftWorkItem"), "Composer must debounce full-draft persistence instead of copying long drafts on every key")
    try assert(source.contains("scheduleDraftChange(textView)"), "Composer text changes must schedule draft persistence instead of synchronously copying the draft")
    try assert(source.contains("flushDraft(textView: textView, parent: previousParent)"), "Composer must flush drafts when switching chats")
    try assert(!source.contains("Voice input is not enabled") && !source.contains("Image(systemName: \"mic\")"), "Mac composer must not show a dead microphone control")
}

func checkComposerDraftPersistence() throws {
    let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
    let macStore = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/State/AppStore.swift"), encoding: .utf8)
    let mobileStore = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDockIOS/State/MobileAppStore.swift"), encoding: .utf8)
    let macComposer = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/Views/ComposerView.swift"), encoding: .utf8)
    let mobileComposer = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDockIOS/Views/MobileComposerView.swift"), encoding: .utf8)

    try assert(macStore.contains("private var draftPromptsBySessionID: [String: String] = [:]"), "Mac store must keep per-session composer drafts outside published state")
    try assert(mobileStore.contains("private var draftPromptsBySessionID: [String: String] = [:]"), "iOS store must keep per-session composer drafts")
    try assert(macStore.contains("\"ZenithDock.composerDrafts.\\(namespace)\""), "Mac composer drafts must be scoped by canonical server namespace")
    try assert(mobileStore.contains("\"ZenithDock.composerDrafts.\\(serverCacheNamespace)\""), "iOS composer drafts must be scoped by canonical server namespace")
    try assert(macStore.contains("func rememberDraftPrompt(_ text: String, for sessionID: String?)"), "Mac store must expose non-published draft save")
    try assert(mobileStore.contains("func rememberDraftPrompt(_ text: String, for sessionID: String?)"), "iOS store must expose draft save")
    try assert(macComposer.contains("restoreDraft(for: store.selectedSessionID)"), "Mac composer must restore the selected chat draft")
    try assert(mobileComposer.contains("restoreDraft(for: store.selectedSessionID)"), "iOS composer must restore the selected chat draft")
    try assert(macComposer.contains("onDraftChange: { text, sessionID in") && macComposer.contains("store.rememberDraftPrompt(text, for: sessionID)"), "Mac native text changes must save drafts without publishing the whole binding")
    try assert(mobileComposer.contains(".onChange(of: draftPrompt)") && mobileComposer.contains("store.rememberDraftPrompt(newValue, for: store.selectedSessionID)"), "iOS draft text changes must save the selected chat draft")
    try assert(macComposer.contains("store.clearDraftPrompt(for: sessionID)") && mobileComposer.contains("store.clearDraftPrompt(for: sessionID)"), "Submitted drafts must clear only the submitted session")
    try assert(macComposer.contains("store.sendPrompt(to: sessionID, prompt: submitted, fileIDs: uploadIDs)"), "Mac submit must send to the captured session instead of whatever is selected later")
    try assert(mobileComposer.contains("store.sendPrompt(to: sessionID, prompt: submitted, fileIDs: uploadIDs)"), "iOS submit must send to the captured session instead of whatever is selected later")
    try assert(macStore.contains("func clearUploadsIfCurrent(fileIDs: [String], for sessionID: String?)"), "Mac accepted submits must clear only the captured session's attachments")
    try assert(mobileStore.contains("func clearUploadsIfCurrent(fileIDs: [String], for sessionID: String?)"), "iOS accepted submits must clear only the captured session's attachments")
    try assert(!macComposer.contains(".onChange(of: store.selectedSessionID) {\n            draftPrompt = \"\""), "Mac chat switching must not wipe composer drafts")
    try assert(!mobileComposer.contains(".onChange(of: store.selectedSessionID) {\n            draftPrompt = \"\""), "iOS chat switching must not wipe composer drafts")
    try assert(!macComposer.contains("parent.text ="), "Mac native composer must still avoid publishing full draft text per keystroke")
}

func checkEndpointCacheKeysAreServerScoped() throws {
    let sessionID = "sess_same_after_copy"
    let fallback = "http://127.0.0.1:7850"
    let first = ZEndpointCache.key(serverURL: "http://100.88.206.6:7850", sessionID: sessionID, default: fallback)
    let second = ZEndpointCache.key(serverURL: "100.73.184.23:7850/api/health", sessionID: sessionID, default: fallback)
    let identity = ZEndpointCache.namespace(serverIdentity: "abc123")

    try assert(first != second, "cloned servers with the same session ID must not share chat cache keys")
    try assert(first.hasSuffix("|\(sessionID)"), "cache key should preserve session ID suffix")
    try assert(second == "http___100_73_184_23_7850|\(sessionID)", "cache key should normalize host and strip health path")
    try assert(identity == "server_abc123", "server identity namespaces must be stable and URL independent")

    let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
    let server = try String(contentsOf: cwd.appendingPathComponent("server/agent_server.py"), encoding: .utf8)
    let macStore = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/State/AppStore.swift"), encoding: .utf8)
    let mobileStore = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDockIOS/State/MobileAppStore.swift"), encoding: .utf8)
    try assert(server.contains("\"server_identity\": server_identity()"), "Health endpoint must expose a stable opaque server identity")
    try assert(macStore.contains("adoptServerIdentity(res.server_identity)"), "Mac app must adopt server identity from health")
    try assert(macStore.contains("migrateLocalServerState(from: oldNamespace, to: newNamespace)"), "Mac app must migrate URL-scoped local state to server-identity scoped state")
    try assert(mobileStore.contains("adoptServerIdentity(res.server_identity)"), "iOS app must adopt server identity from health")
}

func checkRuntimeDefaultLabels() throws {
    let catalog = ZRuntimeCatalogSnapshot(backends: [
        "codex": ZRuntimeBackendCatalog(
            models: [ZRuntimeOption(value: "gpt-5.5", label: "GPT-5.5")],
            efforts: [ZRuntimeOption(value: "xhigh", label: "XHigh")],
            default_model: "gpt-5.5",
            default_effort: "xhigh"
        )
    ])
    let sessionData = Data(#"{"id":"sess","title":"Chat","backend":"codex"}"#.utf8)
    let session = try JSONDecoder().decode(ZSession.self, from: sessionData)

    try assert(catalog.modelLabel(nil, backend: "codex") == "GPT-5.5", "model default label should show resolved model without server-default wording")
    try assert(catalog.effortLabel(nil, backend: "codex") == "XHigh", "effort default label should show resolved effort without server-default wording")
    try assert(catalog.compactSummary(for: session) == "Codex · GPT-5.5 · XHigh", "runtime summary should include resolved defaults without server-default wording")

    let fallbackCatalog = ZRuntimeCatalogSnapshot.fallback
    try assert(fallbackCatalog.models(for: "codex").contains { $0.value == "gpt-5.5" }, "Codex fallback catalog must include GPT-5.5 while server discovery is unavailable")
    try assert(fallbackCatalog.efforts(for: "codex").contains { $0.value == "xhigh" }, "Codex fallback catalog must include XHigh effort while server discovery is unavailable")
    try assert(fallbackCatalog.models(for: "claude").contains { $0.value == "claude-opus-4-8" && $0.label == "Opus 4.8" }, "Claude fallback catalog must include Opus 4.8")
    try assert(fallbackCatalog.models(for: "claude").contains { $0.value == "opus[1m]" && $0.label == "Opus 1M" }, "Claude fallback catalog must include Opus 1M")
    try assert(fallbackCatalog.models(for: "claude").contains { $0.value == "claude-opus-4-8[1m]" && $0.label == "Opus 4.8 1M" }, "Claude fallback catalog must include Opus 4.8 1M")

    let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
    let server = try String(contentsOf: cwd.appendingPathComponent("server/agent_server.py"), encoding: .utf8)
    let macStore = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/State/AppStore.swift"), encoding: .utf8)
    let mobileStore = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDockIOS/State/MobileAppStore.swift"), encoding: .utf8)
    try assert(server.contains("runtime_option(\"claude-opus-4-8\", \"Opus 4.8\")"), "Server runtime catalog must advertise Claude Opus 4.8")
    try assert(server.contains("runtime_option(\"opus[1m]\", \"Opus 1M\")"), "Server runtime catalog must advertise Claude Opus 1M")
    try assert(server.contains("runtime_option(\"claude-opus-4-8[1m]\", \"Opus 4.8 1M\")"), "Server runtime catalog must advertise Claude Opus 4.8 1M")
    try assert(server.contains("\"claude-opus-4-8[1m]\": \"Opus 4.8 1M\""), "Server default labels must render Claude Opus 4.8 1M cleanly")
    try assert(server.contains("discovered_codex_default_model") && server.contains("slug == \"gpt-5.5\""), "Server Codex catalog must prefer GPT-5.5 as the resolved default when present")
    try assert(server.contains("default_effort = \"xhigh\""), "Server Codex catalog must not regress GPT-5.5 default effort to medium")
    try assert(server.contains("cmd.extend([\"--model\", str(sess[\"model\"])])"), "Claude launcher must pass selected models with --model")
    try assert(server.contains("model_fields_set"), "Server turns must distinguish omitted runtime fields from explicit default resets")
    try assert(macStore.contains("pendingRuntimeBySessionID") && mobileStore.contains("pendingRuntimeBySessionID"), "Runtime saves must protect staged values from stale session responses")
    try assert(macStore.contains("sessionWithPendingRuntime(_ session: ZSession)") && mobileStore.contains("sessionWithPendingRuntime(_ session: ZSession)"), "Server session merges must preserve pending runtime selections")
    try assert(macStore.contains("pendingRuntimePatchTimeout") && mobileStore.contains("pendingRuntimePatchTimeout"), "Pending runtime overrides must expire so stale local state cannot mask server truth")
    try assert(macStore.contains("pending.clearConfirmed(by: session)") && mobileStore.contains("pending.clearConfirmed(by: session)"), "Pending runtime overrides must reconcile when session refresh confirms server state")
    try assert(macStore.contains("let runtimeModel = selectedSession?.model ?? \"\"") && mobileStore.contains("let runtimeModel = selectedSession?.model ?? \"\""), "User sends must capture the selected runtime before any auto-title/session updates")
    try assert(macStore.contains("model: runtimeModel") && mobileStore.contains("model: runtimeModel"), "Turn requests must carry the captured runtime so a quick send cannot revert to defaults")
    try assert(!macStore.contains("await updateSelected(title: String(firstLine.prefix(72)))"), "Mac send path must not await title saves before posting the turn")
    let composer = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/Views/ComposerView.swift"), encoding: .utf8)
    let mobileTimeline = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDockIOS/Views/MobileTimelineView.swift"), encoding: .utf8)
    try assert(composer.contains("store.stageSelectedRuntime(model: cleanModel)") && composer.contains("applyOptimistic: false"), "Mac runtime menu must stage model changes synchronously before async save")
    try assert(mobileTimeline.contains("store.stageSelectedRuntime(model: newValue)") && mobileTimeline.contains("applyOptimistic: false"), "iOS runtime menu must stage model changes synchronously before async save")
    let inspector = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/Views/InspectorView.swift"), encoding: .utf8)
    let mobileOptions = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDockIOS/Views/MobileChatOptionsView.swift"), encoding: .utf8)
    try assert(inspector.contains("runtimeDraftSessionID") && mobileOptions.contains("runtimeDraftSessionID"), "Runtime draft controls must remember the in-flight session")
    try assert(inspector.contains("guard !shouldPreserveRuntimeDraft(for: session?.id) else { return }"), "Mac inspector must not overwrite in-flight runtime picker drafts from stale session refreshes")
    try assert(mobileOptions.contains("guard !shouldPreserveRuntimeDraft(for: session.id) else { return }"), "iOS options must not overwrite in-flight runtime picker drafts from stale session refreshes")
    try assert(inspector.contains("backendRuntimeBinding") && mobileOptions.contains("backendRuntimeBinding"), "Runtime picker saves must be user-initiated bindings, not draft-sync onChange handlers")
    try assert(!inspector.contains(".onChange(of: backend)") && !mobileOptions.contains(".onChange(of: backend)"), "Runtime draft sync must not trigger backend autosave and reset selected models")
    try assert(composer.contains("await store.updateSession(sessionID, model: cleanModel, applyOptimistic: false)") && composer.contains("await store.updateSession(sessionID, effort: cleanEffort, applyOptimistic: false)"), "Mac composer runtime saves must target the captured session ID so chat switching cannot revert or misroute them")
    try assert(inspector.contains("await store.updateSession(") && inspector.contains("clearRuntimeSaveIndicator()"), "Mac inspector runtime saves must keep persisting against the captured session when switching chats")
    try assert(mobileTimeline.contains("await store.updateSession(sessionID, model: newValue, applyOptimistic: false)") && mobileOptions.contains("await store.updateSession("), "iOS runtime saves must target captured session IDs instead of the current selection")
}

func checkBackendLocksAfterProviderStart() throws {
    let activeSessionData = Data(#"{"id":"sess","title":"Chat","backend":"codex","codex_thread_id":"019e"}"#.utf8)
    let activeSession = try JSONDecoder().decode(ZSession.self, from: activeSessionData)
    let emptySessionData = Data(#"{"id":"new","title":"Chat","backend":"codex"}"#.utf8)
    let emptySession = try JSONDecoder().decode(ZSession.self, from: emptySessionData)
    let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
    let server = try String(contentsOf: cwd.appendingPathComponent("server/agent_server.py"), encoding: .utf8)
    let composer = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/Views/ComposerView.swift"), encoding: .utf8)
    let inspector = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/Views/InspectorView.swift"), encoding: .utf8)
    let mobileOptions = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDockIOS/Views/MobileChatOptionsView.swift"), encoding: .utf8)
    let mobileTimeline = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDockIOS/Views/MobileTimelineView.swift"), encoding: .utf8)

    try assert(activeSession.isBackendLocked, "Provider-backed sessions must lock backend switching")
    try assert(!emptySession.isBackendLocked, "New sessions without provider IDs must allow backend selection")
    try assert(server.contains("session_backend_locked(sess)"), "Server must enforce backend lock")
    try assert(server.contains("status_code=409"), "Backend lock violation should return a conflict")
    try assert(composer.contains("if session.isBackendLocked"), "Mac composer backend picker must switch to a read-only chip after chat starts")
    try assert(!composer.contains(".disabled(session.isBackendLocked)"), "Mac composer backend chip must not dim the icon when locked")
    try assert(inspector.contains(".disabled(session.isBackendLocked)"), "Mac inspector backend picker must disable after chat starts")
    try assert(mobileOptions.contains(".disabled(session.isBackendLocked)"), "iOS options backend picker must disable after chat starts")
    try assert(mobileTimeline.contains(".disabled(session.isBackendLocked)"), "iOS timeline backend picker must disable after chat starts")
}

func checkClaudeResumeFailureDoesNotPoisonSession() throws {
    let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
    let server = try String(contentsOf: cwd.appendingPathComponent("server/agent_server.py"), encoding: .utf8)

    try assert(server.contains("def claude_result_error(event: dict[str, Any]) -> str | None:"), "Server must classify Claude result failures before saving resume IDs")
    try assert(server.contains("event.get(\"subtype\") == \"error_during_execution\""), "Claude error_during_execution results must be treated as failed resumes")
    try assert(server.contains("result_error = claude_result_error(event)"), "Claude runner must inspect result events for provider errors")
    try assert(server.contains("provider_id = None\n                    await append_event(session_id, \"error\""), "Claude failed-result session IDs must be discarded and surfaced as errors")
    try assert(server.contains("if provider_id and not result_error:"), "Claude provider session must only save after a successful result")
    try assert(server.contains("Avoid Markdown heading markers like `#`, `##`, or `###`"), "Claude prompt should avoid noisy Markdown heading markers")
    try assert(server.contains("run `git diff --stat`") && server.contains("bounded unified diff"), "Claude prompt should require bounded diff traces after code edits")
    try assert(server.contains("def resolve_claude_resume_provider(sess: dict[str, Any], cwd: str)"), "Server must verify Claude resume IDs against the current cwd before launching")
    try assert(server.contains("claude_resume_file_for_cwd(provider_id, cwd)"), "Claude resume preflight must check the cwd-scoped transcript file")
    try assert(server.contains("resume_provider_id, resume_skip_message = resolve_claude_resume_provider(sess, cwd)"), "Claude launches must use the cwd-scoped resume preflight")
    try assert(server.contains("cwd=cwd"), "Saved Claude provider sessions must remember their launch cwd")
    try assert(!server.contains("provider_id = event[\"session_id\"]\n                await STORE.save_provider_session(session_id, provider_id, BACKEND_CLAUDE)"), "Claude streamed session IDs must not be saved before the result succeeds")
    try assert(server.contains("def codex_result_error(event: dict[str, Any]) -> str | None:"), "Server must classify Codex JSON error and turn.failed events")
    try assert(server.contains("event_type == \"turn.failed\""), "Codex turn.failed events must be surfaced as visible errors")
    try assert(server.contains("cmd.extend([\"--disable\", \"image_generation\"])"), "Server-launched Codex turns must disable the currently broken image_generation tool")
    try assert(server.contains("Codex exited {proc.returncode} without error output."), "Codex nonzero exits without stderr must still show a visible error")
}

func checkServerURLNormalization() throws {
    let fallback = "http://127.0.0.1:7850"

    try assert(
        ZenithServerURL.normalized("100.73.184.23:7850/api/health", default: fallback) == "http://100.73.184.23:7850",
        "health endpoint paste should normalize to server root"
    )
    try assert(
        ZenithServerURL.normalized("http://100.73.184.23:7850/", default: fallback) == "http://100.73.184.23:7850",
        "trailing slash should be stripped"
    )
}

func checkShellCopyNormalization() throws {
    let input = "python train.py \\\\\n  --checkpoint_path \"$MODEL\" \\\\\n  --port 6666"
    let expected = "python train.py \\\n  --checkpoint_path \"$MODEL\" \\\n  --port 6666"
    let normalized = ZClipboardText.normalizedForCopy(input, language: "bash")

    try assert(normalized == expected, "shell copy should collapse accidental double continuations")
    try assert(
        ZClipboardText.normalizedForCopy("\\begin{tabular}\\\\", language: nil) == "\\begin{tabular}\\\\",
        "LaTeX-looking text should not be normalized as shell"
    )
}

func checkCodeBlockCopyUsesFullText() throws {
    let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
    let markdown = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/Views/Components/MarkdownView.swift"), encoding: .utf8)
    let macEvents = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/Views/EventViews.swift"), encoding: .utf8)
    let mobileEvents = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDockIOS/Views/MobileEventViews.swift"), encoding: .utf8)

    try assert(markdown.contains("var copyMarkdown: String?"), "Mac MarkdownView should accept untrimmed markdown for copy actions")
    try assert(markdown.contains("copyCodeBlocks"), "Mac MarkdownView should parse copy-only code blocks from the full message")
    try assert(markdown.contains("CodeBlock(text: block.text, copySource: copyCodeText(for: block)"), "Mac code blocks inside folded messages must copy the full source block")
    try assert(markdown.contains("private var visibleDisplayText"), "Mac code block should keep a separate visible display string")
    try assert(markdown.contains("private var copyText"), "Mac code block should keep a separate full copy string")
    try assert(markdown.contains("ZClipboardText.normalizedForCopy(copySource ?? text, language: language)"), "Mac code block copy must use the full backing text")
    try assert(markdown.contains("copyToPasteboard(copyText)"), "Mac code block copy button/context menu must copy the full backing text")
    try assert(markdown.contains("CodeHighlighter.highlight(visibleDisplayText"), "Mac code block rendering should still use the visible truncated display text")
    try assert(macEvents.contains("copyMarkdown: text"), "Mac folded message bubbles must pass full text into MarkdownView copy actions")
    try assert(mobileEvents.contains("var copyMarkdown: String?"), "iOS MarkdownView should accept untrimmed markdown for copy actions")
    try assert(mobileEvents.contains("MobileCodeBlock(text: block.text, copySource: copyCodeText(for: block)"), "iOS code blocks inside folded messages must copy the full source block")
    try assert(mobileEvents.contains("ZClipboardText.normalizedForCopy(copySource ?? text, language: language)"), "iOS code block copy must use the full backing text")
    try assert(mobileEvents.contains("MobileMarkdownView(markdown: visibleText, copyMarkdown: text"), "iOS folded message bubbles must pass full text into markdown copy actions")
}

func checkMessageFoldingThresholds() throws {
    let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
    let macEvents = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/Views/EventViews.swift"), encoding: .utf8)
    let macMarkdown = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/Views/Components/MarkdownView.swift"), encoding: .utf8)
    let mobileEvents = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDockIOS/Views/MobileEventViews.swift"), encoding: .utf8)

    try assert(macEvents.contains("isContextDigest ? 1_800 : 4_200"), "Mac message folding character limits should allow 1.5x more text before folding")
    try assert(macEvents.contains("isContextDigest ? 18 : 48"), "Mac message folding line limits should allow 1.5x more lines before folding")
    try assert(mobileEvents.contains("isContextDigest ? 1_350 : 1_800"), "iOS message folding character limits should allow 1.5x more text before folding")
    try assert(mobileEvents.contains("isContextDigest ? 15 : 18"), "iOS message folding line limits should allow 1.5x more lines before folding")
    try assert(macEvents.contains("@State private var fullTextExpanded"), "Mac folded messages must expand full text inline")
    try assert(mobileEvents.contains("@State private var fullTextExpanded"), "iOS folded messages must expand full text inline")
    try assert(macEvents.contains("Button(fullTextExpanded ? \"Collapse\" : \"Open full text\")"), "Mac Open full text action must toggle inline expansion")
    try assert(mobileEvents.contains("Button(fullTextExpanded ? \"Collapse\" : \"Full text\")"), "iOS Full text action must toggle inline expansion")
    try assert(macEvents.contains("allowTruncation: !fullTextExpanded"), "Mac expanded messages must bypass MarkdownView UI truncation")
    try assert(macMarkdown.contains("var allowTruncation = true"), "Mac MarkdownView must expose an explicit truncation toggle")
    try assert(macMarkdown.contains("guard allowTruncation else { return text }"), "Mac MarkdownView must render complete expanded text without the trim marker")
    try assert(!macEvents.contains("@State private var fullTextOpen"), "Mac folded messages must not open full text in a sheet")
    try assert(!mobileEvents.contains("@State private var fullTextOpen"), "iOS folded messages must not open full text in a sheet")
}

func checkTimelineMessageTimestamps() throws {
    let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
    let macEvents = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/Views/EventViews.swift"), encoding: .utf8)
    let mobileEvents = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDockIOS/Views/MobileEventViews.swift"), encoding: .utf8)

    try assert(macEvents.contains("lhs.event.ts == rhs.event.ts"), "Mac event card equality must include timestamp updates")
    try assert(macEvents.contains("private var messageTimestamp: String?"), "Mac event cards must derive a message timestamp")
    try assert(macEvents.contains("localTimestampString(event.ts)"), "Mac event timestamps must use local time formatting")
    try assert(macEvents.contains("var timestamp: String?"), "Mac message bubbles must accept a timestamp")
    try assert(macEvents.contains("Text(timestamp)\n                        .font(.caption.monospacedDigit())"), "Mac message bubbles must render timestamps in the header")
    try assert(macEvents.contains("localTimestampString(jobRun.finishedAt ?? jobRun.lastEventAt ?? jobRun.runEvent.ts)"), "Mac job run bubbles must show the latest update time")
    try assert(mobileEvents.contains("private var messageTimestamp: String?"), "iOS event cards must derive a message timestamp")
    try assert(mobileEvents.contains("mobileMessageTimestampString(event.ts)"), "iOS event timestamps must use local time formatting")
    try assert(mobileEvents.contains("var timestamp: String?"), "iOS message bubbles must accept a timestamp")
    try assert(mobileEvents.contains("MobileSystemCard(\n                icon: \"clock.badge.checkmark\""), "iOS job system cards must pass timestamps through")
    try assert(mobileEvents.contains("mobileMessageTimestampString(jobRun.finishedAt ?? jobRun.lastEventAt ?? jobRun.runEvent.ts)"), "iOS job run bubbles must show the latest update time")
}

func checkArchiveSessionBehavior() throws {
    let sessionData = Data(#"{"id":"sess","title":"Archived","backend":"codex","archived":true,"sort_order":10}"#.utf8)
    let session = try JSONDecoder().decode(ZSession.self, from: sessionData)
    try assert(session.archived == true, "ZSession must decode archived session state")
    try assert(session.sort_order == 10, "ZSession must decode stable manual sidebar order")

    let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
    let macStore = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/State/AppStore.swift"), encoding: .utf8)
    let mobileStore = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDockIOS/State/MobileAppStore.swift"), encoding: .utf8)
    let macSidebar = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/Views/SidebarView.swift"), encoding: .utf8)
    let mobileSidebar = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDockIOS/Views/MobileSidebarView.swift"), encoding: .utf8)
    let macDigest = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/Views/SessionManagementSheets.swift"), encoding: .utf8)
    let mobileDigest = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDockIOS/Views/MobileChatOptionsView.swift"), encoding: .utf8)
    let server = try String(contentsOf: cwd.appendingPathComponent("server/agent_server.py"), encoding: .utf8)

    try assert(macStore.contains("sessions.filter { $0.archived != true }"), "Mac active session lists must filter archived chats")
    try assert(mobileStore.contains("sessions.filter { $0.archived != true }"), "iOS active session lists must filter archived chats")
    try assert(!macSidebar.contains("pieces.append(\"archived\")"), "Mac sidebar archived rows must not repeat archived in every subtitle")
    try assert(!mobileSidebar.contains("pieces.append(\"archived\")"), "iOS sidebar archived rows must not repeat archived in every subtitle")
    try assert(macStore.contains("orderedSessions("), "Mac session rows must use stable explicit ordering")
    try assert(mobileStore.contains("orderedSessions("), "iOS session rows must use stable explicit ordering")
    try assert(macStore.contains("func reorderSession("), "Mac app must expose manual session reorder")
    try assert(mobileStore.contains("func reorderSession("), "iOS app must expose manual session reorder")
    try assert(macSidebar.contains("@State private var reorderMode"), "Mac sidebar must expose explicit reorder mode")
    try assert(mobileSidebar.contains("@State private var reorderMode"), "iOS sidebar must expose explicit reorder mode")
    try assert(macSidebar.contains("guard !reorderMode else { return }"), "Mac sidebar must suppress chat selection while reordering")
    try assert(macSidebar.contains("SidebarFolderDragHandleNSView") && macSidebar.contains("beginDraggingSession"), "Mac sidebar reorder mode must use a native draggable folder handle")
    try assert(macSidebar.contains(".onDrop"), "Mac sidebar reorder mode must expose drop targets")
    try assert(macSidebar.contains("SidebarSessionDropDelegate"), "Mac sidebar reorder mode must make chat rows draggable")
    try assert(macSidebar.contains("handleSessionDrop"), "Mac sidebar must reorder chats by drag/drop in reorder mode")
    try assert(macStore.contains("func reorderSession(_ session: ZSession, relativeTo target: ZSession"), "Mac store must send chat drops through server reorder calls")
    try assert(macStore.contains("let target_id: String") && macStore.contains("body: Body(target_id: target.id, placement: placement)"), "Mac chat drag/drop reorder must send a single target placement request")
    try assert(!macStore.contains("for _ in 0..<abs(destination - sourceIndex)"), "Mac chat drag/drop reorder must not animate through repeated up/down swaps")
    try assert(macStore.contains("canReorderSession(_ session: ZSession, relativeTo target: ZSession)"), "Mac sidebar must guard chat drops to compatible sections")
    try assert(macSidebar.contains("handleFolderDrop"), "Mac sidebar must reorder folders by drag/drop in reorder mode")
    try assert(macSidebar.contains("withoutSidebarAnimation"), "Mac sidebar drag reorder must suppress implicit list animations")
    try assert(macSidebar.contains("store.reorderFolders(from: IndexSet(integer: sourceIndex), to: destination)"), "Mac folder drag reorder must apply one final order update instead of stepwise swaps")
    try assert(macSidebar.contains("SidebarInsertionRule"), "Mac sidebar drag reorder must show an insertion indicator")
    try assert(macSidebar.contains("SidebarDropPlacement"), "Mac sidebar drag reorder must distinguish before/after placement")
    try assert(macSidebar.contains("sidebarDragPayload"), "Mac sidebar drag reorder must track the active drag payload")
    try assert(macSidebar.contains("clearSidebarDragState"), "Mac sidebar drag reorder must explicitly clear drag state")
    try assert(macSidebar.contains("guard let activeDragPayload else { return false }"), "Mac sidebar insertion indicators must be gated by active drag state")
    try assert(mobileSidebar.contains(".onMove"), "iOS sidebar must support drag reorder")
    try assert(macDigest.contains("store.digestTargetSections(excluding: sourceSession.id)"), "Mac digest sheet must render target chats in sidebar sections")
    try assert(mobileDigest.contains("store.digestTargetSections(excluding: sourceSession.id)"), "iOS digest sheet must render target chats in sidebar sections")
    try assert(macDigest.contains("Section(section.title)") && mobileDigest.contains("Section(section.title)"), "Digest target pickers must preserve sidebar section labels")
    try assert(macStore.contains("func digestTargetSections(excluding sourceSessionID: String) -> [DigestTargetSection]"), "Mac digest targets must use a sectioned sidebar source")
    try assert(mobileStore.contains("func digestTargetSections(excluding sourceSessionID: String) -> [DigestTargetSection]"), "iOS digest targets must use a sectioned sidebar source")
    try assert(!macStore.contains("sidebarOrderedActiveSessions") && !mobileStore.contains("sidebarOrderedActiveSessions"), "Digest targets must not use a hidden flat sidebar-order helper")
    try assert(macStore.contains("for folder in folderNames") && mobileStore.contains("for folder in folderNames"), "Digest target ordering must respect manual folder order")
    try assert(macSidebar.contains("Task { await store.fork(session) }") && macSidebar.contains("Label(\"Fork Chat\", systemImage: \"arrow.triangle.branch\")"), "Mac sidebar row context menu must expose Fork Chat for the clicked row")
    try assert(mobileSidebar.contains("Task { await store.fork(session) }") && mobileSidebar.contains("Label(\"Fork Chat\", systemImage: \"arrow.triangle.branch\")"), "iOS sidebar row context menu must expose Fork Chat for the pressed row")
    guard let macForkRange = macStore.range(of: "func forkSelected() async"),
          let macDigestRange = macStore.range(of: "func createHandoffDigest", range: macForkRange.upperBound..<macStore.endIndex),
          let mobileForkRange = mobileStore.range(of: "func forkSelected() async"),
          let mobileDigestRange = mobileStore.range(of: "func createHandoffDigest", range: mobileForkRange.upperBound..<mobileStore.endIndex) else {
        throw GuardrailFailure.failed("Mac and iOS stores must keep identifiable forkSelected boundaries")
    }
    let macForkBody = macStore[macForkRange.lowerBound..<macDigestRange.lowerBound]
    let mobileForkBody = mobileStore[mobileForkRange.lowerBound..<mobileDigestRange.lowerBound]
    try assert(macForkBody.contains("let sessions: [ZSession]?") && macForkBody.contains("if let authoritativeSessions = res.sessions"), "Mac forks must prefer the server's authoritative sidebar order")
    try assert(mobileForkBody.contains("let sessions: [ZSession]?") && mobileForkBody.contains("if let authoritativeSessions = res.sessions"), "iOS forks must prefer the server's authoritative sidebar order")
    try assert(macForkBody.contains("insertForkedSession(res.session, after: sid)"), "Mac forks must still fall back to local beside-parent insertion for older servers")
    try assert(mobileForkBody.contains("insertForkedSession(res.session, after: sid)"), "iOS forks must still fall back to local beside-parent insertion for older servers")
    try assert(!macForkBody.contains("sessions.insert(res.session, at: 0)"), "Mac forks must not jump to the top of the sidebar")
    try assert(!mobileForkBody.contains("sessions.insert(res.session, at: 0)"), "iOS forks must not jump to the top of the sidebar")
    try assert(server.contains("archived: bool | None = None"), "Server session update API must accept archived state")
    try assert(server.contains("\"archived\", \"archived_at\", \"sort_order\""), "Server public sessions must expose archived state and stable order")
    try assert(server.contains("def sorted_sessions("), "Server session list must use explicit sort_order instead of updated_at recency")
    try assert(server.contains("@app.post(\"/api/sessions/{session_id}/order\")"), "Server must expose manual session reorder endpoint")
    try assert(server.contains("target_id: str | None = None") && server.contains("placement: str | None = None"), "Server reorder endpoint must accept target placement for drag/drop")
    try assert(server.contains("reordered = peers[:insert_index] + [sess] + peers[insert_index:]"), "Server drag/drop reorder must compute one final order")
    try assert(server.contains("req.direction, req.target_id, req.placement"), "Server reorder route must pass target placement to the store")
    try assert(server.contains("pinned=bool(parent.get(\"pinned\"))") && server.contains("archived=bool(parent.get(\"archived\"))"), "Server forks must preserve parent sidebar section metadata")
    try assert(server.contains("ordered_sessions = await STORE.reorder(child[\"id\"], target_id=session_id, placement=\"after\")"), "Server forks must place the child directly after the parent")
    try assert(server.contains("\"sessions\": [public_session(sess) for sess in ordered_sessions]"), "Server fork response must return authoritative sidebar order")
}

func checkFolderSectionControls() throws {
    let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
    let macStore = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/State/AppStore.swift"), encoding: .utf8)
    let mobileStore = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDockIOS/State/MobileAppStore.swift"), encoding: .utf8)
    let macSidebar = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/Views/SidebarView.swift"), encoding: .utf8)
    let mobileSidebar = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDockIOS/Views/MobileSidebarView.swift"), encoding: .utf8)

    try assert(macStore.contains("folderOrder"), "Mac store must persist manual folder order")
    try assert(macStore.contains("collapsedFolders"), "Mac store must persist collapsed folder state")
    try assert(macStore.contains("archivedSectionCollapsed"), "Mac store must persist archived section collapse state")
    try assert(macStore.contains("func moveFolder("), "Mac store must expose folder move controls")
    try assert(macStore.contains("func reorderFolders("), "Mac store must expose drag folder reorder")
    try assert(macStore.contains("func toggleFolderCollapsed"), "Mac store must expose folder collapse controls")
    try assert(macStore.contains("func toggleArchivedSectionCollapsed"), "Mac store must expose archived section collapse controls")
    try assert(mobileStore.contains("folderOrder"), "iOS store must persist manual folder order")
    try assert(mobileStore.contains("collapsedFolders"), "iOS store must persist collapsed folder state")
    try assert(mobileStore.contains("archivedSectionCollapsed"), "iOS store must persist archived section collapse state")
    try assert(mobileStore.contains("func moveFolder("), "iOS store must expose folder move controls")
    try assert(mobileStore.contains("func reorderFolders("), "iOS store must expose drag folder reorder")
    try assert(mobileStore.contains("func toggleArchivedSectionCollapsed"), "iOS store must expose archived section collapse controls")
    try assert(macSidebar.contains("FolderSectionHeader"), "Mac sidebar must render custom folder section headers")
    try assert(macSidebar.contains("ArchivedSectionHeader"), "Mac sidebar must render a collapsible archived section header")
    try assert(macSidebar.contains("Label(reorderMode ? \"Done\" : \"Reorder\""), "Mac sidebar must expose a reorder toggle")
    try assert(macSidebar.contains("Collapse Folder"), "Mac folder header must expose collapse")
    try assert(mobileSidebar.contains("MobileFolderSectionHeader"), "iOS sidebar must render custom folder section headers")
    try assert(mobileSidebar.contains("MobileArchivedSectionHeader"), "iOS sidebar must render a collapsible archived section header")
    try assert(mobileSidebar.contains("Button(reorderMode ? \"Done\" : \"Reorder\")"), "iOS sidebar must expose a reorder toggle")
}

func checkMobileDoesNotAutoSelectFirstChat() throws {
    let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
    let mobileStore = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDockIOS/State/MobileAppStore.swift"), encoding: .utf8)
    let mobileSidebar = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDockIOS/Views/MobileSidebarView.swift"), encoding: .utf8)
    let mobileRoot = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDockIOS/Views/MobileRootView.swift"), encoding: .utf8)

    try assert(!mobileStore.contains("selectedSessionID = sessions.first?.id"), "iOS refresh must not auto-open the first chat")
    try assert(!mobileStore.contains("if let next = sessions.first"), "iOS delete flow must not auto-open the next first chat")
    try assert(mobileStore.contains("private func clearSelection()"), "iOS store must have an explicit clear-selection path")
    try assert(mobileStore.contains("if let selectedSessionID, !sessions.contains"), "iOS refresh should only clear a stale selection")
    try assert(mobileSidebar.contains("List(selection: sessionSelection)"), "iOS sidebar selection must route through store.select so warm cache can apply before publishing selection")
    try assert(!mobileSidebar.contains("List(selection: $store.selectedSessionID)"), "iOS sidebar must not publish selectedSessionID directly before cached rows are ready")
    try assert(!mobileRoot.contains(".onChange(of: store.selectedSessionID)"), "iOS root must not run a second store.select after sidebar/store selection already started")
    guard let cacheRange = mobileStore.range(of: "if let cached = memoryCachedChat(sessionID)"),
          let selectedRange = mobileStore.range(of: "selectedSessionID = sessionID", range: cacheRange.upperBound..<mobileStore.endIndex) else {
        throw GuardrailFailure.failed("iOS session select must prepare cached rows before publishing selectedSessionID")
    }
    try assert(cacheRange.lowerBound < selectedRange.lowerBound, "iOS session select must apply cached rows before publishing selectedSessionID")
}

func checkTimelineRevealWaitsForLatestSnapshot() throws {
    let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
    let macStore = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/State/AppStore.swift"), encoding: .utf8)
    let mobileStore = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDockIOS/State/MobileAppStore.swift"), encoding: .utf8)
    let timeline = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/Views/TimelineView.swift"), encoding: .utf8)
    let sidebar = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/Views/SidebarView.swift"), encoding: .utf8)
    let root = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/Views/RootView.swift"), encoding: .utf8)
    let inspector = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/Views/InspectorView.swift"), encoding: .utf8)
    let eventViews = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/Views/EventViews.swift"), encoding: .utf8)
    let mobileTimeline = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDockIOS/Views/MobileTimelineView.swift"), encoding: .utf8)
    let server = try String(contentsOf: cwd.appendingPathComponent("server/agent_server.py"), encoding: .utf8)

    try assert(macStore.contains("@Published var isSelectingSession = false"), "Mac store must publish session selection/loading state")
    try assert(macStore.contains("@Published var isRefreshingCachedDelta = false"), "Mac store must publish warm-cache delta refresh state")
    try assert(macStore.contains("isSelectingSession = true"), "Mac session select must mark the latest snapshot as loading")
    try assert(macStore.contains("private let maxMemoryCachedChats = 32"), "Mac store must keep enough warm chats to avoid recent-chat spinner regressions")
    try assert(macStore.contains("rememberSelectedChatInMemory()"), "Mac store must snapshot the current chat before switching away")
    guard let warmCacheRange = macStore.range(of: "let warmCachedChat = memoryCachedChat(sessionID)"),
          let selectedRange = macStore.range(of: "selectedSessionID = sessionID", range: warmCacheRange.upperBound..<macStore.endIndex) else {
        throw GuardrailFailure.failed("Mac session select must prepare warm cache before publishing selectedSessionID")
    }
    try assert(warmCacheRange.lowerBound < selectedRange.lowerBound, "Mac session select must apply warm cache before publishing selectedSessionID")
    try assert(timeline.contains("hasWarmSelectedTimeline"), "Mac timeline must reveal warm selected-chat cache while the latest snapshot refreshes")
    try assert(timeline.contains("isInitialTimelineMasked = store.selectedSessionID != nil && !hasWarmSelectedTimeline"), "Mac timeline must not show the opening mask for warm selected-chat cache")
    try assert(timeline.contains("if hasWarmSelectedTimeline {"), "Mac timeline must drop the opening mask immediately when warm cache becomes available")
    try assert(timeline.contains("guard !store.isSelectingSession || hasWarmSelectedTimeline else { return }"), "Mac timeline must not keep the opening mask up when selected-chat cache is already renderable")
    try assert(sidebar.contains("List(selection: sessionSelection)"), "Mac sidebar selection must route through store.select so warm cache can apply before publishing selection")
    try assert(!sidebar.contains("List(selection: $store.selectedSessionID)"), "Mac sidebar must not publish selectedSessionID directly before warm cache is applied")
    try assert(!root.contains(".onChange(of: store.selectedSessionID)"), "Mac root must not run a second store.select after sidebar/store selection already started")
    try assert(timeline.contains(".onChange(of: store.isSelectingSession)"), "Timeline must retry reveal when the latest snapshot load finishes")
    try assert(timeline.contains("settleBottomAfterLayout(proxy, sessionID: store.selectedSessionID)"), "Timeline thread switches must settle bottom position after SwiftUI lays out new rows")
    try assert(timeline.contains("guard store.selectedSessionID == sessionID else { return }"), "Delayed timeline bottom settles must be scoped to the selected session")
    try assert(timeline.contains("@State private var pendingOpenBottomSessionID"), "Mac timeline must remember that newly opened chats should land at the latest message")
    try assert(timeline.contains("pendingOpenBottomSessionID = store.selectedSessionID"), "Mac timeline must arm latest-message positioning on thread open")
    try assert(timeline.contains("private func settleOpenThreadAtLatest"), "Mac timeline must centralize newly opened thread latest-position settling")
    try assert(timeline.contains("pendingOpenBottomSessionID = nil\n        suppressHistoryLoading(for: 2.4)"), "Mac timeline must consume the open-position request once rows are actually renderable")
    try assert(macStore.contains("@Published var forcedScrollToBottomRevision"), "Mac store must separate forced open/reopen bottom scrolls from ordinary live scroll requests")
    try assert(timeline.contains(".onChange(of: store.forcedScrollToBottomRevision)"), "Mac timeline must always honor forced open/reopen bottom scroll requests")
    try assert(timeline.contains("private func forceOpenThreadToLatest"), "Mac timeline must force open/reopen positioning independent of near-bottom state")
    try assert(timeline.contains("pendingOpenBottomSessionID = sessionID\n        suppressHistoryLoading(for: 2.4)\n        disarmAutomaticOlderHistoryLoad()\n        visibleRowLimit = defaultVisibleRowLimit\n        guard canSettleOpenThreadRows else"), "Forced latest-position requests must stay pending while large timeline batches are masked")
    try assert(timeline.contains("forceBottomRevision: store.forcedScrollToBottomRevision"), "Mac timeline must pass forced open/reopen bottom requests into the NSScrollView observer")
    guard let openSettleRange = timeline.range(of: "private func settleOpenThreadAtLatest"),
          let forceSettleRange = timeline.range(of: "private func forceOpenThreadToLatest", range: openSettleRange.upperBound..<timeline.endIndex) else {
        throw GuardrailFailure.failed("Mac timeline must keep explicit open/force latest settle helpers")
    }
    let openSettleBlock = timeline[openSettleRange.lowerBound..<forceSettleRange.lowerBound]
    guard let openScrollRange = openSettleBlock.range(of: "scrollToBottom(proxy)"),
          let openUnmaskRange = openSettleBlock.range(of: "isInitialTimelineMasked = false") else {
        throw GuardrailFailure.failed("Mac open settle must scroll and clear the initial mask")
    }
    try assert(openScrollRange.lowerBound < openUnmaskRange.lowerBound, "Mac chat open must scroll to bottom before revealing masked timeline rows")
    guard let initialMaskCheckRange = timeline.range(of: "private func initialTimelineMaskIsCurrent", range: forceSettleRange.upperBound..<timeline.endIndex) else {
        throw GuardrailFailure.failed("Mac timeline must keep initialTimelineMaskIsCurrent after force settle")
    }
    let forceSettleBlock = timeline[forceSettleRange.lowerBound..<initialMaskCheckRange.lowerBound]
    guard let forceScrollRange = forceSettleBlock.range(of: "scrollToBottom(proxy)"),
          let forceUnmaskRange = forceSettleBlock.range(of: "isInitialTimelineMasked = false") else {
        throw GuardrailFailure.failed("Mac forced settle must scroll and clear the initial mask")
    }
    try assert(forceScrollRange.lowerBound < forceUnmaskRange.lowerBound, "Mac forced latest settle must scroll before revealing masked timeline rows")
    try assert(timeline.contains("for delay in [0.04, 0.14, 0.28]"), "Mac timeline bottom settling must avoid late visible scroll nudges")
    try assert(!timeline.contains("0.75, 1.25"), "Mac timeline bottom settling must not include late visible nudge passes")
    try assert(timeline.contains("clipView.scroll(to: target)"), "Forced open/reopen bottom positioning must use the underlying NSScrollView document geometry")
    try assert(timeline.contains("scrollView.verticalScrollElasticity = .none"), "Mac timeline must disable rubber-band overscroll on the underlying NSScrollView")
    try assert(timeline.contains("let zeroInsets = NSEdgeInsets(top: 0, left: 0, bottom: 0, right: 0)"), "Mac timeline must define explicit zero AppKit insets")
    try assert(timeline.contains("scrollView.contentInsets = zeroInsets"), "Mac timeline must not allow AppKit content insets to create bottom overscroll slack")
    try assert(!timeline.contains(".padding(.bottom, 56)"), "Mac timeline content must not add artificial bottom scroll slack")
    try assert(!timeline.contains(".padding(20)"), "Mac timeline content must not apply symmetric padding that creates bottom scroll slack")
    try assert(timeline.contains(".padding(.horizontal, 20)\n                        .padding(.top, 20)"), "Mac timeline content should keep side/top padding without bottom padding")
    try assert(timeline.contains("clampAttachedScrollViewIfNeeded()"), "Mac timeline must clamp the underlying NSScrollView immediately on attach and bounds changes")
    try assert(timeline.contains("installClampingClipViewIfNeeded"), "Mac timeline must install an NSClipView that rejects overscroll bounds")
    try assert(timeline.contains("private final class TimelineClampingClipView: NSClipView"), "Mac timeline must use a custom clamping clip view")
    try assert(timeline.contains("override func constrainBoundsRect"), "Mac timeline clip view must clamp proposed scroll bounds")
    try assert(timeline.contains("clampDocumentOriginIfNeeded(scrollView, documentView: documentView)"), "Mac timeline must clamp scroll origins before reporting metrics")
    try assert(timeline.contains("forceBottomUntil = Date().addingTimeInterval"), "Forced open/reopen bottom positioning must persist only during layout settling")
    try assert(inspector.contains("private struct JobFormLabel"), "Mac job sheets must use fixed-width one-line labels")
    try assert(inspector.contains("private struct JobFormRow"), "Mac job sheets must use fixed-label form rows instead of compressible grids")
    try assert(inspector.contains("JobFormRow(title: \"Mode\")"), "Mac job mode label must not wrap vertically")
    try assert(timeline.contains("let timelineRowsSuspended = isInitialTimelineMasked && !hasWarmSelectedTimeline"), "Mac timeline should structurally suspend cold opens when no selected-chat cache can be rendered")
    try assert(macStore.contains("@Published var isApplyingLargeTimelineBatch = false"), "Mac store must publish a large-batch timeline mask")
    try assert(macStore.contains("private let largeTimelineBatchEventThreshold = 80"), "Mac store must define a threshold for large timeline batch masking")
    try assert(macStore.contains("private let largeTimelineBatchCharacterThreshold = 14_000"), "Mac store must mask same-event huge text expansion, not only event-count changes")
    try assert(macStore.contains("beginLargeTimelineBatchMask()"), "Mac store must mask large session snapshots and stream bursts before applying them")
    try assert(macStore.contains("if !hasRenderableSelectedTimeline {\n            setStatus(\"Opening latest messages\")"), "Mac cached-chat tail refreshes must not show the opening spinner when a renderable timeline is already visible")
    try assert(macStore.contains("scheduleLargeTimelineBatchReveal()"), "Mac store must reveal large timeline batches after layout settles")
    try assert(macStore.contains("oldTextWeight: oldTextWeight"), "Mac cached-tail masking must compare rendered text weight before applying a snapshot")
    try assert(macStore.contains("timelineDisplayWeight(makeDisplayEvents(from: projectedEvents))"), "Mac cached-tail masking must catch trimmed-cache to full-text expansion")
    try assert(timeline.contains("let shouldHideLargeTimelineBatch = store.isApplyingLargeTimelineBatch"), "Mac timeline must hide rows while a heavy snapshot is applied, including warm-cache text expansion")
    try assert(timeline.contains("let timelineRowsStructurallySuspended = timelineRowsSuspended || shouldHideLargeTimelineBatch"), "Mac timeline must structurally suspend cold rows for large sync batches")
    try assert(timeline.contains("let shouldMaskTimeline = timelineRowsStructurallySuspended"), "Mac cached refresh state must not mask an already-rendered timeline")
    try assert(timeline.contains("showTimelinePositioningOverlay"), "Mac timeline opening overlay must be gated separately from the fast structural mask")
    try assert(timeline.contains("timelinePositioningOverlayDelayNanos"), "Mac timeline opening overlay must be delayed so fast cache hits do not flicker a spinner")
    try assert(timeline.contains("if shouldMaskTimeline, store.selectedSession != nil, showTimelinePositioningOverlay"), "Mac timeline must not show the opening spinner immediately whenever rows are structurally masked")
    try assert(timeline.contains("updateTimelinePositioningOverlay(masked: shouldMaskTimeline)"), "Mac timeline must coalesce opening spinner visibility from the current mask state")
    try assert(timeline.contains("hideTimelinePositioningOverlay()"), "Mac timeline must clear stale opening spinners when switching chats")
    try assert(timeline.contains(".onChange(of: store.isApplyingLargeTimelineBatch)"), "Mac timeline must retry latest-position settling after the large-batch mask drops")
    try assert(timeline.contains("timelineRowsStructurallySuspended ? [] : store.displayEvents"), "Mac timeline must not build rows while a large sync batch is masked")
    try assert(timeline.contains("let projectedDisplayEvents = timelineProjectionEvents(from: displayEvents, visibleLimit: visibleRowLimit)"), "Mac timeline must project only the currently visible event budget while keeping loaded history in store")
    try assert(timeline.contains("projectionEventsPerVisibleRow"), "Mac timeline projection budget must expand as the visible row budget expands")
    try assert(timeline.contains("private let defaultVisibleRowLimit = 64"), "Mac timeline must keep the default rendered row window small enough for smooth scrolling")
    try assert(timeline.contains("private let projectionBaseEventLimit = 300"), "Mac timeline event projection must avoid rebuilding too many hidden events while scrolling")
    try assert(eventViews.contains("TraceGroupSummaryCache") && eventViews.contains("TraceChangeSummary.extract(from: events)"), "Mac collapsed trace summaries must be cached instead of reparsed during scroll layout")
    try assert(timeline.contains("hasHiddenProjectedEvents(visibleLimit: oldLimit)"), "Mac show-older must reveal locally loaded projected events before asking the server")
    try assert(timeline.contains("TimelineRows.build(from: timelineProjectionEvents(from: store.displayEvents"), "Mac helper row builds must use the same bounded projection path")
    try assert(macStore.contains("private let maxWarmCachedTimelineEvents = 240"), "Mac warm-cache chat switches must render only a small recent tail")
    try assert(macStore.contains("private(set) var events: [ZEvent] = []"), "Mac raw event storage must not be @Published; displayEvents is the timeline publication boundary")
    try assert(macStore.contains("private let streamFlushDelayNanos"), "Mac websocket stream updates must be coalesced before publishing timeline changes")
    try assert(macStore.contains("applyCachedChat(warmCachedChat, renderLimit: maxWarmCachedTimelineEvents)"), "Mac memory-cache chat switches must apply only the warm recent tail")
    try assert(macStore.contains("applyCachedChat(cached, renderLimit: maxWarmCachedTimelineEvents)"), "Mac duplicate-selection memory restores must apply only the warm recent tail")
    try assert(macStore.contains("let cachedLastSeq = lastSeq"), "Mac warm-cache chat switches must capture cached lastSeq before catch-up")
    try assert(macStore.contains("cachedTailIsKnownFresh(sessionID: sessionID, cachedLastSeq: cachedLastSeq)"), "Mac warm-cache chat switches must skip REST tail refresh when the session list already proves the cache is fresh")
    try assert(macStore.contains("private let cachedTailFreshnessWindow"), "Mac cached-tail skip must have a bounded freshness window")
    try assert(macStore.contains("let loadedAt = Date()") && macStore.contains("lastLoadedAt = loadedAt"), "Mac session-list freshness must update on every successful /api/sessions response")
    try assert(macStore.contains("guard let sessionListLoadedAt = lastLoadedAt"), "Mac cached-tail skip must require a recent server session list")
    try assert(!macStore.contains("?? memoryCachedChat(sessionID)?.session.latest_event_seq"), "Mac cached-tail freshness must not be proven by the same local chat cache")
    try assert(!macStore.contains("connectEvents(sessionID: sessionID, after: cachedLastSeq)"), "Mac warm-cache chat switches must not replay the whole websocket gap before refreshing the latest tail")
    try assert(macStore.contains("refreshCachedSessionLatestTail"), "Mac warm-cache chat switches must refresh the server latest tail")
    try assert(!macStore.contains("Refreshing latest chat"), "Mac warm-cache chat switches must not present background tail refresh as foreground loading")
    try assert(macStore.contains("URLQueryItem(name: \"tail\", value: \"true\")"), "Mac cached chat refresh must request the latest tail window")
    try assert(macStore.contains("URLQueryItem(name: \"visible\", value: \"true\")"), "Mac session history fetches must page displayable events instead of raw trace noise")
    try assert(macStore.contains("applySessionEventSnapshot(res, sessionID: sessionID, preserveExisting: true)"), "Mac cached chat refresh must merge the server latest tail without dropping loaded older pages")
    try assert(macStore.contains("connectEvents(sessionID: sessionID, after: lastSeq)"), "Mac warm-cache chat switches must connect live streaming only after the latest tail is applied")
    try assert(macStore.contains("isRefreshingCachedDelta = true"), "Mac cached chat refresh must still mark its background refresh state")
    try assert(macStore.contains("let newSnapshotEventCount = preserveExisting"), "Mac cached tail refresh must count only actually new events for large-batch masking")
    try assert(macStore.contains("incomingCount: newSnapshotEventCount"), "Mac no-op latest-tail refreshes must not trigger large-batch timeline masking")
    try assert(macStore.contains("newSnapshotEventCount == 0") && macStore.contains("return false"), "Mac no-op cached tail refreshes must skip timeline rebuilds")
    try assert(macStore.contains("guard !newEvents.isEmpty else"), "Mac event merge must skip timeline rebuilds when catch-up returns duplicate/no-op events")
    guard let memorySnapshotRange = macStore.range(of: "private func rememberSelectedChatInMemory()"),
          let diskSnapshotRange = macStore.range(of: "private func saveSelectedChatCache()", range: memorySnapshotRange.upperBound..<macStore.endIndex) else {
        throw GuardrailFailure.failed("Mac store must keep memory and disk chat-cache paths separate")
    }
    try assert(!macStore[memorySnapshotRange.lowerBound..<diskSnapshotRange.lowerBound].contains("sanitizedForCache"), "Mac memory cache snapshot must not sanitize/copy large text while switching chats")
    try assert(macStore.contains("Task.detached(priority: .utility)"), "Mac disk cache sanitization must run off the main actor")
    try assert(macStore.contains("Self.sanitizedForCache($0, maxCharacters: maxCharacters)"), "Mac disk cache writes must sanitize large text inside the detached task")
    guard let applyCacheRange = macStore.range(of: "private func applyCachedChat"),
          let refreshFilesRange = macStore.range(of: "private func refreshSessionFilesFromLoadedEvents", range: applyCacheRange.upperBound..<macStore.endIndex) else {
        throw GuardrailFailure.failed("Mac store must keep applyCachedChat isolated for sidebar-order checks")
    }
    try assert(!macStore[applyCacheRange.lowerBound..<refreshFilesRange.lowerBound].contains("sessions[idx] = cached.session"), "Mac cached chat application must not replace existing sidebar metadata")
    try assert(mobileTimeline.contains("store.isLoading && store.selectedSessionID != nil && store.displayEvents.isEmpty"), "iOS timeline must reveal small cached selected-chat rows while refreshing")
    try assert(mobileTimeline.contains("timelineRowsSuspended ? [] : store.displayEvents"), "iOS timeline must structurally suspend row rendering for cold opens and heavy snapshots")
    try assert(mobileStore.contains("@Published var isApplyingLargeTimelineBatch = false"), "iOS store must publish a large-batch timeline mask")
    try assert(mobileStore.contains("private let largeTimelineBatchEventThreshold = 80"), "iOS store must define a threshold for large timeline batch masking")
    try assert(mobileStore.contains("private let largeTimelineBatchCharacterThreshold = 14_000"), "iOS store must mask same-event huge text expansion, not only event-count changes")
    try assert(mobileStore.contains("beginLargeTimelineBatchMaskIfNeeded"), "iOS store must mask heavy session snapshots before publishing rows")
    try assert(mobileStore.contains("timelineDisplayWeight(makeDisplayEvents(from: snapshotEvents))"), "iOS snapshot masking must catch trimmed-cache to full-text expansion")
    try assert(mobileTimeline.contains("let timelineRowsSuspended = coldOpenRowsSuspended || (store.isApplyingLargeTimelineBatch && store.selectedSessionID != nil)"), "iOS timeline must structurally suspend cold large batches instead of showing a text fly-by")
    try assert(mobileTimeline.contains("@State private var isOpeningTimelineMasked"), "iOS timeline must keep newly opened chats visually hidden until bottom positioning settles")
    try assert(mobileTimeline.contains("guard !isOpeningTimelineMasked,\n              !store.isApplyingLargeTimelineBatch,\n              !store.isLoading else"), "iOS top-edge history autoload must be disabled while opening or applying a large batch")
    try assert(mobileTimeline.contains(".opacity(isOpeningTimelineMasked && !displayEvents.isEmpty ? 0 : 1)"), "iOS opening mask must hide rows until latest-position scroll is settled")
    try assert(mobileTimeline.contains("MobileTimelinePositioningOverlay"), "iOS opening mask must show a small positioning overlay instead of flying text")
    try assert(mobileStore.contains("@Published private(set) var displayEvents: [ZEvent] = []"), "iOS store must publish filtered display events instead of recomputing them in the timeline body")
    try assert(mobileStore.contains("private(set) var events: [ZEvent] = []"), "iOS raw event storage must not publish directly into the whole UI")
    try assert(mobileStore.contains("private func rebuildDisplayEvents()"), "iOS store must rebuild display events only when raw events change")
    try assert(mobileStore.contains("URLQueryItem(name: \"visible\", value: \"true\")"), "iOS session history fetches must page displayable events instead of raw trace noise")
    try assert(mobileStore.contains("for _ in 0..<8") && mobileStore.contains("remainingOmitted = res.events_omitted_before ?? 0"), "iOS older-history fetches must skip invisible-only pages")
    try assert(mobileStore.contains("isPrimaryTimelinePageEvent"), "iOS older-history paging must keep walking past trace-only visible pages")
    try assert(mobileStore.contains("struct OlderHistoryLoadResult"), "iOS older-history loading must return target metadata, not only a count")
    try assert(mobileStore.contains("firstAddedEventID"), "iOS older-history loading must track the first newly added event for stable scroll targeting")
    try assert(mobileTimeline.contains("olderPageRevealLimit(oldLimit:"), "iOS local Show Older must expand past trace-only rendered pages")
    try assert(mobileTimeline.contains("isPrimaryPageRow"), "iOS timeline rows must identify primary conversation rows for older-page targeting")
    try assert(mobileTimeline.contains("revealOlderRowsShowingNewPage(proxy)"), "iOS explicit Show Older must visibly move to the newly revealed rendered page")
    try assert(mobileTimeline.contains("loadOlderHistoryShowingNewPage"), "iOS explicit Load Older must visibly move to the newly loaded older page")
    try assert(mobileTimeline.contains("olderHistoryTarget(firstAddedEventID: result.firstAddedEventID"), "iOS Load Older must target the first newly loaded event")
    try assert(mobileTimeline.contains("scrollToOlderPageTarget"), "iOS older-page navigation must share delayed scroll settling")
    try assert(mobileTimeline.contains("func containsEventID(_ eventID: String)"), "iOS grouped timeline rows must retain source event IDs for deterministic scroll targeting")
    try assert(mobileTimeline.contains("@State private var pendingOpenBottomSessionID"), "iOS timeline must remember that newly opened chats should land at the latest message")
    try assert(mobileTimeline.contains("private func scrollToBottom(_ proxy: ScrollViewProxy, animated: Bool = false)"), "iOS timeline bottom positioning must default to a non-animated jump")
    try assert(mobileTimeline.contains("scrollToBottom(proxy, animated: true)"), "iOS explicit bottom button may animate, but open-chat positioning must not fly through history")
    try assert(mobileTimeline.contains("MobileTimelineViewportHeightPreferenceKey") && mobileTimeline.contains("MobileTimelineBottomPreferenceKey"), "iOS bottom button visibility must use measured scroll geometry")
    try assert(mobileTimeline.contains("private func updateBottomStateFromGeometry()"), "iOS bottom button state must be derived from distance to the viewport bottom")
    try assert(mobileTimeline.contains("if maxY == nil && !displayEvents.isEmpty"), "iOS bottom button must show when LazyVStack stops instantiating the bottom marker")
    try assert(!mobileTimeline.contains(".onAppear { isAtBottom = true }") && !mobileTimeline.contains(".onDisappear { isAtBottom = false }"), "iOS bottom button must not rely on lazy bottom marker appearance")
    try assert(mobileTimeline.contains("settleBottomAfterExplicitScroll(proxy)"), "iOS explicit bottom button scrolls must settle after lazy layout and keyboard inset changes")
    try assert(mobileTimeline.contains("withTransaction(noAnimationTransaction)"), "iOS non-animated bottom jumps must disable SwiftUI animation")
    guard let mobileSelectRange = mobileStore.range(of: "func select(sessionID: String) async"),
          let mobileLoadOlderRange = mobileStore.range(of: "@discardableResult\n    func loadOlderHistory()", range: mobileSelectRange.upperBound..<mobileStore.endIndex) else {
        throw GuardrailFailure.failed("iOS store must keep an identifiable select/session history boundary")
    }
    try assert(!mobileStore[mobileSelectRange.lowerBound..<mobileLoadOlderRange.lowerBound].contains("scrollRevision += 1"), "iOS chat open must not fire the send-style bottom scroll revision after loading history")
    try assert(!macStore.contains("URLQueryItem(name: \"tail\", value: \"false\")"), "Mac chat open must not request a non-tail catch-up page")
    try assert(!mobileStore.contains("URLQueryItem(name: \"tail\", value: \"false\")"), "iOS chat open must not request a non-tail catch-up page")
    try assert(server.contains("API_CONTRACT_VERSION = 4"), "Server visible-history paging is a v4 API contract")
    try assert(server.contains("visible: bool = False") && server.contains("is_visible_timeline_event"), "Server session endpoint must support visible timeline event paging")
    try assert(server.contains("read_visible_events_page(") && server.contains("visible_count - len(events)"), "Server visible-history paging must report visible omitted counts, not raw seq gaps")
}

func checkConnectionFailuresDoNotModal() throws {
    let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
    let server = try String(contentsOf: cwd.appendingPathComponent("server/agent_server.py"), encoding: .utf8)
    let macStore = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/State/AppStore.swift"), encoding: .utf8)
    let mobileStore = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDockIOS/State/MobileAppStore.swift"), encoding: .utf8)

    try assert(macStore.contains("@Published var connectionProblemText: String?"), "Mac store must keep connection failures as inline state")
    try assert(macStore.contains("if isConnectionError(error)"), "Mac network failures must be separated from blocking alerts")
    try assert(macStore.contains("connectionProblemText = message"), "Mac connection failure should populate inline connection text")
    try assert(macStore.contains("} else {\n            return\n        }"), "Mac refresh should not keep loading sessions/jobs after health is offline")
    try assert(server.contains("\"api_contract_version\": API_CONTRACT_VERSION"), "Server health must expose API contract version")
    try assert(macStore.contains("minimumAgentAPIContractVersion"), "Mac app must define a minimum server API contract")
    try assert(macStore.contains("markServerUpgradeRequired(version:"), "Mac app must show server-upgrade-required state")
    try assert(mobileStore.contains("minimumAgentAPIContractVersion"), "iOS app must define a minimum server API contract")
    try assert(mobileStore.contains("markServerUpgradeRequired(version:"), "iOS app must show server-upgrade-required state")
}

func checkLaunchDeferredIsInline() throws {
    let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
    let server = try String(contentsOf: cwd.appendingPathComponent("server/agent_server.py"), encoding: .utf8)
    let macStore = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/State/AppStore.swift"), encoding: .utf8)
    let mobileStore = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDockIOS/State/MobileAppStore.swift"), encoding: .utf8)
    let macTimeline = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/Views/TimelineView.swift"), encoding: .utf8)
    let mobileTimeline = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDockIOS/Views/MobileTimelineView.swift"), encoding: .utf8)

    try assert(server.contains("ZENITHBOT_MAX_ACTIVE_AGENT_RUNS\", \"10\""), "Server default manual-agent concurrency cap should be 10")
    try assert(macStore.contains("@Published var launchDeferredText: String?"), "Mac store must keep launch-deferred state separate from modal errors")
    try assert(macStore.contains("isAgentLaunchDeferred(error, message: message)"), "Mac store must classify launch-deferred API responses")
    try assert(macStore.contains("launchDeferredText = message"), "Mac launch-deferred responses must become inline status")
    try assert(macStore.contains("setStatus(\"Launch deferred\")"), "Mac launch-deferred responses must update run status")
    try assert(macStore.contains("clearLaunchDeferredIfResolved(by: event)"), "Mac selected-chat turn events must clear stale launch-deferred banners")
    try assert(macStore.contains("launchDeferredText != nil") && macStore.contains("\"turn_started\", \"assistant_text\", \"turn_finished\", \"error\", \"turn_stopped\""), "Mac launch-deferred clearing must be scoped to real turn activity")
    try assert(macStore.contains("apiErrorDetail"), "Mac API errors should unwrap JSON detail strings")
    try assert(macTimeline.contains("store.launchDeferredText"), "Mac timeline header must render launch-deferred state inline")
    try assert(mobileStore.contains("@Published var launchDeferredText: String?"), "iOS store must keep launch-deferred state separate from modal errors")
    try assert(mobileStore.contains("isAgentLaunchDeferred(error, message: message)"), "iOS store must classify launch-deferred API responses")
    try assert(mobileStore.contains("setStatus(\"Launch deferred\")"), "iOS launch-deferred responses must update run status")
    try assert(mobileStore.contains("clearLaunchDeferredIfResolved(by: event)"), "iOS selected-chat turn events must clear stale launch-deferred banners")
    try assert(mobileTimeline.contains("store.launchDeferredText"), "iOS timeline header must render launch-deferred state inline")
}

func checkVideoMetadataIsNotHiddenByMixedFilePaging() throws {
    let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
    let macStore = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/State/AppStore.swift"), encoding: .utf8)
    let inspector = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/Views/InspectorView.swift"), encoding: .utf8)
    let eventViews = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/Views/EventViews.swift"), encoding: .utf8)
    let mobileEvents = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDockIOS/Views/MobileEventViews.swift"), encoding: .utf8)
    let server = try String(contentsOf: cwd.appendingPathComponent("server/agent_server.py"), encoding: .utf8)

    try assert(server.contains("content_prefix: str | None = Query(default=None)"), "Server files API must support content-type prefix filtering")
    try assert(server.contains("str(rec.get(\"content_type\") or \"\").lower().startswith(prefix)"), "Server files API must filter records before paging")
    try assert(macStore.contains("@Published var sessionVideoFiles: [ZFile] = []"), "Mac store must keep video metadata separate from mixed file pages")
    try assert(macStore.contains("URLQueryItem(name: \"content_prefix\", value: \"video/\")"), "Mac store must fetch videos independently of mixed file paging")
    try assert(macStore.contains("URLQueryItem(name: \"limit\", value: \"\\(sessionFilesPageLimit)\")"), "Mac video metadata fetch must be paged instead of pulling every video while switching chats")
    try assert(inspector.contains("store.sessionVideos"), "Mac files inspector must render the independent video list")
    try assert(inspector.contains("@State private var visibleVideoCount = 4"), "Mac files inspector must start video grids at four previews")
    try assert(inspector.contains("private let videoPageSize = 4"), "Mac files inspector must page video grids four at a time")
    try assert(eventViews.contains("private let initialArtifactLimit = 4"), "Mac timeline artifact grids must start at four previews")
    try assert(eventViews.contains("let mediaArtifacts = visibleArtifacts.filter"), "Mac timeline artifact cards must derive media/files from the capped preview set")
    try assert(eventViews.contains("visibleArtifacts.filter { $0.file.isPreviewableArtifact }"), "Mac timeline artifact cards must split media previews from plain files")
    try assert(eventViews.contains("private struct ArtifactFileRow"), "Mac timeline plain files must render as compact rows instead of large preview tiles")
    try assert(eventViews.contains("private extension ZFile"), "Mac timeline artifact preview classification should live with artifact rendering")
    try assert(inspector.contains("struct MacArtifactDownloadButton"), "Mac must expose a reusable artifact download button")
    try assert(inspector.contains("NSSavePanel()"), "Mac artifact downloads must let the user choose a save location")
    try assert(inspector.contains("ArtifactDragFileCache.shared.localFile"), "Mac artifact downloads must cache remote files locally before saving")
    try assert(eventViews.contains("MacArtifactDownloadButton(file: file, url: url, title: \"\")"), "Mac timeline artifacts must expose explicit download controls")
    try assert(eventViews.contains("MacArtifactDownloadButton(file: attachment.file, url: url, title: \"\")"), "Mac message attachment cards must expose explicit download controls")
    try assert(inspector.contains("MacArtifactDownloadButton(file: file, url: url, title: \"\")"), "Mac files/videos inspector must expose explicit download controls")
    try assert(eventViews.contains("MacImagePreviewSheet(file: file, url: url)"), "Mac timeline image thumbnails must open a larger preview")
    try assert(mobileEvents.contains("mobileImageFullscreen(isPresented:"), "iOS timeline image thumbnails must open a larger preview")
    try assert(mobileEvents.contains("MobileFullscreenImageView"), "iOS image preview must have a dedicated full-screen viewer")
}

func checkRuntimeAutosavesAndBackendIcons() throws {
    let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
    let macTheme = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/Design/Theme.swift"), encoding: .utf8)
    let mobileTheme = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDockIOS/Design/MobileTheme.swift"), encoding: .utf8)
    let macInspector = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/Views/InspectorView.swift"), encoding: .utf8)
    let mobileOptions = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDockIOS/Views/MobileChatOptionsView.swift"), encoding: .utf8)
    let macSidebar = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/Views/SidebarView.swift"), encoding: .utf8)
    let mobileSidebar = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDockIOS/Views/MobileSidebarView.swift"), encoding: .utf8)
    let assets = cwd.appendingPathComponent("Sources/ZenithDockIOS/Resources/Assets.xcassets")

    try assert(macTheme.contains("struct BackendLogo"), "Mac theme must define backend logo views")
    try assert(mobileTheme.contains("struct MobileBackendLogo"), "iOS theme must define backend logo views")
    try assert(macTheme.contains("\"ClaudeBackendLogo\""), "Mac backend logos must use the supplied Claude asset")
    try assert(macTheme.contains("\"CodexBackendLogo\""), "Mac backend logos must use the supplied Codex asset")
    try assert(macTheme.contains("var size: CGFloat = 16"), "Mac backend logo view must own an explicit icon size")
    try assert(macTheme.contains(".clipped()"), "Mac backend logo image must be clipped to its icon frame")
    try assert(mobileTheme.contains("\"ClaudeBackendLogo\""), "iOS backend logos must use the supplied Claude asset")
    try assert(mobileTheme.contains("\"CodexBackendLogo\""), "iOS backend logos must use the supplied Codex asset")
    try assert(mobileTheme.contains("var size: CGFloat = 16"), "iOS backend logo view must own an explicit icon size")
    try assert(mobileTheme.contains(".clipped()"), "iOS backend logo image must be clipped to its icon frame")
    try assert(
        FileManager.default.fileExists(atPath: assets.appendingPathComponent("ClaudeBackendLogo.imageset/ClaudeBackendLogo.png").path),
        "Claude backend image asset must exist"
    )
    try assert(
        FileManager.default.fileExists(atPath: assets.appendingPathComponent("ClaudeBackendLogo.imageset/ClaudeBackendLogo@2x.png").path),
        "Claude backend image asset must include a 2x small rendition"
    )
    try assert(
        FileManager.default.fileExists(atPath: assets.appendingPathComponent("CodexBackendLogo.imageset/CodexBackendLogo.png").path),
        "Codex backend image asset must exist"
    )
    try assert(
        FileManager.default.fileExists(atPath: assets.appendingPathComponent("CodexBackendLogo.imageset/CodexBackendLogo@2x.png").path),
        "Codex backend image asset must include a 2x small rendition"
    )
    try assert(macSidebar.contains("SessionRowBackendIcon"), "Mac sidebar must keep provider icons in chat rows")
    try assert(mobileSidebar.contains("MobileSessionRowBackendIcon"), "iOS sidebar must keep provider icons in chat rows")
    try assert(macSidebar.contains("BackendLogo(backend: backend)"), "Mac sidebar rows must show the backend logo")
    try assert(mobileSidebar.contains("MobileBackendLogo(backend: backend)"), "iOS sidebar rows must show the backend logo")
    try assert(macSidebar.contains("badgeColor: Color?"), "Mac sidebar row status must be a single optional badge on the icon")
    try assert(mobileSidebar.contains("badgeColor: Color?"), "iOS sidebar row status must be a single optional badge on the icon")
    try assert(!macTheme.contains("\"terminal\""), "Codex must not fall back to the terminal SF Symbol")
    try assert(!mobileTheme.contains("\"terminal\""), "iOS Codex must not fall back to the terminal SF Symbol")
    try assert(!macSidebar.contains("sparkle.magnifyingglass"), "Codex sidebar icon must not be the search glyph")
    try assert(!mobileSidebar.contains("sparkle.magnifyingglass"), "iOS Codex sidebar icon must not be the search glyph")
    try assert(!macSidebar.contains("circle.hexagongrid"), "Claude sidebar icon must not be the old generic grid glyph")
    try assert(macInspector.contains("scheduleRuntimeSave(debounceNanoseconds: 0)"), "Mac inspector runtime changes must autosave immediately")
    try assert(!macInspector.contains("\"Save Runtime\""), "Mac inspector must not show a Save Runtime button")
    try assert(mobileOptions.contains("scheduleRuntimeSave(debounceNanoseconds: 0)"), "iOS chat options runtime changes must autosave immediately")
    try assert(!mobileOptions.contains("Save Runtime & Session"), "iOS options must not imply runtime requires a manual save")
}

func checkJobIntervalPresets() throws {
    let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
    let inspector = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/Views/InspectorView.swift"), encoding: .utf8)
    let mobileOptions = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDockIOS/Views/MobileChatOptionsView.swift"), encoding: .utf8)
    let macStore = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/State/AppStore.swift"), encoding: .utf8)
    let mobileStore = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDockIOS/State/MobileAppStore.swift"), encoding: .utf8)
    let server = try String(contentsOf: cwd.appendingPathComponent("server/agent_server.py"), encoding: .utf8)

    try assert(inspector.contains("private struct JobIntervalControl"), "Mac job scheduling must use the reusable interval preset control")
    try assert(inspector.contains("private let jobIntervalPresets"), "Mac job scheduling must define interval presets")
    try assert(inspector.contains("JobIntervalPreset(seconds: 30"), "Job interval presets must include short status-check timing")
    try assert(inspector.contains("JobIntervalPreset(seconds: 86_400"), "Job interval presets must include daily timing")
    try assert(inspector.contains("Text(\"Custom\").tag(customJobIntervalTag)"), "Job interval picker must keep a custom option")
    try assert(inspector.contains("JobIntervalControl(intervalText: $intervalText)"), "Both new and edit job sheets should use the preset interval control")
    try assert(inspector.contains("private struct JobStartControl"), "Mac job scheduling must expose first-run/next-run timing")
    try assert(inspector.contains("DatePicker("), "Mac custom job start time must use a DatePicker")
    try assert(inspector.contains("firstRunAt: jobFirstRunAt"), "New jobs must pass the requested first-run time")
    try assert(inspector.contains("nextRunAt: nextRunAt"), "Edited jobs must pass the requested next-run time")
    try assert(mobileOptions.contains("private struct MobileJobIntervalControl"), "iOS job scheduling must use an interval preset control")
    try assert(mobileOptions.contains("private struct MobileJobStartControl"), "iOS job scheduling must expose first-run/next-run timing")
    try assert(mobileOptions.contains("DatePicker(\"Start time\""), "iOS custom job start time must use a DatePicker")
    try assert(mobileOptions.contains("firstRunAt: jobFirstRunAt"), "iOS new jobs must pass the requested first-run time")
    try assert(mobileOptions.contains("nextRunAt: nextRunAt"), "iOS edited jobs must pass the requested next-run time")
    try assert(macStore.contains("first_run_at: String?"), "Mac job create payload must support first_run_at")
    try assert(macStore.contains("next_run_at: String?"), "Mac job update payload must support next_run_at")
    try assert(macStore.contains("max_runs: Int?"), "Mac job payloads must support fixed run counts")
    try assert(inspector.contains("maxRunsText"), "Mac job sheets must expose fixed run-count controls")
    try assert(inspector.contains("jobRunModeDescription(loop:"), "Mac job rows must describe finite run counts")
    try assert(allPickersHideLabels(named: "Mode", binding: "$loop", in: inspector), "Mac job mode segmented pickers must hide their own labels so Mode does not wrap/cut off")
    try assert(allPickersHideLabels(named: "Backend", binding: "$backend", in: inspector), "Mac job backend segmented pickers must hide their own labels so Backend does not wrap/cut off")
    try assert(mobileStore.contains("first_run_at: String?"), "iOS job create payload must stay compatible with first_run_at")
    try assert(mobileStore.contains("max_runs: Int?"), "iOS job payloads must support fixed run counts")
    try assert(mobileOptions.contains("maxRunsText"), "iOS job sheets must expose fixed run-count controls")
    try assert(server.contains("first_run_at: str | None = None"), "Server job create model must accept first_run_at")
    try assert(server.contains("next_run_at: str | None = None"), "Server job update model must accept next_run_at")
    try assert(server.contains("max_runs: int | None = None"), "Server job models must accept max_runs")
    try assert(server.contains("finite_has_more"), "Server scheduler must keep finite jobs running until max_runs is reached")
    try assert(server.contains("parse_job_timestamp"), "Server must parse explicit job timestamps")
}

func allPickersHideLabels(named name: String, binding: String, in source: String) -> Bool {
    let marker = "Picker(\"\(name)\", selection: \(binding))"
    let chunks = source.components(separatedBy: marker).dropFirst()
    guard !chunks.isEmpty else { return false }
    return chunks.allSatisfy { chunk in
        let prefix = String(chunk.prefix(320))
        return prefix.contains(".labelsHidden()") && prefix.contains(".pickerStyle(.segmented)")
    }
}

func checkTimelineCombinesRunTraces() throws {
    let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
    let macTimeline = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/Views/TimelineView.swift"), encoding: .utf8)
    let mobileTimeline = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDockIOS/Views/MobileTimelineView.swift"), encoding: .utf8)
    let server = try String(contentsOf: cwd.appendingPathComponent("server/agent_server.py"), encoding: .utf8)

    try assert(macTimeline.contains("activeAssistantEvents: [ZEvent]"), "Mac timeline must collect assistant chunks per run")
    try assert(macTimeline.contains("activeArtifactEvents: [ZEvent]"), "Mac timeline must collect run artifacts so videos render after assistant text")
    try assert(macTimeline.contains("activeTrace: [ZEvent]"), "Mac timeline must collect trace events per run")
    try assert(macTimeline.contains("if event.type == \"artifact_created\""), "Mac timeline must special-case artifacts before the generic row path")
    try assert(macTimeline.contains("if activeRunID != nil {\n                    activeArtifactEvents.append(event)"), "Mac timeline must group old nil-run manifest artifacts with the active run")
    try assert(macTimeline.contains("trace-run-\\(activeRunID"), "Mac timeline trace rows must be run-scoped")
    try assert(macTimeline.contains("joined(separator: \"\\n\\n\")"), "Mac timeline must merge assistant chunks into one message")
    try assert(mobileTimeline.contains("activeAssistantEvents: [ZEvent]"), "iOS timeline must collect assistant chunks per run")
    try assert(mobileTimeline.contains("activeArtifactEvents: [ZEvent]"), "iOS timeline must collect run artifacts so videos render after assistant text")
    try assert(mobileTimeline.contains("activeTrace: [ZEvent]"), "iOS timeline must collect trace events per run")
    try assert(mobileTimeline.contains("if event.type == \"artifact_created\""), "iOS timeline must special-case artifacts before the generic row path")
    try assert(mobileTimeline.contains("if activeRunID != nil {\n                    activeArtifactEvents.append(event)"), "iOS timeline must group old nil-run manifest artifacts with the active run")
    try assert(mobileTimeline.contains("trace-run-\\(activeRunID"), "iOS timeline trace rows must be run-scoped")
    try assert(server.contains("async def collect_manifest("), "Server manifest collection must know the active run id")
    try assert(server.contains("async def watch_manifest_artifacts"), "Server must watch manifests during a running turn so artifacts can appear before turn end")
    try assert(server.contains("async def collect_recent_leftover_manifests"), "Server must recover recent stale-run manifests written by resumed agents")
    try assert(server.contains("max_age_seconds: int = 6 * 60 * 60"), "Stale manifest recovery must be bounded to recent manifests")
    try assert(server.contains("live_manifest_entry_ready"), "Live manifest watcher must wait for stable files before publishing artifacts")
    try assert(server.contains("manifest_watch_task = asyncio.create_task(watch_manifest_artifacts"), "Claude and Codex runs must start live manifest watcher tasks")
    try assert(server.components(separatedBy: "collect_recent_leftover_manifests").count >= 4, "Both Claude and Codex runs must sweep recent leftover manifests after the primary manifest")
    try assert(server.contains("\"artifact_created\", {\"run_id\": run_id, \"artifact\": rec}"), "Server artifact_created events must include run_id so videos render after assistant text")
}

func checkFlexibleEventOutputDecoding() throws {
    let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
    let core = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithCore/ZenithCore.swift"), encoding: .utf8)
    let server = try String(contentsOf: cwd.appendingPathComponent("server/agent_server.py"), encoding: .utf8)
    let json = """
    {
      "seq": 1,
      "id": "evt_test",
      "session_id": "sess_test",
      "type": "tool_finished",
      "ts": "2026-06-02T00:00:00Z",
      "output": [
        {"type": "text", "text": "hello"},
        {"type": "image", "source": {"type": "base64", "data": "abc"}}
      ]
    }
    """
    let event = try JSONDecoder().decode(ZEvent.self, from: Data(json.utf8))
    try assert(event.output?.contains("hello") == true, "ZEvent must decode Claude array-style tool output into text")
    try assert(event.output?.contains("[image result]") == true, "ZEvent must summarize image output blocks instead of failing decode")
    try assert(core.contains("decodeStringLike") && core.contains("stringLikeText"), "Core event decoder must keep flexible output decoding")
    try assert(server.contains("def event_output_text") && server.contains("def client_safe_event"), "Server must sanitize legacy non-string tool output when serving history")
    try assert(server.contains("event = client_safe_event(event)"), "Server read_events must normalize legacy event output before API responses")
    try assert(server.contains("content = event_output_text(block.get(\"content\", \"\"))"), "Claude stream ingestion must write tool output as text")
}

func checkInlineVideoPlayAutoplays() throws {
    let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
    let inlineVideo = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/Views/Components/InlineVideoView.swift"), encoding: .utf8)

    try assert(inlineVideo.contains("@State private var autoplayOnLoad = false"), "Inline video should track autoplay intent from the placeholder")
    try assert(inlineVideo.contains("InlineVideoPlayerView(url: url, autoplay: autoplayOnLoad)"), "Inline video must pass autoplay intent to the player")
    try assert(inlineVideo.contains("playerView.player?.play()"), "Mac inline video player must start playback after the user presses Play")
    try assert(inlineVideo.contains("videoHTML(for: url, autoplay: autoplay)"), "iOS inline video web player must receive autoplay intent")
    try assert(inlineVideo.contains("video.play().catch"), "iOS inline video web player should attempt playback after loading")
}

func checkCodeReviewSurfaceIsStructured() throws {
    let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
    let review = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/Views/TraceChangeSetView.swift"), encoding: .utf8)

    try assert(review.contains("TraceReviewDiffPane"), "Code review sheet must render a structured diff pane")
    try assert(review.contains("TraceReviewDiffPane(sections: sections)"), "Code review sheet should render all file hunks together like Codex review")
    try assert(review.contains("TraceDiffLineView"), "Code review sheet must render per-line diff rows")
    try assert(review.contains("oldNumber"), "Code review diff rows should include old/new line numbers")
    try assert(review.contains("!path.hasPrefix(\"+\")"), "Code change extraction must reject diff body lines as fake paths")
    try assert(!review.contains("event.tool?.traceCommandText,\n            event.tool?.input?.pretty"), "Code review extraction must not treat command text as diff content")
    try assert(!review.contains("lower.contains(\"git status\")"), "Code review extraction must not treat git status commands as review hunks")
}

func checkUnreadMessageMarker() throws {
    let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
    let core = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithCore/ZenithCore.swift"), encoding: .utf8)
    let macStore = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/State/AppStore.swift"), encoding: .utf8)
    let mobileStore = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDockIOS/State/MobileAppStore.swift"), encoding: .utf8)
    let mobileSidebar = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDockIOS/Views/MobileSidebarView.swift"), encoding: .utf8)
    let macSidebar = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/Views/SidebarView.swift"), encoding: .utf8)
    let macEventViews = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/Views/EventViews.swift"), encoding: .utf8)
    let mobileEventViews = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDockIOS/Views/MobileEventViews.swift"), encoding: .utf8)
    let server = try String(contentsOf: cwd.appendingPathComponent("server/agent_server.py"), encoding: .utf8)
    let timeline = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/Views/TimelineView.swift"), encoding: .utf8)

    try assert(core.contains("latest_agent_event_seq"), "Shared session model must decode latest visible agent event seq")
    try assert(core.contains("last_read_agent_event_seq"), "Shared session model must decode server-backed read cursor")
    try assert(core.contains("manual_unread"), "Shared session model must decode server-backed manual unread state")
    try assert(server.contains("latest_agent_event_seq"), "Server public sessions must expose latest visible agent event seq")
    try assert(server.contains("last_read_agent_event_seq"), "Server public sessions must expose server-backed read cursor")
    try assert(server.contains("manual_unread"), "Server public sessions must expose manual unread state")
    try assert(server.contains("sess[\"latest_agent_event_seq\"] = requested"), "Server read marks must repair stale latest agent seq metadata")
    try assert(server.contains("@app.post(\"/api/sessions/{session_id}/read\")"), "Server must expose a read-state endpoint for cross-device unread sync")
    try assert(server.contains("@app.post(\"/api/sessions/{session_id}/unread\")"), "Server must expose a manual unread endpoint for cross-device unread sync")
    try assert(server.contains("\"job_ran\", \"job_error\""), "Server must treat scheduled-job output as visible agent output")
    try assert(server.contains("update_session_event_metadata(session_id, event)"), "Server must update session event metadata as events are appended")
    try assert(macStore.contains("firstUnreadAgentSeqBySessionID"), "Mac store must remember the first unread agent event seq")
    try assert(macStore.contains("selectedTimelineAtBottom"), "Mac store must track whether the selected timeline is actually at bottom")
    try assert(macStore.contains("lastReadAgentSeqBySessionID"), "Mac unread state must compare server latest seq against local last-read seq")
    try assert(macStore.contains("manuallyUnreadSessionIDs"), "Mac store must preserve manual unread marks while the selected chat is open")
    try assert(macStore.contains("private func adoptServerReadCursor"), "Mac session refresh must treat the server read cursor as authoritative")
    try assert(macStore.contains("setLastReadAgentSeq(seq, for: sessionID, allowDecrease: true)"), "Mac server read cursor adoption must allow cross-device cursor decreases")
    try assert(macStore.contains("markSessionUnread"), "Mac store must support manually marking a chat unread")
    try assert(macStore.contains("allowDecrease: true"), "Manual unread must be able to move the local read cursor backward")
    try assert(macStore.contains("reconcileUnreadFromSessions()"), "Mac session refresh must reconcile unread state for non-selected scheduled-job output")
    try assert(macStore.contains("/api/sessions/\\(sessionID)/read"), "Mac read marks must sync to the server")
    try assert(macStore.contains("/api/sessions/\\(sessionID)/unread"), "Mac manual unread marks must sync to the server")
    try assert(macStore.contains("[sessionSeq, eventSeq].compactMap"), "Mac read marks must use the max of server metadata and loaded visible events")
    try assert(macStore.contains("selectedSessionFirstUnreadSeq"), "Mac store must expose selected chat's first unread seq")
    try assert(macStore.contains("markAgentUnread(sessionID: String, firstSeq: Int? = nil)"), "Unread marking must accept a first event seq")
    try assert(macStore.contains("case \"job_ran\""), "Scheduled job responses must count as visible agent messages")
    try assert(macStore.contains("case \"job_ran\", \"job_error\""), "Scheduled job failures must count as visible agent messages")
    try assert(macEventViews.contains("case \"job_created\", \"job_ran\", \"job_deferred\"") && macEventViews.contains("case \"job_deferred\": \"Job Deferred\""), "Mac job-deferred events must render as orange job timeline cards")
    try assert(macStore.contains("else if !selectedTimelineAtBottom"), "Selected-chat live agent messages must mark unread when the user is away from bottom")
    try assert(mobileStore.contains("unreadAgentSessionIDs"), "iOS must keep unread state for session rows")
    try assert(mobileStore.contains("lastReadAgentSeqBySessionID"), "iOS unread state must compare server latest seq against local last-read seq")
    try assert(mobileStore.contains("manuallyUnreadSessionIDs"), "iOS store must preserve manual unread marks while the selected chat is open")
    try assert(mobileStore.contains("private func adoptServerReadCursor"), "iOS session refresh must treat the server read cursor as authoritative")
    try assert(mobileStore.contains("setLastReadAgentSeq(seq, for: sessionID, allowDecrease: true)"), "iOS server read cursor adoption must allow cross-device cursor decreases")
    try assert(mobileStore.contains("markSessionUnread"), "iOS store must support manually marking a chat unread")
    try assert(mobileStore.contains("reconcileUnreadFromSessions()"), "iOS session refresh must reconcile unread state for non-selected scheduled-job output")
    try assert(mobileStore.contains("/api/sessions/\\(sessionID)/read"), "iOS read marks must sync to the server")
    try assert(mobileStore.contains("/api/sessions/\\(sessionID)/unread"), "iOS manual unread marks must sync to the server")
    try assert(mobileStore.contains("[sessionSeq, eventSeq].compactMap"), "iOS read marks must use the max of server metadata and loaded visible events")
    try assert(macSidebar.contains("Mark as Unread"), "Mac sidebar must expose a mark-as-unread chat action")
    try assert(macSidebar.contains("Mark as Read"), "Mac sidebar must expose a mark-as-read chat action")
    try assert(mobileSidebar.contains("Mark as Unread"), "iOS sidebar must expose a mark-as-unread chat action")
    try assert(mobileSidebar.contains("Mark as Read"), "iOS sidebar must expose a mark-as-read chat action")
    try assert(mobileSidebar.contains("Unread agent message"), "iOS sidebar must show unread agent messages")
    try assert(mobileEventViews.contains("case \"job_created\", \"job_ran\", \"job_deferred\"") && mobileEventViews.contains("case \"job_deferred\":\n            return \"Job Deferred\""), "iOS job-deferred events must render as orange job timeline cards")
    try assert(timeline.contains("TimelineUnreadMarker"), "Mac timeline must render an inline new-message marker")
    try assert(timeline.contains("firstUnreadRowID(in: rows, unreadSeq: store.selectedSessionFirstUnreadSeq)"), "Timeline must anchor the marker to the first unread row")
    try assert(timeline.contains("(!isNearBottom || store.selectedSessionHasUnread)"), "Bottom button must still show when there are unread messages near the bottom")
    try assert(timeline.contains("metrics.distanceFromBottom <= 28"), "Read clearing must use a strict bottom threshold")
    try assert(timeline.contains("trailingReportWorkItem"), "Scroll observer must deliver a trailing scroll-position report")
    try assert(timeline.contains("store.setSelectedTimelineAtBottom(nextAtBottom)"), "Timeline must publish strict bottom state to the store")
    try assert(!timeline.contains("TimelineHistoryTopReader"), "Mac timeline must not use a SwiftUI geometry preference reader during normal scrolling")
    try assert(timeline.contains("distanceFromTop"), "Mac scroll observer must report top distance for older-history loading")
    try assert(timeline.contains("bottomBucket(lhs.distanceFromBottom) == bottomBucket(rhs.distanceFromBottom)"), "Mac scroll observer must bucket bottom distance instead of publishing every pixel")
    try assert(timeline.contains("topBucket(lhs.distanceFromTop) == topBucket(rhs.distanceFromTop)"), "Mac scroll observer must bucket top distance instead of publishing every pixel")
}

func checkTimelineHistoryPaging() throws {
    let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
    let macStore = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/State/AppStore.swift"), encoding: .utf8)
    let timeline = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/Views/TimelineView.swift"), encoding: .utf8)

    try assert(macStore.contains("private let initialSessionEventLimit = 240"), "Mac chat selection must load a bounded recent tail")
    try assert(macStore.contains("private let maxCachedTimelineEvents = 720"), "Mac chat cache must retain more than the initial recent window without bloating warm switches")
    try assert(macStore.contains("private let maxCachedStringCharacters = 6_000"), "Mac disk cache must cap large text payloads aggressively")
    try assert(macStore.contains("let limit = renderLimit ?? maxCachedTimelineEvents"), "Mac disk cached chat restores must keep older pages while memory switches can render a warm tail")
    try assert(macStore.contains("events = Array(cachedEvents.suffix(limit))"), "Mac cached chat restores must apply the requested cache render window")
    try assert(macStore.contains(".suffix(maxCachedTimelineEvents)"), "Mac memory/disk chat cache must retain expanded older-page windows")
    try assert(macStore.contains("drop stale older history session="), "Older-history responses must not mutate the timeline after switching chats")
    try assert(macStore.contains("preserveExisting ? events.filter { $0.session_id == sessionID } : []"), "Fresh session snapshots must support preserving cached pages for same-chat full refreshes")
    try assert(macStore.contains("preservedBeforeSnapshot"), "Merged snapshots must reduce the older-hidden count by locally preserved events")
    try assert(macStore.contains("omittedHistoryEventCount > 0 && !isLoadingOlderHistory"), "Older-history loading must not stop just because the local timeline window is full")
    try assert(macStore.contains("URLQueryItem(name: \"limit\", value: \"\\(olderHistoryPageLimit)\")"), "Older-history paging must request a fixed page instead of remaining local capacity")
    try assert(macStore.contains("mergedEvents.removeLast(overflow)"), "Older-history paging must slide the local window by dropping the newest overflow")
    try assert(macStore.contains("for _ in 0..<8"), "Older-history paging must skip over invisible/raw-only server pages")
    try assert(macStore.contains("skipped_invisible_pages"), "Older-history logs must report invisible pages skipped while seeking visible rows")
    try assert(macStore.contains("isPrimaryTimelinePageEvent"), "Mac older-history paging must keep walking past trace-only visible pages")
    try assert(macStore.contains("skipped_non_primary_pages"), "Older-history logs must report trace-only pages skipped while seeking primary rows")
    try assert(timeline.contains("TimelineScrollAnchor"), "History paging must capture a stable scroll anchor")
    try assert(timeline.contains("anchorEventID"), "History paging must keep an event-id fallback for regrouped rows")
    try assert(timeline.contains("row(containingEventID: eventID, in: rows)"), "History paging must restore through the event-id fallback when row IDs change")
    try assert(timeline.contains("for delay in [0.0, 0.06, 0.18]"), "History paging must restore the scroll anchor across multiple layout passes")
    try assert(timeline.contains("loadOlderHistoryShowingNewPage"), "Explicit Load Older button must visibly move to the newly revealed older page")
    try assert(timeline.contains("revealOlderRowsShowingNewPage"), "Explicit Show Older button must visibly move to the newly revealed rendered page")
    try assert(timeline.contains("olderPageReveal(oldLimit:"), "Show Older must expand past trace-only rendered pages before choosing its target")
    try assert(timeline.contains("isPrimaryPageRow"), "Timeline rows must identify primary conversation rows for older-page targeting")
    try assert(timeline.contains("scrollToOlderPageTarget"), "Explicit older-page navigation must share delayed scroll settling")
    try assert(timeline.contains("private func renderedRows(visibleLimit:"), "Older-page navigation must use the same rows the UI actually renders")
    try assert(timeline.contains("AppLogger.info(\"auto older loaded"), "Automatic older-history loading must log rendered row expansion diagnostics")
    try assert(timeline.contains("firstNewOlderRow(before:"), "Automatic older-history loading must reveal the newly loaded page instead of pinning the old top row")
    try assert(macStore.contains("firstAddedEventID"), "Older-history loading must return the first newly loaded event for deterministic scroll targeting")
    try assert(timeline.contains("row(containingEventID: firstAddedEventID, in: rows)"), "Older-history navigation must scroll to the row containing the first newly loaded event")
    try assert(timeline.contains("olderHistoryVisibleLimit"), "Older-history reveal must expand the rendered suffix far enough to include its scroll target")
    try assert(timeline.contains("rowsNeeded + 2"), "Older-history target rows must be inside the rendered suffix before scrolling")
    try assert(timeline.contains("target=\\(target?.id ?? \"-\")"), "Older-history logs must include the actual target row")
    try assert(timeline.contains("func containsEventID(_ eventID: String)"), "Grouped timeline rows must retain source event IDs for deterministic scroll targeting")
    try assert(timeline.contains("private static let assistantRowChunkSize"), "Assistant runs must be split into bounded rows so older pages create visible targets")
    try assert(timeline.contains("private static let traceRowChunkSize"), "Trace runs must be split into bounded rows so older pages create visible targets")
    try assert(timeline.contains("private static let compactedTraceEventLimit"), "Adjacent trace-only rows must be compacted so history pages do not become trace walls")
    try assert(timeline.contains("compactAdjacentTraceRows(buildRows"), "Mac timeline projection must compact adjacent trace cards after preserving row targets")
    try assert(timeline.contains("trace-compact-"), "Compacted trace rows must retain deterministic scroll IDs")
    try assert(timeline.contains("eventIDs: chunk.map(\\.id)"), "Chunked timeline rows must preserve the source event IDs they represent")
    try assert(timeline.contains("AppLogger.info(\"show older rows"), "Show Older must log target rows for paging diagnostics")
    try assert(timeline.contains("let effectiveLimit = isProjectionExpansion ? max(candidateLimit, nextLimit) : max(oldLimit, nextLimit)"), "Show Older must expand projection-budget-hidden rows even when rendered row count is unchanged")
    try assert(timeline.contains("rows.first(where: { $0.isPrimaryPageRow }) ??"), "Show Older must fall back to a primary row target when newly revealed rows are all compacted")
    try assert(timeline.contains("AppLogger.info(\"load older intent"), "Load Older must log target rows for paging diagnostics")
    try assert(timeline.contains("private func disarmAutomaticOlderHistoryLoad()"), "Timeline must centralize the guard that prevents open-bottom from accidentally auto-loading older history")
    try assert(timeline.contains("disarmAutomaticOlderHistoryLoad()\n                    suppressHistoryLoading(for: 1.4)"), "Opening a chat must disarm auto older-history loading until the latest-message scroll settles")
    try assert(timeline.contains("disarmAutomaticOlderHistoryLoad()\n        let action = {"), "Programmatic bottom scrolls must disarm older-history autoload before layout metrics arrive")
    try assert(timeline.contains("if topHasLeftViewport {\n            olderHistoryLoadArmed = true"), "Older-history autoload should rearm only after the rendered top has left the viewport")
    try assert(timeline.contains("if revealOlderRowsShowingNewPage(proxy) {\n            olderHistoryLoadArmed = false"), "Automatic older-history loading must reveal the new page instead of preserving the old top anchor")
    try assert(timeline.contains("private func suppressHistoryLoading(for interval: TimeInterval)"), "Open-to-latest must use monotonic history-load suppression instead of shortening the suppression window")
    try assert(timeline.contains("suppressHistoryLoading(for: 2.4)"), "Opening a chat must suppress top-edge history loading while bottom scrolling settles")
    try assert(timeline.contains("for delay in [0.04, 0.14, 0.28]"), "Opening a chat must use short bottom settle passes without late visible jumps")
    try assert(timeline.contains("metrics.isScrollable && metrics.distanceFromBottom <= 28"), "Forced bottom scrolling must not declare success while only a placeholder/non-scrollable timeline is rendered")
    try assert(!timeline.contains("disarmAutomaticOlderHistoryLoad()\n                    historyLoadSuppressedUntil = Date.distantPast"), "Opening a chat must not immediately re-enable top-edge history loading")
    try assert(!timeline.contains("Loaded window limit"), "Mac history banner must keep offering Load Older while the server has older events")
}

func checkLiveTimelineAutoFollow() throws {
    let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
    let macStore = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/State/AppStore.swift"), encoding: .utf8)
    let macTimeline = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/Views/TimelineView.swift"), encoding: .utf8)
    let mobileStore = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDockIOS/State/MobileAppStore.swift"), encoding: .utf8)
    let mobileTimeline = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDockIOS/Views/MobileTimelineView.swift"), encoding: .utf8)
    guard let macApplyRange = macStore.range(of: "private func applyStreamEvents"),
          let macRunningRange = macStore.range(of: "private func syncSelectedRunningState", range: macApplyRange.upperBound..<macStore.endIndex),
          let macIngestRange = macStore.range(of: "private func ingest"),
          let macRequestScrollRange = macStore.range(of: "private func requestScrollToBottom", range: macIngestRange.upperBound..<macStore.endIndex),
          let mobileIngestRange = mobileStore.range(of: "private func ingest"),
          let mobileRunningRange = mobileStore.range(of: "private func updateRunningState", range: mobileIngestRange.upperBound..<mobileStore.endIndex) else {
        throw GuardrailFailure.failed("Could not locate live timeline stream handlers")
    }
    let macApplyStreamBlock = macStore[macApplyRange.lowerBound..<macRunningRange.lowerBound]
    let macIngestBlock = macStore[macIngestRange.lowerBound..<macRequestScrollRange.lowerBound]
    let mobileIngestBlock = mobileStore[mobileIngestRange.lowerBound..<mobileRunningRange.lowerBound]

    try assert(macTimeline.contains("private func shouldAutoFollowLiveEvent(after previousSeq: Int) -> Bool {\n        false\n    }"), "Mac timeline must not auto-scroll downward when new selected-chat messages arrive")
    try assert(macTimeline.contains("store.markAgentUnread(sessionID: sessionID, firstSeq: firstSeq)"), "Mac timeline must mark selected-chat agent output unread instead of auto-following")
    try assert(macTimeline.contains("cappedLiveVisibleRowLimit(rowCount: rowCount, oldCount: oldCount, newCount: newCount)"), "Mac live-follow must not expand the rendered window to the full chat history")
    try assert(macTimeline.contains("suppressHistoryLoading(for: 0.45)"), "Mac programmatic bottom scrolls must suppress older-history autoload")
    try assert(macTimeline.contains("store.markSelectedSessionRead(force: true)"), "Mac auto-follow must clear selected unread state intentionally")
    try assert(macStore.contains("@Published var preserveTimelineScrollRevision"), "Mac store must expose a passive live-update scroll preservation revision")
    try assert(macStore.contains("preserveSelectedTimelineIfNeeded(for: buffered)\n        applyStreamEvents(buffered)"), "Mac selected-chat agent output must preserve the current viewport before publishing streamed events")
    try assert(macStore.contains("guard !selectedTimelineAtBottom,"), "Mac live stream preservation must not force layout restores while the selected timeline is already at bottom")
    try assert(macTimeline.contains("return min(rowCount, currentLimit)"), "Mac live bottom updates must not expand the rendered row window on every incoming event")
    try assert(macTimeline.contains("preservePositionRevision: store.preserveTimelineScrollRevision"), "Mac timeline must pass passive live-update preservation requests to the scroll observer")
    try assert(macTimeline.contains("func handlePreservePositionRevision") && macTimeline.contains("restoreVisibleOrigin"), "Mac scroll observer must restore the prior visible origin for passive live updates")
    try assert(!macApplyStreamBlock.contains("requestScrollToBottom()"), "Mac streamed event batches must not request bottom scrolling")
    try assert(!macIngestBlock.contains("requestScrollToBottom()"), "Mac single streamed events must not request bottom scrolling")
    try assert(macStore.contains("requestScrollToBottom(immediate: true)\n            AppLogger.info(\"send prompt"), "Mac user sends must still scroll the timeline to the bottom")
    try assert(macStore.contains("pendingStreamEvents"), "Mac streaming catch-up must buffer burst events instead of publishing one-by-one flyby")
    try assert(macStore.contains("streamBackfillMaskThreshold"), "Mac streaming catch-up must mask large event bursts")
    try assert(macStore.contains("applyStreamEvents(buffered)"), "Mac streaming catch-up must apply buffered events as one batch")
    try assert(mobileTimeline.contains("private func shouldAutoFollowLiveEvent(after previousSeq: Int) -> Bool {\n        false\n    }"), "iOS timeline must not auto-scroll downward when new selected-chat messages arrive")
    try assert(mobileTimeline.contains("store.markSessionUnread(sessionID)"), "iOS timeline must mark selected-chat agent output unread instead of auto-following")
    try assert(mobileTimeline.contains("lastObservedEventSeq"), "iOS timeline must distinguish new streamed events from older history prepends")
    try assert(mobileTimeline.contains("cappedLiveVisibleRowLimit(rowCount: rowCount, oldCount: oldCount, newCount: newCount)"), "iOS live-follow must not expand the rendered window to the full chat history")
    try assert(mobileTimeline.contains("pendingOpenBottomSessionID = store.selectedSessionID\n                    isAtBottom = true\n                    disarmAutomaticOlderHistoryLoad()"), "iOS opening a chat must disarm older-history autoload while latest-position settling runs")
    try assert(mobileTimeline.contains("private func settleOpenThreadAtLatest"), "iOS timeline must centralize newly opened thread latest-position settling")
    try assert(mobileTimeline.contains("!displayEvents.isEmpty,\n              !store.isApplyingLargeTimelineBatch"), "iOS open-to-latest must wait until rows are renderable and large-batch masking has finished")
    try assert(mobileTimeline.contains("pendingOpenBottomSessionID = nil"), "iOS open-to-latest must consume the pending request only after rows are renderable")
    try assert(mobileTimeline.contains("for delay in [0.04, 0.12, 0.22]"), "iOS opening a chat must use short bottom settle passes without late visible jumps")
    try assert(!mobileTimeline.contains("historyLoadSuppressedUntil = Date.distantPast\n                    visibleRowLimit"), "iOS opening a chat must not immediately re-enable top-edge history loading")
    try assert(!mobileIngestBlock.contains("scrollRevision += 1"), "iOS streamed events must not request bottom scrolling")
    try assert(mobileStore.contains("syncSelectedRunningState()\n        scrollRevision += 1\n        do {"), "iOS user sends must still scroll the timeline to the bottom")
}

func checkQueuedRemovalDisappears() throws {
    let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
    let macStore = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/State/AppStore.swift"), encoding: .utf8)
    let mobileStore = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDockIOS/State/MobileAppStore.swift"), encoding: .utf8)
    let server = try String(contentsOf: cwd.appendingPathComponent("server/agent_server.py"), encoding: .utf8)

    try assert(macStore.contains("var pendingQueuedTurns: [ZQueuedTurn]"), "Mac queue shelf must use authoritative queued turns instead of timeline event inference")
    try assert(macStore.contains("queuedTurnsBySessionID"), "Mac store must keep queue state separate from the timeline window")
    try assert(macStore.contains("applyAuthoritativeQueuedTurns"), "Mac session refresh must reconcile stale queued rows from server queue state")
    try assert(macStore.contains("queuedTurnsBySessionID[sessionID] != nil"), "Mac cached-fresh skips must still fetch once when authoritative queue state is unknown")
    try assert(macStore.contains("case \"turn_queued\":\n                return false"), "Mac timeline must keep pending queued turns out of the timeline")
    try assert(macStore.contains("\"turn_queue_updated\""), "Mac timeline must hide queue metadata events")
    try assert(macStore.contains("\"turn_stopped\""), "Mac timeline must hide stop events from Send Now interruptions")
    try assert(!macStore.contains("queuedTurnIDs.contains(queuedID)"), "Mac timeline must render queued turn_started prompts as user messages")
    try assert(macStore.contains("events.removeAll { $0.type == \"turn_queued\" && $0.queued_id == queuedID }"), "Mac unqueue should remove the queued row locally after server success")
    try assert(macStore.contains("func runQueuedNow"), "Mac store must support interrupting the current run for a queued turn")
    try assert(macStore.contains("func moveQueued"), "Mac store must support queue reordering")
    try assert(macStore.contains("func updateQueued"), "Mac store must support editing queued prompts")
    try assert(macStore.contains("func handleStaleQueuedTurn"), "Mac store must silently reconcile stale queued rows")
    try assert(macStore.contains("isQueuedTurnNotFound(error)"), "Mac stale queued rows must be detected without showing a modal")
    try assert(macStore.contains("ns.code == 404") && macStore.contains("message.localizedCaseInsensitiveContains(\"not found\")"), "Mac queue actions must treat generic 404 queue rows as stale local cache")
    try assert(macStore.contains("let event: ZEvent?"), "Mac turn responses must decode accepted timeline events")
    try assert(macStore.contains("applyAcceptedTurnEvent(res.event, sessionID:"), "Mac sends must render accepted queued/started events without waiting for websocket delivery")
    try assert(macStore.contains("clearSubmittedPromptIfCurrent(submittedPrompt: submittedPrompt, trimmed: trimmed)"), "Mac send success must clear a stale submitted draft after queued sends")
    try assert(macStore.contains("prompt.trimmingCharacters(in: .whitespacesAndNewlines) == trimmed"), "Mac draft clearing must not wipe a newer prompt typed during submit")
    try assert(mobileStore.contains("events.removeAll { $0.type == \"turn_queued\" && $0.queued_id == queuedID }"), "iOS unqueue should remove queued rows locally after server success")
    try assert(mobileStore.contains("func runQueuedNow"), "iOS store must support interrupting the current run for a queued turn")
    try assert(mobileStore.contains("func moveQueued"), "iOS store must support queue reordering")
    try assert(mobileStore.contains("func updateQueued"), "iOS store must support editing queued prompts")
    try assert(mobileStore.contains("func handleStaleQueuedTurn"), "iOS store must silently reconcile stale queued rows")
    try assert(mobileStore.contains("isQueuedTurnNotFound(error)"), "iOS stale queued rows must be detected without showing an alert")
    try assert(mobileStore.contains("ns.code == 404") && mobileStore.contains("message.localizedCaseInsensitiveContains(\"not found\")"), "iOS queue actions must treat generic 404 queue rows as stale local cache")
    try assert(mobileStore.contains("let event: ZEvent?"), "iOS turn responses must decode accepted timeline events")
    try assert(mobileStore.contains("applyAcceptedTurnEvent(res.event, sessionID:"), "iOS sends must render accepted queued/started events without waiting for websocket delivery")
    try assert(mobileStore.contains("clearSubmittedPromptIfCurrent(submittedPrompt: submittedPrompt, trimmed: trimmed)"), "iOS send success must clear a stale submitted draft after queued sends")
    try assert(server.contains("RUN_NOW_TURNS"), "Server Send Now must reserve the exact queued item instead of relying on queue order")
    try assert(server.contains("stop_turn(session_id, emit_event=False, schedule_queue=False)"), "Server Send Now must silently interrupt without appending visible stop cards")
    try assert(server.contains("\"event\": queued_event"), "Server queued sends must return the turn_queued event to the app")
    try assert(server.contains("\"event\": started_event"), "Server started sends must return the turn_started event to the app")
    try assert(server.contains("\"queued_turns\": await queued_turns_snapshot(session_id)"), "Server session responses must include authoritative pending queue state")
    try assert(server.contains("schedule_rebuilt_queued_turns") && server.contains("queue_drains"), "Server startup must schedule rebuilt queues to drain")
    try assert(server.contains("def should_schedule_queue_after_finish") && server.contains("return not stopped or session_id in RUN_NOW_TURNS"), "Server plain Stop must leave queued turns pending while Send Now still drains the reserved item")
}

func checkPromptImageAttachments() throws {
    let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
    let macStore = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/State/AppStore.swift"), encoding: .utf8)
    let mobileStore = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDockIOS/State/MobileAppStore.swift"), encoding: .utf8)
    let macTimeline = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/Views/TimelineView.swift"), encoding: .utf8)
    let macEvents = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/Views/EventViews.swift"), encoding: .utf8)
    let mobileEvents = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDockIOS/Views/MobileEventViews.swift"), encoding: .utf8)
    let composer = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/Views/ComposerView.swift"), encoding: .utf8)

    try assert(macStore.contains("func promptFiles(for event: ZEvent)"), "Mac store must resolve turn file_ids into prompt attachments")
    try assert(mobileStore.contains("func promptFiles(for event: ZEvent)"), "iOS store must resolve turn file_ids into prompt attachments")
    try assert(macTimeline.contains("MessageAttachment(file: $0, url: store.fileURL($0))"), "Mac timeline must pass prompt attachments into user bubbles")
    try assert(macEvents.contains("MessageAttachmentStrip"), "Mac user bubbles must render prompt attachments")
    try assert(macEvents.contains("attachment.file.content_type?.hasPrefix(\"image/\") == true"), "Mac prompt attachments must render image thumbnails")
    try assert(mobileEvents.contains("MobileMessageAttachmentStrip"), "iOS user bubbles must render prompt attachments")
    try assert(mobileEvents.contains("attachment.file.content_type?.hasPrefix(\"image/\") == true"), "iOS prompt attachments must render image thumbnails")
    try assert(composer.contains("override func paste"), "Mac composer must intercept pasteboard images")
    try assert(composer.contains("override func validateUserInterfaceItem"), "Mac composer must keep Paste enabled for image-only clipboards")
    try assert(composer.contains("override func performKeyEquivalent"), "Mac composer must catch Command-V for image-only clipboards")
    try assert(composer.contains("NSImage(pasteboard: pasteboard)"), "Mac composer must read raw image data from the pasteboard")
    try assert(composer.contains("UTType(type.rawValue)"), "Mac composer must accept typed image pasteboard data, not only NSImage pasteboard decoding")
    try assert(composer.contains("utType.conforms(to: .image)"), "Mac composer must detect PNG/JPEG/TIFF/HEIC-style clipboard images")
    try assert(composer.contains("item.data(forType: type)"), "Mac composer must inspect per-item pasteboard image data")
    try assert(composer.contains("ZenithDockPasteboardImages"), "Mac composer must persist pasted images before upload")
}

func checkMobileVideoDownloads() throws {
    let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
    let mobileEvents = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDockIOS/Views/MobileEventViews.swift"), encoding: .utf8)
    let mobileOptions = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDockIOS/Views/MobileChatOptionsView.swift"), encoding: .utf8)

    try assert(mobileEvents.contains("struct MobileArtifactShareButton"), "iOS must expose a native artifact download/share button")
    try assert(mobileEvents.contains("MobileActivityView(activityItems: [item.url])"), "iOS download button must open the native activity sheet with a local file")
    try assert(mobileEvents.contains("MobileArtifactDragFileCache.shared.localFile"), "iOS download must cache remote videos/files locally before sharing")
    try assert(mobileEvents.contains("struct MobileActivityView: UIViewControllerRepresentable"), "iOS download must use UIActivityViewController")
    try assert(mobileOptions.contains("MobileArtifactShareButton(file: file, url: url"), "iOS files/videos panel must expose download/share controls")
    try assert(mobileEvents.contains(".aspectRatio(16.0 / 9.0, contentMode: .fit)"), "iOS timeline videos must use a stable letterboxed wide-video frame")
    try assert(mobileOptions.contains(".aspectRatio(16.0 / 9.0, contentMode: .fit)"), "iOS video grid thumbnails must use a stable letterboxed wide-video frame")
    try assert(mobileEvents.contains(".scaledToFit()"), "iOS timeline video thumbnails must not crop ultra-wide videos")
    try assert(mobileOptions.contains(".scaledToFit()"), "iOS video grid thumbnails must not crop ultra-wide videos")
}

func checkTmuxSubmitterVisualizer() throws {
    let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
    let core = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithCore/ZenithCore.swift"), encoding: .utf8)
    let macStore = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/State/AppStore.swift"), encoding: .utf8)
    let inspector = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/Views/InspectorView.swift"), encoding: .utf8)
    let server = try String(contentsOf: cwd.appendingPathComponent("server/agent_server.py"), encoding: .utf8)

    try assert(core.contains("struct ZTmuxPane"), "Core must model tmux pane rows")
    try assert(core.contains("struct ZTmuxCapture"), "Core must model captured tmux pane output")
    try assert(server.contains("@app.get(\"/api/sessions/{session_id}/tmux\")"), "Server must expose a tmux pane listing endpoint")
    try assert(server.contains("@app.get(\"/api/sessions/{session_id}/tmux/capture\")"), "Server must expose a tmux pane capture endpoint")
    try assert(server.contains("TMUX_SUBMITTER_KEYWORDS"), "Server tmux listing must identify likely submitter panes")
    try assert(server.contains("meaningful_chat_cwd"), "Server tmux listing must ignore broad home/default cwd matches")
    try assert(server.contains("TMUX_CHAT_MATCH_LABELS"), "Server tmux listing must distinguish chat-linked panes from machine-wide panes")
    try assert(server.contains("TMUX_CHAT_MATCH_LABELS = {\"chat tmux\", \"chat target\"}"), "Default tmux listing must not treat shared cwd as a chat link")
    try assert(server.contains("tmux_explicit_chat_targets"), "Server tmux listing must derive default matches from explicit tmux targets")
    try assert(!server.contains("TMUX_CONTEXT_TOKEN_RE"), "Default tmux listing must not mine broad chat text tokens")
    try assert(server.contains("if not include_all and not chat_linked"), "Default tmux listing must not include unrelated submitters")
    try assert(macStore.contains("refreshSelectedTmuxPanes"), "Mac store must load tmux panes on demand")
    try assert(macStore.contains("captureTmuxPane"), "Mac store must capture tmux pane output on demand")
    try assert(inspector.contains("TmuxSubmitterInspector"), "Mac inspector must render the tmux submitter visualizer")
    try assert(inspector.contains("Inspect Tmux Submitters"), "Mac inspector must keep tmux inspection explicit/on demand")
    try assert(inspector.contains("not just panes linked to this chat"), "Mac tmux inspector must label the All toggle as machine-wide")
}

func checkExportCompliancePlists() throws {
    let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
    let iosPlist = try String(contentsOf: cwd.appendingPathComponent("Apps/ZenithDockIOS/Info.plist"), encoding: .utf8)
    let macPlist = try String(contentsOf: cwd.appendingPathComponent("Apps/ZenithDockMac/Info.plist"), encoding: .utf8)
    let key = "<key>ITSAppUsesNonExemptEncryption</key>"
    let value = "<false/>"

    try assert(iosPlist.contains(key), "iOS Info.plist must declare TestFlight encryption compliance")
    try assert(iosPlist.contains(value), "iOS Info.plist must mark non-exempt encryption as false")
    try assert(macPlist.contains(key), "macOS Info.plist must declare TestFlight encryption compliance")
    try assert(macPlist.contains(value), "macOS Info.plist must mark non-exempt encryption as false")
}

func checkAgentHTTPTransportPlists() throws {
    let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
    let iosPlist = try String(contentsOf: cwd.appendingPathComponent("Apps/ZenithDockIOS/Info.plist"), encoding: .utf8)
    let macPlist = try String(contentsOf: cwd.appendingPathComponent("Apps/ZenithDockMac/Info.plist"), encoding: .utf8)

    for (label, plist) in [("iOS", iosPlist), ("macOS", macPlist)] {
        try assert(plist.contains("<key>NSAllowsArbitraryLoads</key>"), "\(label) Info.plist must allow arbitrary user-entered agent HTTP URLs")
        try assert(!plist.contains("<key>NSExceptionDomains</key>"), "\(label) Info.plist must not regress to hard-coded ATS IP exceptions")
        try assert(!plist.contains("<key>NSAllowsLocalNetworking</key>"), "\(label) Info.plist must avoid scoped ATS keys that can make broad HTTP allowance brittle")
        try assert(!plist.contains("10.112.") && !plist.contains("100.88.") && !plist.contains("100.73."), "\(label) Info.plist must not ship lab/Tailscale IP literals")
    }

    try assert(iosPlist.contains("<key>NSLocalNetworkUsageDescription</key>"), "iOS Info.plist must explain Local Network access")
    try assert(iosPlist.contains("local network or Tailscale"), "iOS Local Network prompt must mention the private agent route")
    try assert(macPlist.contains("<key>NSLocalNetworkUsageDescription</key>"), "macOS Info.plist must explain Local Network access")
    try assert(macPlist.contains("local network or Tailscale"), "macOS Local Network prompt must mention the private agent route")
}

func checkInspectorCollapseAndPins() throws {
    let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
    let root = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/Views/RootView.swift"), encoding: .utf8)
    let timeline = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/Views/TimelineView.swift"), encoding: .utf8)
    let eventViews = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/Views/EventViews.swift"), encoding: .utf8)
    let inspector = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/Views/InspectorView.swift"), encoding: .utf8)
    let app = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/ZenithDockApp.swift"), encoding: .utf8)
    let macStore = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/State/AppStore.swift"), encoding: .utf8)

    try assert(root.contains("@AppStorage(\"rightInspectorVisible\")"), "Mac root must persist right-inspector visibility")
    try assert(root.contains("navigationSplitViewColumnWidth(min: 0, ideal: 0, max: 0)"), "Hidden right inspector must release its column width")
    try assert(timeline.contains("inspectorToggleButton"), "Mac header must expose a right-panel toggle")
    try assert(app.contains("@AppStorage(\"rightInspectorVisible\")") && app.contains(".keyboardShortcut(\"l\", modifiers: .command)"), "Mac app must toggle the right panel with Cmd-L")
    try assert(macStore.contains("struct PinnedTimelineItem"), "Mac store must model pinned timeline items")
    try assert(macStore.contains("pinnedItemsDefaultsKey(namespace: serverCacheNamespace)"), "Pinned items must be scoped by canonical server namespace")
    try assert(macStore.contains("migrateLocalServerState") && macStore.contains("oldPinnedKey"), "Pinned items must migrate when server identity is adopted")
    try assert(timeline.contains("isPinned: store.isPinned(event)"), "Mac timeline event cards must receive pin state")
    try assert(eventViews.contains("onTogglePin") && timeline.contains("onTogglePin: { event in"), "Mac timeline must wire event pin actions")
    try assert(inspector.contains("PinnedItemsInspector"), "Mac inspector must show a pinned shelf")
    try assert(inspector.contains("store.revealPinnedItem(item)"), "Pinned shelf must support finding pins in chat")
    try assert(inspector.contains("store.togglePin(file)"), "Mac files/videos inspector must support pinning files")
}

func checkMacChatKeyboardNavigation() throws {
    let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
    let app = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/ZenithDockApp.swift"), encoding: .utf8)
    let macStore = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/State/AppStore.swift"), encoding: .utf8)

    try assert(app.contains("Button(\"Next Chat\")"), "Mac app must expose a Next Chat command")
    try assert(app.contains(".keyboardShortcut(.tab, modifiers: [.control])"), "Next Chat must use Ctrl-Tab")
    try assert(app.contains("Button(\"Previous Chat\")"), "Mac app must expose a Previous Chat command")
    try assert(app.contains(".keyboardShortcut(.tab, modifiers: [.control, .shift])"), "Previous Chat must use Ctrl-Shift-Tab")
    try assert(macStore.contains("var sidebarNavigationSessions: [ZSession]"), "Mac store must expose sidebar-ordered navigation sessions")
    try assert(macStore.contains("for folder in folderNames where !isFolderCollapsed(folder)"), "Mac chat keyboard navigation must respect collapsed folders")
    try assert(macStore.contains("func selectAdjacentSession(direction: Int) async"), "Mac store must provide adjacent chat selection")
    try assert(macStore.contains("await select(sessionID: visibleSessions[nextIndex].id)"), "Adjacent chat selection must reuse the normal select path")
}

func checkHandoffDigestUsesLLM() throws {
    let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
    let server = try String(contentsOf: cwd.appendingPathComponent("server/agent_server.py"), encoding: .utf8)
    let macStore = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/State/AppStore.swift"), encoding: .utf8)
    let mobileStore = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDockIOS/State/MobileAppStore.swift"), encoding: .utf8)
    let macSheet = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/Views/SessionManagementSheets.swift"), encoding: .utf8)
    let mobileSheet = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDockIOS/Views/MobileChatOptionsView.swift"), encoding: .utf8)
    let macEvents = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/Views/EventViews.swift"), encoding: .utf8)
    let mobileEvents = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDockIOS/Views/MobileEventViews.swift"), encoding: .utf8)

    try assert(server.contains("async def build_handoff_digest("), "Server handoff digest must be async so it can run an LLM summarizer")
    try assert(server.contains("build_handoff_source_pack"), "Server may build a source pack, but only as LLM input")
    try assert(server.contains("run_claude_handoff_summarizer") && server.contains("run_codex_handoff_summarizer"), "Server digest must support real LLM summarizers")
    try assert(server.contains("return await build_handoff_digest("), "Digest endpoint must await the LLM digest path")
    try assert(server.contains("@app.post(\"/api/sessions/{session_id}/digest/send\")"), "Server must expose a background digest-send endpoint")
    try assert(server.contains("asyncio.create_task(run_handoff_digest_send"), "Digest send must run in a server-owned background task")
    try assert(server.contains("purpose=\"handoff_digest\""), "Digest send must create a tagged source-chat turn")
    try assert(server.contains("wait_for_digest_turn_result"), "Digest send must wait for the source-chat digest turn before forwarding")
    try assert(server.contains("source_digest_display_prompt"), "Digest send must use a short visible source-chat prompt instead of dumping internal instructions into the timeline")
    try assert(server.contains("\"handoff_digest_sent\"") && server.contains("\"handoff_digest_error\""), "Server must emit source-chat digest completion/error events")
    try assert(!server.contains("return build_handoff_digest(session_id, detail=req.detail, user_prompt=req.user_prompt)"), "Digest endpoint must not return the deterministic source pack directly")
    try assert(macStore.contains("target_session_id: targetSessionID"), "Mac digest requests must pass the selected target chat")
    try assert(mobileStore.contains("target_session_id: targetSessionID"), "iOS digest requests must pass the selected target chat")
    try assert(macStore.contains("\"/api/sessions/\\(sourceSessionID)/digest/send\""), "Mac Send to Chat must call the background digest-send endpoint")
    try assert(mobileStore.contains("\"/api/sessions/\\(sourceSessionID)/digest/send\""), "iOS Send to Chat must call the background digest-send endpoint")
    try assert(macSheet.contains("@State private var detail = \"normal\""), "Mac digest sheet must default to normal LLM context depth")
    try assert(mobileSheet.contains("@State private var detail = \"normal\""), "iOS digest sheet must default to normal LLM context depth")
    try assert(macSheet.contains("Summarizing with LLM") && mobileSheet.contains("Summarizing with LLM"), "Digest preview UI must disclose that creation is an LLM summarization step")
    try assert(macSheet.contains("Starting background digest") && mobileSheet.contains("Starting background digest"), "Digest send UI must not block on the whole LLM summary")
    try assert(macSheet.contains("Digest running in source chat"), "Mac digest send must keep the user oriented on the source chat")
    try assert(!macSheet.contains("await store.select(sessionID: targetSessionID)") && !mobileSheet.contains("await store.select(sessionID: targetSessionID)"), "Digest send must not jump to the target chat before the source turn runs")
    try assert(macEvents.contains("isDigestTurn") && macEvents.contains("isDigest"), "Mac timeline must render tagged digest turns distinctly")
    try assert(mobileEvents.contains("isDigestTurn") && mobileEvents.contains("queued: isDigest"), "iOS timeline must render tagged digest turns distinctly")
}

func checkMacTimelineScrollPerformanceGuards() throws {
    let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
    let macStore = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/State/AppStore.swift"), encoding: .utf8)
    let inspector = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/Views/InspectorView.swift"), encoding: .utf8)
    let timeline = try String(contentsOf: cwd.appendingPathComponent("Sources/ZenithDock/Views/TimelineView.swift"), encoding: .utf8)

    try assert(macStore.contains("@Published private(set) var sessionVideos: [ZFile] = []"), "Mac store must cache selected-session videos instead of deriving them during render")
    try assert(!macStore.contains("var sessionVideos: [ZFile] {\n        mergedFiles"), "Mac sessionVideos must not be a merge/sort computed getter")
    try assert(inspector.contains("private var videos: [ZFile] {\n        store.sessionVideos\n    }"), "Files inspector must use cached video ordering")
    try assert(!inspector.contains("sortedLatestFirst("), "Files inspector must not sort media lists during ordinary body updates")
    try assert(timeline.contains("let minimumInterval = 0.14"), "Timeline scroll observer reports must be throttled enough to avoid bottom-scroll churn")

    guard let boundsStart = timeline.range(of: "forName: NSView.boundsDidChangeNotification"),
          let boundsEnd = timeline.range(of: "scrollView.postsFrameChangedNotifications", range: boundsStart.upperBound..<timeline.endIndex) else {
        throw GuardrailFailure.failed("Timeline bounds observer block not found")
    }
    let boundsBlock = timeline[boundsStart.lowerBound..<boundsEnd.lowerBound]
    try assert(!boundsBlock.contains("clampAttachedScrollViewIfNeeded"), "Bounds-change observer must not manually clamp on every scroll tick")

    guard let bottomStart = timeline.range(of: "private func scrollDocumentToBottom()"),
          let bottomEnd = timeline.range(of: "private func scheduleVisibleOriginRestore", range: bottomStart.upperBound..<timeline.endIndex) else {
        throw GuardrailFailure.failed("Timeline bottom scroll function not found")
    }
    let bottomBlock = timeline[bottomStart.lowerBound..<bottomEnd.lowerBound]
    try assert(!bottomBlock.contains("layoutSubtreeIfNeeded()"), "Bottom-scroll chase must not force full layout on every retry")
}

do {
    try checkTextPresenceGateBehavior()
    try checkComposerUsesPresenceGate()
    try checkComposerDraftPersistence()
    try checkEndpointCacheKeysAreServerScoped()
    try checkRuntimeDefaultLabels()
    try checkBackendLocksAfterProviderStart()
    try checkClaudeResumeFailureDoesNotPoisonSession()
    try checkServerURLNormalization()
    try checkShellCopyNormalization()
    try checkCodeBlockCopyUsesFullText()
    try checkMessageFoldingThresholds()
    try checkTimelineMessageTimestamps()
    try checkArchiveSessionBehavior()
    try checkFolderSectionControls()
    try checkMobileDoesNotAutoSelectFirstChat()
    try checkTimelineRevealWaitsForLatestSnapshot()
    try checkConnectionFailuresDoNotModal()
    try checkLaunchDeferredIsInline()
    try checkVideoMetadataIsNotHiddenByMixedFilePaging()
    try checkRuntimeAutosavesAndBackendIcons()
    try checkJobIntervalPresets()
    try checkTimelineCombinesRunTraces()
    try checkFlexibleEventOutputDecoding()
    try checkInlineVideoPlayAutoplays()
    try checkCodeReviewSurfaceIsStructured()
    try checkUnreadMessageMarker()
    try checkTimelineHistoryPaging()
    try checkLiveTimelineAutoFollow()
    try checkQueuedRemovalDisappears()
    try checkPromptImageAttachments()
    try checkMobileVideoDownloads()
    try checkTmuxSubmitterVisualizer()
    try checkExportCompliancePlists()
    try checkAgentHTTPTransportPlists()
    try checkInspectorCollapseAndPins()
    try checkMacChatKeyboardNavigation()
    try checkHandoffDigestUsesLLM()
    try checkMacTimelineScrollPerformanceGuards()
    print("ZenithGuardrails passed")
} catch {
    fputs("ZenithGuardrails failed: \(error)\n", stderr)
    exit(1)
}
