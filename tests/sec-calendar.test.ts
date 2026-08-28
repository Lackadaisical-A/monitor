import { afterEach, describe, expect, it, vi } from "vitest";
import { SecCalendarSource } from "../src/sources/sec-calendar.js";

afterEach(() => vi.unstubAllGlobals());

describe("SEC catalyst calendar backfill", () => {
  it("keeps only filings containing an explicitly dated future catalyst", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("data.sec.gov/submissions")) {
        return Response.json({
          name: "Example Bio, Inc.",
          filings: { recent: {
            accessionNumber: ["0001234567-26-000010", "0001234567-26-000009"],
            form: ["8-K", "8-K"],
            primaryDocument: ["dated.htm", "undated.htm"],
            primaryDocDescription: ["Regulatory update", "Corporate update"],
            items: ["8.01", "7.01"],
            filingDate: ["2026-02-10", "2026-02-01"],
            acceptanceDateTime: ["20260210143000", "20260201143000"],
          } },
        });
      }
      if (url.endsWith("/dated.htm")) {
        return new Response("<p>The FDA assigned ABC-101 a PDUFA target action date of September 30, 2026.</p>");
      }
      if (url.endsWith("/undated.htm")) {
        return new Response("<p>The company continues to work with the FDA on ABC-101.</p>");
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const source = new SecCalendarSource([{
      ticker: "EXBI",
      company: "Example Bio",
      aliases: ["Example Bio, Inc."],
      cik: "1234567",
      marketCapBand: "small",
      xAccounts: [],
      programs: ["ABC-101"],
    }], "CatalystWatch test@example.com", 5_000);

    const result = await source.fetch(null);

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      tickerHint: "EXBI",
      publishedAt: "2026-02-10T14:30:00.000Z",
      raw: { catalystWatch: { calendarOnly: true, backfill: "sec" } },
    });
    expect(result.items[0]?.summary).toContain("September 30, 2026");
    expect(JSON.parse(result.cursor!)).toMatchObject({ nextCompanyIndex: 1, completedAt: expect.any(String) });
  });
});
