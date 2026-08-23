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
});
