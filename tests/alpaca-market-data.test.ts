import { afterEach, describe, expect, it, vi } from "vitest";
import { AlpacaMarketDataService, eventSessionAnchorDate } from "../src/market-data/alpaca.js";

afterEach(() => vi.unstubAllGlobals());

describe("AlpacaMarketDataService", () => {
  it("maps premarket news to the same session and calculates change from the prior close", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => Response.json({
      RGNX: {
        dailyBar: bar("2026-08-24T04:00:00Z", 6.7, 6.9, 5.9, 6.16),
        prevDailyBar: bar("2026-08-21T04:00:00Z", 8.1, 8.2, 7.9, 8),
      },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const service = configuredService("2026-08-24T14:00:00Z");

    const movements = await service.getMovements([{
      id: "rgnx-news",
      ticker: "RGNX",
      publishedAt: "2026-08-24T11:05:00Z",
    }]);
    await service.getMovements([{
      id: "rgnx-news-cached",
      ticker: "RGNX",
      publishedAt: "2026-08-24T11:05:00Z",
    }]);

    expect(movements.get("rgnx-news")).toMatchObject({
      sessionDate: "2026-08-24",
      status: "live",
      previousClose: 8,
      close: 6.16,
      changePct: -23,
      feed: "iex",
      basis: "previous_close",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [input, init] = fetchMock.mock.calls[0]!;
    expect(String(input)).toContain("/v2/stocks/snapshots");
    expect((init?.headers as Record<string, string>)["APCA-API-KEY-ID"]).toBe("test-key");
    expect((init?.headers as Record<string, string>)["APCA-API-SECRET-KEY"]).toBe("test-secret");
  });

  it("maps an after-close announcement to the next trading session", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      EXBI: {
        dailyBar: bar("2026-08-25T04:00:00Z", 15, 16, 14, 15.75),
        prevDailyBar: bar("2026-08-24T04:00:00Z", 12, 13, 11, 12.5),
      },
    })));
    const service = configuredService("2026-08-25T18:00:00Z");

    const movements = await service.getMovements([{
      id: "night-news",
      ticker: "EXBI",
      publishedAt: "2026-08-24T21:30:00Z",
    }]);

    expect(movements.get("night-news")).toMatchObject({
      sessionDate: "2026-08-25",
      status: "live",
      previousClose: 12.5,
      close: 15.75,
      changePct: 26,
    });
  });

  it("uses Alpaca's returned sessions to skip a weekend", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      EXBI: {
        dailyBar: bar("2026-08-24T04:00:00Z", 9, 10, 8, 9.5),
        prevDailyBar: bar("2026-08-21T04:00:00Z", 10, 10.5, 9.5, 10),
      },
    })));
    const service = configuredService("2026-08-24T18:00:00Z");

    const movements = await service.getMovements([{
      id: "weekend-news",
      ticker: "EXBI",
      publishedAt: "2026-08-22T14:00:00Z",
    }]);

    expect(movements.get("weekend-news")?.sessionDate).toBe("2026-08-24");
  });

  it("falls back to historical daily bars for an older announcement", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes("snapshots")) {
        return Response.json({
          EXBI: {
            dailyBar: bar("2026-08-24T04:00:00Z", 20, 21, 19, 20),
            prevDailyBar: bar("2026-08-21T04:00:00Z", 19, 20, 18, 19),
          },
        });
      }
      return Response.json({
        bars: {
          EXBI: [
            bar("2026-08-19T04:00:00Z", 9, 10, 8, 10),
            bar("2026-08-20T04:00:00Z", 8, 9, 7, 8),
          ],
        },
        next_page_token: null,
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const service = configuredService("2026-08-24T18:00:00Z");

    const movements = await service.getMovements([{
      id: "old-news",
      ticker: "EXBI",
      publishedAt: "2026-08-20T12:00:00Z",
    }]);

    expect(movements.get("old-news")).toMatchObject({
      sessionDate: "2026-08-20",
      status: "closed",
      changePct: -20,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
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

describe("eventSessionAnchorDate", () => {
  it("keeps premarket news on the same New York date", () => {
    expect(eventSessionAnchorDate("2026-08-24T08:30:00Z")).toBe("2026-08-24");
  });

  it("moves news at the regular close to the following date", () => {
    expect(eventSessionAnchorDate("2026-08-24T20:00:00Z")).toBe("2026-08-25");
  });
});

function configuredService(now: string) {
  return new AlpacaMarketDataService({
    scope: "developer",
    keyId: "test-key",
    secretKey: "test-secret",
    feed: "iex",
  }, { now: () => new Date(now) });
}

function bar(t: string, o: number, h: number, l: number, c: number) {
  return { t, o, h, l, c };
}
