import type { NormalizedItem, SourceAdapter, SourceFetchResult, WatchCompany } from "../types.js";
import { canonicalUrl, itemId, stripHtml } from "../utils.js";
import { fetchWithTimeout } from "./http.js";

interface SecSubmissions {
  name?: string;
  filings?: {
    recent?: {
      accessionNumber?: string[];
      filingDate?: string[];
      acceptanceDateTime?: string[];
      form?: string[];
      primaryDocument?: string[];
      primaryDocDescription?: string[];
      items?: string[];
    };
  };
}

export class SecFilingsSource implements SourceAdapter {
  readonly descriptor = { id: "sec-edgar", name: "SEC EDGAR", type: "sec", tier: "primary" } as const;

  constructor(
    private readonly watchlist: WatchCompany[],
    private readonly userAgent: string,
    private readonly timeoutMs: number,
  ) {}

  async fetch(cursor: string | null): Promise<SourceFetchResult> {
    const since = cursor && /^\d{4}-\d{2}-\d{2}$/.test(cursor)
      ? cursor
      : new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const discoveredAt = new Date().toISOString();
    const items: NormalizedItem[] = [];

    for (const company of this.watchlist.filter((entry) => entry.cik)) {
      const cikPadded = company.cik!.padStart(10, "0");
      const response = await fetchWithTimeout(`https://data.sec.gov/submissions/CIK${cikPadded}.json`, {
        headers: { "User-Agent": this.userAgent, Accept: "application/json" },
      }, this.timeoutMs);
      const payload = await response.json() as SecSubmissions;
      const recent = payload.filings?.recent;
      if (!recent) continue;
      const forms = recent.form ?? [];
      for (let index = 0; index < forms.length; index += 1) {
        const form = forms[index];
        const filingDate = recent.filingDate?.[index];
        const accession = recent.accessionNumber?.[index];
        const primaryDocument = recent.primaryDocument?.[index];
        if (!form || !filingDate || !accession || !primaryDocument) continue;
        if (!new Set(["8-K", "8-K/A", "6-K", "6-K/A"]).has(form) || filingDate < since) continue;
        const cikNumeric = String(Number(cikPadded));
        const accessionCompact = accession.replaceAll("-", "");
        const documentUrl = canonicalUrl(`https://www.sec.gov/Archives/edgar/data/${cikNumeric}/${accessionCompact}/${primaryDocument}`);
        let filingText = "";
        try {
          const documentResponse = await fetchWithTimeout(documentUrl, {
            headers: { "User-Agent": this.userAgent, Accept: "text/html, text/plain;q=0.9" },
          }, this.timeoutMs);
          filingText = stripHtml(await documentResponse.text()).slice(0, 25_000);
        } catch (error) {
          filingText = `Primary filing document could not be fetched: ${error instanceof Error ? error.message : String(error)}`;
        }
        const itemNumbers = recent.items?.[index] ?? "";
        const description = recent.primaryDocDescription?.[index] ?? "Current report";
        const headline = `${company.company} filed ${form}: ${description}`;
        const summary = [
          `SEC form: ${form}`,
          itemNumbers ? `8-K item numbers: ${itemNumbers}` : "",
          `Accession: ${accession}`,
          filingText,
        ].filter(Boolean).join("\n");
        items.push({
          id: itemId(this.descriptor.id, accession, documentUrl, headline),
          externalId: accession,
          source: this.descriptor,
          headline,
          summary,
          url: documentUrl,
          author: payload.name ?? company.company,
          publishedAt: toSecIso(recent.acceptanceDateTime?.[index], filingDate),
          discoveredAt,
          companyHint: company.company,
          tickerHint: company.ticker,
          raw: {
            accession,
            filingDate,
            form,
            primaryDocument,
            primaryDocDescription: description,
            items: itemNumbers,
          },
        });
      }
    }
    return { items, cursor: discoveredAt.slice(0, 10), diagnostics: { companyCount: this.watchlist.filter((entry) => entry.cik).length, since } };
  }
}

function toSecIso(acceptanceDateTime: string | undefined, filingDate: string): string {
  if (acceptanceDateTime && /^\d{14}$/.test(acceptanceDateTime)) {
    return `${acceptanceDateTime.slice(0, 4)}-${acceptanceDateTime.slice(4, 6)}-${acceptanceDateTime.slice(6, 8)}T${acceptanceDateTime.slice(8, 10)}:${acceptanceDateTime.slice(10, 12)}:${acceptanceDateTime.slice(12, 14)}-04:00`;
  }
  return `${filingDate}T00:00:00.000Z`;
}
