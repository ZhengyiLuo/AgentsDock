import SwiftUI
import ZenithCore

struct MobilePinnedItemsSection: View {
    @EnvironmentObject private var store: MobileAppStore
    @EnvironmentObject private var features: MobileFeatureStore
    let session: ZSession
    let dismissOptions: () -> Void

    var body: some View {
        Section {
            if pins.isEmpty {
                Text("Pin important messages or files from the timeline.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(pins) { pin in
                    MobilePinnedItemRow(
                        pin: pin,
                        file: pin.fileID.flatMap(fileWithID),
                        openMessage: {
                            dismissOptions()
                            Task { await store.navigate(to: pin) }
                        },
                        remove: { features.removePin(pin.id) }
                    )
                }
            }
        } header: {
            Label("Pinned · \(pins.count)", systemImage: "pin.fill")
        }
    }

    private var pins: [ZPinnedItem] {
        features.pins(for: session.id)
    }

    private func fileWithID(_ id: String) -> ZFile? {
        store.sessionFiles.first { $0.id == id }
    }
}

private struct MobilePinnedItemRow: View {
    @EnvironmentObject private var store: MobileAppStore
    let pin: ZPinnedItem
    let file: ZFile?
    let openMessage: () -> Void
    let remove: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: pin.kind == .file ? "doc.fill" : "text.bubble.fill")
                .foregroundStyle(Color.accentColor)
                .frame(width: 20)
                .padding(.top, 2)
            Group {
                if let file {
                    Link(destination: store.fileURL(file)) {
                        label
                    }
                } else if let fileID = pin.fileID {
                    Link(destination: store.fileURL(fileID: fileID)) {
                        label
                    }
                } else {
                    Button(action: openMessage) {
                        label
                    }
                    .buttonStyle(.plain)
                    .disabled(pin.eventID == nil)
                }
            }
            Spacer(minLength: 4)
            Button(role: .destructive, action: remove) {
                Image(systemName: "xmark.circle.fill")
            }
            .buttonStyle(.borderless)
            .accessibilityLabel("Unpin")
        }
        .padding(.vertical, 3)
    }

    private var label: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(pin.title)
                .font(.subheadline.weight(.semibold))
                .lineLimit(1)
            if let body = pin.body?.trimmingCharacters(in: .whitespacesAndNewlines), !body.isEmpty {
                Text(body)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(3)
            } else if let subtitle = pin.subtitle, !subtitle.isEmpty {
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }
}
