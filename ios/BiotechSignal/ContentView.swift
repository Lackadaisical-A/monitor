import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var store: MonitorStore

    var body: some View {
        TabView {
            NavigationStack { SignalFeedView() }
                .tabItem { Label("Signals", systemImage: "waveform.path.ecg") }
            NavigationStack { SettingsView() }
                .tabItem { Label("Settings", systemImage: "slider.horizontal.3") }
        }
        .tint(.catalystGreen)
        .sheet(item: $store.selectedSignal) { entry in
            NavigationStack { SignalDetailView(entry: entry) }
                .presentationDetents([.large])
        }
    }
}

private struct SignalFeedView: View {
    @EnvironmentObject private var store: MonitorStore

    var body: some View {
        ZStack {
            Color.catalystBackground.ignoresSafeArea()
            ScrollView {
                LazyVStack(spacing: 14) {
                    DisclaimerCard()
                    if store.settings.isComplete == false {
                        EmptyMonitorCard(
                            icon: "link.badge.plus",
                            title: "Connect your monitor",
                            body: "Add the server URL and pairing token in Settings."
                        )
                    } else if store.entries.isEmpty {
                        EmptyMonitorCard(
                            icon: "scope",
                            title: "No signals yet",
                            body: "The server is watching for evidence that matches your company watchlist."
                        )
                    } else {
                        ForEach(store.entries) { entry in
                            Button { store.selectedSignal = entry } label: { SignalCard(entry: entry) }
                                .buttonStyle(.plain)
                        }
                    }
                }
                .padding(16)
            }
            .refreshable { await store.refresh() }
        }
        .navigationTitle("Catalyst Watch")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                ConnectionPill(state: store.connection)
            }
        }
    }
}

private struct DisclaimerCard: View {
    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "exclamationmark.shield.fill").foregroundStyle(Color.catalystAmber)
            Text("Signals are probabilistic research support—not certainty or trading instructions. Verify the primary source.")
                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(Color.catalystAmber.opacity(0.07), in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(Color.catalystAmber.opacity(0.18)))
    }
}

private struct SignalCard: View {
    let entry: FeedEntry

    var body: some View {
        let analysis = entry.analysis
        let assessment = analysis?.assessment
        VStack(alignment: .leading, spacing: 13) {
            HStack {
                Text(assessment?.ticker.nonEmpty ?? entry.item.tickerHint ?? "—")
                    .font(.system(.headline, design: .monospaced, weight: .bold))
                    .foregroundStyle(Color.catalystGreen)
                TierPill(tier: analysis?.alertTier ?? "pending")
                Spacer()
                Text(relativeDate(entry.item.publishedAt)).font(.caption2).foregroundStyle(.tertiary)
            }
            Text(entry.item.headline)
                .font(.subheadline.weight(.semibold)).multilineTextAlignment(.leading)
                .foregroundStyle(.primary).lineLimit(3)
            HStack(spacing: 16) {
                Metric(label: "Materiality", value: assessment.map { "\($0.materiality)" } ?? "—")
                Metric(label: "Confidence", value: assessment.map { "\(Int($0.confidence * 100))%" } ?? "—")
                Metric(label: "Direction", value: assessment?.stockDirection.capitalized ?? "Pending")
            }
            HStack(spacing: 6) {
                Image(systemName: sourceIcon(entry.item.source.type))
                Text(entry.item.source.name)
                if entry.corroborationCount > 0 {
                    Text("· \(entry.corroborationCount + 1) sources")
                }
            }
            .font(.caption2).foregroundStyle(.secondary)
        }
        .padding(16)
        .background(Color.catalystPanel, in: RoundedRectangle(cornerRadius: 18))
        .overlay(RoundedRectangle(cornerRadius: 18).stroke(Color.white.opacity(0.07)))
    }
}

private struct SignalDetailView: View {
    @Environment(\.dismiss) private var dismiss
    let entry: FeedEntry

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                if let analysis = entry.analysis {
                    HStack { TierPill(tier: analysis.alertTier); Text(analysis.assessment.stockDirection.capitalized).foregroundStyle(directionColor(analysis.assessment.stockDirection)); Spacer() }
                    Text(entry.item.headline).font(.title2.bold())
                    HStack(spacing: 10) {
                        DetailScore(label: "Materiality", value: "\(analysis.assessment.materiality)/100")
                        DetailScore(label: "Confidence", value: "\(Int(analysis.assessment.confidence * 100))%")
                        DetailScore(label: "Base case", value: signed(analysis.assessment.expectedMoveBasePct))
                    }
                    DetailSection(title: "Why it may matter", text: analysis.assessment.rationale)
                    DetailList(title: "Evidence", values: analysis.assessment.evidence)
                    DetailList(title: "Uncertainty", values: analysis.assessment.uncertainty)
                    DetailList(title: "Disconfirming evidence", values: analysis.assessment.disconfirmingEvidence)
                    DetailList(title: "Alert policy", values: analysis.policyReasons)
                } else {
                    Text(entry.item.headline).font(.title2.bold())
                    Text("This item has not been analyzed yet.").foregroundStyle(.secondary)
                }
                if let url = URL(string: entry.item.url) {
                    Link(destination: url) { Label("Verify original source", systemImage: "arrow.up.right.square") }
                        .foregroundStyle(Color.catalystGreen)
                }
            }
            .padding(20)
        }
        .background(Color.catalystBackground)
        .navigationTitle(entry.analysis?.assessment.ticker ?? "Signal")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
    }
}

private struct EmptyMonitorCard: View {
    let icon: String; let title: String; let body: String
    var body: some View {
        VStack(spacing: 13) {
            Image(systemName: icon).font(.system(size: 28)).foregroundStyle(Color.catalystGreen)
            Text(title).font(.headline)
            Text(body).font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity).padding(.vertical, 44).padding(.horizontal, 20)
        .background(Color.catalystPanel, in: RoundedRectangle(cornerRadius: 18))
    }
}

private struct TierPill: View {
    let tier: String
    var body: some View {
        Text(tier.uppercased()).font(.system(size: 9, weight: .bold, design: .rounded)).tracking(1)
            .foregroundStyle(tierColor(tier)).padding(.horizontal, 8).padding(.vertical, 4)
            .background(tierColor(tier).opacity(0.09), in: Capsule())
            .overlay(Capsule().stroke(tierColor(tier).opacity(0.25)))
    }
}

private struct Metric: View {
    let label: String; let value: String
    var body: some View { VStack(alignment: .leading, spacing: 3) { Text(value).font(.subheadline.bold()); Text(label).font(.system(size: 9)).foregroundStyle(.tertiary).textCase(.uppercase) } }
}

private struct DetailScore: View {
    let label: String; let value: String
    var body: some View { VStack(alignment: .leading, spacing: 5) { Text(label.uppercased()).font(.system(size: 8, weight: .bold)).tracking(1).foregroundStyle(.secondary); Text(value).font(.headline) }.frame(maxWidth: .infinity, alignment: .leading).padding(12).background(Color.catalystPanel, in: RoundedRectangle(cornerRadius: 12)) }
}

private struct DetailSection: View {
    let title: String; let text: String
    var body: some View { VStack(alignment: .leading, spacing: 8) { Text(title.uppercased()).font(.caption2.bold()).tracking(1.2).foregroundStyle(Color.catalystGreen); Text(text).font(.subheadline).foregroundStyle(.secondary) } }
}

private struct DetailList: View {
    let title: String; let values: [String]
    var body: some View {
        if !values.isEmpty { VStack(alignment: .leading, spacing: 9) { Text(title.uppercased()).font(.caption2.bold()).tracking(1.2).foregroundStyle(Color.catalystGreen); ForEach(values, id: \.self) { value in HStack(alignment: .top) { Circle().fill(Color.catalystGreen.opacity(0.7)).frame(width: 4, height: 4).padding(.top, 7); Text(value).font(.subheadline).foregroundStyle(.secondary) } } } }
    }
}

private struct ConnectionPill: View {
    let state: ConnectionState
    var body: some View {
        HStack(spacing: 5) { Circle().fill(color).frame(width: 6, height: 6); Text(label).font(.caption2) }.foregroundStyle(.secondary)
    }
    private var label: String { switch state { case .connected: "Live"; case .connecting: "Syncing"; case .failed: "Offline"; case .notConfigured: "Setup" } }
    private var color: Color { switch state { case .connected: .catalystGreen; case .connecting: .catalystAmber; case .failed: .red; case .notConfigured: .secondary } }
}

private func tierColor(_ tier: String) -> Color { switch tier { case "urgent": .catalystGreen; case "high": .catalystAmber; case "watch": .blue; default: .secondary } }
private func directionColor(_ direction: String) -> Color { direction == "bullish" ? .catalystGreen : direction == "bearish" ? .red : .secondary }
private func sourceIcon(_ type: String) -> String { switch type { case "sec": "building.columns"; case "clinical_trials": "cross.case"; case "x": "bubble.left"; case "reddit": "person.3"; default: "newspaper" } }
private func signed(_ value: Double) -> String { String(format: "%@%.0f%%", value > 0 ? "+" : "", value) }
private func relativeDate(_ value: String) -> String {
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let plain = ISO8601DateFormatter()
    guard let date = fractional.date(from: value) ?? plain.date(from: value) else { return value }
    return date.formatted(.relative(presentation: .numeric))
}

private extension String {
    var nonEmpty: String? { isEmpty ? nil : self }
}

extension Color {
    static let catalystBackground = Color(red: 0.027, green: 0.063, blue: 0.055)
    static let catalystPanel = Color(red: 0.063, green: 0.116, blue: 0.098)
    static let catalystGreen = Color(red: 0.41, green: 0.90, blue: 0.67)
    static let catalystAmber = Color(red: 0.95, green: 0.78, blue: 0.43)
}
