import type { AlertTier, AnalysisMethod, EvidenceContext, ImpactAssessment } from "../types.js";
import { clamp } from "../utils.js";

export interface AlertPolicyConfig {
  minMateriality: number;
  minConfidence: number;
}

export interface PolicyDecision {
  score: number;
  tier: AlertTier;
  reasons: string[];
}

const MATERIAL_EVENT_TYPES = new Set<ImpactAssessment["eventType"]>([
  "trial_topline",
  "regulatory_decision",
  "safety_signal",
]);

export function decideAlert(
  assessment: ImpactAssessment,
  context: EvidenceContext,
  method: AnalysisMethod,
  config: AlertPolicyConfig,
): PolicyDecision {
  const reasons: string[] = [];
  const distinctSources = new Set([context.item.source.id, ...context.corroboratingItems.map((item) => item.source.id)]);
  const tickerMapped = Boolean(context.company && context.company.ticker.toUpperCase() === assessment.ticker.toUpperCase());
  const hasPrimary = [context.item, ...context.corroboratingItems].some((item) => item.source.tier === "primary");
  const hasIndependentCorroboration = distinctSources.size >= 2
    && [context.item, ...context.corroboratingItems].filter((item) => item.source.tier !== "social").length >= 2;
  const evidenceQuality = hasPrimary ? 100 : hasIndependentCorroboration ? 78 : context.item.source.tier === "secondary" ? 52 : 20;
  const endpointQuality = assessment.eventType === "regulatory_decision"
    ? 100
    : assessment.primaryEndpointMet === "yes"
      ? assessment.statisticalStrength === "strong" ? 100 : 82
      : assessment.primaryEndpointMet === "partial" ? 50 : 20;
  const directionStrength = assessment.stockDirection === "bullish"
    ? assessment.probabilityPositiveMove * 100
    : assessment.stockDirection === "bearish"
      ? (1 - assessment.probabilityPositiveMove) * 100
      : 30;
  const rawScore = assessment.materiality * 0.35
    + assessment.confidence * 100 * 0.2
    + evidenceQuality * 0.2
    + endpointQuality * 0.15
    + directionStrength * 0.1;
  const penalty = (assessment.requiresHumanReview ? 12 : 0)
    + (assessment.noveltyVsPriorDisclosure === "repeated" ? 20 : 0)
    + (assessment.safetyAssessment === "concerning" && assessment.stockDirection === "bullish" ? 18 : 0);
  const score = Math.round(clamp(rawScore - penalty, 0, 100));
  const rangeConsistent = assessment.expectedMoveLowPct <= assessment.expectedMoveBasePct
    && assessment.expectedMoveBasePct <= assessment.expectedMoveHighPct;
  const safetyReady = assessment.eventType === "regulatory_decision"
    ? assessment.safetyAssessment !== "concerning"
    : ["favorable", "manageable"].includes(assessment.safetyAssessment);

  if (!assessment.isBiotechCatalyst) reasons.push("not classified as a biotech catalyst");
  if (!assessment.ticker) reasons.push("no public-company ticker established");
  else if (!tickerMapped) reasons.push("ticker is not mapped to the configured watchlist");
  if (!MATERIAL_EVENT_TYPES.has(assessment.eventType)) reasons.push("event is not a top-line result, regulatory decision, or safety signal");
  if (!hasPrimary && !hasIndependentCorroboration) reasons.push("no primary evidence or independent non-social corroboration");
  if (context.item.source.tier === "social" && !hasPrimary && !hasIndependentCorroboration) reasons.push("social-only evidence cannot escalate");
  if (assessment.materiality < config.minMateriality) reasons.push(`materiality ${assessment.materiality} is below ${config.minMateriality}`);
  if (assessment.confidence < config.minConfidence) reasons.push(`confidence ${assessment.confidence.toFixed(2)} is below ${config.minConfidence.toFixed(2)}`);
  if (assessment.requiresHumanReview) reasons.push("analysis explicitly requires human review");
  if (assessment.noveltyVsPriorDisclosure !== "new") reasons.push("announcement is not clearly new");
  if (!rangeConsistent) reasons.push("stock-move scenario range is internally inconsistent");
  if (!safetyReady) reasons.push("safety evidence is insufficient for positive escalation");
  if (assessment.evidence.length === 0) reasons.push("analysis returned no quoted or paraphrased evidence");
  if (assessment.disconfirmingEvidence.length > 0) reasons.push("disconfirming evidence requires review");

  if (!assessment.isBiotechCatalyst || !assessment.ticker) return { score, tier: "none", reasons };
  if (method !== "openai") {
    reasons.push("demo heuristic is hard-blocked from high-priority alerts");
    return { score: Math.min(score, 49), tier: "watch", reasons };
  }
  if (!tickerMapped) return { score: Math.min(score, 69), tier: "watch", reasons };

  const high = MATERIAL_EVENT_TYPES.has(assessment.eventType)
    && assessment.materiality >= config.minMateriality
    && assessment.confidence >= config.minConfidence
    && (hasPrimary || hasIndependentCorroboration)
    && assessment.noveltyVsPriorDisclosure === "new";
  if (!high) return { score, tier: score >= 55 ? "watch" : "none", reasons };

  const positiveUrgent = assessment.stockDirection === "bullish"
    && assessment.resultDirection === "positive"
    && assessment.probabilityPositiveMove >= 0.75
    && assessment.expectedMoveBasePct > 0
    && rangeConsistent
    && !assessment.requiresHumanReview
    && safetyReady
    && assessment.evidence.length > 0
    && assessment.disconfirmingEvidence.length === 0
    && (
      assessment.eventType === "regulatory_decision"
      || (assessment.eventType === "trial_topline"
        && assessment.primaryEndpointMet === "yes"
        && ["strong", "moderate"].includes(assessment.statisticalStrength))
    );
  if (positiveUrgent) {
    reasons.push("passed conservative positive-catalyst escalation gate");
    return { score, tier: "urgent", reasons };
  }

  reasons.push("material but does not pass the positive urgent-alert gate");
  return { score, tier: "high", reasons };
}
