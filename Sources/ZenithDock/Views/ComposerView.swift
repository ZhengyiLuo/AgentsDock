import AppKit
import SwiftUI
import ZenithCore

struct ComposerView: View {
    @EnvironmentObject private var store: AppStore
    @Binding var importerOpen: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if !store.uploads.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack {
                        ForEach(store.uploads) { file in
                            UploadChip(file: file)
                        }
                    }
                }
            }
            HStack(alignment: .bottom, spacing: 10) {
                Button {
                    importerOpen = true
                } label: {
                    Image(systemName: "paperclip")
                }
                .buttonStyle(.bordered)
                PromptTextView(text: $store.prompt, isEditable: store.selectedSession != nil) {
                    Task { await store.sendPrompt() }
                }
                .frame(minHeight: 52, maxHeight: 140)
                .overlay(alignment: .topLeading) {
                    if store.prompt.isEmpty {
                        Text("Message")
                            .foregroundStyle(.tertiary)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 10)
                            .allowsHitTesting(false)
                    }
                }
                .background(Theme.card)
                .clipShape(RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.line))
                Button {
                    Task { await store.sendPrompt() }
                } label: {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.title2)
                }
                .buttonStyle(.plain)
                .disabled(store.selectedSession == nil || store.prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .help(store.isRunning ? "Queue message" : "Send message")
            }
        }
        .padding(16)
        .background(Theme.panel)
    }
}

struct PromptTextView: NSViewRepresentable {
    @Binding var text: String
    var isEditable: Bool
    var onSubmit: () -> Void

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
        textView.textContainerInset = NSSize(width: 8, height: 8)
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
    }
}

struct UploadChip: View {
    let file: ZFile

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: icon)
            Text(file.filename)
                .lineLimit(1)
            if let size = file.size {
                Text(byteString(size))
                    .foregroundStyle(.secondary)
            }
        }
        .font(.caption)
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(.quaternary)
        .clipShape(RoundedRectangle(cornerRadius: 7))
    }

    var icon: String {
        if file.content_type?.hasPrefix("video/") == true { return "film" }
        if file.content_type?.hasPrefix("image/") == true { return "photo" }
        return "doc"
    }
}
