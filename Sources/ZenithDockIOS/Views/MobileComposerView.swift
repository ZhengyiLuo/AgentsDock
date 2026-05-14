import SwiftUI
import ZenithCore

#if canImport(UIKit)
import UIKit
#endif

struct MobileComposerView: View {
    @EnvironmentObject private var store: MobileAppStore
    @Binding var importerOpen: Bool
    @State private var promptFocused = false
    @State private var promptHeight: CGFloat = MobilePromptTextView.minimumHeight

    var body: some View {
        VStack(spacing: 7) {
            if !store.uploads.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(store.uploads) { file in
                            MobileUploadChip(file: file)
                        }
                    }
                    .padding(.horizontal, 16)
                }
            }
            if !store.pendingQueuedEvents.isEmpty {
                MobileQueuedShelf()
                    .padding(.horizontal, 16)
            }
            HStack(alignment: .bottom, spacing: 8) {
                Button {
                    importerOpen = true
                } label: {
                    Image(systemName: "paperclip")
                        .font(.system(size: 17, weight: .semibold))
                        .frame(width: 36, height: 36)
                }
                .buttonStyle(.plain)
                .background(.quaternary)
                .clipShape(Circle())
                .disabled(store.selectedSessionID == nil)
                .opacity(store.selectedSessionID == nil ? 0.45 : 1)
                .accessibilityLabel("Attach file")

                ZStack(alignment: .topLeading) {
                    MobilePromptTextView(
                        text: $store.prompt,
                        isFocused: $promptFocused,
                        measuredHeight: $promptHeight,
                        isEditable: store.selectedSessionID != nil,
                        onSubmit: submitPrompt
                    )
                    .frame(height: promptHeight)
                    if store.prompt.isEmpty {
                        Text(store.selectedSessionID == nil ? "Select a chat" : "Message")
                            .font(.body)
                            .foregroundStyle(.tertiary)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 8)
                            .allowsHitTesting(false)
                    }
                }
                .padding(.horizontal, 2)
                .background(MobileTheme.card)
                .clipShape(RoundedRectangle(cornerRadius: 18))
                .overlay(RoundedRectangle(cornerRadius: 18).stroke(promptFocused ? .blue.opacity(0.75) : MobileTheme.softLine))

                Button {
                    submitPrompt()
                } label: {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 16, weight: .bold))
                        .foregroundStyle(.white)
                        .frame(width: 36, height: 36)
                }
                .buttonStyle(.plain)
                .background(canSend ? Color.accentColor : Color.secondary.opacity(0.18))
                .clipShape(Circle())
                .disabled(!canSend)
                .accessibilityLabel(store.isRunning ? "Queue message" : "Send message")
            }
            .padding(.horizontal, 16)
        }
        .padding(.top, 8)
        .padding(.bottom, 7)
        .background(.bar)
    }

    private var canSend: Bool {
        store.selectedSessionID != nil && !store.prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func submitPrompt() {
        guard canSend else { return }
        Task { await store.sendPrompt() }
    }
}

private struct MobilePromptTextView: UIViewRepresentable {
    static let minimumHeight: CGFloat = 38
    static let maximumHeight: CGFloat = 112

    @Binding var text: String
    @Binding var isFocused: Bool
    @Binding var measuredHeight: CGFloat
    var isEditable: Bool
    var onSubmit: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }

    func makeUIView(context: Context) -> UITextView {
        let textView = UITextView()
        textView.delegate = context.coordinator
        textView.backgroundColor = .clear
        textView.font = .preferredFont(forTextStyle: .body)
        textView.adjustsFontForContentSizeCategory = true
        textView.textColor = .label
        textView.tintColor = .systemBlue
        textView.textContainerInset = UIEdgeInsets(top: 9, left: 8, bottom: 9, right: 8)
        textView.textContainer.lineFragmentPadding = 0
        textView.returnKeyType = .send
        textView.enablesReturnKeyAutomatically = true
        textView.isScrollEnabled = false
        textView.isEditable = isEditable
        textView.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        textView.setContentHuggingPriority(.required, for: .vertical)
        textView.accessibilityLabel = "Message"

        let toolbar = UIToolbar()
        toolbar.items = [
            UIBarButtonItem(systemItem: .flexibleSpace),
            UIBarButtonItem(title: "Done", style: .done, target: context.coordinator, action: #selector(Coordinator.doneTapped))
        ]
        toolbar.sizeToFit()
        textView.inputAccessoryView = toolbar
        return textView
    }

    func updateUIView(_ textView: UITextView, context: Context) {
        context.coordinator.parent = self
        if textView.text != text {
            textView.text = text
        }
        textView.isEditable = isEditable
        context.coordinator.recalculateHeight(textView)
        if isFocused, !textView.isFirstResponder {
            textView.becomeFirstResponder()
        } else if !isFocused, textView.isFirstResponder {
            textView.resignFirstResponder()
        }
    }

    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: MobilePromptTextView

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
            recalculateHeight(textView)
        }

        func textView(_ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText replacement: String) -> Bool {
            guard replacement == "\n" else { return true }
            if parent.isEditable && !textView.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                parent.onSubmit()
            }
            return false
        }

        @objc func doneTapped() {
            parent.isFocused = false
        }

        func recalculateHeight(_ textView: UITextView) {
            let width = textView.bounds.width
            guard width > 0 else { return }
            let fittingSize = textView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
            let next = min(max(fittingSize.height, MobilePromptTextView.minimumHeight), MobilePromptTextView.maximumHeight)
            textView.isScrollEnabled = fittingSize.height > MobilePromptTextView.maximumHeight
            guard abs(parent.measuredHeight - next) > 0.5 else { return }
            DispatchQueue.main.async {
                self.parent.measuredHeight = next
            }
        }
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

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: icon)
            Text(file.filename)
                .lineLimit(1)
            if let size = file.size {
                Text(mobileByteString(size))
                    .foregroundStyle(.secondary)
            }
        }
        .font(.caption)
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(.quaternary)
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    private var icon: String {
        if file.content_type?.hasPrefix("video/") == true { return "film" }
        if file.content_type?.hasPrefix("image/") == true { return "photo" }
        return "doc"
    }
}
