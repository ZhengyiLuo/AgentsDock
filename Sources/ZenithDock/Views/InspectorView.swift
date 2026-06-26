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
    @State private var runtimeDraftSessionID: String?
    @State private var jobTitle = ""
    @State private var jobPrompt = ""
    @State private var intervalText = "3600"
    @State private var jobStartOption: JobStartOption = .afterInterval
    @State private var jobStartDate = Date().addingTimeInterval(3_600)
    @State private var loopJob = true
    @State private var fixedJobRunsText = "1"
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
                        Picker("Backend", selection: backendRuntimeBinding) {
                            Text("Claude").tag("claude")
                            Text("Codex").tag("codex")
                        }
                        .pickerStyle(.segmented)
                        .disabled(session.isBackendLocked)
                        .help(session.isBackendLocked ? "Backend is locked after chat starts. Fork or create a new chat to use another backend." : "Backend")
                        Picker("Model", selection: modelRuntimeBinding) {
                            ForEach(modelOptions(for: backend)) { option in
                                Text(option.label).tag(option.value)
                            }
                        }
                        .pickerStyle(.menu)
                        TextField("Custom model ID", text: $model)
                            .textFieldStyle(.roundedBorder)
                            .font(.caption)
                            .autocorrectionDisabled()
                            .onSubmit { scheduleRuntimeSave(debounceNanoseconds: 0) }
                        Picker("Effort", selection: effortRuntimeBinding) {
                            ForEach(effortOptions) { option in
                                Text(option.label).tag(option.value)
                            }
                        }
                        .pickerStyle(.menu)
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

                PinnedItemsInspector()

                GroupBox("Run") {
                    VStack(alignment: .leading, spacing: 10) {
                        LabeledContent("Events", value: "\(store.events.count)")
                        LabeledContent("Files", value: "\(store.sessionFiles.count)")
                        LabeledContent("Videos", value: "\(store.sessionVideos.count)")
                        LabeledContent("Images", value: "\(store.sessionFiles.filter { ($0.content_type ?? "").hasPrefix("image/") }.count)")
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
                        .help("Delete this chat from AgentsDock")
                    }
                }

                LiveProcessesInspector()

                TmuxSubmitterInspector()

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
            clearRuntimeSaveIndicator()
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
            Text(store.selectedSession?.title ?? "This chat will be removed from AgentsDock.")
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
                    composerPrompt: store.draftPrompt(for: store.selectedSessionID),
                    title: $jobTitle,
                    prompt: $jobPrompt,
                    intervalText: $intervalText,
                    startOption: $jobStartOption,
                    startDate: $jobStartDate,
                    loop: $loopJob,
                    maxRunsText: $fixedJobRunsText,
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
        let session = store.selectedSession
        title = session?.title ?? ""
        folder = session?.folder ?? "General"
        cwd = session?.cwd ?? store.defaultCwd
        guard !shouldPreserveRuntimeDraft(for: session?.id) else { return }
        backend = session?.backend ?? "claude"
        model = session?.model ?? ""
        effort = session?.effort ?? ""
    }

    func syncServerDrafts() {
        serverURLDraft = store.serverURLString
        accessTokenDraft = store.accessToken
    }

    var backendRuntimeBinding: Binding<String> {
        Binding(
            get: { backend },
            set: { newValue in
                guard backend != newValue else { return }
                backend = newValue
                model = ""
                effort = ""
                scheduleRuntimeSave(debounceNanoseconds: 0)
            }
        )
    }

    var modelRuntimeBinding: Binding<String> {
        Binding(
            get: { model },
            set: { newValue in
                guard model != newValue else { return }
                model = newValue
                scheduleRuntimeSave(debounceNanoseconds: 0)
            }
        )
    }

    var effortRuntimeBinding: Binding<String> {
        Binding(
            get: { effort },
            set: { newValue in
                guard effort != newValue else { return }
                effort = newValue
                scheduleRuntimeSave(debounceNanoseconds: 0)
            }
        )
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
                runtimeDraftSessionID = nil
            }
            return
        }
        runtimeSaveTask?.cancel()
        isRuntimeSaving = true
        runtimeSaveFailed = false
        runtimeSaveMessage = "Saving runtime..."
        guard let selectedID = store.selectedSessionID else {
            clearRuntimeSaveIndicator()
            return
        }
        runtimeDraftSessionID = selectedID
        let backendValue = backend
        let modelValue = ZRuntimeCatalog.cleanForAPI(model)
        let effortValue = ZRuntimeCatalog.cleanForAPI(effort)
        store.stageSelectedRuntime(backend: backendValue, model: modelValue, effort: effortValue)
        runtimeSaveTask = Task {
            if debounceNanoseconds > 0 {
                try? await Task.sleep(nanoseconds: debounceNanoseconds)
            }
            guard !Task.isCancelled else { return }
            let saved = await store.updateSession(
                selectedID,
                backend: backendValue,
                model: modelValue,
                effort: effortValue,
                applyOptimistic: false
            )
            guard !Task.isCancelled else { return }
            await MainActor.run {
                guard store.selectedSessionID == selectedID else { return }
                isRuntimeSaving = false
                runtimeSaveFailed = !saved
                runtimeSaveMessage = saved ? "Runtime saved" : "Runtime save failed"
                if saved {
                    runtimeDraftSessionID = nil
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
        runtimeDraftSessionID = nil
    }

    func clearRuntimeSaveIndicator() {
        runtimeSaveTask = nil
        isRuntimeSaving = false
        runtimeSaveFailed = false
        runtimeSaveMessage = ""
        runtimeDraftSessionID = nil
    }

    func shouldPreserveRuntimeDraft(for sessionID: String?) -> Bool {
        isRuntimeSaving && runtimeDraftSessionID != nil && runtimeDraftSessionID == sessionID
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
        cleanJobPrompt.isEmpty ? store.draftPrompt(for: store.selectedSessionID).trimmingCharacters(in: .whitespacesAndNewlines) : cleanJobPrompt
    }

    var parsedJobInterval: Int? {
        guard let value = Int(intervalText.trimmingCharacters(in: .whitespacesAndNewlines)), value >= 10 else {
            return nil
        }
        return value
    }

    var jobFirstRunAt: Date? {
        jobScheduledDate(
            for: jobStartOption,
            customDate: jobStartDate,
            intervalSeconds: parsedJobInterval,
            afterIntervalUsesDate: false
        )
    }

    var canCreateJob: Bool {
        !effectiveJobPrompt.isEmpty && parsedJobInterval != nil
            && (loopJob || parsedJobMaxRuns != nil)
    }

    func createJob(for session: ZSession) {
        guard let interval = parsedJobInterval, !effectiveJobPrompt.isEmpty else { return }
        let cleanTitle = jobTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        Task {
            await store.createJob(
                title: cleanTitle.isEmpty ? "\(loopJob ? "Loop" : "Job"): \(session.title)" : cleanTitle,
                prompt: effectiveJobPrompt,
                intervalSeconds: interval,
                loop: loopJob,
                maxRuns: parsedJobMaxRuns,
                firstRunAt: jobFirstRunAt
            )
            jobTitle = ""
            jobPrompt = ""
            jobStartOption = .afterInterval
            jobStartDate = Date().addingTimeInterval(TimeInterval(interval))
            fixedJobRunsText = "1"
        }
    }

    func jobDraftSummary(for session: ZSession) -> String {
        let promptSource = cleanJobPrompt.isEmpty ? "composer prompt" : "custom prompt"
        let interval = parsedJobInterval.map(jobIntervalDescription) ?? "invalid interval"
        let start = jobStartSummary(
            for: jobStartOption,
            customDate: jobStartDate,
            intervalSeconds: parsedJobInterval,
            currentNextRun: nil,
            afterIntervalMeansKeep: false
        )
        return "\(jobRunModeDescription(loop: loopJob, maxRuns: parsedJobMaxRuns)) · \(interval) · \(start) · \(promptSource)"
    }

    var parsedJobMaxRuns: Int? {
        guard !loopJob else { return nil }
        return Int(fixedJobRunsText.trimmingCharacters(in: .whitespacesAndNewlines)).flatMap { $0 >= 1 ? $0 : nil }
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

private struct JobIntervalPreset: Identifiable {
    let seconds: Int
    let label: String

    var id: Int { seconds }
    var tag: String { "\(seconds)" }
}

private enum JobStartOption: String, CaseIterable, Identifiable {
    case keepCurrent
    case afterInterval
    case now
    case inFiveMinutes
    case inFifteenMinutes
    case inOneHour
    case custom

    var id: String { rawValue }

    var label: String {
        switch self {
        case .keepCurrent: "Keep current"
        case .afterInterval: "After interval"
        case .now: "Now"
        case .inFiveMinutes: "In 5 min"
        case .inFifteenMinutes: "In 15 min"
        case .inOneHour: "In 1 hour"
        case .custom: "Custom time"
        }
    }
}

private let customJobIntervalTag = "custom"

private let jobIntervalPresets: [JobIntervalPreset] = [
    JobIntervalPreset(seconds: 30, label: "30 sec"),
    JobIntervalPreset(seconds: 60, label: "1 min"),
    JobIntervalPreset(seconds: 120, label: "2 min"),
    JobIntervalPreset(seconds: 300, label: "5 min"),
    JobIntervalPreset(seconds: 600, label: "10 min"),
    JobIntervalPreset(seconds: 900, label: "15 min"),
    JobIntervalPreset(seconds: 1_800, label: "30 min"),
    JobIntervalPreset(seconds: 3_600, label: "1 hour"),
    JobIntervalPreset(seconds: 7_200, label: "2 hours"),
    JobIntervalPreset(seconds: 14_400, label: "4 hours"),
    JobIntervalPreset(seconds: 21_600, label: "6 hours"),
    JobIntervalPreset(seconds: 43_200, label: "12 hours"),
    JobIntervalPreset(seconds: 86_400, label: "24 hours")
]

private func jobStartOptions(includeKeepCurrent: Bool) -> [JobStartOption] {
    let options: [JobStartOption] = [.afterInterval, .now, .inFiveMinutes, .inFifteenMinutes, .inOneHour, .custom]
    return includeKeepCurrent ? [.keepCurrent] + options : options
}

private struct JobIntervalControl: View {
    @Binding var intervalText: String

    var body: some View {
        HStack(spacing: 8) {
            Picker("Interval preset", selection: presetSelection) {
                ForEach(jobIntervalPresets) { preset in
                    Text(preset.label).tag(preset.tag)
                }
                Text("Custom").tag(customJobIntervalTag)
            }
            .labelsHidden()
            .pickerStyle(.menu)
            .frame(width: 142)

            TextField("Seconds", text: $intervalText)
                .textFieldStyle(.roundedBorder)
                .font(.body.monospacedDigit())
                .frame(width: 100)

            Text("sec")
                .foregroundStyle(.secondary)

            if !intervalIsValid {
                Text("Minimum 10")
                    .font(.caption)
                    .foregroundStyle(.red)
            }
        }
    }

    private var presetSelection: Binding<String> {
        Binding {
            let clean = intervalText.trimmingCharacters(in: .whitespacesAndNewlines)
            guard let value = Int(clean),
                  let preset = jobIntervalPresets.first(where: { $0.seconds == value }) else {
                return customJobIntervalTag
            }
            return preset.tag
        } set: { tag in
            guard tag != customJobIntervalTag,
                  let preset = jobIntervalPresets.first(where: { $0.tag == tag }) else {
                return
            }
            intervalText = "\(preset.seconds)"
        }
    }

    private var intervalIsValid: Bool {
        Int(intervalText.trimmingCharacters(in: .whitespacesAndNewlines)).map { $0 >= 10 } ?? false
    }
}

private struct JobStartControl: View {
    @Binding var option: JobStartOption
    @Binding var customDate: Date
    let intervalSeconds: Int?
    let includeKeepCurrent: Bool
    let currentNextRun: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Picker("Start", selection: $option) {
                    ForEach(jobStartOptions(includeKeepCurrent: includeKeepCurrent)) { option in
                        Text(option.label).tag(option)
                    }
                }
                .labelsHidden()
                .pickerStyle(.menu)
                .frame(width: 150)

                if option == .custom {
                    DatePicker(
                        "Start time",
                        selection: $customDate,
                        displayedComponents: [.date, .hourAndMinute]
                    )
                    .labelsHidden()
                    .frame(width: 230)
                }
            }

            Text(summary)
                .font(.caption2)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
    }

    private var summary: String {
        jobStartSummary(
            for: option,
            customDate: customDate,
            intervalSeconds: intervalSeconds,
            currentNextRun: currentNextRun,
            afterIntervalMeansKeep: includeKeepCurrent
        )
    }
}

private func jobIntervalDescription(_ seconds: Int) -> String {
    if seconds < 60 {
        return "every \(seconds)s"
    }
    if seconds < 3_600 {
        let minutes = seconds / 60
        let remainder = seconds % 60
        return remainder == 0 ? "every \(minutes)m" : "every \(minutes)m \(remainder)s"
    }
    if seconds.isMultiple(of: 3_600) {
        return "every \(seconds / 3_600)h"
    }
    return "every \(seconds / 3_600)h \((seconds % 3_600) / 60)m"
}

private func jobRunModeDescription(loop: Bool, maxRuns: Int?) -> String {
    if loop { return "Loop forever" }
    let runs = max(1, maxRuns ?? 1)
    return runs == 1 ? "Run once" : "Run \(runs) times"
}

private func jobScheduledDate(
    for option: JobStartOption,
    customDate: Date,
    intervalSeconds: Int?,
    afterIntervalUsesDate: Bool
) -> Date? {
    switch option {
    case .keepCurrent:
        return nil
    case .afterInterval:
        guard afterIntervalUsesDate, let intervalSeconds else { return nil }
        return Date().addingTimeInterval(TimeInterval(intervalSeconds))
    case .now:
        return Date()
    case .inFiveMinutes:
        return Date().addingTimeInterval(300)
    case .inFifteenMinutes:
        return Date().addingTimeInterval(900)
    case .inOneHour:
        return Date().addingTimeInterval(3_600)
    case .custom:
        return customDate
    }
}

private func jobStartSummary(
    for option: JobStartOption,
    customDate: Date,
    intervalSeconds: Int?,
    currentNextRun: String?,
    afterIntervalMeansKeep: Bool
) -> String {
    switch option {
    case .keepCurrent:
        return currentNextRun.map { "keeps next run at \($0)" } ?? "keeps current next run"
    case .afterInterval:
        if afterIntervalMeansKeep, let currentNextRun {
            return "reschedules after interval when interval/mode changes; current next \(currentNextRun)"
        }
        return intervalSeconds.map { "first run \(jobIntervalDescription($0))" } ?? "first run after interval"
    case .now:
        return "first run immediately"
    case .inFiveMinutes:
        return "first run in 5 minutes"
    case .inFifteenMinutes:
        return "first run in 15 minutes"
    case .inOneHour:
        return "first run in 1 hour"
    case .custom:
        return "first run \(localJobDateString(customDate))"
    }
}

private func localJobDateString(_ date: Date) -> String {
    let formatter = DateFormatter()
    formatter.locale = .autoupdatingCurrent
    formatter.timeZone = .autoupdatingCurrent
    formatter.dateStyle = .medium
    formatter.timeStyle = .short
    return formatter.string(from: date)
}

private struct JobFormLabel: View {
    let title: String

    var body: some View {
        Text(title)
            .font(.caption.weight(.semibold))
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .fixedSize(horizontal: true, vertical: false)
            .frame(minWidth: 88, idealWidth: 88, maxWidth: 88, alignment: .leading)
    }
}

private struct JobFormRow<Content: View>: View {
    let title: String
    var alignment: VerticalAlignment = .center
    @ViewBuilder var content: () -> Content

    var body: some View {
        HStack(alignment: alignment, spacing: 12) {
            JobFormLabel(title: title)
            content()
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

private struct NewJobDetailsSheet: View {
    let sessionTitle: String
    let composerPrompt: String
    @Binding var title: String
    @Binding var prompt: String
    @Binding var intervalText: String
    @Binding var startOption: JobStartOption
    @Binding var startDate: Date
    @Binding var loop: Bool
    @Binding var maxRunsText: String
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

            VStack(alignment: .leading, spacing: 10) {
                JobFormRow(title: "Title") {
                    TextField("Job title", text: $title)
                        .textFieldStyle(.roundedBorder)
                }
                JobFormRow(title: "Interval") {
                    JobIntervalControl(intervalText: $intervalText)
                }
                JobFormRow(title: "Start") {
                    JobStartControl(
                        option: $startOption,
                        customDate: $startDate,
                        intervalSeconds: parsedInterval,
                        includeKeepCurrent: false,
                        currentNextRun: nil
                    )
                }
                JobFormRow(title: "Mode") {
                    HStack(spacing: 10) {
                        Picker("Mode", selection: $loop) {
                            Text("Run fixed times").tag(false)
                            Text("Loop forever").tag(true)
                        }
                        .labelsHidden()
                        .pickerStyle(.segmented)
                        .frame(width: 250)
                        if !loop {
                            Stepper(value: fixedRunsBinding, in: 1...999) {
                                TextField("Runs", text: $maxRunsText)
                                    .frame(width: 52)
                                    .textFieldStyle(.roundedBorder)
                            }
                            Text("times")
                                .foregroundStyle(.secondary)
                        }
                    }
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
        parsedInterval != nil
    }

    private var maxRunsIsValid: Bool {
        loop || parsedMaxRuns != nil
    }

    private var parsedInterval: Int? {
        guard let value = Int(intervalText.trimmingCharacters(in: .whitespacesAndNewlines)), value >= 10 else {
            return nil
        }
        return value
    }

    private var parsedMaxRuns: Int? {
        guard !loop else { return nil }
        return Int(maxRunsText.trimmingCharacters(in: .whitespacesAndNewlines)).flatMap { $0 >= 1 ? $0 : nil }
    }

    private var fixedRunsBinding: Binding<Int> {
        Binding(
            get: { parsedMaxRuns ?? 1 },
            set: { maxRunsText = "\($0)" }
        )
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
        var parts = [jobRunModeDescription(loop: job.loop == true, maxRuns: job.max_runs)]
        if let interval = job.interval_seconds {
            parts.append(jobIntervalDescription(interval))
        }
        if job.enabled, let next = localTimestampString(job.next_run_at_iso) {
            parts.append("next \(next)")
        } else if !job.enabled {
            parts.append("paused")
        }
        return parts.joined(separator: " · ")
    }
}

private struct JobEditorSheet: View {
    @EnvironmentObject private var store: AppStore
    let job: ZJob
    @Binding var isPresented: Bool
    @State private var title = ""
    @State private var prompt = ""
    @State private var intervalText = "3600"
    @State private var startOption: JobStartOption = .keepCurrent
    @State private var startDate = Date().addingTimeInterval(3_600)
    @State private var loop = true
    @State private var maxRunsText = "1"
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

            VStack(alignment: .leading, spacing: 10) {
                JobFormRow(title: "Title") {
                    TextField("Job title", text: $title)
                        .textFieldStyle(.roundedBorder)
                }
                JobFormRow(title: "Backend") {
                    Picker("Backend", selection: $backend) {
                        Text("Claude").tag("claude")
                        Text("Codex").tag("codex")
                    }
                    .labelsHidden()
                    .pickerStyle(.segmented)
                    .frame(width: 180)
                }
                JobFormRow(title: "Interval") {
                    JobIntervalControl(intervalText: $intervalText)
                }
                JobFormRow(title: "Next Run") {
                    JobStartControl(
                        option: $startOption,
                        customDate: $startDate,
                        intervalSeconds: parsedInterval,
                        includeKeepCurrent: true,
                        currentNextRun: localTimestampString(job.next_run_at_iso)
                    )
                }
                JobFormRow(title: "Options") {
                    HStack(spacing: 16) {
                        Picker("Mode", selection: $loop) {
                            Text("Run fixed times").tag(false)
                            Text("Loop forever").tag(true)
                        }
                        .labelsHidden()
                        .pickerStyle(.segmented)
                        .frame(width: 250)
                        if !loop {
                            Stepper(value: fixedRunsBinding, in: 1...999) {
                                TextField("Runs", text: $maxRunsText)
                                    .frame(width: 52)
                                    .textFieldStyle(.roundedBorder)
                            }
                            Text("times")
                                .foregroundStyle(.secondary)
                        }
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
        !cleanTitle.isEmpty && !cleanPrompt.isEmpty && intervalIsValid && maxRunsIsValid
    }

    private func syncDrafts() {
        title = job.title
        prompt = job.prompt
        intervalText = "\(job.interval_seconds ?? 3600)"
        startOption = .keepCurrent
        startDate = parseServerDate(job.next_run_at_iso) ?? Date().addingTimeInterval(TimeInterval(job.interval_seconds ?? 3_600))
        loop = job.loop == true
        maxRunsText = "\(max(1, job.max_runs ?? 1))"
        enabled = job.enabled
        backend = job.backend ?? store.selectedSession?.backend ?? "claude"
    }

    private func save() {
        guard let parsedInterval, canSave else { return }
        let nextRunAt = jobScheduledDate(
            for: startOption,
            customDate: startDate,
            intervalSeconds: parsedInterval,
            afterIntervalUsesDate: true
        )
        let intervalPatch = parsedInterval == job.interval_seconds ? nil : parsedInterval
        let loopPatch = loop == (job.loop == true) ? nil : loop
        let currentMaxRuns = job.loop == true ? nil : max(1, job.max_runs ?? 1)
        let maxRunsPatch = parsedMaxRuns == currentMaxRuns ? nil : parsedMaxRuns
        let enabledPatch = enabled == job.enabled ? nil : enabled
        let backendPatch = backend == (job.backend ?? store.selectedSession?.backend ?? "claude") ? nil : backend
        isSaving = true
        Task {
            await store.updateJob(
                job,
                title: cleanTitle,
                prompt: cleanPrompt,
                intervalSeconds: intervalPatch,
                loop: loopPatch,
                maxRuns: maxRunsPatch,
                enabled: enabledPatch,
                backend: backendPatch,
                nextRunAt: nextRunAt
            )
            await MainActor.run {
                isSaving = false
                isPresented = false
            }
        }
    }

    private var maxRunsIsValid: Bool {
        loop || parsedMaxRuns != nil
    }

    private var parsedMaxRuns: Int? {
        guard !loop else { return nil }
        return Int(maxRunsText.trimmingCharacters(in: .whitespacesAndNewlines)).flatMap { $0 >= 1 ? $0 : nil }
    }

    private var fixedRunsBinding: Binding<Int> {
        Binding(
            get: { parsedMaxRuns ?? 1 },
            set: { maxRunsText = "\($0)" }
        )
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

private struct TmuxSubmitterInspector: View {
    @EnvironmentObject private var store: AppStore
    @State private var isOpen = false
    @State private var includeAll = false

    var body: some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Label("Tmux Submitters", systemImage: "rectangle.connected.to.line.below")
                        .font(.headline)
                    Spacer()
                    if store.isLoadingTmux {
                        ProgressView()
                            .controlSize(.small)
                    }
                    if isOpen {
                        Toggle("All", isOn: $includeAll)
                            .font(.caption)
                            .toggleStyle(.checkbox)
                            .help("Show every tmux pane on the server, not just panes linked to this chat")
                        Button {
                            refresh()
                        } label: {
                            Image(systemName: "arrow.clockwise")
                        }
                        .buttonStyle(.borderless)
                        .help("Refresh tmux panes")
                        Button {
                            isOpen = false
                            store.tmuxSnapshot = nil
                            store.tmuxCapture = nil
                        } label: {
                            Image(systemName: "chevron.up")
                        }
                        .buttonStyle(.borderless)
                        .help("Hide tmux submitters")
                    }
                }

                if isOpen {
                    if let snapshot = store.tmuxSnapshot {
                        HStack(spacing: 8) {
                            Text("\(snapshot.panes.count) shown")
                            if let total = snapshot.total_panes {
                                Text("of \(total)")
                            }
                            if snapshot.filtered == true {
                                Text("filtered")
                            }
                        }
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(.secondary)

                        if snapshot.panes.isEmpty {
                            Text(includeAll ? "No tmux panes are running." : "No tmux panes are linked to this chat yet. Use All for the machine-wide list.")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        } else {
                            VStack(alignment: .leading, spacing: 6) {
                                ForEach(snapshot.panes) { pane in
                                    TmuxPaneRow(pane: pane)
                                        .environmentObject(store)
                                }
                            }
                        }

                        if let capture = store.tmuxCapture {
                            TmuxCaptureView(capture: capture)
                                .environmentObject(store)
                        }
                    } else {
                        Text("Tmux inspection is available on request.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                } else {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("List tmux panes linked to this chat. Use All after opening for the machine-wide list.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Button {
                            isOpen = true
                            refresh()
                        } label: {
                            Label("Inspect Tmux Submitters", systemImage: "rectangle.connected.to.line.below")
                        }
                        .controlSize(.small)
                        .disabled(store.selectedSessionID == nil || store.isLoadingTmux)
                    }
                }
            }
            .padding(.vertical, 4)
        }
        .onChange(of: includeAll) {
            guard isOpen else { return }
            refresh()
        }
        .onChange(of: store.selectedSessionID) {
            isOpen = false
            includeAll = false
            store.tmuxSnapshot = nil
            store.tmuxCapture = nil
        }
    }

    private func refresh() {
        Task { await store.refreshSelectedTmuxPanes(includeAll: includeAll) }
    }
}

private struct TmuxPaneRow: View {
    @EnvironmentObject private var store: AppStore
    let pane: ZTmuxPane

    private var isSelected: Bool {
        store.tmuxCapture?.pane_id == pane.pane_id
    }

    private var targetLabel: String {
        let window = pane.window_index.map { "\($0)" } ?? "?"
        let paneIndex = pane.pane_index.map { "\($0)" } ?? "?"
        return "\(pane.session_name):\(window).\(paneIndex)"
    }

    var body: some View {
        Button {
            Task { await store.captureTmuxPane(pane) }
        } label: {
            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 6) {
                    Circle()
                        .fill(pane.active == true ? Color.green : Color.secondary.opacity(0.5))
                        .frame(width: 7, height: 7)
                    Text(targetLabel)
                        .font(.caption.weight(.semibold).monospaced())
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer()
                    if let pid = pane.pane_pid {
                        Text("pid \(pid)")
                            .font(.caption2.monospacedDigit())
                            .foregroundStyle(.secondary)
                    }
                    Image(systemName: isSelected ? "checkmark.circle.fill" : "text.page")
                        .foregroundStyle(isSelected ? Color.accentColor : Color.secondary)
                }
                Text(pane.display ?? pane.command ?? "tmux pane")
                    .font(.caption)
                    .foregroundStyle(.primary)
                    .lineLimit(2)
                    .truncationMode(.middle)
                if let cwd = pane.cwd, !cwd.isEmpty {
                    Text(cwd)
                        .font(.caption2.monospaced())
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                if let matches = pane.matches, !matches.isEmpty {
                    HStack(spacing: 4) {
                        ForEach(matches, id: \.self) { match in
                            Text(match)
                                .font(.caption2.weight(.semibold))
                                .padding(.horizontal, 5)
                                .padding(.vertical, 2)
                                .background(Color.accentColor.opacity(0.14))
                                .clipShape(Capsule())
                        }
                    }
                }
            }
            .padding(8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(isSelected ? Color.accentColor.opacity(0.16) : Color.black.opacity(0.08))
            .clipShape(RoundedRectangle(cornerRadius: 7))
            .overlay(RoundedRectangle(cornerRadius: 7).stroke(isSelected ? Color.accentColor.opacity(0.45) : Theme.softLine))
        }
        .buttonStyle(.plain)
        .help("Capture this tmux pane")
    }
}

private struct TmuxCaptureView: View {
    @EnvironmentObject private var store: AppStore
    let capture: ZTmuxCapture
    @State private var copied = false

    private var bodyText: String {
        capture.text.isEmpty ? "(pane has no captured output)" : capture.text
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Label("Pane Output", systemImage: "terminal")
                    .font(.caption.weight(.semibold))
                Spacer()
                Text("\(capture.lines ?? 0) lines")
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(.secondary)
                Button {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(capture.text, forType: .string)
                    copied = true
                    Task {
                        try? await Task.sleep(nanoseconds: 900_000_000)
                        await MainActor.run { copied = false }
                    }
                } label: {
                    Image(systemName: copied ? "checkmark" : "doc.on.doc")
                }
                .buttonStyle(.borderless)
                .help("Copy tmux pane output")
                .disabled(capture.text.isEmpty)
                Button {
                    store.tmuxCapture = nil
                } label: {
                    Image(systemName: "xmark.circle")
                }
                .buttonStyle(.borderless)
                .help("Close pane output")
            }
            Text(capture.pane_id)
                .font(.caption2.monospaced())
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
            ScrollView {
                Text(bodyText)
                    .font(.caption2.monospaced())
                    .foregroundStyle(capture.text.isEmpty ? .secondary : .primary)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(8)
            }
            .frame(minHeight: 120, maxHeight: 260)
            .background(Color.black.opacity(0.18))
            .clipShape(RoundedRectangle(cornerRadius: 7))
            .overlay(RoundedRectangle(cornerRadius: 7).stroke(Theme.softLine))
        }
        .padding(.top, 4)
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

private struct PinnedItemsInspector: View {
    @EnvironmentObject private var store: AppStore

    var body: some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 9) {
                HStack(spacing: 8) {
                    Label("Pinned", systemImage: "pin.fill")
                        .font(.headline)
                    Text("\(store.selectedPinnedItems.count)")
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(.secondary)
                    Spacer()
                }

                if store.selectedPinnedItems.isEmpty {
                    Text("Pin messages or files from the timeline to keep them here.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                } else {
                    VStack(spacing: 8) {
                        ForEach(store.selectedPinnedItems) { item in
                            PinnedItemRow(item: item)
                        }
                    }
                }
            }
            .padding(.vertical, 4)
        }
    }
}

private struct PinnedItemRow: View {
    @EnvironmentObject private var store: AppStore
    let item: PinnedTimelineItem

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: icon)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(tint)
                    .frame(width: 18)
                    .padding(.top, 2)
                VStack(alignment: .leading, spacing: 2) {
                    Text(item.title)
                        .font(.caption.weight(.semibold))
                        .lineLimit(2)
                        .truncationMode(.middle)
                    if let subtitle = item.subtitle, !subtitle.isEmpty {
                        Text(subtitle)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 6)
                Button {
                    store.removePinnedItem(item)
                } label: {
                    Image(systemName: "pin.slash")
                }
                .buttonStyle(.borderless)
                .help("Unpin")
            }

            if let body = item.body?.trimmingCharacters(in: .whitespacesAndNewlines), !body.isEmpty {
                Text(body)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(3)
                    .textSelection(.enabled)
            }

            HStack(spacing: 8) {
                Button {
                    store.revealPinnedItem(item)
                } label: {
                    Label("Find", systemImage: "text.magnifyingglass")
                }
                .controlSize(.mini)
                .help("Find in chat")

                if let file = item.file {
                    Link(destination: store.fileURL(file)) {
                        Label("Open", systemImage: "arrow.up.right.square")
                    }
                    .controlSize(.mini)

                    MacArtifactDownloadButton(file: file, url: store.fileURL(file), title: "Download")
                        .controlSize(.mini)
                }

                if let body = item.body, !body.isEmpty {
                    Button {
                        copyToPasteboard(ZClipboardText.normalizedForCopy(body))
                    } label: {
                        Label("Copy", systemImage: "doc.on.doc")
                    }
                    .controlSize(.mini)
                    .help("Copy pinned text")
                }
            }
            .font(.caption2.weight(.semibold))
        }
        .padding(9)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.card)
        .clipShape(RoundedRectangle(cornerRadius: 7))
        .overlay(RoundedRectangle(cornerRadius: 7).stroke(Theme.softLine))
    }

    private var icon: String {
        switch item.kind {
        case .message:
            return "text.bubble"
        case .file:
            if item.file?.content_type?.hasPrefix("video/") == true { return "film" }
            if item.file?.content_type?.hasPrefix("image/") == true { return "photo" }
            return "doc"
        }
    }

    private var tint: Color {
        switch item.kind {
        case .message:
            return .accentColor
        case .file:
            if item.file?.content_type?.hasPrefix("video/") == true { return .green }
            if item.file?.content_type?.hasPrefix("image/") == true { return .blue }
            return .secondary
        }
    }

    private func copyToPasteboard(_ string: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(string, forType: .string)
    }
}

private struct ChatFilesInspector: View {
    @EnvironmentObject private var store: AppStore
    let files: [ZFile]
    @AppStorage("zenithdock.filesInspector.expanded") private var isExpanded = false
    @State private var visibleMediaCount = 4
    @State private var visibleDocumentCount = 10

    private let mediaPageSize = 4
    private let documentPageSize = 12

    private var images: [ZFile] {
        files.filter { ($0.content_type ?? "").hasPrefix("image/") }
    }

    // Videos and images grouped together into one visual gallery (videos first,
    // then images), de-duplicated by id.
    private var media: [ZFile] {
        var seen = Set<String>()
        var result: [ZFile] = []
        for file in store.sessionVideos + images where seen.insert(file.id).inserted {
            result.append(file)
        }
        return result
    }

    // Non-visual files only — images and videos now live in the Media gallery.
    private var documents: [ZFile] {
        files.filter {
            let ct = $0.content_type ?? ""
            return !ct.hasPrefix("video/") && !ct.hasPrefix("image/")
        }
    }

    private var visibleMedia: [ZFile] {
        Array(media.prefix(visibleMediaCount))
    }

    private var mediaRows: [[ZFile]] {
        let current = visibleMedia
        return stride(from: 0, to: current.count, by: 2).map { index in
            Array(current[index..<min(index + 2, current.count)])
        }
    }

    private var fileChangeToken: String {
        "\(files.count):\(media.count):\(files.first?.id ?? ""):\(files.last?.id ?? ""):\(media.first?.id ?? "")"
    }

    var body: some View {
        GroupBox {
            DisclosureGroup(isExpanded: $isExpanded) {
                VStack(alignment: .leading, spacing: 10) {
                    if files.isEmpty && media.isEmpty {
                        Text("No files in this chat yet")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    } else {
                        if !media.isEmpty {
                            mediaSection
                        }
                        if !documents.isEmpty {
                            fileSection(media.isEmpty ? "Files" : "Other Files", files: documents)
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
                    Label("Media & Files", systemImage: "paperclip")
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
            visibleMediaCount = min(max(visibleMediaCount, 4), max(media.count, 4))
            visibleDocumentCount = min(max(visibleDocumentCount, 10), max(documents.count, 10))
        }
    }

    private var mediaSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionHeader("Media", visible: min(visibleMediaCount, media.count), total: media.count)
            VStack(alignment: .leading, spacing: 8) {
                ForEach(Array(mediaRows.enumerated()), id: \.offset) { _, row in
                    HStack(alignment: .top, spacing: 8) {
                        ForEach(row) { file in
                            mediaCell(file)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        if row.count == 1 {
                            Color.clear
                                .frame(maxWidth: .infinity)
                        }
                    }
                }
            }
            if visibleMediaCount < media.count {
                showMoreButton(title: "Show More Media", count: media.count - visibleMediaCount) {
                    visibleMediaCount = min(media.count, visibleMediaCount + mediaPageSize)
                }
            }
        }
    }

    @ViewBuilder
    private func mediaCell(_ file: ZFile) -> some View {
        if (file.content_type ?? "").hasPrefix("image/") {
            ChatImageGridCell(file: file, url: store.fileURL(file))
        } else {
            ChatVideoGridCell(file: file, url: store.fileURL(file))
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
        visibleMediaCount = 4
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

                MacArtifactDownloadButton(file: file, url: url, title: "")
                    .controlSize(.mini)
                    .help("Download video")

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

                Button {
                    store.togglePin(file)
                } label: {
                    Image(systemName: store.isPinned(file) ? "pin.fill" : "pin")
                }
                .buttonStyle(.borderless)
                .help(store.isPinned(file) ? "Unpin from right panel" : "Pin to right panel")
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

private struct ChatImageGridCell: View {
    @EnvironmentObject private var store: AppStore
    let file: ZFile
    let url: URL
    @State private var previewOpen = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                previewOpen = true
            } label: {
                ChatImageThumbnail(url: url)
                    .frame(height: 64)
            }
            .buttonStyle(.plain)
            .help("View image")
            .accessibilityLabel("View image")
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
                    previewOpen = true
                } label: {
                    Label("View", systemImage: "eye")
                }
                .controlSize(.mini)
                .help("View image")

                MacArtifactDownloadButton(file: file, url: url, title: "")
                    .controlSize(.mini)
                    .help("Download image")

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

                Button {
                    store.togglePin(file)
                } label: {
                    Image(systemName: store.isPinned(file) ? "pin.fill" : "pin")
                }
                .buttonStyle(.borderless)
                .help(store.isPinned(file) ? "Unpin from right panel" : "Pin to right panel")
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
        .sheet(isPresented: $previewOpen) {
            InspectorImagePreviewSheet(file: file, url: url)
        }
    }

    private var detail: String {
        file.size.map(byteString) ?? "Image"
    }
}

private struct ChatImageThumbnail: View {
    let url: URL

    var body: some View {
        RoundedRectangle(cornerRadius: 7)
            .fill(.black.opacity(0.18))
            .overlay {
                AsyncImage(url: url) { phase in
                    switch phase {
                    case .success(let image):
                        image
                            .resizable()
                            .scaledToFill()
                    case .failure:
                        Image(systemName: "photo")
                            .font(.title3.weight(.semibold))
                            .foregroundStyle(.green)
                    default:
                        ProgressView()
                            .controlSize(.small)
                    }
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: 7))
            .clipped()
    }
}

private struct InspectorImagePreviewSheet: View {
    let file: ZFile
    let url: URL
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                Image(systemName: "photo")
                    .foregroundStyle(.green)
                Text(file.title ?? file.filename)
                    .font(.headline)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: 16)
                Link(destination: url) {
                    Label("Open", systemImage: "arrow.up.right.square")
                }
                MacArtifactDownloadButton(file: file, url: url, title: "Download")
                Button("Done") {
                    dismiss()
                }
                .keyboardShortcut(.defaultAction)
            }
            .padding(14)
            Divider()
            ZStack {
                Color.black.opacity(0.88)
                AsyncImage(url: url) { image in
                    image
                        .resizable()
                        .scaledToFit()
                        .padding(12)
                } placeholder: {
                    ProgressView()
                        .controlSize(.large)
                }
            }
        }
        .frame(minWidth: 760, minHeight: 540)
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
    @EnvironmentObject private var store: AppStore
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
            MacArtifactDownloadButton(file: file, url: url, title: "")
                .help("Download file")
            Button {
                store.togglePin(file)
            } label: {
                Image(systemName: store.isPinned(file) ? "pin.fill" : "pin")
            }
            .buttonStyle(.borderless)
            .help(store.isPinned(file) ? "Unpin from right panel" : "Pin to right panel")
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

struct MacArtifactDownloadButton: View {
    let file: ZFile
    let url: URL
    var title = "Download"

    @State private var isPreparing = false
    @State private var errorText: String?

    var body: some View {
        Button {
            Task { await download() }
        } label: {
            if title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                Image(systemName: isPreparing ? "hourglass" : "arrow.down.circle")
            } else {
                Label(isPreparing ? "Preparing" : title, systemImage: "arrow.down.circle")
            }
        }
        .buttonStyle(.borderless)
        .disabled(isPreparing)
        .help("Download \(file.filename)")
        .alert("Download Failed", isPresented: errorBinding) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(errorText ?? "Could not download \(file.filename).")
        }
    }

    private var errorBinding: Binding<Bool> {
        Binding {
            errorText != nil
        } set: { newValue in
            if !newValue {
                errorText = nil
            }
        }
    }

    @MainActor
    private func download() async {
        guard let destination = chooseDestination() else { return }
        isPreparing = true
        defer { isPreparing = false }
        do {
            let localURL = try await ArtifactDragFileCache.shared.localFile(for: file, remoteURL: url)
            if localURL.standardizedFileURL != destination.standardizedFileURL {
                if FileManager.default.fileExists(atPath: destination.path) {
                    try FileManager.default.removeItem(at: destination)
                }
                try FileManager.default.copyItem(at: localURL, to: destination)
            }
            NSWorkspace.shared.activateFileViewerSelecting([destination])
        } catch {
            errorText = "Could not save \(file.filename)."
        }
    }

    @MainActor
    private func chooseDestination() -> URL? {
        let panel = NSSavePanel()
        panel.title = "Download \(file.filename)"
        panel.nameFieldStringValue = file.filename
        panel.canCreateDirectories = true
        panel.directoryURL = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
        return panel.runModal() == .OK ? panel.url : nil
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
