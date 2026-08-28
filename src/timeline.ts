import { createHash } from "node:crypto";
import type {
  AnalysisRecord,
  CatalystEventType,
  FutureMilestone,
  ImpactAssessment,
  NormalizedItem,
  TimelineDatePrecision,
  TimelineEvent,
} from "./types.js";

const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
] as const;
const MONTH_PATTERN = MONTHS.map((month) => `${month.slice(0, 3)}(?:${month.slice(3)})?`).join("|");
const MILESTONE_CUE = /\b(?:pdufa|target action date|fda action|fda decision|advisory committee|adcom|priority review|accepted for review|topline|top-line|readout|results?|data|ind|nda|bla|submission|resubmission|filing|primary completion|study completion|enrollment|first patient|dose)\b/i;
const FUTURE_CUE = /\b(?:expect(?:s|ed)?|anticipat(?:e|es|ed)|plan(?:s|ned)?|intend(?:s|ed)?|scheduled|target(?:s|ed)?|assign(?:s|ed)?|establish(?:es|ed)?|remain(?:s|ed)?|set|sets|on track|due|will|guidance)\b/i;
const DECISION_DATE_CUE = /\b(?:pdufa(?: target action)? date|target action date)\b/i;
const BOILERPLATE = /\b(?:forward-looking statements?|safe harbor|risks and uncertainties|may differ materially|sec filings?)\b/i;
const ROUTINE_EVENT = /\b(?:conference|symposium|presentation|webcast|fireside chat|investor event)\b/i;
const SUBSTANTIVE_EVENT = /\b(?:topline|top-line|readout|clinical trial results?|new (?:clinical )?data|pdufa|fda (?:action|decision)|submission|resubmission|filing)\b/i;
const INACTIVE_STUDY_STATUSES = new Set(["COMPLETED", "TERMINATED", "WITHDRAWN", "SUSPENDED"]);
const TRUSTED_CALENDAR_SOURCE_TYPES = new Set(["company_ir", "regulator", "sec"]);

interface CalendarIdentity {
  ticker: string;
  companyName: string;
  trialPhase: ImpactAssessment["trialPhase"];
  program: string;
  indication: string;
  createdAt: string;
}

export function timelineEventsFromAnalysis(
  item: NormalizedItem,
  analysis: AnalysisRecord,
): TimelineEvent[] {
  const assessment = analysis.assessment;
  if (!assessment.isBiotechCatalyst || !assessment.ticker.trim()) return [];
  const events: TimelineEvent[] = [];
  if (analysis.alertTier !== "none") events.push(completedEvent(item, analysis));
  const identity = calendarIdentity(item, analysis);

  const future = [
    ...registryMilestones(item, identity),
    ...(assessment.futureMilestones ?? []).flatMap((milestone) => modelMilestone(item, identity, milestone)),
    ...extractGuidedMilestones(item, identity),
  ];
  events.push(...deduplicateFutureEvents(future));
  return events;
}

export function timelineEventsFromItem(item: NormalizedItem): TimelineEvent[] {
  const identity = calendarIdentity(item);
  if (!identity.ticker) return [];
  if (item.source.type === "clinical_trials") {
    return deduplicateFutureEvents(registryMilestones(item, identity));
  }
  if (!TRUSTED_CALENDAR_SOURCE_TYPES.has(item.source.type) && item.provenance !== "syndicated_primary") {
    return [];
  }
  return deduplicateFutureEvents(extractGuidedMilestones(item, identity));
}

export function clinicalSurpriseScore(
  expectedSuccessProbability: number | null,
  resultDirection: ImpactAssessment["resultDirection"] | null,
): number | null {
  if (expectedSuccessProbability === null || !resultDirection || resultDirection === "unclear") return null;
  const actual = resultDirection === "positive" ? 1 : resultDirection === "mixed" ? 0.5 : 0;
  return Math.round((actual - expectedSuccessProbability) * 100);
}

function calendarIdentity(item: NormalizedItem, analysis?: AnalysisRecord): CalendarIdentity {
  const assessment = analysis?.assessment;
  const ticker = (assessment?.ticker || item.tickerHint || "").trim().toUpperCase();
  return {
    ticker,
    companyName: assessment?.companyName || item.companyHint || ticker,
    trialPhase: assessment?.trialPhase ?? "unknown",
    program: assessment?.trialName ?? "",
    indication: assessment?.indication ?? "",
    createdAt: analysis?.createdAt ?? item.discoveredAt,
  };
}

function completedEvent(item: NormalizedItem, analysis: AnalysisRecord): TimelineEvent {
  const assessment = analysis.assessment;
  const eventDate = validIso(analysis.eventAnchorAt ?? item.publishedAt) ?? item.publishedAt;
  const now = analysis.createdAt;
  return {
    id: timelineId(`completed:${analysis.eventKey ?? item.id}`),
    status: "completed",
    basis: "announced",
    ticker: assessment.ticker.trim().toUpperCase(),
    companyName: assessment.companyName || item.companyHint || assessment.ticker,
    program: assessment.trialName,
    indication: assessment.indication,
    eventType: assessment.eventType,
    trialPhase: assessment.trialPhase,
    title: item.headline.slice(0, 220),
    summary: assessment.rationale.slice(0, 1_000),
    eventDate,
    initialEventDate: eventDate,
    datePrecision: "exact",
    dateLabel: formatExactDate(eventDate),
    sourceName: item.source.name,
    sourceUrl: item.url,
    sourceTier: item.source.tier,
    itemId: item.id,
    eventKey: analysis.eventKey ?? null,
    alertTier: analysis.alertTier,
    initialMateriality: assessment.marketMateriality ?? assessment.materiality,
    anticipatedMateriality: null,
    confidence: assessment.confidence,
    expectedDirection: null,
    expectedOutcome: null,
    expectedSuccessProbability: null,
    expectationConfidence: null,
    expectationAsOf: null,
    resultDirection: assessment.resultDirection,
    expectationEventId: null,
    resolvedByEventId: null,
    clinicalSurpriseScore: null,
    outcome: null,
    createdAt: now,
    updatedAt: now,
  };
}

function modelMilestone(
  item: NormalizedItem,
  identity: CalendarIdentity,
  milestone: FutureMilestone,
): TimelineEvent[] {
  const eventDate = normalizeFutureDate(milestone.expectedDate, milestone.datePrecision, item.publishedAt);
  if (!eventDate) return [];
  return [upcomingEvent(item, identity, {
    basis: "company_guidance",
    stableKey: `${milestone.eventType}:${milestone.program || milestone.indication}:${milestoneKind(milestone.title)}`,
    eventType: milestone.eventType,
    trialPhase: identity.trialPhase,
    program: milestone.program || identity.program,
    indication: milestone.indication || identity.indication,
    title: milestone.title,
    summary: milestone.sourceEvidence,
    eventDate,
    datePrecision: milestone.datePrecision,
    dateLabel: milestone.dateLabel,
    anticipatedMateriality: milestone.anticipatedMateriality,
    expectedDirection: milestone.expectedDirection,
    expectedOutcome: milestone.expectedOutcome,
    expectedSuccessProbability: milestone.expectedSuccessProbability,
    expectationConfidence: milestone.expectationConfidence,
  })];
}

function registryMilestones(item: NormalizedItem, identity: CalendarIdentity): TimelineEvent[] {
  if (item.source.type !== "clinical_trials") return [];
  const raw = record(item.raw);
  const protocol = record(raw.protocolSection);
  const identification = record(protocol.identificationModule);
  const status = record(protocol.statusModule);
  const design = record(protocol.designModule);
  const interventions = record(protocol.armsInterventionsModule);
  const nctId = stringValue(identification.nctId);
  const studyTitle = stringValue(identification.briefTitle) || stringValue(identification.officialTitle) || item.headline;
  const overallStatus = stringValue(status.overallStatus).toUpperCase();
  if (!nctId || INACTIVE_STUDY_STATUSES.has(overallStatus)) return [];
  const interventionList = Array.isArray(interventions.interventions) ? interventions.interventions : [];
  const program = interventionList.map((entry) => stringValue(record(entry).name)).find(Boolean)
    || identity.program;
  const trialPhase = registryTrialPhase(design.phases) ?? identity.trialPhase;
  const conditions = record(protocol.conditionsModule);
  const conditionList = Array.isArray(conditions.conditions) ? conditions.conditions.map(String).filter(Boolean) : [];
  const indication = conditionList.slice(0, 3).join(", ") || identity.indication;
  const milestones: Array<{
    field: string;
    label: string;
    title: string;
    eventType: CatalystEventType;
    anticipatedMateriality: number;
  }> = [{
    field: "primaryCompletionDateStruct",
    label: "Registered primary completion",
    title: `${studyTitle}: primary completion`,
    eventType: "trial_update",
    anticipatedMateriality: phase3Like(trialPhase) ? 78
      : ["phase_2", "phase_2_3"].includes(trialPhase) ? 62 : 55,
  }];
  return milestones.flatMap((milestone) => {
    const dateStruct = record(status[milestone.field]);
    const rawDate = stringValue(dateStruct.date);
    if (!rawDate) return [];
    const parsed = parseRegistryDate(rawDate, item.discoveredAt);
    if (!parsed) return [];
    const eventDate = parsed.eventDate;
    if (Date.parse(eventDate) < startOfDay(item.discoveredAt)) return [];
    const estimated = stringValue(dateStruct.type).toUpperCase() !== "ACTUAL";
    return [upcomingEvent(item, { ...identity, trialPhase, program, indication }, {
      basis: "registry_schedule",
      stableKey: `${nctId}:${milestone.field}`,
      eventType: milestone.eventType,
      trialPhase,
      program,
      indication,
      title: milestone.title,
      summary: `${milestone.label} from ClinicalTrials.gov${estimated ? " (estimated)" : ""}. Registry completion dates do not guarantee a data release on that date.`,
      eventDate,
      datePrecision: parsed.precision,
      dateLabel: rawDate,
      anticipatedMateriality: milestone.anticipatedMateriality,
      expectedDirection: "unclear",
      expectedOutcome: "Registry schedule milestone; a result direction is not implied.",
      expectedSuccessProbability: null,
      expectationConfidence: estimated ? 0.72 : 0.9,
    })];
  });
}

function extractGuidedMilestones(item: NormalizedItem, identity: CalendarIdentity): TimelineEvent[] {
  const text = `${item.headline}. ${item.summary.slice(0, 50_000)}`;
  const sentences = text.split(/(?<=[.!?])\s+|\n+/).map((sentence) => sentence.trim()).filter(Boolean);
  return sentences.slice(0, 160).flatMap((sentence) => {
    if (BOILERPLATE.test(sentence) || (ROUTINE_EVENT.test(sentence) && !SUBSTANTIVE_EVENT.test(sentence))
      || !MILESTONE_CUE.test(sentence)
      || (!FUTURE_CUE.test(sentence) && !DECISION_DATE_CUE.test(sentence))) return [];
    const parsed = parseDateMention(sentence, item.publishedAt);
    if (!parsed) return [];
    const eventType = eventTypeFromSentence(sentence);
    const program = identity.program || programFromSentence(sentence);
    return [upcomingEvent(item, identity, {
      basis: "company_guidance",
      stableKey: guidedMilestoneKey(eventType, parsed.eventDate, program, identity.indication, sentence),
      eventType,
      trialPhase: identity.trialPhase,
      program,
      indication: identity.indication,
      title: sentence.slice(0, 220),
      summary: sentence.slice(0, 500),
      eventDate: parsed.eventDate,
      datePrecision: parsed.precision,
      dateLabel: parsed.label,
      anticipatedMateriality: anticipatedMateriality(eventType, identity.trialPhase),
      expectedDirection: "unclear",
      expectedOutcome: "Company-guided milestone; outcome direction was not quantified in the source.",
      expectedSuccessProbability: null,
      expectationConfidence: 0.62,
    })];
  });
}

interface UpcomingFields {
  basis: TimelineEvent["basis"];
  stableKey: string;
  eventType: CatalystEventType;
  trialPhase: ImpactAssessment["trialPhase"];
  program: string;
  indication: string;
  title: string;
  summary: string;
  eventDate: string;
  datePrecision: TimelineDatePrecision;
  dateLabel: string;
  anticipatedMateriality: number;
  expectedDirection: ImpactAssessment["resultDirection"];
  expectedOutcome: string;
  expectedSuccessProbability: number | null;
  expectationConfidence: number;
}

function upcomingEvent(item: NormalizedItem, identity: CalendarIdentity, fields: UpcomingFields): TimelineEvent {
  return {
    id: timelineId(`upcoming:${identity.ticker}:${fields.stableKey}`),
    status: "upcoming",
    basis: fields.basis,
    ticker: identity.ticker,
    companyName: identity.companyName,
    program: fields.program.slice(0, 160),
    indication: fields.indication.slice(0, 200),
    eventType: fields.eventType,
    trialPhase: fields.trialPhase,
    title: fields.title.slice(0, 220),
    summary: fields.summary.slice(0, 1_000),
    eventDate: fields.eventDate,
    initialEventDate: fields.eventDate,
    datePrecision: fields.datePrecision,
    dateLabel: fields.dateLabel.slice(0, 80),
    sourceName: item.source.name,
    sourceUrl: item.url,
    sourceTier: item.source.tier,
    itemId: item.id,
    eventKey: null,
    alertTier: null,
    initialMateriality: null,
    anticipatedMateriality: fields.anticipatedMateriality,
    confidence: null,
    expectedDirection: fields.expectedDirection,
    expectedOutcome: fields.expectedOutcome.slice(0, 500),
    expectedSuccessProbability: fields.expectedSuccessProbability,
    expectationConfidence: fields.expectationConfidence,
    expectationAsOf: item.publishedAt,
    resultDirection: null,
    expectationEventId: null,
    resolvedByEventId: null,
    clinicalSurpriseScore: null,
    outcome: null,
    createdAt: identity.createdAt,
    updatedAt: identity.createdAt,
  };
}

function deduplicateFutureEvents(events: readonly TimelineEvent[]): TimelineEvent[] {
  const sorted = [...events].sort((left, right) => basisRank(right.basis) - basisRank(left.basis));
  const selected: TimelineEvent[] = [];
  for (const event of sorted) {
    const existingIndex = selected.findIndex((candidate) => likelySameMilestone(candidate, event));
    if (existingIndex < 0) {
      selected.push(event);
      continue;
    }
    const existing = selected[existingIndex]!;
    const eventHasOutcomeExpectation = event.expectedSuccessProbability !== null;
    const existingHasOutcomeExpectation = existing.expectedSuccessProbability !== null;
    selected[existingIndex] = {
      ...existing,
      anticipatedMateriality: eventHasOutcomeExpectation && !existingHasOutcomeExpectation
        ? event.anticipatedMateriality : existing.anticipatedMateriality,
      expectedDirection: event.expectedDirection !== "unclear" ? event.expectedDirection : existing.expectedDirection,
      expectedOutcome: event.expectedSuccessProbability !== null ? event.expectedOutcome : existing.expectedOutcome,
      expectedSuccessProbability: event.expectedSuccessProbability ?? existing.expectedSuccessProbability,
      expectationConfidence: event.expectedSuccessProbability !== null
        ? event.expectationConfidence : existing.expectationConfidence,
    };
  }
  return selected;
}

function likelySameMilestone(left: TimelineEvent, right: TimelineEvent): boolean {
  if (left.eventType !== right.eventType) return false;
  if (Math.abs(Date.parse(left.eventDate) - Date.parse(right.eventDate)) > 45 * 24 * 60 * 60_000) return false;
  const leftProgram = normalizeToken(left.program);
  const rightProgram = normalizeToken(right.program);
  if (leftProgram && rightProgram && leftProgram === rightProgram) return true;
  return tokenOverlap(left.title, right.title) >= 0.5;
}

function parseDateMention(sentence: string, publishedAt: string): ParsedDate | null {
  const iso = /\b(20\d{2})-(\d{2})-(\d{2})\b/.exec(sentence);
  if (iso && isFutureDateContext(sentence, iso)) {
    return parsedDate(Number(iso[1]), Number(iso[2]), Number(iso[3]), "exact", iso[0], publishedAt);
  }
  const numeric = /\b(\d{1,2})\/(\d{1,2})\/(20\d{2})\b/.exec(sentence);
  if (numeric && isFutureDateContext(sentence, numeric)) {
    return parsedDate(Number(numeric[3]), Number(numeric[1]), Number(numeric[2]), "exact", numeric[0], publishedAt);
  }
  const exact = new RegExp(`\\b(${MONTH_PATTERN})\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(20\\d{2})\\b`, "i").exec(sentence);
  if (exact && isFutureDateContext(sentence, exact)) {
    const month = monthNumber(exact[1]!);
    const day = Number(exact[2]);
    const year = Number(exact[3]);
    return parsedDate(year, month, day, "exact", exact[0], publishedAt);
  }
  const quarter = /\b(?:q([1-4])|(?:first|1st|second|2nd|third|3rd|fourth|4th) quarter(?: of)?)\s*(20\d{2})\b/i.exec(sentence);
  if (quarter && isFutureDateContext(sentence, quarter)) {
    const q = quarter[1] ? Number(quarter[1]) : ordinalQuarter(quarter[0]);
    const year = Number(quarter[2]);
    const month = q * 3;
    return parsedDate(year, month, daysInMonth(year, month), "quarter", quarter[0], publishedAt);
  }
  const half = /\b(?:h([12])|(?:first|1st|second|2nd) half(?: of)?)\s*(20\d{2})\b/i.exec(sentence);
  if (half && isFutureDateContext(sentence, half)) {
    const h = half[1] ? Number(half[1]) : /first|1st/i.test(half[0]) ? 1 : 2;
    return parsedDate(Number(half[2]), h === 1 ? 6 : 12, h === 1 ? 30 : 31, "half", half[0], publishedAt);
  }
  const monthYear = new RegExp(`\\b(${MONTH_PATTERN})\\s+(20\\d{2})\\b`, "i").exec(sentence);
  if (monthYear && isFutureDateContext(sentence, monthYear)) {
    const month = monthNumber(monthYear[1]!);
    const year = Number(monthYear[2]);
    return parsedDate(year, month, daysInMonth(year, month), "month", monthYear[0], publishedAt);
  }
  const fiscalYear = /\b(?:by (?:the )?end of |in |during |fiscal(?: year)? |fy)(20\d{2})\b/i.exec(sentence);
  if (fiscalYear && isFutureDateContext(sentence, fiscalYear)) {
    return parsedDate(Number(fiscalYear[1]), 12, 31, "year", fiscalYear[0].trim(), publishedAt);
  }
  const monthDay = new RegExp(`\\b(${MONTH_PATTERN})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, "i").exec(sentence);
  if (monthDay && isFutureDateContext(sentence, monthDay)) {
    const month = monthNumber(monthDay[1]!);
    const published = new Date(publishedAt);
    let year = published.getUTCFullYear();
    if (month < published.getUTCMonth() + 1) year += 1;
    return parsedDate(year, month, Number(monthDay[2]), "exact", monthDay[0], publishedAt);
  }
  const bareMonth = new RegExp(
    `\\b(?:in|by|during|for|before|expected|planned|scheduled|targeted)\\s+(?:the\\s+)?(${MONTH_PATTERN})\\b|\\b(${MONTH_PATTERN})\\s+(?:readout|results?|data|submission|filing|meeting)\\b`,
    "i",
  ).exec(sentence);
  if (bareMonth && (isFutureDateContext(sentence, bareMonth)
    || /\b(?:expected|planned|scheduled|targeted)\b/i.test(bareMonth[0]))) {
    const monthLabel = bareMonth[1] ?? bareMonth[2]!;
    const month = monthNumber(monthLabel);
    const published = new Date(publishedAt);
    let year = published.getUTCFullYear();
    if (month < published.getUTCMonth() + 1) year += 1;
    return parsedDate(year, month, daysInMonth(year, month), "month", monthLabel, publishedAt);
  }
  return null;
}

function parseRegistryDate(value: string, publishedAt: string): ParsedDate | null {
  const exact = /^(20\d{2})-(\d{2})-(\d{2})$/.exec(value);
  if (exact) return parsedDate(Number(exact[1]), Number(exact[2]), Number(exact[3]), "exact", value, publishedAt);
  const month = /^(20\d{2})-(\d{2})$/.exec(value);
  if (month) {
    const year = Number(month[1]);
    const monthNumberValue = Number(month[2]);
    return parsedDate(year, monthNumberValue, daysInMonth(year, monthNumberValue), "month", value, publishedAt);
  }
  const year = /^(20\d{2})$/.exec(value);
  return year ? parsedDate(Number(year[1]), 12, 31, "year", value, publishedAt) : null;
}

interface ParsedDate {
  eventDate: string;
  precision: TimelineDatePrecision;
  label: string;
}

function parsedDate(
  year: number,
  month: number,
  day: number,
  precision: TimelineDatePrecision,
  label: string,
  publishedAt: string,
): ParsedDate | null {
  if (year < 2000 || year > new Date(publishedAt).getUTCFullYear() + 6 || month < 1 || month > 12) return null;
  const date = new Date(Date.UTC(year, month - 1, day, 12));
  if (Number.isNaN(date.getTime()) || date.getTime() < startOfDay(publishedAt) - 24 * 60 * 60_000) return null;
  return { eventDate: date.toISOString(), precision, label };
}

function normalizeFutureDate(value: string, precision: TimelineDatePrecision, publishedAt: string): string | null {
  const parsed = validIso(value);
  if (!parsed) return null;
  const timestamp = Date.parse(parsed);
  if (timestamp < startOfDay(publishedAt) - 24 * 60 * 60_000) return null;
  if (timestamp > Date.parse(publishedAt) + 6 * 366 * 24 * 60 * 60_000) return null;
  if (precision === "exact") return parsed;
  const date = new Date(parsed);
  const year = date.getUTCFullYear();
  if (precision === "month") return new Date(Date.UTC(year, date.getUTCMonth() + 1, 0, 12)).toISOString();
  if (precision === "quarter") {
    const endMonth = (Math.floor(date.getUTCMonth() / 3) + 1) * 3;
    return new Date(Date.UTC(year, endMonth, 0, 12)).toISOString();
  }
  if (precision === "half") return new Date(Date.UTC(year, date.getUTCMonth() < 6 ? 6 : 12, 0, 12)).toISOString();
  return new Date(Date.UTC(year, 11, 31, 12)).toISOString();
}

function eventTypeFromSentence(sentence: string): CatalystEventType {
  if (/\b(?:pdufa|fda action|fda decision|advisory committee|adcom|approval decision)\b/i.test(sentence)) return "regulatory_decision";
  if (/\b(?:ind|nda|bla|submission|resubmission|filing|fda meeting)\b/i.test(sentence)) return "regulatory_update";
  if (/\b(?:topline|top-line|readout|results?|data)\b/i.test(sentence)) return "trial_topline";
  return "trial_update";
}

function isFutureDateContext(sentence: string, match: RegExpExecArray): boolean {
  const before = sentence.slice(Math.max(0, match.index - 240), match.index);
  if (FUTURE_CUE.test(before) || DECISION_DATE_CUE.test(before)) return true;
  const after = sentence.slice(match.index + match[0].length, match.index + match[0].length + 90);
  if (DECISION_DATE_CUE.test(after)) return true;
  return /^\s*(?:topline|top-line|readout|results?|data|submission|filing|meeting)?\s*(?:is|are|remains?)?\s*(?:expected|anticipated|planned|scheduled|targeted|due)\b/i.test(after);
}

function anticipatedMateriality(
  eventType: CatalystEventType,
  trialPhase: ImpactAssessment["trialPhase"],
): number {
  if (eventType === "regulatory_decision") return 90;
  if (eventType === "safety_signal") return 88;
  if (eventType === "trial_topline") return phase3Like(trialPhase) ? 90
    : ["phase_2", "phase_2_3"].includes(trialPhase) ? 78 : 65;
  if (eventType === "regulatory_update") return 68;
  return 55;
}

function phase3Like(trialPhase: ImpactAssessment["trialPhase"]): boolean {
  return ["phase_2_3", "phase_3"].includes(trialPhase);
}

function timelineId(value: string): string {
  return `tle_${createHash("sha256").update(value.toLowerCase()).digest("hex").slice(0, 32)}`;
}

function milestoneKind(value: string): string {
  const lower = value.toLowerCase();
  if (/overall survival|\bos\b/.test(lower)) return "overall-survival";
  if (/progression.free survival|\bpfs\b/.test(lower)) return "progression-free-survival";
  if (/interim/.test(lower)) return "interim-readout";
  if (/topline|top-line|readout|results?|data/.test(lower)) return "data-readout";
  if (/pdufa|approval|fda action|advisory committee|adcom/.test(lower)) return "regulatory-decision";
  if (/submission|resubmission|filing/.test(lower)) return "submission";
  if (/primary completion/.test(lower)) return "primary-completion";
  if (/study completion|trial completion/.test(lower)) return "study-completion";
  if (/enrollment/.test(lower)) return "enrollment";
  return lower.replace(/\b20\d{2}\b/g, "").replace(/[^a-z0-9]+/g, " ").trim().slice(0, 100);
}

function milestoneSubject(value: string): string {
  const program = programFromSentence(value);
  if (program) return program.toLowerCase();
  return value.toLowerCase()
    .replace(new RegExp(`\\b(?:${MONTH_PATTERN})\\b`, "gi"), " ")
    .replace(/\b(?:20\d{2}|q[1-4]|h[12]|pdufa|fda|target|action|date|expected|expects|scheduled|plans?|will|results?|readout|topline|top-line)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .slice(0, 8)
    .join("-");
}

function guidedMilestoneKey(
  eventType: CatalystEventType,
  eventDate: string,
  program: string,
  indication: string,
  sentence: string,
): string {
  const kind = milestoneKind(sentence);
  if (eventType === "regulatory_decision") {
    const subtype = /\bpdufa\b|target action date/i.test(sentence) ? "pdufa"
      : /\badcom\b|advisory committee/i.test(sentence) ? "adcom" : kind;
    return `${eventType}:${subtype}:${eventDate.slice(0, 10)}`;
  }
  return `${eventType}:${program || indication}:${kind}:${milestoneSubject(sentence)}`;
}

function programFromSentence(sentence: string): string {
  return /\b([A-Z]{2,10}[A-Z0-9]*-?\d{2,6}(?:-\d+)?)\b/i.exec(sentence)?.[1] ?? "";
}

function registryTrialPhase(value: unknown): ImpactAssessment["trialPhase"] | null {
  if (!Array.isArray(value)) return null;
  const phases = value.map((phase) => String(phase).toUpperCase().replace(/[^A-Z0-9]/g, ""));
  if (phases.some((phase) => phase === "PHASE3")) {
    return phases.some((phase) => phase === "PHASE2") ? "phase_2_3" : "phase_3";
  }
  if (phases.some((phase) => phase === "PHASE2")) {
    return phases.some((phase) => phase === "PHASE1") ? "phase_1_2" : "phase_2";
  }
  if (phases.some((phase) => phase === "PHASE1")) return "phase_1";
  if (phases.some((phase) => phase === "EARLYPHASE1")) return "phase_1";
  return null;
}

function normalizeToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function tokenOverlap(left: string, right: string): number {
  const tokens = (value: string) => new Set(value.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);
  const leftTokens = tokens(left);
  const rightTokens = tokens(right);
  if (!leftTokens.size || !rightTokens.size) return 0;
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  return intersection / Math.min(leftTokens.size, rightTokens.size);
}

function basisRank(value: TimelineEvent["basis"]): number {
  return value === "registry_schedule" ? 3 : value === "company_guidance" ? 2 : 1;
}

function formatExactDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString().slice(0, 10);
}

function validIso(value: string): string | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function startOfDay(value: string): number {
  const date = new Date(value);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function monthNumber(value: string): number {
  const normalized = value.toLowerCase().slice(0, 3);
  return MONTHS.findIndex((month) => month.startsWith(normalized)) + 1;
}

function ordinalQuarter(value: string): number {
  if (/first|1st/i.test(value)) return 1;
  if (/second|2nd/i.test(value)) return 2;
  if (/third|3rd/i.test(value)) return 3;
  return 4;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
