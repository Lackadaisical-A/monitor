import { afterEach, describe, expect, it, vi } from "vitest";
import { AlpacaMarketDataService } from "../src/market-data/alpaca.js";

afterEach(() => vi.unstubAllGlobals());

describe("AlpacaMarketDataService", () => {
  it("measures regular-hours news from the last completed minute before publication", async () => {
    const baseline = bar("2026-08-24T13:30:00Z", 8.1, 8.2, 7.9, 8);
    const reaction = [
      bar("2026-08-24T13:32:00Z", 8, 8.2, 7.9, 8.1),
      bar("2026-08-24T14:00:00Z", 8.2, 8.4, 7.8, 8),
      bar("2026-08-24T14:59:00Z", 6.2, 6.3, 6, 6.16),
    ];
    const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const url = new URL(String(input));
      return barsResponse("RGNX", url.searchParams.get("sort") === "desc" ? [baseline] : reaction);
    });
    vi.stubGlobal("fetch", fetchMock);
    const service = configuredService(() => new Date("2026-08-24T15:00:00Z"));
    const request = { id: "rgnx-news", ticker: "RGNX", publishedAt: "2026-08-24T13:31:30Z" };

    const movements = await service.getMovements([request]);
    const cached = await service.getMovements([{ ...request, id: "rgnx-news-cached" }]);

    expect(movements.get("rgnx-news")).toMatchObject({
      sessionDate: "2026-08-24",
      status: "live",
      announcementAt: "2026-08-24T13:31:30.000Z",
      priceStartAt: "2026-08-24T13:31:00.000Z",
      priceEndAt: "2026-08-24T15:00:00.000Z",
      window: "since_announcement",
      refreshIntervalSeconds: 300,
      previousClose: 8,
      close: 6.16,
      changePct: -23,
      feed: "iex",
      basis: "pre_announcement_price",
    });
    expect(cached.get("rgnx-news-cached")?.changePct).toBe(-23);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const ascendingCall = fetchMock.mock.calls.find((call) => query(call).get("sort") === "asc")!;
    const baselineCall = fetchMock.mock.calls.find((call) => query(call).get("sort") === "desc")!;
    expect(query(ascendingCall).get("start")).toBe("2026-08-24T13:31:30.000Z");
    expect(query(baselineCall).get("end")).toBe("2026-08-24T13:30:59.999Z");
    expect((ascendingCall[1]?.headers as Record<string, string>)["APCA-API-KEY-ID"]).toBe("test-key");
    expect((ascendingCall[1]?.headers as Record<string, string>)["APCA-API-SECRET-KEY"]).toBe("test-secret");
  });

  it("preserves the premarket announcement gap from the prior close", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      return barsResponse("RGNX", url.searchParams.get("sort") === "desc"
        ? [bar("2026-08-21T19:59:00Z", 10.7, 10.72, 10.69, 10.71)]
        : [
          bar("2026-08-24T13:30:00Z", 8.39, 8.61, 8.3, 8.4),
          bar("2026-08-24T17:59:00Z", 7.9, 7.95, 7.77, 7.88),
        ]);
    });
    vi.stubGlobal("fetch", fetchMock);
    const service = configuredService(() => new Date("2026-08-24T18:00:00Z"));

    const movements = await service.getMovements([{
      id: "premarket-news",
      ticker: "RGNX",
      publishedAt: "2026-08-24T11:05:00Z",
    }]);

    expect(movements.get("premarket-news")).toMatchObject({
      sessionDate: "2026-08-24",
      status: "live",
      priceStartAt: "2026-08-21T20:00:00.000Z",
      previousClose: 10.71,
      close: 7.88,
      changePct: -26.4239,
    });
  });

  it("uses the prior session for a weekend announcement", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      return barsResponse("EXBI", url.searchParams.get("sort") === "desc"
        ? [bar("2026-08-21T19:59:00Z", 9.9, 10.1, 9.9, 10)]
        : [bar("2026-08-24T13:30:00Z", 10, 10.5, 9.9, 10.25)]);
    });
    vi.stubGlobal("fetch", fetchMock);
    const service = configuredService(() => new Date("2026-08-24T18:00:00Z"));

    const movements = await service.getMovements([{
      id: "weekend-news",
      ticker: "EXBI",
      publishedAt: "2026-08-22T14:00:00Z",
    }]);

    expect(movements.get("weekend-news")).toMatchObject({
      sessionDate: "2026-08-22",
      priceStartAt: "2026-08-21T20:00:00.000Z",
      previousClose: 10,
      close: 10.25,
      changePct: 2.5,
    });
  });

  it("freezes an older announcement at its five-day cutoff", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      return barsResponse("EXBI", url.searchParams.get("sort") === "desc"
        ? [bar("2026-08-24T11:59:00Z", 9.9, 10.1, 9.9, 10)]
        : [
          bar("2026-08-24T12:01:00Z", 10, 10.2, 9.9, 10.1),
          bar("2026-08-28T19:59:00Z", 11.8, 12.1, 11.7, 12),
        ]);
    });
    vi.stubGlobal("fetch", fetchMock);
    const service = configuredService(() => new Date("2026-08-30T18:00:00Z"));

    const movements = await service.getMovements([{
      id: "old-news",
      ticker: "EXBI",
      publishedAt: "2026-08-24T12:00:00Z",
    }]);

    expect(movements.get("old-news")).toMatchObject({
      status: "closed",
      cutoffAt: "2026-08-29T12:00:00.000Z",
      window: "five_day",
      previousClose: 10,
      close: 12,
      changePct: 20,
    });
    const ascendingCall = fetchMock.mock.calls.find((call) => query(call).get("sort") === "asc")!;
    expect(query(ascendingCall).get("end")).toBe("2026-08-29T12:00:00.000Z");
  });

  it("refreshes a live return after five minutes and incrementally requests new bars", async () => {
    let now = new Date("2026-08-24T14:00:00Z");
    let reactionCalls = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.searchParams.get("sort") === "desc") {
        return barsResponse("EXBI", [bar("2026-08-24T13:29:00Z", 9.9, 10.1, 9.9, 10)]);
      }
      reactionCalls += 1;
      return barsResponse("EXBI", reactionCalls === 1
        ? [
          bar("2026-08-24T13:30:00Z", 10, 10.2, 9.9, 10),
          bar("2026-08-24T13:59:00Z", 10.9, 11.1, 10.8, 11),
        ]
        : [bar("2026-08-24T14:04:00Z", 11.8, 12.1, 11.7, 12)]);
    });
    vi.stubGlobal("fetch", fetchMock);
    const service = configuredService(() => now);
    const request = { id: "live", ticker: "EXBI", publishedAt: "2026-08-24T13:30:00Z" };

    expect((await service.getMovements([request])).get("live")?.changePct).toBe(10);
    now = new Date("2026-08-24T14:04:59Z");
    expect((await service.getMovements([request])).get("live")?.changePct).toBe(10);
    now = new Date("2026-08-24T14:05:01Z");
    const updated = (await service.getMovements([request])).get("live");
    expect(updated).toMatchObject({ changePct: 20, high: 12.1, low: 9.9 });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const ascendingCalls = fetchMock.mock.calls.filter((call) => query(call).get("sort") === "asc");
    expect(query(ascendingCalls[1]!).get("start")).toBe("2026-08-24T14:00:00.000Z");
  });

  it("does not call Alpaca when market data is disabled", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const service = new AlpacaMarketDataService({
      scope: "disabled",
      keyId: "test-key",
      secretKey: "test-secret",
      feed: "iex",
    });

    expect(await service.getMovements([{ id: "item", ticker: "EXBI", publishedAt: new Date().toISOString() }]))
      .toEqual(new Map());
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function configuredService(now: () => Date) {
  return new AlpacaMarketDataService({
    scope: "developer",
    keyId: "test-key",
    secretKey: "test-secret",
    feed: "iex",
  }, { now });
}

function query(call: readonly unknown[]): URLSearchParams {
  return new URL(String(call[0])).searchParams;
}

function barsResponse(ticker: string, bars: ReturnType<typeof bar>[]) {
  return Response.json({ bars: { [ticker]: bars }, next_page_token: null });
}

function bar(t: string, o: number, h: number, l: number, c: number) {
  return { t, o, h, l, c };
}
