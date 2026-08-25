import { createHash, timingSafeEqual } from "node:crypto";
import type { SourceType, WatchCompany } from "./types.js";

const TRACKING_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "gclid",
  "fbclid",
  "mc_cid",
  "mc_eid",
]);

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_PARAMS.has(key.toLowerCase())) url.searchParams.delete(key);
    }
    url.hostname = url.hostname.toLowerCase();
    url.pathname = url.pathname.replace(/\/$/, "") || "/";
    const query = [...url.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
    url.search = "";
    for (const [key, value] of query) url.searchParams.append(key, value);
    return url.toString();
  } catch {
    return raw.trim();
  }
}

export function normalizedHeadline(value: string): string {
  return value
    .toLowerCase()
    .replace(/<[^>]*>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/[^a-z0-9$]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function stripHtml(value: string): string {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => safeCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, decimal: string) => safeCodePoint(Number.parseInt(decimal, 10)))
    .replace(/\s+/g, " ")
    .trim();
}

export function itemId(sourceId: string, externalId: string, url: string, headline: string): string {
  return sha256(`${sourceId}|${externalId || canonicalUrl(url)}|${normalizedHeadline(headline)}`).slice(0, 32);
}

export function findWatchCompany(text: string, watchlist: WatchCompany[]): WatchCompany | null {
  return resolveWatchCompany({ headline: text, summary: "" }, watchlist);
}

export function resolveWatchCompany(
  input: { headline: string; summary?: string; tickerHint?: string | null; companyHint?: string | null },
  watchlist: WatchCompany[],
): WatchCompany | null {
  const hintedTicker = input.tickerHint?.trim().toUpperCase();
  if (hintedTicker) {
    const hinted = watchlist.find((company) => company.ticker === hintedTicker);
    if (hinted) return hinted;
  }
  const headline = input.headline ?? "";
  const summary = input.summary ?? "";
  const companyHint = input.companyHint ?? "";
  const scored = watchlist.map((company) => ({ company, score: companyMatchScore(company, headline, summary, companyHint) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score);
  if (!scored.length) return null;
  if (scored[0]!.score < 60) return null;
  if (scored.length > 1 && scored[0]!.score === scored[1]!.score) return null;
  return scored[0]!.company;
}

export function isCatalystCandidate(
  text: string,
  watchlist: WatchCompany[],
  options: {
    tickerHint?: string | null;
    sourceType?: SourceType;
    headline?: string;
    summary?: string;
  } = {},
): boolean {
  const company = resolveWatchCompany({
    headline: options.headline ?? text,
    summary: options.summary ?? "",
    ...(options.tickerHint !== undefined ? { tickerHint: options.tickerHint } : {}),
  }, watchlist);
  if (!company && watchlist.length > 0) return false;
  if (options.tickerHint && ["company_ir", "sec", "regulator"].includes(options.sourceType ?? "")) return true;
  return /\b(?:phase\s*(?:1|2|3|i|ii|iii)|clinical(?:\s+trial|\s+study|\s+hold)?|top[- ]?line|primary endpoint|secondary endpoint|overall survival|progression.free survival|statistically significant|p\s*[<=>]|fda|ema|chmp|mhlw|ind|nda|bla|maa|snda|sbla|pdufa|adcom|approval|authori[sz]ation|complete response letter|(?:received|issued|gets?|hit with) (?:an? )?crl|refuse(?:d)?[- ]to[- ]file|fast track|breakthrough therapy|orphan drug|rmat|priority review|adverse event|safety signal|interim analysis|data readout|results?|enrollment|first (?:patient|participant)|dosed|discontinued|paused|terminated|licen[cs](?:e|ing)|partnership|collaboration|acquisition|merger|offering|financing|private placement|debt facility|cash runway|restructuring|bankruptcy|delisting|nasdaq compliance|financial results|earnings)\b/i.test(text);
}

function companyMatchScore(company: WatchCompany, headline: string, summary: string, companyHint: string): number {
  let score = 0;
  if (tickerMatches(headline, company.ticker)) score = Math.max(score, 120);
  if (tickerMatches(companyHint, company.ticker)) score = Math.max(score, 110);
  const companyNames = uniqueStrings([
    company.company,
    ...company.aliases,
    simplifiedCompanyName(company.company),
    distinctiveCompanyToken(company.company),
  ]);
  const programNames = uniqueStrings(company.programs);
  for (const name of companyNames) {
    if (textContainsEntity(headline, name)) score = Math.max(score, 100 + Math.min(20, name.length));
    if (textContainsEntity(companyHint, name)) score = Math.max(score, 90 + Math.min(20, name.length));
    if (textContainsEntity(summary, name)) score = Math.max(score, 35 + Math.min(15, name.length));
  }
  for (const program of programNames) {
    if (textContainsEntity(headline, program)) score = Math.max(score, 85 + Math.min(15, program.length));
    if (textContainsEntity(summary, program)) score = Math.max(score, 25 + Math.min(10, program.length));
  }
  return score;
}

function textContainsEntity(text: string, candidate: string): boolean {
  const needle = candidate.trim();
  if (!needle || needle === "$" || needle.length < 3) return false;
  if (/^[a-z0-9-]{2,12}$/i.test(needle)) {
    return new RegExp(`(?:^|[^a-z0-9])${escapeRegex(needle)}(?:$|[^a-z0-9])`, "i").test(text);
  }
  return ` ${text.toLowerCase()} `.includes(needle.toLowerCase());
}

function simplifiedCompanyName(value: string): string {
  return value.replace(/\s+(?:holdings?|therapeutics?|pharmaceuticals?|sciences?|biopharma|biosciences?)?\s*(?:inc\.?|corp\.?|corporation|ltd\.?|limited|plc|se|sa|ag|nv)$/i, "").trim();
}

function distinctiveCompanyToken(value: string): string {
  const first = value.trim().split(/\s+/)[0] ?? "";
  const generic = new Set(["american", "global", "international", "national", "united"]);
  return first.length >= 6 && !generic.has(first.toLowerCase()) ? first : "";
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export function jaccardSimilarity(a: string, b: string): number {
  const stop = new Set(["the", "a", "an", "and", "or", "to", "of", "in", "for", "on", "with", "from", "announces", "reports", "data"]);
  const tokens = (value: string) => new Set(normalizedHeadline(value).split(" ").filter((token) => token.length > 2 && !stop.has(token)));
  const left = tokens(a);
  const right = tokens(b);
  if (!left.size || !right.size) return 0;
  const intersection = [...left].filter((token) => right.has(token)).length;
  return intersection / (left.size + right.size - intersection);
}

export function isoDate(value: unknown, fallback = new Date()): string {
  const normalized = typeof value === "string" ? value.replace(/(\d)(am|pm)\b/i, "$1 $2") : value;
  const parsed = normalized instanceof Date ? normalized : new Date(String(normalized ?? ""));
  return Number.isNaN(parsed.getTime()) ? fallback.toISOString() : parsed.toISOString();
}

export function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<Array<PromiseSettledResult<R>>> {
  const results = new Array<PromiseSettledResult<R>>(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(Math.floor(limit), items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = { status: "fulfilled", value: await mapper(items[index]!, index) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tickerMatches(text: string, rawTicker: string): boolean {
  const ticker = rawTicker.trim().toUpperCase();
  if (!ticker) return false;
  const escaped = escapeRegex(ticker);
  const explicit = new RegExp(
    `(?:\\$\\s*|(?:nasdaq|nyse(?: american)?|amex|otc|ticker)\\s*[:=]\\s*)${escaped}(?![a-z0-9])`,
    "i",
  );
  if (explicit.test(text)) return true;
  if (ticker.length < 4) return false;
  return new RegExp(`(?:^|[^A-Z0-9])${escaped}(?:$|[^A-Z0-9])`).test(text);
}

function safeCodePoint(value: number): string {
  return Number.isInteger(value) && value >= 0 && value <= 0x10ffff ? String.fromCodePoint(value) : "�";
}
