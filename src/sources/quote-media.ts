import type { QuoteMediaSourceConfig } from "../config.js";
import type { NormalizedItem, SourceAdapter, SourceFetchResult, WatchCompany } from "../types.js";
import { canonicalUrl, findWatchCompany, isoDate, itemId, mapWithConcurrency, stripHtml } from "../utils.js";
import { fetchWithTimeout } from "./http.js";

const HEADLINES_URL = "https://www.accesswire.com/qm/data/getHeadlines.json";
const STORY_URL = "https://www.accesswire.com/qm/data/getStory.json";
const RELEASE_SOURCES = "pzo,bayaw,prn,bwi,TheNewsWire,nfil,actw,irw,acn,cnw,nwd,glpr,nwmw";

interface HeadlineItem {
  newsid?: string | number;
  datetime?: string;
  source?: string;
  headline?: string;
  qmsummary?: string;
  storyurl?: string;
  permalink?: string;
}

interface HeadlinesPayload {
  results?: {
    news?: Array<{ newsitem?: HeadlineItem[] }>;
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
      ? new Date(parsedCursor.getTime() - 24 * 60 * 60 * 1000)
      : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const through = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const url = new URL(HEADLINES_URL);
    url.searchParams.set("topics", this.config.symbol);
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
    const headlines = (payload.results?.news ?? []).flatMap((group) => group.newsitem ?? [])
      .filter((entry) => entry.newsid && entry.headline && entry.datetime)
      .filter((entry) => new Date(entry.datetime!).getTime() >= since.getTime());
    const storyResults = await mapWithConcurrency(headlines, 3, (entry) => this.fetchStory(entry.newsid!));
    const discoveredAt = new Date().toISOString();
    const configuredCompany = this.watchlist.find((company) => company.ticker === this.config.symbol) ?? null;
    const items = headlines.map((entry, index): NormalizedItem => {
      const story = storyResults[index]?.status === "fulfilled" ? storyResults[index].value : "";
      const headline = stripHtml(entry.headline!);
      const summary = stripHtml(story || entry.qmsummary || "").slice(0, 25_000);
      const company = configuredCompany ?? findWatchCompany(`${headline} ${summary}`, this.watchlist);
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
        companyHint: company?.company ?? null,
        tickerHint: company?.ticker ?? this.config.symbol,
        raw: { ...entry, fullStoryFetched: Boolean(story) },
      };
    });
    const newest = items.reduce<string | null>((latest, item) => (
      !latest || item.publishedAt > latest ? item.publishedAt : latest
    ), cursor);
    return { items, cursor: newest ?? undefined, diagnostics: { entryCount: items.length, symbol: this.config.symbol } };
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
