import SwiftUI
import ZenithCore

#if canImport(UIKit)
import UIKit
#endif

struct MobileComposerView: View {
    @EnvironmentObject private var store: MobileAppStore
    @Binding var importerOpen: Bool
    @State private var draftPrompt = ""
    @State private var promptFocused = false
    @State private var promptHeight: CGFloat = MobilePromptTextView.minimumHeight
    @State private var isAttachmentDropTargeted = false

    var body: some View {
        VStack(spacing: 7) {
            if !store.uploads.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(store.uploads) { file in
                            MobileUploadChip(file: file, url: store.fileURL(file)) {
                                store.removeUpload(file)
                            }
                        }
                    }
                    .padding(.horizontal, 16)
                }
            }
            if !store.pendingQueuedEvents.isEmpty {
                MobileQueuedShelf()
                    .padding(.horizontal, 16)
            }
            VStack(alignment: .leading, spacing: 4) {
                ZStack(alignment: .topLeading) {
                    MobilePromptTextView(
                        text: $draftPrompt,
                        isFocused: $promptFocused,
                        measuredHeight: $promptHeight,
                        isEditable: store.selectedSessionID != nil,
                        onSubmit: submitPrompt
                        )
                        .frame(height: promptHeight)
                    if draftPrompt.isEmpty {
                        Text(store.selectedSessionID == nil ? "Select a chat" : "Message")
                            .font(.body)
                            .foregroundStyle(.tertiary)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 8)
                            .allowsHitTesting(false)
                    }
                }
                .frame(maxWidth: .infinity, minHeight: promptHeight, maxHeight: promptHeight, alignment: .topLeading)

                HStack(spacing: 8) {
                    Button {
                        importerOpen = true
                    } label: {
                        Image(systemName: "paperclip")
                            .font(.system(size: 16, weight: .semibold))
                            .frame(width: 30, height: 30)
                    }
                    .buttonStyle(.plain)
                    .background(.quaternary)
                    .clipShape(Circle())
                    .disabled(store.selectedSessionID == nil)
                    .opacity(store.selectedSessionID == nil ? 0.45 : 1)
                    .accessibilityLabel("Attach file")

                    if let session = store.selectedSession {
                        HStack(spacing: 5) {
                            Image(systemName: MobileTheme.backendIconName(session.backend))
                                .font(.caption2.weight(.semibold))
                                .foregroundStyle(MobileTheme.backendTint(session.backend))
                            Text(runtimeLabel(for: session))
                                .lineLimit(1)
                                .minimumScaleFactor(0.75)
                        }
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .accessibilityLabel(store.runtimeCatalog.compactSummary(for: session))
                    }

                    Spacer(minLength: 4)

                    if store.isRunning {
                        MobileComposerRunningStatus(backend: store.selectedSession?.backend ?? "agent")
                    }

                    Button {
                        submitPrompt()
                    } label: {
                        Image(systemName: store.isRunning ? "text.line.last.and.arrowtriangle.forward" : "arrow.up")
                            .font(.system(size: 15, weight: .bold))
                            .foregroundStyle(.white)
                            .frame(width: 30, height: 30)
                    }
                    .buttonStyle(.plain)
                    .background(canSend ? Color.accentColor : Color.secondary.opacity(0.18))
                    .clipShape(Circle())
                    .disabled(!canSend)
                    .accessibilityLabel(store.isRunning ? "Queue message" : "Send message")
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            .background(MobileTheme.card)
            .clipShape(RoundedRectangle(cornerRadius: 18))
            .overlay {
                RoundedRectangle(cornerRadius: 18)
                    .stroke(isAttachmentDropTargeted ? Color.accentColor.opacity(0.85) : (promptFocused ? .blue.opacity(0.75) : MobileTheme.softLine), lineWidth: isAttachmentDropTargeted ? 2 : 1)
            }
            .onDrop(of: MobileTimelineFileDrop.supportedTypes, isTargeted: $isAttachmentDropTargeted) { providers in
                acceptAttachmentDrop(providers)
            }
            .layoutPriority(1)
            .padding(.horizontal, 16)
        }
        .padding(.top, 8)
        .padding(.bottom, 7)
        .background(.bar)
        .onChange(of: store.selectedSessionID) {
            draftPrompt = ""
            promptHeight = MobilePromptTextView.minimumHeight
        }
    }

    private var canSend: Bool {
        store.selectedSessionID != nil && !draftPrompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func runtimeLabel(for session: ZSession) -> String {
        let model = store.runtimeCatalog.modelLabel(session.model, backend: session.backend)
        let effort = store.runtimeCatalog.effortLabel(session.effort, backend: session.backend)
        let compactModel = model == "Server default" ? "Default" : model
        let compactEffort = effort == "Server default" ? "" : effort
        return [compactModel, compactEffort].filter { !$0.isEmpty }.joined(separator: " · ")
    }

    private func submitPrompt() {
        guard canSend else { return }
        let submitted = draftPrompt
        draftPrompt = ""
        promptHeight = MobilePromptTextView.minimumHeight
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
            let urls = await MobileTimelineFileDrop.urls(from: providers)
            guard !urls.isEmpty else { return }
            await store.upload(urls: urls)
        }
        return true
    }
}

private struct MobileComposerRunningStatus: View {
    @EnvironmentObject private var store: MobileAppStore
    var backend: String

    var body: some View {
        HStack(spacing: 5) {
            ProgressView()
                .controlSize(.small)
            Button(role: .destructive) {
                Task { await store.stop() }
            } label: {
                Image(systemName: "stop.circle")
                    .font(.caption.weight(.semibold))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Stop current turn")
        }
        .foregroundStyle(backend == "codex" ? .orange : .blue)
        .padding(.horizontal, 7)
        .padding(.vertical, 4)
        .background((backend == "codex" ? Color.orange : Color.blue).opacity(0.12))
        .clipShape(Capsule())
        .accessibilityLabel("\(backend.capitalized) running")
    }
}

private struct MobilePromptTextView: UIViewRepresentable {
    static let minimumHeight: CGFloat = 40
    static let maximumHeight: CGFloat = 168

    @Binding var text: String
    @Binding var isFocused: Bool
    @Binding var measuredHeight: CGFloat
    var isEditable: Bool
    var onSubmit: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }

    func makeUIView(context: Context) -> UITextView {
        let textView = PromptUITextView()
        textView.onLayout = { [weak coordinator = context.coordinator] view in
            coordinator?.recalculateHeight(view, scrollToCaret: false)
        }
        textView.delegate = context.coordinator
        textView.backgroundColor = .clear
        textView.font = .preferredFont(forTextStyle: .body)
        textView.adjustsFontForContentSizeCategory = true
        textView.textColor = .label
        textView.tintColor = .systemBlue
        textView.textContainerInset = UIEdgeInsets(top: 9, left: 8, bottom: 9, right: 8)
        textView.textContainer.lineFragmentPadding = 0
        textView.textContainer.widthTracksTextView = true
        textView.returnKeyType = .send
        textView.enablesReturnKeyAutomatically = true
        textView.isScrollEnabled = false
        textView.isEditable = isEditable
        textView.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        textView.setContentHuggingPriority(.required, for: .vertical)
        textView.accessibilityLabel = "Message"

        return textView
    }

    func updateUIView(_ textView: UITextView, context: Context) {
        context.coordinator.parent = self
        if textView.text != text {
            textView.text = text
            context.coordinator.recalculateHeight(textView, scrollToCaret: true)
        }
        textView.isEditable = isEditable
        context.coordinator.recalculateHeight(textView, scrollToCaret: false)
        if isFocused, !textView.isFirstResponder {
            textView.becomeFirstResponder()
        } else if !isFocused, textView.isFirstResponder {
            textView.resignFirstResponder()
        }
    }

    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: MobilePromptTextView
        private var pendingHeight: CGFloat?
        private var heightUpdateScheduled = false

        init(_ parent: MobilePromptTextView) {
            self.parent = parent
        }

        func textViewDidBeginEditing(_ textView: UITextView) {
            parent.isFocused = true
        }

        func textViewDidEndEditing(_ textView: UITextView) {
            parent.isFocused = false
        }

        func textViewDidChange(_ textView: UITextView) {
            parent.text = textView.text
            recalculateHeight(textView, scrollToCaret: true)
        }

        func textView(_ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText replacement: String) -> Bool {
            guard replacement == "\n" else { return true }
            if (textView as? PromptUITextView)?.consumeHardwareShiftReturn() == true {
                return true
            }
            if parent.isEditable && !textView.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                parent.onSubmit()
            }
            return false
        }

        func recalculateHeight(_ textView: UITextView, scrollToCaret: Bool) {
            let width = textView.bounds.width > 0 ? textView.bounds.width : textView.frame.width
            guard width > 0 else { return }
            let inset = textView.textContainerInset.left + textView.textContainerInset.right
            textView.textContainer.size = CGSize(
                width: max(width - inset, 0),
                height: .greatestFiniteMagnitude
            )
            let fittingSize = textView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
            let rawHeight = ceil(fittingSize.height)
            let next = min(max(rawHeight, MobilePromptTextView.minimumHeight), MobilePromptTextView.maximumHeight)
            let shouldScroll = rawHeight > MobilePromptTextView.maximumHeight + 1
            if textView.isScrollEnabled != shouldScroll {
                textView.isScrollEnabled = shouldScroll
            }
            if scrollToCaret, textView.isScrollEnabled {
                let selectedRange = textView.selectedRange
                textView.scrollRangeToVisible(selectedRange)
            }
            guard abs(parent.measuredHeight - next) > 1 else { return }
            if let pendingHeight, abs(pendingHeight - next) <= 1 {
                return
            }
            pendingHeight = next
            guard !heightUpdateScheduled else { return }
            heightUpdateScheduled = true
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                let pendingHeight = self.pendingHeight
                self.pendingHeight = nil
                self.heightUpdateScheduled = false
                guard let pendingHeight else { return }
                guard abs(self.parent.measuredHeight - pendingHeight) > 1 else { return }
                var transaction = Transaction()
                transaction.disablesAnimations = true
                withTransaction(transaction) {
                    self.parent.measuredHeight = pendingHeight
                }
            }
        }
    }
}

private final class PromptUITextView: UITextView {
    var onLayout: ((UITextView) -> Void)?
    private var hardwareShiftReturnPending = false

    override func layoutSubviews() {
        super.layoutSubviews()
        onLayout?(self)
    }

    override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        let hasShiftReturn = presses.contains(where: isShiftReturn)
        if hasShiftReturn {
            hardwareShiftReturnPending = true
        }
        super.pressesBegan(presses, with: event)
        if hasShiftReturn {
            DispatchQueue.main.async { [weak self] in
                self?.hardwareShiftReturnPending = false
            }
        }
    }

    func consumeHardwareShiftReturn() -> Bool {
        defer { hardwareShiftReturnPending = false }
        return hardwareShiftReturnPending
    }

    private func isShiftReturn(_ press: UIPress) -> Bool {
        guard let key = press.key else { return false }
        guard key.modifierFlags.contains(.shift) else { return false }
        if key.charactersIgnoringModifiers == "\n" || key.charactersIgnoringModifiers == "\r" {
            return true
        }
        if #available(iOS 13.4, *) {
            return key.keyCode == .keyboardReturnOrEnter
        }
        return false
    }
}

private struct MobileQueuedShelf: View {
    @EnvironmentObject private var store: MobileAppStore

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
                        MobileQueuedChip(event: event)
                    }
                }
            }
            .frame(maxHeight: 110)
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
    }
}

private struct MobileQueuedChip: View {
    @EnvironmentObject private var store: MobileAppStore
    let event: ZEvent

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Text(event.prompt ?? "Queued message")
                .font(.caption)
                .lineLimit(2)
                .multilineTextAlignment(.trailing)
            Button {
                Task { await store.unqueue(event) }
            } label: {
                Image(systemName: "xmark.circle.fill")
                    .imageScale(.medium)
            }
            .buttonStyle(.borderless)
            .accessibilityLabel("Unqueue message")
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .frame(maxWidth: 320, alignment: .trailing)
        .background(.secondary.opacity(0.12))
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(.secondary.opacity(0.18)))
    }
}

private struct MobileUploadChip: View {
    let file: ZFile
    let url: URL
    var onRemove: () -> Void

    var body: some View {
        HStack(spacing: 7) {
            preview
            VStack(alignment: .leading, spacing: 1) {
                Text(file.filename)
                    .lineLimit(1)
                    .truncationMode(.middle)
                if let size = file.size {
                    Text(mobileByteString(size))
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
            .accessibilityLabel("Remove attachment")
        }
        .font(.caption)
        .padding(.horizontal, 8)
        .padding(.vertical, 7)
        .frame(maxWidth: 230)
        .background(.quaternary)
        .clipShape(RoundedRectangle(cornerRadius: 8))
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
            .frame(width: 40, height: 40)
            .background(.black.opacity(0.10))
            .clipShape(RoundedRectangle(cornerRadius: 7))
        } else {
            Image(systemName: icon)
                .frame(width: 28, height: 28)
                .background(.secondary.opacity(0.12))
                .clipShape(RoundedRectangle(cornerRadius: 7))
        }
    }

    private var icon: String {
        if file.content_type?.hasPrefix("video/") == true { return "film" }
        if file.content_type?.hasPrefix("image/") == true { return "photo" }
        return "doc"
    }
}
