import { z } from "zod";
import type { AppConfig } from "../config.js";
import { fetchWithTimeout } from "../sources/http.js";
import type { StockMovement } from "../types.js";
import { mapWithConcurrency } from "../utils.js";

const DATA_URL = "https://data.alpaca.markets";
const HISTORICAL_CONCURRENCY = 3;
const RETURN_WINDOW_MS = 5 * 24 * 60 * 60_000;
const BASELINE_LOOKBACK_MS = 30 * 24 * 60 * 60_000;
const LIVE_CACHE_MS = 5 * 60_000;
const CLOSED_CACHE_MS = 24 * 60 * 60_000;
const EMPTY_CACHE_MS = 5 * 60_000;

const AlpacaBarSchema = z.object({
  t: z.string(),
  o: z.number(),
  h: z.number(),
  l: z.number(),
  c: z.number(),
});

const HistoricalBarsResponseSchema = z.object({
  bars: z.record(z.string(), z.array(AlpacaBarSchema)),
  next_page_token: z.string().nullable().optional(),
});

type AlpacaBar = z.infer<typeof AlpacaBarSchema>;

export interface StockMovementRequest {
  id: string;
  ticker: string;
  publishedAt: string;
}

export interface MarketDataProvider {
  readonly configured: boolean;
  readonly feed: "iex" | "sip";
  getMovements(requests: readonly StockMovementRequest[]): Promise<Map<string, StockMovement>>;
}

interface MovementKey {
  cacheKey: string;
  ticker: string;
  publishedAt: string;
  cutoffAt: string;
}

interface CacheEntry {
  value: StockMovement | null;
  expiresAt: number;
}

interface AlpacaOptions {
  timeoutMs?: number;
  now?: () => Date;
  onError?: (error: unknown) => void;
}

export class AlpacaMarketDataService implements MarketDataProvider {
  readonly configured: boolean;
  readonly feed: "iex" | "sip";
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<StockMovement | null>>();
  private readonly timeoutMs: number;
  private readonly now: () => Date;
  private readonly onError: (error: unknown) => void;

  constructor(private readonly config: AppConfig["alpaca"], options: AlpacaOptions = {}) {
    this.configured = config.scope !== "disabled" && Boolean(config.keyId && config.secretKey);
    this.feed = config.feed;
    this.timeoutMs = options.timeoutMs ?? 8_000;
    this.now = options.now ?? (() => new Date());
    this.onError = options.onError ?? (() => {});
  }

  async getMovements(requests: readonly StockMovementRequest[]): Promise<Map<string, StockMovement>> {
    const result = new Map<string, StockMovement>();
    if (!this.configured || !requests.length) return result;

    const normalizedRequests = requests.flatMap((request) => {
      const ticker = request.ticker.trim().toUpperCase();
      const published = new Date(request.publishedAt);
      if (!/^[A-Z][A-Z0-9.-]{0,11}$/.test(ticker) || Number.isNaN(published.getTime())) return [];
      const publishedAt = published.toISOString();
      return [{
        ...request,
        ticker,
        publishedAt,
        cutoffAt: new Date(published.getTime() + RETURN_WINDOW_MS).toISOString(),
        cacheKey: `${ticker}:${publishedAt}`,
      }];
    });
    const uniqueKeys = [...new Map(normalizedRequests.map((request) => [request.cacheKey, {
      cacheKey: request.cacheKey,
      ticker: request.ticker,
      publishedAt: request.publishedAt,
      cutoffAt: request.cutoffAt,
    }])).values()];
    const now = this.now();
    const missing = uniqueKeys.filter((key) => {
      const cached = this.cache.get(key.cacheKey);
      return !(cached && cached.expiresAt > now.getTime()) && !this.inFlight.has(key.cacheKey);
    });

    if (missing.length) {
      const batch = this.loadMissing(missing, now).catch((error) => {
        this.onError(error);
        return new Map<string, StockMovement | null>();
      });
      for (const key of missing) {
        const pending = batch.then((values) => values.get(key.cacheKey) ?? null)
          .then((value) => {
            this.cache.set(key.cacheKey, {
              value,
              expiresAt: now.getTime() + cacheDuration(value),
            });
            return value;
          })
          .finally(() => this.inFlight.delete(key.cacheKey));
        this.inFlight.set(key.cacheKey, pending);
      }
    }

    const values = new Map<string, StockMovement | null>();
    await Promise.all(uniqueKeys.map(async (key) => {
      const cached = this.cache.get(key.cacheKey);
      if (cached && cached.expiresAt > now.getTime()) {
        values.set(key.cacheKey, cached.value);
        return;
      }
      const pending = this.inFlight.get(key.cacheKey);
      values.set(key.cacheKey, pending ? await pending : null);
    }));
    for (const request of normalizedRequests) {
      const movement = values.get(request.cacheKey);
      if (movement) result.set(request.id, movement);
    }
    return result;
  }

  private async loadMissing(keys: readonly MovementKey[], now: Date): Promise<Map<string, StockMovement | null>> {
    const movements = new Map<string, StockMovement | null>();
    const loaded = await mapWithConcurrency(keys, HISTORICAL_CONCURRENCY, async (key) => {
      const previous = this.cache.get(key.cacheKey)?.value ?? null;
      return this.loadMovement(key, now, previous);
    });
    loaded.forEach((result, index) => {
      const key = keys[index]!;
      if (result.status === "fulfilled") {
        movements.set(key.cacheKey, result.value);
      } else {
        this.onError(result.reason);
        movements.set(key.cacheKey, this.cache.get(key.cacheKey)?.value ?? null);
      }
    });
    return movements;
  }

  private async loadMovement(
    key: MovementKey,
    now: Date,
    previous: StockMovement | null,
  ): Promise<StockMovement | null> {
    const publishedMs = Date.parse(key.publishedAt);
    if (publishedMs > now.getTime()) return null;
    const cutoffMs = Date.parse(key.cutoffAt);
    const endMs = Math.min(now.getTime(), cutoffMs);
    const queryStart = previous
      ? laterTimestamp(key.publishedAt, previous.priceEndAt)
      : key.publishedAt;
    const [baseline, bars] = await Promise.all([
      previous ? Promise.resolve(null) : this.fetchBaselineBar(key.ticker, key.publishedAt),
      this.fetchHistoricalBars(key.ticker, queryStart, new Date(endMs).toISOString()),
    ]);
    return movementFromBars(key, bars, baseline, previous, now, this.feed);
  }

  private async fetchBaselineBar(ticker: string, publishedAt: string): Promise<AlpacaBar | null> {
    const publishedMs = Date.parse(publishedAt);
    const url = new URL("/v2/stocks/bars", DATA_URL);
    url.searchParams.set("symbols", ticker);
    url.searchParams.set("timeframe", "1Min");
    url.searchParams.set("start", new Date(publishedMs - BASELINE_LOOKBACK_MS).toISOString());
    url.searchParams.set("end", new Date(Math.floor(publishedMs / 60_000) * 60_000 - 1).toISOString());
    url.searchParams.set("limit", "1");
    url.searchParams.set("adjustment", "all");
    url.searchParams.set("feed", this.feed);
    url.searchParams.set("sort", "desc");
    const response = await fetchWithTimeout(url, { headers: this.headers() }, this.timeoutMs);
    const payload = HistoricalBarsResponseSchema.parse(await response.json());
    return payload.bars[ticker]?.[0] ?? null;
  }

  private async fetchHistoricalBars(ticker: string, startAt: string, endAt: string): Promise<AlpacaBar[]> {
    const bars: AlpacaBar[] = [];
    let pageToken: string | null = null;
    for (let page = 0; page < 5; page += 1) {
      const url = new URL("/v2/stocks/bars", DATA_URL);
      url.searchParams.set("symbols", ticker);
      url.searchParams.set("timeframe", "1Min");
      url.searchParams.set("start", startAt);
      url.searchParams.set("end", endAt);
      url.searchParams.set("limit", "10000");
      url.searchParams.set("adjustment", "all");
      url.searchParams.set("feed", this.feed);
      url.searchParams.set("sort", "asc");
      if (pageToken) url.searchParams.set("page_token", pageToken);
      const response = await fetchWithTimeout(url, { headers: this.headers() }, this.timeoutMs);
      const payload = HistoricalBarsResponseSchema.parse(await response.json());
      bars.push(...(payload.bars[ticker] ?? []));
      pageToken = payload.next_page_token ?? null;
      if (!pageToken) break;
      if (page === 4) throw new Error("Alpaca historical bars exceeded the pagination limit");
    }
    return [...new Map(bars.map((bar) => [bar.t, bar])).values()]
      .sort((left, right) => Date.parse(left.t) - Date.parse(right.t));
  }

  private headers(): Record<string, string> {
    return {
      Accept: "application/json",
      "APCA-API-KEY-ID": this.config.keyId,
      "APCA-API-SECRET-KEY": this.config.secretKey,
      "User-Agent": "CatalystWatch/0.1 market movement",
    };
  }
}

function movementFromBars(
  key: MovementKey,
  bars: readonly AlpacaBar[],
  baseline: AlpacaBar | null,
  previous: StockMovement | null,
  now: Date,
  feed: "iex" | "sip",
): StockMovement | null {
  const publishedMs = Date.parse(key.publishedAt);
  const endMs = Math.min(now.getTime(), Date.parse(key.cutoffAt));
  const sorted = [...bars]
    .filter((bar) => {
      const timestamp = Date.parse(bar.t);
      return timestamp >= publishedMs && timestamp + 60_000 <= endMs;
    })
    .sort((left, right) => Date.parse(left.t) - Date.parse(right.t));
  const first = sorted[0];
  const last = sorted.at(-1);
  if (!previous && (!baseline || baseline.c <= 0)) return null;
  const startPrice = previous?.previousClose ?? baseline!.c;
  const endPrice = last?.c ?? previous?.close ?? startPrice;
  if (!endPrice || startPrice <= 0 || endPrice <= 0) return null;
  const rangeHighs = sorted.map((bar) => bar.h);
  const rangeLows = sorted.map((bar) => bar.l);
  const change = endPrice - startPrice;
  const closed = now.getTime() >= Date.parse(key.cutoffAt);
  const priceStartAt = previous?.priceStartAt ?? barEndAt(baseline!);
  return {
    ticker: key.ticker,
    sessionDate: previous?.sessionDate ?? newYorkParts(new Date(key.publishedAt)).date,
    status: closed ? "closed" : "live",
    announcementAt: key.publishedAt,
    priceStartAt,
    priceEndAt: last ? barEndAt(last) : previous?.priceEndAt ?? priceStartAt,
    cutoffAt: key.cutoffAt,
    window: closed ? "five_day" : "since_announcement",
    refreshIntervalSeconds: LIVE_CACHE_MS / 1000,
    previousClose: decimal(startPrice),
    open: decimal(startPrice),
    high: decimal(Math.max(previous?.high ?? startPrice, startPrice, ...rangeHighs)),
    low: decimal(Math.min(previous?.low ?? startPrice, startPrice, ...rangeLows)),
    close: decimal(endPrice),
    change: decimal(change),
    changePct: decimal((change / startPrice) * 100),
    fetchedAt: now.toISOString(),
    feed,
    provider: "alpaca",
    basis: "pre_announcement_price",
  };
}

function barEndAt(bar: AlpacaBar): string {
  return new Date(Date.parse(bar.t) + 60_000).toISOString();
}

function laterTimestamp(left: string, right: string): string {
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

function newYorkParts(date: Date): { date: string; hour: number } {
  const values = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    hour: Number(values.hour),
  };
}

function decimal(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function cacheDuration(value: StockMovement | null): number {
  if (!value) return EMPTY_CACHE_MS;
  return value.status === "live" ? LIVE_CACHE_MS : CLOSED_CACHE_MS;
}
