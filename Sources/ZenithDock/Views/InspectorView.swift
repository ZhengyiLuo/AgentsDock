import AVFoundation
import AppKit
import SwiftUI
import UniformTypeIdentifiers
import ZenithCore

struct InspectorView: View {
    @EnvironmentObject private var store: AppStore
    @State private var serverURLDraft = ""
    @State private var accessTokenDraft = ""
    @State private var isApplyingServerSettings = false
    @State private var title = ""
    @State private var folder = ""
    @State private var cwd = ""
    @State private var backend = "claude"
    @State private var model = ""
    @State private var effort = ""
    @State private var runtimeSaveTask: Task<Void, Never>?
    @State private var runtimeSaveMessage = ""
    @State private var isRuntimeSaving = false
    @State private var runtimeSaveFailed = false
    @State private var jobTitle = ""
    @State private var jobPrompt = ""
    @State private var intervalText = "3600"
    @State private var loopJob = true
    @State private var newJobDetailsOpen = false
    @State private var confirmDelete = false
    @State private var handoffOpen = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
            GroupBox("Security") {
                VStack(alignment: .leading, spacing: 10) {
                    LabeledContent("Server", value: store.serverReachable ? "Online" : "Offline")
                    TextField("Server URL or host:port", text: $serverURLDraft)
                        .textFieldStyle(.roundedBorder)
                        .textSelection(.enabled)
                        .onSubmit { applyServerSettings() }
                    SecureField("Agent access token", text: $accessTokenDraft)
                        .textFieldStyle(.roundedBorder)
                        .onSubmit { applyServerSettings() }
                    Button {
                        applyServerSettings()
                    } label: {
                        Label(isApplyingServerSettings ? "Connecting" : "Apply & Reconnect", systemImage: "bolt.horizontal.circle")
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(serverURLDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isApplyingServerSettings)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(.vertical, 4)
            }

            if let session = store.selectedSession {
                GroupBox("Session") {
                    VStack(alignment: .leading, spacing: 10) {
                        HStack {
                            TextField("Chat name", text: $title)
                                .textFieldStyle(.roundedBorder)
                                .onSubmit { saveTitle() }
                            Button {
                                saveTitle()
                            } label: {
                                Label("Save", systemImage: "checkmark.circle")
                            }
                            .buttonStyle(.borderless)
                            .labelStyle(.titleAndIcon)
                            .disabled(title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                            .help("Save chat name")
                        }
                        Picker("Backend", selection: $backend) {
                            Text("Claude").tag("claude")
                            Text("Codex").tag("codex")
                        }
                        .pickerStyle(.segmented)
                        .disabled(session.isBackendLocked)
                        .help(session.isBackendLocked ? "Backend is locked after chat starts. Fork or create a new chat to use another backend." : "Backend")
                        .onChange(of: backend) {
                            model = ""
                            effort = ""
                            scheduleRuntimeSave()
                        }
                        Picker("Model", selection: $model) {
                            ForEach(modelOptions(for: backend)) { option in
                                Text(option.label).tag(option.value)
                            }
                        }
                        .pickerStyle(.menu)
                        .onChange(of: model) {
                            scheduleRuntimeSave(debounceNanoseconds: 450_000_000)
                        }
                        TextField("Custom model ID", text: $model)
                            .textFieldStyle(.roundedBorder)
                            .font(.caption)
                            .autocorrectionDisabled()
                            .onSubmit { scheduleRuntimeSave(debounceNanoseconds: 0) }
                        Picker("Effort", selection: $effort) {
                            ForEach(effortOptions) { option in
                                Text(option.label).tag(option.value)
                            }
                        }
                        .pickerStyle(.menu)
                        .onChange(of: effort) {
                            scheduleRuntimeSave()
                        }
                        runtimeSaveStatus
                        LabeledContent("Pinned", value: session.pinned == true ? "Yes" : "No")
                        LabeledContent("Archived", value: session.archived == true ? "Yes" : "No")
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
                        LabeledContent("Files", value: "\(store.sessionFiles.count)")
                        LabeledContent("Videos", value: "\(store.sessionVideos.count)")
                        LabeledContent("Uploads queued", value: "\(store.uploads.count)")
                        Button {
                            handoffOpen = true
                        } label: {
                            Label("Create Digest", systemImage: "arrowshape.turn.up.right")
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .help("Create a handoff digest from this chat")
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
                        Button {
                            Task { await store.toggleArchive(session) }
                        } label: {
                            Label(session.archived == true ? "Unarchive Chat" : "Archive Chat", systemImage: "archivebox")
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .help(session.archived == true ? "Return this chat to the active list" : "Move this chat to Archived")
                        Button(role: .destructive) {
                            confirmDelete = true
                        } label: {
                            Label("Delete Chat", systemImage: "trash")
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .help("Delete this chat from Zenith Dock")
                    }
                }

                LiveProcessesInspector()

                ChatFilesInspector(files: store.sessionFiles)

                GroupBox("Jobs") {
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            Text("Schedule a recurring prompt for this chat.")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                                .truncationMode(.middle)
                            Spacer(minLength: 8)
                        }
                        Button {
                            newJobDetailsOpen = true
                        } label: {
                            Label("Schedule Job...", systemImage: "clock.badge.plus")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.large)
                        .help("Create a scheduled job for this chat")

                        Divider()
                        let chatJobs = store.jobs.filter { $0.session_id == session.id }
                        if chatJobs.isEmpty {
                            Text("No jobs for this chat")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        } else {
                            ForEach(chatJobs) { job in
                                ChatJobRow(job: job)
                            }
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
        .onAppear { syncServerDrafts() }
        .onChange(of: store.selectedSessionID) {
            cancelRuntimeSave()
            syncDrafts()
        }
        .onChange(of: store.selectedSession?.title) { syncDrafts() }
        .onChange(of: store.selectedSession?.folder) { syncDrafts() }
        .onChange(of: store.selectedSession?.cwd) { syncDrafts() }
        .onChange(of: store.selectedSession?.backend) { syncDrafts() }
        .onChange(of: store.selectedSession?.model) { syncDrafts() }
        .onChange(of: store.selectedSession?.effort) { syncDrafts() }
        .confirmationDialog("Delete chat?", isPresented: $confirmDelete) {
            Button("Delete", role: .destructive) {
                guard let session = store.selectedSession else { return }
                Task { await store.deleteSession(session) }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(store.selectedSession?.title ?? "This chat will be removed from Zenith Dock.")
        }
        .sheet(isPresented: $handoffOpen) {
            if let session = store.selectedSession {
                HandoffDigestSheet(isPresented: $handoffOpen, sourceSession: session)
                    .environmentObject(store)
            }
        }
        .sheet(isPresented: $newJobDetailsOpen) {
            if let session = store.selectedSession {
                NewJobDetailsSheet(
                    sessionTitle: session.title,
                    composerPrompt: store.prompt,
                    title: $jobTitle,
                    prompt: $jobPrompt,
                    intervalText: $intervalText,
                    loop: $loopJob,
                    isPresented: $newJobDetailsOpen,
                    canSchedule: canCreateJob,
                    scheduleSummary: jobDraftSummary(for: session),
                    onSchedule: {
                        createJob(for: session)
                        newJobDetailsOpen = false
                    }
                )
            }
        }
    }

    func short(_ value: String?) -> String {
        guard let value, !value.isEmpty else { return "-" }
        return String(value.prefix(10))
    }

    func syncDrafts() {
        title = store.selectedSession?.title ?? ""
        folder = store.selectedSession?.folder ?? "General"
        cwd = store.selectedSession?.cwd ?? store.defaultCwd
        backend = store.selectedSession?.backend ?? "claude"
        model = store.selectedSession?.model ?? ""
        effort = store.selectedSession?.effort ?? ""
    }

    func syncServerDrafts() {
        serverURLDraft = store.serverURLString
        accessTokenDraft = store.accessToken
    }

    func applyServerSettings() {
        let cleanServerURL = serverURLDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanServerURL.isEmpty else { return }
        isApplyingServerSettings = true
        Task {
            await store.applyServerSettings(serverURL: cleanServerURL, accessToken: accessTokenDraft)
            await MainActor.run {
                isApplyingServerSettings = false
                syncServerDrafts()
            }
        }
    }

    func saveTitle() {
        let clean = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else { return }
        Task { await store.updateSelected(title: clean) }
    }

    @ViewBuilder
    var runtimeSaveStatus: some View {
        if isRuntimeSaving || !runtimeSaveMessage.isEmpty {
            HStack(spacing: 6) {
                if isRuntimeSaving {
                    ProgressView()
                        .controlSize(.small)
                } else {
                    Image(systemName: runtimeSaveFailed ? "exclamationmark.triangle.fill" : "checkmark.circle.fill")
                        .foregroundStyle(runtimeSaveFailed ? .orange : .green)
                }
                Text(runtimeSaveMessage)
                    .font(.caption)
                    .foregroundStyle(runtimeSaveFailed ? .orange : .secondary)
                Spacer(minLength: 0)
            }
            .padding(.top, 1)
        }
    }

    func scheduleRuntimeSave(debounceNanoseconds: UInt64 = 180_000_000) {
        guard runtimeSelectionChanged else {
            runtimeSaveTask?.cancel()
            if !isRuntimeSaving {
                runtimeSaveMessage = ""
                runtimeSaveFailed = false
            }
            return
        }
        runtimeSaveTask?.cancel()
        isRuntimeSaving = true
        runtimeSaveFailed = false
        runtimeSaveMessage = "Saving runtime..."
        let selectedID = store.selectedSessionID
        let backendValue = backend
        let modelValue = ZRuntimeCatalog.cleanForAPI(model)
        let effortValue = ZRuntimeCatalog.cleanForAPI(effort)
        runtimeSaveTask = Task {
            if debounceNanoseconds > 0 {
                try? await Task.sleep(nanoseconds: debounceNanoseconds)
            }
            guard !Task.isCancelled else { return }
            let saved = await store.updateSelected(
                backend: backendValue,
                model: modelValue,
                effort: effortValue
            )
            guard !Task.isCancelled else { return }
            await MainActor.run {
                guard store.selectedSessionID == selectedID else { return }
                isRuntimeSaving = false
                runtimeSaveFailed = !saved
                runtimeSaveMessage = saved ? "Runtime saved" : "Runtime save failed"
                if saved {
                    syncDrafts()
                }
            }
        }
    }

    func cancelRuntimeSave() {
        runtimeSaveTask?.cancel()
        runtimeSaveTask = nil
        isRuntimeSaving = false
        runtimeSaveFailed = false
        runtimeSaveMessage = ""
    }

    var runtimeSelectionChanged: Bool {
        guard let session = store.selectedSession else { return false }
        return backend != session.backend ||
            (ZRuntimeCatalog.cleanForAPI(model) ?? "") != (session.model ?? "") ||
            (ZRuntimeCatalog.cleanForAPI(effort) ?? "") != (session.effort ?? "")
    }

    func saveFolder() {
        Task { await store.updateSelected(folder: folder.trimmingCharacters(in: .whitespacesAndNewlines)) }
    }

    func saveCwd() {
        Task { await store.updateSelected(cwd: cwd.trimmingCharacters(in: .whitespacesAndNewlines)) }
    }

    var cleanJobPrompt: String {
        jobPrompt.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var effectiveJobPrompt: String {
        cleanJobPrompt.isEmpty ? store.prompt.trimmingCharacters(in: .whitespacesAndNewlines) : cleanJobPrompt
    }

    var parsedJobInterval: Int? {
        guard let value = Int(intervalText.trimmingCharacters(in: .whitespacesAndNewlines)), value >= 10 else {
            return nil
        }
        return value
    }

    var canCreateJob: Bool {
        !effectiveJobPrompt.isEmpty && parsedJobInterval != nil
    }

    func createJob(for session: ZSession) {
        guard let interval = parsedJobInterval, !effectiveJobPrompt.isEmpty else { return }
        let cleanTitle = jobTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        Task {
            await store.createJob(
                title: cleanTitle.isEmpty ? "\(loopJob ? "Loop" : "Job"): \(session.title)" : cleanTitle,
                prompt: effectiveJobPrompt,
                intervalSeconds: interval,
                loop: loopJob
            )
            jobTitle = ""
            jobPrompt = ""
        }
    }

    func jobDraftSummary(for session: ZSession) -> String {
        let promptSource = cleanJobPrompt.isEmpty ? "composer prompt" : "custom prompt"
        let interval = parsedJobInterval.map(formatInterval) ?? "invalid interval"
        return "\(loopJob ? "Loop" : "One shot") · \(interval) · \(promptSource)"
    }

    func formatInterval(_ seconds: Int) -> String {
        if seconds < 60 {
            return "every \(seconds)s"
        }
        if seconds < 3600 {
            return "every \(seconds / 60)m \(seconds % 60)s"
        }
        if seconds.isMultiple(of: 3600) {
            return "every \(seconds / 3600)h"
        }
        return "every \(seconds / 3600)h \((seconds % 3600) / 60)m"
    }

    func modelOptions(for backend: String) -> [ZRuntimeOption] {
        optionsWithCurrent(store.runtimeCatalog.models(for: backend), current: model)
    }

    var effortOptions: [ZRuntimeOption] {
        optionsWithCurrent(store.runtimeCatalog.efforts(for: backend), current: effort)
    }

    func optionsWithCurrent(_ options: [ZRuntimeOption], current: String) -> [ZRuntimeOption] {
        let clean = current.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty, !options.contains(where: { $0.value == clean }) else {
            return options
        }
        return options + [ZRuntimeOption(value: clean, label: clean)]
    }
}

private struct NewJobDetailsSheet: View {
    let sessionTitle: String
    let composerPrompt: String
    @Binding var title: String
    @Binding var prompt: String
    @Binding var intervalText: String
    @Binding var loop: Bool
    @Binding var isPresented: Bool
    let canSchedule: Bool
    let scheduleSummary: String
    let onSchedule: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Schedule Job")
                        .font(.title3.weight(.semibold))
                    Text(sessionTitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer()
                Button("Cancel") {
                    isPresented = false
                }
                .keyboardShortcut(.cancelAction)
                Button {
                    onSchedule()
                } label: {
                    Label("Schedule Job", systemImage: "clock.badge.plus")
                }
                .buttonStyle(.borderedProminent)
                .disabled(!canSchedule)
                .keyboardShortcut(.defaultAction)
            }

            Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 10) {
                GridRow {
                    Text("Title").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    TextField("Job title", text: $title)
                        .textFieldStyle(.roundedBorder)
                }
                GridRow {
                    Text("Interval").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    HStack(spacing: 8) {
                        TextField("Seconds", text: $intervalText)
                            .textFieldStyle(.roundedBorder)
                            .font(.body.monospacedDigit())
                            .frame(width: 120)
                        Text("seconds")
                            .foregroundStyle(.secondary)
                        if !intervalIsValid {
                            Text("Minimum 10")
                                .font(.caption)
                                .foregroundStyle(.red)
                        }
                    }
                }
                GridRow {
                    Text("Mode").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    Toggle("Loop", isOn: $loop)
                }
            }

            VStack(alignment: .leading, spacing: 7) {
                HStack {
                    Text("Prompt")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                    Spacer()
                    if !composerPrompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        Button("Use Composer") {
                            prompt = composerPrompt
                        }
                        .controlSize(.small)
                    }
                }
                TextEditor(text: $prompt)
                    .font(.body.monospaced())
                    .frame(minHeight: 220)
                    .scrollContentBackground(.hidden)
                    .padding(8)
                    .background(Theme.card)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.softLine))
                Text(prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "Empty prompt uses the current composer text when you create the job." : "\(prompt.count) characters")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }

            HStack {
                Text(scheduleSummary)
                    .font(.caption)
                    .foregroundStyle(canSchedule ? Color.secondary : Color.red)
                    .lineLimit(2)
                Spacer()
                Button {
                    onSchedule()
                } label: {
                    Label("Schedule Job", systemImage: "clock.badge.plus")
                }
                .buttonStyle(.borderedProminent)
                .disabled(!canSchedule)
            }
        }
        .padding(18)
        .frame(minWidth: 620, idealWidth: 720, minHeight: 500, idealHeight: 600)
    }

    private var intervalIsValid: Bool {
        Int(intervalText.trimmingCharacters(in: .whitespacesAndNewlines)).map { $0 >= 10 } ?? false
    }
}

private struct ChatJobRow: View {
    @EnvironmentObject private var store: AppStore
    let job: ZJob
    @State private var editorOpen = false

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 8) {
                Circle()
                    .fill(job.enabled ? .green : .secondary)
                    .frame(width: 7, height: 7)
                Text(job.title)
                    .font(.callout.weight(.medium))
                    .lineLimit(1)
                Spacer(minLength: 8)
                Text("\(job.run_count ?? 0)")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
            }

            Text(subtitle)
                .font(.caption2)
                .foregroundStyle(.secondary)
                .lineLimit(1)

            HStack(spacing: 8) {
                Button {
                    editorOpen = true
                } label: {
                    Label("Edit", systemImage: "slider.horizontal.3")
                }
                .controlSize(.mini)
                .help("Edit job prompt, interval, backend, and loop behavior")

                Button {
                    Task { await store.runJobNow(job) }
                } label: {
                    Label("Run now", systemImage: "play.fill")
                }
                .controlSize(.mini)
                .help("Run this job now")

                Button {
                    Task { await store.updateJob(job, enabled: !job.enabled) }
                } label: {
                    Label(job.enabled ? "Pause" : "Enable", systemImage: job.enabled ? "pause.fill" : "play")
                }
                .controlSize(.mini)
                .help(job.enabled ? "Pause this job" : "Enable this job")

                Button(role: .destructive) {
                    Task { await store.deleteJob(job) }
                } label: {
                    Label("Delete", systemImage: "trash")
                }
                .controlSize(.mini)
                .help("Delete this job")
            }
            .labelStyle(.iconOnly)
        }
        .padding(8)
        .background(.quaternary)
        .clipShape(RoundedRectangle(cornerRadius: 7))
        .sheet(isPresented: $editorOpen) {
            JobEditorSheet(job: currentJob, isPresented: $editorOpen)
                .environmentObject(store)
        }
    }

    private var currentJob: ZJob {
        store.jobs.first(where: { $0.id == job.id }) ?? job
    }

    private var subtitle: String {
        var parts = [job.loop == true ? "Loop" : "One shot"]
        if let interval = job.interval_seconds {
            parts.append(everyString(interval))
        }
        if job.enabled, let next = localTimestampString(job.next_run_at_iso) {
            parts.append("next \(next)")
        } else if !job.enabled {
            parts.append("paused")
        }
        return parts.joined(separator: " · ")
    }

    private func everyString(_ seconds: Int) -> String {
        if seconds < 60 {
            return "every \(seconds)s"
        }
        if seconds < 3600 {
            return "every \(seconds / 60)m"
        }
        if seconds.isMultiple(of: 3600) {
            return "every \(seconds / 3600)h"
        }
        return "every \(seconds / 3600)h \((seconds % 3600) / 60)m"
    }
}

private struct JobEditorSheet: View {
    @EnvironmentObject private var store: AppStore
    let job: ZJob
    @Binding var isPresented: Bool
    @State private var title = ""
    @State private var prompt = ""
    @State private var intervalText = "3600"
    @State private var loop = true
    @State private var enabled = true
    @State private var backend = "claude"
    @State private var isSaving = false

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Edit Job")
                        .font(.title3.weight(.semibold))
                    Text(job.id)
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button("Cancel") {
                    isPresented = false
                }
                Button {
                    save()
                } label: {
                    Label(isSaving ? "Saving" : "Save", systemImage: "checkmark.circle.fill")
                }
                .buttonStyle(.borderedProminent)
                .disabled(!canSave || isSaving)
                .keyboardShortcut(.defaultAction)
            }

            Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 10) {
                GridRow {
                    Text("Title").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    TextField("Job title", text: $title)
                        .textFieldStyle(.roundedBorder)
                }
                GridRow {
                    Text("Backend").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    Picker("Backend", selection: $backend) {
                        Text("Claude").tag("claude")
                        Text("Codex").tag("codex")
                    }
                    .pickerStyle(.segmented)
                    .frame(width: 180)
                }
                GridRow {
                    Text("Interval").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    HStack(spacing: 8) {
                        TextField("Seconds", text: $intervalText)
                            .textFieldStyle(.roundedBorder)
                            .font(.body.monospacedDigit())
                            .frame(width: 120)
                        Text("seconds")
                            .foregroundStyle(.secondary)
                        if !intervalIsValid {
                            Text("Minimum 10")
                                .font(.caption)
                                .foregroundStyle(.red)
                        }
                    }
                }
                GridRow {
                    Text("Options").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    HStack(spacing: 16) {
                        Toggle("Loop", isOn: $loop)
                        Toggle("Enabled", isOn: $enabled)
                    }
                }
            }

            VStack(alignment: .leading, spacing: 7) {
                Text("Prompt")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                TextEditor(text: $prompt)
                    .font(.body.monospaced())
                    .frame(minHeight: 190)
                    .scrollContentBackground(.hidden)
                    .padding(8)
                    .background(Theme.card)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.softLine))
            }
        }
        .padding(18)
        .frame(minWidth: 620, idealWidth: 720, minHeight: 480, idealHeight: 560)
        .onAppear { syncDrafts() }
        .onChange(of: job.id) { syncDrafts() }
    }

    private var cleanTitle: String {
        title.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var cleanPrompt: String {
        prompt.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var parsedInterval: Int? {
        Int(intervalText.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    private var intervalIsValid: Bool {
        parsedInterval.map { $0 >= 10 } ?? false
    }

    private var canSave: Bool {
        !cleanTitle.isEmpty && !cleanPrompt.isEmpty && intervalIsValid
    }

    private func syncDrafts() {
        title = job.title
        prompt = job.prompt
        intervalText = "\(job.interval_seconds ?? 3600)"
        loop = job.loop == true
        enabled = job.enabled
        backend = job.backend ?? store.selectedSession?.backend ?? "claude"
    }

    private func save() {
        guard let parsedInterval, canSave else { return }
        isSaving = true
        Task {
            await store.updateJob(
                job,
                title: cleanTitle,
                prompt: cleanPrompt,
                intervalSeconds: parsedInterval,
                loop: loop,
                enabled: enabled,
                backend: backend
            )
            await MainActor.run {
                isSaving = false
                isPresented = false
            }
        }
    }
}

private struct LiveProcessesInspector: View {
    @EnvironmentObject private var store: AppStore
    @State private var isOpen = false

    var body: some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Label("Live Processes", systemImage: "terminal")
                        .font(.headline)
                    Spacer()
                    if store.isLoadingProcesses {
                        ProgressView()
                            .controlSize(.small)
                    }
                    if isOpen {
                        Button {
                            Task { await store.refreshSelectedProcesses() }
                        } label: {
                            Image(systemName: "arrow.clockwise")
                        }
                        .buttonStyle(.borderless)
                        .help("Refresh live processes")
                        Button {
                            isOpen = false
                            store.processSnapshot = nil
                            store.processLogTail = nil
                        } label: {
                            Image(systemName: "chevron.up")
                        }
                        .buttonStyle(.borderless)
                        .help("Hide live process output")
                    }
                }

                if isOpen {
                    if let snapshot = store.processSnapshot, snapshot.active {
                        snapshotHeader(snapshot)
                        VStack(alignment: .leading, spacing: 6) {
                            ForEach(snapshot.processes) { process in
                                LiveProcessRow(process: process)
                                    .environmentObject(store)
                            }
                        }
                        if let output = snapshot.stdout_tail {
                            LiveProcessOutputView(output: output)
                        }
                        if let log = store.processLogTail {
                            LiveProcessLogView(log: log)
                        }
                    } else {
                        Text(store.isRunning ? "No process snapshot yet" : "No live process for this chat")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                } else {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(store.isRunning ? "Live process inspection is available on request." : "No live process inspection loaded.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Button {
                            isOpen = true
                            Task { await store.refreshSelectedProcesses() }
                        } label: {
                            Label("Inspect Live Process", systemImage: "terminal")
                        }
                        .controlSize(.small)
                        .disabled(store.selectedSessionID == nil || store.isLoadingProcesses)
                    }
                }
            }
            .padding(.vertical, 4)
        }
        .onChange(of: store.selectedSessionID) {
            isOpen = false
            store.processSnapshot = nil
            store.processLogTail = nil
        }
    }

    private func snapshotHeader(_ snapshot: ZProcessSnapshot) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Text(snapshot.backend?.capitalized ?? "Agent")
                    .font(.caption.weight(.semibold))
                Text("pid \(snapshot.pid ?? 0)")
                Text("pgid \(snapshot.pgid ?? 0)")
                Text(elapsedString(snapshot.elapsed_seconds ?? 0))
            }
            .font(.caption.monospacedDigit())
            .foregroundStyle(.secondary)
            if let cwd = snapshot.cwd, !cwd.isEmpty {
                Text(cwd)
                    .font(.caption2.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
        }
    }
}

private struct LiveProcessRow: View {
    @EnvironmentObject private var store: AppStore
    let process: ZProcessInfo
    @State private var detailsOpen = false

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 7) {
                Circle()
                    .fill(statusColor)
                    .frame(width: 7, height: 7)
                Text(process.command ?? "process")
                    .font(.caption.weight(.semibold))
                    .lineLimit(1)
                Spacer(minLength: 4)
                Text("pid \(process.pid)")
                Text(cpuText)
                Text(memoryText)
                Button {
                    detailsOpen = true
                } label: {
                    Image(systemName: "info.circle")
                }
                .buttonStyle(.borderless)
                .help("Show process details")
            }
            .font(.caption.monospacedDigit())
            .foregroundStyle(.secondary)

            if let args = process.args, !args.isEmpty {
                Text(args)
                    .font(.caption2.monospaced())
                    .foregroundStyle(.primary)
                    .lineLimit(2)
                    .truncationMode(.middle)
                    .textSelection(.enabled)
            }

            if let hints = process.log_hints, !hints.isEmpty {
                HStack(spacing: 6) {
                    ForEach(hints) { hint in
                        Button {
                            Task { await store.tailProcessLog(hint) }
                        } label: {
                            Label(hint.source, systemImage: "doc.text.magnifyingglass")
                        }
                        .controlSize(.mini)
                        .help(hint.path)
                    }
                }
            }
        }
        .padding(8)
        .padding(.leading, CGFloat(process.depth ?? 0) * 12)
        .background(Theme.card)
        .clipShape(RoundedRectangle(cornerRadius: 7))
        .overlay(RoundedRectangle(cornerRadius: 7).stroke(Theme.softLine))
        .contentShape(RoundedRectangle(cornerRadius: 7))
        .onTapGesture {
            detailsOpen = true
        }
        .sheet(isPresented: $detailsOpen) {
            LiveProcessDetailSheet(process: process)
                .environmentObject(store)
        }
    }

    private var statusColor: Color {
        if process.stat?.contains("Z") == true { return .red }
        if (process.cpu_percent ?? 0) > 20 { return .orange }
        return .green
    }

    private var cpuText: String {
        String(format: "%.1f%%", process.cpu_percent ?? 0)
    }

    private var memoryText: String {
        byteString((process.rss_kb ?? 0) * 1024)
    }
}

private struct LiveProcessDetailSheet: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    let process: ZProcessInfo
    @State private var selectedLogPath: String?

    private var commandText: String {
        let args = process.args?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !args.isEmpty {
            return args
        }
        return process.command ?? "process"
    }

    private var hasAttachedLog: Bool {
        guard let log = store.processLogTail else { return false }
        if let selectedLogPath, samePath(selectedLogPath, log.path) {
            return true
        }
        return process.log_hints?.contains(where: { samePath($0.path, log.path) }) == true
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 3) {
                    Label(process.command ?? "Process", systemImage: "terminal")
                        .font(.title3.weight(.semibold))
                    Text("pid \(process.pid)")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button("Done") {
                    dismiss()
                }
                .keyboardShortcut(.cancelAction)
            }

            HStack(alignment: .top, spacing: 10) {
                fact("State", process.stat ?? "-")
                fact("Parent", process.ppid.map { "\($0)" } ?? "-")
                fact("Group", process.pgid.map { "\($0)" } ?? "-")
                fact("CPU", String(format: "%.1f%%", process.cpu_percent ?? 0))
                fact("RSS", byteString((process.rss_kb ?? 0) * 1024))
                fact("Elapsed", elapsedString(process.elapsed_seconds ?? 0))
            }

            if let cwd = process.cwd, !cwd.isEmpty {
                detailBlock(title: "Working Directory", value: cwd, maxHeight: 70)
            }

            detailBlock(title: "Command", value: commandText, minHeight: 110, maxHeight: 180)

            if let hints = process.log_hints, !hints.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Attached Logs")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(hints) { hint in
                                Button {
                                    selectedLogPath = hint.path
                                    Task { await store.tailProcessLog(hint) }
                                } label: {
                                    Label(hint.source, systemImage: "doc.text.magnifyingglass")
                                }
                                .controlSize(.small)
                                .help(hint.path)
                            }
                        }
                    }
                }
            }

            if hasAttachedLog, let log = store.processLogTail {
                LiveProcessLogView(log: log)
            } else {
                Text("Pick an attached log to inspect its latest tail.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(20)
        .frame(minWidth: 640, idealWidth: 760, minHeight: 520, alignment: .topLeading)
        .background(Theme.window)
    }

    private func fact(_ title: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.secondary)
            Text(value)
                .font(.caption.monospacedDigit())
                .lineLimit(1)
                .minimumScaleFactor(0.8)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(9)
        .background(Theme.card)
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.softLine))
    }

    private func detailBlock(title: String, value: String, minHeight: CGFloat? = nil, maxHeight: CGFloat? = nil) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(title)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                Spacer()
                Button {
                    copyToPasteboard(value)
                } label: {
                    Image(systemName: "doc.on.doc")
                }
                .buttonStyle(.borderless)
                .help("Copy \(title.lowercased())")
            }
            ScrollView {
                Text(value)
                    .font(.caption.monospaced())
                    .foregroundStyle(.primary)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(10)
            }
            .frame(minHeight: minHeight, maxHeight: maxHeight)
            .background(Theme.card)
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.softLine))
        }
    }

    private func copyToPasteboard(_ string: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(string, forType: .string)
    }

    private func samePath(_ lhs: String, _ rhs: String) -> Bool {
        if lhs == rhs {
            return true
        }
        return URL(fileURLWithPath: lhs).standardizedFileURL.path == URL(fileURLWithPath: rhs).standardizedFileURL.path
    }
}

private struct LiveProcessOutputView: View {
    let output: ZProcessOutputTail
    @State private var copied = false
    @State private var isExpanded = true

    private var bodyText: String {
        output.text.isEmpty ? "(no stdout captured yet)" : output.text
    }

    private var detailText: String {
        var parts: [String] = []
        if let backend = output.backend {
            parts.append(backend)
        }
        if let runID = output.run_id {
            parts.append(runID)
        }
        if let total = output.total_lines {
            parts.append("\(total) line\(total == 1 ? "" : "s")")
        }
        if output.truncated == true {
            parts.append("tail")
        }
        return parts.joined(separator: " · ")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Button {
                    isExpanded.toggle()
                } label: {
                    Label("Live stdout", systemImage: isExpanded ? "chevron.down" : "chevron.right")
                        .font(.caption.weight(.semibold))
                }
                .buttonStyle(.plain)
                .help(isExpanded ? "Collapse stdout" : "Expand stdout")
                Spacer()
                if !detailText.isEmpty {
                    Text(detailText)
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Button {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(output.text, forType: .string)
                    copied = true
                    Task {
                        try? await Task.sleep(nanoseconds: 900_000_000)
                        await MainActor.run { copied = false }
                    }
                } label: {
                    Image(systemName: copied ? "checkmark" : "doc.on.doc")
                }
                .buttonStyle(.borderless)
                .help("Copy stdout")
                .disabled(output.text.isEmpty)
                Button {
                    isExpanded = false
                } label: {
                    Image(systemName: "xmark.circle")
                }
                .buttonStyle(.borderless)
                .help("Hide stdout details")
                .disabled(!isExpanded)
            }
            if isExpanded {
                ScrollView {
                    Text(bodyText)
                        .font(.caption2.monospaced())
                        .foregroundStyle(output.text.isEmpty ? .secondary : .primary)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(8)
                }
                .frame(minHeight: 110, maxHeight: 240)
                .background(Color.black.opacity(0.18))
                .clipShape(RoundedRectangle(cornerRadius: 7))
                .overlay(RoundedRectangle(cornerRadius: 7).stroke(Theme.softLine))
            } else if !output.text.isEmpty {
                Text(output.text.split(separator: "\n").last.map(String.init) ?? "")
                    .font(.caption2.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
        }
        .padding(.top, 2)
    }
}

private struct LiveProcessLogView: View {
    let log: ZProcessLogTail

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Label("Log Tail", systemImage: "doc.text")
                    .font(.caption.weight(.semibold))
                Spacer()
                Text(byteString(log.size ?? 0))
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            Text(log.path)
                .font(.caption2.monospaced())
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
                .textSelection(.enabled)
            ScrollView {
                Text(log.text.isEmpty ? "(empty log)" : log.text)
                    .font(.caption2.monospaced())
                    .foregroundStyle(.primary)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(8)
            }
            .frame(minHeight: 96, maxHeight: 220)
            .background(.black.opacity(0.18))
            .clipShape(RoundedRectangle(cornerRadius: 7))
            .overlay(RoundedRectangle(cornerRadius: 7).stroke(Theme.softLine))
        }
        .padding(.top, 4)
    }
}

private func elapsedString(_ seconds: Int) -> String {
    if seconds < 60 {
        return "\(seconds)s"
    }
    if seconds < 3600 {
        return "\(seconds / 60)m \(seconds % 60)s"
    }
    return "\(seconds / 3600)h \((seconds % 3600) / 60)m"
}

private struct ChatFilesInspector: View {
    @EnvironmentObject private var store: AppStore
    let files: [ZFile]
    @AppStorage("zenithdock.filesInspector.expanded") private var isExpanded = false
    @State private var visibleVideoCount = 8
    @State private var visibleDocumentCount = 10

    private let videoPageSize = 8
    private let documentPageSize = 12

    private var videos: [ZFile] {
        sortedLatestFirst(store.sessionVideos)
    }

    private var documents: [ZFile] {
        sortedLatestFirst(files.filter { !($0.content_type ?? "").hasPrefix("video/") })
    }

    private var visibleVideos: [ZFile] {
        Array(videos.prefix(visibleVideoCount))
    }

    private var videoRows: [[ZFile]] {
        let current = visibleVideos
        return stride(from: 0, to: current.count, by: 2).map { index in
            Array(current[index..<min(index + 2, current.count)])
        }
    }

    private var fileChangeToken: String {
        "\(files.count):\(videos.count):\(files.first?.id ?? ""):\(files.last?.id ?? ""):\(videos.first?.id ?? "")"
    }

    var body: some View {
        GroupBox {
            DisclosureGroup(isExpanded: $isExpanded) {
                VStack(alignment: .leading, spacing: 10) {
                    if files.isEmpty && videos.isEmpty {
                        Text("No files in this chat yet")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    } else {
                        if !videos.isEmpty {
                            videoSection
                        }
                        if !documents.isEmpty {
                            fileSection(videos.isEmpty ? "Files" : "Other Files", files: documents)
                        }
                        if store.sessionFilesHasMore {
                            Button {
                                Task { await store.loadMoreSelectedFiles() }
                            } label: {
                                Label(store.isLoadingSessionFiles ? "Loading" : "Load More Files", systemImage: "arrow.down.circle")
                            }
                            .controlSize(.small)
                            .disabled(store.isLoadingSessionFiles)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .help("Load the next page of files for this chat")
                        }
                    }
                }
                .padding(.top, 10)
            } label: {
                HStack(spacing: 8) {
                    Label("Files & Videos", systemImage: "paperclip")
                        .font(.headline)
                    Text(summaryText)
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(.secondary)
                    Spacer()
                    Button {
                        Task { await store.refreshSelectedFiles() }
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                    .buttonStyle(.borderless)
                    .help("Refresh files for this chat")
                }
            }
            .padding(.vertical, 4)
        }
        .onChange(of: store.selectedSessionID) {
            resetVisibleCounts()
        }
        .onChange(of: fileChangeToken) {
            visibleVideoCount = min(max(visibleVideoCount, 8), max(videos.count, 8))
            visibleDocumentCount = min(max(visibleDocumentCount, 10), max(documents.count, 10))
        }
    }

    private var videoSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionHeader("Videos", visible: min(visibleVideoCount, videos.count), total: videos.count)
            VStack(alignment: .leading, spacing: 8) {
                ForEach(Array(videoRows.enumerated()), id: \.offset) { _, row in
                    HStack(alignment: .top, spacing: 8) {
                        ForEach(row) { file in
                            ChatVideoGridCell(file: file, url: store.fileURL(file))
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        if row.count == 1 {
                            Color.clear
                                .frame(maxWidth: .infinity)
                        }
                    }
                }
            }
            if visibleVideoCount < videos.count {
                showMoreButton(title: "Show More Videos", count: videos.count - visibleVideoCount) {
                    visibleVideoCount = min(videos.count, visibleVideoCount + videoPageSize)
                }
            }
        }
    }

    @ViewBuilder
    private func fileSection(_ title: String, files: [ZFile]) -> some View {
        sectionHeader(title, visible: min(visibleDocumentCount, files.count), total: files.count)
        VStack(alignment: .leading, spacing: 7) {
            ForEach(Array(files.prefix(visibleDocumentCount))) { file in
                ChatFileRow(file: file, url: store.fileURL(file))
            }
        }
        if visibleDocumentCount < files.count {
            showMoreButton(title: "Show More Files", count: files.count - visibleDocumentCount) {
                visibleDocumentCount = min(files.count, visibleDocumentCount + documentPageSize)
            }
        }
    }

    private var summaryText: String {
        let loaded = files.count
        let total = store.sessionFilesTotal.map(String.init) ?? "\(loaded)"
        let base = "\(loaded)/\(total)"
        if store.sessionFilesHasMore {
            return "\(base) loaded"
        }
        return "\(loaded)"
    }

    private func resetVisibleCounts() {
        visibleVideoCount = 8
        visibleDocumentCount = 10
    }

    private func sectionHeader(_ title: String, visible: Int, total: Int) -> some View {
        HStack {
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            Spacer()
            if total > visible {
                Text("\(visible)/\(total)")
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(.tertiary)
            } else {
                Text("\(total)")
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(.tertiary)
            }
        }
    }

    private func showMoreButton(title: String, count: Int, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label("\(title) (\(count))", systemImage: "chevron.down.circle")
        }
        .controlSize(.small)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func sortedLatestFirst(_ source: [ZFile]) -> [ZFile] {
        source.sorted { lhs, rhs in
            let leftDate = lhs.created_at ?? ""
            let rightDate = rhs.created_at ?? ""
            if leftDate != rightDate {
                return leftDate > rightDate
            }
            return lhs.filename.localizedStandardCompare(rhs.filename) == .orderedAscending
        }
    }
}

private struct ChatVideoGridCell: View {
    @EnvironmentObject private var store: AppStore
    let file: ZFile
    let url: URL
    @State private var thumbnail: NSImage?
    @State private var thumbnailFailed = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                VideoFullscreenPresenter.present(url: url)
            } label: {
                VideoThumbnailPreview(image: thumbnail, failed: thumbnailFailed)
                    .frame(height: 64)
                    .overlay {
                        Image(systemName: "play.circle.fill")
                            .font(.title3.weight(.semibold))
                            .foregroundStyle(.white.opacity(0.92))
                            .shadow(radius: 3)
                    }
            }
            .buttonStyle(.plain)
            .help("Play video")
            .accessibilityLabel("Play video")
            .task(id: url.absoluteString) {
                await loadThumbnail()
            }
            Text(file.title ?? file.filename)
                .font(.caption.weight(.semibold))
                .lineLimit(2)
                .truncationMode(.middle)
                .frame(maxWidth: .infinity, alignment: .leading)
            Text(detail)
                .font(.caption2)
                .foregroundStyle(.secondary)
                .lineLimit(1)
            HStack(spacing: 6) {
                Button {
                    VideoFullscreenPresenter.present(url: url)
                } label: {
                    Label("Play", systemImage: "play.fill")
                }
                .controlSize(.mini)
                .help("Open video player")

                Button {
                    Task { await store.findFileInChat(file) }
                } label: {
                    Label("Find", systemImage: "text.magnifyingglass")
                }
                .controlSize(.mini)
                .help("Find in chat")

                Link(destination: url) {
                    Image(systemName: "arrow.up.right.square")
                }
                .help("Open file")
            }
            .font(.caption2)
        }
        .padding(7)
        .background(Theme.card)
        .clipShape(RoundedRectangle(cornerRadius: 7))
        .overlay(RoundedRectangle(cornerRadius: 7).stroke(Theme.softLine))
        .onDrag {
            ArtifactDragItemProvider.provider(for: file, url: url)
        }
        .help("Drag to Finder or another app")
    }

    private var detail: String {
        file.size.map(byteString) ?? "Video"
    }

    @MainActor
    private func loadThumbnail() async {
        thumbnail = nil
        thumbnailFailed = false
        let data = await VideoThumbnailCache.shared.thumbnailData(for: url)
        guard !Task.isCancelled else { return }
        guard let data else {
            thumbnailFailed = true
            return
        }
        thumbnail = NSImage(data: data)
        thumbnailFailed = thumbnail == nil
    }
}

private struct VideoThumbnailPreview: View {
    let image: NSImage?
    let failed: Bool

    var body: some View {
        RoundedRectangle(cornerRadius: 7)
            .fill(.black.opacity(0.18))
            .overlay {
                if let image {
                    Image(nsImage: image)
                        .resizable()
                        .scaledToFill()
                } else {
                    Image(systemName: failed ? "film" : "photo.on.rectangle")
                        .font(.title3.weight(.semibold))
                        .foregroundStyle(.green)
                }
            }
            .overlay {
                LinearGradient(
                    colors: [.black.opacity(0.20), .clear],
                    startPoint: .top,
                    endPoint: .center
                )
            }
            .clipShape(RoundedRectangle(cornerRadius: 7))
            .clipped()
    }
}

private actor VideoThumbnailCache {
    static let shared = VideoThumbnailCache()

    private var cached: [String: Data] = [:]
    private var order: [String] = []
    private var failed: Set<String> = []
    private let maxCached = 240

    func thumbnailData(for url: URL) async -> Data? {
        let key = url.absoluteString
        if let data = cached[key] {
            return data
        }
        if failed.contains(key) {
            return nil
        }
        do {
            let data = try await Task.detached(priority: .utility) {
                try makeVideoThumbnailData(from: url)
            }.value
            cached[key] = data
            order.append(key)
            trimIfNeeded()
            return data
        } catch {
            failed.insert(key)
            return nil
        }
    }

    private func trimIfNeeded() {
        guard order.count > maxCached else { return }
        let overflow = order.count - maxCached
        let expired = order.prefix(overflow)
        for key in expired {
            cached.removeValue(forKey: key)
        }
        order.removeFirst(overflow)
    }
}

private func makeVideoThumbnailData(from url: URL) throws -> Data {
    let asset = AVURLAsset(url: url)
    let generator = AVAssetImageGenerator(asset: asset)
    generator.appliesPreferredTrackTransform = true
    generator.maximumSize = CGSize(width: 360, height: 240)
    generator.requestedTimeToleranceBefore = .zero
    generator.requestedTimeToleranceAfter = CMTime(seconds: 1, preferredTimescale: 600)
    let image = try generator.copyCGImage(at: CMTime(seconds: 0.2, preferredTimescale: 600), actualTime: nil)
    let rep = NSBitmapImageRep(cgImage: image)
    guard let data = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.68]) else {
        throw CocoaError(.fileWriteUnknown)
    }
    return data
}

private struct ChatFileRow: View {
    let file: ZFile
    let url: URL

    var body: some View {
        HStack(spacing: 9) {
            Image(systemName: icon)
                .foregroundStyle(tint)
                .frame(width: 18)
            VStack(alignment: .leading, spacing: 2) {
                Text(file.title ?? file.filename)
                    .font(.caption.weight(.semibold))
                    .lineLimit(2)
                Text(detail)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 6)
            if isVideo {
                Button {
                    VideoFullscreenPresenter.present(url: url)
                } label: {
                    Image(systemName: "play.rectangle")
                }
                .buttonStyle(.borderless)
                .help("Open player")
            }
            Link(destination: url) {
                Image(systemName: "arrow.up.right.square")
            }
            .help("Open file")
        }
        .padding(8)
        .background(Theme.card)
        .clipShape(RoundedRectangle(cornerRadius: 7))
        .overlay(RoundedRectangle(cornerRadius: 7).stroke(Theme.softLine))
        .onDrag {
            ArtifactDragItemProvider.provider(for: file, url: url)
        }
        .help("Drag to Finder or another app")
    }

    private var isVideo: Bool {
        (file.content_type ?? "").hasPrefix("video/")
    }

    private var icon: String {
        if isVideo { return "film" }
        if (file.content_type ?? "").hasPrefix("image/") { return "photo" }
        return "doc"
    }

    private var tint: Color {
        if isVideo { return .green }
        if (file.content_type ?? "").hasPrefix("image/") { return .blue }
        return .secondary
    }

    private var detail: String {
        var parts = [file.kind?.capitalized ?? "File"]
        if let size = file.size {
            parts.append(byteString(size))
        }
        return parts.joined(separator: " · ")
    }
}

enum ArtifactDragItemProvider {
    static func provider(for file: ZFile, url: URL) -> NSItemProvider {
        let provider = NSItemProvider()
        let type = dragType(for: file)
        provider.suggestedName = file.filename
        provider.registerFileRepresentation(
            forTypeIdentifier: type.identifier,
            fileOptions: [],
            visibility: .all
        ) { completion in
            let progress = Progress(totalUnitCount: 100)
            Task.detached(priority: .userInitiated) {
                do {
                    let localURL = try await ArtifactDragFileCache.shared.localFile(for: file, remoteURL: url)
                    progress.completedUnitCount = 100
                    completion(localURL, true, nil)
                } catch {
                    completion(nil, false, error)
                }
            }
            return progress
        }
        provider.registerObject(url as NSURL, visibility: .all)
        provider.registerObject(url.absoluteString as NSString, visibility: .all)
        return provider
    }

    private static func dragType(for file: ZFile) -> UTType {
        if let ext = file.filename.split(separator: ".").last,
           ext != file.filename,
           let type = UTType(filenameExtension: String(ext)) {
            return type
        }
        if let contentType = file.content_type,
           let type = UTType(contentType) {
            return type
        }
        return .data
    }
}

private actor ArtifactDragFileCache {
    static let shared = ArtifactDragFileCache()

    private var cached: [String: URL] = [:]

    func localFile(for file: ZFile, remoteURL: URL) async throws -> URL {
        if remoteURL.isFileURL {
            return remoteURL
        }

        if let existing = cached[file.id], FileManager.default.fileExists(atPath: existing.path) {
            return existing
        }

        let destination = try cacheURL(for: file)
        if FileManager.default.fileExists(atPath: destination.path) {
            cached[file.id] = destination
            return destination
        }

        let (tempURL, response) = try await URLSession.shared.download(from: remoteURL)
        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            throw CocoaError(.fileReadUnknown)
        }

        let folder = destination.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        if FileManager.default.fileExists(atPath: destination.path) {
            try FileManager.default.removeItem(at: destination)
        }
        try FileManager.default.moveItem(at: tempURL, to: destination)
        cached[file.id] = destination
        return destination
    }

    private func cacheURL(for file: ZFile) throws -> URL {
        guard let root = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first else {
            throw CocoaError(.fileNoSuchFile)
        }
        let safeID = sanitizedPathComponent(file.id.isEmpty ? UUID().uuidString : file.id)
        let safeName = sanitizedFilename(file.filename)
        return root
            .appendingPathComponent("ZenithDock", isDirectory: true)
            .appendingPathComponent("DragArtifacts", isDirectory: true)
            .appendingPathComponent(safeID, isDirectory: true)
            .appendingPathComponent(safeName, isDirectory: false)
    }

    private func sanitizedFilename(_ name: String) -> String {
        let cleaned = sanitizedPathComponent(name)
        return cleaned.isEmpty ? "artifact" : cleaned
    }

    private func sanitizedPathComponent(_ value: String) -> String {
        let illegal = CharacterSet(charactersIn: "/:\\")
            .union(.newlines)
            .union(.controlCharacters)
        return value
            .components(separatedBy: illegal)
            .joined(separator: "-")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
