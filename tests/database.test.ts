import { afterEach, describe, expect, it } from "vitest";
import { SignalDatabase } from "../src/db.js";
import type { ImpactAssessment, NormalizedItem } from "../src/types.js";

let db: SignalDatabase | null = null;
afterEach(() => { db?.close(); db = null; });

describe("SignalDatabase", () => {
  it("deduplicates a source item and returns it in the feed", () => {
    db = new SignalDatabase(":memory:");
    const item: NormalizedItem = {
      id: "one", externalId: "ext-one",
      source: { id: "feed", name: "Feed", type: "outlet", tier: "secondary" },
      headline: "Trial result", summary: "Summary", url: "https://example.test/one", author: null,
      publishedAt: new Date().toISOString(), discoveredAt: new Date().toISOString(),
      companyHint: null, tickerHint: null, raw: {},
    };
    expect(db.insertItem(item)).toBe(true);
    expect(db.insertItem(item)).toBe(false);
    expect(db.listFeed()).toHaveLength(1);
    expect(db.getPendingItems()).toHaveLength(1);
  });

  it("includes the analyzed item ID in feed responses", () => {
    db = new SignalDatabase(":memory:");
    const item: NormalizedItem = {
      id: "analyzed-one", externalId: "ext-analyzed-one",
      source: { id: "ir", name: "Company IR", type: "company_ir", tier: "primary" },
      headline: "Phase 3 endpoint met", summary: "Summary", url: "https://example.test/analyzed", author: null,
      publishedAt: new Date().toISOString(), discoveredAt: new Date().toISOString(),
      companyHint: "Example Bio", tickerHint: "EXBI", raw: {},
    };
    db.insertItem(item);
    db.saveAnalysis({
      itemId: item.id,
      model: "test-model",
      method: "openai",
      assessment: {} as ImpactAssessment,
      policyScore: 90,
      alertTier: "urgent",
      policyReasons: ["test"],
      createdAt: new Date().toISOString(),
    });
    db.insertItem({
      ...item,
      id: "newer-routine",
      externalId: "ext-newer-routine",
      headline: "Routine registry update",
      publishedAt: new Date(Date.now() + 60_000).toISOString(),
    });

    expect(db.listFeed()[0]?.analysis?.itemId).toBe(item.id);
  });

  it("collapses equivalent cross-source headlines and keeps the urgent item", () => {
    db = new SignalDatabase(":memory:");
    const publishedAt = new Date().toISOString();
    const base: NormalizedItem = {
      id: "wire-copy", externalId: "wire-copy",
      source: { id: "wire", name: "Wire", type: "outlet", tier: "secondary" },
      headline: "Example Bio Phase 3 endpoint met", summary: "Summary", url: "https://example.test/wire", author: null,
      publishedAt, discoveredAt: publishedAt,
      companyHint: "Example Bio", tickerHint: "EXBI", raw: {},
    };
    const primary: NormalizedItem = {
      ...base,
      id: "primary-copy",
      externalId: "primary-copy",
      source: { id: "ir", name: "Company IR", type: "company_ir", tier: "primary" },
      headline: "Example Bio: Phase 3 endpoint met!",
      url: "https://example.test/primary",
    };
    db.insertItem(base);
    db.insertItem(primary);
    db.saveAnalysis({
      itemId: primary.id,
      model: "test-model",
      method: "openai",
      assessment: {} as ImpactAssessment,
      policyScore: 92,
      alertTier: "urgent",
      policyReasons: ["test"],
      createdAt: publishedAt,
    });

    const feed = db.listFeed();
    expect(feed).toHaveLength(1);
    expect(feed[0]?.item.id).toBe(primary.id);
  });

  it("only returns APNs devices with active Pro or developer access", () => {
    db = new SignalDatabase(":memory:");
    const freeId = "0e2d25f4-9c6d-4303-a39f-e90db6a47fa1";
    const proId = "f4d6cddf-2353-4f0c-a0b4-2586ea5d4404";
    const developerId = "bd9f36bc-42fc-4b7d-b0ba-528102defbce";
    for (const id of [freeId, proId, developerId]) {
      db.registerInstallation(id, `hash-${id}`);
      db.upsertDevice({
        installationId: id,
        deviceToken: id.replaceAll("-", "").padEnd(64, "0"),
        environment: "sandbox",
        timeSensitiveAuthorized: true,
        criticalAuthorized: false,
      });
    }
    db.applyStoreTransaction({
      installationId: proId,
      productId: "com.yingcui.CatalystWatch.pro.monthly",
      originalTransactionId: "original-pro",
      transactionId: "transaction-pro",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      environment: "Sandbox",
      revoked: false,
    });
    db.activateDeveloperAccess(developerId);

    expect(db.listDevices()).toHaveLength(3);
    expect(db.listAlertDevices().map((device) => device.installationId).sort()).toEqual([developerId, proId].sort());
    expect(db.listAlertDevices("MRNA", "regulatory_update", "high").map((device) => device.installationId))
      .toEqual([developerId]);
    db.updateInstallationPreferences({
      installationId: proId,
      watchedTickers: [],
      feedMode: "all",
      pushMode: "all",
      minimumAlertTier: "high",
      eventTypes: ["regulatory_update"],
    });
    expect(db.listAlertDevices("MRNA", "regulatory_update", "high").map((device) => device.installationId).sort())
      .toEqual([developerId, proId].sort());
  });

  it("moves an APNs token to the current installation", () => {
    db = new SignalDatabase(":memory:");
    const oldId = "0e2d25f4-9c6d-4303-a39f-e90db6a47fa1";
    const currentId = "f4d6cddf-2353-4f0c-a0b4-2586ea5d4404";
    const deviceToken = "a".repeat(64);
    db.registerInstallation(oldId, "old-token-hash");
    db.registerInstallation(currentId, "current-token-hash");

    db.upsertDevice({
      installationId: oldId,
      deviceToken,
      environment: "sandbox",
      timeSensitiveAuthorized: true,
      criticalAuthorized: false,
    });
    db.upsertDevice({
      installationId: currentId,
      deviceToken,
      environment: "sandbox",
      timeSensitiveAuthorized: true,
      criticalAuthorized: false,
    });

    expect(db.listDevices()).toMatchObject([{ installationId: currentId, deviceToken }]);
  });

  it("persists learned program aliases without case-variant duplicates", () => {
    db = new SignalDatabase(":memory:");
    db.saveCompanyPrograms("avxl", ["ANAVEX2-73", "blarcamesine", "Blarcamesine"]);

    expect(db.listCompanyPrograms()).toEqual([
      { ticker: "AVXL", program: "ANAVEX2-73" },
      { ticker: "AVXL", program: "blarcamesine" },
    ]);
  });

  it("stores an installation watchlist and filters its feed", () => {
    db = new SignalDatabase(":memory:");
    const id = "f4d6cddf-2353-4f0c-a0b4-2586ea5d4404";
    db.registerInstallation(id, "client-token-hash");
    db.insertItem({
      ...signalItem("moderna", "MRNA"),
      publishedAt: new Date(Date.now() - 1_000).toISOString(),
    });
    db.insertItem({
      ...signalItem("vertex", "VRTX"),
      publishedAt: new Date().toISOString(),
    });
    db.insertItem({
      ...signalItem("stat-roundup", "MRNA"),
      headline: "Lady Gaga and her fiance launch a biotech startup",
      summary: "A newsletter roundup also mentions Moderna.",
      publishedAt: new Date(Date.now() + 1_000).toISOString(),
    });
    db.saveAnalysis({
      itemId: "stat-roundup",
      model: "test-model",
      method: "openai",
      assessment: assessment({ isBiotechCatalyst: false, materiality: 0 }),
      policyScore: 0,
      alertTier: "none",
      policyReasons: ["not classified as a biotech catalyst"],
      createdAt: new Date().toISOString(),
    });

    const preferences = db.updateInstallationPreferences({
      installationId: id,
      watchedTickers: ["MRNA"],
      feedMode: "watchlist",
      pushMode: "watchlist",
      eventTypes: ["trial_topline", "regulatory_decision"],
    });

    expect(preferences).toMatchObject({
      watchedTickers: ["MRNA"],
      feedMode: "watchlist",
      pushMode: "watchlist",
      eventTypes: ["trial_topline", "regulatory_decision"],
    });
    expect(db.listFeed(100, null, preferences.watchedTickers).map((entry) => entry.item.id)).toEqual(["moderna"]);
  });

  it("routes alerts by ticker and catalyst preference", () => {
    db = new SignalDatabase(":memory:");
    const modernaId = "f4d6cddf-2353-4f0c-a0b4-2586ea5d4404";
    const allId = "bd9f36bc-42fc-4b7d-b0ba-528102defbce";
    for (const id of [modernaId, allId]) {
      db.registerInstallation(id, `hash-${id}`);
      db.activateDeveloperAccess(id);
      db.upsertDevice({
        installationId: id,
        deviceToken: id.replaceAll("-", "").padEnd(64, "0"),
        environment: "sandbox",
        timeSensitiveAuthorized: true,
        criticalAuthorized: false,
      });
    }
    db.updateInstallationPreferences({
      installationId: modernaId,
      watchedTickers: ["MRNA"],
      feedMode: "watchlist",
      pushMode: "watchlist",
      eventTypes: ["regulatory_decision"],
    });

    expect(db.listAlertDevices("MRNA", "regulatory_decision").map((device) => device.installationId).sort())
      .toEqual([allId, modernaId].sort());
    expect(db.listAlertDevices("VRTX", "regulatory_decision").map((device) => device.installationId)).toEqual([allId]);
    expect(db.listAlertDevices("MRNA", "trial_topline").map((device) => device.installationId)).toEqual([allId]);
  });

  it("rekeys an existing alert when event identity is reconciled", () => {
    db = new SignalDatabase(":memory:");
    const item = signalItem("rekeyed", "RGNX");
    db.insertItem(item);
    db.saveAlert({
      id: "alert-rekeyed",
      itemId: item.id,
      ticker: "RGNX",
      eventType: "regulatory_decision",
      tier: "urgent",
      eventKey: "RGNX:old",
      status: "sent",
    });
    db.saveAnalysis({
      itemId: item.id,
      model: "test-model",
      method: "openai",
      assessment: assessment(),
      policyScore: 90,
      alertTier: "urgent",
      policyReasons: ["test"],
      createdAt: new Date().toISOString(),
      eventKey: "RGNX:canonical",
      eventAnchorAt: item.publishedAt,
      analysisVersion: 2,
    });

    expect(db.hasRecentAlert("RGNX:canonical", "urgent", new Date(0).toISOString())).toBe(true);
    expect(db.hasRecentAlert("RGNX:old", "urgent", new Date(0).toISOString())).toBe(false);
  });

  it("downgrades an expired subscription without deleting its purchase record", () => {
    db = new SignalDatabase(":memory:");
    const id = "f4d6cddf-2353-4f0c-a0b4-2586ea5d4404";
    db.registerInstallation(id, "client-token-hash");
    db.applyStoreTransaction({
      installationId: id,
      productId: "com.yingcui.CatalystWatch.pro.monthly",
      originalTransactionId: "original-expired",
      transactionId: "transaction-expired",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      environment: "Sandbox",
      revoked: false,
    });

    expect(db.getInstallationAccess(id)).toMatchObject({ level: "free", pro: false, source: "free" });
  });

  it("requeues only the newest permanent failures", () => {
    db = new SignalDatabase(":memory:");
    const failed = [
      { id: "old-failure", publishedAt: "2026-08-30T12:00:00.000Z" },
      { id: "middle-failure", publishedAt: "2026-08-31T12:00:00.000Z" },
      { id: "new-failure", publishedAt: "2026-09-01T12:00:00.000Z" },
    ];
    for (const candidate of failed) {
      db.insertItem({ ...signalItem(candidate.id, "MRNA"), publishedAt: candidate.publishedAt });
      for (let attempt = 0; attempt < 4; attempt += 1) db.recordItemFailure(candidate.id, "quota exhausted");
    }
    db.insertItem(signalItem("scheduled-retry", "MRNA"));
    db.recordItemFailure("scheduled-retry", "temporary failure");

    expect(db.requeueFailedItems(2)).toBe(2);
    expect(db.getPendingItems().map((item) => item.id)).toEqual(["new-failure", "middle-failure"]);
    expect(db.stats()).toMatchObject({ pending_count: 2, retry_count: 1, error_count: 1 });
  });
});

function signalItem(id: string, ticker: string): NormalizedItem {
  const timestamp = new Date().toISOString();
  return {
    id,
    externalId: id,
    source: { id: "wire", name: "Wire", type: "outlet", tier: "secondary" },
    headline: `${ticker} catalyst`,
    summary: "Summary",
    url: `https://example.test/${id}`,
    author: null,
    publishedAt: timestamp,
    discoveredAt: timestamp,
    companyHint: ticker,
    tickerHint: ticker,
    raw: {},
  };
}

function assessment(overrides: Partial<ImpactAssessment> = {}): ImpactAssessment {
  return {
    isBiotechCatalyst: true,
    companyName: "Moderna",
    ticker: "MRNA",
    eventType: "trial_update",
    trialPhase: "unknown",
    trialName: "",
    indication: "",
    resultDirection: "unclear",
    stockDirection: "unclear",
    materiality: 60,
    confidence: 0.9,
    probabilityPositiveMove: 0.5,
    expectedMoveLowPct: -5,
    expectedMoveBasePct: 0,
    expectedMoveHighPct: 5,
    timeHorizon: "intraday",
    primaryEndpointMet: "not_reported",
    statisticalStrength: "not_reported",
    safetyAssessment: "not_reported",
    noveltyVsPriorDisclosure: "new",
    rationale: "Test assessment",
    evidence: [],
    uncertainty: [],
    disconfirmingEvidence: [],
    requiresHumanReview: false,
    ...overrides,
  };
}
