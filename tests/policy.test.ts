import { describe, expect, it } from "vitest";
import { decideAlert } from "../src/analysis/policy.js";
import type { EvidenceContext, ImpactAssessment, NormalizedItem } from "../src/types.js";

const strongPositive: ImpactAssessment = {
  isBiotechCatalyst: true,
  companyName: "Example Bio",
  ticker: "EXBI",
  eventType: "trial_topline",
  trialPhase: "phase_3",
  trialName: "VICTOR",
  indication: "Example disease",
  resultDirection: "positive",
  stockDirection: "bullish",
  materiality: 94,
  confidence: 0.92,
  probabilityPositiveMove: 0.82,
  expectedMoveLowPct: 8,
  expectedMoveBasePct: 18,
  expectedMoveHighPct: 36,
  timeHorizon: "next_session",
  primaryEndpointMet: "yes",
  statisticalStrength: "strong",
  safetyAssessment: "manageable",
  noveltyVsPriorDisclosure: "new",
  rationale: "The pivotal study met its prespecified primary endpoint.",
  evidence: ["Primary endpoint met"],
  uncertainty: ["Full subgroup data are pending"],
  disconfirmingEvidence: [],
  requiresHumanReview: false,
};

describe("deterministic alert policy", () => {
  it("allows a strong primary-source positive catalyst through the urgent gate", () => {
    const context = makeContext("primary");
    const decision = decideAlert(strongPositive, context, "openai", { minMateriality: 88, minConfidence: 0.86 });
    expect(decision.tier).toBe("urgent");
    expect(decision.reasons).toContain("passed conservative positive-catalyst escalation gate");
  });

  it("never escalates social-only evidence", () => {
    const context = makeContext("social");
    const decision = decideAlert(strongPositive, context, "openai", { minMateriality: 88, minConfidence: 0.86 });
    expect(decision.tier).not.toBe("urgent");
    expect(decision.reasons.join(" ")).toMatch(/social-only|primary evidence/);
  });

  it("hard-blocks the offline demo heuristic from high-priority alerts", () => {
    const context = makeContext("primary");
    const decision = decideAlert(strongPositive, context, "heuristic_demo", { minMateriality: 88, minConfidence: 0.86 });
    expect(decision.tier).toBe("watch");
    expect(decision.score).toBeLessThanOrEqual(49);
  });

  it("does not escalate a ticker that is absent from the configured watchlist", () => {
    const context = { ...makeContext("primary"), company: null };
    const decision = decideAlert(strongPositive, context, "openai", { minMateriality: 88, minConfidence: 0.86 });
    expect(decision.tier).toBe("watch");
    expect(decision.reasons).toContain("ticker is not mapped to the configured watchlist");
  });

  it("does not call incomplete trial updates urgent", () => {
    const incomplete = { ...strongPositive, primaryEndpointMet: "not_reported" as const, statisticalStrength: "not_reported" as const, requiresHumanReview: true };
    const decision = decideAlert(incomplete, makeContext("primary"), "openai", { minMateriality: 88, minConfidence: 0.86 });
    expect(decision.tier).toBe("high");
  });
});

function makeContext(tier: "primary" | "social"): EvidenceContext {
  const item: NormalizedItem = {
    id: "item-1",
    externalId: "external-1",
    source: { id: tier === "primary" ? "company-ir" : "x", name: tier === "primary" ? "Company IR" : "X", type: tier === "primary" ? "company_ir" : "x", tier },
    headline: "Example Bio reports positive Phase 3 results",
    summary: "The study met its primary endpoint with statistical significance.",
    url: "https://example.test/result",
    author: "Example Bio",
    publishedAt: new Date().toISOString(),
    discoveredAt: new Date().toISOString(),
    companyHint: "Example Bio",
    tickerHint: "EXBI",
    raw: {},
  };
  return {
    item,
    corroboratingItems: [],
    company: { ticker: "EXBI", company: "Example Bio", aliases: [], marketCapBand: "small", xAccounts: [], programs: [] },
  };
}
