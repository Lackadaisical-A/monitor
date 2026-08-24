import { afterEach, describe, expect, it, vi } from "vitest";
import { QuoteMediaPressReleaseSource } from "../src/sources/quote-media.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("QuoteMediaPressReleaseSource", () => {
  it("normalizes the full story from a company investor-relations feed", async () => {
    const publishedAt = new Date().toISOString();
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes("getHeadlines")) {
        return Response.json({
          results: {
            news: [{
              topicstring: "MRNA",
              newsitem: [{
                newsid: 123,
                datetime: publishedAt,
                source: "Business Wire via QuoteMedia",
                headline: "Moderna reports Phase 3 trial met its primary endpoint",
                qmsummary: "Short summary",
                permalink: "https://www.businesswire.com/news/home/example/en/",
              }],
            }],
          },
        });
      }
      return Response.json({
        qmcistory: {
          qmnews: { qmstory: { qmtext: "<p>The trial met its primary endpoint with p&lt;0.01.</p>" } },
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const source = new QuoteMediaPressReleaseSource({
      id: "moderna-ir",
      name: "Moderna investor relations",
      type: "quote_media",
      sourceType: "company_ir",
      tier: "primary",
      symbol: "MRNA",
      symbols: [],
      watchlist: false,
      enabled: true,
    }, [{
      ticker: "MRNA",
      company: "Moderna",
      aliases: ["Moderna, Inc."],
      cik: "0001682852",
      marketCapBand: "large",
      xAccounts: [],
      programs: ["mRNA-4157"],
    }], 5_000);

    const result = await source.fetch(null);

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.source.tier).toBe("primary");
    expect(result.items[0]?.tickerHint).toBe("MRNA");
    expect(result.items[0]?.summary).toContain("met its primary endpoint with p<0.01");
    expect(result.items[0]?.url).toBe("https://www.businesswire.com/news/home/example/en");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("replays the prior day without advancing an empty cursor", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-21T18:00:00.000Z"));
    const fetchMock = vi.fn(async (_input: string | URL | Request) => Response.json({ results: { news: [] } }));
    vi.stubGlobal("fetch", fetchMock);
    const source = new QuoteMediaPressReleaseSource({
      id: "moderna-ir",
      name: "Moderna investor relations",
      type: "quote_media",
      sourceType: "company_ir",
      tier: "primary",
      symbol: "MRNA",
      symbols: [],
      watchlist: false,
      enabled: true,
    }, [], 5_000);

    const cursor = "2026-08-21T16:00:00.000Z";
    const result = await source.fetch(cursor);
    const requestURL = new URL(String(fetchMock.mock.calls[0]?.[0]));

    expect(requestURL.searchParams.get("start")).toBe("2026-08-21");
    expect(result.cursor).toBe(cursor);
    expect(result.items).toEqual([]);
  });

  it("keeps retrying the initial lookback when no releases are returned", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ results: { news: [] } })));
    const source = new QuoteMediaPressReleaseSource({
      id: "moderna-ir",
      name: "Moderna investor relations",
      type: "quote_media",
      sourceType: "company_ir",
      tier: "primary",
      symbol: "MRNA",
      symbols: [],
      watchlist: false,
      enabled: true,
    }, [], 5_000);

    expect((await source.fetch(null)).cursor).toBeUndefined();
  });

  it("uses the requested topic to map broad-watchlist releases", async () => {
    const publishedAt = new Date().toISOString();
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes("getStory")) return Response.json({ qmcistory: {} });
      return Response.json({
        results: {
          news: [{
            topicstring: "VRTX",
            newsitem: [{
              newsid: 456,
              datetime: publishedAt,
              headline: "Positive pivotal results announced for the ALPINE program",
              qmsummary: "The primary endpoint was met.",
              permalink: "https://example.test/alpine-results",
            }],
          }],
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const source = new QuoteMediaPressReleaseSource({
      id: "watchlist-press-releases",
      name: "Watchlist company press releases",
      type: "quote_media",
      sourceType: "company_ir",
      tier: "primary",
      symbols: [],
      watchlist: true,
      enabled: true,
    }, [{
      ticker: "VRTX",
      company: "Vertex Pharmaceuticals",
      aliases: [],
      cik: "0000875320",
      marketCapBand: "large",
      xAccounts: [],
      programs: [],
    }], 5_000);

    const result = await source.fetch(null);

    expect(result.items[0]).toMatchObject({
      source: { type: "company_ir", tier: "primary" },
      tickerHint: "VRTX",
      companyHint: "Vertex Pharmaceuticals",
    });
  });
});
