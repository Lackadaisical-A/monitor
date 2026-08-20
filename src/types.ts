import { z } from "zod";

export const SourceTypeSchema = z.enum([
  "company_ir",
  "sec",
  "clinical_trials",
  "outlet",
  "x",
  "reddit",
]);
export type SourceType = z.infer<typeof SourceTypeSchema>;

export const SourceTierSchema = z.enum(["primary", "secondary", "social"]);
export type SourceTier = z.infer<typeof SourceTierSchema>;

export interface SourceDescriptor {
  id: string;
  name: string;
  type: SourceType;
  tier: SourceTier;
}

export interface NormalizedItem {
  id: string;
  externalId: string;
  source: SourceDescriptor;
  headline: string;
  summary: string;
  url: string;
  author: string | null;
  publishedAt: string;
  discoveredAt: string;
  companyHint: string | null;
  tickerHint: string | null;
  raw: unknown;
}

export interface WatchCompany {
  ticker: string;
  company: string;
  aliases: string[];
  cik?: string | undefined;
  marketCapBand: "micro" | "small" | "mid" | "large" | "mega" | "unknown";
  xAccounts: string[];
  programs: string[];
}

export const ImpactAssessmentSchema = z.object({
  isBiotechCatalyst: z.boolean(),
  companyName: z.string(),
  ticker: z.string(),
  eventType: z.enum([
    "trial_topline",
    "trial_update",
    "regulatory_decision",
    "regulatory_update",
    "safety_signal",
    "publication",
    "financing",
    "partnership",
    "other",
  ]),
  trialPhase: z.enum(["preclinical", "phase_1", "phase_1_2", "phase_2", "phase_2_3", "phase_3", "post_market", "not_applicable", "unknown"]),
  trialName: z.string(),
  indication: z.string(),
  resultDirection: z.enum(["positive", "mixed", "negative", "unclear"]),
  stockDirection: z.enum(["bullish", "neutral", "bearish", "unclear"]),
  materiality: z.number().int().min(0).max(100),
  confidence: z.number().min(0).max(1),
  probabilityPositiveMove: z.number().min(0).max(1),
  expectedMoveLowPct: z.number().min(-100).max(500),
  expectedMoveBasePct: z.number().min(-100).max(500),
  expectedMoveHighPct: z.number().min(-100).max(500),
  timeHorizon: z.enum(["intraday", "next_session", "one_week", "longer_term", "unknown"]),
  primaryEndpointMet: z.enum(["yes", "no", "partial", "not_reported", "not_applicable"]),
  statisticalStrength: z.enum(["strong", "moderate", "weak", "not_reported", "not_applicable"]),
  safetyAssessment: z.enum(["favorable", "manageable", "concerning", "not_reported", "not_applicable"]),
  noveltyVsPriorDisclosure: z.enum(["new", "incremental", "repeated", "unknown"]),
  rationale: z.string(),
  evidence: z.array(z.string()).max(8),
  uncertainty: z.array(z.string()).max(8),
  disconfirmingEvidence: z.array(z.string()).max(8),
  requiresHumanReview: z.boolean(),
});
export type ImpactAssessment = z.infer<typeof ImpactAssessmentSchema>;

export type AnalysisMethod = "openai" | "heuristic_demo";
export type AlertTier = "none" | "watch" | "high" | "urgent";

export interface AnalysisRecord {
  itemId: string;
  model: string;
  method: AnalysisMethod;
  assessment: ImpactAssessment;
  policyScore: number;
  alertTier: AlertTier;
  policyReasons: string[];
  createdAt: string;
}

export interface EvidenceContext {
  item: NormalizedItem;
  corroboratingItems: NormalizedItem[];
  company: WatchCompany | null;
}

export interface SourceFetchResult {
  items: NormalizedItem[];
  cursor?: string | undefined;
  diagnostics?: Record<string, unknown> | undefined;
}

export interface SourceAdapter {
  descriptor: SourceDescriptor;
  fetch(cursor: string | null): Promise<SourceFetchResult>;
}

export interface DeviceRegistration {
  installationId: string;
  deviceToken: string;
  environment: "sandbox" | "production";
  timeSensitiveAuthorized: boolean;
  criticalAuthorized: boolean;
}

export interface FeedEntry {
  item: NormalizedItem;
  analysis: AnalysisRecord | null;
  corroborationCount: number;
  alertedAt: string | null;
}
