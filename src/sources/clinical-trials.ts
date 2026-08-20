import type { NormalizedItem, SourceAdapter, SourceFetchResult, WatchCompany } from "../types.js";
import { findWatchCompany, isoDate, itemId } from "../utils.js";
import { fetchWithTimeout } from "./http.js";

interface ClinicalStudy {
  protocolSection?: {
    identificationModule?: {
      nctId?: string;
      briefTitle?: string;
      officialTitle?: string;
      organization?: { fullName?: string };
    };
    statusModule?: {
      overallStatus?: string;
      lastUpdatePostDateStruct?: { date?: string };
      resultsFirstPostDateStruct?: { date?: string };
      completionDateStruct?: { date?: string };
    };
    sponsorCollaboratorsModule?: {
      leadSponsor?: { name?: string; class?: string };
      collaborators?: Array<{ name?: string; class?: string }>;
    };
    designModule?: { phases?: string[]; studyType?: string; enrollmentInfo?: { count?: number; type?: string } };
    descriptionModule?: { briefSummary?: string; detailedDescription?: string };
    conditionsModule?: { conditions?: string[] };
    outcomesModule?: { primaryOutcomes?: Array<{ measure?: string; description?: string }> };
  };
  hasResults?: boolean;
  resultsSection?: unknown;
}

interface ClinicalTrialsResponse {
  studies?: ClinicalStudy[];
  totalCount?: number;
}

export class ClinicalTrialsSource implements SourceAdapter {
  readonly descriptor = {
    id: "clinicaltrials-gov",
    name: "ClinicalTrials.gov",
    type: "clinical_trials",
    tier: "primary",
  } as const;

  constructor(
    private readonly watchlist: WatchCompany[],
    private readonly timeoutMs: number,
  ) {}

  async fetch(cursor: string | null): Promise<SourceFetchResult> {
    if (this.watchlist.length === 0) return { items: [], diagnostics: { reason: "watchlist_empty" } };
    const since = cursor && /^\d{4}-\d{2}-\d{2}$/.test(cursor)
      ? cursor
      : new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const sponsorQuery = this.watchlist.map((company) => `\"${company.company.replaceAll('"', "")}\"`).join(" OR ");
    const url = new URL("https://clinicaltrials.gov/api/v2/studies");
    url.searchParams.set("format", "json");
    url.searchParams.set("pageSize", "100");
    url.searchParams.set("countTotal", "true");
    url.searchParams.set("query.spons", sponsorQuery);
    url.searchParams.set("filter.advanced", `AREA[LastUpdatePostDate]RANGE[${since}, MAX]`);
    url.searchParams.set("sort", "LastUpdatePostDate:desc");

    const response = await fetchWithTimeout(url, {
      headers: { "User-Agent": "BiotechSignal/0.1 clinical trial monitor" },
    }, this.timeoutMs);
    const payload = await response.json() as ClinicalTrialsResponse;
    const discoveredAt = new Date().toISOString();
    const items = (payload.studies ?? []).flatMap((study): NormalizedItem[] => {
      const protocol = study.protocolSection;
      const identification = protocol?.identificationModule;
      const status = protocol?.statusModule;
      const nctId = identification?.nctId;
      const title = identification?.briefTitle ?? identification?.officialTitle;
      if (!nctId || !title) return [];
      const sponsor = protocol?.sponsorCollaboratorsModule?.leadSponsor?.name ?? identification.organization?.fullName ?? "";
      const phases = protocol?.designModule?.phases?.join("/") ?? "Unknown phase";
      const resultsDate = status?.resultsFirstPostDateStruct?.date;
      const isFreshResults = Boolean(resultsDate && resultsDate >= since);
      const headline = `ClinicalTrials.gov ${isFreshResults ? "results posted" : "record updated"}: ${title}`;
      const outcomes = protocol?.outcomesModule?.primaryOutcomes?.map((outcome) => `${outcome.measure ?? ""}: ${outcome.description ?? ""}`).join("\n") ?? "";
      const summary = [
        `Sponsor: ${sponsor}`,
        `NCT ID: ${nctId}`,
        `Phase: ${phases}`,
        `Overall status: ${status?.overallStatus ?? "unknown"}`,
        `Has posted results: ${study.hasResults ? "yes" : "no"}`,
        `Conditions: ${protocol?.conditionsModule?.conditions?.join(", ") ?? "not reported"}`,
        `Enrollment: ${protocol?.designModule?.enrollmentInfo?.count ?? "not reported"}`,
        `Brief summary: ${protocol?.descriptionModule?.briefSummary ?? ""}`,
        outcomes ? `Registered primary outcomes: ${outcomes}` : "",
        // ClinicalTrials.gov results are structured and may be large. The raw record remains stored for audit.
        study.resultsSection ? `Posted results payload: ${JSON.stringify(study.resultsSection).slice(0, 10_000)}` : "",
      ].filter(Boolean).join("\n").slice(0, 16_000);
      const company = findWatchCompany(`${sponsor} ${title} ${summary}`, this.watchlist);
      const url = `https://clinicaltrials.gov/study/${nctId}`;
      const version = status?.lastUpdatePostDateStruct?.date ?? resultsDate ?? discoveredAt.slice(0, 10);
      return [{
        id: itemId(this.descriptor.id, `${nctId}:${version}`, url, headline),
        externalId: `${nctId}:${version}`,
        source: this.descriptor,
        headline,
        summary,
        url,
        author: sponsor || null,
        publishedAt: isoDate(status?.lastUpdatePostDateStruct?.date ?? resultsDate, new Date()),
        discoveredAt,
        companyHint: company?.company ?? (sponsor || null),
        tickerHint: company?.ticker ?? null,
        raw: study,
      }];
    });
    return {
      items,
      cursor: discoveredAt.slice(0, 10),
      diagnostics: { totalCount: payload.totalCount ?? items.length, since },
    };
  }
}
