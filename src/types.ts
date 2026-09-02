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

export type SourceProvenance =
  | "direct_primary"
  | "syndicated_primary"
  | "independent_reporting"
  | "registry"
  | "social"
  | "unknown";

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
  provenance?: SourceProvenance | undefined;
  independenceKey?: string | undefined;
  raw: unknown;
}

export interface WatchCompany {
  ticker: string;
  company: string;
  aliases: string[];
  cik?: string | undefined;
  marketCapBand: "micro" | "small" | "mid" | "large" | "mega" | "unknown";
  marketCapUsd?: number | undefined;
  averageDailyDollarVolume?: number | undefined;
  annualizedVolatilityPct?: number | undefined;
  metadataUpdatedAt?: string | undefined;
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

export const TimelineDatePrecisionSchema = z.enum(["exact", "month", "quarter", "half", "year"]);
export type TimelineDatePrecision = z.infer<typeof TimelineDatePrecisionSchema>;

export const FutureMilestoneSchema = z.object({
  title: z.string().min(1).max(220),
  eventType: CatalystEventTypeSchema,
  program: z.string().max(160),
  indication: z.string().max(200),
  expectedDate: z.string().describe(
    "ISO 8601 date for the end of the explicitly stated guidance window.",
  ),
  datePrecision: TimelineDatePrecisionSchema,
  dateLabel: z.string().min(1).max(80),
  expectedDirection: z.enum(["positive", "mixed", "negative", "unclear"]),
  expectedOutcome: z.string().max(500),
  anticipatedMateriality: z.number().int().min(0).max(100),
  expectedSuccessProbability: z.number().min(0).max(1).nullable(),
  expectationConfidence: z.number().min(0).max(1),
  sourceEvidence: z.string().min(1).max(500),
});
export type FutureMilestone = z.infer<typeof FutureMilestoneSchema>;

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
  marketMateriality: z.number().int().min(0).max(100).optional().describe(
    "Expected public-company valuation relevance, independent of whether the event contains clinical efficacy data.",
  ),
  scientificSignificance: z.number().int().min(0).max(100).optional().describe(
    "Strength and importance of new scientific or clinical evidence; procedural and financial events can score low here while remaining market-material.",
  ),
  regulatorySignificance: z.number().int().min(0).max(100).optional().describe(
    "Importance of a completed regulator-facing action or agency outcome, distinct from scientific evidence strength.",
  ),
  evidenceConfidence: z.number().min(0).max(1).optional().describe(
    "Confidence that the supplied evidence is authentic, attributable, and correctly interpreted.",
  ),
  actionStatus: z.enum([
    "agency_confirmed",
    "completed",
    "in_progress",
    "planned",
    "retrospective",
    "unknown",
  ]).optional(),
  assetImportance: z.enum(["lead", "core", "non_core", "not_applicable", "unknown"]).optional(),
  valuationImpact: z.enum(["transformative", "material", "moderate", "limited", "unknown"]).optional(),
  eventSignature: z.string().max(160).optional().describe(
    "Short stable identifier for the underlying event, excluding publisher, timestamp, and article framing.",
  ),
  noveltySummary: z.string().max(600).optional().describe(
    "What is newly completed or agency-confirmed versus prior disclosures supplied in context.",
  ),
  futureMilestones: z.array(FutureMilestoneSchema).max(6).optional().describe(
    "Explicitly guided future clinical, regulatory, or data milestones in the current evidence.",
  ),
});
export type ImpactAssessment = z.infer<typeof ImpactAssessmentSchema>;

export const ImpactAssessmentOutputSchema = ImpactAssessmentSchema.extend({
  marketMateriality: z.number().int().min(0).max(100),
  scientificSignificance: z.number().int().min(0).max(100),
  regulatorySignificance: z.number().int().min(0).max(100),
  evidenceConfidence: z.number().min(0).max(1),
  actionStatus: z.enum([
    "agency_confirmed",
    "completed",
    "in_progress",
    "planned",
    "retrospective",
    "unknown",
  ]),
  assetImportance: z.enum(["lead", "core", "non_core", "not_applicable", "unknown"]),
  valuationImpact: z.enum(["transformative", "material", "moderate", "limited", "unknown"]),
  eventSignature: z.string().max(160),
  noveltySummary: z.string().max(600),
  futureMilestones: z.array(FutureMilestoneSchema).max(6),
});

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
  eventKey?: string | undefined;
  eventAnchorAt?: string | undefined;
  analysisVersion?: number | undefined;
}

export interface EvidenceContext {
  item: NormalizedItem;
  corroboratingItems: NormalizedItem[];
  company: WatchCompany | null;
  priorItems?: NormalizedItem[] | undefined;
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
  attentionSoundsSupported: boolean;
}

export type AccessLevel = "free" | "pro" | "developer";

export interface InstallationAccess {
  installationId: string;
  level: AccessLevel;
  pro: boolean;
  clubAccess: boolean;
  productId: string | null;
  expiresAt: string | null;
  source: "free" | "app_store" | "developer";
}

export const ClubContactTypeSchema = z.enum(["phone", "instagram"]);
export type ClubContactType = z.infer<typeof ClubContactTypeSchema>;

export const ClubGradeSchema = z.enum([
  "first_year",
  "sophomore",
  "junior",
  "senior",
  "graduate",
  "alumni",
  "other",
]);
export type ClubGrade = z.infer<typeof ClubGradeSchema>;

export const ClubCardTechnologySchema = z.enum(["mifare", "iso7816", "iso15693", "felica"]);
export type ClubCardTechnology = z.infer<typeof ClubCardTechnologySchema>;

export interface ClubMemberProfile {
  name: string;
  age: number;
  contactType: ClubContactType;
  contact: string;
  grade: ClubGrade;
}

export interface ClubMember extends ClubMemberProfile {
  id: string;
  cardHint: string;
  tagTechnology: ClubCardTechnology;
  consentedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface ClubCheckIn {
  id: string;
  eventId: string;
  memberId: string;
  checkedInAt: string;
  member: ClubMember;
}

export interface ClubEvent {
  id: string;
  title: string;
  startedAt: string;
  endedAt: string | null;
  checkInCount: number;
  createdAt: string;
}

export interface ClubEventDetail extends ClubEvent {
  checkIns: ClubCheckIn[];
}

export interface ClubDashboard {
  activeEvent: ClubEventDetail | null;
  recentEvents: ClubEvent[];
}

export interface ClubAttendanceSnapshot {
  members: Array<{
    id: string;
    name: string;
    createdAt: string;
  }>;
  meetings: Array<{
    id: string;
    title: string;
    startedAt: string;
    endedAt: string | null;
  }>;
  checkIns: Array<{
    eventId: string;
    memberId: string;
  }>;
}

export interface ClubCardCheckInInput {
  eventId: string;
  cardIdentifier: string;
  tagTechnology: ClubCardTechnology;
  profile?: ClubMemberProfile | undefined;
  installationId: string;
}

export type ClubCardCheckInResult =
  | { status: "registration_required"; cardHint: string; member: null; checkIn: null }
  | { status: "checked_in" | "already_checked_in"; cardHint: string; member: ClubMember; checkIn: ClubCheckIn }
  | { status: "event_unavailable"; cardHint: string; member: null; checkIn: null };

export const FeedModeSchema = z.enum(["all", "watchlist"]);
export type FeedMode = z.infer<typeof FeedModeSchema>;

export const PushModeSchema = z.enum(["all", "watchlist"]);
export type PushMode = z.infer<typeof PushModeSchema>;

export const AlertPrioritySchema = z.enum(["high", "urgent"]);
export type AlertPriority = z.infer<typeof AlertPrioritySchema>;

export interface InstallationPreferences {
  installationId: string;
  watchedTickers: string[];
  feedMode: FeedMode;
  pushMode: PushMode;
  minimumAlertTier: AlertPriority;
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
  marketMovement?: StockMovement | null;
}

export interface StockMovement {
  ticker: string;
  sessionDate: string;
  status: "live" | "closed";
  announcementAt: string;
  priceStartAt: string;
  priceEndAt: string;
  cutoffAt: string;
  window: "since_announcement" | "five_day";
  refreshIntervalSeconds: number;
  previousClose: number;
  open: number;
  high: number;
  low: number;
  close: number;
  change: number;
  changePct: number;
  fetchedAt: string;
  feed: "iex" | "sip";
  provider: "alpaca";
  basis: "pre_announcement_price";
}

export interface OutcomeAudit {
  eventKey: string;
  itemId: string;
  ticker: string;
  eventType: CatalystEventType;
  alertTier: AlertTier;
  predictedDirection: ImpactAssessment["stockDirection"];
  probabilityPositiveMove: number;
  expectedMoveLowPct: number;
  expectedMoveBasePct: number;
  expectedMoveHighPct: number;
  initialMateriality: number;
  actualReturnPct: number;
  benchmarkReturnPct: number | null;
  benchmarkBasis: "xbi_spy" | "xbi" | "spy" | "unavailable";
  abnormalReturnPct: number | null;
  marketSurpriseScore: number;
  surpriseAdjustedMateriality: number;
  directionCorrect: boolean | null;
  abnormalDirectionCorrect: boolean | null;
  expectedRangeHit: boolean;
  movementWindow: StockMovement["window"];
  status: StockMovement["status"];
  priceStartAt: string;
  priceEndAt: string;
  auditedAt: string;
  calibrationVersion: number;
}

export type TimelineEventStatus = "upcoming" | "completed";
export type TimelineEventBasis = "announced" | "company_guidance" | "registry_schedule";

export interface TimelineEvent {
  id: string;
  status: TimelineEventStatus;
  basis: TimelineEventBasis;
  ticker: string;
  companyName: string;
  program: string;
  indication: string;
  eventType: CatalystEventType;
  trialPhase: ImpactAssessment["trialPhase"];
  title: string;
  summary: string;
  eventDate: string;
  initialEventDate: string;
  datePrecision: TimelineDatePrecision;
  dateLabel: string;
  sourceName: string;
  sourceUrl: string;
  sourceTier: SourceTier;
  itemId: string | null;
  eventKey: string | null;
  alertTier: AlertTier | null;
  initialMateriality: number | null;
  anticipatedMateriality: number | null;
  confidence: number | null;
  expectedDirection: ImpactAssessment["resultDirection"] | null;
  expectedOutcome: string | null;
  expectedSuccessProbability: number | null;
  expectationConfidence: number | null;
  expectationAsOf: string | null;
  resultDirection: ImpactAssessment["resultDirection"] | null;
  expectationEventId: string | null;
  resolvedByEventId: string | null;
  clinicalSurpriseScore: number | null;
  outcome: OutcomeAudit | null;
  createdAt: string;
  updatedAt: string;
}
