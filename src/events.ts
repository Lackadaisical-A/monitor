import { createHash } from "node:crypto";
import type { EvidenceContext, ImpactAssessment, NormalizedItem, SourceProvenance, WatchCompany } from "./types.js";
import { jaccardSimilarity, normalizedHeadline } from "./utils.js";

const EVENT_WINDOW_MS = 72 * 60 * 60_000;
const PROGRAM_ID = /\b(?:[A-Z]{2,8}[- ]?\d{2,6}(?:-\d+)?|NCT\d{8})\b/g;
const NON_PROGRAM_IDS = new Set(["PHASE1", "PHASE2", "PHASE3", "FORM10", "COVID19"]);
const EVENT_FACT_STOP_WORDS = new Set([
  "announced", "announces", "biotech", "clinical", "company", "drug", "fda", "gene",
  "hold", "patient", "participant", "program", "regulatory", "report", "reported",
  "study", "therapy", "trial", "treatment", "update",
]);

export interface EvidenceProfile {
  hasPrimary: boolean;
  hasDirectPrimary: boolean;
  hasIndependentCorroboration: boolean;
  independentSourceCount: number;
}

export function sourceProvenance(item: NormalizedItem): SourceProvenance {
  if (item.provenance) return item.provenance;
  if (["regulator", "sec"].includes(item.source.type)) return "direct_primary";
  if (item.source.type === "clinical_trials") return "registry";
  if (["x", "reddit"].includes(item.source.type)) return "social";
  if (item.source.type === "company_ir") {
    const raw = asRecord(item.raw);
    return raw.newsid || /(?:newswire|accesswire|quotemedia)/i.test(`${item.author ?? ""} ${item.url}`)
      ? "syndicated_primary"
      : "direct_primary";
  }
  if (/(?:globe ?newswire|accesswire|pr ?newswire|business ?wire|newsfile)/i.test(
    `${item.source.name} ${item.author ?? ""} ${item.url}`,
  )) return "syndicated_primary";
  return item.source.tier === "secondary" ? "independent_reporting" : "unknown";
}

export function evidenceIndependenceKey(item: NormalizedItem): string {
  if (item.independenceKey) return item.independenceKey;
  const provenance = sourceProvenance(item);
  if (provenance === "syndicated_primary" || item.source.type === "company_ir") {
    const issuer = item.tickerHint || item.companyHint;
    return issuer ? `issuer:${normalizeSignature(issuer)}` : `release:${contentFingerprint(item)}`;
  }
  if (provenance === "direct_primary") {
    return `authority:${item.source.id}`;
  }
  if (provenance === "registry") {
    return `registry:${item.externalId || item.source.id}`;
  }
  try {
    return `publisher:${new URL(item.url).hostname.replace(/^www\./, "")}`;
  } catch {
    return `publisher:${item.source.id}`;
  }
}

export function evidenceProfile(context: EvidenceContext): EvidenceProfile {
  const items = [context.item, ...context.corroboratingItems];
  const provenances = items.map(sourceProvenance);
  const credible = items.filter((item) => sourceProvenance(item) !== "social");
  const independentSourceCount = new Set(credible.map(evidenceIndependenceKey)).size;
  return {
    hasPrimary: provenances.some((value) => ["direct_primary", "syndicated_primary"].includes(value)),
    hasDirectPrimary: provenances.includes("direct_primary"),
    hasIndependentCorroboration: independentSourceCount >= 2,
    independentSourceCount,
  };
}

export function areLikelySameEvent(
  left: NormalizedItem,
  right: NormalizedItem,
  company: WatchCompany | null,
): boolean {
  if (Math.abs(Date.parse(left.publishedAt) - Date.parse(right.publishedAt)) > EVENT_WINDOW_MS) return false;
  if (contentFingerprint(left) === contentFingerprint(right)) return true;
  const leftText = `${left.headline}\n${left.summary}`;
  const rightText = `${right.headline}\n${right.summary}`;
  const leftIds = eventIdentifiers(leftText, company);
  const rightIds = eventIdentifiers(rightText, company);
  const sharesIdentifier = [...leftIds].some((value) => rightIds.has(value));
  const leftAction = actionFamily(leftText);
  const rightAction = actionFamily(rightText);
  if (sharesIdentifier && (leftAction === rightAction || leftAction === "general" || rightAction === "general")) return true;
  const similarity = jaccardSimilarity(left.headline, right.headline);
  if (similarity >= 0.34 || (similarity >= 0.2 && leftAction === rightAction && leftAction !== "general")) return true;
  return leftAction === rightAction
    && leftAction !== "general"
    && eventFactOverlap(leftText, rightText) >= 0.3;
}

export function eventIdentity(
  assessment: ImpactAssessment,
  context: EvidenceContext,
): { eventKey: string; eventAnchorAt: string } {
  const ticker = assessment.ticker.trim().toUpperCase() || context.company?.ticker || context.item.tickerHint || "UNKNOWN";
  const evidence = [context.item, ...context.corroboratingItems];
  const anchor = evidence.reduce((earliest, item) => (
    Date.parse(item.publishedAt) < Date.parse(earliest) ? item.publishedAt : earliest
  ), context.item.publishedAt);
  const combined = evidence.map((item) => `${item.headline}\n${item.summary}`).join("\n");
  const identifierText = [
    combined,
    assessment.eventSignature ?? "",
    assessment.trialName,
  ].join("\n");
  const identifier = canonicalEventIdentifier(eventIdentifiers(identifierText, context.company), context.company);
  const signature = normalizeSignature(assessment.eventSignature ?? "");
  const action = actionFamily(combined);
  const eventDate = anchor.slice(0, 10);
  const stableDescriptor = (identifier
    ? `${identifier}:${action}`
    : signature)
    || `${action}:${normalizedHeadline(context.item.headline)}`;
  const digest = createHash("sha256").update(`${ticker}|${eventDate}|${stableDescriptor}`).digest("hex").slice(0, 20);
  return { eventKey: `${ticker}:${digest}`, eventAnchorAt: anchor };
}

export function actionFamily(text: string): string {
  const value = text.toLowerCase();
  if (/\b(?:lift(?:ed|s|ing)?|remove(?:d|s|ing)?) (?:the )?(?:full |partial )?clinical hold\b/.test(value)) return "clinical-hold-lifted";
  if (/\b(?:fda|food and drug administration)\b.{0,80}\b(?:pause|paused|pauses|halt|halted|halts|suspend|suspended|suspends)\b.{0,60}\b(?:trial|study|program)\b/.test(value)
    || /\b(?:trial|study|program)\b.{0,60}\b(?:pause|paused|pauses|halt|halted|halts|suspend|suspended|suspends)\b.{0,80}\b(?:by |from )?(?:the )?(?:fda|food and drug administration)\b/.test(value)) return "clinical-hold";
  if (/\bclinical hold\b/.test(value)) return "clinical-hold";
  if (/\b(?:complete response letter|refuse(?:d)?[- ]to[- ]file|rejection|rejected|denied)\b/.test(value)
    || /\b(?:receive[ds]?|issue[ds]?|gets?|got|hit with) (?:an? )?crl\b/.test(value)
    || /\b(?:fda\b.{0,40}\bcrl|crl\b.{0,40}\b(?:from|by) (?:the )?fda)\b/.test(value)) return "regulatory-rejection";
  if (/\b(?:approved|approval|authori[sz]ation)\b/.test(value)) return "regulatory-approval";
  if (/\b(?:met|missed|failed) (?:the )?(?:primary|co-primary) endpoint|top[- ]?line|readout\b/.test(value)) return "trial-results";
  if (/\b(?:adverse event|safety signal|patient death|fatalit)\b/.test(value)) return "safety";
  if (/\b(?:ind|nda|bla|maa|snda|sbla)\b.{0,40}\b(?:submit|file|accept)|\b(?:submit|file|accept)\w*\b.{0,40}\b(?:ind|nda|bla|maa|snda|sbla)\b/.test(value)) return "regulatory-filing";
  if (/\b(?:fda|ema|chmp|mhlw)\b.{0,50}\bmeeting|\bmeeting\b.{0,50}\b(?:fda|ema|chmp|mhlw)\b/.test(value)) return "regulatory-meeting";
  if (/\b(?:offering|financing|private placement|debt facility|cash runway)\b/.test(value)) return "financing";
  if (/\b(?:partnership|collaboration|licen[cs]ing agreement|acquisition|merger)\b/.test(value)) return "transaction";
  if (/\b(?:first patient|first participant|dosed|enrollment complete|completed enrollment|initiated)\b/.test(value)) return "trial-progress";
  if (/\b(?:publication|published|journal|conference presentation)\b/.test(value)) return "publication";
  return "general";
}

export function contentFingerprint(item: NormalizedItem): string {
  const content = `${normalizedHeadline(item.headline)}|${normalizeSignature(item.summary.slice(0, 1_200))}`;
  return createHash("sha256").update(content).digest("hex").slice(0, 20);
}

function eventIdentifiers(text: string, company: WatchCompany | null): Set<string> {
  const normalized = text.toUpperCase().replaceAll(" ", "");
  const values = new Set((text.toUpperCase().match(PROGRAM_ID) ?? [])
    .map((value) => value.replaceAll(/[^A-Z0-9]/g, ""))
    .filter((value) => !NON_PROGRAM_IDS.has(value)));
  for (const program of company?.programs ?? []) {
    const identifier = normalizeSignature(program).replaceAll("-", "");
    if (identifier.length >= 4 && normalized.includes(identifier.toUpperCase())) values.add(identifier.toUpperCase());
  }
  return values;
}

function canonicalEventIdentifier(values: Set<string>, company: WatchCompany | null): string {
  for (const program of company?.programs ?? []) {
    const identifier = normalizeSignature(program).replaceAll("-", "").toUpperCase();
    if (values.has(identifier)) return identifier;
  }
  return [...values].sort((left, right) => {
    const leftNct = left.startsWith("NCT") ? 1 : 0;
    const rightNct = right.startsWith("NCT") ? 1 : 0;
    return leftNct - rightNct || left.length - right.length || left.localeCompare(right);
  })[0] ?? "";
}

function eventFactOverlap(left: string, right: string): number {
  const leftFacts = eventFactTokens(left);
  const rightFacts = eventFactTokens(right);
  if (!leftFacts.size || !rightFacts.size) return 0;
  const shared = [...leftFacts].filter((value) => rightFacts.has(value)).length;
  if (shared < 4) return 0;
  return shared / Math.min(leftFacts.size, rightFacts.size);
}

function eventFactTokens(value: string): Set<string> {
  const words = value.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return new Set(words
    .map(stemEventToken)
    .filter((word) => word.length >= 4 && !EVENT_FACT_STOP_WORDS.has(word)));
}

function stemEventToken(value: string): string {
  if (value.endsWith("ies") && value.length > 5) return `${value.slice(0, -3)}y`;
  if (value.endsWith("sses")) return value.slice(0, -2);
  if (value.endsWith("es") && value.length > 5) return value.slice(0, -2);
  if (value.endsWith("s") && value.length > 4) return value.slice(0, -1);
  return value;
}

function normalizeSignature(value: string): string {
  return value.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 160);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
