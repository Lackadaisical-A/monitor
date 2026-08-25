import { evidenceProfile } from "../events.js";
import type { AlertTier, AnalysisMethod, EvidenceContext, ImpactAssessment } from "../types.js";
import { clamp } from "../utils.js";

export interface AlertPolicyConfig {
  minMateriality: number;
  minConfidence: number;
  highMinMateriality?: number;
  highMinConfidence?: number;
}

export interface PolicyDecision {
  score: number;
  tier: AlertTier;
  reasons: string[];
  effectiveMarketMateriality: number;
}

const HIGH_EVENT_TYPES = new Set<ImpactAssessment["eventType"]>([
  "trial_topline", "trial_update", "regulatory_decision", "regulatory_update",
  "safety_signal", "publication", "financing", "partnership",
]);

const SEVERE_NEGATIVE_EVENT_TYPES = new Set<ImpactAssessment["eventType"]>([
  "trial_topline", "trial_update", "regulatory_decision", "regulatory_update", "safety_signal",
]);

const SEVERE_NEGATIVE_SIGNALS = [
  /\b(?:full |partial )?clinical hold\b/i,
  /\bcomplete response letter\b|\b(?:receive[ds]?|issue[ds]?|gets?|got|hit with) (?:an? )?CRL\b|\b(?:FDA\b.{0,40}\bCRL|CRL\b.{0,40}\b(?:from|by) (?:the )?FDA)\b/i,
  /\brefus(?:e|ed|es|ing)[ -]to[ -]file\b/i,
  /\b(?:approval (?:was )?(?:denied|rejected)|declined to approve|did not approve|not approved)\b/i,
  /\b(?:failed|fails|did not meet|does not meet|missed|misses) (?:its |the )?(?:primary|co-primary) endpoint\b/i,
  /\b(?:primary|co-primary) endpoint (?:was |were )?(?:not met|missed)\b/i,
  /\b(?:trial|study|program|development)\b.{0,50}\b(?:halted|paused|suspended|terminated|discontinued)\b/i,
  /\b(?:patient|subject) deaths?\b|\bfatalit(?:y|ies)\b|\bserious adverse events?\b/i,
];

export function decideAlert(
  assessment: ImpactAssessment,
  context: EvidenceContext,
  method: AnalysisMethod,
  config: AlertPolicyConfig,
): PolicyDecision {
  const reasons: string[] = [];
  const profile = evidenceProfile(context);
  const tickerMapped = Boolean(context.company && context.company.ticker.toUpperCase() === assessment.ticker.toUpperCase());
  const modelMarketMateriality = assessment.marketMateriality ?? assessment.materiality;
  const materialityFloor = deterministicMarketMaterialityFloor(assessment, context);
  const marketMateriality = Math.max(modelMarketMateriality, materialityFloor);
  const evidenceConfidence = assessment.evidenceConfidence ?? assessment.confidence;
  const scientificSignificance = assessment.scientificSignificance ?? endpointSignificance(assessment);
  const regulatorySignificance = assessment.regulatorySignificance
    ?? (["regulatory_decision", "regulatory_update"].includes(assessment.eventType) ? assessment.materiality : 20);
  const highMinMateriality = config.highMinMateriality ?? 70;
  const highMinConfidence = config.highMinConfidence ?? 0.8;
  const evidenceQuality = profile.hasDirectPrimary ? 100
    : profile.hasPrimary ? 92
      : profile.hasIndependentCorroboration ? 78
        : context.item.source.tier === "secondary" ? 52 : 20;
  const eventSignificance = Math.max(endpointSignificance(assessment), scientificSignificance, regulatorySignificance);
  const directionStrength = assessment.stockDirection === "bullish"
    ? assessment.probabilityPositiveMove * 100
    : assessment.stockDirection === "bearish"
      ? (1 - assessment.probabilityPositiveMove) * 100
      : 30;
  const rawScore = marketMateriality * 0.4
    + Math.min(assessment.confidence, evidenceConfidence) * 100 * 0.15
    + evidenceQuality * 0.2
    + eventSignificance * 0.15
    + directionStrength * 0.1;
  const penalty = (assessment.requiresHumanReview ? 10 : 0)
    + (assessment.noveltyVsPriorDisclosure === "repeated" ? 20 : 0)
    + (assessment.safetyAssessment === "concerning" && assessment.stockDirection === "bullish" ? 18 : 0);
  const score = Math.round(clamp(rawScore - penalty, 0, 100));
  if (materialityFloor > 0 && materialityFloor >= modelMarketMateriality) {
    reasons.push(`deterministic market-materiality floor ${materialityFloor} applied for multiple completed lead-asset small-cap regulatory actions`);
  }
  const rangeConsistent = assessment.expectedMoveLowPct <= assessment.expectedMoveBasePct
    && assessment.expectedMoveBasePct <= assessment.expectedMoveHighPct;
  const positiveSafetyReady = assessment.eventType === "regulatory_decision"
    ? assessment.safetyAssessment !== "concerning"
    : ["favorable", "manageable"].includes(assessment.safetyAssessment);
  const severeNegativeUrgent = SEVERE_NEGATIVE_EVENT_TYPES.has(assessment.eventType)
    && hasSevereNegativeSignal(context)
    && profile.hasPrimary
    && marketMateriality >= 75
    && assessment.confidence >= 0.8
    && evidenceConfidence >= 0.8
    && assessment.stockDirection === "bearish"
    && ["negative", "mixed"].includes(assessment.resultDirection)
    && assessment.probabilityPositiveMove <= 0.35
    && assessment.expectedMoveBasePct < 0
    && assessment.expectedMoveHighPct < 0
    && rangeConsistent
    && !assessment.requiresHumanReview
    && assessment.noveltyVsPriorDisclosure === "new"
    && assessment.evidence.length > 0;
  const severeNegativeHigh = SEVERE_NEGATIVE_EVENT_TYPES.has(assessment.eventType)
    && hasSevereNegativeSignal(context)
    && (profile.hasPrimary || profile.hasIndependentCorroboration)
    && marketMateriality >= 75
    && assessment.confidence >= 0.8
    && evidenceConfidence >= 0.8
    && assessment.stockDirection === "bearish"
    && ["negative", "mixed"].includes(assessment.resultDirection)
    && assessment.expectedMoveBasePct < 0
    && assessment.expectedMoveHighPct < 0
    && rangeConsistent
    && assessment.noveltyVsPriorDisclosure === "new"
    && assessment.evidence.length > 0;

  if (!assessment.isBiotechCatalyst) reasons.push("not classified as a biotech catalyst");
  if (!assessment.ticker) reasons.push("no public-company ticker established");
  else if (!tickerMapped) reasons.push("ticker is not mapped to the configured watchlist");
  if (!profile.hasPrimary && !profile.hasIndependentCorroboration) reasons.push("no primary evidence or independent non-social corroboration");
  if (context.item.source.tier === "social" && !profile.hasPrimary && !profile.hasIndependentCorroboration) {
    reasons.push("social-only evidence cannot escalate");
  }

  if (!assessment.isBiotechCatalyst || !assessment.ticker) return { score, tier: "none", reasons, effectiveMarketMateriality: marketMateriality };
  if (method !== "openai") {
    reasons.push("demo heuristic is hard-blocked from high-priority alerts");
    return { score: Math.min(score, 49), tier: "watch", reasons, effectiveMarketMateriality: marketMateriality };
  }
  if (!tickerMapped) return { score: Math.min(score, 69), tier: "watch", reasons, effectiveMarketMateriality: marketMateriality };
  if (severeNegativeUrgent) {
    reasons.push("passed primary-source severe negative catalyst escalation gate");
    return { score, tier: "urgent", reasons, effectiveMarketMateriality: marketMateriality };
  }
  if (severeNegativeHigh) {
    reasons.push("passed severe negative high-priority gate");
    return { score, tier: "high", reasons, effectiveMarketMateriality: marketMateriality };
  }

  if (!HIGH_EVENT_TYPES.has(assessment.eventType)) reasons.push("event type is not eligible for high-priority escalation");
  if (marketMateriality < highMinMateriality) reasons.push(`market materiality ${marketMateriality} is below high threshold ${highMinMateriality}`);
  if (assessment.confidence < highMinConfidence) reasons.push(`confidence ${assessment.confidence.toFixed(2)} is below high threshold ${highMinConfidence.toFixed(2)}`);
  if (evidenceConfidence < highMinConfidence) reasons.push(`evidence confidence ${evidenceConfidence.toFixed(2)} is below high threshold ${highMinConfidence.toFixed(2)}`);
  if (assessment.requiresHumanReview) reasons.push("analysis explicitly requires human review");
  if (["repeated", "unknown"].includes(assessment.noveltyVsPriorDisclosure)) reasons.push("announcement is not clearly new");
  if (!rangeConsistent) reasons.push("stock-move scenario range is internally inconsistent");
  if (assessment.stockDirection === "bullish" && !positiveSafetyReady) reasons.push("safety evidence is insufficient for positive urgent escalation");
  if (assessment.evidence.length === 0) reasons.push("analysis returned no quoted or paraphrased evidence");

  const concreteIncremental = assessment.noveltyVsPriorDisclosure === "incremental"
    && ["completed", "agency_confirmed"].includes(assessment.actionStatus ?? "unknown")
    && marketMateriality >= highMinMateriality + 5;
  const high = HIGH_EVENT_TYPES.has(assessment.eventType)
    && marketMateriality >= highMinMateriality
    && assessment.confidence >= highMinConfidence
    && evidenceConfidence >= highMinConfidence
    && (profile.hasPrimary || profile.hasIndependentCorroboration)
    && (assessment.noveltyVsPriorDisclosure === "new" || concreteIncremental)
    && assessment.evidence.length > 0;
  if (!high) return { score, tier: score >= 55 ? "watch" : "none", reasons, effectiveMarketMateriality: marketMateriality };

  const positiveUrgent = assessment.stockDirection === "bullish"
    && assessment.resultDirection === "positive"
    && assessment.probabilityPositiveMove >= 0.75
    && assessment.expectedMoveBasePct > 0
    && rangeConsistent
    && !assessment.requiresHumanReview
    && positiveSafetyReady
    && assessment.evidence.length > 0
    && assessment.disconfirmingEvidence.length === 0
    && marketMateriality >= config.minMateriality
    && assessment.confidence >= config.minConfidence
    && evidenceConfidence >= config.minConfidence
    && (
      assessment.eventType === "regulatory_decision"
      || (assessment.eventType === "trial_topline"
        && assessment.primaryEndpointMet === "yes"
        && ["strong", "moderate"].includes(assessment.statisticalStrength))
    );
  if (positiveUrgent) {
    reasons.push("passed conservative positive-catalyst escalation gate");
    return { score, tier: "urgent", reasons, effectiveMarketMateriality: marketMateriality };
  }

  if (assessment.disconfirmingEvidence.length > 0) reasons.push("disconfirming evidence prevents positive urgent escalation");
  reasons.push("market-material event passed the high-priority gate but not the urgent gate");
  return { score, tier: "high", reasons, effectiveMarketMateriality: marketMateriality };
}

function endpointSignificance(assessment: ImpactAssessment): number {
  if (assessment.eventType === "regulatory_decision") return 100;
  if (assessment.primaryEndpointMet === "yes") return assessment.statisticalStrength === "strong" ? 100 : 82;
  if (assessment.primaryEndpointMet === "partial") return 50;
  return 20;
}

function hasSevereNegativeSignal(context: EvidenceContext): boolean {
  return [context.item, ...context.corroboratingItems].some((item) => {
    const text = `${item.headline}\n${item.summary.slice(0, 6_000)}`;
    return SEVERE_NEGATIVE_SIGNALS.some((pattern) => pattern.test(text));
  });
}

function deterministicMarketMaterialityFloor(
  assessment: ImpactAssessment,
  context: EvidenceContext,
): number {
  if (!context.company || !["micro", "small"].includes(context.company.marketCapBand)) return 0;
  if (!["lead", "core"].includes(assessment.assetImportance ?? "unknown")) return 0;
  if (!["completed", "agency_confirmed"].includes(assessment.actionStatus ?? "unknown")) return 0;
  if (!["regulatory_update", "regulatory_decision"].includes(assessment.eventType)) return 0;
  const text = [context.item, ...context.corroboratingItems]
    .map((item) => `${item.headline}\n${item.summary}`)
    .join("\n");
  const completedActions = [
    /\bsubmitted all [^\n.]{0,80}\bdata\b[^\n.]{0,100}\b(?:FDA|IND)\b/i.test(text),
    /\b(?:submitted|filed) (?:a |the )?formal (?:FDA |EMA )?(?:meeting|Type [ABCD]) request\b/i.test(text),
    /\b(?:(?:IND|NDA|BLA|MAA|sNDA|sBLA)\b.{0,30}\b(?:was |has been )?(?:submitted|filed|accepted|cleared)|(?:submitted|filed|accepted|cleared) (?:an? |the )?(?:IND|NDA|BLA|MAA|sNDA|sBLA)\b)/i.test(text),
  ].filter(Boolean).length;
  return completedActions >= 2 ? 76 : 0;
}
