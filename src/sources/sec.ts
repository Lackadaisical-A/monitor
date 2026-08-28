import { XMLParser } from "fast-xml-parser";
import type { NormalizedItem, SourceAdapter, SourceFetchResult, WatchCompany } from "../types.js";
import { canonicalUrl, itemId, stripHtml } from "../utils.js";
import { fetchSec } from "./sec-http.js";

interface SecSubmissions {
  name?: string;
  filings?: {
    recent?: {
      accessionNumber?: string[];
      form?: string[];
      primaryDocument?: string[];
      primaryDocDescription?: string[];
      items?: string[];
    };
  };
}

interface AtomFiling {
  accession: string;
  cik: string;
  form: string;
  indexUrl: string;
  summary: string;
  updatedAt: string;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  processEntities: true,
});

export class SecFilingsSource implements SourceAdapter {
  readonly descriptor = { id: "sec-edgar", name: "SEC EDGAR", type: "sec", tier: "primary" } as const;

  constructor(
    private readonly watchlist: WatchCompany[],
    private readonly userAgent: string,
    private readonly timeoutMs: number,
  ) {}

  async fetch(cursor: string | null): Promise<SourceFetchResult> {
    const discoveredAt = new Date().toISOString();
    const cursorTime = cursor && Number.isFinite(Date.parse(cursor))
      ? Date.parse(cursor) - 10 * 60_000
      : Date.now() - 48 * 60 * 60_000;
    const companiesByCik = new Map(this.watchlist
      .filter((company) => company.cik)
      .map((company) => [normalizeCik(company.cik!), company]));
    const formResults = await Promise.allSettled([
      this.fetchCurrentFilings("8-K", cursorTime),
      this.fetchCurrentFilings("6-K", cursorTime),
    ]);
    const successful = formResults.filter((result): result is PromiseFulfilledResult<AtomFiling[]> => result.status === "fulfilled");
    if (!successful.length) {
      const failure = formResults.find((result): result is PromiseRejectedResult => result.status === "rejected");
      throw failure?.reason ?? new Error("SEC current filings feeds were unavailable");
    }

    const feedFilings = successful.flatMap((result) => result.value);
    const watched = feedFilings.filter((filing) => companiesByCik.has(filing.cik));
    const submissionCache = new Map<string, Promise<SecSubmissions>>();
    const items: NormalizedItem[] = [];
    for (const filing of watched) {
      const company = companiesByCik.get(filing.cik)!;
      const submissions = await this.getSubmissions(filing.cik, submissionCache).catch(() => null);
      const recent = submissions?.filings?.recent;
      const filingIndex = recent?.accessionNumber?.findIndex((accession) => accession === filing.accession) ?? -1;
      const primaryDocument = filingIndex >= 0 ? recent?.primaryDocument?.[filingIndex] : undefined;
      const description = filingIndex >= 0
        ? recent?.primaryDocDescription?.[filingIndex] || `${filing.form} current report`
        : `${filing.form} current report`;
      const itemNumbers = filingIndex >= 0 ? recent?.items?.[filingIndex] ?? "" : "";
      const documentUrl = primaryDocument
        ? canonicalUrl(`https://www.sec.gov/Archives/edgar/data/${filing.cik}/${filing.accession.replaceAll("-", "")}/${primaryDocument}`)
        : filing.indexUrl;
      let filingText = "";
      if (primaryDocument) {
        try {
          const response = await fetchSec(documentUrl, {
            headers: { "User-Agent": this.userAgent, Accept: "text/html, text/plain;q=0.9" },
          }, this.timeoutMs);
          filingText = stripHtml(await response.text()).slice(0, 25_000);
        } catch (error) {
          filingText = `Primary filing document could not be fetched: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
      const headline = `${company.company} filed ${filing.form}: ${description}`;
      items.push({
        id: itemId(this.descriptor.id, filing.accession, documentUrl, headline),
        externalId: filing.accession,
        source: this.descriptor,
        headline,
        summary: [
          `SEC form: ${filing.form}`,
          itemNumbers ? `8-K item numbers: ${itemNumbers}` : "",
          `Accession: ${filing.accession}`,
          filing.summary,
          filingText,
        ].filter(Boolean).join("\n"),
        url: documentUrl,
        author: submissions?.name ?? company.company,
        publishedAt: filing.updatedAt,
        discoveredAt,
        companyHint: company.company,
        tickerHint: company.ticker,
        provenance: "direct_primary",
        independenceKey: `sec:${filing.accession}`,
        raw: {
          accession: filing.accession,
          cik: filing.cik,
          form: filing.form,
          primaryDocument: primaryDocument ?? null,
          primaryDocDescription: description,
          items: itemNumbers,
        },
      });
    }

    return {
      items,
      cursor: discoveredAt,
      diagnostics: {
        feedEntryCount: feedFilings.length,
        matchedFilingCount: watched.length,
        failedFeedCount: formResults.length - successful.length,
        since: new Date(cursorTime).toISOString(),
      },
    };
  }

  private async fetchCurrentFilings(form: "8-K" | "6-K", sinceTime: number): Promise<AtomFiling[]> {
    const filings: AtomFiling[] = [];
    for (let start = 0; start < 500; start += 100) {
      const url = new URL("https://www.sec.gov/cgi-bin/browse-edgar");
      url.search = new URLSearchParams({
        action: "getcurrent",
        type: form,
        company: "",
        dateb: "",
        owner: "include",
        start: String(start),
        count: "100",
        output: "atom",
      }).toString();
      const response = await fetchSec(url.toString(), {
        headers: {
          "User-Agent": this.userAgent,
          Accept: "application/atom+xml, application/xml;q=0.9",
        },
      }, this.timeoutMs);
      const page = parseAtomFilings(await response.text());
      filings.push(...page.filter((filing) => Date.parse(filing.updatedAt) >= sinceTime));
      const oldest = Math.min(...page.map((filing) => Date.parse(filing.updatedAt)).filter(Number.isFinite));
      if (page.length < 100 || !Number.isFinite(oldest) || oldest < sinceTime) break;
    }
    return filings;
  }

  private getSubmissions(cik: string, cache: Map<string, Promise<SecSubmissions>>): Promise<SecSubmissions> {
    const existing = cache.get(cik);
    if (existing) return existing;
    const request = fetchSec(`https://data.sec.gov/submissions/CIK${cik.padStart(10, "0")}.json`, {
      headers: { "User-Agent": this.userAgent, Accept: "application/json" },
    }, this.timeoutMs).then((response) => response.json() as Promise<SecSubmissions>);
    cache.set(cik, request);
    return request;
  }
}

export function parseAtomFilings(xml: string): AtomFiling[] {
  const parsed = parser.parse(xml) as Record<string, unknown>;
  const feed = asRecord(parsed.feed);
  return asArray(feed.entry).flatMap((rawEntry): AtomFiling[] => {
    const entry = asRecord(rawEntry);
    const title = asText(entry.title);
    const cik = title.match(/\((\d{10})\)\s*\(Filer\)/i)?.[1];
    const accession = asText(entry.id).match(/accession-number=([0-9-]+)/i)?.[1];
    const indexUrl = extractLink(entry.link);
    const updatedAt = asText(entry.updated);
    const form = asText(asRecord(entry.category)["@_term"]);
    if (!cik || !accession || !indexUrl || !updatedAt || !form) return [];
    return [{
      accession,
      cik: normalizeCik(cik),
      form,
      indexUrl: canonicalUrl(indexUrl),
      summary: stripHtml(asText(entry.summary)).slice(0, 12_000),
      updatedAt: new Date(updatedAt).toISOString(),
    }];
  });
}

function normalizeCik(cik: string): string {
  return String(Number(cik));
}

function extractLink(value: unknown): string {
  for (const link of asArray(value)) {
    if (typeof link === "string") return link;
    const record = asRecord(link);
    if (!record["@_rel"] || record["@_rel"] === "alternate") {
      const href = asText(record["@_href"]);
      if (href) return href;
    }
  }
  return "";
}

function asText(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(asText).find(Boolean) ?? "";
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return asText(record["#text"] ?? record["@_href"] ?? "");
  }
  return "";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
}
