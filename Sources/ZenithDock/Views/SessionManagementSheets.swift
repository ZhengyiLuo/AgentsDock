import SwiftUI
import ZenithCore

struct NewFolderSheet: View {
    @EnvironmentObject private var store: AppStore
    @Binding var isPresented: Bool
    @State private var folderName = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("New Folder")
                .font(.title3.weight(.semibold))
            TextField("Folder name", text: $folderName)
                .onSubmit { create() }
            HStack {
                Spacer()
                Button("Cancel") { isPresented = false }
                Button("Create") { create() }
                    .buttonStyle(.borderedProminent)
                    .disabled(folderName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(20)
        .frame(width: 360)
    }

    private func create() {
        let name = folderName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return }
        Task {
            await store.createSession(folder: name)
            isPresented = false
        }
    }
}

struct ResumeSessionSheet: View {
    @EnvironmentObject private var store: AppStore
    @Binding var isPresented: Bool
    @State private var backend = "claude"
    @State private var providerID = ""
    @State private var title = ""
    @State private var folder = "General"
    @State private var cwd = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Resume Chat")
                .font(.title3.weight(.semibold))
            Picker("Backend", selection: $backend) {
                Text("Claude").tag("claude")
                Text("Codex").tag("codex")
            }
            .pickerStyle(.segmented)
            TextField(backend == "claude" ? "Claude session ID" : "Codex thread ID", text: $providerID)
                .textFieldStyle(.roundedBorder)
            TextField("Title", text: $title)
                .textFieldStyle(.roundedBorder)
            TextField("Folder", text: $folder)
                .textFieldStyle(.roundedBorder)
            TextField("Working directory", text: $cwd)
                .textFieldStyle(.roundedBorder)
            HStack {
                Spacer()
                Button("Cancel") { isPresented = false }
                Button("Resume") { resume() }
                    .buttonStyle(.borderedProminent)
                    .disabled(providerID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(20)
        .frame(width: 460)
        .onAppear {
            if folder.isEmpty {
                folder = store.selectedSession?.folder ?? "General"
            }
        }
    }

    private func resume() {
        Task {
            await store.resumeSession(
                backend: backend,
                providerID: providerID,
                title: title,
                folder: folder,
                cwd: cwd
            )
            isPresented = false
        }
    }
}

struct HandoffDigestSheet: View {
    @EnvironmentObject private var store: AppStore
    @Binding var isPresented: Bool
    let sourceSession: ZSession

    @State private var targetSessionID = ""
    @State private var detail = "normal"
    @State private var userPrompt = ""
    @State private var preview = ""
    @State private var isWorking = false
    @State private var status = ""

    private var targets: [ZSession] {
        store.digestTargetSessions(excluding: sourceSession.id)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Create Digest")
                        .font(.title3.weight(.semibold))
                    Text(sourceSession.title)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer()
                Button {
                    isPresented = false
                } label: {
                    Image(systemName: "xmark")
                }
                .buttonStyle(.borderless)
                .help("Close")
            }

            Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 10) {
                GridRow {
                    Text("Target")
                        .foregroundStyle(.secondary)
                    Picker("Target Chat", selection: $targetSessionID) {
                        Text("Choose chat").tag("")
                        ForEach(targets) { session in
                            Text(session.title).tag(session.id)
                        }
                    }
                    .labelsHidden()
                }
                GridRow {
                    Text("Detail")
                        .foregroundStyle(.secondary)
                    Picker("Detail", selection: $detail) {
                        Text("Short").tag("short")
                        Text("Normal").tag("normal")
                        Text("Deep").tag("deep")
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                }
            }

            TextField("Prompt for target agent", text: $userPrompt, axis: .vertical)
                .textFieldStyle(.roundedBorder)
                .lineLimit(3...7)

            GroupBox {
                if preview.isEmpty {
                    ContentUnavailableView("No Preview", systemImage: "doc.text.magnifyingglass")
                        .frame(maxWidth: .infinity, minHeight: 180)
                } else {
                    ScrollView {
                        Text(preview)
                            .font(.system(.caption, design: .monospaced))
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(10)
                    }
                    .frame(minHeight: 220, idealHeight: 300, maxHeight: 360)
                }
            } label: {
                Label("Preview", systemImage: "doc.text")
            }

            HStack(spacing: 10) {
                if isWorking {
                    ProgressView()
                        .controlSize(.small)
                }
                Text(status)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Spacer()
                Button("Preview") {
                    Task { await previewDigest() }
                }
                .disabled(isWorking)
                Button("Send to Chat") {
                    Task { await sendDigest() }
                }
                .buttonStyle(.borderedProminent)
                .disabled(isWorking || targetSessionID.isEmpty)
            }
        }
        .padding(20)
        .frame(width: 640, height: 660)
        .onAppear {
            if targetSessionID.isEmpty {
                targetSessionID = targets.first?.id ?? ""
            }
        }
        .onChange(of: targets) {
            if !targets.contains(where: { $0.id == targetSessionID }) {
                targetSessionID = targets.first?.id ?? ""
            }
        }
    }

    private func previewDigest() async {
        isWorking = true
        status = "Summarizing with LLM"
        defer { isWorking = false }
        if let digest = await store.createHandoffDigest(
            sourceSessionID: sourceSession.id,
            targetSessionID: targetSessionID.isEmpty ? nil : targetSessionID,
            detail: detail,
            userPrompt: userPrompt
        ) {
            preview = digest
            status = "\(digest.count) characters"
        } else {
            status = "Digest failed"
        }
    }

    private func sendDigest() async {
        guard !targetSessionID.isEmpty else { return }
        isWorking = true
        status = "Starting background digest"
        defer { isWorking = false }
        let ok = await store.sendHandoffDigest(
            sourceSessionID: sourceSession.id,
            targetSessionID: targetSessionID,
            detail: detail,
            userPrompt: userPrompt
        )
        if ok {
            status = "Digest running in target chat"
            await store.select(sessionID: targetSessionID)
            isPresented = false
        } else {
            status = "Send failed"
        }
    }
}
