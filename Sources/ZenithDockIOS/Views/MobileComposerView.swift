import SwiftUI
import ZenithCore

struct MobileComposerView: View {
    @EnvironmentObject private var store: MobileAppStore
    @Binding var importerOpen: Bool

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
            HStack(alignment: .bottom, spacing: 10) {
                Button {
                    importerOpen = true
                } label: {
                    Image(systemName: "paperclip")
                }
                .buttonStyle(.bordered)

                TextField("Message", text: $store.prompt, axis: .vertical)
                    .lineLimit(1...5)
                    .textFieldStyle(.plain)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)
                    .background(MobileTheme.card)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                    .overlay(RoundedRectangle(cornerRadius: 12).stroke(MobileTheme.softLine))
                    .submitLabel(.send)
                    .onSubmit { Task { await store.sendPrompt() } }

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
