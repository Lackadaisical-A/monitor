import { afterEach, describe, expect, it } from "vitest";
import { SignalDatabase } from "../src/db.js";
import type { NormalizedItem } from "../src/types.js";

let db: SignalDatabase | null = null;
afterEach(() => { db?.close(); db = null; });

describe("SignalDatabase", () => {
  it("deduplicates a source item and returns it in the feed", () => {
    db = new SignalDatabase(":memory:");
    const item: NormalizedItem = {
      id: "one", externalId: "ext-one",
      source: { id: "feed", name: "Feed", type: "outlet", tier: "secondary" },
      headline: "Trial result", summary: "Summary", url: "https://example.test/one", author: null,
      publishedAt: new Date().toISOString(), discoveredAt: new Date().toISOString(),
      companyHint: null, tickerHint: null, raw: {},
    };
    expect(db.insertItem(item)).toBe(true);
    expect(db.insertItem(item)).toBe(false);
    expect(db.listFeed()).toHaveLength(1);
    expect(db.getPendingItems()).toHaveLength(1);
  });
});
