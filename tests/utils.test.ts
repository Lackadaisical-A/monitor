import { describe, expect, it } from "vitest";
import { canonicalUrl, findWatchCompany, isoDate, jaccardSimilarity, normalizedHeadline, stripHtml } from "../src/utils.js";

describe("normalization utilities", () => {
  it("removes fragments and known tracking parameters while preserving useful query parameters", () => {
    expect(canonicalUrl("HTTPS://Example.COM/news/?id=7&utm_source=x#section"))
      .toBe("https://example.com/news?id=7");
  });

  it("normalizes punctuation and whitespace in headlines", () => {
    expect(normalizedHeadline("  Phase 3: Met Primary Endpoint! ")).toBe("phase 3 met primary endpoint");
  });

  it("decodes numeric HTML entities from feed text", () => {
    expect(stripHtml("Company&#8217;s result &amp; outlook")).toBe("Company’s result & outlook");
  });

  it("parses publisher dates where am/pm is attached to the minute", () => {
    expect(isoDate("Aug 20, 2026 9:25am")).toMatch(/^2026-08-20T/);
  });

  it("matches watchlist aliases without treating a short ticker as a substring", () => {
    const watchlist = [{
      ticker: "EDIT",
      company: "Editas Medicine",
      aliases: ["Editas"],
      marketCapBand: "small" as const,
      xAccounts: [],
      programs: [],
    }];
    expect(findWatchCompany("Editas Medicine reports data", watchlist)?.ticker).toBe("EDIT");
    expect(findWatchCompany("Editors report data", watchlist)).toBeNull();
  });

  it("requires explicit market context for ambiguous short tickers", () => {
    const watchlist = [{
      ticker: "RNA",
      company: "Avidity Biosciences",
      aliases: ["$RNA"],
      marketCapBand: "mid" as const,
      xAccounts: [],
      programs: [],
    }];
    expect(findWatchCompany("The study measured RNA expression", watchlist)).toBeNull();
    expect(findWatchCompany("Avidity Biosciences (NASDAQ: RNA) reports data", watchlist)?.ticker).toBe("RNA");
  });

  it("matches an uppercase four-character ticker but not an ordinary lowercase word", () => {
    const watchlist = [{
      ticker: "EDIT",
      company: "Editas Medicine",
      aliases: [],
      marketCapBand: "small" as const,
      xAccounts: [],
      programs: [],
    }];
    expect(findWatchCompany("EDIT reports Phase 2 data", watchlist)?.ticker).toBe("EDIT");
    expect(findWatchCompany("Researchers edit immune cells", watchlist)).toBeNull();
  });

  it("scores near-duplicate catalyst headlines above unrelated headlines", () => {
    const related = jaccardSimilarity(
      "Acme reports positive Phase 3 trial results in melanoma",
      "Positive Phase III melanoma data reported by Acme",
    );
    const unrelated = jaccardSimilarity(
      "Acme reports positive Phase 3 trial results in melanoma",
      "Company appoints a new chief financial officer",
    );
    expect(related).toBeGreaterThan(0.4);
    expect(unrelated).toBeLessThan(related);
  });
});
