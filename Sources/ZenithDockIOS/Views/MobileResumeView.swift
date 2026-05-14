import SwiftUI

struct MobileResumeView: View {
    @EnvironmentObject private var store: MobileAppStore
    @Binding var isPresented: Bool
    @State private var backend = "claude"
    @State private var providerID = ""
    @State private var title = ""
    @State private var folder = "General"
    @State private var cwd = "/home/zen"

    var body: some View {
        NavigationStack {
            Form {
                Section("Provider") {
                    Picker("Backend", selection: $backend) {
                        Text("Claude").tag("claude")
                        Text("Codex").tag("codex")
                    }
                    .pickerStyle(.segmented)
                    TextField(backend == "claude" ? "Claude session ID" : "Codex thread ID", text: $providerID)
                }
                Section("Chat") {
                    TextField("Title", text: $title)
                    TextField("Folder", text: $folder)
                    TextField("Working directory", text: $cwd)
                }
            }
            .navigationTitle("Resume Chat")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { isPresented = false }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Resume") { resume() }
                        .disabled(providerID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
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
