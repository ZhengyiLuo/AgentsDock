import SwiftUI

struct InspectorView: View {
    @EnvironmentObject private var store: AppStore
    @State private var folder = ""
    @State private var cwd = ""
    @State private var jobTitle = ""
    @State private var jobPrompt = ""
    @State private var intervalText = "3600"
    @State private var loopJob = true
    @State private var confirmDelete = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
            GroupBox("Security") {
                VStack(alignment: .leading, spacing: 10) {
                    LabeledContent("Server", value: store.serverReachable ? "Online" : "Offline")
                    SecureField("Agent access token", text: $store.accessToken)
                        .textFieldStyle(.roundedBorder)
                        .onChange(of: store.accessToken) {
                            store.rememberAccessToken()
                        }
                        .onSubmit {
                            Task { await store.refresh() }
                        }
                    Button {
                        Task { await store.refresh() }
                    } label: {
                        Label("Check Server", systemImage: "bolt.horizontal.circle")
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(.vertical, 4)
            }

            if let session = store.selectedSession {
                GroupBox("Session") {
                    VStack(alignment: .leading, spacing: 10) {
                        LabeledContent("Backend", value: session.backend)
                        LabeledContent("Pinned", value: session.pinned == true ? "Yes" : "No")
                        LabeledContent("Claude", value: short(session.claude_session_id))
                        LabeledContent("Codex", value: short(session.codex_thread_id))
                        HStack {
                            TextField("Folder", text: $folder)
                                .onSubmit { saveFolder() }
                            Button {
                                saveFolder()
                            } label: {
                                Label("Save", systemImage: "checkmark.circle")
                            }
                            .buttonStyle(.borderless)
                            .labelStyle(.titleAndIcon)
                            .help("Save folder")
                        }
                        HStack {
                            TextField("Working directory", text: $cwd)
                                .onSubmit { saveCwd() }
                            Button {
                                saveCwd()
                            } label: {
                                Label("Save", systemImage: "checkmark.circle")
                            }
                            .buttonStyle(.borderless)
                            .labelStyle(.titleAndIcon)
                            .help("Save working directory")
                        }
                    }
                    .padding(.vertical, 4)
                }

                GroupBox("Run") {
                    VStack(alignment: .leading, spacing: 10) {
                        LabeledContent("Events", value: "\(store.events.count)")
                        LabeledContent("Artifacts", value: "\(store.events.compactMap(\.artifact).count)")
                        LabeledContent("Uploads queued", value: "\(store.uploads.count)")
                        Button {
                            Task { await store.forkSelected() }
                        } label: {
                            Label("Fork Chat", systemImage: "arrow.triangle.branch")
                        }
                        .buttonStyle(.borderedProminent)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .help("Create a new chat from this chat")
                        Button {
                            Task { await store.togglePin(session) }
                        } label: {
                            Label(session.pinned == true ? "Unpin Chat" : "Pin Chat", systemImage: session.pinned == true ? "pin.slash" : "pin")
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .help(session.pinned == true ? "Remove this chat from Pinned" : "Keep this chat in Pinned")
                        Button(role: .destructive) {
                            confirmDelete = true
                        } label: {
                            Label("Delete Chat", systemImage: "trash")
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .help("Delete this chat from Zenith Dock")
                    }
                }

                GroupBox("Jobs") {
                    VStack(alignment: .leading, spacing: 8) {
                        TextField("Job title", text: $jobTitle)
                        TextField("Prompt to run", text: $jobPrompt, axis: .vertical)
                            .lineLimit(3...6)
                        HStack {
                            TextField("Interval seconds", text: $intervalText)
                            Toggle("Loop", isOn: $loopJob)
                        }
                        Button {
                            let title = jobTitle.trimmingCharacters(in: .whitespacesAndNewlines)
                            let prompt = jobPrompt.trimmingCharacters(in: .whitespacesAndNewlines)
                            let interval = max(10, Int(intervalText) ?? 3600)
                            Task {
                                await store.createJob(
                                    title: title.isEmpty ? "Loop: \(session.title)" : title,
                                    prompt: prompt.isEmpty ? store.prompt : prompt,
                                    intervalSeconds: interval,
                                    loop: loopJob
                                )
                                jobTitle = ""
                                jobPrompt = ""
                            }
                        } label: {
                            Label("New Job", systemImage: "clock.badge.plus")
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .disabled((jobPrompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && store.prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty))
                        .help("Schedule this prompt to run again")

                        Divider()
                        ForEach(store.jobs.filter { $0.session_id == session.id }) { job in
                            VStack(alignment: .leading, spacing: 3) {
                                HStack {
                                    Circle()
                                        .fill(job.enabled ? .green : .secondary)
                                        .frame(width: 7, height: 7)
                                    Text(job.title)
                                        .font(.callout.weight(.medium))
                                    Spacer()
                                    Text("\(job.run_count ?? 0)")
                                        .font(.caption.monospacedDigit())
                                        .foregroundStyle(.secondary)
                                }
                                Text(job.next_run_at_iso.map { "Next: \($0)" } ?? "Manual")
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                            }
                            .padding(8)
                            .background(.quaternary)
                            .clipShape(RoundedRectangle(cornerRadius: 7))
                        }
                    }
                }
            } else {
                ContentUnavailableView("No Chat Selected", systemImage: "bubble.left", description: Text("Create or select a chat to start."))
            }
            Spacer()
            }
            .padding(18)
        }
        .background(Theme.panel)
        .onAppear { syncDrafts() }
        .onChange(of: store.selectedSessionID) { syncDrafts() }
        .onChange(of: store.selectedSession?.folder) { syncDrafts() }
        .onChange(of: store.selectedSession?.cwd) { syncDrafts() }
        .confirmationDialog("Delete chat?", isPresented: $confirmDelete) {
            Button("Delete", role: .destructive) {
                guard let session = store.selectedSession else { return }
                Task { await store.deleteSession(session) }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(store.selectedSession?.title ?? "This chat will be removed from Zenith Dock.")
        }
    }

    func short(_ value: String?) -> String {
        guard let value, !value.isEmpty else { return "-" }
        return String(value.prefix(10))
    }

    func syncDrafts() {
        folder = store.selectedSession?.folder ?? "General"
        cwd = store.selectedSession?.cwd ?? "/home/zen"
    }

    func saveFolder() {
        Task { await store.updateSelected(folder: folder.trimmingCharacters(in: .whitespacesAndNewlines)) }
    }

    func saveCwd() {
        Task { await store.updateSelected(cwd: cwd.trimmingCharacters(in: .whitespacesAndNewlines)) }
    }
}
