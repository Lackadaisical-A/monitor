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

  it("urgently escalates a primary-source FDA clinical hold below the positive threshold", () => {
    const clinicalHold: ImpactAssessment = {
      ...strongPositive,
      companyName: "REGENXBIO",
      ticker: "RGNX",
      eventType: "regulatory_update",
      trialPhase: "unknown",
      trialName: "RGX-121 registrational trial",
      indication: "MPS II",
      resultDirection: "negative",
      stockDirection: "bearish",
      materiality: 82,
      confidence: 0.9,
      probabilityPositiveMove: 0.1,
      expectedMoveLowPct: -35,
      expectedMoveBasePct: -20,
      expectedMoveHighPct: -5,
      primaryEndpointMet: "not_reported",
      statisticalStrength: "not_reported",
      safetyAssessment: "concerning",
      rationale: "The FDA clinical hold prevents a near-term resubmission.",
      evidence: ["The FDA placed the RGX-121 program on clinical hold."],
      uncertainty: ["The findings' clinical significance is not yet known."],
      disconfirmingEvidence: ["The observed MRI findings were asymptomatic."],
    };
    const context = makeContext("primary", {
      headline: "REGENXBIO announces regulatory update on RGX-121",
      summary: "The FDA placed a clinical hold on RGX-121 after spinal MRI findings. The company no longer plans a near-term resubmission.",
      tickerHint: "RGNX",
      companyHint: "REGENXBIO",
    }, "RGNX", "REGENXBIO");

    const decision = decideAlert(clinicalHold, context, "openai", { minMateriality: 88, minConfidence: 0.86 });

    expect(decision.tier).toBe("urgent");
    expect(decision.reasons).toContain("passed primary-source severe negative catalyst escalation gate");
    expect(decision.reasons.join(" ")).not.toMatch(/below 88|positive escalation|disconfirming evidence/);
  });

  it("does not use the severe-negative fast path for one secondary report", () => {
    const clinicalHold: ImpactAssessment = {
      ...strongPositive,
      eventType: "regulatory_update",
      resultDirection: "negative",
      stockDirection: "bearish",
      materiality: 82,
      confidence: 0.9,
      probabilityPositiveMove: 0.1,
      expectedMoveLowPct: -35,
      expectedMoveBasePct: -20,
      expectedMoveHighPct: -5,
      safetyAssessment: "concerning",
    };
    const context = makeContext("secondary", {
      headline: "FDA places clinical hold on Example Bio program",
      summary: "The clinical hold has paused the registrational study.",
    });

    const decision = decideAlert(clinicalHold, context, "openai", { minMateriality: 88, minConfidence: 0.86 });

    expect(decision.tier).toBe("watch");
    expect(decision.reasons).toContain("no primary evidence or independent non-social corroboration");
  });

  it("promotes an independently corroborated severe negative report to high", () => {
    const clinicalHold: ImpactAssessment = {
      ...strongPositive,
      eventType: "regulatory_update",
      resultDirection: "negative",
      stockDirection: "bearish",
      materiality: 82,
      confidence: 0.9,
      probabilityPositiveMove: 0.1,
      expectedMoveLowPct: -35,
      expectedMoveBasePct: -20,
      expectedMoveHighPct: -5,
      safetyAssessment: "concerning",
    };
    const context = makeContext("secondary", {
      headline: "FDA places clinical hold on Example Bio program",
      summary: "The clinical hold paused the registrational study.",
    });
    context.corroboratingItems = [{
      ...context.item,
      id: "item-2",
      externalId: "external-2",
      source: { id: "second-news", name: "Second News", type: "outlet", tier: "secondary" },
    }];

    const decision = decideAlert(clinicalHold, context, "openai", { minMateriality: 88, minConfidence: 0.86 });

    expect(decision.tier).toBe("high");
    expect(decision.reasons).toContain("passed severe negative high-priority gate");
  });

  it("does not treat a positive hold-lift announcement as a severe negative", () => {
    const holdLifted = { ...strongPositive, eventType: "regulatory_decision" as const };
    const context = makeContext("primary", {
      headline: "FDA lifts clinical hold on Example Bio study",
      summary: "Enrollment can resume after the FDA lifted the clinical hold.",
    });

    const decision = decideAlert(holdLifted, context, "openai", { minMateriality: 88, minConfidence: 0.86 });

    expect(decision.tier).toBe("urgent");
    expect(decision.reasons).toContain("passed conservative positive-catalyst escalation gate");
    expect(decision.reasons).not.toContain("passed primary-source severe negative catalyst escalation gate");
  });
});

function makeContext(
  tier: "primary" | "secondary" | "social",
  overrides: Partial<NormalizedItem> = {},
  ticker = "EXBI",
  company = "Example Bio",
): EvidenceContext {
  const item: NormalizedItem = {
    id: "item-1",
    externalId: "external-1",
    source: tier === "primary"
      ? { id: "company-ir", name: "Company IR", type: "company_ir", tier }
      : tier === "secondary"
        ? { id: "news", name: "News", type: "outlet", tier }
        : { id: "x", name: "X", type: "x", tier },
    headline: "Example Bio reports positive Phase 3 results",
    summary: "The study met its primary endpoint with statistical significance.",
    url: "https://example.test/result",
    author: "Example Bio",
    publishedAt: new Date().toISOString(),
    discoveredAt: new Date().toISOString(),
    companyHint: company,
    tickerHint: ticker,
    raw: {},
    ...overrides,
  };
  return {
    item,
    corroboratingItems: [],
    company: { ticker, company, aliases: [], marketCapBand: "small", xAccounts: [], programs: [] },
  };
}
