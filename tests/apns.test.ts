import { describe, expect, it } from "vitest";
import { buildApnsPayload, HIGH_ALERT_SOUND, URGENT_ALERT_SOUND } from "../src/alerts/apns.js";
import type { AnalysisRecord, NormalizedItem } from "../src/types.js";

const item: NormalizedItem = {
  id: "signal-123",
  externalId: "article-1",
  source: { id: "company-ir", name: "Company IR", type: "company_ir", tier: "primary" },
  headline: "Example Bio reports positive pivotal results",
  summary: "",
  url: "https://example.test/results",
  author: null,
  publishedAt: new Date().toISOString(),
  discoveredAt: new Date().toISOString(),
  companyHint: "Example Bio",
  tickerHint: "EXBI",
  raw: {},
};

const analysis: AnalysisRecord = {
  itemId: item.id,
  model: "test",
  method: "openai",
  assessment: {
    isBiotechCatalyst: true, companyName: "Example Bio", ticker: "EXBI", eventType: "trial_topline",
    trialPhase: "phase_3", trialName: "", indication: "", resultDirection: "positive", stockDirection: "bullish",
    materiality: 92, confidence: 0.91, probabilityPositiveMove: 0.8,
    expectedMoveLowPct: 7, expectedMoveBasePct: 15, expectedMoveHighPct: 28, timeHorizon: "next_session",
    primaryEndpointMet: "yes", statisticalStrength: "strong", safetyAssessment: "manageable",
    noveltyVsPriorDisclosure: "new", rationale: "", evidence: [], uncertainty: [], disconfirmingEvidence: [], requiresHumanReview: false,
  },
  policyScore: 91,
  alertTier: "urgent",
  policyReasons: [],
  createdAt: new Date().toISOString(),
};

describe("APNs payload", () => {
  it("builds a Time Sensitive payload by default", () => {
    const payload = buildApnsPayload(item, analysis, false, true) as { aps: Record<string, unknown> };
    expect(payload.aps["interruption-level"]).toBe("time-sensitive");
    expect(payload.aps.sound).toBe("default");
    expect(payload.aps.badge).toBe(1);
    expect(JSON.stringify(payload)).toContain("Verify the primary source");
  });

  it("uses tier-specific sounds only for capable app builds", () => {
    const urgent = buildApnsPayload(item, analysis, false, true, true) as { aps: Record<string, unknown> };
    const high = buildApnsPayload(item, { ...analysis, alertTier: "high" }, false, true, true) as { aps: Record<string, unknown> };

    expect(urgent.aps.sound).toBe(URGENT_ALERT_SOUND);
    expect(high.aps.sound).toBe(HIGH_ALERT_SOUND);
  });

  it("only uses critical sound fields when explicitly requested", () => {
    const payload = buildApnsPayload(item, analysis, true, true, true) as { aps: Record<string, unknown> };
    expect(payload.aps["interruption-level"]).toBe("critical");
    expect(payload.aps.sound).toEqual({ critical: 1, name: URGENT_ALERT_SOUND, volume: 1 });
  });
});
