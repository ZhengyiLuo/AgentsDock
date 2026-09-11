import SwiftUI
import ZenithCore

struct MobileCodeReviewView: View {
    @EnvironmentObject private var store: MobileAppStore
    @Environment(\.dismiss) private var dismiss
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    let sessionID: String
    let runID: String

    @State private var diff: ZUnifiedDiff?
    @State private var selectedPath: String?
    @State private var isLoading = true
    @State private var errorText: String?
    @State private var copied = false

    var body: some View {
        NavigationStack {
            Group {
                if isLoading {
                    ProgressView("Loading complete diff…")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if let errorText {
                    ContentUnavailableView(
                        "Code Review Unavailable",
                        systemImage: "doc.text.magnifyingglass",
                        description: Text(errorText)
                    )
                } else if let diff, !diff.files.isEmpty {
                    reviewWorkspace(diff)
                } else {
                    ContentUnavailableView("No Code Changes", systemImage: "checkmark.circle")
                }
            }
            .navigationTitle("Review")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
                ToolbarItem(placement: .principal) {
                    if let diff {
                        HStack(spacing: 7) {
                            Text("Last turn")
                                .font(.headline)
                            Text("+\(diff.additions)")
                                .foregroundStyle(.green)
                            Text("-\(diff.deletions)")
                                .foregroundStyle(.red)
                        }
                        .font(.caption.monospacedDigit())
                    }
                }
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        copyDiff()
                    } label: {
                        Label(copied ? "Copied" : "Copy Diff", systemImage: copied ? "checkmark" : "doc.on.doc")
                    }
                    .disabled(diff == nil)
                }
            }
        }
        .task(id: "\(sessionID):\(runID)") {
            await loadDiff()
        }
    }

    @ViewBuilder
    private func reviewWorkspace(_ diff: ZUnifiedDiff) -> some View {
        if horizontalSizeClass == .regular {
            HStack(spacing: 0) {
                fileList(diff)
                    .frame(width: 280)
                Divider()
                diffPane(diff)
            }
        } else {
            VStack(spacing: 0) {
                Picker("File", selection: selectedPathBinding(diff)) {
                    ForEach(diff.files) { file in
                        Text(file.path).tag(file.path)
                    }
                }
                .pickerStyle(.menu)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                Divider()
                diffPane(diff)
            }
        }
    }

    private func fileList(_ diff: ZUnifiedDiff) -> some View {
        List {
            ForEach(diff.files) { file in
                Button {
                    selectedPath = file.path
                } label: {
                    VStack(alignment: .leading, spacing: 5) {
                        Text(file.path)
                            .font(.caption.weight(.semibold).monospaced())
                            .lineLimit(3)
                            .truncationMode(.middle)
                        HStack(spacing: 8) {
                            if file.additions > 0 {
                                Text("+\(file.additions)")
                                    .foregroundStyle(.green)
                            }
                            if file.deletions > 0 {
                                Text("-\(file.deletions)")
                                    .foregroundStyle(.red)
                            }
                        }
                        .font(.caption2.monospacedDigit())
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .padding(.vertical, 4)
                .listRowBackground(
                    (selectedPath ?? diff.files.first?.path) == file.path
                        ? Color.accentColor.opacity(0.13)
                        : Color.clear
                )
            }
        }
        .listStyle(.plain)
    }

    private func diffPane(_ diff: ZUnifiedDiff) -> some View {
        let files = selectedFile(in: diff).map { [$0] } ?? diff.files
        return ScrollView([.vertical, .horizontal]) {
            LazyVStack(alignment: .leading, spacing: 12) {
                ForEach(files) { file in
                    VStack(alignment: .leading, spacing: 0) {
                        MobileDiffFileHeader(file: file)
                        ForEach(file.lines) { line in
                            MobileDiffLineRow(line: line)
                        }
                    }
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(MobileTheme.softLine))
                }
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(Color.primary.opacity(0.018))
    }

    private func selectedPathBinding(_ diff: ZUnifiedDiff) -> Binding<String> {
        Binding(
            get: { selectedPath ?? diff.files.first?.path ?? "" },
            set: { selectedPath = $0 }
        )
    }

    private func selectedFile(in diff: ZUnifiedDiff) -> ZDiffFile? {
        let path = selectedPath ?? diff.files.first?.path
        return diff.files.first { $0.path == path }
    }

    private func loadDiff() async {
        isLoading = true
        errorText = nil
        do {
            let source = try await store.api.getText("/api/sessions/\(sessionID)/diffs/\(runID)")
            let parsed = ZUnifiedDiffParser.parse(source)
            guard !Task.isCancelled else { return }
            diff = parsed
            selectedPath = parsed.files.first?.path
            isLoading = false
        } catch {
            guard !Task.isCancelled else { return }
            diff = nil
            errorText = error.localizedDescription
            isLoading = false
        }
    }

    private func copyDiff() {
        guard let source = diff?.source else { return }
        UIPasteboard.general.string = source
        copied = true
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(1.2))
            copied = false
        }
    }
}

private struct MobileDiffFileHeader: View {
    let file: ZDiffFile

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "doc.text")
            Text(file.path)
                .font(.caption.weight(.semibold).monospaced())
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer(minLength: 16)
            if file.additions > 0 {
                Text("+\(file.additions)")
                    .foregroundStyle(.green)
            }
            if file.deletions > 0 {
                Text("-\(file.deletions)")
                    .foregroundStyle(.red)
            }
        }
        .font(.caption.monospacedDigit())
        .padding(.horizontal, 11)
        .padding(.vertical, 9)
        .frame(minWidth: 660, alignment: .leading)
        .background(Color.primary.opacity(0.07))
    }
}

private struct MobileDiffLineRow: View {
    let line: ZDiffLine

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 0) {
            Text(line.oldNumber.map(String.init) ?? " ")
                .frame(width: 42, alignment: .trailing)
            Text(line.newNumber.map(String.init) ?? " ")
                .frame(width: 42, alignment: .trailing)
            Text(line.prefix)
                .frame(width: 20, alignment: .center)
            Text(line.text)
                .textSelection(.enabled)
                .fixedSize(horizontal: true, vertical: false)
                .frame(minWidth: 0, alignment: .leading)
        }
        .font(.system(size: 12.5, weight: .regular, design: .monospaced))
        .foregroundStyle(foreground)
        .padding(.horizontal, 9)
        .padding(.vertical, line.kind == .hunk ? 5 : 2)
        .background(background)
    }

    private var foreground: Color {
        switch line.kind {
        case .added: return .green
        case .removed: return .red
        case .hunk: return .blue
        case .metadata: return .secondary
        case .context: return .primary
        }
    }

    private var background: Color {
        switch line.kind {
        case .added: return .green.opacity(0.14)
        case .removed: return .red.opacity(0.14)
        case .hunk: return .blue.opacity(0.10)
        case .metadata: return .secondary.opacity(0.05)
        case .context: return .clear
        }
    }
}
