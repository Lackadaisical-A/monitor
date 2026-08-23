import { z } from "zod";

export const SourceTypeSchema = z.enum([
  "company_ir",
  "regulator",
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

export const CatalystEventTypeSchema = z.enum([
  "trial_topline",
  "trial_update",
  "regulatory_decision",
  "regulatory_update",
  "safety_signal",
  "publication",
  "financing",
  "partnership",
  "other",
]);
export type CatalystEventType = z.infer<typeof CatalystEventTypeSchema>;

export const ImpactAssessmentSchema = z.object({
  isBiotechCatalyst: z.boolean(),
  companyName: z.string(),
  ticker: z.string(),
  eventType: CatalystEventTypeSchema,
  trialPhase: z.enum(["preclinical", "phase_1", "phase_1_2", "phase_2", "phase_2_3", "phase_3", "post_market", "not_applicable", "unknown"]),
  trialName: z.string(),
  indication: z.string(),
  resultDirection: z.enum(["positive", "mixed", "negative", "unclear"]),
  stockDirection: z.enum(["bullish", "neutral", "bearish", "unclear"]),
  materiality: z.number().int().min(0).max(100).describe(
    "Stock-catalyst materiality on a 0-100 scale: 0 irrelevant, 50 meaningful but usually incremental, 75 material, 90+ potentially market-moving Phase 3 topline or regulatory decision.",
  ),
  confidence: z.number().min(0).max(1).describe(
    "Confidence from 0 to 1 in the factual event classification and directional scenario, not the probability that a trade is profitable.",
  ),
  probabilityPositiveMove: z.number().min(0).max(1).describe(
    "Conditional probability from 0 to less than 1 that the first material market reaction is positive, given only the supplied evidence.",
  ),
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
  disconfirmingEvidence: z.array(z.string()).max(8).describe(
    "Only supplied facts that contradict or materially weaken the directional interpretation. Missing details belong in uncertainty, not here.",
  ),
  requiresHumanReview: z.boolean().describe(
    "True only when conflicting evidence, uncertain source authenticity, endpoint ambiguity, or a material safety ambiguity could reverse the classification. Missing detailed statistics alone is not sufficient when an authentic primary release clearly reports a prespecified endpoint result.",
  ),
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

export type AccessLevel = "free" | "pro" | "developer";

export interface InstallationAccess {
  installationId: string;
  level: AccessLevel;
  pro: boolean;
  productId: string | null;
  expiresAt: string | null;
  source: "free" | "app_store" | "developer";
}

export const FeedModeSchema = z.enum(["all", "watchlist"]);
export type FeedMode = z.infer<typeof FeedModeSchema>;

export const PushModeSchema = z.enum(["all", "watchlist"]);
export type PushMode = z.infer<typeof PushModeSchema>;

export interface InstallationPreferences {
  installationId: string;
  watchedTickers: string[];
  feedMode: FeedMode;
  pushMode: PushMode;
  eventTypes: CatalystEventType[];
  updatedAt: string | null;
}

export interface CompanyCoverage {
  sec: boolean;
  clinicalTrials: boolean;
  pressReleases: boolean;
  companyIr: boolean;
  programMetadata: boolean;
  level: "core" | "strong" | "complete";
}

export interface StoreTransactionEntitlement {
  installationId?: string;
  productId: string;
  originalTransactionId: string;
  transactionId: string;
  expiresAt: string;
  environment: "Sandbox" | "Production";
  revoked: boolean;
}

export interface FeedEntry {
  item: NormalizedItem;
  analysis: AnalysisRecord | null;
  corroborationCount: number;
  alertedAt: string | null;
}
