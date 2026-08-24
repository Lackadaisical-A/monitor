import { afterEach, describe, expect, it } from "vitest";
import type { CatalystAnalyzer } from "../src/analysis/analyzer.js";
import type { AlertService } from "../src/alerts/service.js";
import type { AppConfig } from "../src/config.js";
import { SignalDatabase } from "../src/db.js";
import { MonitorPipeline } from "../src/pipeline.js";
import type { ImpactAssessment, NormalizedItem } from "../src/types.js";

let db: SignalDatabase | null = null;

afterEach(() => {
  db?.close();
  db = null;
});

describe("MonitorPipeline policy reconciliation", () => {
  it("re-scores a stored clinical hold after its source becomes primary", async () => {
    db = new SignalDatabase(":memory:");
    const item = clinicalHoldItem();
    db.insertItem(item);
    db.saveAnalysis({
      itemId: item.id,
      model: "test-model",
      method: "openai",
      assessment: clinicalHoldAssessment(),
      policyScore: 69,
      alertTier: "watch",
      policyReasons: ["no primary evidence or independent non-social corroboration"],
      createdAt: new Date().toISOString(),
    });
    db.syncSourceDescriptors([{
      id: item.source.id,
      name: item.source.name,
      type: "company_ir",
      tier: "primary",
    }]);
    const pipeline = new MonitorPipeline(
      {
        watchlist: [{
          ticker: "RGNX",
          company: "Regenxbio",
          aliases: ["REGENXBIO Inc."],
          marketCapBand: "small",
          xAccounts: [],
          programs: ["RGX-121"],
        }],
        alertPolicy: { dryRun: false, minMateriality: 88, minConfidence: 0.86, cooldownMinutes: 240 },
      } as unknown as AppConfig,
      db,
      [],
      { analyze: async () => { throw new Error("not used"); } } as CatalystAnalyzer,
      {} as AlertService,
      { info: () => {}, warn: () => {}, error: () => {} },
    );

    const result = await pipeline.reconcileStoredPolicies();

    expect(result).toEqual({ checkedCount: 1, updatedCount: 1, errorCount: 0 });
    expect(db.getItem(item.id)?.source).toMatchObject({ type: "company_ir", tier: "primary" });
    expect(db.getAnalysis(item.id)).toMatchObject({
      policyScore: 79,
      alertTier: "urgent",
      policyReasons: ["passed primary-source severe negative catalyst escalation gate"],
    });
  });
});

function clinicalHoldItem(): NormalizedItem {
  const timestamp = new Date().toISOString();
  return {
    id: "rgnx-hold",
    externalId: "release-1",
    source: {
      id: "watchlist-press-releases",
      name: "Watchlist company press releases",
      type: "outlet",
      tier: "secondary",
    },
    headline: "REGENXBIO Announces Regulatory Update on RGX-121 for MPS II",
    summary: "The FDA placed a clinical hold on RGX-121 and the company does not expect a near-term BLA resubmission.",
    url: "https://example.test/rgnx-hold",
    author: "PR Newswire via QuoteMedia",
    publishedAt: timestamp,
    discoveredAt: timestamp,
    companyHint: "Regenxbio",
    tickerHint: "RGNX",
    raw: {},
  };
}

function clinicalHoldAssessment(): ImpactAssessment {
  return {
    isBiotechCatalyst: true,
    companyName: "Regenxbio",
    ticker: "RGNX",
    eventType: "regulatory_update",
    trialPhase: "unknown",
    trialName: "CAMPSIITE",
    indication: "MPS II",
    resultDirection: "negative",
    stockDirection: "bearish",
    materiality: 82,
    confidence: 0.9,
    probabilityPositiveMove: 0.12,
    expectedMoveLowPct: -20,
    expectedMoveBasePct: -10,
    expectedMoveHighPct: -4,
    timeHorizon: "next_session",
    primaryEndpointMet: "not_reported",
    statisticalStrength: "not_reported",
    safetyAssessment: "concerning",
    noveltyVsPriorDisclosure: "new",
    rationale: "The FDA clinical hold prevents a near-term BLA resubmission.",
    evidence: ["The FDA placed RGX-121 on clinical hold."],
    uncertainty: ["The FDA hold letter is pending."],
    disconfirmingEvidence: ["The findings were asymptomatic."],
    requiresHumanReview: false,
  };
}
