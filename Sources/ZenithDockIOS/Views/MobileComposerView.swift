import SwiftUI
import ZenithCore

#if canImport(UIKit)
import UIKit
#endif

struct MobileComposerView: View {
    @EnvironmentObject private var store: MobileAppStore
    @Binding var importerOpen: Bool
    @FocusState private var promptFocused: Bool

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

                TextField("Message", text: $store.prompt, axis: .vertical)
                    .focused($promptFocused)
                    .lineLimit(1...5)
                    .textFieldStyle(.plain)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)
                    .background(MobileTheme.card)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                    .overlay(RoundedRectangle(cornerRadius: 12).stroke(MobileTheme.softLine))
                    .submitLabel(.send)
                    .onSubmit { Task { await store.sendPrompt() } }
                    .toolbar {
                        ToolbarItemGroup(placement: .keyboard) {
                            Spacer()
                            Button("Done") {
                                promptFocused = false
                                dismissMobileKeyboard()
                            }
                        }
                    }

                Button {
                    Task { await store.sendPrompt() }
                } label: {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.title2)
                }
                .disabled(store.selectedSessionID == nil || store.prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            .padding(.horizontal, 16)
        }
        .padding(.vertical, 10)
        .background(.bar)
    }
}

@MainActor
private func dismissMobileKeyboard() {
    #if canImport(UIKit)
    UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
    #endif
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
