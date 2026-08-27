import { afterEach, describe, expect, it } from "vitest";
import { SignalDatabase } from "../src/db.js";
import type { MarketDataProvider } from "../src/market-data/alpaca.js";
import { OutcomeAuditor, summarizeOutcomes } from "../src/outcomes.js";
import type { ImpactAssessment, NormalizedItem } from "../src/types.js";

let db: SignalDatabase | null = null;
afterEach(() => { db?.close(); db = null; });

describe("OutcomeAuditor", () => {
  it("persists realized direction and expected-range calibration without re-querying immediately", async () => {
    db = new SignalDatabase(":memory:");
    const eventAt = new Date(Date.now() - 60 * 60_000).toISOString();
    const item = signal(eventAt);
    db.insertItem(item);
    db.saveAnalysis({
      itemId: item.id,
      model: "test",
      method: "openai",
      assessment: assessment(),
      policyScore: 85,
      alertTier: "high",
      policyReasons: ["test"],
      createdAt: new Date().toISOString(),
      eventKey: "AVXL:event-1",
      eventAnchorAt: eventAt,
      analysisVersion: 2,
    });
    let calls = 0;
    const marketData: MarketDataProvider = {
      configured: true,
      feed: "iex",
      getMovements: async (requests) => {
        calls += 1;
        return new Map(requests.map((request) => [request.id, {
          ticker: request.ticker,
          sessionDate: "2026-08-25",
          status: "live",
          announcementAt: eventAt,
          priceStartAt: eventAt,
          priceEndAt: new Date().toISOString(),
          cutoffAt: new Date(Date.parse(eventAt) + 5 * 24 * 60 * 60_000).toISOString(),
          window: "since_announcement",
          refreshIntervalSeconds: 300,
          previousClose: request.ticker === "XBI" ? 100 : 3.1,
          open: request.ticker === "XBI" ? 100 : 3.1,
          high: request.ticker === "XBI" ? 103 : 3.68,
          low: request.ticker === "XBI" ? 99 : 3.1,
          close: request.ticker === "XBI" ? 102.5 : 3.55,
          change: request.ticker === "XBI" ? 2.5 : 0.45,
          changePct: request.ticker === "XBI" ? 2.5 : 14.5,
          fetchedAt: new Date().toISOString(),
          feed: "iex",
          provider: "alpaca",
          basis: "pre_announcement_price",
        }]));
      },
    };
    const auditor = new OutcomeAuditor(db, marketData, { info: () => {}, warn: () => {} }, 15, 30);

    expect(await auditor.run()).toMatchObject({ checked: 1, recorded: 1, finalized: 0 });
    const audits = db.listOutcomeAudits();
    expect(audits[0]).toMatchObject({
      eventKey: "AVXL:event-1",
      actualReturnPct: 14.5,
      benchmarkReturnPct: 2.5,
      abnormalReturnPct: 12,
      marketSurpriseScore: 17,
      surpriseAdjustedMateriality: 79,
      directionCorrect: true,
      abnormalDirectionCorrect: true,
      expectedRangeHit: true,
      status: "live",
    });
    expect(summarizeOutcomes(audits)).toMatchObject({
      count: 1,
      directionAccuracy: 1,
      expectedRangeCoverage: 1,
    });
    expect(await auditor.run()).toMatchObject({ checked: 0, recorded: 0 });
    expect(calls).toBe(1);
  });
});

function signal(publishedAt: string): NormalizedItem {
  return {
    id: "avxl-update",
    externalId: "avxl-update",
    source: { id: "avxl-ir", name: "Anavex IR", type: "company_ir", tier: "primary" },
    headline: "Anavex reports regulatory business update",
    summary: "Clinical data were submitted to a newly opened FDA IND.",
    url: "https://example.test/avxl",
    author: "Anavex Life Sciences",
    publishedAt,
    discoveredAt: publishedAt,
    companyHint: "Anavex Life Sciences",
    tickerHint: "AVXL",
    provenance: "direct_primary",
    raw: {},
  };
}

function assessment(): ImpactAssessment {
  return {
    isBiotechCatalyst: true,
    companyName: "Anavex Life Sciences",
    ticker: "AVXL",
    eventType: "regulatory_update",
    trialPhase: "phase_3",
    trialName: "ANAVEX2-73-RS-005",
    indication: "Rett syndrome",
    resultDirection: "positive",
    stockDirection: "bullish",
    materiality: 78,
    confidence: 0.9,
    probabilityPositiveMove: 0.68,
    expectedMoveLowPct: -4,
    expectedMoveBasePct: 8,
    expectedMoveHighPct: 20,
    timeHorizon: "next_session",
    primaryEndpointMet: "not_reported",
    statisticalStrength: "not_reported",
    safetyAssessment: "not_reported",
    noveltyVsPriorDisclosure: "incremental",
    rationale: "Concrete regulator-facing execution is market-material for a small cap.",
    evidence: ["The clinical data were submitted."],
    uncertainty: [],
    disconfirmingEvidence: [],
    requiresHumanReview: false,
  };
}
