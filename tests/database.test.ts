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
});
