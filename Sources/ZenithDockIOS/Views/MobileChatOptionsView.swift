import SwiftUI
import ZenithCore

struct MobileChatOptionsView: View {
    @EnvironmentObject private var store: MobileAppStore
    @Binding var isPresented: Bool
    @Binding var resumeOpen: Bool

    @State private var title = ""
    @State private var folder = "General"
    @State private var cwd = "/home/zen"
    @State private var backend = "claude"
    @State private var pinned = false
    @State private var jobTitle = ""
    @State private var jobPrompt = ""
    @State private var intervalText = "3600"
    @State private var loopJob = true
    @State private var confirmDelete = false

    var body: some View {
        NavigationStack {
            Form {
                if let session = store.selectedSession {
                    Section("Session") {
                        TextField("Chat name", text: $title)
                        Picker("Backend", selection: $backend) {
                            Text("Claude").tag("claude")
                            Text("Codex").tag("codex")
                        }
                        .pickerStyle(.segmented)
                        TextField("Folder", text: $folder)
                        TextField("Working directory", text: $cwd)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                        Toggle("Pinned", isOn: $pinned)
                        Button {
                            saveSession()
                        } label: {
                            Label("Save Changes", systemImage: "checkmark.circle")
                        }
                        .disabled(title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }

                    Section("Actions") {
                        Button {
                            openResume()
                        } label: {
                            Label("Resume Existing Chat", systemImage: "arrow.uturn.forward.circle")
                        }
                        Button {
                            Task {
                                await store.forkSelected()
                                isPresented = false
                            }
                        } label: {
                            Label("Fork Chat", systemImage: "arrow.triangle.branch")
                        }
                        Button(role: .destructive) {
                            confirmDelete = true
                        } label: {
                            Label("Delete Chat", systemImage: "trash")
                        }
                    }

                    Section("Loop Job") {
                        TextField("Job title", text: $jobTitle)
                        TextField("Prompt to run", text: $jobPrompt, axis: .vertical)
                            .lineLimit(3...7)
                        TextField("Interval seconds", text: $intervalText)
                            .keyboardType(.numberPad)
                        Toggle("Loop", isOn: $loopJob)
                        Button {
                            createJob(for: session)
                        } label: {
                            Label("Create Job", systemImage: "clock.badge.plus")
                        }
                        .disabled(jobPrompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && store.prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }

                    Section("Jobs") {
                        let sessionJobs = store.jobs.filter { $0.session_id == session.id }
                        if sessionJobs.isEmpty {
                            Text("No jobs for this chat")
                                .foregroundStyle(.secondary)
                        } else {
                            ForEach(sessionJobs) { job in
                                MobileJobRow(job: job)
                            }
                        }
                    }
                } else {
                    ContentUnavailableView("No Chat Selected", systemImage: "bubble.left")
                }
            }
            .navigationTitle("Chat Options")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { isPresented = false }
                }
            }
        }
        .onAppear { syncDrafts() }
        .onChange(of: store.selectedSessionID) { syncDrafts() }
        .confirmationDialog("Delete chat?", isPresented: $confirmDelete) {
            Button("Delete", role: .destructive) {
                guard let session = store.selectedSession else { return }
                Task {
                    await store.deleteSession(session)
                    isPresented = false
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(store.selectedSession?.title ?? "This chat will be removed from ZenithDock.")
        }
    }

    private func syncDrafts() {
        guard let session = store.selectedSession else { return }
        title = session.title
        folder = session.folder ?? "General"
        cwd = session.cwd ?? "/home/zen"
        backend = session.backend
        pinned = session.pinned == true
    }

    private func saveSession() {
        let cleanTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        let cleanFolder = folder.trimmingCharacters(in: .whitespacesAndNewlines)
        let cleanCwd = cwd.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanTitle.isEmpty else { return }
        Task {
            await store.updateSelected(
                backend: backend,
                folder: cleanFolder.isEmpty ? "General" : cleanFolder,
                title: cleanTitle,
                cwd: cleanCwd.isEmpty ? "/home/zen" : cleanCwd,
                pinned: pinned
            )
            syncDrafts()
        }
    }

    private func openResume() {
        isPresented = false
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(250))
            resumeOpen = true
        }
    }

    private func createJob(for session: ZSession) {
        let prompt = jobPrompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? store.prompt : jobPrompt
        let interval = max(10, Int(intervalText) ?? 3600)
        Task {
            await store.createJob(
                title: jobTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "Loop: \(session.title)" : jobTitle,
                prompt: prompt,
                intervalSeconds: interval,
                loop: loopJob
            )
            jobTitle = ""
            jobPrompt = ""
        }
    }
}

private struct MobileJobRow: View {
    @EnvironmentObject private var store: MobileAppStore
    let job: ZJob

    var body: some View {
        HStack(spacing: 10) {
            Circle()
                .fill(job.enabled ? .green : .secondary)
                .frame(width: 8, height: 8)
            VStack(alignment: .leading, spacing: 3) {
                Text(job.title)
                    .lineLimit(1)
                Text(subtitle)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer()
            Menu {
                Button(job.enabled ? "Pause" : "Enable") {
                    Task { await store.updateJob(job, enabled: !job.enabled) }
                }
                Button(role: .destructive) {
                    Task { await store.deleteJob(job) }
                } label: {
                    Label("Delete", systemImage: "trash")
                }
            } label: {
                Image(systemName: "ellipsis.circle")
            }
        }
    }

    private var subtitle: String {
        let runs = "\(job.run_count ?? 0) run\(job.run_count == 1 ? "" : "s")"
        if let next = job.next_run_at_iso {
            return "\(runs) · next \(next)"
        }
        return runs
    }
}
