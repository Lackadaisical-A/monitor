import { describe, expect, it } from "vitest";
import { actionFamily, areLikelySameEvent, evidenceProfile, eventIdentity } from "../src/events.js";
import type { EvidenceContext, ImpactAssessment, NormalizedItem, WatchCompany } from "../src/types.js";

const company: WatchCompany = {
  ticker: "RGNX",
  company: "REGENXBIO",
  aliases: ["REGENXBIO Inc."],
  marketCapBand: "small",
  xAccounts: [],
  programs: ["RGX-121", "CAMPSIITE"],
};

describe("event identity and evidence provenance", () => {
  it("counts an issuer feed and its syndicated wire copy as one evidence origin", () => {
    const direct = signal("direct", "company-ir", "https://regenxbio.com/release", "direct_primary");
    const wire = signal("wire", "wire", "https://accesswire.com/release", "syndicated_primary");
    direct.independenceKey = "issuer:rgnx";
    wire.independenceKey = "issuer:rgnx";
    const profile = evidenceProfile({ item: wire, corroboratingItems: [direct], company });

    expect(profile.hasPrimary).toBe(true);
    expect(profile.independentSourceCount).toBe(1);
    expect(profile.hasIndependentCorroboration).toBe(false);
  });

  it("recognizes genuinely independent reporting as a second origin", () => {
    const issuer = signal("wire", "wire", "https://accesswire.com/release", "syndicated_primary");
    issuer.independenceKey = "issuer:rgnx";
    const report = signal("report", "news", "https://reuters.test/rgnx-hold", "independent_reporting");
    report.independenceKey = "publisher:reuters";

    const profile = evidenceProfile({ item: issuer, corroboratingItems: [report], company });

    expect(profile.independentSourceCount).toBe(2);
    expect(profile.hasIndependentCorroboration).toBe(true);
  });

  it("clusters cross-source copies but time-bounds a later event on the same program", () => {
    const primary = signal("primary", "company-ir", "https://regenxbio.com/release", "direct_primary");
    const report = signal("report", "news", "https://news.test/rgnx-hold", "independent_reporting");
    report.headline = "FDA hold derails RGX-121 refiling plan at REGENXBIO";
    expect(areLikelySameEvent(primary, report, company)).toBe(true);

    const firstContext: EvidenceContext = { item: primary, corroboratingItems: [report], company };
    const reverseContext: EvidenceContext = { item: report, corroboratingItems: [primary], company };
    const first = eventIdentity(assessment("issuer-rgx121-hold"), firstContext);
    const reverse = eventIdentity(assessment("news-rgx-121-clinical-hold"), reverseContext);
    expect(reverse).toEqual(first);

    const later = {
      ...primary,
      id: "later",
      externalId: "later",
      publishedAt: "2026-10-01T11:00:00.000Z",
    };
    const laterIdentity = eventIdentity(assessment("issuer-rgx121-hold"), {
      item: later,
      corroboratingItems: [],
      company,
    });
    expect(laterIdentity.eventKey).not.toBe(first.eventKey);

    const lifted = {
      ...primary,
      id: "lifted",
      externalId: "lifted",
      headline: "FDA lifts clinical hold on RGX-121",
      summary: "The RGX-121 study may resume after the agency removed the hold.",
    };
    const liftedIdentity = eventIdentity(assessment("issuer-rgx121-hold-lifted"), {
      item: lifted,
      corroboratingItems: [],
      company,
    });
    expect(liftedIdentity.eventKey).not.toBe(first.eventKey);
  });

  it("clusters coverage that omits the asset code but repeats distinctive event facts", () => {
    const primary = signal("primary", "company-ir", "https://regenxbio.com/release", "direct_primary");
    primary.summary = "The FDA placed RGX-121 on clinical hold after asymptomatic spine masses were found in five people with Hunter syndrome.";
    const report = signal("report", "news", "https://news.test/rgnx-hold", "independent_reporting");
    report.headline = "FDA pauses Regenxbio gene therapy trial again due to safety concerns";
    report.summary = "Small masses were found on the spines of five people with Hunter syndrome, and the company said they remain asymptomatic.";

    expect(areLikelySameEvent(primary, report, company)).toBe(true);
    expect(eventIdentity(assessment("issuer-rgx121-hold"), {
      item: primary,
      corroboratingItems: [],
      company,
    }).eventKey).toBe(eventIdentity(assessment("rgnx-rgx-121-fda-clinical-hold"), {
      item: report,
      corroboratingItems: [],
      company,
    }).eventKey);
  });

  it("does not interpret the CRL ticker as a regulatory rejection without FDA context", () => {
    expect(actionFamily("CRL reports quarterly financial results")).toBe("general");
    expect(actionFamily("Example Bio received a CRL from the FDA")).toBe("regulatory-rejection");
  });
});

function signal(
  id: string,
  sourceId: string,
  url: string,
  provenance: NormalizedItem["provenance"],
): NormalizedItem {
  return {
    id,
    externalId: id,
    source: {
      id: sourceId,
      name: sourceId,
      type: sourceId === "company-ir" || sourceId === "wire" ? "company_ir" : "outlet",
      tier: sourceId === "news" ? "secondary" : "primary",
    },
    headline: "REGENXBIO announces FDA clinical hold on RGX-121",
    summary: "The FDA placed RGX-121 on clinical hold and the near-term BLA refiling is no longer planned.",
    url,
    author: null,
    publishedAt: "2026-08-24T11:05:00.000Z",
    discoveredAt: "2026-08-24T11:06:00.000Z",
    companyHint: "REGENXBIO",
    tickerHint: "RGNX",
    provenance,
    raw: {},
  };
}

function assessment(eventSignature: string): ImpactAssessment {
  return {
    isBiotechCatalyst: true,
    companyName: "REGENXBIO",
    ticker: "RGNX",
    eventType: "regulatory_decision",
    trialPhase: "unknown",
    trialName: "CAMPSIITE",
    indication: "MPS II",
    resultDirection: "negative",
    stockDirection: "bearish",
    materiality: 90,
    confidence: 0.95,
    probabilityPositiveMove: 0.08,
    expectedMoveLowPct: -35,
    expectedMoveBasePct: -20,
    expectedMoveHighPct: -5,
    timeHorizon: "next_session",
    primaryEndpointMet: "not_reported",
    statisticalStrength: "not_reported",
    safetyAssessment: "concerning",
    noveltyVsPriorDisclosure: "new",
    rationale: "A new FDA hold blocks development.",
    evidence: ["FDA placed the program on clinical hold."],
    uncertainty: [],
    disconfirmingEvidence: [],
    requiresHumanReview: false,
    eventSignature,
  };
}
