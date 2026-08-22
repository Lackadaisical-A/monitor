import { createHash, timingSafeEqual } from "node:crypto";
import type { WatchCompany } from "./types.js";

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
  const haystack = ` ${text.toLowerCase()} `;
  for (const company of watchlist) {
    const candidates = [company.company, ...company.aliases, ...company.programs];
    if (candidates.some((candidate) => {
      const needle = candidate.trim().toLowerCase();
      if (!needle) return false;
      if (needle.length <= 5 && /^[a-z]+$/i.test(needle)) {
        return new RegExp(`(?:^|[^a-z0-9])${escapeRegex(needle)}(?:$|[^a-z0-9])`, "i").test(text);
      }
      return haystack.includes(needle);
    }) || tickerMatches(text, company.ticker)) return company;
  }
  return null;
}

export function isCatalystCandidate(text: string, watchlist: WatchCompany[]): boolean {
  const company = findWatchCompany(text, watchlist);
  const catalyst = /\b(phase\s*(?:1|2|3|i|ii|iii)|clinical trial|topline|top-line|primary endpoint|secondary endpoint|overall survival|progression.free survival|statistically significant|p\s*[<=>]|fda|approval|complete response letter|crl|fast track|breakthrough therapy|adverse event|safety signal|interim analysis|data readout|results?)\b/i.test(text);
  return catalyst && (company !== null || watchlist.length === 0);
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
