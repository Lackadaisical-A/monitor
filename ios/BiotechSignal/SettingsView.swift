import SwiftUI
import UserNotifications

struct SettingsView: View {
    @EnvironmentObject private var store: MonitorStore
    @State private var baseURL = ""
    @State private var developerCredential = ""
    @State private var isSaving = false
    @State private var showSaved = false

    var body: some View {
        Form {
            Section("Plan") {
                LabeledContent("Access", value: planName)
                if store.access.pro {
                    Label(
                        store.access.level == "developer" ? "Developer entitlement" : "Real-time Pro entitlement",
                        systemImage: "checkmark.seal.fill"
                    )
                    .foregroundStyle(Color.catalystGreen)
                    if store.access.source == "app_store" {
                        Link("Manage subscription", destination: URL(string: "https://apps.apple.com/account/subscriptions")!)
                    }
                } else {
                    Button {
                        store.showingPaywall = true
                    } label: {
                        Label("View Pro plans", systemImage: "sparkles")
                    }
                }
            }

            Section("iPhone alerts") {
                LabeledContent("Permission", value: store.notificationStatus)
                LabeledContent("APNs token", value: NotificationManager.shared.deviceToken == nil ? "Not registered" : "Registered")
                Button {
                    Task { await store.enableNotifications() }
                } label: {
                    Label("Enable notifications", systemImage: "bell.badge")
                }
                Button {
                    Task { await store.sendLocalTest() }
                } label: {
                    Label("Send local test", systemImage: "bell.and.waves.left.and.right")
                }
            }

            if let status = store.status {
                Section("Server state") {
                    LabeledContent("Analysis", value: status.configuration.model)
                    LabeledContent("Alert delivery", value: status.configuration.dryRun ? "Dry run" : "Live")
                    LabeledContent("APNs provider", value: status.configuration.apnsConfigured ? "Configured" : "Missing credentials")
                    LabeledContent("Analyzed items", value: "\(status.stats.analyzed_count)")
                    LabeledContent("Paired devices", value: "\(status.stats.deviceCount)")
                }
            }

            Section {
                TextField("https://monitor.example.com", text: $baseURL)
                    .textInputAutocapitalization(.never)
                    .keyboardType(.URL)
                    .autocorrectionDisabled()
                SecureField("Developer credential (optional)", text: $developerCredential)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                Button {
                    Task { await save() }
                } label: {
                    HStack {
                        if isSaving { ProgressView().controlSize(.small) }
                        Text(isSaving ? "Connecting…" : "Save connection")
                    }
                }
                .disabled(isSaving || baseURL.isEmpty)
            } header: {
                Text("Advanced connection")
            } footer: {
                Text("Installation credentials remain in this iPhone's Keychain.")
            }

            Section("Safety") {
                Label("No signal is guaranteed", systemImage: "exclamationmark.shield")
                Label("No automatic trading", systemImage: "hand.raised")
                Label("Primary-source verification required", systemImage: "doc.text.magnifyingglass")
                Link("Privacy policy", destination: URL(string: "https://lackadaisical-a.github.io/monitor/privacy.html")!)
                Link("Support", destination: URL(string: "https://lackadaisical-a.github.io/monitor/support.html")!)
            }

            if let error = store.lastError {
                Section {
                    Text(error).font(.caption).foregroundStyle(.red)
                }
            }
        }
        .scrollContentBackground(.hidden)
        .background(Color.catalystBackground)
        .navigationTitle("Settings")
        .onAppear { baseURL = store.settings.baseURL }
        .alert("Connection updated", isPresented: $showSaved) {
            Button("OK", role: .cancel) {}
        }
    }

    private var planName: String {
        switch store.access.level {
        case "developer": "Developer Pro"
        case "pro": "Pro"
        default: "Free"
        }
    }

    private func save() async {
        isSaving = true
        defer { isSaving = false }
        do {
            try await store.saveSettings(baseURL: baseURL, developerCredential: developerCredential)
            developerCredential = ""
            showSaved = true
        } catch {
            store.lastError = error.localizedDescription
        }
    }
}
