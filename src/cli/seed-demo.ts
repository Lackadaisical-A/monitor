import { loadConfig } from "../config.js";
import { SignalDatabase } from "../db.js";
import type { ImpactAssessment, NormalizedItem } from "../types.js";
import { itemId } from "../utils.js";

const config = loadConfig();
const db = new SignalDatabase(config.databasePath);
const now = new Date();

const fixtures: Array<{ item: Omit<NormalizedItem, "id" | "discoveredAt" | "raw">; assessment: ImpactAssessment }> = [
  {
    item: {
      externalId: "synthetic-positive-1",
      source: { id: "synthetic-company-ir", name: "Synthetic company IR", type: "company_ir", tier: "primary" },
      headline: "Example Bio reports positive Phase 3 topline results in the VICTOR study",
      summary: "Synthetic fixture for UI testing. The release says the primary endpoint was met and safety was manageable.",
      url: "https://example.com/synthetic-positive",
      author: "Example Bio",
      publishedAt: new Date(now.getTime() - 12 * 60_000).toISOString(),
      companyHint: "Example Bio",
      tickerHint: "EXBI",
    },
    assessment: baseAssessment({
      ticker: "EXBI", companyName: "Example Bio", materiality: 86, confidence: 0.4,
      resultDirection: "positive", stockDirection: "bullish", primaryEndpointMet: "yes",
      statisticalStrength: "moderate", safetyAssessment: "manageable", expectedMoveLowPct: 5,
      expectedMoveBasePct: 13, expectedMoveHighPct: 28,
    }),
  },
  {
    item: {
      externalId: "synthetic-registry-1",
      source: { id: "synthetic-ctgov", name: "Synthetic ClinicalTrials.gov", type: "clinical_trials", tier: "primary" },
      headline: "ClinicalTrials.gov record updated: Phase 2 study of EXB-201",
      summary: "Synthetic fixture for UI testing. A registry update does not itself establish a new efficacy result.",
      url: "https://example.com/synthetic-registry",
      author: "Example Bio",
      publishedAt: new Date(now.getTime() - 80 * 60_000).toISOString(),
      companyHint: "Example Bio",
      tickerHint: "EXBI",
    },
    assessment: baseAssessment({
      ticker: "EXBI", companyName: "Example Bio", eventType: "trial_update", trialPhase: "phase_2",
      materiality: 36, confidence: 0.4, resultDirection: "unclear", stockDirection: "unclear",
      primaryEndpointMet: "not_reported", statisticalStrength: "not_reported", safetyAssessment: "not_reported",
      expectedMoveLowPct: -3, expectedMoveBasePct: 0, expectedMoveHighPct: 3,
    }),
  },
];

for (const fixture of fixtures) {
  const id = itemId(fixture.item.source.id, fixture.item.externalId, fixture.item.url, fixture.item.headline);
  const item: NormalizedItem = { ...fixture.item, id, discoveredAt: now.toISOString(), raw: { synthetic: true } };
  db.insertItem(item);
  db.saveAnalysis({
    itemId: id,
    model: "heuristic-demo-v1",
    method: "heuristic_demo",
    assessment: fixture.assessment,
    policyScore: Math.min(49, fixture.assessment.materiality),
    alertTier: "watch",
    policyReasons: ["Synthetic UI fixture", "Demo heuristic is hard-blocked from high-priority alerts"],
    createdAt: now.toISOString(),
  });
}

console.log(`Seeded ${fixtures.length} clearly labeled synthetic signals into ${config.databasePath}`);
db.close();

function baseAssessment(overrides: Partial<ImpactAssessment>): ImpactAssessment {
  return {
    isBiotechCatalyst: true, companyName: "", ticker: "", eventType: "trial_topline", trialPhase: "phase_3",
    trialName: "VICTOR", indication: "Synthetic indication", resultDirection: "unclear", stockDirection: "unclear",
    materiality: 30, confidence: 0.4, probabilityPositiveMove: 0.5,
    expectedMoveLowPct: -3, expectedMoveBasePct: 0, expectedMoveHighPct: 3, timeHorizon: "next_session",
    primaryEndpointMet: "not_reported", statisticalStrength: "not_reported", safetyAssessment: "not_reported",
    noveltyVsPriorDisclosure: "unknown", rationale: "Synthetic demo data only; no market conclusion should be drawn.",
    evidence: ["Synthetic fixture"], uncertainty: ["Not a real announcement"], disconfirmingEvidence: [], requiresHumanReview: true,
    ...overrides,
  };
}
