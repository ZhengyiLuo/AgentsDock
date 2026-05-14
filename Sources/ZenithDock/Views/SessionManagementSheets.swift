import SwiftUI

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
    @State private var cwd = "/home/zen"

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
