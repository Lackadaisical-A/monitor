import type { EvidenceContext, ImpactAssessment } from "../types.js";
import { clamp } from "../utils.js";
import type { AnalyzerResult, CatalystAnalyzer } from "./analyzer.js";

export class HeuristicDemoAnalyzer implements CatalystAnalyzer {
  async analyze(context: EvidenceContext): Promise<AnalyzerResult> {
    const text = `${context.item.headline}\n${context.item.summary}`;
    const lower = text.toLowerCase();
    const phase = detectPhase(lower);
    const crlAction = hasCrlAction(text);
    const negative = /\b(did not meet|failed|missed (?:the )?primary|terminated|clinical hold|death|deaths|fatal|concerning safety|complete response letter)\b/i.test(text)
      || crlAction;
    const positive = /\b(met (?:the )?primary endpoint|statistically significant|fda approv|positive topline|positive top-line|reduced (?:the )?risk|overall survival benefit)\b/i.test(text);
    const primaryEndpointMet: ImpactAssessment["primaryEndpointMet"] = negative && /primary/.test(lower)
      ? "no"
      : positive && /primary endpoint/.test(lower)
        ? "yes"
        : "not_reported";
    const resultDirection: ImpactAssessment["resultDirection"] = negative && positive ? "mixed" : negative ? "negative" : positive ? "positive" : "unclear";
    const stockDirection: ImpactAssessment["stockDirection"] = resultDirection === "positive" ? "bullish" : resultDirection === "negative" ? "bearish" : "unclear";
    const baseMateriality = phase === "phase_3" ? 78 : phase === "phase_2" || phase === "phase_2_3" ? 65 : phase === "phase_1" || phase === "phase_1_2" ? 45 : 35;
    const materiality = clamp(baseMateriality + (positive || negative ? 8 : 0), 0, 86);
    const magnitude = phase === "phase_3" ? 18 : phase === "phase_2" || phase === "phase_2_3" ? 12 : 6;
    const sign = stockDirection === "bearish" ? -1 : stockDirection === "bullish" ? 1 : 0;
    const companyName = context.company?.company ?? context.item.companyHint ?? "";
    const ticker = context.company?.ticker ?? context.item.tickerHint ?? "";
    const expectedLow = sign < 0 ? -Math.round(magnitude * 1.8) : sign * Math.round(magnitude * 0.35);
    const expectedHigh = sign < 0 ? -Math.round(magnitude * 0.35) : sign * Math.round(magnitude * 1.8);
    const assessment: ImpactAssessment = {
      isBiotechCatalyst: /\b(clinical|trial|phase|fda|endpoint|topline|top-line|efficacy|safety)\b/i.test(text) || crlAction,
      companyName,
      ticker,
      eventType: /fda|regulatory|complete response letter/i.test(text) || crlAction
        ? "regulatory_update"
        : /topline|top-line|results?|endpoint/i.test(text)
          ? "trial_topline"
          : "trial_update",
      trialPhase: phase,
      trialName: extractFirst(text, /\b(?:study|trial)\s+([A-Z][A-Za-z0-9-]{2,20})\b/) ?? "",
      indication: "",
      resultDirection,
      stockDirection,
      materiality,
      confidence: 0.4,
      probabilityPositiveMove: stockDirection === "bullish" ? 0.6 : stockDirection === "bearish" ? 0.25 : 0.5,
      expectedMoveLowPct: expectedLow,
      expectedMoveBasePct: sign * magnitude,
      expectedMoveHighPct: expectedHigh,
      timeHorizon: "next_session",
      primaryEndpointMet,
      statisticalStrength: /statistically significant|p\s*</i.test(text) ? "moderate" : "not_reported",
      safetyAssessment: /well.tolerated|favorable safety|no new safety/i.test(text) ? "favorable" : /death|fatal|concerning safety|clinical hold/i.test(text) ? "concerning" : "not_reported",
      noveltyVsPriorDisclosure: "unknown",
      rationale: "Demo keyword heuristic only. Configure OPENAI_API_KEY for evidence-aware structured analysis.",
      evidence: [context.item.headline],
      uncertainty: ["No model-based analysis was run.", "Headline keywords cannot establish trial validity or likely market reaction."],
      disconfirmingEvidence: [],
      requiresHumanReview: true,
      marketMateriality: materiality,
      scientificSignificance: positive || negative ? materiality : Math.min(materiality, 35),
      regulatorySignificance: /fda|regulatory|complete response letter/i.test(text) || crlAction ? materiality : 10,
      evidenceConfidence: 0.4,
      actionStatus: /\b(?:approved|granted|submitted|filed|completed|met|failed|clinical hold)\b/i.test(text)
        ? "completed"
        : /\b(?:plans?|expects?|intends?|will)\b/i.test(text) ? "planned" : "unknown",
      assetImportance: "unknown",
      valuationImpact: materiality >= 70 ? "material" : materiality >= 50 ? "moderate" : "limited",
      eventSignature: [ticker, extractFirst(text, /\b([A-Z]{2,8}-?\d{2,6})\b/) ?? "", assessmentEventToken(text)].filter(Boolean).join("-").toLowerCase(),
      noveltySummary: "Demo mode cannot compare the item reliably with prior disclosures.",
    };
    return { assessment, method: "heuristic_demo", model: "heuristic-demo-v1" };
  }
}

function assessmentEventToken(text: string): string {
  if (/clinical hold/i.test(text)) return "clinical-hold";
  if (/complete response letter/i.test(text) || hasCrlAction(text)) return "regulatory-rejection";
  if (/approved|approval/i.test(text)) return "approval";
  if (/primary endpoint|topline|top-line/i.test(text)) return "trial-results";
  return "update";
}

function hasCrlAction(text: string): boolean {
  return /\b(?:receive[ds]?|issue[ds]?|gets?|got|hit with) (?:an? )?crl\b/i.test(text)
    || /\b(?:fda\b.{0,40}\bcrl|crl\b.{0,40}\b(?:from|by) (?:the )?fda)\b/i.test(text);
}

function detectPhase(text: string): ImpactAssessment["trialPhase"] {
  if (/phase\s*(?:2\s*\/\s*3|ii\s*\/\s*iii|2b\s*\/\s*3)/i.test(text)) return "phase_2_3";
  if (/phase\s*(?:1\s*\/\s*2|i\s*\/\s*ii|1b\s*\/\s*2)/i.test(text)) return "phase_1_2";
  if (/phase\s*(?:3|iii)\b/i.test(text)) return "phase_3";
  if (/phase\s*(?:2|ii)\b/i.test(text)) return "phase_2";
  if (/phase\s*(?:1|i)\b/i.test(text)) return "phase_1";
  if (/preclinical/i.test(text)) return "preclinical";
  return "unknown";
}

function extractFirst(text: string, regex: RegExp): string | null {
  return regex.exec(text)?.[1] ?? null;
}
