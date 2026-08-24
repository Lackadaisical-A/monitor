import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var store: MonitorStore

    var body: some View {
        TabView(selection: $store.selectedTab) {
            NavigationStack { SignalFeedView() }
                .tabItem { Label("Signals", systemImage: "waveform.path.ecg") }
                .tag("signals")
            NavigationStack { WatchlistView() }
                .tabItem { Label("Watchlist", systemImage: "star") }
                .tag("watchlist")
            NavigationStack { SettingsView() }
                .tabItem { Label("Settings", systemImage: "slider.horizontal.3") }
                .tag("settings")
        }
        .tint(.catalystGreen)
        .sheet(item: $store.selectedSignal) { entry in
            NavigationStack { SignalDetailView(entry: entry) }
                .presentationDetents([.large])
        }
        .sheet(isPresented: $store.showingPaywall) {
            SubscriptionView()
                .environmentObject(store)
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
                    if !store.access.pro {
                        FreePlanBar()
                    }
                    FeedScopeBar()
                    DisclaimerCard()
                    if store.scanInProgress {
                        ScanProgressCard()
                    } else if let summary = store.lastScanSummary {
                        ScanSummaryCard(summary: summary)
                    }
                    if let error = store.lastError, store.connection != .notConfigured {
                        EmptyMonitorCard(
                            icon: "wifi.slash",
                            title: "Connection problem",
                            message: error
                        )
                    }
                    if store.settings.isComplete == false {
                        EmptyMonitorCard(
                            icon: "link.badge.plus",
                            title: "Connect your monitor",
                            message: "Add the server URL in Settings."
                        )
                    } else if store.entries.isEmpty {
                        EmptyMonitorCard(
                            icon: store.preferences.feedMode == "watchlist" ? "star" : "scope",
                            title: store.preferences.feedMode == "watchlist" ? "No followed signals" : "No signals yet",
                            message: store.preferences.feedMode == "watchlist"
                                ? "Follow companies in Watchlist or switch this feed to All."
                                : "The server is watching for new biotech evidence."
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
            ToolbarItemGroup(placement: .topBarLeading) {
                Button {
                    Task { await store.refresh() }
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .accessibilityLabel("Refresh")

                Button {
                    Task { await store.runScan() }
                } label: {
                    if store.scanInProgress {
                        ProgressView().controlSize(.small)
                    } else {
                        Image(systemName: store.access.pro ? "dot.radiowaves.left.and.right" : "lock")
                    }
                }
                .disabled(store.scanInProgress || !store.settings.isComplete)
                .accessibilityLabel("Run scan")
            }
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button {
                    if !store.access.pro { store.showingPaywall = true }
                } label: {
                    Image(systemName: store.access.pro ? "checkmark.seal.fill" : "sparkles")
                }
                .disabled(store.access.pro)
                .accessibilityLabel(store.access.pro ? "Pro active" : "View Pro plans")
                ConnectionPill(state: store.connection)
            }
        }
    }
}

private struct FeedScopeBar: View {
    @EnvironmentObject private var store: MonitorStore

    var body: some View {
        HStack(spacing: 12) {
            Picker("Signal universe", selection: Binding(
                get: { store.preferences.feedMode },
                set: { mode in Task { await store.setFeedMode(mode) } }
            )) {
                Text("All").tag("all")
                Text("Following \(store.preferences.watchedTickers.count)").tag("watchlist")
            }
            .pickerStyle(.segmented)
            .disabled(store.preferenceUpdateInProgress)

            Text("\(store.entries.count)")
                .font(.system(.caption, design: .monospaced, weight: .bold))
                .foregroundStyle(.secondary)
                .frame(minWidth: 28, alignment: .trailing)
        }
        .padding(10)
        .background(Color.catalystPanel, in: RoundedRectangle(cornerRadius: 8))
    }
}

private struct FreePlanBar: View {
    @EnvironmentObject private var store: MonitorStore

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "clock.badge")
                .foregroundStyle(Color.catalystAmber)
            Text("Free · \(store.status?.configuration.freeFeedDelayMinutes ?? 30)-minute delay")
                .font(.caption.weight(.semibold))
            Spacer()
            Button("Upgrade") { store.showingPaywall = true }
                .font(.caption.bold())
        }
        .padding(.horizontal, 14)
        .frame(minHeight: 42)
        .background(Color.catalystPanel, in: RoundedRectangle(cornerRadius: 8))
    }
}

private struct ScanProgressCard: View {
    var body: some View {
        HStack(spacing: 12) {
            ProgressView().tint(Color.catalystGreen)
            VStack(alignment: .leading, spacing: 3) {
                Text("Scanning sources").font(.caption.bold())
                Text("The server is checking the configured news feeds now.").font(.caption2).foregroundStyle(.secondary)
            }
            Spacer()
        }
        .padding(14)
        .background(Color.catalystPanel, in: RoundedRectangle(cornerRadius: 8))
    }
}

private struct ScanSummaryCard: View {
    let summary: ScanResponse

    var body: some View {
        HStack(spacing: 14) {
            Metric(label: "Fetched", value: "\(summary.fetchedCount)")
            Metric(label: "New", value: "\(summary.insertedCount)")
            Metric(label: "Analyzed", value: "\(summary.analyzedCount)")
            Spacer()
            Text(summary.alreadyRunning ? "Running" : relativeDate(summary.finishedAt))
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
        .padding(14)
        .background(Color.catalystPanel, in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.white.opacity(0.07)))
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
        .background(Color.catalystAmber.opacity(0.07), in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.catalystAmber.opacity(0.18)))
    }
}

private struct SignalCard: View {
    let entry: FeedEntry

    var body: some View {
        let analysis = entry.analysis
        let assessment = analysis?.assessment
        VStack(alignment: .leading, spacing: 13) {
            HStack {
                Text(displayTicker(entry) ?? "—")
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
            if let movement = entry.marketMovement {
                MarketMovementLine(movement: movement)
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
        .background(Color.catalystPanel, in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.white.opacity(0.07)))
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
                    if let movement = entry.marketMovement {
                        MarketMovementDetail(movement: movement)
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
        .navigationTitle(displayTicker(entry) ?? "Signal")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
    }
}

private struct EmptyMonitorCard: View {
    let icon: String; let title: String; let message: String
    var body: some View {
        VStack(spacing: 13) {
            Image(systemName: icon).font(.system(size: 28)).foregroundStyle(Color.catalystGreen)
            Text(title).font(.headline)
            Text(message).font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity).padding(.vertical, 44).padding(.horizontal, 20)
        .background(Color.catalystPanel, in: RoundedRectangle(cornerRadius: 8))
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

private struct MarketMovementLine: View {
    let movement: StockMovement

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: movement.changePct >= 0 ? "arrow.up.right" : "arrow.down.right")
                .font(.caption.bold())
            Text("News-day move")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.secondary)
            Text(marketSigned(movement.changePct))
                .font(.system(.subheadline, design: .monospaced, weight: .bold))
            Spacer()
            Text("\(marketSessionDate(movement.sessionDate)) · \(movement.status.capitalized)")
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
        .foregroundStyle(movementColor(movement.changePct))
        .padding(.top, 2)
    }
}

private struct MarketMovementDetail: View {
    let movement: StockMovement

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text("NEWS-DAY MOVE")
                        .font(.caption2.bold())
                        .foregroundStyle(.secondary)
                    Text(marketSigned(movement.changePct))
                        .font(.system(.title2, design: .monospaced, weight: .bold))
                        .foregroundStyle(movementColor(movement.changePct))
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 4) {
                    Text(marketSessionDate(movement.sessionDate)).font(.caption.weight(.semibold))
                    Text(movement.status.capitalized).font(.caption2).foregroundStyle(.secondary)
                }
            }
            HStack(spacing: 10) {
                MarketPrice(label: "Prev close", value: movement.previousClose)
                MarketPrice(label: "Open", value: movement.open)
                MarketPrice(label: "High", value: movement.high)
                MarketPrice(label: "Low", value: movement.low)
                MarketPrice(label: movement.status == "live" ? "Last" : "Close", value: movement.close)
            }
            Text("Alpaca · \(movement.feed.uppercased()) · Change versus previous close")
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
        .padding(14)
        .background(Color.catalystPanel, in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.white.opacity(0.07)))
    }
}

private struct MarketPrice: View {
    let label: String
    let value: Double

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(marketPrice(value)).font(.caption.weight(.semibold)).lineLimit(1).minimumScaleFactor(0.75)
            Text(label).font(.system(size: 8)).foregroundStyle(.tertiary).textCase(.uppercase)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct DetailScore: View {
    let label: String; let value: String
    var body: some View { VStack(alignment: .leading, spacing: 5) { Text(label.uppercased()).font(.system(size: 8, weight: .bold)).tracking(1).foregroundStyle(.secondary); Text(value).font(.headline) }.frame(maxWidth: .infinity, alignment: .leading).padding(12).background(Color.catalystPanel, in: RoundedRectangle(cornerRadius: 8)) }
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
private func sourceIcon(_ type: String) -> String { switch type { case "regulator": "checkmark.seal"; case "sec": "building.columns"; case "clinical_trials": "cross.case"; case "x": "bubble.left"; case "reddit": "person.3"; default: "newspaper" } }
private func signed(_ value: Double) -> String { String(format: "%@%.0f%%", value > 0 ? "+" : "", value) }
private func marketSigned(_ value: Double) -> String { String(format: "%@%.1f%%", value > 0 ? "+" : "", value) }
private func marketPrice(_ value: Double) -> String { String(format: value < 1 ? "$%.4f" : "$%.2f", value) }
private func movementColor(_ value: Double) -> Color { value > 0 ? .catalystGreen : value < 0 ? .red : .secondary }
private func marketSessionDate(_ value: String) -> String {
    let formatter = DateFormatter()
    formatter.calendar = Calendar(identifier: .gregorian)
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.dateFormat = "yyyy-MM-dd"
    guard let date = formatter.date(from: value) else { return value }
    return date.formatted(.dateTime.month(.abbreviated).day())
}
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

private func displayTicker(_ entry: FeedEntry) -> String? {
    if let assessment = entry.analysis?.assessment {
        guard assessment.isBiotechCatalyst else { return nil }
        return assessment.ticker.nonEmpty ?? entry.item.tickerHint?.nonEmpty
    }
    return entry.item.tickerHint?.nonEmpty
}

extension Color {
    static let catalystBackground = Color(red: 0.027, green: 0.063, blue: 0.055)
    static let catalystPanel = Color(red: 0.063, green: 0.116, blue: 0.098)
    static let catalystGreen = Color(red: 0.41, green: 0.90, blue: 0.67)
    static let catalystAmber = Color(red: 0.95, green: 0.78, blue: 0.43)
}
