import { afterEach, describe, expect, it, vi } from "vitest";
import { RssSource } from "../src/sources/rss.js";

afterEach(() => vi.unstubAllGlobals());

describe("RssSource", () => {
  it("persists recent item IDs so unchanged feeds do not hit the store again", async () => {
    const xml = `<?xml version="1.0"?>
      <rss><channel><item>
        <title>Moderna reports Phase 3 results</title>
        <link>https://example.test/moderna-results</link>
        <guid>release-1</guid>
        <pubDate>Sat, 22 Aug 2026 13:00:00 GMT</pubDate>
        <description>Primary endpoint met.</description>
      </item></channel></rss>`;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(xml, { status: 200 })));
    const source = new RssSource({
      id: "example-rss",
      name: "Example RSS",
      type: "rss",
      sourceType: "outlet",
      tier: "secondary",
      url: "https://example.test/feed.xml",
      tickers: [],
      enabled: true,
    }, [], 5_000);

    const first = await source.fetch(null);
    const second = await source.fetch(first.cursor ?? null);

    expect(first.items).toHaveLength(1);
    expect(JSON.parse(first.cursor ?? "{}")).toMatchObject({ itemIds: [first.items[0]?.id] });
    expect(second.items).toEqual([]);
    expect(second.diagnostics).toMatchObject({ entryCount: 1, newEntryCount: 0 });
  });

  it("does not tag a newsletter item from a company mentioned only in teaser copy", async () => {
    const xml = `<?xml version="1.0"?>
      <rss><channel><item>
        <title>Lady Gaga and her fiance launch a biotech startup</title>
        <link>https://example.test/unrelated-startup</link>
        <guid>newsletter-1</guid>
        <pubDate>Tue, 25 Aug 2026 14:57:00 GMT</pubDate>
        <description>An inside look back at how Moderna and Merck's cancer vaccine gamble paid off.</description>
      </item></channel></rss>`;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(xml, { status: 200 })));
    const source = new RssSource({
      id: "newsletter",
      name: "Newsletter",
      type: "rss",
      sourceType: "outlet",
      tier: "secondary",
      url: "https://example.test/feed.xml",
      tickers: [],
      enabled: true,
    }, [{
      ticker: "MRNA",
      company: "Moderna",
      aliases: ["Moderna, Inc."],
      marketCapBand: "large",
      xAccounts: [],
      programs: ["mRNA-4157"],
    }], 5_000);

    const result = await source.fetch(null);

    expect(result.items[0]).toMatchObject({ tickerHint: null, companyHint: null });
  });
});
