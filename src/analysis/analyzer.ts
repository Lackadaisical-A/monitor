import type { EvidenceContext, ImpactAssessment } from "../types.js";

export interface AnalyzerResult {
  assessment: ImpactAssessment;
  method: "openai" | "heuristic_demo";
  model: string;
}

export interface CatalystAnalyzer {
  analyze(context: EvidenceContext): Promise<AnalyzerResult>;
}
