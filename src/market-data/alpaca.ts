import { z } from "zod";
import type { AppConfig } from "../config.js";
import { fetchWithTimeout } from "../sources/http.js";
import type { StockMovement } from "../types.js";
import { mapWithConcurrency } from "../utils.js";

const DATA_URL = "https://data.alpaca.markets";
const SYMBOL_BATCH_SIZE = 50;
const HISTORICAL_CONCURRENCY = 3;
const LIVE_CACHE_MS = 45_000;
const CLOSED_CACHE_MS = 24 * 60 * 60_000;
const EMPTY_CACHE_MS = 45_000;

const AlpacaBarSchema = z.object({
  t: z.string(),
  o: z.number(),
  h: z.number(),
  l: z.number(),
  c: z.number(),
});

const SnapshotSchema = z.object({
  dailyBar: AlpacaBarSchema.nullish(),
  prevDailyBar: AlpacaBarSchema.nullish(),
}).passthrough();

const SnapshotsResponseSchema = z.record(z.string(), SnapshotSchema.nullable());
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
  anchorDate: string;
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
      const anchorDate = eventSessionAnchorDate(request.publishedAt);
      if (!/^[A-Z][A-Z0-9.-]{0,11}$/.test(ticker) || !anchorDate) return [];
      return [{ ...request, ticker, anchorDate, cacheKey: `${ticker}:${anchorDate}` }];
    });
    const uniqueKeys = [...new Map(normalizedRequests.map((request) => [request.cacheKey, {
      cacheKey: request.cacheKey,
      ticker: request.ticker,
      anchorDate: request.anchorDate,
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
    const movements = new Map<string, StockMovement | null>(keys.map((key) => [key.cacheKey, null]));
    const today = newYorkParts(now).date;
    const snapshotSymbols = [...new Set(keys.filter((key) => key.anchorDate <= today).map((key) => key.ticker))];
    const snapshots = await this.fetchSnapshots(snapshotSymbols);

    for (const key of keys) {
      const snapshot = snapshots[key.ticker];
      if (!snapshot?.dailyBar || !snapshot.prevDailyBar) continue;
      const dailyDate = newYorkParts(new Date(snapshot.dailyBar.t)).date;
      const previousDate = newYorkParts(new Date(snapshot.prevDailyBar.t)).date;
      if (previousDate < key.anchorDate && dailyDate >= key.anchorDate) {
        movements.set(key.cacheKey, movementFromBars(key.ticker, snapshot.prevDailyBar, snapshot.dailyBar, now, this.feed));
      }
    }

    const unresolved = keys.filter((key) => !movements.get(key.cacheKey) && key.anchorDate <= today);
    const groups = [...groupBy(unresolved, (key) => key.anchorDate).entries()]
      .flatMap(([anchorDate, group]) => chunk(group, SYMBOL_BATCH_SIZE).map((batch) => ({ anchorDate, keys: batch })));
    const historical = await mapWithConcurrency(groups, HISTORICAL_CONCURRENCY, async (group) => ({
      group,
      bars: await this.fetchHistoricalBars(group.keys.map((key) => key.ticker), group.anchorDate, today),
    }));
    for (const load of historical) {
      if (load.status === "rejected") {
        this.onError(load.reason);
        continue;
      }
      for (const key of load.value.group.keys) {
        const movement = movementForAnchor(key.ticker, load.value.bars[key.ticker] ?? [], key.anchorDate, now, this.feed);
        if (movement) movements.set(key.cacheKey, movement);
      }
    }
    return movements;
  }

  private async fetchSnapshots(symbols: readonly string[]): Promise<Record<string, z.infer<typeof SnapshotSchema> | null>> {
    const snapshots: Record<string, z.infer<typeof SnapshotSchema> | null> = {};
    const results = await mapWithConcurrency(chunk([...symbols], SYMBOL_BATCH_SIZE), 3, async (batch) => {
      const url = new URL("/v2/stocks/snapshots", DATA_URL);
      url.searchParams.set("symbols", batch.join(","));
      url.searchParams.set("feed", this.feed);
      const response = await fetchWithTimeout(url, { headers: this.headers() }, this.timeoutMs);
      return SnapshotsResponseSchema.parse(await response.json());
    });
    for (const result of results) {
      if (result.status === "fulfilled") Object.assign(snapshots, result.value);
      else this.onError(result.reason);
    }
    return snapshots;
  }

  private async fetchHistoricalBars(symbols: readonly string[], anchorDate: string, today: string): Promise<Record<string, AlpacaBar[]>> {
    const bars: Record<string, AlpacaBar[]> = {};
    let pageToken: string | null = null;
    for (let page = 0; page < 5; page += 1) {
      const url = new URL("/v2/stocks/bars", DATA_URL);
      url.searchParams.set("symbols", [...new Set(symbols)].join(","));
      url.searchParams.set("timeframe", "1Day");
      url.searchParams.set("start", addDays(anchorDate, -10));
      url.searchParams.set("end", minDate(addDays(anchorDate, 8), addDays(today, 1)));
      url.searchParams.set("limit", "10000");
      url.searchParams.set("adjustment", "all");
      url.searchParams.set("feed", this.feed);
      url.searchParams.set("sort", "asc");
      if (pageToken) url.searchParams.set("page_token", pageToken);
      const response = await fetchWithTimeout(url, { headers: this.headers() }, this.timeoutMs);
      const payload = HistoricalBarsResponseSchema.parse(await response.json());
      for (const [ticker, tickerBars] of Object.entries(payload.bars)) {
        bars[ticker] = [...(bars[ticker] ?? []), ...tickerBars];
      }
      pageToken = payload.next_page_token ?? null;
      if (!pageToken) break;
      if (page === 4) throw new Error("Alpaca historical bars exceeded the pagination limit");
    }
    return bars;
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

export function eventSessionAnchorDate(publishedAt: string): string | null {
  const published = new Date(publishedAt);
  if (Number.isNaN(published.getTime())) return null;
  const parts = newYorkParts(published);
  return parts.hour >= 16 ? addDays(parts.date, 1) : parts.date;
}

function movementForAnchor(
  ticker: string,
  bars: readonly AlpacaBar[],
  anchorDate: string,
  now: Date,
  feed: "iex" | "sip",
): StockMovement | null {
  const sorted = [...bars].sort((left, right) => Date.parse(left.t) - Date.parse(right.t));
  const targetIndex = sorted.findIndex((bar) => newYorkParts(new Date(bar.t)).date >= anchorDate);
  if (targetIndex <= 0) return null;
  return movementFromBars(ticker, sorted[targetIndex - 1]!, sorted[targetIndex]!, now, feed);
}

function movementFromBars(
  ticker: string,
  previous: AlpacaBar,
  target: AlpacaBar,
  now: Date,
  feed: "iex" | "sip",
): StockMovement | null {
  if (previous.c <= 0 || target.c <= 0) return null;
  const sessionDate = newYorkParts(new Date(target.t)).date;
  const nowParts = newYorkParts(now);
  const change = target.c - previous.c;
  return {
    ticker,
    sessionDate,
    status: sessionDate === nowParts.date && nowParts.hour < 16 ? "live" : "closed",
    previousClose: decimal(previous.c),
    open: decimal(target.o),
    high: decimal(target.h),
    low: decimal(target.l),
    close: decimal(target.c),
    change: decimal(change),
    changePct: decimal((change / previous.c) * 100),
    fetchedAt: now.toISOString(),
    feed,
    provider: "alpaca",
    basis: "previous_close",
  };
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

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function minDate(left: string, right: string): string {
  return left < right ? left : right;
}

function decimal(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function cacheDuration(value: StockMovement | null): number {
  if (!value) return EMPTY_CACHE_MS;
  return value.status === "live" ? LIVE_CACHE_MS : CLOSED_CACHE_MS;
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
  return groups;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}
