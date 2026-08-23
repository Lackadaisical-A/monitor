import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import { SignalDatabase } from "../src/db.js";
import type { MonitorPipeline } from "../src/pipeline.js";
import type { SubscriptionVerifier } from "../src/subscriptions.js";
import type { NormalizedItem } from "../src/types.js";

const installationId = "9c62cb51-26e7-48f3-a68b-f2e38ff8ab7a";
const clientToken = "a".repeat(64);
let db: SignalDatabase | null = null;

afterEach(() => {
  db?.close();
  db = null;
});

describe("HTTP app", () => {
  it("gives free installations a delayed feed and blocks manual scans", async () => {
    db = new SignalDatabase(":memory:");
    db.insertItem(item("old", Date.now() - 60 * 60_000));
    db.insertItem(item("new", Date.now() - 5 * 60_000));
    let runCount = 0;
    const pipeline = { run: async () => { runCount += 1; return scanSummary(); } } as unknown as MonitorPipeline;
    const app = await createApp(config(), db, pipeline, verifier());
    await bootstrap(app);

    const feed = await app.inject({ method: "GET", url: "/api/feed", headers: clientHeaders() });
    const scan = await app.inject({ method: "POST", url: "/api/scan", headers: clientHeaders() });

    expect(feed.statusCode).toBe(200);
    expect(feed.json().entries.map((entry: { item: { id: string } }) => entry.item.id)).toEqual(["old"]);
    expect(feed.json().delayedByMinutes).toBe(30);
    expect(scan.statusCode).toBe(403);
    expect(runCount).toBe(0);
    await app.close();
  });

  it("grants developer access with the separate credential", async () => {
    db = new SignalDatabase(":memory:");
    let runCount = 0;
    const pipeline = { run: async () => { runCount += 1; return scanSummary(); } } as unknown as MonitorPipeline;
    const app = await createApp(config(), db, pipeline, verifier());
    await bootstrap(app);

    const activation = await app.inject({
      method: "POST",
      url: "/api/entitlements/developer",
      headers: clientHeaders(),
      payload: { credential: "developer-token-that-is-long-and-private" },
    });
    const scan = await app.inject({ method: "POST", url: "/api/scan", headers: clientHeaders() });

    expect(activation.statusCode).toBe(200);
    expect(activation.json().access).toMatchObject({ level: "developer", pro: true, source: "developer" });
    expect(scan.statusCode).toBe(200);
    expect(runCount).toBe(1);
    await app.close();
  });

  it("grants Pro after a server-verified StoreKit transaction", async () => {
    db = new SignalDatabase(":memory:");
    const pipeline = { run: async () => scanSummary() } as unknown as MonitorPipeline;
    const app = await createApp(config(), db, pipeline, verifier());
    await bootstrap(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/entitlements/storekit",
      headers: clientHeaders(),
      payload: { signedTransaction: "signed." + "x".repeat(120) },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().access).toMatchObject({ level: "pro", pro: true, source: "app_store" });
    expect(db.listAlertDevices()).toHaveLength(0);
    await app.close();
  });

  it("rejects requests with the wrong installation credential", async () => {
    db = new SignalDatabase(":memory:");
    const pipeline = { run: async () => scanSummary() } as unknown as MonitorPipeline;
    const app = await createApp(config(), db, pipeline, verifier());
    await bootstrap(app);

    const response = await app.inject({
      method: "GET",
      url: "/api/feed",
      headers: { ...clientHeaders(), "x-client-token": "b".repeat(64) },
    });

    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("allows the private dashboard to run a scan", async () => {
    db = new SignalDatabase(":memory:");
    let runCount = 0;
    const pipeline = { run: async () => { runCount += 1; return scanSummary(); } } as unknown as MonitorPipeline;
    const app = await createApp(config(), db, pipeline, verifier());

    const response = await app.inject({
      method: "POST",
      url: "/api/scan",
      headers: { authorization: "Bearer dash-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(runCount).toBe(1);
    await app.close();
  });

  it("persists a personal watchlist and filters the installation feed", async () => {
    db = new SignalDatabase(":memory:");
    db.insertItem({ ...item("moderna", Date.now() - 60 * 60_000), tickerHint: "MRNA", companyHint: "Moderna" });
    db.insertItem({ ...item("vertex", Date.now() - 60 * 60_000), tickerHint: "VRTX", companyHint: "Vertex Pharmaceuticals" });
    const pipeline = { run: async () => scanSummary() } as unknown as MonitorPipeline;
    const app = await createApp(config(), db, pipeline, verifier());
    await bootstrap(app);

    const update = await app.inject({
      method: "PUT",
      url: "/api/preferences",
      headers: clientHeaders(),
      payload: {
        watchedTickers: ["MRNA"],
        feedMode: "watchlist",
        pushMode: "watchlist",
        eventTypes: ["trial_topline", "regulatory_decision"],
      },
    });
    const feed = await app.inject({ method: "GET", url: "/api/feed?scope=watchlist", headers: clientHeaders() });
    const watchlist = await app.inject({ method: "GET", url: "/api/watchlist", headers: clientHeaders() });

    expect(update.statusCode).toBe(200);
    expect(update.json().preferences.watchedTickers).toEqual(["MRNA"]);
    expect(feed.json().entries.map((entry: { item: { tickerHint: string } }) => entry.item.tickerHint)).toEqual(["MRNA"]);
    expect(watchlist.json().companies.find((company: { ticker: string }) => company.ticker === "MRNA"))
      .toMatchObject({ followed: true, coverage: { sec: false, clinicalTrials: false } });
    await app.close();
  });
});

function config(): AppConfig {
  return {
    port: 8787,
    host: "127.0.0.1",
    databasePath: ":memory:",
    scanIntervalSeconds: 120,
    sourceTimeoutMs: 15_000,
    logLevel: "silent",
    dashboardToken: "dash-token",
    devicePairingToken: "",
    entitlements: {
      developerPairingToken: "developer-token-that-is-long-and-private",
      freeFeedDelayMinutes: 30,
      bundleId: "com.yingcui.CatalystWatch",
      appAppleId: 6803988538,
      productIds: [
        "com.yingcui.CatalystWatch.pro.monthly",
        "com.yingcui.CatalystWatch.pro.yearly",
      ],
      appleRootCaDirectory: resolve("config/apple"),
    },
    openaiApiKey: "",
    openaiModel: "test-model",
    watchlist: [
      {
        ticker: "MRNA", company: "Moderna", aliases: ["Moderna, Inc."], cik: "0001682852",
        marketCapBand: "large", xAccounts: [], programs: ["mRNA-4157"],
      },
      {
        ticker: "VRTX", company: "Vertex Pharmaceuticals", aliases: ["Vertex"], cik: "0000875320",
        marketCapBand: "large", xAccounts: [], programs: ["CASGEVY"],
      },
    ],
    rssSources: [],
    quoteMediaSources: [],
    x: { bearerToken: "", query: "" },
    reddit: { clientId: "", clientSecret: "", userAgent: "", subreddits: "" },
    clinicalTrialsEnabled: false,
    secEnabled: false,
    fdaAdcomEnabled: false,
    secUserAgent: "",
    alertPolicy: { dryRun: true, minMateriality: 88, minConfidence: 0.86, cooldownMinutes: 240 },
    apns: {
      teamId: "",
      keyId: "",
      bundleId: "com.yingcui.CatalystWatch",
      privateKey: "",
      privateKeyPath: "",
      environment: "sandbox",
      allowCritical: false,
    },
  };
}

function verifier(): SubscriptionVerifier {
  return {
    verifyTransaction: async (_signedTransaction, verifiedInstallationId) => ({
      ...(verifiedInstallationId ? { installationId: verifiedInstallationId } : {}),
      productId: "com.yingcui.CatalystWatch.pro.monthly",
      originalTransactionId: "original-1",
      transactionId: "transaction-1",
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60_000).toISOString(),
      environment: "Sandbox",
      revoked: false,
    }),
    verifyNotification: async () => ({ notificationType: "DID_RENEW", transaction: null }),
  };
}

async function bootstrap(app: Awaited<ReturnType<typeof createApp>>) {
  const response = await app.inject({
    method: "POST",
    url: "/api/installations",
    payload: { installationId, clientToken },
  });
  expect(response.statusCode).toBe(201);
}

function clientHeaders() {
  return { "x-installation-id": installationId, "x-client-token": clientToken };
}

function item(id: string, publishedAt: number): NormalizedItem {
  const timestamp = new Date(publishedAt).toISOString();
  return {
    id,
    externalId: id,
    source: { id: "feed", name: "Feed", type: "outlet", tier: "secondary" },
    headline: `Signal ${id}`,
    summary: "Summary",
    url: `https://example.test/${id}`,
    author: null,
    publishedAt: timestamp,
    discoveredAt: timestamp,
    companyHint: null,
    tickerHint: null,
    raw: {},
  };
}

function scanSummary() {
  const now = new Date().toISOString();
  return {
    startedAt: now,
    finishedAt: now,
    sourceCount: 0,
    fetchedCount: 0,
    insertedCount: 0,
    analyzedCount: 0,
    skippedCount: 0,
    errorCount: 0,
    urgentCount: 0,
    alreadyRunning: false,
  };
}
