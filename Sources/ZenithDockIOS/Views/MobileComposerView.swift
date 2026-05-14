import SwiftUI
import ZenithCore

#if canImport(UIKit)
import UIKit
#endif

struct MobileComposerView: View {
    @EnvironmentObject private var store: MobileAppStore
    @Binding var importerOpen: Bool
    @State private var promptFocused = false

    var body: some View {
        VStack(spacing: 8) {
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
            HStack(alignment: .bottom, spacing: 10) {
                Button {
                    importerOpen = true
                } label: {
                    Image(systemName: "paperclip")
                }
                .buttonStyle(.bordered)
                .disabled(store.selectedSessionID == nil)
                .accessibilityLabel("Attach file")

                ZStack(alignment: .topLeading) {
                    MobilePromptTextView(
                        text: $store.prompt,
                        isFocused: $promptFocused,
                        isEditable: store.selectedSessionID != nil,
                        onSubmit: submitPrompt
                    )
                    .frame(minHeight: 44, maxHeight: 128)
                    if store.prompt.isEmpty {
                        Text(store.selectedSessionID == nil ? "Select a chat" : "Message")
                            .foregroundStyle(.tertiary)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 11)
                            .allowsHitTesting(false)
                    }
                }
                .padding(.horizontal, 4)
                .background(MobileTheme.card)
                .clipShape(RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(promptFocused ? .blue.opacity(0.75) : MobileTheme.softLine))

                Button {
                    submitPrompt()
                } label: {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.title2)
                }
                .disabled(!canSend)
                .accessibilityLabel(store.isRunning ? "Queue message" : "Send message")
            }
            .padding(.horizontal, 16)
        }
        .padding(.vertical, 10)
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
    @Binding var text: String
    @Binding var isFocused: Bool
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
        textView.isScrollEnabled = true
        textView.isEditable = isEditable
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
            .frame(maxHeight: 150)
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
