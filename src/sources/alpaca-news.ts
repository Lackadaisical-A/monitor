import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { NormalizedItem, SourceAdapter, SourceFetchResult, WatchCompany } from "../types.js";
import { canonicalUrl, isoDate, itemId, mapWithConcurrency, resolveWatchCompany, stripHtml } from "../utils.js";
import { fetchWithTimeout } from "./http.js";

const NEWS_URL = "https://data.alpaca.markets/v1beta1/news";
const SYMBOL_BATCH_SIZE = 50;
const BATCH_CONCURRENCY = 3;
const MAX_PAGES = 5;
const CURSOR_OVERLAP_MS = 10 * 60_000;
const MARKET_CHATTER = /(?:here['’]s how much .{0,40} invested|stocks? moving in .{0,30} session|maintains? (?:buy|sell|hold|neutral|overweight|underweight)|(?:raises?|lowers?) price target|shares? (?:rise|fall|gain|drop).{0,50}(?:trading|technical) signal|unusual options activity|options? market tells us|whale activity)/i;

const NewsArticleSchema = z.object({
  id: z.union([z.string(), z.number()]),
  author: z.string().nullable().optional(),
  created_at: z.string(),
  updated_at: z.string().optional(),
  headline: z.string(),
  summary: z.string().nullable().optional(),
  content: z.string().nullable().optional(),
  url: z.string().url(),
  symbols: z.array(z.string()).default([]),
  source: z.string().nullable().optional(),
}).passthrough();

const NewsResponseSchema = z.object({
  news: z.array(NewsArticleSchema).default([]),
  next_page_token: z.string().nullable().optional(),
});

type NewsArticle = z.infer<typeof NewsArticleSchema>;

interface NewsBatchResult {
  articles: NewsArticle[];
  truncated: boolean;
}

export class AlpacaNewsSource implements SourceAdapter {
  readonly descriptor = {
    id: "alpaca-news",
    name: "Alpaca News (Benzinga)",
    type: "outlet",
    tier: "secondary",
  } as const;

  constructor(
    private readonly config: AppConfig["alpaca"],
    private readonly watchlist: WatchCompany[],
    private readonly timeoutMs: number,
  ) {}

  async fetch(cursor: string | null): Promise<SourceFetchResult> {
    if (!this.config.keyId || !this.config.secretKey || !this.watchlist.length) {
      return { items: [], diagnostics: { reason: "credentials_or_watchlist_missing" } };
    }
    const parsedCursor = cursor && Number.isFinite(Date.parse(cursor)) ? Date.parse(cursor) : null;
    const startAt = new Date((parsedCursor ?? Date.now() - 24 * 60 * 60_000) - (parsedCursor ? CURSOR_OVERLAP_MS : 0));
    const batches = chunk(this.watchlist.map((company) => company.ticker), SYMBOL_BATCH_SIZE);
    const results = await mapWithConcurrency(
      batches,
      BATCH_CONCURRENCY,
      (symbols) => this.fetchBatch(symbols, startAt.toISOString()),
    );
    const successful = results.filter((result): result is PromiseFulfilledResult<NewsBatchResult> => result.status === "fulfilled");
    if (!successful.length) {
      const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
      throw failure?.reason ?? new Error("Alpaca News returned no successful symbol batches");
    }
    const discoveredAt = new Date().toISOString();
    const articles = [...new Map(successful.flatMap((result) => result.value.articles)
      .map((article) => [String(article.id), article])).values()]
      .filter((article) => Date.parse(article.updated_at ?? article.created_at) >= startAt.getTime())
      .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at));
    const watchlistByTicker = new Map(this.watchlist.map((company) => [company.ticker, company]));
    const items = articles.flatMap((article): NormalizedItem[] => {
      const headline = stripHtml(article.headline).trim();
      if (!headline || MARKET_CHATTER.test(headline)) return [];
      const summary = stripHtml([article.summary, article.content].filter(Boolean).join("\n")).slice(0, 25_000);
      const taggedCompanies = article.symbols
        .map((symbol) => watchlistByTicker.get(symbol.toUpperCase()))
        .filter((company): company is WatchCompany => Boolean(company));
      const company = resolveWatchCompany({ headline, summary }, taggedCompanies);
      const externalId = String(article.id);
      const url = canonicalUrl(article.url);
      const publisher = (article.source || "benzinga").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-");
      return [{
        id: itemId(this.descriptor.id, externalId, url, headline),
        externalId,
        source: this.descriptor,
        headline,
        summary,
        url,
        author: article.author ?? article.source ?? null,
        publishedAt: isoDate(article.created_at),
        discoveredAt,
        companyHint: company?.company ?? null,
        tickerHint: company?.ticker ?? null,
        provenance: "independent_reporting",
        independenceKey: `publisher:${publisher || "alpaca-news"}`,
        raw: article,
      }];
    });
    const newest = articles.reduce<string | null>((latest, article) => {
      const updatedAt = isoDate(article.updated_at ?? article.created_at, new Date(0));
      return !latest || updatedAt > latest ? updatedAt : latest;
    }, cursor);
    const complete = successful.length === results.length && successful.every((result) => !result.value.truncated);
    return {
      items,
      ...(complete ? { cursor: newest ?? discoveredAt } : cursor ? { cursor } : {}),
      diagnostics: {
        articleCount: articles.length,
        itemCount: items.length,
        batchCount: batches.length,
        failedBatchCount: results.length - successful.length,
        truncatedBatchCount: successful.filter((result) => result.value.truncated).length,
        since: startAt.toISOString(),
      },
    };
  }

  private async fetchBatch(symbols: string[], startAt: string): Promise<NewsBatchResult> {
    const articles: NewsArticle[] = [];
    let pageToken: string | null = null;
    let truncated = false;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const url = new URL(NEWS_URL);
      url.searchParams.set("symbols", symbols.join(","));
      url.searchParams.set("start", startAt);
      url.searchParams.set("sort", "desc");
      url.searchParams.set("limit", "50");
      url.searchParams.set("include_content", "true");
      if (pageToken) url.searchParams.set("page_token", pageToken);
      const response = await fetchWithTimeout(url, {
        headers: {
          Accept: "application/json",
          "APCA-API-KEY-ID": this.config.keyId,
          "APCA-API-SECRET-KEY": this.config.secretKey,
          "User-Agent": "CatalystWatch/0.2 news monitor",
        },
      }, this.timeoutMs);
      const payload = NewsResponseSchema.parse(await response.json());
      articles.push(...payload.news);
      pageToken = payload.next_page_token ?? null;
      if (!pageToken) break;
      if (page === MAX_PAGES - 1) truncated = true;
    }
    return { articles, truncated };
  }
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}
