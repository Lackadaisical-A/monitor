import StoreKit
import SwiftUI

struct SubscriptionView: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var store: MonitorStore
    @State private var selectedProductId = MonitorStore.yearlyProductId

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    VStack(alignment: .leading, spacing: 8) {
                        Image(systemName: "bolt.badge.clock.fill")
                            .font(.system(size: 32))
                            .foregroundStyle(Color.catalystGreen)
                        Text("Catalyst Watch Pro")
                            .font(.title.bold())
                        Text("Immediate biotech catalyst intelligence on your iPhone.")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }

                    VStack(spacing: 0) {
                        comparisonRow("Signal feed", free: "30-min delay", pro: "Real time")
                        Divider()
                        comparisonRow("Watchlist", free: "10 companies", pro: "Full universe")
                        Divider()
                        comparisonRow("Alerts", free: "In-app", pro: "Time Sensitive")
                        Divider()
                        comparisonRow("Manual scan", free: "—", pro: "Included")
                    }
                    .background(Color.catalystPanel, in: RoundedRectangle(cornerRadius: 8))

                    if store.access.pro {
                        Label("Your Pro access is active", systemImage: "checkmark.seal.fill")
                            .font(.headline)
                            .foregroundStyle(Color.catalystGreen)
                    } else if store.screenshotMode {
                        screenshotPlans
                    } else if !store.productsLoaded {
                        HStack(spacing: 10) {
                            ProgressView()
                            Text("Loading App Store plans…").foregroundStyle(.secondary)
                        }
                    } else if store.products.isEmpty {
                        Label(
                            "App Store plans are temporarily unavailable.",
                            systemImage: "exclamationmark.triangle"
                        )
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    } else {
                        VStack(spacing: 10) {
                            ForEach(store.products, id: \.id) { product in
                                productButton(product)
                            }
                        }

                        Button {
                            guard let product = selectedProduct else { return }
                            Task { await store.purchase(product) }
                        } label: {
                            HStack {
                                if store.purchaseInProgress { ProgressView().tint(.black) }
                                Text(store.purchaseInProgress ? "Processing…" : "Continue")
                                Spacer()
                                if let selectedProduct { Text(selectedProduct.displayPrice) }
                            }
                            .font(.headline)
                            .foregroundStyle(.black)
                            .padding(.horizontal, 16)
                            .frame(maxWidth: .infinity, minHeight: 50)
                            .background(Color.catalystGreen, in: RoundedRectangle(cornerRadius: 8))
                        }
                        .disabled(store.purchaseInProgress || selectedProduct == nil)
                    }

                    if let message = store.purchaseMessage {
                        Text(message).font(.caption).foregroundStyle(.secondary)
                    }

                    VStack(spacing: 10) {
                        Button("Restore purchases") { Task { await store.restorePurchases() } }
                            .disabled(store.purchaseInProgress)
                        HStack(spacing: 14) {
                            Link("Terms", destination: URL(string: "https://www.apple.com/legal/internet-services/itunes/dev/stdeula/")!)
                            Link("Privacy", destination: URL(string: "https://lackadaisical-a.github.io/monitor/privacy.html")!)
                        }
                        .font(.caption)
                        Text("Subscriptions renew automatically unless canceled at least 24 hours before the current period ends. Manage or cancel in your App Store account.")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                            .multilineTextAlignment(.center)
                    }
                    .frame(maxWidth: .infinity)
                }
                .padding(20)
            }
            .background(Color.catalystBackground)
            .navigationTitle("Upgrade")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { dismiss() } label: { Image(systemName: "xmark") }
                        .accessibilityLabel("Close")
                }
            }
            .onAppear {
                if !store.products.contains(where: { $0.id == selectedProductId }) {
                    selectedProductId = store.products.first?.id ?? MonitorStore.yearlyProductId
                }
            }
            .onChange(of: store.access.pro) { _, active in
                if active { dismiss() }
            }
        }
    }

    private var selectedProduct: Product? {
        store.products.first { $0.id == selectedProductId }
    }

    @ViewBuilder
    private var screenshotPlans: some View {
        VStack(spacing: 10) {
            screenshotProductButton(
                id: MonitorStore.yearlyProductId,
                name: "Catalyst Watch Pro Annual",
                description: "Full watchlist, filtered alerts, real-time signals, and scans.",
                price: "$79.99"
            )
            screenshotProductButton(
                id: MonitorStore.monthlyProductId,
                name: "Catalyst Watch Pro Monthly",
                description: "Full watchlist, filtered alerts, real-time signals, and scans.",
                price: "$9.99"
            )
        }

        Button {
        } label: {
            HStack {
                Text("Continue")
                Spacer()
                Text(selectedProductId == MonitorStore.yearlyProductId ? "$79.99" : "$9.99")
            }
            .font(.headline)
            .foregroundStyle(.black)
            .padding(.horizontal, 16)
            .frame(maxWidth: .infinity, minHeight: 50)
            .background(Color.catalystGreen, in: RoundedRectangle(cornerRadius: 8))
        }
    }

    private func screenshotProductButton(
        id: String,
        name: String,
        description: String,
        price: String
    ) -> some View {
        Button {
            selectedProductId = id
        } label: {
            HStack(spacing: 12) {
                Image(systemName: selectedProductId == id ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(selectedProductId == id ? Color.catalystGreen : .secondary)
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        Text(name).font(.headline)
                        if id == MonitorStore.yearlyProductId {
                            Image(systemName: "star.fill").font(.caption).foregroundStyle(Color.catalystAmber)
                        }
                    }
                    Text(description).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                }
                Spacer()
                Text(price).font(.headline)
            }
            .padding(14)
            .frame(maxWidth: .infinity, minHeight: 70)
            .background(Color.catalystPanel, in: RoundedRectangle(cornerRadius: 8))
            .overlay(
                RoundedRectangle(cornerRadius: 8)
                    .stroke(selectedProductId == id ? Color.catalystGreen : Color.white.opacity(0.08), lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
    }

    private func productButton(_ product: Product) -> some View {
        Button {
            selectedProductId = product.id
        } label: {
            HStack(spacing: 12) {
                Image(systemName: selectedProductId == product.id ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(selectedProductId == product.id ? Color.catalystGreen : .secondary)
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        Text(product.displayName).font(.headline)
                        if product.id == MonitorStore.yearlyProductId {
                            Image(systemName: "star.fill").font(.caption).foregroundStyle(Color.catalystAmber)
                        }
                    }
                    Text(product.description).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                }
                Spacer()
                Text(product.displayPrice).font(.headline)
            }
            .padding(14)
            .frame(maxWidth: .infinity, minHeight: 70)
            .background(Color.catalystPanel, in: RoundedRectangle(cornerRadius: 8))
            .overlay(
                RoundedRectangle(cornerRadius: 8)
                    .stroke(selectedProductId == product.id ? Color.catalystGreen : Color.white.opacity(0.08), lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
    }

    private func comparisonRow(_ label: String, free: String, pro: String) -> some View {
        HStack(spacing: 8) {
            Text(label).frame(maxWidth: .infinity, alignment: .leading)
            Text(free).foregroundStyle(.secondary).frame(width: 92, alignment: .leading)
            Text(pro).foregroundStyle(Color.catalystGreen).frame(width: 100, alignment: .leading)
        }
        .font(.subheadline)
        .padding(.horizontal, 14)
        .frame(minHeight: 48)
    }
}
