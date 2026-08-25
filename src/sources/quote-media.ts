import type { QuoteMediaSourceConfig } from "../config.js";
import type { NormalizedItem, SourceAdapter, SourceFetchResult, WatchCompany } from "../types.js";
import { canonicalUrl, isoDate, itemId, mapWithConcurrency, resolveWatchCompany, stripHtml } from "../utils.js";
import { fetchWithTimeout } from "./http.js";

const HEADLINES_URL = "https://www.accesswire.com/qm/data/getHeadlines.json";
const STORY_URL = "https://www.accesswire.com/qm/data/getStory.json";
const RELEASE_SOURCES = "pzo,bayaw,prn,bwi,TheNewsWire,nfil,actw,irw,acn,cnw,nwd,glpr,nwmw";
const TOPIC_BATCH_SIZE = 50;
const TOPIC_BATCH_CONCURRENCY = 2;
const STORY_CONCURRENCY = 4;
const CURSOR_OVERLAP_MS = 10 * 60 * 1000;
const LEGAL_NOISE = /\b(class action|shareholder alert|investor alert|securities fraud|law offices? of|investigates|deadline alert|notice of settlement)\b/i;
const EXCLUDED_TOPICS = ["ATTORNEY/LAWSUIT INVESTIGATION", "CLASS ACTION", "FRAUDONL"];

interface HeadlineItem {
  newsid?: string | number;
  datetime?: string;
  source?: string;
  headline?: string;
  qmsummary?: string;
  storyurl?: string;
  permalink?: string;
  topic?: string;
  matchedTicker?: string;
}

interface HeadlinesPayload {
  results?: {
    news?: Array<{ topicstring?: string; newsitem?: HeadlineItem[] }>;
  };
}

interface StoryPayload {
  qmcistory?: {
    qmnews?: {
      qmstory?: {
        qmtext?: string;
        qmsummary?: string;
      };
    };
  };
}

export class QuoteMediaPressReleaseSource implements SourceAdapter {
  readonly descriptor;

  constructor(
    private readonly config: QuoteMediaSourceConfig,
    private readonly watchlist: WatchCompany[],
    private readonly timeoutMs: number,
  ) {
    this.descriptor = {
      id: config.id,
      name: config.name,
      type: config.sourceType,
      tier: config.tier,
    } as const;
  }

  async fetch(cursor: string | null): Promise<SourceFetchResult> {
    const parsedCursor = cursor ? new Date(cursor) : null;
    const since = parsedCursor && !Number.isNaN(parsedCursor.getTime())
      ? new Date(parsedCursor.getTime() - CURSOR_OVERLAP_MS)
      : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const through = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const configuredSymbols = [...new Set([
      ...(this.config.watchlist ? this.watchlist.map((company) => company.ticker) : []),
      ...(this.config.symbol ? [this.config.symbol] : []),
      ...this.config.symbols,
    ])];
    if (!configuredSymbols.length) return { items: [], diagnostics: { reason: "symbols_empty" } };
    const headlineResults = await mapWithConcurrency(
      chunk(configuredSymbols, TOPIC_BATCH_SIZE),
      TOPIC_BATCH_CONCURRENCY,
      (symbols) => this.fetchHeadlines(symbols, since, through),
    );
    const successfulHeadlines = headlineResults.filter(
      (result): result is PromiseFulfilledResult<HeadlineItem[]> => result.status === "fulfilled",
    );
    if (!successfulHeadlines.length) {
      const firstFailure = headlineResults.find((result): result is PromiseRejectedResult => result.status === "rejected");
      throw firstFailure?.reason ?? new Error("Press release headlines were unavailable");
    }
    const headlines = [...new Map(successfulHeadlines.flatMap((result) => result.value)
      .filter((entry) => entry.newsid && entry.headline && entry.datetime)
      .filter((entry) => new Date(entry.datetime!).getTime() >= since.getTime())
      .filter(isUsefulRelease)
      .map((entry) => [String(entry.newsid), entry])).values()]
      .sort((left, right) => Date.parse(right.datetime!) - Date.parse(left.datetime!));
    const storyResults = await mapWithConcurrency(headlines, STORY_CONCURRENCY, (entry) => this.fetchStory(entry.newsid!));
    const discoveredAt = new Date().toISOString();
    const configuredCompany = configuredSymbols.length === 1
      ? this.watchlist.find((company) => company.ticker === configuredSymbols[0]) ?? null
      : null;
    const items = headlines.map((entry, index): NormalizedItem => {
      const story = storyResults[index]?.status === "fulfilled" ? storyResults[index].value : "";
      const headline = stripHtml(entry.headline!);
      const summary = stripHtml(story || entry.qmsummary || "").slice(0, 25_000);
      const company = resolveWatchCompany({
        headline,
        summary,
        tickerHint: entry.matchedTicker ?? null,
      }, this.watchlist);
      const resolvedCompany = company ?? configuredCompany;
      const externalId = String(entry.newsid);
      const url = canonicalUrl(entry.permalink || entry.storyurl || `${STORY_URL}?storyId=${externalId}&newslang=en`);
      return {
        id: itemId(this.descriptor.id, externalId, url, headline),
        externalId,
        source: this.descriptor,
        headline,
        summary,
        url,
        author: entry.source ?? this.config.name,
        publishedAt: isoDate(entry.datetime, new Date()),
        discoveredAt,
        companyHint: resolvedCompany?.company ?? null,
        tickerHint: resolvedCompany?.ticker ?? null,
        provenance: "syndicated_primary",
        independenceKey: resolvedCompany
          ? `issuer:${resolvedCompany.ticker.toLowerCase()}`
          : `wire-release:${externalId}`,
        raw: { ...entry, fullStoryFetched: Boolean(story) },
      };
    }).filter((item) => (
      this.config.sourceType !== "company_ir"
      || !configuredSymbols.length
      || Boolean(item.tickerHint && configuredSymbols.includes(item.tickerHint))
    ));
    const newest = headlines.reduce<string | null>((latest, entry) => {
      const publishedAt = isoDate(entry.datetime, new Date(0));
      return !latest || publishedAt > latest ? publishedAt : latest;
    }, cursor);
    return {
      items,
      cursor: headlineResults.length === successfulHeadlines.length ? newest ?? undefined : cursor ?? undefined,
      diagnostics: {
        entryCount: items.length,
        symbolCount: configuredSymbols.length,
        batchCount: headlineResults.length,
        failedBatchCount: headlineResults.length - successfulHeadlines.length,
      },
    };
  }

  private async fetchHeadlines(symbols: string[], since: Date, through: Date): Promise<HeadlineItem[]> {
    const url = new URL(HEADLINES_URL);
    url.searchParams.set("topics", symbols.join(","));
    url.searchParams.set("excludeTopics", "NONCOMPANY");
    url.searchParams.set("noSrc", "qmr");
    url.searchParams.set("src", RELEASE_SOURCES);
    url.searchParams.set("summary", "true");
    url.searchParams.set("summLen", "1000");
    url.searchParams.set("start", since.toISOString().slice(0, 10));
    url.searchParams.set("end", through.toISOString().slice(0, 10));

    const response = await fetchWithTimeout(url, {
      headers: { Accept: "application/json", "User-Agent": "CatalystWatch/0.1 press release reader" },
    }, this.timeoutMs);
    const payload = parsePayload<HeadlinesPayload>(await response.json());
    return (payload.results?.news ?? []).flatMap((group) => {
      const matchedTicker = group.topicstring?.trim().toUpperCase();
      return (group.newsitem ?? []).map((entry) => (
        matchedTicker ? { ...entry, matchedTicker } : entry
      ));
    });
  }

  private async fetchStory(storyId: string | number): Promise<string> {
    const url = new URL(STORY_URL);
    url.searchParams.set("storyId", String(storyId));
    url.searchParams.set("newslang", "en");
    const response = await fetchWithTimeout(url, {
      headers: { Accept: "application/json", "User-Agent": "CatalystWatch/0.1 press release reader" },
    }, this.timeoutMs);
    const payload = parsePayload<StoryPayload>(await response.json());
    const story = payload.qmcistory?.qmnews?.qmstory;
    return story?.qmtext || story?.qmsummary || "";
  }
}

function parsePayload<T>(value: unknown): T {
  return (typeof value === "string" ? JSON.parse(value) : value) as T;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

function isUsefulRelease(entry: HeadlineItem): boolean {
  if (LEGAL_NOISE.test(stripHtml(entry.headline ?? ""))) return false;
  const topics = entry.topic ?? "";
  return !EXCLUDED_TOPICS.some((topic) => topics.includes(topic));
}
