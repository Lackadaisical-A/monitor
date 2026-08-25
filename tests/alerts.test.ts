import { afterEach, describe, expect, it } from "vitest";
import { AlertService } from "../src/alerts/service.js";
import type { AppConfig } from "../src/config.js";
import { SignalDatabase } from "../src/db.js";
import type { AnalysisRecord, ImpactAssessment, NormalizedItem } from "../src/types.js";

let db: SignalDatabase | null = null;
afterEach(() => { db?.close(); db = null; });

describe("AlertService event delivery", () => {
  it("delivers high alerts once per event and still permits an urgent upgrade", async () => {
    db = new SignalDatabase(":memory:");
    const item = signal(new Date(Date.now() - 5 * 60_000).toISOString());
    db.insertItem(item);
    const service = new AlertService(config(), db);
    const high = analysis(item, "high");

    const parallel = await Promise.all([service.dispatch(item, high), service.dispatch(item, high)]);
    expect(new Set(parallel.map((result) => result.suppressedReason))).toEqual(new Set([null, "cooldown"]));
    expect(await service.dispatch(item, { ...high, alertTier: "urgent" })).toMatchObject({
      dryRun: true,
      suppressedReason: null,
    });
  });

  it("records but does not push an analysis completed after the freshness window", async () => {
    db = new SignalDatabase(":memory:");
    const item = signal(new Date(Date.now() - 45 * 60_000).toISOString());
    db.insertItem(item);
    const service = new AlertService(config(), db);

    expect(await service.dispatch(item, analysis(item, "high"))).toMatchObject({
      attempted: 0,
      suppressedReason: "stale_event",
    });
  });
});

function config(): AppConfig {
  return {
    alertPolicy: {
      dryRun: true,
      highMinMateriality: 70,
      highMinConfidence: 0.8,
      minMateriality: 88,
      minConfidence: 0.86,
      cooldownMinutes: 240,
      maxAgeMinutes: 30,
    },
    apns: {
      teamId: "TEAM123",
      keyId: "KEY123",
      bundleId: "com.example.app",
      privateKey: "test-private-key",
      privateKeyPath: "",
      environment: "sandbox",
      allowCritical: false,
    },
  } as unknown as AppConfig;
}

function signal(publishedAt: string): NormalizedItem {
  return {
    id: `signal-${publishedAt}`,
    externalId: `signal-${publishedAt}`,
    source: { id: "company-ir", name: "Company IR", type: "company_ir", tier: "primary" },
    headline: "Example Bio announces an FDA regulatory decision",
    summary: "The FDA approved the application.",
    url: "https://example.test/release",
    author: "Example Bio",
    publishedAt,
    discoveredAt: publishedAt,
    companyHint: "Example Bio",
    tickerHint: "EXBI",
    provenance: "direct_primary",
    raw: {},
  };
}

function analysis(item: NormalizedItem, tier: AnalysisRecord["alertTier"]): AnalysisRecord {
  return {
    itemId: item.id,
    model: "test",
    method: "openai",
    assessment: assessment(),
    policyScore: 90,
    alertTier: tier,
    policyReasons: [],
    createdAt: new Date().toISOString(),
    eventKey: "EXBI:approval-event",
    eventAnchorAt: item.publishedAt,
    analysisVersion: 2,
  };
}

function assessment(): ImpactAssessment {
  return {
    isBiotechCatalyst: true,
    companyName: "Example Bio",
    ticker: "EXBI",
    eventType: "regulatory_decision",
    trialPhase: "not_applicable",
    trialName: "",
    indication: "Example disease",
    resultDirection: "positive",
    stockDirection: "bullish",
    materiality: 92,
    confidence: 0.92,
    probabilityPositiveMove: 0.8,
    expectedMoveLowPct: 5,
    expectedMoveBasePct: 15,
    expectedMoveHighPct: 30,
    timeHorizon: "next_session",
    primaryEndpointMet: "not_applicable",
    statisticalStrength: "not_applicable",
    safetyAssessment: "manageable",
    noveltyVsPriorDisclosure: "new",
    rationale: "Approval is material.",
    evidence: ["FDA approved the application."],
    uncertainty: [],
    disconfirmingEvidence: [],
    requiresHumanReview: false,
  };
}
