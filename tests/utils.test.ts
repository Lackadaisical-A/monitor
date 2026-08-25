import { describe, expect, it } from "vitest";
import {
  canonicalUrl,
  findWatchCompany,
  isCatalystCandidate,
  isoDate,
  jaccardSimilarity,
  normalizedHeadline,
  resolveWatchCompany,
  stripHtml,
} from "../src/utils.js";

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

  it("does not assign an unrelated headline from an incidental summary mention", () => {
    const watchlist = [{
      ticker: "MRNA",
      company: "Moderna",
      aliases: ["Moderna, Inc."],
      marketCapBand: "large" as const,
      xAccounts: [],
      programs: ["mRNA-4157"],
    }];
    expect(resolveWatchCompany({
      headline: "Lady Gaga and her fiance launch a biotech startup",
      summary: "A newsletter teaser also links to an older Moderna cancer-vaccine story.",
    }, watchlist)).toBeNull();
    expect(resolveWatchCompany({
      headline: "Moderna reports new mRNA-4157 cancer vaccine results",
      summary: "The primary endpoint was met.",
    }, watchlist)?.ticker).toBe("MRNA");
  });

  it("recognizes first-name issuer headlines and a broad set of actionable catalyst terms", () => {
    const watchlist = [{
      ticker: "AVXL",
      company: "Anavex Life Sciences",
      aliases: ["ANAVEX LIFE SCIENCES CORP."],
      marketCapBand: "small" as const,
      xAccounts: [],
      programs: ["ANAVEX2-73"],
    }];
    expect(resolveWatchCompany({
      headline: "Anavex announces a completed IND submission",
    }, watchlist)?.ticker).toBe("AVXL");
    expect(isCatalystCandidate("Anavex completed an IND submission and requested an FDA meeting", watchlist)).toBe(true);
    expect(isCatalystCandidate("Anavex entered a licensing and financing agreement", watchlist)).toBe(true);
  });

  it("distinguishes the CRL ticker from a Complete Response Letter catalyst", () => {
    const watchlist = [{
      ticker: "CRL",
      company: "Charles River Laboratories",
      aliases: ["Charles River"],
      marketCapBand: "large" as const,
      xAccounts: [],
      programs: [],
    }];

    expect(isCatalystCandidate(
      "Here's how much $100 invested in Charles River Laboratories 15 years ago would be worth today",
      watchlist,
    )).toBe(false);
    expect(isCatalystCandidate(
      "Charles River Laboratories received a CRL from FDA for its biologics application",
      watchlist,
    )).toBe(true);
  });
});
