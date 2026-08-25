import type { NormalizedItem, SourceAdapter, SourceFetchResult, WatchCompany } from "../types.js";
import { canonicalUrl, itemId, resolveWatchCompany, stripHtml } from "../utils.js";
import { fetchWithTimeout } from "./http.js";

const ENDPOINT = "https://www.federalregister.gov/api/v1/documents.json";

interface FederalRegisterDocument {
  title?: string;
  abstract?: string;
  document_number?: string;
  html_url?: string;
  publication_date?: string;
  excerpts?: string;
}

interface FederalRegisterResponse {
  count?: number;
  total_pages?: number;
  results?: FederalRegisterDocument[];
}

export class FdaAdvisorySource implements SourceAdapter {
  readonly descriptor = {
    id: "fda-advisory-committees",
    name: "FDA advisory committee notices",
    type: "regulator",
    tier: "primary",
  } as const;

  constructor(
    private readonly watchlist: WatchCompany[],
    private readonly timeoutMs: number,
  ) {}

  async fetch(cursor: string | null): Promise<SourceFetchResult> {
    const cursorTime = cursor && Number.isFinite(Date.parse(cursor))
      ? Date.parse(cursor) - 24 * 60 * 60 * 1000
      : Date.now() - 14 * 24 * 60 * 60 * 1000;
    const url = new URL(ENDPOINT);
    url.searchParams.set("conditions[agencies][]", "food-and-drug-administration");
    url.searchParams.set("conditions[term]", "advisory committee");
    url.searchParams.set("conditions[publication_date][gte]", new Date(cursorTime).toISOString().slice(0, 10));
    url.searchParams.set("order", "newest");
    url.searchParams.set("per_page", "100");
    const response = await fetchWithTimeout(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "CatalystWatch/0.2 FDA advisory monitor",
      },
    }, this.timeoutMs);
    const payload = await response.json() as FederalRegisterResponse;
    const discoveredAt = new Date().toISOString();
    const items = (payload.results ?? []).flatMap((document): NormalizedItem[] => {
      const documentNumber = document.document_number;
      const title = stripHtml(document.title ?? "");
      const sourceUrl = document.html_url;
      const publicationDate = document.publication_date;
      if (!documentNumber || !title || !sourceUrl || !publicationDate) return [];
      const summary = stripHtml([document.abstract, document.excerpts].filter(Boolean).join("\n")).slice(0, 25_000);
      const company = resolveWatchCompany({ headline: title, summary }, this.watchlist);
      const publishedAt = new Date(`${publicationDate}T12:00:00.000Z`).toISOString();
      const headline = `FDA advisory notice: ${title}`;
      const urlValue = canonicalUrl(sourceUrl);
      return [{
        id: itemId(this.descriptor.id, documentNumber, urlValue, headline),
        externalId: documentNumber,
        source: this.descriptor,
        headline,
        summary,
        url: urlValue,
        author: "U.S. Food and Drug Administration",
        publishedAt,
        discoveredAt,
        companyHint: company?.company ?? null,
        tickerHint: company?.ticker ?? null,
        provenance: "direct_primary",
        independenceKey: `regulator:${documentNumber}`,
        raw: document,
      }];
    });
    return {
      items,
      cursor: discoveredAt,
      diagnostics: {
        resultCount: payload.count ?? items.length,
        itemCount: items.length,
        totalPages: payload.total_pages ?? 1,
      },
    };
  }
}
