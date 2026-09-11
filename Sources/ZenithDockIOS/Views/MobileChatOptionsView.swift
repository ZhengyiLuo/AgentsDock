import AVFoundation
import SwiftUI
import UIKit
import ZenithCore

struct MobileChatOptionsView: View {
    @EnvironmentObject private var store: MobileAppStore
    @EnvironmentObject private var features: MobileFeatureStore
    @Binding var isPresented: Bool
    @Binding var resumeOpen: Bool

    @State private var title = ""
    @State private var folder = "General"
    @State private var cwd = ""
    @State private var backend = "claude"
    @State private var model = ""
    @State private var effort = ""
    @State private var runtimeSaveTask: Task<Void, Never>?
    @State private var runtimeSaveMessage = ""
    @State private var isRuntimeSaving = false
    @State private var runtimeSaveFailed = false
    @State private var runtimeDraftSessionID: String?
    @State private var pinned = false
    @State private var archived = false
    @State private var jobTitle = ""
    @State private var jobPrompt = ""
    @State private var intervalText = "3600"
    @State private var jobStartOption: MobileJobStartOption = .afterInterval
    @State private var jobStartDate = Date().addingTimeInterval(3_600)
    @State private var loopJob = true
    @State private var fixedJobRunsText = "1"
    @State private var newJobDetailsOpen = false
    @State private var confirmDelete = false
    @State private var handoffOpen = false

    var body: some View {
        NavigationStack {
            Form {
                if let session = store.selectedSession {
                    Section("Session") {
                        TextField("Chat name", text: $title)
                        Picker("Backend", selection: backendRuntimeBinding) {
                            Text("Claude").tag("claude")
                            Text("Codex").tag("codex")
                        }
                        .pickerStyle(.segmented)
                        .disabled(session.isBackendLocked)
                        Picker("Model", selection: modelRuntimeBinding) {
                            ForEach(modelOptions(for: backend)) { option in
                                Text(option.label).tag(option.value)
                            }
                        }
                        TextField("Custom model ID", text: $model)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .onSubmit { scheduleRuntimeSave(debounceNanoseconds: 0) }
                        Picker("Effort", selection: effortRuntimeBinding) {
                            ForEach(effortOptions) { option in
                                Text(option.label).tag(option.value)
                            }
                        }
                        runtimeSaveStatus
                        TextField("Folder", text: $folder)
                        TextField("Working directory", text: $cwd)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                        Toggle("Pinned", isOn: $pinned)
                        Toggle("Archived", isOn: $archived)
                        Button {
                            saveSession()
                        } label: {
                            Label("Save Session Details", systemImage: "checkmark.circle.fill")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.large)
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
                        Button {
                            handoffOpen = true
                        } label: {
                            Label("Create Digest", systemImage: "arrowshape.turn.up.right")
                        }
                        Button {
                            Task { await store.toggleArchive(session) }
                        } label: {
                            Label(session.archived == true ? "Unarchive Chat" : "Archive Chat", systemImage: "archivebox")
                        }
                        Button(role: .destructive) {
                            confirmDelete = true
                        } label: {
                            Label("Delete Chat", systemImage: "trash")
                        }
                    }

                    MobilePinnedItemsSection(session: session) {
                        isPresented = false
                    }

                    MobileLiveProcessesSection()

                    Section {
                        if store.sessionFiles.isEmpty {
                            Text("No files in this chat yet")
                                .foregroundStyle(.secondary)
                        } else {
                            if !videoFiles.isEmpty {
                                LazyVGrid(
                                    columns: [GridItem(.adaptive(minimum: 116), spacing: 10, alignment: .top)],
                                    alignment: .leading,
                                    spacing: 10
                                ) {
                                    ForEach(videoFiles) { file in
                                        MobileVideoGridCell(
                                            file: file,
                                            url: store.fileURL(file),
                                            find: file.event_seq.map { sequence in
                                                { findInChat(sessionID: session.id, sequence: sequence) }
                                            }
                                        )
                                    }
                                }
                                .padding(.vertical, 4)
                            }
                            if !otherFiles.isEmpty {
                                ForEach(otherFiles) { file in
                                    MobileChatFileRow(
                                        file: file,
                                        url: store.fileURL(file),
                                        find: file.event_seq.map { sequence in
                                            { findInChat(sessionID: session.id, sequence: sequence) }
                                        }
                                    )
                                }
                            }
                        }
                        Button {
                            Task { await store.refreshSelectedFiles() }
                        } label: {
                            Label("Refresh Files", systemImage: "arrow.clockwise")
                        }
                    } header: {
                        Text("Files & Videos")
                    } footer: {
                        Text("\(store.sessionFiles.count) files · \(store.sessionVideos.count) videos")
                    }

                    Section("Schedule Job") {
                        Button {
                            newJobDetailsOpen = true
                        } label: {
                            Label("Schedule Job...", systemImage: "clock.badge.plus")
                        }
                        Text("Create a recurring prompt for this chat.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
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
        .onChange(of: store.selectedSessionID) {
            clearRuntimeSaveIndicator()
            syncDrafts()
        }
        .onChange(of: store.selectedSession?.backend) { syncDrafts() }
        .onChange(of: store.selectedSession?.model) { syncDrafts() }
        .onChange(of: store.selectedSession?.effort) { syncDrafts() }
        .sheet(isPresented: $handoffOpen) {
            if let session = store.selectedSession {
                MobileHandoffDigestView(isPresented: $handoffOpen, sourceSession: session)
                    .environmentObject(store)
            }
        }
        .sheet(isPresented: $newJobDetailsOpen) {
            if let session = store.selectedSession {
                MobileNewJobDetailsView(
                    sessionTitle: session.title,
                    composerPrompt: store.prompt,
                    title: $jobTitle,
                    prompt: $jobPrompt,
                    intervalText: $intervalText,
                    startOption: $jobStartOption,
                    startDate: $jobStartDate,
                    loop: $loopJob,
                    maxRunsText: $fixedJobRunsText,
                    isPresented: $newJobDetailsOpen,
                    canSchedule: canCreateJob,
                    scheduleSummary: jobDraftSummary,
                    onSchedule: {
                        createJob(for: session)
                        newJobDetailsOpen = false
                    }
                )
            }
        }
        .alert("Delete Chat?", isPresented: $confirmDelete) {
            Button("Delete Chat", role: .destructive) {
                guard let session = store.selectedSession else { return }
                Task {
                    await store.deleteSession(session)
                    isPresented = false
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(deleteMessage)
        }
    }

    private var deleteMessage: String {
        guard let title = store.selectedSession?.title else {
            return "This chat will be removed from ZenithDock."
        }
        return "Delete \"\(title)\" from ZenithDock? This cannot be undone."
    }

    private var videoFiles: [ZFile] {
        sortedLatestFirst(store.sessionFiles.filter { ($0.content_type ?? "").hasPrefix("video/") })
    }

    private var otherFiles: [ZFile] {
        sortedLatestFirst(store.sessionFiles.filter { !($0.content_type ?? "").hasPrefix("video/") })
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

    private func findInChat(sessionID: String, sequence: Int) {
        isPresented = false
        Task { await store.navigate(sessionID: sessionID, sequence: sequence) }
    }

    private func syncDrafts() {
        guard let session = store.selectedSession else { return }
        title = session.title
        folder = session.folder ?? "General"
        cwd = session.cwd ?? store.defaultCwd
        pinned = session.pinned == true
        archived = session.archived == true
        guard !shouldPreserveRuntimeDraft(for: session.id) else { return }
        backend = session.backend
        model = session.model ?? ""
        effort = session.effort ?? ""
    }

    private var backendRuntimeBinding: Binding<String> {
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

    private var modelRuntimeBinding: Binding<String> {
        Binding(
            get: { model },
            set: { newValue in
                guard model != newValue else { return }
                model = newValue
                scheduleRuntimeSave(debounceNanoseconds: 0)
            }
        )
    }

    private var effortRuntimeBinding: Binding<String> {
        Binding(
            get: { effort },
            set: { newValue in
                guard effort != newValue else { return }
                effort = newValue
                scheduleRuntimeSave(debounceNanoseconds: 0)
            }
        )
    }

    @ViewBuilder
    private var runtimeSaveStatus: some View {
        if isRuntimeSaving || !runtimeSaveMessage.isEmpty {
            HStack(spacing: 8) {
                if isRuntimeSaving {
                    ProgressView()
                } else {
                    Image(systemName: runtimeSaveFailed ? "exclamationmark.triangle.fill" : "checkmark.circle.fill")
                        .foregroundStyle(runtimeSaveFailed ? .orange : .green)
                }
                Text(runtimeSaveMessage)
                    .foregroundStyle(runtimeSaveFailed ? .orange : .secondary)
            }
            .font(.caption)
        }
    }

    private func scheduleRuntimeSave(debounceNanoseconds: UInt64 = 180_000_000) {
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

    private func cancelRuntimeSave() {
        runtimeSaveTask?.cancel()
        runtimeSaveTask = nil
        isRuntimeSaving = false
        runtimeSaveFailed = false
        runtimeSaveMessage = ""
        runtimeDraftSessionID = nil
    }

    private func clearRuntimeSaveIndicator() {
        runtimeSaveTask = nil
        isRuntimeSaving = false
        runtimeSaveFailed = false
        runtimeSaveMessage = ""
        runtimeDraftSessionID = nil
    }

    private func shouldPreserveRuntimeDraft(for sessionID: String?) -> Bool {
        isRuntimeSaving && runtimeDraftSessionID != nil && runtimeDraftSessionID == sessionID
    }

    private var runtimeSelectionChanged: Bool {
        guard let session = store.selectedSession else { return false }
        return backend != session.backend ||
            (ZRuntimeCatalog.cleanForAPI(model) ?? "") != (session.model ?? "") ||
            (ZRuntimeCatalog.cleanForAPI(effort) ?? "") != (session.effort ?? "")
    }

    private func saveSession() {
        let cleanTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        let cleanFolder = folder.trimmingCharacters(in: .whitespacesAndNewlines)
        let cleanCwd = cwd.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanTitle.isEmpty else { return }
        Task {
            await store.updateSelected(
                backend: backend,
                model: ZRuntimeCatalog.cleanForAPI(model),
                effort: ZRuntimeCatalog.cleanForAPI(effort),
                folder: cleanFolder.isEmpty ? "General" : cleanFolder,
                title: cleanTitle,
                cwd: cleanCwd.isEmpty ? store.defaultCwd : cleanCwd,
                pinned: archived ? false : pinned,
                archived: archived
            )
            syncDrafts()
        }
    }

    private func modelOptions(for backend: String) -> [ZRuntimeOption] {
        optionsWithCurrent(store.runtimeCatalog.models(for: backend), current: model)
    }

    private var effortOptions: [ZRuntimeOption] {
        optionsWithCurrent(store.runtimeCatalog.efforts(for: backend), current: effort)
    }

    private func optionsWithCurrent(_ options: [ZRuntimeOption], current: String) -> [ZRuntimeOption] {
        let clean = current.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty, !options.contains(where: { $0.value == clean }) else {
            return options
        }
        return options + [ZRuntimeOption(value: clean, label: clean)]
    }

    private func openResume() {
        isPresented = false
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(250))
            resumeOpen = true
        }
    }

    private func createJob(for session: ZSession) {
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

    private var cleanJobPrompt: String {
        jobPrompt.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var effectiveJobPrompt: String {
        cleanJobPrompt.isEmpty ? store.prompt.trimmingCharacters(in: .whitespacesAndNewlines) : cleanJobPrompt
    }

    private var parsedJobInterval: Int? {
        guard let value = Int(intervalText.trimmingCharacters(in: .whitespacesAndNewlines)), value >= 10 else {
            return nil
        }
        return value
    }

    private var canCreateJob: Bool {
        !effectiveJobPrompt.isEmpty && parsedJobInterval != nil
            && (loopJob || parsedJobMaxRuns != nil)
    }

    private var jobFirstRunAt: Date? {
        mobileJobScheduledDate(
            for: jobStartOption,
            customDate: jobStartDate,
            intervalSeconds: parsedJobInterval,
            afterIntervalUsesDate: false
        )
    }

    private var jobDraftSummary: String {
        let promptSource = cleanJobPrompt.isEmpty ? "composer prompt" : "custom prompt"
        let interval = parsedJobInterval.map(mobileJobIntervalDescription) ?? "invalid interval"
        let start = mobileJobStartSummary(
            for: jobStartOption,
            customDate: jobStartDate,
            intervalSeconds: parsedJobInterval,
            currentNextRun: nil,
            afterIntervalMeansKeep: false
        )
        return "\(mobileJobRunModeDescription(loop: loopJob, maxRuns: parsedJobMaxRuns)) · \(interval) · \(start) · \(promptSource)"
    }

    private var parsedJobMaxRuns: Int? {
        guard !loopJob else { return nil }
        return Int(fixedJobRunsText.trimmingCharacters(in: .whitespacesAndNewlines)).flatMap { $0 >= 1 ? $0 : nil }
    }
}

private struct MobileJobIntervalPreset: Identifiable {
    let seconds: Int
    let label: String

    var id: Int { seconds }
    var tag: String { "\(seconds)" }
}

private enum MobileJobStartOption: String, CaseIterable, Identifiable {
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

private let mobileCustomJobIntervalTag = "custom"

private let mobileJobIntervalPresets: [MobileJobIntervalPreset] = [
    MobileJobIntervalPreset(seconds: 30, label: "30 sec"),
    MobileJobIntervalPreset(seconds: 60, label: "1 min"),
    MobileJobIntervalPreset(seconds: 120, label: "2 min"),
    MobileJobIntervalPreset(seconds: 300, label: "5 min"),
    MobileJobIntervalPreset(seconds: 600, label: "10 min"),
    MobileJobIntervalPreset(seconds: 900, label: "15 min"),
    MobileJobIntervalPreset(seconds: 1_800, label: "30 min"),
    MobileJobIntervalPreset(seconds: 3_600, label: "1 hour"),
    MobileJobIntervalPreset(seconds: 7_200, label: "2 hours"),
    MobileJobIntervalPreset(seconds: 14_400, label: "4 hours"),
    MobileJobIntervalPreset(seconds: 21_600, label: "6 hours"),
    MobileJobIntervalPreset(seconds: 43_200, label: "12 hours"),
    MobileJobIntervalPreset(seconds: 86_400, label: "24 hours")
]

private func mobileJobStartOptions(includeKeepCurrent: Bool) -> [MobileJobStartOption] {
    let options: [MobileJobStartOption] = [.afterInterval, .now, .inFiveMinutes, .inFifteenMinutes, .inOneHour, .custom]
    return includeKeepCurrent ? [.keepCurrent] + options : options
}

private struct MobileJobIntervalControl: View {
    @Binding var intervalText: String

    var body: some View {
        Picker("Interval", selection: presetSelection) {
            ForEach(mobileJobIntervalPresets) { preset in
                Text(preset.label).tag(preset.tag)
            }
            Text("Custom").tag(mobileCustomJobIntervalTag)
        }

        TextField("Custom seconds", text: $intervalText)
            .keyboardType(.numberPad)
            .font(.body.monospacedDigit())
    }

    private var presetSelection: Binding<String> {
        Binding {
            let clean = intervalText.trimmingCharacters(in: .whitespacesAndNewlines)
            guard let value = Int(clean),
                  let preset = mobileJobIntervalPresets.first(where: { $0.seconds == value }) else {
                return mobileCustomJobIntervalTag
            }
            return preset.tag
        } set: { tag in
            guard tag != mobileCustomJobIntervalTag,
                  let preset = mobileJobIntervalPresets.first(where: { $0.tag == tag }) else {
                return
            }
            intervalText = "\(preset.seconds)"
        }
    }
}

private struct MobileJobStartControl: View {
    @Binding var option: MobileJobStartOption
    @Binding var customDate: Date
    let intervalSeconds: Int?
    let includeKeepCurrent: Bool
    let currentNextRun: String?

    var body: some View {
        Picker("Start", selection: $option) {
            ForEach(mobileJobStartOptions(includeKeepCurrent: includeKeepCurrent)) { option in
                Text(option.label).tag(option)
            }
        }

        if option == .custom {
            DatePicker("Start time", selection: $customDate, displayedComponents: [.date, .hourAndMinute])
        }

        Text(summary)
            .font(.caption)
            .foregroundStyle(.secondary)
    }

    private var summary: String {
        mobileJobStartSummary(
            for: option,
            customDate: customDate,
            intervalSeconds: intervalSeconds,
            currentNextRun: currentNextRun,
            afterIntervalMeansKeep: includeKeepCurrent
        )
    }
}

private func mobileJobIntervalDescription(_ seconds: Int) -> String {
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

private func mobileJobRunModeDescription(loop: Bool, maxRuns: Int?) -> String {
    if loop { return "Loop forever" }
    let runs = max(1, maxRuns ?? 1)
    return runs == 1 ? "Run once" : "Run \(runs) times"
}

private func mobileJobScheduledDate(
    for option: MobileJobStartOption,
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

private func mobileJobStartSummary(
    for option: MobileJobStartOption,
    customDate: Date,
    intervalSeconds: Int?,
    currentNextRun: String?,
    afterIntervalMeansKeep: Bool
) -> String {
    switch option {
    case .keepCurrent:
        return currentNextRun.map { "Keeps next run at \($0)" } ?? "Keeps current next run"
    case .afterInterval:
        if afterIntervalMeansKeep, let currentNextRun {
            return "Reschedules after interval when interval/mode changes. Current next: \(currentNextRun)"
        }
        return intervalSeconds.map { "First run \(mobileJobIntervalDescription($0))" } ?? "First run after interval"
    case .now:
        return "First run immediately"
    case .inFiveMinutes:
        return "First run in 5 minutes"
    case .inFifteenMinutes:
        return "First run in 15 minutes"
    case .inOneHour:
        return "First run in 1 hour"
    case .custom:
        return "First run \(mobileLocalJobDateString(customDate))"
    }
}

private func mobileLocalJobDateString(_ date: Date) -> String {
    MobileDateFormatters.mediumDateTime.string(from: date)
}

private func mobileParseServerDate(_ value: String?) -> Date? {
    parseMobileServerDate(value)
}

private func mobileLocalTimestampString(_ value: String?) -> String? {
    guard let date = mobileParseServerDate(value) else { return value }

    let calendar = Calendar.autoupdatingCurrent

    if calendar.isDateInToday(date) {
        return "\(MobileDateFormatters.timeOnly.string(from: date)) today"
    }

    if calendar.isDateInTomorrow(date) {
        return "\(MobileDateFormatters.timeOnly.string(from: date)) tomorrow"
    }

    if calendar.component(.year, from: date) == calendar.component(.year, from: Date()) {
        return MobileDateFormatters.monthDayTime.string(from: date)
    }
    return MobileDateFormatters.mediumDateTime.string(from: date)
}

private struct MobileNewJobDetailsView: View {
    let sessionTitle: String
    let composerPrompt: String
    @Binding var title: String
    @Binding var prompt: String
    @Binding var intervalText: String
    @Binding var startOption: MobileJobStartOption
    @Binding var startDate: Date
    @Binding var loop: Bool
    @Binding var maxRunsText: String
    @Binding var isPresented: Bool
    let canSchedule: Bool
    let scheduleSummary: String
    let onSchedule: () -> Void

    var body: some View {
        NavigationStack {
            Form {
                Section("Job") {
                    Text(sessionTitle)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                    TextField("Job title", text: $title)
                    Picker("Mode", selection: $loop) {
                        Text("Fixed").tag(false)
                        Text("Loop").tag(true)
                    }
                    .pickerStyle(.segmented)
                    if !loop {
                        Stepper(value: fixedRunsBinding, in: 1...999) {
                            TextField("Run count", text: $maxRunsText)
                                .keyboardType(.numberPad)
                        }
                    }
                }

                Section("Schedule") {
                    MobileJobIntervalControl(intervalText: $intervalText)
                    MobileJobStartControl(
                        option: $startOption,
                        customDate: $startDate,
                        intervalSeconds: parsedInterval,
                        includeKeepCurrent: false,
                        currentNextRun: nil
                    )
                    if !intervalIsValid {
                        Text("Interval must be at least 10 seconds.")
                            .font(.caption)
                            .foregroundStyle(.red)
                    }
                }

                Section {
                    TextField("Prompt to run", text: $prompt, axis: .vertical)
                        .lineLimit(8...18)
                        .textInputAutocapitalization(.sentences)
                    if !composerPrompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        Button("Use Composer Prompt") {
                            prompt = composerPrompt
                        }
                    }
                } header: {
                    Text("Prompt")
                } footer: {
                    Text(prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "Empty prompt uses the current composer text when you create the job." : "\(prompt.count) characters")
                }
            }
            .navigationTitle("Schedule Job")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        isPresented = false
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Schedule") {
                        onSchedule()
                    }
                    .disabled(!canSchedule)
                }
            }
            .safeAreaInset(edge: .bottom) {
                VStack(alignment: .leading, spacing: 8) {
                    Text(scheduleSummary)
                        .font(.caption)
                        .foregroundStyle(canSchedule ? Color.secondary : Color.red)
                        .lineLimit(2)
                    Button {
                        onSchedule()
                    } label: {
                        Label("Schedule Job", systemImage: "clock.badge.plus")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(!canSchedule)
                }
                .padding()
                .background(.bar)
            }
        }
    }

    private var intervalIsValid: Bool {
        parsedInterval != nil
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

private struct MobileHandoffDigestView: View {
    @EnvironmentObject private var store: MobileAppStore
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

    private var targetSections: [DigestTargetSection] {
        store.digestTargetSections(excluding: sourceSession.id)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Source") {
                    Text(sourceSession.title)
                        .lineLimit(2)
                    Picker("Target", selection: $targetSessionID) {
                        Text("Choose chat").tag("")
                        ForEach(targetSections) { section in
                            Section(section.title) {
                                ForEach(section.sessions) { session in
                                    Text(session.title).tag(session.id)
                                }
                            }
                        }
                    }
                    Picker("Detail", selection: $detail) {
                        Text("Short").tag("short")
                        Text("Normal").tag("normal")
                        Text("Deep").tag("deep")
                    }
                    .pickerStyle(.segmented)
                }

                Section("Prompt") {
                    TextField("Prompt for target agent", text: $userPrompt, axis: .vertical)
                        .lineLimit(4...8)
                }

                Section("Preview") {
                    if preview.isEmpty {
                        ContentUnavailableView("No Preview", systemImage: "doc.text.magnifyingglass")
                    } else {
                        ScrollView {
                            Text(preview)
                                .font(.system(.caption, design: .monospaced))
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .frame(minHeight: 220)
                    }
                    if !status.isEmpty {
                        Text(status)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .navigationTitle("Create Digest")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { isPresented = false }
                }
                ToolbarItemGroup(placement: .confirmationAction) {
                    Button("Preview") {
                        Task { await previewDigest() }
                    }
                    .disabled(isWorking)
                    Button("Send") {
                        Task { await sendDigest() }
                    }
                    .disabled(isWorking || targetSessionID.isEmpty)
                }
            }
        }
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
            isPresented = false
        } else {
            status = "Send failed"
        }
    }
}

private struct MobileVideoGridCell: View {
    @EnvironmentObject private var store: MobileAppStore
    @EnvironmentObject private var features: MobileFeatureStore
    let file: ZFile
    let url: URL
    let find: (() -> Void)?
    @State private var fullscreenVideo = false
    @State private var thumbnail: UIImage?
    @State private var thumbnailFailed = false

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            Button {
                fullscreenVideo = true
            } label: {
                MobileVideoThumbnailPreview(image: thumbnail, failed: thumbnailFailed)
                    .frame(maxWidth: .infinity)
                    .aspectRatio(16.0 / 9.0, contentMode: .fit)
            }
            .buttonStyle(.plain)
            .task(id: url.absoluteString) {
                await loadThumbnail()
            }
            Text(file.title ?? file.filename)
                .font(.caption.weight(.semibold))
                .lineLimit(2)
                .truncationMode(.middle)
            HStack(spacing: 6) {
                Text(detail)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Spacer(minLength: 4)
                Button {
                    features.toggleFilePin(file, fallbackSessionID: store.selectedSessionID ?? "")
                } label: {
                    Image(systemName: features.isFilePinned(file.id) ? "pin.fill" : "pin")
                }
                .buttonStyle(.borderless)
                .accessibilityLabel(features.isFilePinned(file.id) ? "Unpin file" : "Pin file")
                if let find {
                    Button(action: find) {
                        Image(systemName: "magnifyingglass")
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel("Find in chat")
                }
                MobileArtifactShareButton(file: file, url: url, title: "")
                    .labelStyle(.iconOnly)
                    .font(.caption)
                Link(destination: url) {
                    Image(systemName: "arrow.up.right.square")
                }
                .font(.caption)
            }
        }
        .padding(8)
        .background(.thinMaterial)
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .contentShape(Rectangle())
        .onDrag {
            MobileArtifactDragItemProvider.provider(for: file, url: url)
        }
        .fullScreenCover(isPresented: $fullscreenVideo) {
            MobileFullscreenVideoView(url: url, title: file.title ?? file.filename)
        }
    }

    private var detail: String {
        file.size.map(mobileByteString) ?? "Video"
    }

    @MainActor
    private func loadThumbnail() async {
        thumbnail = nil
        thumbnailFailed = false
        let data = await MobileVideoThumbnailCache.shared.thumbnailData(for: url)
        guard !Task.isCancelled else { return }
        guard let data else {
            thumbnailFailed = true
            return
        }
        thumbnail = UIImage(data: data)
        thumbnailFailed = thumbnail == nil
    }
}

private struct MobileVideoThumbnailPreview: View {
    let image: UIImage?
    let failed: Bool

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 8)
                .fill(.black.opacity(0.18))
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
            } else {
                Image(systemName: failed ? "film" : "photo.on.rectangle")
                    .font(.title2.weight(.semibold))
                    .foregroundStyle(.green)
            }
            LinearGradient(
                colors: [.black.opacity(0.22), .clear],
                startPoint: .top,
                endPoint: .center
            )
            Image(systemName: "play.circle.fill")
                .font(.title2.weight(.semibold))
                .foregroundStyle(.white.opacity(0.92))
                .shadow(radius: 3)
        }
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .clipped()
    }
}

private actor MobileVideoThumbnailCache {
    static let shared = MobileVideoThumbnailCache()

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
                try makeMobileVideoThumbnailData(from: url)
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

private func makeMobileVideoThumbnailData(from url: URL) throws -> Data {
    let asset = AVURLAsset(url: url)
    let generator = AVAssetImageGenerator(asset: asset)
    generator.appliesPreferredTrackTransform = true
    generator.maximumSize = CGSize(width: 360, height: 240)
    generator.requestedTimeToleranceBefore = .zero
    generator.requestedTimeToleranceAfter = CMTime(seconds: 1, preferredTimescale: 600)
    let image = try generator.copyCGImage(at: CMTime(seconds: 0.2, preferredTimescale: 600), actualTime: nil)
    guard let data = UIImage(cgImage: image).jpegData(compressionQuality: 0.68) else {
        throw CocoaError(.fileWriteUnknown)
    }
    return data
}

private struct MobileChatFileRow: View {
    @EnvironmentObject private var store: MobileAppStore
    @EnvironmentObject private var features: MobileFeatureStore
    let file: ZFile
    let url: URL
    let find: (() -> Void)?
    @State private var fullscreenVideo = false

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: icon)
                .foregroundStyle(tint)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 3) {
                Text(file.title ?? file.filename)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(2)
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            Button {
                features.toggleFilePin(file, fallbackSessionID: store.selectedSessionID ?? "")
            } label: {
                Image(systemName: features.isFilePinned(file.id) ? "pin.fill" : "pin")
            }
            .buttonStyle(.borderless)
            .accessibilityLabel(features.isFilePinned(file.id) ? "Unpin file" : "Pin file")
            if let find {
                Button(action: find) {
                    Image(systemName: "magnifyingglass")
                }
                .buttonStyle(.borderless)
                .accessibilityLabel("Find in chat")
            }
            if isVideo {
                MobileArtifactShareButton(file: file, url: url, title: "")
                    .labelStyle(.iconOnly)
                    .accessibilityLabel("Download file")
                Button {
                    fullscreenVideo = true
                } label: {
                    Image(systemName: "arrow.up.left.and.arrow.down.right")
                }
                .buttonStyle(.borderless)
                .accessibilityLabel("Open video fullscreen")
            }
            if !isVideo {
                MobileArtifactShareButton(file: file, url: url, title: "")
                    .labelStyle(.iconOnly)
                    .accessibilityLabel("Download file")
            }
            Link(destination: url) {
                Image(systemName: "arrow.up.right.square")
            }
            .accessibilityLabel("Open file")
        }
        .padding(.vertical, 4)
        .contentShape(Rectangle())
        .onDrag {
            MobileArtifactDragItemProvider.provider(for: file, url: url)
        }
        .fullScreenCover(isPresented: $fullscreenVideo) {
            MobileFullscreenVideoView(url: url, title: file.title ?? file.filename)
        }
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
            parts.append(mobileByteString(size))
        }
        return parts.joined(separator: " · ")
    }
}

private struct MobileLiveProcessesSection: View {
    @EnvironmentObject private var store: MobileAppStore
    @State private var isOpen = false

    var body: some View {
        Section {
            if isOpen {
                if let snapshot = store.processSnapshot, snapshot.active {
                    VStack(alignment: .leading, spacing: 5) {
                        Text("\(snapshot.backend?.capitalized ?? "Agent") · pid \(snapshot.pid ?? 0)")
                            .font(.caption.weight(.semibold))
                        Text(mobileElapsedString(snapshot.elapsed_seconds ?? 0))
                            .font(.caption2.monospacedDigit())
                            .foregroundStyle(.secondary)
                        if let cwd = snapshot.cwd {
                            Text(cwd)
                                .font(.caption2.monospaced())
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                                .truncationMode(.middle)
                        }
                    }
                    ForEach(snapshot.processes) { process in
                        MobileLiveProcessRow(process: process)
                    }
                    if let output = snapshot.stdout_tail {
                        MobileLiveProcessOutputView(output: output)
                    }
                    if let log = store.processLogTail {
                        MobileLiveProcessLogView(log: log)
                    }
                } else {
                    Text(store.isRunning ? "No process snapshot yet" : "No live process for this chat")
                        .foregroundStyle(.secondary)
                }
                HStack {
                    Button {
                        Task { await store.refreshSelectedProcesses() }
                    } label: {
                        Label(store.isLoadingProcesses ? "Refreshing" : "Refresh", systemImage: "arrow.clockwise")
                    }
                    Button {
                        isOpen = false
                        store.processSnapshot = nil
                        store.processLogTail = nil
                    } label: {
                        Label("Hide", systemImage: "chevron.up")
                    }
                }
            } else {
                Text(store.isRunning ? "Live process inspection is available on request." : "No live process inspection loaded.")
                    .foregroundStyle(.secondary)
                Button {
                    isOpen = true
                    Task { await store.refreshSelectedProcesses() }
                } label: {
                    Label("Inspect Live Process", systemImage: "terminal")
                }
                .disabled(store.selectedSessionID == nil || store.isLoadingProcesses)
            }
        } header: {
            Text("Live Processes")
        } footer: {
            Text("Loads the selected chat's active process group and stdout only when requested.")
        }
        .onChange(of: store.selectedSessionID) {
            isOpen = false
            store.processSnapshot = nil
            store.processLogTail = nil
        }
    }
}

private struct MobileLiveProcessRow: View {
    @EnvironmentObject private var store: MobileAppStore
    let process: ZProcessInfo
    @State private var detailsOpen = false

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack {
                Circle()
                    .fill(statusColor)
                    .frame(width: 7, height: 7)
                Text(process.command ?? "process")
                    .font(.caption.weight(.semibold))
                    .lineLimit(1)
                Spacer()
                Text("pid \(process.pid)")
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(.secondary)
                Button {
                    detailsOpen = true
                } label: {
                    Image(systemName: "info.circle")
                }
                .buttonStyle(.borderless)
                .accessibilityLabel("Show process details")
            }
            Text(metricText)
                .font(.caption2.monospacedDigit())
                .foregroundStyle(.secondary)
            if let args = process.args, !args.isEmpty {
                Text(args)
                    .font(.caption2.monospaced())
                    .lineLimit(2)
                    .truncationMode(.middle)
                    .textSelection(.enabled)
            }
            if let hints = process.log_hints, !hints.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(hints) { hint in
                            Button {
                                Task { await store.tailProcessLog(hint) }
                            } label: {
                                Label(hint.source, systemImage: "doc.text.magnifyingglass")
                            }
                            .buttonStyle(.bordered)
                            .controlSize(.small)
                        }
                    }
                }
            }
        }
        .padding(.leading, CGFloat(process.depth ?? 0) * 10)
        .contentShape(Rectangle())
        .onTapGesture {
            detailsOpen = true
        }
        .sheet(isPresented: $detailsOpen) {
            NavigationStack {
                MobileLiveProcessDetailSheet(process: process)
                    .environmentObject(store)
            }
        }
    }

    private var statusColor: Color {
        if process.stat?.contains("Z") == true { return .red }
        if (process.cpu_percent ?? 0) > 20 { return .orange }
        return .green
    }

    private var metricText: String {
        let cpu = String(format: "%.1f%% CPU", process.cpu_percent ?? 0)
        let memory = mobileByteString((process.rss_kb ?? 0) * 1024)
        return "\(cpu) · \(memory) · \(mobileElapsedString(process.elapsed_seconds ?? 0))"
    }
}

private struct MobileLiveProcessDetailSheet: View {
    @EnvironmentObject private var store: MobileAppStore
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
        Form {
            Section("Process") {
                LabeledContent("Command", value: process.command ?? "process")
                LabeledContent("PID", value: "\(process.pid)")
                LabeledContent("Parent", value: process.ppid.map { "\($0)" } ?? "-")
                LabeledContent("Group", value: process.pgid.map { "\($0)" } ?? "-")
                LabeledContent("State", value: process.stat ?? "-")
                LabeledContent("CPU", value: String(format: "%.1f%%", process.cpu_percent ?? 0))
                LabeledContent("Memory", value: mobileByteString((process.rss_kb ?? 0) * 1024))
                LabeledContent("Elapsed", value: mobileElapsedString(process.elapsed_seconds ?? 0))
            }

            if let cwd = process.cwd, !cwd.isEmpty {
                Section("Working Directory") {
                    selectableBlock(cwd)
                    Button {
                        UIPasteboard.general.string = cwd
                    } label: {
                        Label("Copy Directory", systemImage: "doc.on.doc")
                    }
                }
            }

            Section("Command Line") {
                selectableBlock(commandText)
                Button {
                    UIPasteboard.general.string = commandText
                } label: {
                    Label("Copy Command", systemImage: "doc.on.doc")
                }
            }

            if let hints = process.log_hints, !hints.isEmpty {
                Section("Attached Logs") {
                    ForEach(hints) { hint in
                        Button {
                            selectedLogPath = hint.path
                            Task { await store.tailProcessLog(hint) }
                        } label: {
                            VStack(alignment: .leading, spacing: 3) {
                                Label(hint.source, systemImage: "doc.text.magnifyingglass")
                                Text(hint.path)
                                    .font(.caption2.monospaced())
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                                    .truncationMode(.middle)
                            }
                        }
                    }
                }
            }

            Section("Log Tail") {
                if hasAttachedLog, let log = store.processLogTail {
                    MobileLiveProcessLogView(log: log)
                } else {
                    Text("Pick an attached log to inspect its latest tail.")
                        .foregroundStyle(.secondary)
                }
            }
        }
        .navigationTitle("Process \(process.pid)")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Done") {
                    dismiss()
                }
            }
        }
    }

    private func selectableBlock(_ text: String) -> some View {
        ScrollView(.horizontal, showsIndicators: true) {
            Text(text)
                .font(.caption.monospaced())
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, 4)
        }
    }

    private func samePath(_ lhs: String, _ rhs: String) -> Bool {
        if lhs == rhs {
            return true
        }
        return URL(fileURLWithPath: lhs).standardizedFileURL.path == URL(fileURLWithPath: rhs).standardizedFileURL.path
    }
}

private struct MobileLiveProcessOutputView: View {
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
                Spacer()
                if !detailText.isEmpty {
                    Text(detailText)
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Button {
                    UIPasteboard.general.string = output.text
                    copied = true
                    Task {
                        try? await Task.sleep(for: .seconds(0.9))
                        await MainActor.run { copied = false }
                    }
                } label: {
                    Image(systemName: copied ? "checkmark" : "doc.on.doc")
                }
                .disabled(output.text.isEmpty)
                .accessibilityLabel("Copy stdout")
                Button {
                    isExpanded = false
                } label: {
                    Image(systemName: "xmark.circle")
                }
                .disabled(!isExpanded)
                .accessibilityLabel("Hide stdout details")
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
                .frame(minHeight: 120, maxHeight: 260)
                .background(Color.black.opacity(0.18))
                .clipShape(RoundedRectangle(cornerRadius: 8))
            } else if !output.text.isEmpty {
                Text(output.text.split(separator: "\n").last.map(String.init) ?? "")
                    .font(.caption2.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
        }
        .padding(.vertical, 4)
    }
}

private struct MobileLiveProcessLogView: View {
    let log: ZProcessLogTail

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(log.path)
                .font(.caption2.monospaced())
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
                .textSelection(.enabled)
            ScrollView {
                Text(log.text.isEmpty ? "(empty log)" : log.text)
                    .font(.caption2.monospaced())
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(8)
            }
            .frame(minHeight: 120, maxHeight: 240)
            .background(Color.black.opacity(0.18))
            .clipShape(RoundedRectangle(cornerRadius: 8))
        }
    }
}

private func mobileElapsedString(_ seconds: Int) -> String {
    if seconds < 60 {
        return "\(seconds)s"
    }
    if seconds < 3600 {
        return "\(seconds / 60)m \(seconds % 60)s"
    }
    return "\(seconds / 3600)h \((seconds % 3600) / 60)m"
}

private struct MobileJobRow: View {
    @EnvironmentObject private var store: MobileAppStore
    let job: ZJob
    @State private var editorOpen = false

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Circle()
                .fill(job.enabled ? .green : .secondary)
                .frame(width: 8, height: 8)
                .padding(.top, 7)
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
                Button {
                    editorOpen = true
                } label: {
                    Label("Edit Job", systemImage: "slider.horizontal.3")
                }
                Button {
                    Task { await store.runJobNow(job) }
                } label: {
                    Label("Run Now", systemImage: "play.fill")
                }
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
        .sheet(isPresented: $editorOpen) {
            MobileJobEditorView(job: currentJob, isPresented: $editorOpen)
                .environmentObject(store)
        }
    }

    private var currentJob: ZJob {
        store.jobs.first(where: { $0.id == job.id }) ?? job
    }

    private var subtitle: String {
        let runs = "\(job.run_count ?? 0) run\(job.run_count == 1 ? "" : "s")"
        let mode = mobileJobRunModeDescription(loop: job.loop == true, maxRuns: job.max_runs).lowercased()
        let interval = job.interval_seconds.map(mobileJobIntervalDescription) ?? "manual"
        if let next = mobileLocalTimestampString(job.next_run_at_iso) {
            return "\(mode) · \(interval) · \(runs) · next \(next)"
        }
        return "\(mode) · \(interval) · \(runs) · \(job.enabled ? "manual" : "paused")"
    }
}

private struct MobileJobEditorView: View {
    @EnvironmentObject private var store: MobileAppStore
    let job: ZJob
    @Binding var isPresented: Bool
    @State private var title = ""
    @State private var prompt = ""
    @State private var intervalText = "3600"
    @State private var startOption: MobileJobStartOption = .keepCurrent
    @State private var startDate = Date().addingTimeInterval(3_600)
    @State private var loop = true
    @State private var maxRunsText = "1"
    @State private var enabled = true
    @State private var backend = "claude"
    @State private var isSaving = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Job") {
                    TextField("Title", text: $title)
                    Picker("Backend", selection: $backend) {
                        Text("Claude").tag("claude")
                        Text("Codex").tag("codex")
                    }
                    Picker("Mode", selection: $loop) {
                        Text("Fixed").tag(false)
                        Text("Loop").tag(true)
                    }
                    .pickerStyle(.segmented)
                    if !loop {
                        Stepper(value: fixedRunsBinding, in: 1...999) {
                            TextField("Run count", text: $maxRunsText)
                                .keyboardType(.numberPad)
                        }
                    }
                    Toggle("Enabled", isOn: $enabled)
                }

                Section("Schedule") {
                    MobileJobIntervalControl(intervalText: $intervalText)
                    MobileJobStartControl(
                        option: $startOption,
                        customDate: $startDate,
                        intervalSeconds: parsedInterval,
                        includeKeepCurrent: true,
                        currentNextRun: mobileLocalTimestampString(job.next_run_at_iso)
                    )
                    if !intervalIsValid {
                        Text("Interval must be at least 10 seconds.")
                            .font(.caption)
                            .foregroundStyle(.red)
                    }
                }

                Section {
                    TextField("Prompt", text: $prompt, axis: .vertical)
                        .lineLimit(8...18)
                        .font(.body.monospaced())
                } header: {
                    Text("Prompt")
                } footer: {
                    if !intervalIsValid {
                        Text("Interval must be at least 10 seconds.")
                            .foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("Edit Job")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        isPresented = false
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(isSaving ? "Saving" : "Save") {
                        save()
                    }
                    .disabled(!canSave || isSaving)
                }
            }
            .onAppear { syncDrafts() }
            .onChange(of: job.id) { syncDrafts() }
        }
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
        startDate = mobileParseServerDate(job.next_run_at_iso) ?? Date().addingTimeInterval(TimeInterval(job.interval_seconds ?? 3_600))
        loop = job.loop == true
        maxRunsText = "\(max(1, job.max_runs ?? 1))"
        enabled = job.enabled
        backend = job.backend ?? store.selectedSession?.backend ?? "claude"
    }

    private func save() {
        guard let parsedInterval, canSave else { return }
        let nextRunAt = mobileJobScheduledDate(
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
