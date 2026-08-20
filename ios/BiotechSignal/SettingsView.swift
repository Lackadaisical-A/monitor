import SwiftUI
import UserNotifications

struct SettingsView: View {
    @EnvironmentObject private var store: MonitorStore
    @State private var baseURL = ""
    @State private var pairingToken = ""
    @State private var isSaving = false
    @State private var showSaved = false

    var body: some View {
        Form {
            Section {
                TextField("https://monitor.example.com", text: $baseURL)
                    .textInputAutocapitalization(.never)
                    .keyboardType(.URL)
                    .autocorrectionDisabled()
                SecureField("Pairing token", text: $pairingToken)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                Button {
                    Task { await save() }
                } label: {
                    HStack {
                        if isSaving { ProgressView().controlSize(.small) }
                        Text(isSaving ? "Connecting…" : "Save and connect")
                    }
                }
                .disabled(isSaving || baseURL.isEmpty || pairingToken.isEmpty)
            } header: {
                Text("Private server")
            } footer: {
                Text("Use HTTPS outside your local network. The pairing token is stored in this device's Keychain.")
            }

            Section {
                LabeledContent("Permission", value: store.notificationStatus)
                LabeledContent("APNs token", value: NotificationManager.shared.deviceToken == nil ? "Not registered" : "Registered")
                Button("Enable notifications") { Task { await store.enableNotifications() } }
                Button("Send local Time Sensitive test") { Task { await store.sendLocalTest() } }
            } header: {
                Text("iPhone alerts")
            } footer: {
                Text("Time Sensitive alerts can break through Focus and Notification Summary if enabled, but users can turn that off. Critical Alerts also bypass mute and require a separate Apple-approved entitlement; this project keeps them disabled by default.")
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

            Section("Safety") {
                Label("No signal is guaranteed", systemImage: "exclamationmark.shield")
                Label("No automatic trading", systemImage: "hand.raised")
                Label("Primary-source verification required", systemImage: "doc.text.magnifyingglass")
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
        .onAppear {
            let current = store.settings
            baseURL = current.baseURL
            pairingToken = current.pairingToken
        }
        .alert("Connected", isPresented: $showSaved) {
            Button("OK", role: .cancel) {}
        } message: {
            Text("This iPhone is paired with your monitor.")
        }
    }

    private func save() async {
        isSaving = true
        defer { isSaving = false }
        do {
            try await store.saveSettings(baseURL: baseURL, pairingToken: pairingToken)
            showSaved = true
        } catch {
            store.lastError = error.localizedDescription
        }
    }
}
