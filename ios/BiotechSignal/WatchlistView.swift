import SwiftUI

struct WatchlistView: View {
    @EnvironmentObject private var store: MonitorStore
    @State private var searchText = ""
    @State private var scope = WatchlistScope.all

    var body: some View {
        ZStack {
            Color.catalystBackground.ignoresSafeArea()
            List {
                Section {
                    watchlistSummary
                    Picker("Companies", selection: $scope) {
                        ForEach(WatchlistScope.allCases) { option in
                            Text(option.label).tag(option)
                        }
                    }
                    .pickerStyle(.segmented)
                }

                if filteredCompanies.isEmpty {
                    ContentUnavailableView(
                        searchText.isEmpty ? "No followed companies" : "No matching companies",
                        systemImage: searchText.isEmpty ? "star" : "magnifyingglass",
                        description: Text(searchText.isEmpty
                            ? "Select All and follow companies to build your monitor."
                            : "Try a different ticker, company, alias, or program.")
                    )
                    .listRowBackground(Color.clear)
                } else {
                    Section("Monitored universe") {
                        ForEach(filteredCompanies) { company in
                            CompanyWatchRow(company: company)
                        }
                    }
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .refreshable { await store.refresh() }
        }
        .navigationTitle("Watchlist")
        .searchable(text: $searchText, prompt: "Ticker, company, program")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    Task { await store.refresh() }
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .accessibilityLabel("Refresh watchlist")
            }
        }
    }

    private var watchlistSummary: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack {
                Label("\(store.preferences.watchedTickers.count) followed", systemImage: "star.fill")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Color.catalystAmber)
                Spacer()
                Text("\(store.watchlistLimit) available")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            ProgressView(
                value: Double(min(store.preferences.watchedTickers.count, store.watchlistLimit)),
                total: Double(max(store.watchlistLimit, 1))
            )
            .tint(Color.catalystGreen)
            if !store.access.pro {
                Button("Unlock the full universe") { store.showingPaywall = true }
                    .font(.caption.weight(.semibold))
            }
        }
        .padding(.vertical, 5)
    }

    private var filteredCompanies: [WatchCompany] {
        let followed = Set(store.preferences.watchedTickers)
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return store.watchlist.enumerated()
            .filter { _, company in
                if scope == .following && !followed.contains(company.ticker) { return false }
                guard !query.isEmpty else { return true }
                return ([company.ticker, company.company] + company.aliases + company.programs)
                    .joined(separator: " ")
                    .lowercased()
                    .contains(query)
            }
            .sorted { left, right in
                let leftFollowed = followed.contains(left.element.ticker)
                let rightFollowed = followed.contains(right.element.ticker)
                if leftFollowed != rightFollowed { return leftFollowed }
                return left.offset < right.offset
            }
            .map(\.element)
    }
}

private struct CompanyWatchRow: View {
    @EnvironmentObject private var store: MonitorStore
    let company: WatchCompany

    private var followed: Bool {
        store.preferences.watchedTickers.contains(company.ticker)
    }

    var body: some View {
        HStack(spacing: 12) {
            Button {
                Task { await store.toggleFollow(company.ticker) }
            } label: {
                Image(systemName: followed ? "star.fill" : "star")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(followed ? Color.catalystAmber : Color.secondary)
                    .frame(width: 34, height: 40)
            }
            .buttonStyle(.borderless)
            .disabled(store.preferenceUpdateInProgress)
            .accessibilityLabel(followed ? "Unfollow \(company.ticker)" : "Follow \(company.ticker)")

            VStack(alignment: .leading, spacing: 5) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(company.ticker)
                        .font(.system(.subheadline, design: .monospaced, weight: .bold))
                        .foregroundStyle(Color.catalystGreen)
                    Text(company.company)
                        .font(.subheadline.weight(.semibold))
                        .lineLimit(1)
                    Spacer(minLength: 4)
                    Text(company.marketCapBand.uppercased())
                        .font(.system(size: 8, weight: .bold))
                        .foregroundStyle(.secondary)
                }
                HStack(spacing: 7) {
                    CoverageLevel(level: company.coverage.level)
                    Text(company.coverage.labels.joined(separator: " · "))
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                if let program = company.programs.first {
                    Text(program)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                }
            }
            .padding(.vertical, 5)
        }
        .listRowBackground(Color.catalystPanel.opacity(0.45))
    }
}

private struct CoverageLevel: View {
    let level: String

    var body: some View {
        Text(level.uppercased())
            .font(.system(size: 8, weight: .bold))
            .foregroundStyle(color)
            .padding(.horizontal, 5)
            .padding(.vertical, 2)
            .overlay(RoundedRectangle(cornerRadius: 4).stroke(color.opacity(0.45)))
    }

    private var color: Color {
        switch level {
        case "complete": .catalystGreen
        case "strong": .cyan
        default: .secondary
        }
    }
}

private enum WatchlistScope: String, CaseIterable, Identifiable {
    case all
    case following

    var id: String { rawValue }
    var label: String { self == .all ? "All" : "Following" }
}
