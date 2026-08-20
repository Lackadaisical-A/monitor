import type { EvidenceContext, ImpactAssessment } from "../types.js";
import { clamp } from "../utils.js";
import type { AnalyzerResult, CatalystAnalyzer } from "./analyzer.js";

export class HeuristicDemoAnalyzer implements CatalystAnalyzer {
  async analyze(context: EvidenceContext): Promise<AnalyzerResult> {
    const text = `${context.item.headline}\n${context.item.summary}`;
    const lower = text.toLowerCase();
    const phase = detectPhase(lower);
    const negative = /\b(did not meet|failed|missed (?:the )?primary|terminated|clinical hold|death|deaths|fatal|concerning safety|complete response letter|crl)\b/i.test(text);
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
      isBiotechCatalyst: /\b(clinical|trial|phase|fda|endpoint|topline|top-line|efficacy|safety)\b/i.test(text),
      companyName,
      ticker,
      eventType: /fda|regulatory|complete response letter|crl/i.test(text)
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
    };
    return { assessment, method: "heuristic_demo", model: "heuristic-demo-v1" };
  }
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
