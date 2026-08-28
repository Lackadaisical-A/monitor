import { timelineEventsFromItem } from "../timeline.js";
import type { NormalizedItem, SourceAdapter, SourceFetchResult, WatchCompany } from "../types.js";
import { canonicalUrl, itemId, mapWithConcurrency, stripHtml } from "../utils.js";
import { fetchSec } from "./sec-http.js";

const BACKFILL_DAYS = 400;
const REFRESH_INTERVAL_MS = 30 * 24 * 60 * 60_000;
const COMPANIES_PER_BATCH = 20;
const MAX_FILINGS_PER_COMPANY = 12;
const COMPANY_CONCURRENCY = 3;
const DOCUMENT_CONCURRENCY = 3;
const INCLUDED_FORMS = new Set(["8-K", "6-K", "10-Q", "10-K", "20-F"]);
const CATALYST_CONTEXT = /\b(?:pdufa|target action date|priority review|advisory committee|adcom|fda|nda|bla|ind|top[- ]?line|readout|primary endpoint|clinical trial|phase\s*(?:1|2|3|i|ii|iii)|results?|data)\b/i;

interface SecCalendarCursor {
  version: 1;
  nextCompanyIndex: number;
  cycleStartedAt: string;
  completedAt: string | null;
}

interface SecSubmissions {
  name?: string;
  filings?: {
    recent?: {
      accessionNumber?: string[];
      form?: string[];
      primaryDocument?: string[];
      primaryDocDescription?: string[];
      items?: string[];
      filingDate?: string[];
      acceptanceDateTime?: string[];
    };
  };
}

interface FilingCandidate {
  accession: string;
  form: string;
  primaryDocument: string;
  description: string;
  items: string;
  filingDate: string;
  acceptedAt: string;
}

export class SecCalendarSource implements SourceAdapter {
  readonly descriptor = {
    id: "sec-calendar-backfill-v1",
    name: "SEC catalyst calendar",
    type: "sec",
    tier: "primary",
  } as const;
  private readonly companies: WatchCompany[];

  constructor(
    watchlist: WatchCompany[],
    private readonly userAgent: string,
    private readonly timeoutMs: number,
  ) {
    this.companies = watchlist.filter((company) => company.cik);
  }

  async fetch(cursor: string | null): Promise<SourceFetchResult> {
    if (!this.companies.length) return { items: [], diagnostics: { reason: "cik_watchlist_empty" } };
    const now = new Date();
    let state = parseCursor(cursor, now);
    if (state.completedAt && now.getTime() - Date.parse(state.completedAt) < REFRESH_INTERVAL_MS) {
      return {
        items: [],
        cursor: JSON.stringify(state),
        diagnostics: { phase: "idle", companyCount: this.companies.length, completedAt: state.completedAt },
      };
    }
    if (state.nextCompanyIndex >= this.companies.length) {
      state = { version: 1, nextCompanyIndex: 0, cycleStartedAt: now.toISOString(), completedAt: null };
    }

    const startIndex = state.nextCompanyIndex;
    const batch = this.companies.slice(startIndex, startIndex + COMPANIES_PER_BATCH);
    const threshold = new Date(now.getTime() - BACKFILL_DAYS * 24 * 60 * 60_000).toISOString().slice(0, 10);
    const companyResults = await mapWithConcurrency(
      batch,
      COMPANY_CONCURRENCY,
      (company) => this.fetchCompany(company, threshold, now.toISOString()),
    );
    const successful = companyResults.filter(
      (result): result is PromiseFulfilledResult<NormalizedItem[]> => result.status === "fulfilled",
    );
    if (!successful.length && batch.length) {
      const failure = companyResults.find((result): result is PromiseRejectedResult => result.status === "rejected");
      throw failure?.reason ?? new Error("SEC calendar backfill returned no successful companies");
    }

    const items = [...new Map(successful.flatMap((result) => result.value).map((item) => [item.id, item])).values()];
    const firstFailureOffset = companyResults.findIndex((result) => result.status === "rejected");
    const nextCompanyIndex = Math.min(
      this.companies.length,
      firstFailureOffset >= 0 ? startIndex + firstFailureOffset : startIndex + batch.length,
    );
    const completed = nextCompanyIndex >= this.companies.length;
    const nextState: SecCalendarCursor = {
      ...state,
      nextCompanyIndex,
      completedAt: completed ? now.toISOString() : null,
    };
    return {
      items,
      cursor: JSON.stringify(nextState),
      diagnostics: {
        phase: completed ? "complete" : "backfill",
        companyStartIndex: startIndex,
        companyCount: batch.length,
        failedCompanyCount: companyResults.length - successful.length,
        matchedFilingCount: items.length,
        nextCompanyIndex,
        totalCompanyCount: this.companies.length,
      },
    };
  }

  private async fetchCompany(company: WatchCompany, threshold: string, discoveredAt: string): Promise<NormalizedItem[]> {
    const cik = normalizeCik(company.cik!);
    const response = await fetchSec(`https://data.sec.gov/submissions/CIK${cik.padStart(10, "0")}.json`, {
      headers: { "User-Agent": this.userAgent, Accept: "application/json" },
    }, this.timeoutMs);
    const submissions = await response.json() as SecSubmissions;
    const filings = filingCandidates(submissions, threshold).slice(0, MAX_FILINGS_PER_COMPANY);
    const documentResults = await mapWithConcurrency(
      filings,
      DOCUMENT_CONCURRENCY,
      (filing) => this.filingItem(company, submissions.name, cik, filing, discoveredAt),
    );
    return documentResults.flatMap((result) => result.status === "fulfilled" && result.value ? [result.value] : []);
  }

  private async filingItem(
    company: WatchCompany,
    registrantName: string | undefined,
    cik: string,
    filing: FilingCandidate,
    discoveredAt: string,
  ): Promise<NormalizedItem | null> {
    const documentUrl = canonicalUrl(
      `https://www.sec.gov/Archives/edgar/data/${cik}/${filing.accession.replaceAll("-", "")}/${filing.primaryDocument}`,
    );
    const response = await fetchSec(documentUrl, {
      headers: { "User-Agent": this.userAgent, Accept: "text/html, text/plain;q=0.9" },
    }, this.timeoutMs);
    const focusedText = catalystContext(await response.text());
    if (!focusedText) return null;
    const headline = `${company.company} ${filing.form} catalyst disclosures`;
    const item: NormalizedItem = {
      id: itemId(this.descriptor.id, filing.accession, documentUrl, headline),
      externalId: filing.accession,
      source: this.descriptor,
      headline,
      summary: [
        `SEC form: ${filing.form}`,
        filing.items ? `8-K item numbers: ${filing.items}` : "",
        `Accession: ${filing.accession}`,
        filing.description,
        focusedText,
      ].filter(Boolean).join("\n").slice(0, 50_000),
      url: documentUrl,
      author: registrantName ?? company.company,
      publishedAt: secTimestamp(filing.acceptedAt, filing.filingDate),
      discoveredAt,
      companyHint: company.company,
      tickerHint: company.ticker,
      provenance: "direct_primary",
      independenceKey: `sec:${filing.accession}`,
      raw: {
        accession: filing.accession,
        cik,
        form: filing.form,
        primaryDocument: filing.primaryDocument,
        primaryDocDescription: filing.description,
        items: filing.items,
        catalystWatch: { calendarOnly: true, backfill: "sec" },
      },
    };
    return timelineEventsFromItem(item).length ? item : null;
  }

}

function filingCandidates(submissions: SecSubmissions, threshold: string): FilingCandidate[] {
  const recent = submissions.filings?.recent;
  if (!recent) return [];
  return (recent.accessionNumber ?? []).flatMap((accession, index): FilingCandidate[] => {
    const form = recent.form?.[index] ?? "";
    const primaryDocument = recent.primaryDocument?.[index] ?? "";
    const filingDate = recent.filingDate?.[index] ?? "";
    if (!accession || !INCLUDED_FORMS.has(form) || !primaryDocument || !filingDate || filingDate < threshold) return [];
    return [{
      accession,
      form,
      primaryDocument,
      description: recent.primaryDocDescription?.[index] || `${form} filing`,
      items: recent.items?.[index] ?? "",
      filingDate,
      acceptedAt: recent.acceptanceDateTime?.[index] ?? "",
    }];
  });
}

function catalystContext(html: string): string {
  const text = stripHtml(html);
  const sentences = text.split(/(?<=[.!?])\s+|\n+/).map((sentence) => sentence.trim()).filter(Boolean);
  const selected = new Set<number>();
  for (let index = 0; index < sentences.length; index += 1) {
    if (!CATALYST_CONTEXT.test(sentences[index]!)) continue;
    for (let adjacent = Math.max(0, index - 1); adjacent <= Math.min(sentences.length - 1, index + 1); adjacent += 1) {
      selected.add(adjacent);
    }
  }
  return [...selected].sort((left, right) => left - right)
    .map((index) => sentences[index])
    .join(" ")
    .slice(0, 45_000);
}

function parseCursor(value: string | null, now: Date): SecCalendarCursor {
  if (value) {
    try {
      const parsed = JSON.parse(value) as Partial<SecCalendarCursor>;
      if (parsed.version === 1 && Number.isInteger(parsed.nextCompanyIndex)
        && typeof parsed.cycleStartedAt === "string") {
        return {
          version: 1,
          nextCompanyIndex: Math.max(0, parsed.nextCompanyIndex ?? 0),
          cycleStartedAt: parsed.cycleStartedAt,
          completedAt: typeof parsed.completedAt === "string" ? parsed.completedAt : null,
        };
      }
    } catch {
      // Start a new cycle when the cursor is absent or from an older format.
    }
  }
  return { version: 1, nextCompanyIndex: 0, cycleStartedAt: now.toISOString(), completedAt: null };
}

function secTimestamp(acceptedAt: string, filingDate: string): string {
  const compact = /^(20\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(acceptedAt);
  if (compact) {
    return new Date(Date.UTC(
      Number(compact[1]), Number(compact[2]) - 1, Number(compact[3]),
      Number(compact[4]), Number(compact[5]), Number(compact[6]),
    )).toISOString();
  }
  const parsed = Date.parse(acceptedAt);
  if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  return new Date(`${filingDate}T12:00:00.000Z`).toISOString();
}

function normalizeCik(cik: string): string {
  return String(Number(cik));
}
