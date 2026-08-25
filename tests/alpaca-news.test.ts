import { afterEach, describe, expect, it, vi } from "vitest";
import { AlpacaNewsSource } from "../src/sources/alpaca-news.js";
import type { WatchCompany } from "../src/types.js";

afterEach(() => vi.unstubAllGlobals());

const watchlist: WatchCompany[] = [{
  ticker: "RGNX",
  company: "REGENXBIO",
  aliases: ["REGENXBIO Inc."],
  marketCapBand: "small",
  xAccounts: [],
  programs: ["RGX-121"],
}, {
  ticker: "MRNA",
  company: "Moderna",
  aliases: ["Moderna, Inc."],
  marketCapBand: "large",
  xAccounts: [],
  programs: ["mRNA-4157"],
}];

describe("AlpacaNewsSource", () => {
  it("ingests full licensed news content with structured ticker provenance", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => Response.json({
      news: [{
        id: 991,
        author: "Benzinga Newsdesk",
        created_at: "2026-08-25T08:30:00Z",
        updated_at: "2026-08-25T08:31:00Z",
        headline: "FDA places clinical hold on REGENXBIO gene therapy RGX-121",
        summary: "The filing plan is delayed.",
        content: "<p>The FDA imposed the hold after new MRI findings.</p>",
        url: "https://benzinga.test/news/991?utm_source=alpaca",
        symbols: ["RGNX"],
        source: "benzinga",
      }],
      next_page_token: null,
    }));
    vi.stubGlobal("fetch", fetchMock);
    const source = new AlpacaNewsSource({
      scope: "developer",
      keyId: "test-key",
      secretKey: "test-secret",
      feed: "iex",
      newsEnabled: true,
    }, watchlist, 5_000);

    const result = await source.fetch("2026-08-25T08:00:00Z");

    expect(result.items[0]).toMatchObject({
      tickerHint: "RGNX",
      companyHint: "REGENXBIO",
      provenance: "independent_reporting",
      independenceKey: "publisher:benzinga",
      summary: expect.stringContaining("FDA imposed the hold"),
    });
    expect(result.items[0]?.url).toBe("https://benzinga.test/news/991");
    const [request, init] = fetchMock.mock.calls[0]!;
    const url = new URL(String(request));
    expect(url.pathname).toBe("/v1beta1/news");
    expect(url.searchParams.get("symbols")).toContain("RGNX");
    expect(url.searchParams.get("include_content")).toBe("true");
    expect(init?.headers).toMatchObject({
      "APCA-API-KEY-ID": "test-key",
      "APCA-API-SECRET-KEY": "test-secret",
    });
  });

  it("does not assign a tagged company when it appears only in retrospective teaser copy", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      news: [{
        id: 992,
        created_at: "2026-08-25T14:57:00Z",
        headline: "Lady Gaga and her fiance launch a biotech startup",
        summary: "A related link looks back at Moderna's prior cancer-vaccine result.",
        url: "https://benzinga.test/news/992",
        symbols: ["MRNA"],
        source: "benzinga",
      }],
    })));
    const source = new AlpacaNewsSource({
      scope: "developer",
      keyId: "test-key",
      secretKey: "test-secret",
      feed: "iex",
      newsEnabled: true,
    }, watchlist, 5_000);

    const result = await source.fetch("2026-08-25T14:00:00Z");

    expect(result.items[0]).toMatchObject({ tickerHint: null, companyHint: null });
  });

  it("drops generic investment-performance chatter before analysis", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      news: [{
        id: 993,
        created_at: "2026-08-25T15:15:00Z",
        headline: "Here's how much $100 invested in Moderna 10 years ago would be worth today",
        summary: "A retrospective return calculation.",
        url: "https://benzinga.test/news/993",
        symbols: ["MRNA"],
        source: "benzinga",
      }],
    })));
    const source = new AlpacaNewsSource({
      scope: "developer",
      keyId: "test-key",
      secretKey: "test-secret",
      feed: "iex",
      newsEnabled: true,
    }, watchlist, 5_000);

    const result = await source.fetch("2026-08-25T15:00:00Z");

    expect(result.items).toEqual([]);
  });
});
