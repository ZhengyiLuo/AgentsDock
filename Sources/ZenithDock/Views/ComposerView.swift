import AppKit
import SwiftUI
import ZenithCore

struct ComposerView: View {
    @EnvironmentObject private var store: AppStore
    @Binding var importerOpen: Bool
    @State private var draftPrompt = ""
    @State private var isAttachmentDropTargeted = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !store.uploads.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(store.uploads) { file in
                            UploadChip(file: file, url: store.fileURL(file)) {
                                store.removeUpload(file)
                            }
                        }
                    }
                }
            }
            VStack(alignment: .leading, spacing: 6) {
                PromptTextView(text: $draftPrompt, isEditable: store.selectedSession != nil) {
                    sendDraft()
                } onDropFiles: { urls in
                    uploadDroppedFiles(urls)
                }
                .frame(height: promptHeight)
                .overlay(alignment: .topLeading) {
                    if draftPrompt.isEmpty {
                        Text("Message")
                            .foregroundStyle(.tertiary)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 5)
                            .allowsHitTesting(false)
                    }
                }
                HStack(spacing: 8) {
                    Button {
                        importerOpen = true
                    } label: {
                        Image(systemName: "paperclip")
                            .frame(width: 24, height: 24)
                    }
                    .buttonStyle(.plain)
                    .disabled(store.selectedSession == nil)
                    .opacity(store.selectedSession == nil ? 0.45 : 1)
                    .help("Attach files")

                    if let session = store.selectedSession {
                        HStack(spacing: 5) {
                            Image(systemName: session.backend == "codex" ? "bolt.fill" : "sparkles")
                                .font(.caption2.weight(.semibold))
                            Text(runtimeLabel(for: session))
                                .lineLimit(1)
                                .truncationMode(.tail)
                        }
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .help(store.runtimeCatalog.compactSummary(for: session))
                    }

                    Spacer(minLength: 8)

                    if store.isRunning {
                        ComposerRunningStatus(backend: store.selectedSession?.backend ?? "agent")
                    }

                    Button {
                        sendDraft()
                    } label: {
                        Image(systemName: store.isRunning ? "text.line.last.and.arrowtriangle.forward.circle.fill" : "arrow.up.circle.fill")
                            .font(.title3)
                            .symbolRenderingMode(.hierarchical)
                    }
                    .buttonStyle(.plain)
                    .disabled(store.selectedSession == nil || draftPrompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .help(store.isRunning ? "Queue message" : "Send message")
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 7)
            .background(Theme.card)
            .clipShape(RoundedRectangle(cornerRadius: 12))
            .overlay {
                RoundedRectangle(cornerRadius: 12)
                    .stroke(isAttachmentDropTargeted ? Color.accentColor.opacity(0.80) : Theme.line, lineWidth: isAttachmentDropTargeted ? 2 : 1)
            }
            .overlay {
                if isAttachmentDropTargeted {
                    RoundedRectangle(cornerRadius: 12)
                        .strokeBorder(Color.accentColor.opacity(0.85), style: StrokeStyle(lineWidth: 2, dash: [7, 5]))
                        .allowsHitTesting(false)
                }
            }
            .onDrop(of: TimelineFileDrop.supportedTypes, isTargeted: $isAttachmentDropTargeted) { providers in
                acceptAttachmentDrop(providers)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
        .background(Theme.panel)
        .onChange(of: store.selectedSessionID) {
            draftPrompt = ""
        }
    }

    private var promptHeight: CGFloat {
        let hardLines = draftPrompt.split(separator: "\n", omittingEmptySubsequences: false).count
        let softLines = max(1, Int(ceil(Double(draftPrompt.count) / 110.0)))
        let visibleLines = min(max(hardLines, softLines), 5)
        return CGFloat(visibleLines * 18 + 12)
    }

    private func runtimeLabel(for session: ZSession) -> String {
        let model = store.runtimeCatalog.modelLabel(session.model, backend: session.backend)
        let effort = store.runtimeCatalog.effortLabel(session.effort, backend: session.backend)
        let compactModel = model == "Server default" ? "Default" : model
        let compactEffort = effort == "Server default" ? "" : effort
        return [compactModel, compactEffort].filter { !$0.isEmpty }.joined(separator: " · ")
    }

    private func sendDraft() {
        let submitted = draftPrompt
        guard !submitted.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        draftPrompt = ""
        Task {
            let accepted = await store.sendPrompt(submitted)
            if !accepted {
                await MainActor.run {
                    if draftPrompt.isEmpty {
                        draftPrompt = submitted
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

private struct ComposerRunningStatus: View {
    @EnvironmentObject private var store: AppStore
    var backend: String

    var body: some View {
        HStack(spacing: 6) {
            ProgressView()
                .controlSize(.small)
                .frame(width: 12, height: 12)
            Text("Running")
                .font(.caption.weight(.semibold))
                .lineLimit(1)
            Button(role: .destructive) {
                Task { await store.stop() }
            } label: {
                Image(systemName: "stop.circle")
            }
            .buttonStyle(.borderless)
            .controlSize(.small)
            .help("Stop current turn")
        }
        .foregroundStyle(backend == "codex" ? .orange : .blue)
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background((backend == "codex" ? Color.orange : Color.blue).opacity(0.12))
        .clipShape(Capsule())
        .help("\(backend.capitalized) is running. New sends will queue.")
    }
}

struct PromptTextView: NSViewRepresentable {
    @Binding var text: String
    var isEditable: Bool
    var onSubmit: () -> Void
    var onDropFiles: ([URL]) -> Void = { _ in }

    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }

    func makeNSView(context: Context) -> NSScrollView {
        let scrollView = NSScrollView()
        scrollView.borderType = .noBorder
        scrollView.drawsBackground = false
        scrollView.hasVerticalScroller = true
        scrollView.autohidesScrollers = true

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
        textView.isHorizontallyResizable = false
        textView.isVerticallyResizable = true
        textView.autoresizingMask = [.width]
        textView.textContainer?.widthTracksTextView = true
        textView.textContainer?.containerSize = NSSize(width: scrollView.contentSize.width, height: .greatestFiniteMagnitude)
        textView.onSubmit = onSubmit
        textView.onDropFiles = onDropFiles
        textView.registerForDraggedTypes([.fileURL, .URL])

        scrollView.documentView = textView
        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        context.coordinator.parent = self
        guard let textView = scrollView.documentView as? SubmitTextView else { return }
        if textView.string != text {
            textView.string = text
        }
        textView.isEditable = isEditable
        textView.onSubmit = onSubmit
        textView.onDropFiles = onDropFiles
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: PromptTextView

        init(_ parent: PromptTextView) {
            self.parent = parent
        }

        func textDidChange(_ notification: Notification) {
            guard let textView = notification.object as? NSTextView else { return }
            parent.text = textView.string
        }
    }

    final class SubmitTextView: NSTextView {
        var onSubmit: (() -> Void)?
        var onDropFiles: (([URL]) -> Void)?

        override func keyDown(with event: NSEvent) {
            let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
            let isReturn = event.keyCode == 36 || event.keyCode == 76
            let wantsNewline = flags.contains(.shift) || flags.contains(.option) || flags.contains(.control)
            if isReturn && !wantsNewline {
                onSubmit?()
                return
            }
            super.keyDown(with: event)
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
            let pasteboard = sender.draggingPasteboard
            if let urls = pasteboard.readObjects(
                forClasses: [NSURL.self],
                options: [.urlReadingFileURLsOnly: true]
            ) as? [URL] {
                return urls.filter(\.isFileURL)
            }

            return (pasteboard.pasteboardItems ?? []).compactMap { item in
                if let string = item.string(forType: .fileURL), let url = URL(string: string), url.isFileURL {
                    return url
                }
                if let string = item.string(forType: .URL), let url = URL(string: string), url.isFileURL {
                    return url
                }
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
