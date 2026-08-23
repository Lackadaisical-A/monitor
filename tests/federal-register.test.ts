import { afterEach, describe, expect, it, vi } from "vitest";
import { FdaAdvisorySource } from "../src/sources/federal-register.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("FDA advisory committee source", () => {
  it("normalizes official notices and associates watched companies", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-23T16:30:00.000Z"));
    const fetchMock = vi.fn(async (_input: string | URL | Request) => Response.json({
      count: 2,
      total_pages: 1,
      results: [{
        title: "Oncologic Drugs Advisory Committee Meeting Announcement for Moderna",
        abstract: "<p>The committee will discuss mRNA-4157.</p>",
        excerpts: "Meeting materials will be published before the hearing.",
        document_number: "2026-18415",
        html_url: "https://www.federalregister.gov/documents/2026/08/22/2026-18415/example",
        publication_date: "2026-08-22",
      }, {
        title: "Incomplete notice",
      }],
    }));
    vi.stubGlobal("fetch", fetchMock);
    const source = new FdaAdvisorySource([{
      ticker: "MRNA",
      company: "Moderna",
      aliases: ["Moderna, Inc."],
      cik: "0001682852",
      marketCapBand: "large",
      xAccounts: [],
      programs: ["mRNA-4157"],
    }], 5_000);

    const result = await source.fetch("2026-08-21T13:00:00.000Z");
    const requestedURL = new URL(String(fetchMock.mock.calls[0]?.[0]));

    expect(requestedURL.hostname).toBe("www.federalregister.gov");
    expect(requestedURL.searchParams.get("conditions[agencies][]"))
      .toBe("food-and-drug-administration");
    expect(requestedURL.searchParams.get("conditions[publication_date][gte]"))
      .toBe("2026-08-20");
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      externalId: "2026-18415",
      tickerHint: "MRNA",
      companyHint: "Moderna",
      publishedAt: "2026-08-22T12:00:00.000Z",
      source: { type: "regulator", tier: "primary" },
    });
    expect(result.items[0]?.summary).toContain("The committee will discuss mRNA-4157.");
    expect(result.cursor).toBe("2026-08-23T16:30:00.000Z");
    expect(result.diagnostics).toEqual({ resultCount: 2, itemCount: 1, totalPages: 1 });
  });
});
