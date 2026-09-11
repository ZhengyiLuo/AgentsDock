import SwiftUI

enum MobileAppearanceMode: String, CaseIterable, Identifiable {
    case system
    case light
    case dark

    var id: String { rawValue }

    var label: String {
        switch self {
        case .system: return "System"
        case .light: return "Light"
        case .dark: return "Dark"
        }
    }

    var icon: String {
        switch self {
        case .system: return "circle.lefthalf.filled"
        case .light: return "sun.max"
        case .dark: return "moon"
        }
    }

    var colorScheme: ColorScheme? {
        switch self {
        case .system: return nil
        case .light: return .light
        case .dark: return .dark
        }
    }
}

struct MobileSettingsView: View {
    @EnvironmentObject private var store: MobileAppStore
    @Environment(\.dismiss) private var dismiss
    @AppStorage("AgentsDock.appearanceMode") private var appearanceMode = MobileAppearanceMode.system.rawValue

    @State private var host = ""
    @State private var port = ""
    @State private var token = ""
    @State private var reconnecting = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Appearance") {
                    Picker("Appearance", selection: $appearanceMode) {
                        ForEach(MobileAppearanceMode.allCases) { mode in
                            Label(mode.label, systemImage: mode.icon)
                                .tag(mode.rawValue)
                        }
                    }
                    .pickerStyle(.segmented)
                }

                Section("Connection") {
                    HStack(spacing: 10) {
                        Text("Server")
                        Spacer()
                        Label(
                            store.serverReachable ? "Online" : "Offline",
                            systemImage: store.serverReachable ? "checkmark.circle.fill" : "xmark.circle.fill"
                        )
                        .foregroundStyle(store.serverReachable ? .green : .red)
                    }

                    HStack(spacing: 10) {
                        TextField("Host", text: $host)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .keyboardType(.URL)
                        TextField("Port", text: $port)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .keyboardType(.numberPad)
                            .frame(width: 74)
                    }

                    SecureField("Access token", text: $token)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()

                    Text(store.connectionDetail)
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                }

                Section("Notifications") {
                    Toggle(
                        "Agent notifications and badge",
                        isOn: Binding(
                            get: { store.notificationsEnabled },
                            set: { store.setNotificationsEnabled($0) }
                        )
                    )
                    Text("Alerts are delivered when an agent posts while AgentsDock is in the background. The badge counts chats with unread agent messages.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Section("About") {
                    LabeledContent("App", value: "AgentsDock")
                    LabeledContent("Version", value: appVersion)
                    LabeledContent("Unread chats", value: "\(store.unreadAgentSessionIDs.count)")
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        applyAndReconnect()
                    } label: {
                        if reconnecting {
                            ProgressView()
                        } else {
                            Text("Apply")
                        }
                    }
                    .disabled(reconnecting || host.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
        .onAppear {
            host = store.serverHost
            port = store.serverPort
            token = store.accessToken
        }
    }

    private var appVersion: String {
        let short = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "—"
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "—"
        return "\(short) (\(build))"
    }

    private func applyAndReconnect() {
        reconnecting = true
        store.updateServerAddress(host: host, port: port)
        if store.accessToken != token {
            store.accessToken = token
            store.rememberAccessToken()
        }
        Task {
            await store.reconnect()
            reconnecting = false
            dismiss()
        }
    }
}
