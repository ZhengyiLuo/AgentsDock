import AppKit
import SwiftUI
import ZenithCore

struct ComposerView: View {
    @EnvironmentObject private var store: AppStore
    @Binding var importerOpen: Bool
    @State private var draftPrompt = ""
    @State private var editorResetID = 0
    @State private var editorSubmitRevision = 0
    @State private var editorHasVisibleText = false
    @State private var isAttachmentDropTargeted = false

    var body: some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 7) {
                if !store.uploads.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(store.uploads) { file in
                                UploadChip(file: file, url: store.fileURL(file)) {
                                    store.removeUpload(file)
                                }
                            }
                        }
                        .padding(.horizontal, 2)
                    }
                }

                if !store.pendingQueuedEvents.isEmpty {
                    QueuedTurnShelf()
                }

                StablePromptEditor(
                    text: $draftPrompt,
                    isEditable: store.selectedSession != nil,
                    resetID: editorResetID,
                    submitRevision: editorSubmitRevision
                ) {
                    sendDraft($0)
                } onDropFiles: { urls in
                    uploadDroppedFiles(urls)
                } onTextPresenceChange: { hasText in
                    if editorHasVisibleText != hasText {
                        editorHasVisibleText = hasText
                    }
                }
                .equatable()
                .frame(height: promptHeight)
                .overlay(alignment: .topLeading) {
                    if !editorHasVisibleText {
                        Text("Message")
                            .foregroundStyle(.tertiary)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 6)
                            .allowsHitTesting(false)
                    }
                }

                commandBar
            }
            .padding(.horizontal, 10)
            .padding(.top, 8)
            .padding(.bottom, 7)
            .background(
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .fill(Theme.card)
            )
            .overlay {
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .stroke(isAttachmentDropTargeted ? Color.accentColor.opacity(0.80) : Theme.line, lineWidth: isAttachmentDropTargeted ? 2 : 1)
            }
            .overlay {
                if isAttachmentDropTargeted {
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .strokeBorder(Color.accentColor.opacity(0.85), style: StrokeStyle(lineWidth: 2, dash: [7, 5]))
                        .allowsHitTesting(false)
                }
            }
            .onDrop(of: TimelineFileDrop.supportedTypes, isTargeted: $isAttachmentDropTargeted) { providers in
                acceptAttachmentDrop(providers)
            }
            .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .background(Theme.panel)
        .fixedSize(horizontal: false, vertical: true)
        .onChange(of: store.selectedSessionID) {
            draftPrompt = ""
            editorHasVisibleText = false
            editorResetID += 1
        }
    }

    private var promptHeight: CGFloat {
        store.pendingQueuedEvents.isEmpty ? 58 : 44
    }

    @ViewBuilder
    private var commandBar: some View {
        HStack(spacing: 8) {
            Button {
                importerOpen = true
            } label: {
                Image(systemName: "plus")
                    .font(.system(size: 15, weight: .medium))
                    .frame(width: 27, height: 27)
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .foregroundStyle(store.selectedSession == nil ? .tertiary : .secondary)
            .disabled(store.selectedSession == nil)
            .help("Attach files")

            if let session = store.selectedSession {
                backendMenu(for: session)
                runtimeMenu(for: session)
            }

            Spacer(minLength: 8)

            if store.isRunning {
                ComposerActivityIndicator(backend: store.selectedSession?.backend ?? "agent") {
                    Task { await store.stop() }
                }
                .transition(.opacity.combined(with: .scale(scale: 0.96)))
            }

            Image(systemName: "mic")
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(.tertiary)
                .frame(width: 24, height: 24)
                .help("Voice input is not enabled")

            Button {
                editorSubmitRevision += 1
            } label: {
                Image(systemName: "arrow.up")
                    .font(.system(size: 15, weight: .bold))
                    .frame(width: 29, height: 29)
                    .background(canSend ? Color.accentColor : Color.secondary.opacity(0.18))
                    .foregroundStyle(canSend ? Color.white : Color.secondary)
                    .clipShape(Circle())
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .disabled(!canSend)
            .help(store.isRunning ? "Queue message" : "Send message")
        }
        .frame(minHeight: 31)
    }

    private var canSend: Bool {
        store.selectedSession != nil && editorHasVisibleText
    }

    @ViewBuilder
    private func backendMenu(for session: ZSession) -> some View {
        if session.isBackendLocked {
            composerBackendChip(session.backend)
                .help("Backend is locked after chat starts. Fork or create a new chat to use another backend.")
        } else {
            backendPickerMenu(for: session)
        }
    }

    private func backendPickerMenu(for session: ZSession) -> some View {
        Menu {
            Button {
                setBackend("claude")
            } label: {
                optionLabel("Claude", selected: session.backend == "claude")
            }
            Button {
                setBackend("codex")
            } label: {
                optionLabel("Codex", selected: session.backend == "codex")
            }
        } label: {
            composerBackendChip(session.backend)
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .help("Backend")
    }

    private func runtimeMenu(for session: ZSession) -> some View {
        Menu {
            Section("Model") {
                ForEach(modelOptions(for: session)) { option in
                    Button {
                        setModel(option.value)
                    } label: {
                        optionLabel(option.label, selected: selected(session.model, matches: option.value))
                    }
                }
            }

            Section("Effort") {
                ForEach(effortOptions(for: session)) { option in
                    Button {
                        setEffort(option.value)
                    } label: {
                        optionLabel(option.label, selected: selected(session.effort, matches: option.value))
                    }
                }
            }
        } label: {
            composerChip(
                icon: "gauge.with.dots.needle.67percent",
                text: runtimeBarLabel(for: session),
                tint: .primary,
                trailingChevron: true
            )
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize(horizontal: true, vertical: false)
        .help(store.runtimeCatalog.compactSummary(for: session))
    }

    private func composerChip(icon: String, text: String, tint: Color, trailingChevron: Bool = false) -> some View {
        HStack(spacing: 5) {
            Image(systemName: icon)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(tint)
            Text(text)
                .font(.caption.weight(.semibold))
                .lineLimit(1)
                .truncationMode(.tail)
            if trailingChevron {
                Image(systemName: "chevron.down")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(.tertiary)
            }
        }
        .foregroundStyle(.secondary)
        .padding(.horizontal, 9)
        .frame(height: 27)
        .background(Color.primary.opacity(0.055))
        .clipShape(Capsule())
        .overlay {
            Capsule()
                .stroke(Color.primary.opacity(0.07), lineWidth: 1)
        }
    }

    private func composerBackendChip(_ backend: String) -> some View {
        HStack(spacing: 5) {
            BackendLogo(backend: backend, size: 13)
            Text(backend.capitalized)
                .font(.caption.weight(.semibold))
                .lineLimit(1)
                .truncationMode(.tail)
        }
        .foregroundStyle(.secondary)
        .padding(.horizontal, 9)
        .frame(height: 27)
        .background(Color.primary.opacity(0.055))
        .clipShape(Capsule())
        .overlay {
            Capsule()
                .stroke(Color.primary.opacity(0.07), lineWidth: 1)
        }
    }

    private func optionLabel(_ text: String, selected: Bool) -> some View {
        Label(text, systemImage: selected ? "checkmark" : "circle")
    }

    private func runtimeLabel(for session: ZSession) -> String {
        let model = store.runtimeCatalog.modelLabel(session.model, backend: session.backend)
        let effort = store.runtimeCatalog.effortLabel(session.effort, backend: session.backend)
        let compactModel = model == "Default" ? "" : model
        let compactEffort = effort == "Default" ? "" : effort
        return [compactModel, compactEffort].filter { !$0.isEmpty }.joined(separator: " · ")
    }

    private func runtimeBarLabel(for session: ZSession) -> String {
        let label = runtimeLabel(for: session)
        let compact = label
            .replacingOccurrences(of: "Server default (", with: "")
            .replacingOccurrences(of: ")", with: "")
            .replacingOccurrences(of: "Extra High", with: "XHigh")
        return compact.isEmpty ? "Runtime" : compact
    }

    private func modelOptions(for session: ZSession) -> [ZRuntimeOption] {
        optionsWithCurrent(store.runtimeCatalog.models(for: session.backend), current: session.model)
    }

    private func effortOptions(for session: ZSession) -> [ZRuntimeOption] {
        optionsWithCurrent(store.runtimeCatalog.efforts(for: session.backend), current: session.effort)
    }

    private func optionsWithCurrent(_ options: [ZRuntimeOption], current: String?) -> [ZRuntimeOption] {
        let clean = current?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !clean.isEmpty, !options.contains(where: { $0.value == clean }) else {
            return options
        }
        return options + [ZRuntimeOption(value: clean, label: clean)]
    }

    private func selected(_ current: String?, matches value: String) -> Bool {
        (current?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "") == value
    }

    private func setBackend(_ backend: String) {
        guard store.selectedSession?.backend != backend else { return }
        Task { await store.updateSelected(backend: backend, model: "", effort: "") }
    }

    private func setModel(_ model: String) {
        guard store.selectedSession != nil else { return }
        Task { await store.updateSelected(model: ZRuntimeCatalog.cleanForAPI(model)) }
    }

    private func setEffort(_ effort: String) {
        guard store.selectedSession != nil else { return }
        Task { await store.updateSelected(effort: ZRuntimeCatalog.cleanForAPI(effort)) }
    }

    private func sendDraft(_ submitted: String) {
        guard !submitted.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        draftPrompt = ""
        editorHasVisibleText = false
        editorResetID += 1
        Task {
            let accepted = await store.sendPrompt(submitted)
            if !accepted {
                await MainActor.run {
                    if draftPrompt.isEmpty {
                        draftPrompt = submitted
                        editorHasVisibleText = true
                        editorResetID += 1
                    }
                }
            }
        }
    }

    private func acceptAttachmentDrop(_ providers: [NSItemProvider]) -> Bool {
        guard store.selectedSessionID != nil else { return false }
        Task {
            let urls = await TimelineFileDrop.urls(from: providers)
            guard !urls.isEmpty else { return }
            await store.upload(urls: urls)
        }
        return true
    }

    private func uploadDroppedFiles(_ urls: [URL]) {
        guard store.selectedSessionID != nil, !urls.isEmpty else { return }
        Task { await store.upload(urls: urls) }
    }
}

private struct ComposerActivityIndicator: View {
    var backend: String
    var stop: () -> Void

    var body: some View {
        HStack(spacing: 6) {
            ProgressView()
                .controlSize(.small)
                .scaleEffect(0.68)
                .frame(width: 13, height: 13)
            Button(role: .destructive) {
                stop()
            } label: {
                Image(systemName: "stop.fill")
                    .font(.system(size: 10, weight: .bold))
                    .frame(width: 18, height: 18)
                    .background(Color.primary.opacity(0.08))
                    .clipShape(Circle())
            }
            .buttonStyle(.plain)
            .help("Stop current turn")
        }
        .foregroundStyle(backend == "codex" ? .orange : .blue)
        .help("\(backend.capitalized) is running. New sends will queue.")
    }
}

private struct QueuedTurnShelf: View {
    @EnvironmentObject private var store: AppStore

    var body: some View {
        VStack(alignment: .trailing, spacing: 6) {
            HStack(spacing: 6) {
                Image(systemName: "text.line.last.and.arrowtriangle.forward")
                Text("Queued \(store.pendingQueuedEvents.count)")
            }
            .font(.caption.weight(.semibold))
            .foregroundStyle(.secondary)

            ScrollView {
                VStack(alignment: .trailing, spacing: 6) {
                    ForEach(store.pendingQueuedEvents) { event in
                        QueuedTurnRow(event: event)
                    }
                }
            }
            .frame(height: shelfHeight)
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
        .fixedSize(horizontal: false, vertical: true)
    }

    private var shelfHeight: CGFloat {
        min(CGFloat(store.pendingQueuedEvents.count) * 38, 128)
    }
}

private struct QueuedTurnRow: View {
    @EnvironmentObject private var store: AppStore
    let event: ZEvent
    @State private var editOpen = false
    @State private var draft = ""

    var body: some View {
        HStack(alignment: .center, spacing: 8) {
            Image(systemName: "text.line.last.and.arrowtriangle.forward")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.yellow)
            Text(store.queuedPrompt(for: event))
                .font(.caption)
                .foregroundStyle(.primary)
                .lineLimit(2)
                .multilineTextAlignment(.leading)
                .frame(maxWidth: 420, alignment: .leading)

            Button {
                Task { await store.runQueuedNow(event) }
            } label: {
                Label("Send Now", systemImage: "arrow.turn.down.right")
            }
            .labelStyle(.titleAndIcon)
            .buttonStyle(.borderless)
            .help("Interrupt the current turn and send this queued message now")

            Button {
                Task { await store.moveQueued(event, direction: "up") }
            } label: {
                Image(systemName: "arrow.up")
            }
            .buttonStyle(.borderless)
            .help("Move queued message up")

            Button {
                Task { await store.moveQueued(event, direction: "down") }
            } label: {
                Image(systemName: "arrow.down")
            }
            .buttonStyle(.borderless)
            .help("Move queued message down")

            Button {
                Task { await store.unqueue(event) }
            } label: {
                Image(systemName: "trash")
            }
            .buttonStyle(.borderless)
            .help("Remove from queue")

            Menu {
                Button("Edit Message") {
                    draft = store.queuedPrompt(for: event)
                    editOpen = true
                }
                Button("Send Now") {
                    Task { await store.runQueuedNow(event) }
                }
                Divider()
                Button("Move Up") {
                    Task { await store.moveQueued(event, direction: "up") }
                }
                Button("Move Down") {
                    Task { await store.moveQueued(event, direction: "down") }
                }
                Divider()
                Button("Remove", role: .destructive) {
                    Task { await store.unqueue(event) }
                }
            } label: {
                Image(systemName: "ellipsis")
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .fixedSize()
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .frame(minHeight: 32)
        .background(Color.yellow.opacity(0.10))
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(Color.yellow.opacity(0.28), lineWidth: 1)
        }
        .popover(isPresented: $editOpen) {
            QueuedTurnEditor(
                draft: $draft,
                onCancel: { editOpen = false },
                onSave: {
                    let next = draft
                    editOpen = false
                    Task { await store.updateQueued(event, prompt: next) }
                }
            )
        }
    }
}

private struct QueuedTurnEditor: View {
    @Binding var draft: String
    var onCancel: () -> Void
    var onSave: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Edit Queued Message")
                .font(.headline)
            TextEditor(text: $draft)
                .font(.body)
                .frame(width: 420, height: 160)
                .scrollContentBackground(.hidden)
                .background(Theme.window)
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .stroke(Theme.line, lineWidth: 1)
                }
            HStack {
                Spacer()
                Button("Cancel", action: onCancel)
                Button("Save", action: onSave)
                    .keyboardShortcut(.defaultAction)
                    .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(14)
    }
}

private struct StablePromptEditor: View, Equatable {
    @Binding var text: String
    var isEditable: Bool
    var resetID: Int
    var submitRevision: Int
    var onSubmit: (String) -> Void
    var onDropFiles: ([URL]) -> Void
    var onTextPresenceChange: (Bool) -> Void

    nonisolated static func == (lhs: StablePromptEditor, rhs: StablePromptEditor) -> Bool {
        lhs.isEditable == rhs.isEditable &&
            lhs.resetID == rhs.resetID &&
            lhs.submitRevision == rhs.submitRevision
    }

    var body: some View {
        PromptTextView(
            text: $text,
            isEditable: isEditable,
            resetID: resetID,
            submitRevision: submitRevision,
            onSubmit: onSubmit,
            onDropFiles: onDropFiles,
            onTextPresenceChange: onTextPresenceChange
        )
    }
}

struct PromptTextView: NSViewRepresentable {
    @Binding var text: String
    var isEditable: Bool
    var resetID: Int
    var submitRevision: Int
    var onSubmit: (String) -> Void
    var onDropFiles: ([URL]) -> Void = { _ in }
    var onTextPresenceChange: (Bool) -> Void = { _ in }

    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }

    func makeNSView(context: Context) -> NSScrollView {
        let scrollView = NSScrollView()
        scrollView.borderType = .noBorder
        scrollView.drawsBackground = false
        scrollView.hasVerticalScroller = true
        scrollView.autohidesScrollers = true
        scrollView.verticalScrollElasticity = .allowed

        let textView = SubmitTextView()
        textView.delegate = context.coordinator
        textView.drawsBackground = false
        textView.font = .systemFont(ofSize: NSFont.systemFontSize)
        textView.textColor = .labelColor
        textView.insertionPointColor = .controlAccentColor
        textView.textContainerInset = NSSize(width: 7, height: 4)
        textView.isRichText = false
        textView.allowsUndo = true
        textView.importsGraphics = false
        textView.isAutomaticQuoteSubstitutionEnabled = false
        textView.isAutomaticDashSubstitutionEnabled = false
        textView.isAutomaticSpellingCorrectionEnabled = false
        textView.isContinuousSpellCheckingEnabled = false
        textView.isGrammarCheckingEnabled = false
        textView.smartInsertDeleteEnabled = false
        textView.isHorizontallyResizable = false
        textView.isVerticallyResizable = true
        textView.autoresizingMask = [.width]
        textView.layoutManager?.allowsNonContiguousLayout = true
        textView.layoutManager?.backgroundLayoutEnabled = true
        textView.textContainer?.widthTracksTextView = true
        textView.textContainer?.containerSize = NSSize(width: scrollView.contentSize.width, height: .greatestFiniteMagnitude)
        textView.onSubmitText = { context.coordinator.submit(textView: textView) }
        textView.onDropFiles = onDropFiles
        textView.registerForDraggedTypes([.fileURL, .URL])

        scrollView.documentView = textView
        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        context.coordinator.parent = self
        guard let textView = scrollView.documentView as? SubmitTextView else { return }
        if context.coordinator.lastAppliedResetID != resetID {
            textView.string = text
            context.coordinator.lastAppliedResetID = resetID
            context.coordinator.publishPresence(textView)
        }
        if context.coordinator.lastHandledSubmitRevision != submitRevision {
            context.coordinator.lastHandledSubmitRevision = submitRevision
            context.coordinator.submit(textView: textView)
        }
        textView.isEditable = isEditable
        textView.onSubmitText = { context.coordinator.submit(textView: textView) }
        textView.onDropFiles = onDropFiles
    }

    @MainActor
    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: PromptTextView
        private var presenceGate = ZTextPresenceGate()
        var lastAppliedResetID = 0
        var lastHandledSubmitRevision = 0

        init(_ parent: PromptTextView) {
            self.parent = parent
        }

        func textDidChange(_ notification: Notification) {
            guard let textView = notification.object as? NSTextView else { return }
            publishPresence(textView)
        }

        func submit(textView: NSTextView) {
            parent.onSubmit(textView.string)
        }

        func publishPresence(_ textView: NSTextView) {
            // Guardrail: publishing on every keystroke reintroduces SwiftUI
            // invalidation while typing. Only cross the bridge when the
            // placeholder state actually changes.
            let hasText = (textView.textStorage?.length ?? textView.string.utf16.count) > 0
            guard presenceGate.shouldPublish(hasText: hasText) else { return }
            parent.onTextPresenceChange(hasText)
        }
    }

    final class SubmitTextView: NSTextView {
        var onSubmitText: (() -> Void)?
        var onDropFiles: (([URL]) -> Void)?

        override func keyDown(with event: NSEvent) {
            let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
            let isReturn = event.keyCode == 36 || event.keyCode == 76
            let wantsNewline = flags.contains(.shift) || flags.contains(.option) || flags.contains(.control)
            if isReturn && !wantsNewline {
                onSubmitText?()
                return
            }
            super.keyDown(with: event)
        }

        override func paste(_ sender: Any?) {
            let pasteboard = NSPasteboard.general
            if let urls = Self.fileURLs(from: pasteboard), !urls.isEmpty {
                onDropFiles?(urls)
                return
            }
            if let imageURL = Self.writeImageFromPasteboard(pasteboard) {
                onDropFiles?([imageURL])
                return
            }
            super.paste(sender)
        }

        override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
            draggedFileURLs(from: sender).isEmpty ? super.draggingEntered(sender) : .copy
        }

        override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
            let urls = draggedFileURLs(from: sender)
            guard !urls.isEmpty else {
                return super.performDragOperation(sender)
            }
            onDropFiles?(urls)
            return true
        }

        private func draggedFileURLs(from sender: NSDraggingInfo) -> [URL] {
            Self.fileURLs(from: sender.draggingPasteboard) ?? []
        }

        private static func fileURLs(from pasteboard: NSPasteboard) -> [URL]? {
            if let urls = pasteboard.readObjects(
                forClasses: [NSURL.self],
                options: [.urlReadingFileURLsOnly: true]
            ) as? [URL] {
                let fileURLs = urls.filter(\.isFileURL)
                if !fileURLs.isEmpty {
                    return fileURLs
                }
            }

            let itemURLs = (pasteboard.pasteboardItems ?? []).compactMap { item in
                if let string = item.string(forType: .fileURL), let url = URL(string: string), url.isFileURL {
                    return url
                }
                if let string = item.string(forType: .URL), let url = URL(string: string), url.isFileURL {
                    return url
                }
                return nil
            }
            return itemURLs.isEmpty ? nil : itemURLs
        }

        private static func writeImageFromPasteboard(_ pasteboard: NSPasteboard) -> URL? {
            guard let image = NSImage(pasteboard: pasteboard),
                  let tiff = image.tiffRepresentation,
                  let rep = NSBitmapImageRep(data: tiff),
                  let data = rep.representation(using: .png, properties: [:]) else {
                return nil
            }
            let directory = FileManager.default.temporaryDirectory
                .appendingPathComponent("ZenithDockPasteboardImages", isDirectory: true)
            do {
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                let url = directory.appendingPathComponent("clipboard-image-\(UUID().uuidString).png")
                try data.write(to: url, options: .atomic)
                return url
            } catch {
                return nil
            }
        }
    }
}

struct UploadChip: View {
    let file: ZFile
    let url: URL
    var onRemove: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            preview
            VStack(alignment: .leading, spacing: 2) {
                Text(file.filename)
                    .lineLimit(1)
                    .truncationMode(.middle)
                if let size = file.size {
                    Text(byteString(size))
                        .foregroundStyle(.secondary)
                }
            }
            Button {
                onRemove()
            } label: {
                Image(systemName: "xmark.circle.fill")
                    .symbolRenderingMode(.hierarchical)
            }
            .buttonStyle(.plain)
            .help("Remove attachment")
        }
        .font(.caption)
        .padding(.horizontal, 8)
        .padding(.vertical, 7)
        .frame(maxWidth: 240)
        .background(.quaternary)
        .clipShape(RoundedRectangle(cornerRadius: 7))
    }

    @ViewBuilder
    private var preview: some View {
        if file.content_type?.hasPrefix("image/") == true {
            AsyncImage(url: url) { phase in
                switch phase {
                case .success(let image):
                    image
                        .resizable()
                        .scaledToFill()
                default:
                    Image(systemName: "photo")
                        .foregroundStyle(.secondary)
                }
            }
            .frame(width: 42, height: 42)
            .background(.black.opacity(0.10))
            .clipShape(RoundedRectangle(cornerRadius: 6))
        } else {
            Image(systemName: icon)
                .frame(width: 28, height: 28)
                .background(.secondary.opacity(0.12))
                .clipShape(RoundedRectangle(cornerRadius: 6))
        }
    }

    var icon: String {
        if file.content_type?.hasPrefix("video/") == true { return "film" }
        if file.content_type?.hasPrefix("image/") == true { return "photo" }
        return "doc"
    }
}
