import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import { SignalDatabase } from "../src/db.js";
import type { MarketDataProvider } from "../src/market-data/alpaca.js";
import type { MonitorPipeline } from "../src/pipeline.js";
import type { SubscriptionVerifier } from "../src/subscriptions.js";
import { timelineEventsFromAnalysis } from "../src/timeline.js";
import type { ImpactAssessment, NormalizedItem } from "../src/types.js";

const installationId = "9c62cb51-26e7-48f3-a68b-f2e38ff8ab7a";
const clientToken = "a".repeat(64);
let db: SignalDatabase | null = null;

afterEach(() => {
  db?.close();
  db = null;
});

describe("HTTP app", () => {
  it("serves the catalyst timeline with completed-event calibration metadata", async () => {
    db = new SignalDatabase(":memory:");
    const timelineItem = { ...item("timeline-event", Date.now() - 60 * 60_000), tickerHint: "MRNA", companyHint: "Moderna" };
    const timelineAnalysis = {
      ...analysis(timelineItem.id, { resultDirection: "positive" }, "high"),
      eventKey: "MRNA:timeline-event",
      eventAnchorAt: timelineItem.publishedAt,
      analysisVersion: 2,
    };
    db.insertItem(timelineItem);
    db.saveAnalysis(timelineAnalysis);
    db.upsertTimelineEvents(timelineEventsFromAnalysis(timelineItem, timelineAnalysis));
    const newItem = { ...item("new-guidance", Date.now() - 5 * 60_000), tickerHint: "MRNA", companyHint: "Moderna" };
    const newAnalysis = {
      ...analysis(newItem.id, {
        futureMilestones: [{
          title: "Phase 3 readout",
          eventType: "trial_topline",
          program: "mRNA-1234",
          indication: "Cancer",
          expectedDate: "2027-03-31",
          datePrecision: "quarter" as const,
          dateLabel: "Q1 2027",
          expectedDirection: "positive" as const,
          expectedOutcome: "The primary endpoint is expected to be met.",
          anticipatedMateriality: 90,
          expectedSuccessProbability: 0.65,
          expectationConfidence: 0.6,
          sourceEvidence: "The company guided to Q1 2027.",
        }],
      }, "watch"),
      eventKey: "MRNA:new-guidance",
      eventAnchorAt: newItem.publishedAt,
      analysisVersion: 2,
    };
    db.insertItem(newItem);
    db.saveAnalysis(newAnalysis);
    db.upsertTimelineEvents(timelineEventsFromAnalysis(newItem, newAnalysis));
    const pipeline = { run: async () => scanSummary() } as unknown as MonitorPipeline;
    const app = await createApp(config(), db, pipeline, verifier());
    await bootstrap(app);

    const response = await app.inject({ method: "GET", url: "/api/timeline", headers: clientHeaders() });

    expect(response.statusCode).toBe(200);
    expect(response.json().events).toHaveLength(1);
    expect(response.json()).toMatchObject({
      summary: { completedCount: 1, upcomingCount: 0 },
      delayedByMinutes: 30,
      events: [{
        ticker: "MRNA",
        eventKey: "MRNA:timeline-event",
        initialMateriality: 60,
        outcome: null,
      }],
    });
    await app.close();
  });

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
    const preferences = await app.inject({ method: "GET", url: "/api/preferences", headers: clientHeaders() });
    const scan = await app.inject({ method: "POST", url: "/api/scan", headers: clientHeaders() });

    expect(activation.statusCode).toBe(200);
    expect(activation.json().access).toMatchObject({ level: "developer", pro: true, source: "developer" });
    expect(preferences.json().preferences.minimumAlertTier).toBe("high");
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

  it("keeps default sounds for legacy clients and accepts bundled-sound capability", async () => {
    db = new SignalDatabase(":memory:");
    const pipeline = { run: async () => scanSummary() } as unknown as MonitorPipeline;
    const app = await createApp(config(), db, pipeline, verifier());
    await bootstrap(app);
    const registration = {
      installationId,
      deviceToken: "a".repeat(64),
      environment: "sandbox",
      timeSensitiveAuthorized: true,
      criticalAuthorized: false,
    };

    const legacy = await app.inject({
      method: "POST",
      url: "/api/devices",
      headers: clientHeaders(),
      payload: registration,
    });
    expect(legacy.statusCode).toBe(201);
    expect(db.listDevices()[0]?.attentionSoundsSupported).toBe(false);

    const capable = await app.inject({
      method: "POST",
      url: "/api/devices",
      headers: clientHeaders(),
      payload: { ...registration, attentionSoundsSupported: true },
    });
    expect(capable.statusCode).toBe(201);
    expect(capable.json().attentionSoundsAccepted).toBe(true);
    expect(db.listDevices()[0]?.attentionSoundsSupported).toBe(true);
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

  it("lets only the private dashboard requeue a bounded number of failed items", async () => {
    db = new SignalDatabase(":memory:");
    db.insertItem(item("failed", Date.now()));
    for (let attempt = 0; attempt < 4; attempt += 1) db.recordItemFailure("failed", "quota exhausted");
    const pipeline = { run: async () => scanSummary() } as unknown as MonitorPipeline;
    const app = await createApp(config(), db, pipeline, verifier());

    const unauthorized = await app.inject({
      method: "POST",
      url: "/api/admin/requeue-failed",
      payload: { limit: 1 },
    });
    const authorized = await app.inject({
      method: "POST",
      url: "/api/admin/requeue-failed",
      headers: { authorization: "Bearer dash-token" },
      payload: { limit: 1 },
    });

    expect(unauthorized.statusCode).toBe(401);
    expect(authorized.statusCode).toBe(200);
    expect(authorized.json()).toMatchObject({
      requeuedCount: 1,
      stats: { pending_count: 1, error_count: 0 },
    });
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

  it("adds configured announcement-window movement to feed entries without exposing credentials", async () => {
    db = new SignalDatabase(":memory:");
    db.insertItem({ ...item("market-move", Date.now() - 60 * 60_000), tickerHint: "MRNA" });
    db.saveAnalysis(analysis("market-move"));
    const pipeline = { run: async () => scanSummary() } as unknown as MonitorPipeline;
    const appConfig = config();
    appConfig.alpaca.scope = "all";
    const marketData: MarketDataProvider = {
      configured: true,
      feed: "iex",
      getMovements: async () => new Map([["market-move", {
        ticker: "MRNA",
        sessionDate: "2026-08-24",
        status: "closed",
        announcementAt: "2026-08-24T12:00:00Z",
        priceStartAt: "2026-08-24T12:01:00Z",
        priceEndAt: "2026-08-28T19:59:00Z",
        cutoffAt: "2026-08-29T12:00:00Z",
        window: "five_day",
        refreshIntervalSeconds: 300,
        previousClose: 30,
        open: 30,
        high: 29,
        low: 22,
        close: 23.1,
        change: -6.9,
        changePct: -23,
        fetchedAt: new Date().toISOString(),
        feed: "iex",
        provider: "alpaca",
        basis: "pre_announcement_price",
      }]]),
    };
    const app = await createApp(appConfig, db, pipeline, verifier(), marketData);
    await bootstrap(app);

    const feed = await app.inject({ method: "GET", url: "/api/feed", headers: clientHeaders() });

    expect(feed.statusCode).toBe(200);
    expect(feed.json().entries[0].marketMovement).toMatchObject({
      ticker: "MRNA",
      sessionDate: "2026-08-24",
      changePct: -23,
      basis: "pre_announcement_price",
    });
    expect(JSON.stringify(feed.json())).not.toMatch(/secret|api.?key/i);
    await app.close();
  });

  it("does not attach stock movement to an analyzed non-catalyst", async () => {
    db = new SignalDatabase(":memory:");
    db.insertItem({
      ...item("stat-roundup", Date.now() - 60 * 60_000),
      headline: "Lady Gaga and her fiance launch a biotech startup",
      summary: "A newsletter roundup also mentions Moderna.",
      companyHint: "Moderna",
      tickerHint: "MRNA",
    });
    db.saveAnalysis(analysis("stat-roundup", {
      isBiotechCatalyst: false,
      materiality: 0,
      stockDirection: "neutral",
      rationale: "The headline is unrelated to Moderna.",
    }, "none"));
    const pipeline = { run: async () => scanSummary() } as unknown as MonitorPipeline;
    const appConfig = config();
    appConfig.alpaca.scope = "all";
    let marketDataCalls = 0;
    const marketData: MarketDataProvider = {
      configured: true,
      feed: "iex",
      getMovements: async () => {
        marketDataCalls += 1;
        return new Map();
      },
    };
    const app = await createApp(appConfig, db, pipeline, verifier(), marketData);
    await bootstrap(app);

    const feed = await app.inject({ method: "GET", url: "/api/feed", headers: clientHeaders() });

    expect(feed.statusCode).toBe(200);
    expect(feed.json().entries[0]).toMatchObject({
      item: { id: "stat-roundup", companyHint: null, tickerHint: null },
      analysis: { assessment: { isBiotechCatalyst: false, companyName: "", ticker: "" } },
      marketMovement: null,
    });
    expect(marketDataCalls).toBe(0);
    await app.close();
  });

  it("keeps developer-scoped market data out of public feeds", async () => {
    db = new SignalDatabase(":memory:");
    db.insertItem({ ...item("private-market-move", Date.now() - 60 * 60_000), tickerHint: "MRNA" });
    const pipeline = { run: async () => scanSummary() } as unknown as MonitorPipeline;
    const appConfig = config();
    appConfig.alpaca.scope = "developer";
    let marketDataCalls = 0;
    const marketData: MarketDataProvider = {
      configured: true,
      feed: "iex",
      getMovements: async () => {
        marketDataCalls += 1;
        return new Map();
      },
    };
    const app = await createApp(appConfig, db, pipeline, verifier(), marketData);
    await bootstrap(app);

    const feed = await app.inject({ method: "GET", url: "/api/feed", headers: clientHeaders() });

    expect(feed.statusCode).toBe(200);
    expect(feed.json().entries[0].marketMovement).toBeNull();
    expect(marketDataCalls).toBe(0);
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
    alpaca: { scope: "disabled", keyId: "", secretKey: "", feed: "iex", newsEnabled: true },
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
    alertPolicy: {
      dryRun: true,
      highMinMateriality: 70,
      highMinConfidence: 0.8,
      minMateriality: 88,
      minConfidence: 0.86,
      cooldownMinutes: 240,
      maxAgeMinutes: 30,
    },
    analysis: { concurrency: 4, batchSize: 100, historyDays: 180 },
    slo: { discoverySeconds: 120, analysisSeconds: 45, pushSeconds: 180 },
    outcomes: { intervalMinutes: 15, batchSize: 30 },
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

function analysis(
  itemId: string,
  overrides: Partial<ImpactAssessment> = {},
  alertTier: "none" | "watch" | "high" | "urgent" = "watch",
) {
  return {
    itemId,
    model: "test-model",
    method: "openai" as const,
    assessment: {
      isBiotechCatalyst: true,
      companyName: "Moderna",
      ticker: "MRNA",
      eventType: "trial_update" as const,
      trialPhase: "unknown" as const,
      trialName: "",
      indication: "",
      resultDirection: "unclear" as const,
      stockDirection: "unclear" as const,
      materiality: 60,
      confidence: 0.9,
      probabilityPositiveMove: 0.5,
      expectedMoveLowPct: -5,
      expectedMoveBasePct: 0,
      expectedMoveHighPct: 5,
      timeHorizon: "intraday" as const,
      primaryEndpointMet: "not_reported" as const,
      statisticalStrength: "not_reported" as const,
      safetyAssessment: "not_reported" as const,
      noveltyVsPriorDisclosure: "new" as const,
      rationale: "Test catalyst",
      evidence: [],
      uncertainty: [],
      disconfirmingEvidence: [],
      requiresHumanReview: false,
      ...overrides,
    },
    policyScore: 60,
    alertTier,
    policyReasons: [],
    createdAt: new Date().toISOString(),
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
