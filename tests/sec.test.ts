import { afterEach, describe, expect, it, vi } from "vitest";
import { parseAtomFilings, SecFilingsSource } from "../src/sources/sec.js";

const filingEntry = `
  <entry>
    <title>8-K - Example Bio, Inc. (0001682852) (Filer)</title>
    <link rel="alternate" href="https://www.sec.gov/Archives/edgar/data/1682852/000123456726000001/0001234567-26-000001-index.htm" />
    <summary type="html">&lt;b&gt;Filed:&lt;/b&gt; 2026-08-22&lt;br&gt;Item 8.01: Other Events</summary>
    <updated>2026-08-22T09:15:00-04:00</updated>
    <category term="8-K" />
    <id>urn:tag:sec.gov,2008:accession-number=0001234567-26-000001</id>
  </entry>`;

function atom(entries = "") {
  return `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">${entries}</feed>`;
}

afterEach(() => vi.unstubAllGlobals());

describe("SEC current filings source", () => {
  it("parses accession, CIK, form, and filing timestamp from Atom", () => {
    expect(parseAtomFilings(atom(filingEntry))).toEqual([expect.objectContaining({
      accession: "0001234567-26-000001",
      cik: "1682852",
      form: "8-K",
      updatedAt: "2026-08-22T13:15:00.000Z",
    })]);
  });

  it("loads full filing text only for a watched CIK", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("type=8-K")) return new Response(atom(filingEntry), { status: 200 });
      if (url.includes("type=6-K")) return new Response(atom(), { status: 200 });
      if (url.includes("submissions/CIK0001682852.json")) {
        return Response.json({
          name: "Example Bio, Inc.",
          filings: { recent: {
            accessionNumber: ["0001234567-26-000001"],
            form: ["8-K"],
            primaryDocument: ["example-20260822.htm"],
            primaryDocDescription: ["Positive Phase 3 topline results"],
            items: ["8.01,9.01"],
          } },
        });
      }
      if (url.endsWith("/example-20260822.htm")) {
        return new Response("<html><body>Primary endpoint met with statistical significance.</body></html>", { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const source = new SecFilingsSource([{
      ticker: "EXBI",
      company: "Example Bio",
      aliases: [],
      cik: "1682852",
      marketCapBand: "small",
      xAccounts: [],
      programs: [],
    }], "CatalystWatch test@example.com", 5_000);

    const result = await source.fetch("2026-08-22T13:00:00.000Z");

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      tickerHint: "EXBI",
      headline: "Example Bio filed 8-K: Positive Phase 3 topline results",
      publishedAt: "2026-08-22T13:15:00.000Z",
    });
    expect(result.items[0]?.summary).toContain("Primary endpoint met with statistical significance.");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
